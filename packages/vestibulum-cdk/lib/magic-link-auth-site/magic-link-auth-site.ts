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
import * as fs from "node:fs";

import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import {
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  custom_resources as customResources,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";

import { markWafIntentionallyDisabled } from "../aspects/waf-required.js";
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
  /**
   * Reserved concurrency for `auth-login`. Mirrors `auth-verify`'s
   * cost-DoS envelope (S-C9): 20 covers a legitimate burst for a
   * low-traffic internal site while capping the worst-case
   * Lambda + Cognito cost under attack.
   * @default 20
   */
  readonly authLogin?: number;
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
  /** Function URL of `auth-login`. Reachable only via CloudFront OAC. */
  public readonly authLoginUrl: lambda.FunctionUrl;
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
      // The success path calls Cognito RespondToAuthChallenge, which cascades
      // synchronously through the VerifyAuthChallengeResponse + PreTokenGeneration
      // triggers; with the 3s Lambda default plus a cold start this overruns and
      // the Function URL returns 502. 256 MB also keeps headroom over the
      // ~115 MB the aws-sdk Cognito client uses at 128 MB.
      timeout: Duration.seconds(10),
      memorySize: 256,
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
      // Calls Cognito GlobalSignOut over the network; give the same headroom as
      // auth-verify so a cold start + Cognito latency doesn't hit the 3s default.
      timeout: Duration.seconds(10),
      memorySize: 256,
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
    // auth-login Lambda.
    //
    // Mirrors auth-verify: regional lambda.Function + Code.fromAsset from
    // the pre-built bundle. Drives the browser sign-in/sign-up POST —
    // calls Cognito SignUp + InitiateAuth and reads/writes the shared
    // per-IP rate-limit DynamoDB table (S-C9 cost-DoS envelope).
    // -------------------------------------------------------------------
    const authLoginConcurrency = props.reservedConcurrency?.authLogin ?? 20;
    const authLoginFn = new lambda.Function(this, "AuthLoginFn", {
      code: lambda.Code.fromAsset(bundlePaths["auth-login"]),
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      // Same Cognito-cascade headroom as auth-verify: SignUp / InitiateAuth
      // over the network plus a cold start overruns the 3s/128MB defaults.
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: authLoginConcurrency,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: `${this.namespacePrefix} auth-login endpoint for ${domain}.`,
      environment: {
        [RuntimeEnv.COGNITO_CLIENT_ID]: this.websiteClient.userPoolClientId,
        [RuntimeEnv.DOMAIN]: domain,
        [RuntimeEnv.RATE_LIMIT_TABLE_NAME]: identity.rateLimitTable.tableName,
        // LOGIN_IP_PER_WINDOW: per-IP login attempts per rate-limit window.
        // The constant is added to RuntimeEnv by the concurrent vestibulum
        // change; referenced here per the shared contract.
        [RuntimeEnv.LOGIN_IP_PER_WINDOW]: "10",
        [RuntimeEnv.METRICS_NAMESPACE]: metricsNamespace,
      },
    });
    authLoginFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:SignUp", "cognito-idp:InitiateAuth"],
        resources: [identity.cognitoPool.userPoolArn],
      }),
    );
    identity.rateLimitTable.grantReadWriteData(authLoginFn);

    // -------------------------------------------------------------------
    // Function URLs — authType AWS_IAM (required for OAC).
    // -------------------------------------------------------------------
    this.authVerifyUrl = authVerifyFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    this.authSignoutUrl = authSignoutFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    this.authLoginUrl = authLoginFn.addFunctionUrl({
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
      // NODEJS_22_X (not _20_X): the inlined bundle pulls in undici, whose
      // request internals destructure `markAsUncloneable` from
      // `node:worker_threads` — a Node 22.5+ API. On the node20 runtime that is
      // undefined and the function dies on init with
      // `Vt.util.markAsUncloneable is not a function`, returning 503
      // LambdaExecutionError. Lambda@Edge supports the current node22 runtime
      // (the SES/auth-site sibling functions already use it), so run check-auth
      // there too. The bundle is built with target node22 to match.
      runtime: lambda.Runtime.NODEJS_22_X,
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
    // check-auth deploy-time config baker.
    //
    // The edge bundle ships with `PLACEHOLDER_*` pool/client/region seams
    // (Lambda@Edge can't read env vars, and the consumer supplies these as
    // deploy-time CFN tokens). This custom resource injects the concrete
    // values at deploy time and republishes the function version; the
    // CloudFront viewer-request association below points at THAT version.
    //
    // The baker patches a PRISTINE copy of the base bundle (staged beside
    // its handler), not the deployed code — so a config-only change always
    // re-bakes from clean placeholders.
    // -------------------------------------------------------------------
    const rawOutdir: unknown = Stack.of(this).node.tryGetContext("aws:cdk:outdir");
    const appOutdir = path.resolve(typeof rawOutdir === "string" ? rawOutdir : "cdk.out");
    const bakerStageDir = path.join(appOutdir, ".vestibulum-check-auth-baker", this.node.addr);
    fs.mkdirSync(bakerStageDir, { recursive: true });
    fs.copyFileSync(
      path.join(bundlePaths["check-auth-config-baker"], "index.mjs"),
      path.join(bakerStageDir, "index.mjs"),
    );
    fs.copyFileSync(
      path.join(bundlePaths["check-auth"], "index.mjs"),
      path.join(bakerStageDir, "check-auth-base.mjs"),
    );

    const checkAuthBaker = new lambda.Function(this, "CheckAuthConfigBakerFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bakerStageDir),
      timeout: Duration.minutes(3),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description:
        "Vestibulum check-auth config baker: injects concrete Cognito config " +
        "into the Lambda@Edge bundle at deploy time and republishes the version.",
    });
    // The edge function lives in us-east-1; grant the baker the narrow
    // code/version writes on that function only.
    checkAuthBaker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "BakeCheckAuthConfig",
        // GetFunction(+Configuration) are needed by the `waitUntilFunctionUpdated`
        // poller after UpdateFunctionCode; PublishVersion mints the version the
        // CloudFront association points at.
        actions: [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:PublishVersion",
        ],
        resources: [checkAuthFn.lambda.functionArn, `${checkAuthFn.lambda.functionArn}:*`],
      }),
    );

    const checkAuthBakerProvider = new customResources.Provider(
      this,
      "CheckAuthConfigBakerProvider",
      { onEventHandler: checkAuthBaker },
    );

    const checkAuthBake = new CustomResource(this, "CheckAuthConfigBake", {
      serviceToken: checkAuthBakerProvider.serviceToken,
      resourceType: "Custom::VestibulumCheckAuthConfig",
      properties: {
        FunctionName: checkAuthFn.functionName,
        FunctionRegion: "us-east-1",
        UserPoolId: identity.cognitoPool.userPoolId,
        ClientId: this.websiteClient.userPoolClientId,
        HomeRegion: Stack.of(this).region,
        // Forces a re-bake when the base bundle changes (e.g. a vestibulum
        // upgrade) even if the config values are unchanged.
        BaseSha: manifest.bundles["check-auth"]?.sha256 ?? "unknown",
      },
    });
    // Bake only after the function exists.
    checkAuthBake.node.addDependency(checkAuthFn);

    // The published, config-baked version the CloudFront viewer-request
    // association uses. The version ARN is a deploy-time token, so its region
    // is unresolved at synth — CloudFront's "edge functions must be us-east-1"
    // check passes on the unresolved region, and the ARN itself is us-east-1.
    const bakedCheckAuthVersion = lambda.Version.fromVersionArn(
      this,
      "CheckAuthBakedVersion",
      checkAuthBake.getAttString("FunctionVersionArn"),
    );

    // cdk-nag suppressions for the config baker. The baker function's IAM5 is
    // an intentional, narrowly-scoped wildcard (the function's version ARNs);
    // the Provider framework findings are inherent to the CDK pattern (as with
    // the SES verification-wait resources in MagicLinkIdentity).
    NagSuppressions.addResourceSuppressions(
      checkAuthBaker,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "The baker uses the CDK-managed AWSLambdaBasicExecutionRole for its " +
            "own CloudWatch Logs only.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "lambda:UpdateFunctionCode/PublishVersion are scoped to the single " +
            "check-auth function and its version ARNs (`<fn>` and `<fn>:*`); the " +
            "`:*` wildcard only spans that one function's published versions.",
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      checkAuthBakerProvider,
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "Provider framework Lambda runtime is managed by aws-cdk-lib's " +
            "custom_resources.Provider and pinned by the CDK version, not " +
            "consumer-controllable.",
        },
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Provider framework role uses the CDK-managed " +
            "AWSLambdaBasicExecutionRole for its own CloudWatch Logs.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Provider framework role wildcards are inherent to the " +
            "custom_resources.Provider pattern and not consumer-controllable.",
        },
      ],
      true,
    );

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
      sources: [
        s3deploy.Source.asset(loginPagesDir),
        // Deploy-time runtime config for the browser. The login page is a
        // static asset, so the public website-client id + region (needed for
        // the browser's Cognito `InitiateAuth` call) are injected here. CDK
        // substitutes the `userPoolClientId` token at deploy via the bucket
        // deployment custom resource. Nothing secret: the SPA client has no
        // secret (`generateSecret: false`), and the client id is public.
        s3deploy.Source.jsonData("login-config.json", {
          region,
          userPoolClientId: this.websiteClient.userPoolClientId,
          domain,
        }),
      ],
      destinationBucket: this.loginPageBucket,
      prune: true,
    });

    // -------------------------------------------------------------------
    // Response-headers policy. Branding suppressible via S-C12.
    // -------------------------------------------------------------------
    // Strict `connect-src 'self'` everywhere. The login page previously relaxed
    // this to the regional Cognito IDP endpoint (the browser called
    // `InitiateAuth` directly), but sign-in initiation now goes through the
    // same-origin `/auth-login` endpoint and the callback POSTs same-origin to
    // `/auth-verify` — so no Cognito connect-src relaxation is needed.
    const cspWith = (connectSrc: string): string =>
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src ${connectSrc}`,
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ");

    const makeResponseHeadersPolicy = (
      idSuffix: string,
      nameSuffix: string,
      csp: string,
    ): cloudfront.ResponseHeadersPolicy =>
      new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${idSuffix}`, {
        responseHeadersPolicyName: `${this.namespacePrefix}AuthSite${nameSuffix}-${region}-${domain.replace(/\./g, "-")}`,
        comment: `Security headers for ${this.namespacePrefix} AuthSite on ${domain}.`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(730),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: csp,
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

    const responseHeadersPolicy =
      props.responseHeadersPolicy ?? makeResponseHeadersPolicy("", "", cspWith("'self'"));

    const commonBehavior: Partial<cloudfront.AddBehaviorOptions> = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };

    // The auth Function URL endpoints must NOT cache (CachingDisabled, from
    // `commonBehavior`) but DO need cookies forwarded: CloudFront strips
    // `Set-Cookie` from origin responses AND request cookies before the origin
    // unless cookies are forwarded, so sign-in never sets the id-token cookie
    // and sign-out never sees the tokens it must revoke. A caching-disabled
    // cache policy cannot carry a cookie behaviour ("CookieBehavior is invalid
    // for policy with caching disabled"), so forwarding is done with an origin
    // request policy. The managed `AllViewerExceptHostHeader` policy forwards
    // all viewer headers/cookies/query EXCEPT Host — the right choice for a
    // Lambda Function URL origin (OAC signs against the Lambda URL host, so the
    // viewer Host must not be forwarded). See AWS: "Cache content based on
    // cookies" + managed origin request policies.
    const authOriginRequestPolicy =
      cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    // -------------------------------------------------------------------
    // Login-page URI rewrite (CloudFront Function, viewer-request).
    //
    // The login pages are served under the single `/login*` behaviour
    // below. The two extensionless *page* routes map to their `.html`
    // objects; every other key under `/login*` (`/login.css`,
    // `/login.js`, `/login-callback.js`, `/login-config.json`) passes
    // through to its real S3 key. Without this, CloudFront would forward
    // the extensionless key (`login`, `login/callback`) to S3 and the
    // OAC origin would return 403 for the missing object.
    //
    // No explicit `functionName`: CDK auto-generates a unique, valid name
    // (`region` + a bounded hash, capped at 40 chars) that always fits
    // CloudFront's 64-char function-name limit. A hand-built
    // `prefix-AuthSiteLoginRewrite-region-domain` name overflows 64 chars for
    // ordinary domains (e.g. `atrium.dev.de-otio.org` → 66) and fails deploy.
    const loginRewriteFn = new cloudfront.Function(this, "LoginRewriteFn", {
      comment: `Rewrites /login and /login/callback to their .html objects for ${domain}.`,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          "  if (request.uri === '/login') {",
          "    request.uri = '/login.html';",
          "  } else if (request.uri === '/login/callback') {",
          "    request.uri = '/login-callback.html';",
          "  }",
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // -------------------------------------------------------------------
    // CloudFront distribution.
    // -------------------------------------------------------------------
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domain],
      certificate: edge.certificate,
      ...(edge.webAcl ? { webAclId: edge.webAcl.attrArn } : {}),
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
            // The config-baked version (deploy-time-injected Cognito config),
            // NOT the raw EdgeFunction whose code still has PLACEHOLDER_* seams.
            functionVersion: bakedCheckAuthVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // One prefix behaviour serves the whole login UI off the login-page
        // bucket: the `/login` and `/login/callback` page routes (rewritten
        // to their `.html` objects by `loginRewriteFn`) plus the static
        // assets `/login.css`, `/login.js`, `/login-callback.js`, and the
        // deploy-injected `/login-config.json`. The login pages are
        // unauthenticated (no check-auth Lambda@Edge), so the gate does not
        // bounce them back to `/login`.
        "/login*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.loginPageBucket),
          ...commonBehavior,
          // Same strict security headers as the app — login initiation is
          // same-origin (`/auth-login`), so no CSP relaxation is needed.
          responseHeadersPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          functionAssociations: [
            {
              function: loginRewriteFn,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        "/auth-verify*": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.authVerifyUrl),
          ...commonBehavior,
          // Forward cookies (so the Set-Cookie sign-in response reaches the
          // viewer) without caching; Host excluded to keep OAC signing valid.
          originRequestPolicy: authOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        "/auth-login*": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.authLoginUrl),
          ...commonBehavior,
          // auth-login is a POST endpoint that sets the id-token cookie via
          // Set-Cookie; forward cookies (Host excluded) and allow all methods,
          // mirroring /auth-verify*.
          originRequestPolicy: authOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        "/auth-signout": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(this.authSignoutUrl),
          ...commonBehavior,
          // auth-signout READS the id-token/refresh-token request cookies and
          // clears them via Set-Cookie; both need cookie forwarding.
          originRequestPolicy: authOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
    });

    // When the supplied edge resources opt out of the Web ACL
    // (`EdgeResources.enableWebAcl: false`), the distribution above
    // synthesises without a `WebACLId`. Mark it so the build-time
    // `WafRequiredAspect` treats the absence as deliberate rather than
    // failing the synth.
    if (!edge.webAcl) {
      markWafIntentionallyDisabled(this.distribution.node.defaultChild as Construct);
    }

    // OAC POST support. CloudFront OAC for a Lambda Function URL requires the
    // CloudFront service principal to hold BOTH `lambda:InvokeFunctionUrl`
    // (added by `FunctionUrlOrigin.withOriginAccessControl`) AND
    // `lambda:InvokeFunction`. Without the latter, a correctly-signed POST is
    // rejected at the Function URL auth layer with `403 Forbidden` and the
    // handler never runs — so the browser sign-in POST to `/auth-verify` (and a
    // POST sign-out to `/auth-signout`) cannot complete. Both grants are scoped
    // to this distribution via `AWS:SourceArn`.
    // See: AWS docs — "Restrict access to an AWS Lambda function URL origin"
    // (grants both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`).
    const distributionArn = Stack.of(this).formatArn({
      service: "cloudfront",
      region: "",
      resource: "distribution",
      resourceName: this.distribution.distributionId,
    });
    authVerifyFn.addPermission("AuthVerifyOacInvokeFunction", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: distributionArn,
    });
    authSignoutFn.addPermission("AuthSignoutOacInvokeFunction", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: distributionArn,
    });
    authLoginFn.addPermission("AuthLoginOacInvokeFunction", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: distributionArn,
    });
  }
}
