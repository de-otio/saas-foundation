/**
 * CloudFront distribution for `SharedDistributionIdentity` —
 * one distribution serving all tenants under a wildcard
 * subdomain. Implements
 * `doc/vestibulum/shared-distribution/01-architecture.md` topology
 * and `05-wildcard-infra.md` wildcard cert+DNS wiring.
 *
 * Origins:
 *   - **S3 login pages**: bundled HTML/CSS under
 *     `packages/vestibulum-cdk/login-pages/` (same source as the
 *     single-tenant MagicLinkAuthSite). Default behaviour.
 *   - **`auth-verify` Function URL** (HTTP origin): paths matching
 *     `/login/callback*`. No edge `check-auth`.
 *   - **`auth-signout` Function URL** (HTTP origin): paths matching
 *     `/logout*`. No edge `check-auth`.
 *
 * The parent host (`<parent>` exactly, not a tenant subdomain) is
 * served by the S3 origin with NO edge check (per `05-wildcard-infra.md`
 * § Apex / parent landing page).
 *
 * Optional `webAclArn` is the ACL ARN (typically built by `Waf`).
 * Optional `responseHeadersPolicy` overrides the default one built
 * by `security-headers.ts`.
 *
 * MCP C3 confirmed (2026-05-24): `cloudfront.experimental.EdgeFunction`
 * is the supported pattern for Lambda@Edge in CDK v2; the codebase
 * already uses it.
 */

import * as path from "node:path";

import {
  RemovalPolicy,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { packageRootFrom } from "../_internal/package-root.js";
import {
  type BucketLifecycleProps,
  defaultImmutableAssetLifecycleRules,
  resolveLifecycleRules,
} from "../_internal/s3-lifecycle.js";
import { createDefaultResponseHeadersPolicy } from "./security-headers.js";

export interface CloudFrontDistributionProps {
  /**
   * Apex domain under which tenants live (no trailing dot). The
   * distribution gets alternate names `*.<parent>` AND `<parent>`.
   */
  readonly tenantSubdomainParent: string;

  /**
   * ARN of the wildcard ACM cert (us-east-1). P2a is expected to
   * provision the cert and pass its ARN here.
   */
  readonly wildcardCertificateArn: string;

  /**
   * URL of the `auth-verify` Function URL (e.g.
   * `https://abc123.lambda-url.eu-central-1.on.aws/`). Resolved by
   * the consumer before passing — `lambda.FunctionUrl.url` returns
   * the FQDN with trailing slash.
   */
  readonly authVerifyFunctionUrl: string;

  /**
   * URL of the `auth-signout` Function URL.
   */
  readonly authSignoutFunctionUrl: string;

  /**
   * The deployed edge-function version. Wire from
   * {@link EdgeFunction.version}.
   */
  readonly edgeFunctionVersion: lambda.IVersion;

  /**
   * Optional pre-built WAF ACL ARN. When set, the distribution
   * attaches it. When unset, no `webAclId` is wired (the consumer
   * is expected to attach one out-of-band or rely on
   * non-WAF protections — not recommended).
   */
  readonly webAclArn?: string;

  /**
   * Optional override for the response headers policy. When unset,
   * the default policy from `security-headers.ts` is applied.
   */
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

  /**
   * Optional local-disk path to a custom parent-landing page (HTML
   * file). When set, this file replaces `login-pages/tenant-parent.html`
   * in the deployed bucket.
   */
  readonly tenantParentLandingPage?: string;

  /**
   * CloudFront price class. Defaults to PRICE_CLASS_100 (NA + EU)
   * for the EU-residency-friendly mitigation.
   * @default PriceClass.PRICE_CLASS_100
   */
  readonly priceClass?: cloudfront.PriceClass;

  /**
   * Optional S3 lifecycle configuration applied to the login-page
   * bucket. Cost-pillar review S4.
   *
   * When omitted, the construct applies an immutable-asset default
   * (abort incomplete multipart uploads after 7 days; transition to
   * Standard-IA after 30 days; expire noncurrent versions after 90
   * days). A non-empty `rules` array replaces the default entirely;
   * `rules: []` disables the lifecycle.
   */
  readonly lifecycle?: BucketLifecycleProps;

  /**
   * Override the on-disk path to the `vestibulum-cdk` package root.
   * Test-only — provides the `login-pages/` directory for the
   * `BucketDeployment` source.
   *
   * @internal
   */
  readonly _packageRoot?: string;
}

/**
 * The CloudFront distribution + login-page bucket.
 *
 * Exposed:
 *  - `distribution`: the `cloudfront.IDistribution`.
 *  - `loginPageBucket`: the S3 bucket holding login pages (for
 *    consumers who want to deploy extra static assets).
 */
export class CloudFrontDistribution extends Construct {
  public readonly distribution: cloudfront.IDistribution;
  public readonly loginPageBucket: s3.IBucket;

  public constructor(
    scope: Construct,
    id: string,
    props: CloudFrontDistributionProps,
  ) {
    super(scope, id);

    const parent = props.tenantSubdomainParent.replace(/\.$/, "");

    // -----------------------------------------------------------------
    // ACM cert reference. The cert lives in us-east-1; CDK accepts a
    // cross-region cert by ARN via `Certificate.fromCertificateArn`.
    // -----------------------------------------------------------------
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WildcardCertRef",
      props.wildcardCertificateArn,
    );

    // -----------------------------------------------------------------
    // S3 login-pages bucket. Mirror MagicLinkAuthSite's pattern —
    // private bucket with OAC.
    // -----------------------------------------------------------------
    const lifecycleRules = resolveLifecycleRules(
      props.lifecycle,
      defaultImmutableAssetLifecycleRules(),
    );
    this.loginPageBucket = new s3.Bucket(this, "LoginPageBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Cost-pillar S4: default S3 lifecycle (abort multipart at 7d,
      // Standard → IA at 30d, noncurrent expiry at 90d). An empty
      // `lifecycleRules` array opts out.
      lifecycleRules,
    }) as unknown as s3.IBucket;

    const packageRoot = props._packageRoot ?? packageRootFrom(import.meta.url);
    const loginPagesDir = path.join(packageRoot, "login-pages");
    const deploymentSources = [s3deploy.Source.asset(loginPagesDir)];
    if (props.tenantParentLandingPage !== undefined) {
      // The override is treated as the parent landing page.
      // Deploy alongside the bundled assets; later sources win on
      // key collision (s3deploy semantic).
      deploymentSources.push(
        s3deploy.Source.asset(path.dirname(props.tenantParentLandingPage), {
          exclude: ["*"],
          // include only the file the consumer passed
        }),
      );
    }
    new s3deploy.BucketDeployment(this, "LoginPagesDeploy", {
      sources: deploymentSources,
      destinationBucket: this.loginPageBucket,
      prune: true,
    });

    // -----------------------------------------------------------------
    // Response headers policy.
    // -----------------------------------------------------------------
    const responseHeadersPolicy =
      props.responseHeadersPolicy ??
      createDefaultResponseHeadersPolicy(this, "ResponseHeadersPolicy");

    // -----------------------------------------------------------------
    // Origins.
    // -----------------------------------------------------------------
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      this.loginPageBucket,
    );
    const verifyOrigin = new origins.HttpOrigin(
      stripUrl(props.authVerifyFunctionUrl),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      },
    );
    const signoutOrigin = new origins.HttpOrigin(
      stripUrl(props.authSignoutFunctionUrl),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      },
    );

    // -----------------------------------------------------------------
    // Behaviour shape — shared bits.
    // -----------------------------------------------------------------
    const commonBehaviorBase = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy,
    };

    const edgeBehaviour = {
      ...commonBehaviorBase,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      edgeLambdas: [
        {
          functionVersion: props.edgeFunctionVersion,
          eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
        },
      ],
    };

    // Domains: wildcard + parent.
    const domainNames = [`*.${parent}`, parent];

    // -----------------------------------------------------------------
    // Distribution.
    // -----------------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames,
      certificate,
      ...(props.webAclArn !== undefined && { webAclId: props.webAclArn }),
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: `Vestibulum shared distribution for *.${parent}`,
      defaultBehavior: {
        origin: s3Origin,
        ...edgeBehaviour,
      },
      additionalBehaviors: {
        // Auth-verify endpoint — no edge check.
        "/login/callback*": {
          origin: verifyOrigin,
          ...commonBehaviorBase,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        // Logout endpoint — no edge check.
        "/logout*": {
          origin: signoutOrigin,
          ...commonBehaviorBase,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        // Login page itself — no edge check (otherwise un-authenticated
        // users get redirected away from /login → /login again).
        "/login": {
          origin: s3Origin,
          ...commonBehaviorBase,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        // Login CSS / assets.
        "/login/*": {
          origin: s3Origin,
          ...commonBehaviorBase,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
    });

    this.distribution = distribution;
  }
}

/**
 * Strip the `https://` prefix and any trailing slash from a Function
 * URL so it can be fed to `origins.HttpOrigin` (which wants just the
 * hostname). Function URLs are always `https`, so we trust that.
 */
function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
