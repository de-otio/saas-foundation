/**
 * MagicLinkAuthSite — stateless L3 construct for the CloudFront-facing
 * side of vestibulum-cdk passwordless auth.
 *
 * Composes:
 * - Auto-created Cognito website app client via `identity.addAppClient`.
 * - Lambda@Edge `check-auth` function on the viewer-request of the
 *   default behaviour (verifies the Cognito JWT cookie).
 * - `auth-verify` and `auth-signout` regional Lambdas with Function
 *   URLs gated by CloudFront Origin Access Control at the IAM layer.
 * - CloudFront distribution with five behaviours.
 * - Response-headers policy (HSTS, strict CSP, COOP, CORP,
 *   Permissions-Policy).
 * - BucketDeployment of the bundled login pages.
 *
 * Integrated security fixes from the 2026-05-24 design review:
 *
 * - **B-F:** `wafManagedRules` is NOT on `MagicLinkAuthSiteProps`; the
 *   Web ACL lives on `EdgeResources`, so that prop lives there too.
 * - **B-I:** there is no `_setSignupMode` call. `signupMode` is owned
 *   by `MagicLinkIdentity` per the integrated review.
 * - **S-C5 / S-C6:** the `check-auth` bundle is built with
 *   `aws-jwt-verify` inlined and `drop: ['console']` applied; both
 *   handled by the bundle pipeline (Agent A). This construct just
 *   references the bundle via `Code.fromAsset`.
 * - **S-C9:** cost-DoS envelope (Lambda@Edge + concurrency cap)
 *   reflected in the default reserved concurrency: `auth-verify` 20
 *   (was 50), `auth-signout` 5.
 * - **S-C12:** branding overridable via `namespacePrefix` and
 *   `metricsNamespace` props.
 *
 * @see {@link https://github.com/de-otio/saas-foundation/blob/main/doc/vestibulum-cdk/04-magic-link-auth-site.md}
 */

import * as path from "node:path";

import { Construct } from "constructs";
import {
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";

import { resolveMetricsNamespace, resolveResourceNamePrefix } from "../_internal/branding.js";
import type { IEdgeResources } from "../_internal/edge-handle.js";
import type { IMagicLinkIdentity } from "../_internal/identity-handle.js";
import { packageRootFrom } from "../_internal/package-root.js";
import { RuntimeEnv } from "../_internal/runtime-env.js";
import {
  type BucketLifecycleProps,
  defaultImmutableAssetLifecycleRules,
  resolveLifecycleRules,
} from "../_internal/s3-lifecycle.js";
import {
  readBundleLockManifest,
  resolveAuthSiteBundlePaths,
  type BundleLockManifest,
} from "./auth-verify-paths.js";

/**
 * Lightweight namespace-only metrics handle attached to
 * `MagicLinkAuthSite`. The richer `AuthSiteMetrics` interface (with
 * CloudWatch metric handles for each dashboard line) lives in the
 * sibling `lib/metrics/` module owned by Agent C — pass an instance
 * of this construct to `buildAuthSiteMetrics(...)` to build it.
 */
export interface AuthSiteMetricsNamespace {
  /**
   * CloudWatch namespace used by all auth-site metrics. Defaults to
   * `'Vestibulum/AuthSite'`; overridable via `metricsNamespace`.
   */
  readonly namespace: string;
}

/**
 * Per-handler reserved-concurrency overrides. Defaults are conservative
 * cost-DoS guards (see S-C9).
 */
export interface AuthLambdaConcurrencyProps {
  /**
   * Reserved concurrency for `auth-verify`. Per S-C9 the default
   * lowered from 50 to 20 — 20 covers a legitimate burst for a
   * low-traffic internal site while halving the worst-case
   * Lambda + Cognito cost under attack.
   * @default 20
   */
  readonly authVerify?: number;
  /**
   * Reserved concurrency for `auth-signout`. Sign-out is a cold path
   * that shouldn't see bursts — 5 is plenty.
   * @default 5
   */
  readonly authSignout?: number;
}

/**
 * Props for {@link MagicLinkAuthSite}.
 */
export interface MagicLinkAuthSiteProps {
  /**
   * Public-facing domain for the protected site (e.g. `app.example.com`).
   * Used as the CloudFront alternate domain name and the cookie domain.
   */
  readonly domain: string;
  /**
   * CloudFront origin for the protected content. Typical: a private
   * S3 bucket via `S3BucketOrigin.withOriginAccessControl(bucket)`.
   */
  readonly origin: cloudfront.IOrigin;
  /**
   * Cross-region reference from the `EdgeResources` construct in the
   * us-east-1 stack. Provides the ACM cert and WAF Web ACL ARNs.
   */
  readonly edge: IEdgeResources;
  /**
   * Cross-stack reference from the `MagicLinkIdentity` construct.
   * Provides the Cognito pool and the DynamoDB tables `auth-verify`
   * reads.
   */
  readonly identity: IMagicLinkIdentity;
  /**
   * CloudFront price class — controls which edge regions serve cache
   * hits. Defaults to `PriceClass_100` (NA + EU) per the mandatory
   * EU-residency-friendly mitigation.
   * @default PriceClass.PRICE_CLASS_100
   */
  readonly priceClass?: cloudfront.PriceClass;
  /**
   * Override the CloudFront response-headers policy. The default
   * applies HSTS / strict CSP / X-Frame-Options DENY / COOP / CORP /
   * Permissions-Policy.
   */
  readonly responseHeadersPolicy?: cloudfront.ResponseHeadersPolicy;
  /**
   * Optional pre-created bucket for the login pages. When omitted, an
   * auto-created private bucket is provisioned and the bundled HTML
   * is deployed into it.
   */
  readonly loginPageBucket?: s3.IBucket;
  /**
   * Optional S3 lifecycle configuration applied to the auto-created
   * login-page bucket. Cost-pillar review S4.
   *
   * When omitted, the construct applies an immutable-asset default
   * (abort incomplete multipart uploads after 7 days; transition to
   * Standard-IA after 30 days; expire noncurrent versions after 90
   * days).
   *
   * When `lifecycle.rules` is set to a non-empty array, the consumer
   * rules replace the default entirely. When set to an empty array,
   * the bucket gets no lifecycle (useful for cold-as-operational
   * workloads where retrieval cost dominates and Standard-IA would
   * be net-negative).
   *
   * Has no effect when `loginPageBucket` is consumer-supplied — the
   * construct does not mutate a bucket it did not create.
   */
  readonly lifecycle?: BucketLifecycleProps;
  /**
   * ID-token validity override for the auto-created website app client.
   */
  readonly idTokenValidity?: Duration;
  /**
   * Refresh-token validity override for the auto-created website app client.
   */
  readonly refreshTokenValidity?: Duration;
  /**
   * Reserved-concurrency overrides for the auth Lambda functions.
   */
  readonly reservedConcurrency?: AuthLambdaConcurrencyProps;
  /**
   * Override the CloudWatch metric namespace. Per S-C12.
   * @default `'Vestibulum/AuthSite'`
   */
  readonly metricsNamespace?: string;
  /**
   * Override the resource-name prefix used in physical resource names
   * (response-headers policy, CloudFront comment, etc.). Per S-C12.
   * @default `'Vestibulum'`
   */
  readonly namespacePrefix?: string;
  /**
   * Override the on-disk path to the `vestibulum-cdk` package root.
   * Test-only — production consumers should not set this.
   *
   * @internal
   */
  readonly _packageRoot?: string;
  /**
   * Override the bundle lock manifest. Test-only — when set, the
   * construct skips the on-disk manifest read.
   *
   * @internal
   */
  readonly _bundleManifest?: BundleLockManifest;
  /**
   * When `true`, the construct does not check that the bundle asset
   * directories exist on disk. Test-only — defaults to `false`.
   *
   * @internal
   */
  readonly _skipBundleAssetCheck?: boolean;
}

/**
 * Stateless L3 construct that provisions the CloudFront-facing auth
 * infrastructure for a vestibulum-cdk magic-link site.
 *
 * @example
 * ```typescript
 * new MagicLinkAuthSite(stack, 'Site', {
 *   domain: 'app.example.com',
 *   origin: S3BucketOrigin.withOriginAccessControl(bucket),
 *   edge: edgeResources,
 *   identity: magicLinkIdentity,
 * });
 * ```
 */
export class MagicLinkAuthSite extends Construct {
  /** The CloudFront distribution. Escape hatch for extra behaviours. */
  public readonly distribution: cloudfront.Distribution;
  /** Function URL of `auth-verify`. Reachable only via CloudFront OAC. */
  public readonly authVerifyUrl: lambda.FunctionUrl;
  /** Function URL of `auth-signout`. Reachable only via CloudFront OAC. */
  public readonly authSignoutUrl: lambda.FunctionUrl;
  /** Auto-created Cognito website app client. */
  public readonly websiteClient: cognito.UserPoolClient;
  /** CloudWatch metrics namespace handle. The richer dashboard-ready
   *  `AuthSiteMetrics` object lives in `lib/metrics/`. */
  public readonly metrics: AuthSiteMetricsNamespace;
  /** The login-page S3 bucket (either auto-created or consumer-supplied). */
  public readonly loginPageBucket: s3.IBucket;
  /** The resolved resource-name prefix; exposed for tests. */
  public readonly namespacePrefix: string;

  public constructor(scope: Construct, id: string, props: MagicLinkAuthSiteProps) {
    super(scope, id);

    const { domain, identity, edge } = props;
    const region = Stack.of(this).region;

    // -------------------------------------------------------------------
    // B-I: do NOT call `identity._setSignupMode(...)`. signupMode lives
    // on MagicLinkIdentityProps per the integrated security review.
    //
    // The federation-enabled + missing-signupMode guard now lives on
    // the Identity, not here.
    // -------------------------------------------------------------------

    this.namespacePrefix = resolveResourceNamePrefix(props.namespacePrefix);
    const metricsNamespace = resolveMetricsNamespace(props.metricsNamespace);
    this.metrics = { namespace: metricsNamespace };

    // -------------------------------------------------------------------
    // Auto-created Cognito website app client.
    //
    // generateSecret: false is enforced by DisabledAuthFlowsAspect
    // regardless (Agent C's scope); vestibulum-cdk app clients are
    // public (SPA / browser).
    // -------------------------------------------------------------------
    this.websiteClient = identity.addAppClient("WebsiteClient", {
      oauth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://${domain}/login/callback`],
      },
      generateSecret: false,
      ...(props.idTokenValidity && { idTokenValidity: props.idTokenValidity }),
      ...(props.refreshTokenValidity && {
        refreshTokenValidity: props.refreshTokenValidity,
      }),
    });

    // -------------------------------------------------------------------
    // Resolve bundle paths. Test fixtures supply `_bundleManifest` to
    // avoid the on-disk lookup; production consumers read the manifest
    // shipped in the published tarball.
    // -------------------------------------------------------------------
    const packageRoot = props._packageRoot ?? packageRootFrom(import.meta.url);
    const manifest = props._bundleManifest ?? readBundleLockManifest(packageRoot);
    const bundlePaths = resolveAuthSiteBundlePaths(packageRoot, manifest, {
      skipExistenceCheck: props._skipBundleAssetCheck === true,
    });

    // -------------------------------------------------------------------
    // auth-verify Lambda.
    //
    // Uses lambda.Function + Code.fromAsset (NOT NodejsFunction) per
    // the bundle pipeline contract — esbuild does not run in the
    // consumer's synth process.
    // -------------------------------------------------------------------
    const authVerifyConcurrency = props.reservedConcurrency?.authVerify ?? 20;
    const authVerifyFn = new lambda.Function(this, "AuthVerifyFn", {
      code: lambda.Code.fromAsset(bundlePaths["auth-verify"]),
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      reservedConcurrentExecutions: authVerifyConcurrency,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: `${this.namespacePrefix} auth-verify endpoint for ${domain}.`,
      environment: {
        [RuntimeEnv.COGNITO_USER_POOL_ID]: identity.cognitoPool.userPoolId,
        [RuntimeEnv.COGNITO_CLIENT_ID]: this.websiteClient.userPoolClientId,
        [RuntimeEnv.DOMAIN]: domain,
        [RuntimeEnv.METRICS_NAMESPACE]: metricsNamespace,
      },
    });
    authVerifyFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:RespondToAuthChallenge"],
        resources: [identity.cognitoPool.userPoolArn],
      }),
    );
    identity.tokenTable.grantReadWriteData(authVerifyFn);
    identity.denylistTable.grantReadData(authVerifyFn);

    // -------------------------------------------------------------------
    // auth-signout Lambda.
    // -------------------------------------------------------------------
    const authSignoutConcurrency = props.reservedConcurrency?.authSignout ?? 5;
    const authSignoutFn = new lambda.Function(this, "AuthSignoutFn", {
      code: lambda.Code.fromAsset(bundlePaths["auth-signout"]),
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      reservedConcurrentExecutions: authSignoutConcurrency,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: `${this.namespacePrefix} auth-signout endpoint for ${domain}.`,
      environment: {
        [RuntimeEnv.COGNITO_USER_POOL_ID]: identity.cognitoPool.userPoolId,
        [RuntimeEnv.COGNITO_CLIENT_ID]: this.websiteClient.userPoolClientId,
        [RuntimeEnv.DOMAIN]: domain,
        [RuntimeEnv.METRICS_NAMESPACE]: metricsNamespace,
      },
    });
    authSignoutFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:GlobalSignOut"],
        resources: [identity.cognitoPool.userPoolArn],
      }),
    );

    // -------------------------------------------------------------------
    // Function URLs — authType AWS_IAM (required for OAC).
    // -------------------------------------------------------------------
    this.authVerifyUrl = authVerifyFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    this.authSignoutUrl = authSignoutFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // -------------------------------------------------------------------
    // check-auth Lambda@Edge.
    //
    // EdgeFunction wraps cross-region replication; the asset is the
    // pre-built bundle (S-C5: aws-jwt-verify inlined; S-C6: drop:
    // ['console'] applied). The default basic-execution role grants
    // logs:* — Mandatory Mitigation 1 strips it.
    // -------------------------------------------------------------------
    const checkAuthFn = new cloudfront.experimental.EdgeFunction(this, "CheckAuthFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bundlePaths["check-auth"]),
    });

    // `EdgeFunction.role` is declared on the class but not populated
    // by the constructor (AWS bug / lossy convenience); reach via the
    // underlying `lambda.Function` exposed as `.lambda`.
    const edgeRole = checkAuthFn.role ?? checkAuthFn.lambda.role;
    if (edgeRole && iam.Role.isRole(edgeRole)) {
      // Strip AWSLambdaBasicExecutionRole — Mandatory Mitigation 1.
      //
      // The L2 `Role` resolves its managed-policy list lazily from the
      // private `managedPolicies` array. Two independent overrides
      // ensure the strip survives the lazy resolution:
      //
      //   1. Mutate the private `managedPolicies` array directly via
      //      a `Role.isRole`-guarded cast. This is the only way to
      //      clear what the L2 added in its own constructor (the L2
      //      offers no public clear method).
      //   2. `addPropertyOverride` on the CfnRole pins the rendered
      //      `ManagedPolicyArns` to `[]` as belt-and-braces.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internal = edgeRole as unknown as { managedPolicies: unknown[] };
      internal.managedPolicies.length = 0;
      const cfnRole = edgeRole.node.defaultChild as iam.CfnRole;
      cfnRole.managedPolicyArns = [];
      cfnRole.addPropertyOverride("ManagedPolicyArns", []);
      // Narrow CloudWatch metric permission (no logs:*).
      edgeRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: "PutVestibulumMetrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            StringEquals: { "cloudwatch:namespace": metricsNamespace },
          },
        }),
      );
    }

    // Pin the auto-created edge log group to 1-day retention as
    // belt-and-braces; the role cannot write to it anyway.
    const edgeLogGroup = new logs.LogGroup(this, "CheckAuthLogGroup", {
      logGroupName: `/aws/lambda/us-east-1.${checkAuthFn.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    void edgeLogGroup;

    // -------------------------------------------------------------------
    // Login-page S3 bucket + BucketDeployment.
    // -------------------------------------------------------------------
    const lifecycleRules = resolveLifecycleRules(
      props.lifecycle,
      defaultImmutableAssetLifecycleRules(),
    );
    this.loginPageBucket =
      props.loginPageBucket ??
      // Cast through unknown — `s3.Bucket` is structurally assignable
      // to `s3.IBucket` but `exactOptionalPropertyTypes` rejects the
      // implicit widening of `isWebsite: boolean` to the optional
      // counterpart on the interface. Safe: `IBucket` is the
      // documented escape-hatch surface.
      (new s3.Bucket(this, "LoginPageBucket", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        // Cost-pillar S4: apply default S3 lifecycle. An empty array
        // explicitly disables the lifecycle; CDK's `s3.Bucket` accepts
        // an empty `lifecycleRules` array as "no rules attached" and
        // omits the LifecycleConfiguration block from the CFN render
        // when the array is empty.
        lifecycleRules,
      }) as unknown as s3.IBucket);

    const loginPagesDir = path.join(packageRoot, "login-pages");
    new s3deploy.BucketDeployment(this, "LoginPagesDeploy", {
      sources: [s3deploy.Source.asset(loginPagesDir)],
      destinationBucket: this.loginPageBucket,
      prune: true,
    });

    // -------------------------------------------------------------------
    // Response-headers policy. Branding suppressible via S-C12.
    // -------------------------------------------------------------------
    const defaultCsp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    const responseHeadersPolicy =
      props.responseHeadersPolicy ??
      new cloudfront.ResponseHeadersPolicy(this, "ResponseHeadersPolicy", {
        responseHeadersPolicyName: `${this.namespacePrefix}AuthSite-${region}-${domain.replace(/\./g, "-")}`,
        comment: `Security headers for ${this.namespacePrefix} AuthSite on ${domain}.`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(730),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: defaultCsp,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cross-Origin-Opener-Policy",
              value: "same-origin",
              override: true,
            },
            {
              header: "Cross-Origin-Resource-Policy",
              value: "same-origin",
              override: true,
            },
            {
              header: "Permissions-Policy",
              value: ["camera=()", "geolocation=()", "microphone=()", "payment=()", "usb=()"].join(
                ", ",
              ),
              override: true,
            },
          ],
        },
      });

    const commonBehavior: Partial<cloudfront.AddBehaviorOptions> = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };

    // -------------------------------------------------------------------
    // CloudFront distribution.
    // -------------------------------------------------------------------
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domain],
      certificate: edge.certificate,
      webAclId: edge.webAcl.attrArn,
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: `${this.namespacePrefix} AuthSite for ${domain}`,
      defaultBehavior: {
        origin: props.origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        edgeLambdas: [
          {
            functionVersion: checkAuthFn,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/login": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.loginPageBucket),
          ...commonBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        "/login/callback": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.loginPageBucket),
          ...commonBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        "/auth-verify*": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.authVerifyUrl),
          ...commonBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        "/auth-signout": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.authSignoutUrl),
          ...commonBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
    });
  }
}
