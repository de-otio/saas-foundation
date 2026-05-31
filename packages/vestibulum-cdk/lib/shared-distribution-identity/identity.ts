/**
 * `SharedDistributionIdentity` — the multi-tenant shared-pool sibling
 * of `MagicLinkIdentity`.
 *
 * Owns:
 *   - One shared Cognito user pool (with refresh-token rotation
 *     compatible auth flow — `REFRESH_TOKEN_AUTH` deliberately NOT in
 *     ExplicitAuthFlows; see [03-tenant-onboarding.md]).
 *   - Three DynamoDB tables (`ClientConfig`, `MagicLinkTokens`,
 *     `Reservations`).
 *   - Wildcard ACM cert (us-east-1) + DNS-validated.
 *   - Five Cognito trigger Lambdas + two Function URL Lambdas
 *     (auth-verify, auth-signout).
 *
 * Does NOT own (left to sibling phases):
 *   - CloudFront distribution + edge `check-auth` Lambda — owned by P2b
 *     (`shared-distribution-identity/edge.ts`).
 *   - CloudFront / Cognito WAF web ACLs — owned by P2b.
 *   - Response Headers Policy — owned by P2b.
 *   - Admin Lambda + Function URL — owned by P2c
 *     (`shared-distribution-identity/admin-lambda.ts`).
 *   - Reconciler Lambda + EventBridge schedule — owned by P2c.
 *
 * Public surface exposes the integration seams P2b/P2c need:
 * `userPool`, `clientConfigTable`, `magicLinkTokensTable`,
 * `reservationsTable`, `wildcardCertificateArn`, the trigger Lambdas,
 * and the Function URLs.
 *
 * **Sibling construct, not subclass.** Per [02-construct-api.md]
 * § Decision: sibling construct — duplicating `MagicLinkIdentity` is
 * the right call given the prop-matrix size and the disjoint
 * deploy-vs-data flows.
 */

import { Annotations, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

import { RuntimeEnv } from "../_internal/runtime-env.js";
import {
  installCostDosGuard,
  type CostDosGuardProps,
  type CostDosGuardResources,
} from "../_internal/cost-dos-guard.js";
import { AdminLambda } from "./admin-lambda.js";
import { ClientConfigTable } from "./client-config-table.js";
import { CloudFrontDistribution } from "./cloudfront-distribution.js";
import { EdgeFunction } from "./edge-function.js";
import { Reconciler } from "./reconciler.js";
import { ReservationsTable } from "./reservations-table.js";
import { createDefaultResponseHeadersPolicy } from "./security-headers.js";
import { SharedDistributionTriggers } from "./triggers.js";
import { Waf } from "./waf.js";
import { WildcardCert } from "./wildcard-cert.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Cognito Advanced Security mode for the shared pool.
 *
 * Defaults to `'audit'` (rather than `'off'` like `MagicLinkIdentity`)
 * — shared pools are higher-value targets for credential-stuffing,
 * and the audit-mode signal is load-bearing for tenant-attribution
 * investigations.
 */
export type AdvancedSecurityMode = "off" | "audit" | "enforced";

/**
 * Default tenant-subdomain pattern: DNS-label-shaped, leading letter,
 * no trailing dash. Length 3-64 (matches Cognito client-name max).
 *
 * Per [05-wildcard-infra.md] § Single-level constraint and the
 * subdomain pattern.
 */
export const DEFAULT_TENANT_SUBDOMAIN_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Default reserved subdomains. Per [05-wildcard-infra.md] § Reserved
 * subdomains.
 */
export const DEFAULT_RESERVED_SUBDOMAINS: readonly string[] = Object.freeze([
  "admin",
  "www",
  "api",
  "cdn",
  "static",
  "auth",
  "mail",
  "ftp",
  "localhost",
]);

export interface SharedDistributionIdentityProps {
  /**
   * Parent subdomain that all tenants share. Tenants land on
   * leftmost-label subdomains — e.g. with `tenants.example.com`,
   * tenant `acme` lives at `acme.tenants.example.com`.
   */
  readonly tenantSubdomainParent: string;

  /**
   * SES verified identity used as the magic-link sender.
   */
  readonly sesIdentitySender: string;

  /**
   * Route 53 hosted zone for the parent domain. If provided, the
   * construct creates the wildcard cert with DNS validation.
   * Mutually exclusive with {@link existingWildcardCertificateArn}.
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Existing wildcard cert in us-east-1. Mutually exclusive with
   * {@link hostedZone}.
   */
  readonly existingWildcardCertificateArn?: string;

  /**
   * Reserved subdomain labels (rejected as tenant identifiers by the
   * admin Lambda). Default: {@link DEFAULT_RESERVED_SUBDOMAINS}.
   */
  readonly reservedSubdomains?: readonly string[];

  /**
   * Tenant-subdomain pattern. Default:
   * {@link DEFAULT_TENANT_SUBDOMAIN_PATTERN}.
   */
  readonly tenantSubdomainPattern?: RegExp;

  /**
   * Magic-link cookie TTL. Default 30 days.
   */
  readonly sessionCookieTtl?: Duration;

  /**
   * IAM principal allowed to invoke the admin Lambda Function URL.
   * No default — must be set explicitly. Per [02-construct-api.md]
   * § adminInvokePrincipal.
   *
   * The dual-permission grant (October 2025 change) is wired by P2c
   * when it provisions the admin Lambda; this principal is held here
   * for that wiring step.
   */
  readonly adminInvokePrincipal: iam.IPrincipal;

  /**
   * KMS key for `ClientConfig` and `MagicLinkTokens` tables. Default
   * AWS_MANAGED (not AWS_OWNED).
   */
  readonly tableKmsKey?: kms.IKey;

  /**
   * WAF web ACL ARN for the CloudFront distribution. If unset, P2b's
   * `edge.ts` constructs a default ACL. Held here for P2b consumption.
   */
  readonly cloudFrontWebAclArn?: string;

  /**
   * WAF web ACL ARN for the Cognito user pool. If unset, P2b's
   * `waf.ts` constructs a default ACL. Held here for P2b consumption.
   *
   * NOTE: Cognito WAF association is a Cognito-pool prop, not a
   * CloudFront prop. P2b applies it post-construction.
   */
  readonly cognitoPoolWebAclArn?: string;

  /**
   * CloudFront Response Headers Policy. If unset, the construct
   * produces a hardened default (HSTS preload, strict CSP, X-Frame-Options
   * DENY, etc.) via `security-headers.ts`.
   */
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

  /**
   * Edge JWKS cache TTL. Default 15 min. Held here for P2b's edge
   * bundle generator.
   */
  readonly jwksTtl?: Duration;

  /**
   * Default ID-token validity baked into app clients created by the
   * admin Lambda. Default 60 min. Per [02-construct-api.md].
   */
  readonly idTokenValidity?: Duration;

  /**
   * Emit per-tenant CloudWatch metric dimensions. Default false
   * (controls cost; see [08-observability-and-audit.md] § Cardinality
   * note).
   */
  readonly perTenantMetrics?: boolean;

  /**
   * SNS topic for alarm actions. If unset, alarms are still created
   * but unsubscribed (operator-visible by polling). Per
   * [08-observability-and-audit.md] § CloudWatch alarms.
   */
  readonly alarmTopic?: sns.ITopic;

  /**
   * Cognito Advanced Security mode. Default 'audit' for the shared
   * pool (load-bearing signal for tenant-attribution).
   */
  readonly advancedSecurity?: AdvancedSecurityMode;

  /**
   * Override the cert SAN list. Default `[<parent>]` (combined with
   * the always-present `*.<parent>` wildcard). Pass `[]` to exclude
   * the parent.
   */
  readonly certificateSubjectAlternativeNames?: readonly string[];

  /**
   * Optional CORS options for the admin Function URL.
   * Default: no CORS (`AllowOrigins: []`).
   * Wildcard `['*']` is refused at synth time — IAM-auth'd Function URLs
   * must not be wildcard-CORS.
   */
  readonly adminFunctionUrlCors?: lambda.FunctionUrlCorsOptions;

  /**
   * Skip the esbuild step for the edge function bundle. Test-only.
   * When set, the `EdgeFunction` construct writes a stub bundle and
   * returns a deterministic placeholder hash instead of running esbuild.
   *
   * @internal
   */
  readonly _skipEdgeBundle?: boolean;

  /**
   * Override the bundle output directory for the edge function. Test-only.
   *
   * @internal
   */
  readonly _edgeBundleOutDirOverride?: string;

  /**
   * Removal policy for the Cognito user pool. Default RETAIN.
   * Override for ephemeral environments only — user data lives in the
   * pool, and replacing the pool replaces every user's identity.
   */
  readonly userPoolRemovalPolicy?: RemovalPolicy;

  /**
   * Consumer-supplied PreTokenGeneration trigger.
   *
   * When set, the construct's built-in PreTokenGeneration Lambda is
   * NOT wired to the pool — the consumer Lambda is the sole trigger.
   * The consumer is expected to wrap their handler with
   * `wrapPreTokenHandler` from `@de-otio/vestibulum/lambda/shared`
   * so `custom:tenant_id` is contract-enforced. See
   * [06-trigger-handlers.md] § Allowing consumer customisation.
   *
   * Setting this AFTER construction via the `preTokenGeneration(fn)`
   * method is unsupported — Cognito refuses to register two triggers
   * for the same operation.
   */
  readonly preTokenGeneration?: lambda.IFunction;

  /**
   * Consumer-supplied PostConfirmation trigger. The construct ships
   * no default for this operation.
   */
  readonly postConfirmation?: lambda.IFunction;

  /**
   * Cost-DoS guard for the SES outbound side (cost-pillar review S7).
   *
   * When set with `enabled: true`, deploys a CloudWatch alarm on the
   * `AWS/SES` `Send` metric scoped to the sender's SES identity domain
   * with threshold `sendsPerHourCap`, and (with `selfDefence: true`) a
   * handler that disables Cognito self-sign-up when the alarm fires.
   *
   * Default (unset / `enabled: false`): no alarm, no handler.
   *
   * See `doc/vestibulum-cdk/04-magic-link-auth-site.md § SES cost-DoS guard`.
   */
  readonly costDosGuard?: CostDosGuardProps;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SharedDistributionIdentityPropsError extends Error {
  public override readonly name = "SharedDistributionIdentityPropsError";
  public constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/**
 * Shared-pool multi-tenant identity. Sibling of `MagicLinkIdentity`.
 */
export class SharedDistributionIdentity extends Construct {
  /** The shared Cognito user pool. */
  readonly userPool: cognito.UserPool;

  /**
   * The ClientConfig DDB table (public so consumers can read it).
   *
   * Typed as the concrete `dynamodb.Table` (not `ITable`) because P2c's
   * admin Lambda needs the GSI-aware grant helpers and the
   * `tableStreamArn` field's optional shape on `ITable` is incompatible
   * with the project's `exactOptionalPropertyTypes`.
   */
  readonly clientConfigTable: dynamodb.Table;

  /** Internal helper exposing grant shortcuts; same table as `clientConfigTable`. */
  readonly clientConfigTableConstruct: ClientConfigTable;

  /** MagicLinkTokens DDB table (carry-over shape from single-tenant). */
  readonly magicLinkTokensTable: dynamodb.Table;

  /** Reservations DDB table — admin-Lambda uses for tenant-namespace locking. */
  readonly reservationsTable: dynamodb.Table;

  /** Admin Lambda Function URL (IAM-auth'd). */
  readonly adminFunctionUrl: string;

  /** Admin Lambda function name (for SDK invocation). */
  readonly adminLambdaName: string;

  /** Wildcard ACM cert ARN (whether created or imported). */
  readonly wildcardCertificateArn: string;

  /** The CloudFront distribution serving all tenants. */
  readonly distribution: cloudfront.IDistribution;

  /** Lambda@Edge log groups (populated lazily by consumer code). */
  readonly edgeLogGroups: logs.ILogGroup[];

  /** SHA-256 hex of the edge bundle bytes (`sha256:...`). Stable across re-synths. */
  readonly edgeBundleSha256: string;

  /** Trigger Lambdas — exposed for P2c (which may add IAM grants). */
  readonly preSignUpFn: lambda.Function;
  readonly createAuthChallengeFn: lambda.Function;
  readonly preTokenGenerationFn: lambda.Function;
  readonly defineAuthChallengeFn: lambda.Function;
  readonly verifyAuthChallengeResponseFn: lambda.Function;
  readonly authVerifyFn: lambda.Function;
  readonly authSignoutFn: lambda.Function;
  readonly authVerifyFunctionUrl: lambda.FunctionUrl;
  readonly authSignoutFunctionUrl: lambda.FunctionUrl;

  /** Tenant-subdomain pattern in effect. */
  readonly tenantSubdomainPattern: RegExp;

  /** Reserved-subdomain list in effect. */
  readonly reservedSubdomains: readonly string[];

  /** Tenant parent. */
  readonly tenantSubdomainParent: string;

  /** Effective advanced-security mode. */
  readonly advancedSecurity: AdvancedSecurityMode;

  /** Effective ID-token validity. */
  readonly idTokenValidity: Duration;

  /** Effective WAF ACL ARNs (always set after construction). */
  readonly wafCloudFrontWebAclArn: string;
  readonly wafCognitoPoolWebAclArn: string;

  /** Held for consumer introspection. */
  readonly adminInvokePrincipal: iam.IPrincipal;
  readonly tableKmsKey: kms.IKey | undefined;
  readonly jwksTtl: Duration;
  readonly perTenantMetrics: boolean;
  readonly alarmTopic: sns.ITopic | undefined;
  readonly sessionCookieTtl: Duration;

  /**
   * Resources created by the optional cost-DoS guard (S7). Present only
   * when `props.costDosGuard?.enabled === true`; `undefined` otherwise.
   */
  readonly costDosGuard: CostDosGuardResources | undefined;

  constructor(scope: Construct, id: string, props: SharedDistributionIdentityProps) {
    super(scope, id);

    // -----------------------------------------------------------------------
    // Prop validation + defaults
    // -----------------------------------------------------------------------

    if (!props.tenantSubdomainParent || props.tenantSubdomainParent.length === 0) {
      throw new SharedDistributionIdentityPropsError(
        `[vestibulum-cdk:SharedDistributionIdentity] 'tenantSubdomainParent' ` +
          `is required and must be non-empty.`,
      );
    }
    if (!props.sesIdentitySender || !props.sesIdentitySender.includes("@")) {
      throw new SharedDistributionIdentityPropsError(
        `[vestibulum-cdk:SharedDistributionIdentity] 'sesIdentitySender' must ` +
          `be a fully-qualified email address; got '${props.sesIdentitySender}'.`,
      );
    }
    this.tenantSubdomainParent = props.tenantSubdomainParent;
    this.tenantSubdomainPattern =
      props.tenantSubdomainPattern ?? DEFAULT_TENANT_SUBDOMAIN_PATTERN;
    this.reservedSubdomains = Object.freeze(
      props.reservedSubdomains
        ? [...props.reservedSubdomains]
        : [...DEFAULT_RESERVED_SUBDOMAINS],
    );

    this.sessionCookieTtl = props.sessionCookieTtl ?? Duration.days(30);
    this.idTokenValidity = props.idTokenValidity ?? Duration.minutes(60);
    if (this.idTokenValidity.toMinutes() < 5) {
      throw new SharedDistributionIdentityPropsError(
        `[vestibulum-cdk:SharedDistributionIdentity] 'idTokenValidity' must ` +
          `be at least 5 minutes (Cognito floor); got ` +
          `${this.idTokenValidity.toMinutes()} min.`,
      );
    }

    this.jwksTtl = props.jwksTtl ?? Duration.minutes(15);
    // Use seconds for the floor check — `toMinutes()` throws on
    // sub-minute durations (Duration disallows lossy conversions).
    if (this.jwksTtl.toSeconds() < 60) {
      throw new SharedDistributionIdentityPropsError(
        `[vestibulum-cdk:SharedDistributionIdentity] 'jwksTtl' must be at ` +
          `least 1 minute; got ${this.jwksTtl.toSeconds()}s.`,
      );
    }

    this.adminInvokePrincipal = props.adminInvokePrincipal;
    this.tableKmsKey = props.tableKmsKey;
    this.perTenantMetrics = props.perTenantMetrics ?? false;
    this.alarmTopic = props.alarmTopic;
    this.advancedSecurity = props.advancedSecurity ?? "audit";

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    this.clientConfigTableConstruct = new ClientConfigTable(this, "ClientConfig", {
      ...(props.tableKmsKey ? { tableKmsKey: props.tableKmsKey } : {}),
    });
    this.clientConfigTable = this.clientConfigTableConstruct.table;

    // MagicLinkTokens — same shape as single-tenant token table.
    const magicLinkTokensEncryption: dynamodb.TableEncryption = props.tableKmsKey
      ? dynamodb.TableEncryption.CUSTOMER_MANAGED
      : dynamodb.TableEncryption.AWS_MANAGED;
    this.magicLinkTokensTable = new dynamodb.Table(this, "MagicLinkTokens", {
      partitionKey: {
        name: "token_hash",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: magicLinkTokensEncryption,
      ...(props.tableKmsKey ? { encryptionKey: props.tableKmsKey } : {}),
      timeToLiveAttribute: "expires_at",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const reservations = new ReservationsTable(this, "Reservations");
    this.reservationsTable = reservations.table;

    // -----------------------------------------------------------------------
    // Wildcard cert (+ DNS later in P2b once distribution is known)
    // -----------------------------------------------------------------------

    const wildcardCert = new WildcardCert(this, "Wildcard", {
      tenantSubdomainParent: props.tenantSubdomainParent,
      ...(props.hostedZone ? { hostedZone: props.hostedZone } : {}),
      ...(props.existingWildcardCertificateArn != null && props.existingWildcardCertificateArn !== ''
        ? { existingWildcardCertificateArn: props.existingWildcardCertificateArn }
        : {}),
      ...(props.certificateSubjectAlternativeNames !== undefined
        ? { certificateSubjectAlternativeNames: props.certificateSubjectAlternativeNames }
        : {}),
    });
    this.wildcardCertificateArn = wildcardCert.certificateArn;

    // -----------------------------------------------------------------------
    // Trigger Lambdas (Cognito triggers + Function URL handlers)
    // -----------------------------------------------------------------------

    const triggers = new SharedDistributionTriggers(this, "Triggers", {
      clientConfigTable: this.clientConfigTableConstruct,
      tenantSubdomainParent: props.tenantSubdomainParent,
      sesIdentitySender: props.sesIdentitySender,
    });

    this.preSignUpFn = triggers.preSignUp;
    this.createAuthChallengeFn = triggers.createAuthChallenge;
    this.preTokenGenerationFn = triggers.preTokenGeneration;
    this.defineAuthChallengeFn = triggers.defineAuthChallenge;
    this.verifyAuthChallengeResponseFn = triggers.verifyAuthChallengeResponse;
    this.authVerifyFn = triggers.authVerify;
    this.authSignoutFn = triggers.authSignout;
    this.authVerifyFunctionUrl = triggers.authVerifyFunctionUrl;
    this.authSignoutFunctionUrl = triggers.authSignoutFunctionUrl;

    // -----------------------------------------------------------------------
    // Cognito user pool
    // -----------------------------------------------------------------------

    const userPoolRemovalPolicy = props.userPoolRemovalPolicy ?? RemovalPolicy.RETAIN;

    this.userPool = new cognito.UserPool(this, "Pool", {
      // Email-only sign-in. `usernameAttributes: ['email']` is the L1
      // equivalent; the L2 expresses it via `signInAliases`.
      signInAliases: { email: true },
      selfSignUpEnabled: true,
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      // `custom:tenant_id` is load-bearing for the edge check. Declared
      // here so the pool accepts the attribute when PreTokenGeneration
      // injects it. Mutable: false — once minted into a token it should
      // be stable for that user's session.
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: true, maxLen: 64 }),
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: {
        // Hardened policy — the magic-link flow doesn't use passwords,
        // but Cognito requires *some* policy. Make it strong enough to
        // resist drive-by takeover should the password flow ever be
        // accidentally enabled on an app client.
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      email: cognito.UserPoolEmail.withSES({
        fromEmail: props.sesIdentitySender,
        fromName: "Vestibulum",
        sesRegion: Stack.of(this).region,
      }),
      // PreventUserExistenceErrors is set on the app-client level, not
      // the pool — admin Lambda bakes it in when creating per-tenant
      // app clients.
      removalPolicy: userPoolRemovalPolicy,
    });

    // Wire triggers AFTER pool exists. If the consumer provided their
    // own PreTokenGeneration, skip wiring the built-in (per
    // [02-construct-api.md] § PreTokenGeneration is built in).
    triggers.attachToUserPool(this.userPool, {
      includeBuiltInPreTokenGeneration: props.preTokenGeneration === undefined,
    });

    if (props.preTokenGeneration !== undefined) {
      this.userPool.addTrigger(
        cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
        props.preTokenGeneration,
      );
      // Grant + env wiring is the consumer's responsibility for
      // IFunction (we can't mutate IFunction's environment); the
      // construct's `grantReadClientConfig(fn)` is the explicit hook
      // for Function-typed inputs. Documented in the prop docstring.
      if (props.preTokenGeneration instanceof lambda.Function) {
        this.grantReadClientConfig(props.preTokenGeneration);
      }
    }
    if (props.postConfirmation !== undefined) {
      this.userPool.addTrigger(
        cognito.UserPoolOperation.POST_CONFIRMATION,
        props.postConfirmation,
      );
    }

    // Grant the auth-verify Lambda the Cognito IAM it needs (scoped to
    // this pool's ARN).
    triggers.grantAuthVerifyCognito(this.userPool.userPoolArn);

    // -----------------------------------------------------------------------
    // Advanced Security (default 'audit' for shared pools)
    // -----------------------------------------------------------------------

    const cfnPool = this.userPool.node.defaultChild as cognito.CfnUserPool;

    if (this.advancedSecurity !== "off") {
      Annotations.of(this).addInfo(
        `[vestibulum-cdk:SharedDistributionIdentity] ` +
          `advancedSecurity='${this.advancedSecurity}'. Cognito Advanced ` +
          `Security is billed per MAU above the free-tier cap. The shared ` +
          `pool defaults to 'audit' because cross-tenant credential-stuffing ` +
          `signals are load-bearing for incident response; pass ` +
          `advancedSecurity: 'off' to opt out.`,
      );

      cfnPool.userPoolAddOns = {
        advancedSecurityMode:
          this.advancedSecurity === "enforced" ? "ENFORCED" : "AUDIT",
      };
    }

    // -----------------------------------------------------------------------
    // P2b: WAF, edge function, CloudFront distribution, security headers
    // -----------------------------------------------------------------------

    const waf = new Waf(this, "Waf", {
      userPool: this.userPool,
      ...(props.cloudFrontWebAclArn !== undefined
        ? { cloudFrontWebAclArn: props.cloudFrontWebAclArn }
        : {}),
      ...(props.cognitoPoolWebAclArn !== undefined
        ? { cognitoPoolWebAclArn: props.cognitoPoolWebAclArn }
        : {}),
    });

    this.wafCloudFrontWebAclArn = waf.cloudFrontWebAclArn;
    this.wafCognitoPoolWebAclArn = waf.cognitoPoolWebAclArn;

    const responseHeadersPolicy =
      props.responseHeadersPolicy ??
      createDefaultResponseHeadersPolicy(this, "SecurityHeaders");

    const edgeFunction = new EdgeFunction(this, "EdgeFunction", {
      tenantSubdomainParent: this.tenantSubdomainParent,
      tenantSubdomainPattern: this.tenantSubdomainPattern,
      userPool: this.userPool,
      jwksTtl: this.jwksTtl,
      ...(props._skipEdgeBundle !== undefined
        ? { _skipBundle: props._skipEdgeBundle }
        : {}),
      ...(props._edgeBundleOutDirOverride !== undefined
        ? { _bundleOutDirOverride: props._edgeBundleOutDirOverride }
        : {}),
    });

    const distribution = new CloudFrontDistribution(this, "Distribution", {
      tenantSubdomainParent: this.tenantSubdomainParent,
      wildcardCertificateArn: this.wildcardCertificateArn,
      authVerifyFunctionUrl: this.authVerifyFunctionUrl.url,
      authSignoutFunctionUrl: this.authSignoutFunctionUrl.url,
      edgeFunctionVersion: edgeFunction.version,
      webAclArn: waf.cloudFrontWebAclArn,
      responseHeadersPolicy,
    });

    this.distribution = distribution.distribution;
    this.edgeLogGroups = edgeFunction.logGroups;
    this.edgeBundleSha256 = edgeFunction.bundleSha256;

    // -----------------------------------------------------------------------
    // P2c: Admin Lambda + reconciler
    // -----------------------------------------------------------------------

    // Cast concrete `dynamodb.Table` to `dynamodb.ITable` for the sub-construct
    // props. Under `exactOptionalPropertyTypes`, `Table.tableStreamArn` is
    // `string | undefined` which conflicts with the `ITable` interface's
    // required `string` shape. The cast is safe — CDK's grant helpers only need
    // `ITable`'s method surface, not the concrete class fields.
    const adminLambda = new AdminLambda(this, "AdminLambda", {
      userPool: this.userPool,
      clientConfigTable: this.clientConfigTable as dynamodb.ITable,
      magicLinkTokensTable: this.magicLinkTokensTable as dynamodb.ITable,
      reservationsTable: this.reservationsTable as dynamodb.ITable,
      tenantSubdomainParent: this.tenantSubdomainParent,
      adminInvokePrincipal: props.adminInvokePrincipal,
      ...(props.adminFunctionUrlCors !== undefined
        ? { adminFunctionUrlCors: props.adminFunctionUrlCors }
        : {}),
      ...(props.alarmTopic !== undefined ? { alarmTopic: props.alarmTopic } : {}),
    });

    this.adminFunctionUrl = adminLambda.functionUrl.url;
    this.adminLambdaName = adminLambda.fn.functionName;

    new Reconciler(this, "Reconciler", {
      userPool: this.userPool,
      clientConfigTable: this.clientConfigTable as dynamodb.ITable,
      ...(props.alarmTopic !== undefined ? { alarmTopic: props.alarmTopic } : {}),
    });

    // -----------------------------------------------------------------------
    // Cost-DoS guard (S7) — opt-in via props.costDosGuard.
    //
    // Extracts the sender domain from `sesIdentitySender` to dimension
    // the AWS/SES `Send` metric. The SES domain identity itself is
    // assumed to exist out-of-band for shared-distribution mode (this
    // construct does not create it); the alarm watches whichever
    // identity is configured.
    // -----------------------------------------------------------------------

    if (props.costDosGuard?.enabled === true) {
      const atIdx = props.sesIdentitySender.lastIndexOf("@");
      const sesDomain = atIdx >= 0 ? props.sesIdentitySender.slice(atIdx + 1) : props.sesIdentitySender;
      this.costDosGuard = installCostDosGuard(this, {
        sesIdentityName: sesDomain,
        cognitoPoolArn: this.userPool.userPoolArn,
        cognitoPoolId: this.userPool.userPoolId,
        guard: props.costDosGuard,
      });
    } else {
      this.costDosGuard = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Public helpers (parity with MagicLinkIdentity)
  // -------------------------------------------------------------------------

  /**
   * Grant the supplied Lambda IAM read on `ClientConfig` and inject
   * `VESTIBULUM_CLIENT_CONFIG_TABLE` into its environment.
   *
   * Used by consumers wiring custom PreTokenGeneration replacements
   * via `wrapPreTokenHandler`. See [06-trigger-handlers.md]
   * § Allowing consumer customisation.
   */
  grantReadClientConfig(fn: lambda.Function): void {
    this.clientConfigTableConstruct.grantRead(fn);
    fn.addEnvironment(RuntimeEnv.CLIENT_CONFIG_TABLE, this.clientConfigTable.tableName);
  }

  /**
   * Replace the built-in PreTokenGeneration trigger with a consumer
   * Lambda — **post-construction**. Only succeeds if neither the
   * built-in nor a `props.preTokenGeneration` is already wired.
   *
   * Preferred path: pass `preTokenGeneration` via construct props at
   * construction time (the built-in is skipped automatically). The
   * method-style API is retained for parity with `MagicLinkIdentity`
   * but is rarely needed for shared-distribution mode.
   *
   * Cognito refuses to register two triggers for the same operation;
   * if you've already wired one (via prop OR a previous call to this
   * method), this call throws.
   */
  preTokenGeneration(fn: lambda.IFunction): void {
    if (fn instanceof lambda.Function) {
      this.grantReadClientConfig(fn);
    }
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
      fn,
    );
  }

  /**
   * Attach a PostConfirmation trigger post-construction. Like
   * `preTokenGeneration`, this is unsupported if a trigger is already
   * wired (e.g. via `props.postConfirmation`). Preferred path is the
   * prop.
   */
  postConfirmation(fn: lambda.IFunction): void {
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      fn,
    );
  }

}
