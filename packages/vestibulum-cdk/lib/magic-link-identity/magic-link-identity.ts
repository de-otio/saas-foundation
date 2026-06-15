/**
 * MagicLinkIdentity — stateful CDK L3 construct for passwordless magic-link auth.
 *
 * Composes:
 * - Cognito User Pool with CUSTOM_AUTH flow.
 * - Five Cognito trigger Lambdas (PreSignUp, DefineAuthChallenge,
 *   CreateAuthChallenge, VerifyAuthChallengeResponse, BounceHandler).
 * - Three DynamoDB tables: TokenTable, RateLimitTable, DenylistTable.
 * - SES domain identity with DKIM CNAMEs + SPF TXT + DMARC TXT via Route53.
 * - SNS topic for SES bounces + bounce-handler Lambda subscription.
 * - HMAC secret in AWS Secrets Manager for email-address hashing.
 *
 * All stateful resources use `RemovalPolicy.RETAIN` so they survive
 * `cdk destroy` or accidental stack deletion.
 *
 * **Migration note (P5 / B-C):** the source vestibulum L1 construct used
 * `NodejsFunction` (esbuild at synth-time). This migrated construct uses
 * `lambda.Function` + `Code.fromAsset(bundlePath)`, where `bundlePath`
 * resolves into the package's `lambda-bundles/` directory produced by the
 * build-time pipeline in `scripts/build-bundles.ts`. The bundle hashes
 * are pinned by `lambda-bundles.lock.json`. See
 * `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 *
 * **Integrated review fixes:**
 * - B-I: `signupMode` is a prop on `MagicLinkIdentityProps`; no
 *   `_setSignupMode` private setter.
 * - B-H: Cognito Advanced Security is off by default; opt-in via
 *   `advancedSecurity` prop with per-MAU cost disclosure.
 * - B-C: `lambda.Function` + `Code.fromAsset`, not `NodejsFunction`.
 * - S-C2: custom-attribute name length 1–20 chars.
 * - S-C3: token-size baseline raised; warn at 5 KB, error at 6 KB.
 * - N3: federation-aspect immutable-attribute rule has configurable
 *   severity (default `error`; downgrade to `warning` if the
 *   `AdminLinkProviderForUser` empirical claim is contradicted).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { Annotations, CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as customResources from "aws-cdk-lib/custom-resources";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import { MagicLinkIdentityPropsError } from "./errors.js";
import {
  type CustomAttributeDeclaration,
  type SignupMode,
  validateCustomAttributeDeclarations,
  validateSesIdentitySender,
  validateSenderMatchesHostedZone,
  validateSignupModeForFederation,
  validateTokenSize,
} from "./prop-validation.js";
import {
  installCostDosGuard,
  type CostDosGuardProps,
  type CostDosGuardResources,
} from "../_internal/cost-dos-guard.js";
import { buildAppClientOptions } from "../app-clients/index.js";
import type { AddAppClientProps } from "../_internal/identity-handle.js";

// ---------------------------------------------------------------------------
// Bundle-path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Read the committed lock manifest at module-load to surface a clear
 * error if `npm run build-bundles` has not been executed. The manifest
 * is part of the package's published shape.
 */
interface LockManifestShape {
  readonly vestibulumVersion: string;
  readonly bundles: Record<string, { sha256: string; filename: string; sizeBytes: number }>;
}

/**
 * Resolve the absolute filesystem path of a bundle directory for use
 * with `lambda.Code.fromAsset(...)`.
 *
 * Walks from this file (`lib/magic-link-identity/magic-link-identity.{ts,js}`)
 * up to the package root (`packages/vestibulum-cdk/` in source, package
 * root in node_modules). Bundle paths land in `<root>/lambda-bundles/<name>`.
 */
function resolveBundlePath(bundleName: string): string {
  // From `lib/magic-link-identity/`, the package root is two levels up.
  // From `dist/magic-link-identity/`, ditto.
  const packageRoot = path.resolve(__dirname, "..", "..");
  return path.join(packageRoot, "lambda-bundles", bundleName);
}

/**
 * Read the lock manifest. Cached at module-load. The manifest's
 * `bundles[name].filename` field tells us the asset entry-point — the
 * directory is what `Code.fromAsset` consumes.
 */
const LOCK_MANIFEST: LockManifestShape = (() => {
  const packageRoot = path.resolve(__dirname, "..", "..");
  const lockPath = path.join(packageRoot, "lambda-bundles.lock.json");
  try {
    const text = readFileSync(lockPath, "utf8");
    return JSON.parse(text) as LockManifestShape;
  } catch (err) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] failed to read bundle lock ` +
        `manifest at '${lockPath}'. Run 'npm run build-bundles --workspace=` +
        `@de-otio/vestibulum-cdk' to produce it. Underlying error: ` +
        `${(err as Error).message}`,
    );
  }
})();

// ---------------------------------------------------------------------------
// Runtime env names — duplicated from `@de-otio/vestibulum`'s shared/runtime-env
// to avoid a build-time dep on the runtime package's `dist/` shape. The
// names are part of the runtime contract; the bundling pipeline pins the
// bundled handler bytes, this construct pins the env-var contract.
// ---------------------------------------------------------------------------

const RuntimeEnv = {
  TOKEN_TABLE_NAME: "VESTIBULUM_TOKEN_TABLE",
  RATE_LIMIT_TABLE_NAME: "VESTIBULUM_RATE_LIMIT_TABLE",
  DENYLIST_TABLE_NAME: "VESTIBULUM_DENYLIST_TABLE",
  COGNITO_USER_POOL_ID: "VESTIBULUM_USER_POOL_ID",
  SES_FROM: "VESTIBULUM_SES_FROM",
  SES_REGION: "VESTIBULUM_SES_REGION",
  TOKEN_TTL_MINUTES: "VESTIBULUM_TOKEN_TTL_MINUTES",
  TOKEN_SENDS_PER_WINDOW: "VESTIBULUM_TOKEN_SENDS_PER_WINDOW",
  SIGN_UPS_PER_WINDOW: "VESTIBULUM_SIGN_UPS_PER_WINDOW",
  ALLOWED_EMAIL_DOMAINS: "VESTIBULUM_ALLOWED_EMAIL_DOMAINS",
  SIGNUP_MODE: "VESTIBULUM_SIGNUP_MODE",
  BOUNCE_HMAC_SECRET: "VESTIBULUM_BOUNCE_HMAC_SECRET",
  // Front-door domain the magic-link URL points at (CreateAuthChallenge builds
  // `https://<domain>/login/callback#token=...`). Must match MagicLinkAuthSite's
  // `domain`. Consumed by the create-auth and auth-verify handlers.
  DOMAIN: "VESTIBULUM_DOMAIN",
} as const;

// ---------------------------------------------------------------------------
// SES domain verification-wait — inline custom-resource handler sources
//
// Cold-SES-domain fix (B3): Cognito validates that the SES sender domain is
// *verified for sending* at pool-CREATE time, but SES DKIM verification is
// asynchronous (minutes after the CNAMEs are published). On a fresh domain
// the pool's CREATE fails ("Email address is not verified … identity/<domain>")
// and the stack rolls back, so it never converges.
//
// These two inline handlers back a `custom_resources.Provider` (async-polling
// pattern). The Provider's `isComplete` handler is re-invoked on
// `queryInterval` until SES reports the domain verified for sending; the
// Cognito pool depends on the resulting CustomResource, so the pool only
// CREATEs once the domain is actually usable.
//
// Kept inline (not in the lambda-bundles pipeline) because the dependency
// surface is a single AWS SDK client (`@aws-sdk/client-sesv2`, present on the
// NODEJS_22_X runtime) and the code is short enough to read in-place.
// ---------------------------------------------------------------------------

/**
 * \`onEvent\` handler. Returns a \`PhysicalResourceId\`; no AWS calls (the poll
 * lives in the \`isComplete\` handler).
 *
 * On Update/Delete it **echoes \`event.PhysicalResourceId\`** rather than
 * recomputing it. This is the critical correctness rule for an async
 * (\`isComplete\`-waiter) custom resource: if a CREATE never completes — e.g.
 * the SES domain never verifies and the stack is deleted while the waiter is
 * still polling — CloudFormation still holds the framework's *placeholder*
 * physical id, never the value this handler returned on CREATE. Recomputing
 * \`ses-verify-<domain>\` on Delete would then differ from that placeholder, and
 * CloudFormation rejects any physical-id change during Delete
 * ("cannot change the physical resource ID ... during deletion"), wedging the
 * stack in DELETE_FAILED. Echoing the incoming id makes Delete (and Update)
 * id-stable regardless of how the CREATE ended.
 */
/** @internal Exported only for unit tests; not part of the public API. */
export const SES_VERIFY_ON_EVENT_SOURCE = `
exports.handler = async (event) => {
  if (event.RequestType === "Update" || event.RequestType === "Delete") {
    // Preserve whatever physical id CloudFormation currently holds — never
    // recompute it, or a delete-of-an-incomplete-create fails.
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const domain =
    (event.ResourceProperties && event.ResourceProperties.domain) || "unknown";
  return { PhysicalResourceId: "ses-verify-" + domain };
};
`;

/**
 * `isComplete` handler. Polls SESv2 `GetEmailIdentity` and reports complete
 * once `VerifiedForSendingStatus === true`. On Delete, always complete.
 */
const SES_VERIFY_IS_COMPLETE_SOURCE = `
const { SESv2Client, GetEmailIdentityCommand } = require("@aws-sdk/client-sesv2");

const client = new SESv2Client({});

exports.handler = async (event) => {
  if (event.RequestType === "Delete") {
    return { IsComplete: true };
  }
  const domain =
    event.ResourceProperties && event.ResourceProperties.domain;
  if (!domain) {
    return { IsComplete: false };
  }
  try {
    const res = await client.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    );
    return { IsComplete: res.VerifiedForSendingStatus === true };
  } catch (err) {
    // Identity not yet readable / transient error — keep polling until the
    // Provider's totalTimeout elapses rather than failing the deploy early.
    return { IsComplete: false };
  }
};
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Cognito Hosted UI domain configuration. Two variants:
 *
 * - `kind: 'cognito'`: Cognito-managed subdomain (cheapest path, no DNS or
 *   ACM cert required). Address shape:
 *   `https://{prefix}.auth.{region}.amazoncognito.com`.
 * - `kind: 'custom'`: custom domain backed by an ACM cert. The cert MUST
 *   live in us-east-1 (Cognito's internal CloudFront distribution serving
 *   the Hosted UI requires it, same rule as CloudFront).
 */
export type HostedUiDomainProps =
  | { readonly kind: "cognito"; readonly prefix: string }
  | { readonly kind: "custom"; readonly domainName: string; readonly acmCertArn: string };

/** Re-exported declarative custom-attribute type. */
export type { CustomAttributeDeclaration, SignupMode };

/**
 * Cognito user-pool feature plan.
 *
 * Affects which pre-token-generation trigger event versions are
 * available. Vestibulum-runtime's federation Lambda templates use V2
 * features when `featureTier !== 'Lite'`.
 */
export type FeatureTier = "Lite" | "Essentials" | "Plus";

/**
 * Cognito Advanced Security mode.
 *
 * **Cost surface (B-H).** Both `'audit'` and `'enforced'` are billed
 * per MAU above the Cognito Advanced Security free-tier MAU cap. The
 * default `'off'` keeps the per-MAU bill absent for consumers who do not
 * need risk-based detection.
 */
export type AdvancedSecurityMode = "off" | "audit" | "enforced";

/**
 * Severity setting for the federation-aspect rule that rejects
 * `mutable: false` custom attributes (N3).
 *
 * The default `error` matches the design's empirical claim that
 * `AdminLinkProviderForUser` refuses any user with an immutable custom
 * attribute. Consumers who have empirically demonstrated the rule
 * doesn't hold in their environment may downgrade to `warning`.
 */
export type ImmutableAttributeSeverity = "error" | "warning";

/**
 * Props for `MagicLinkIdentity`.
 */
export interface MagicLinkIdentityProps {
  /**
   * Route 53 hosted zone used to publish DKIM, SPF, and DMARC DNS records.
   *
   * Must cover the domain in `sesIdentitySender`.
   */
  readonly hostedZone: route53.IHostedZone;

  /**
   * Email domains that may register with this pool.
   *
   * `PreSignUp` rejects sign-up attempts from any address whose domain
   * is not in this list. The rejection is always the same generic error
   * (Mandatory Mitigation 4 — see `01-package-api.md`).
   *
   * An empty array means "no domain restriction".
   */
  readonly allowedEmailDomains: string[];

  /**
   * Sender address for outbound magic-link emails (the `From:` header).
   *
   * Must be a fully-qualified email address in a domain covered by
   * `hostedZone`.
   */
  readonly sesIdentitySender: string;

  /**
   * Magic-link token TTL in minutes.
   * @default 15
   */
  readonly tokenTtlMinutes?: number;

  /**
   * Maximum magic-link sends per email address per 15-minute window.
   * @default 3
   */
  readonly tokenSendsPerWindow?: number;

  /**
   * Maximum sign-up attempts per email + source IP per 15-minute window.
   * @default 3
   */
  readonly signUpsPerWindow?: number;

  /**
   * Pool-wide default ID-token validity duration.
   * @default Duration.minutes(15)
   */
  readonly defaultIdTokenValidity?: Duration;

  /**
   * Pool-wide default refresh-token validity duration.
   *
   * Defaults to 24 hours (not Cognito's 30-day default) because the edge
   * JWT verifier doesn't consult Cognito on every request — the offboarding
   * window for active sessions equals this TTL.
   *
   * @default Duration.hours(24)
   */
  readonly defaultRefreshTokenValidity?: Duration;

  /**
   * Optional consumer-supplied `PreTokenGeneration` Lambda.
   *
   * Same-account/region check is performed at synth time.
   */
  readonly preTokenGeneration?: lambda.IFunction;

  /**
   * Trigger version for `preTokenGeneration`. Defaults to `'V1_0'`.
   *
   * Set `'V2_0'` when the handler returns the V2 response shape
   * (`claimsAndScopeOverrideDetails`, which can add claims to BOTH the id and
   * access tokens). The CDK L2 `lambdaTriggers.preTokenGeneration` always wires
   * the trigger as `V1_0`, so a V2 handler's response is silently ignored and
   * its claims never land. `'V2_0'` requires the pool feature plan to be
   * `Essentials` or `Plus` (`featureTier`). No effect when `preTokenGeneration`
   * is not set.
   */
  readonly preTokenGenerationVersion?: "V1_0" | "V2_0";

  /**
   * Optional consumer-supplied `PostConfirmation` Lambda.
   */
  readonly postConfirmation?: lambda.IFunction;

  /**
   * Federation-related: custom-attribute declarations.
   *
   * Cognito does NOT permit adding custom attributes to an existing pool —
   * declare every attribute the consumer's claim-resolver intends to emit
   * at pool creation time. See `02-magic-link-identity.md § Custom attributes`.
   *
   * @default []
   */
  readonly customAttributes?: CustomAttributeDeclaration[];

  /**
   * Federation-related: Cognito Hosted UI domain.
   *
   * Required when `federationEnabled: true`.
   *
   * @default - no Hosted UI domain attached.
   */
  readonly hostedUiDomain?: HostedUiDomainProps;

  /**
   * Federation-related: enable the OAuth code flow + federation-aware
   * defaults on `addAppClient`.
   *
   * When `true`, `signupMode` is **required** (B-I; see § Signup mode in
   * the design doc).
   *
   * @default false
   */
  readonly federationEnabled?: boolean;

  /**
   * Cognito user-pool feature plan.
   */
  readonly featureTier?: FeatureTier;

  /**
   * Sign-up policy enforced by `PreSignUpFn` (B-I).
   *
   * Owned by `MagicLinkIdentity` — the policy is enforced inside the
   * PreSignUp Lambda this construct creates.
   *
   * Required when `federationEnabled: true`. Default `'open'` on
   * non-federation pools.
   */
  readonly signupMode?: SignupMode;

  /**
   * Cognito Advanced Security mode (B-H).
   *
   * Both `'audit'` and `'enforced'` are billed per MAU above the
   * free-tier cap. Default `'off'` keeps the bill absent.
   *
   * @default 'off'
   */
  readonly advancedSecurity?: AdvancedSecurityMode;

  /**
   * Severity for the federation-aspect rule on `mutable: false` (N3).
   *
   * @default 'error'
   */
  readonly immutableAttributeSeverity?: ImmutableAttributeSeverity;

  /**
   * Cost-DoS guard for the SES outbound side (cost-pillar review S7).
   *
   * When set with `enabled: true`, brings SES sends inside the
   * documented cost-DoS envelope: deploys a CloudWatch alarm on the
   * `AWS/SES` `Send` metric scoped to this pool's SES identity with
   * threshold `sendsPerHourCap`, and (with `selfDefence: true`) a
   * handler that disables Cognito self-sign-up when the alarm fires.
   *
   * Default (unset / `enabled: false`): no alarm, no handler. The
   * current cost-DoS envelope already covers the inbound side via WAF
   * rate-limit + reserved-concurrency caps; the SES side is opt-in.
   *
   * See `doc/vestibulum-cdk/04-magic-link-auth-site.md § SES cost-DoS guard`.
   */
  readonly costDosGuard?: CostDosGuardProps;
}

// ---------------------------------------------------------------------------
// Construct metadata markers
// ---------------------------------------------------------------------------

const VESTIBULUM_SUBTREE_MARKER_TYPE = "vestibulum:subtree-root";
const VESTIBULUM_IDENTITY_METADATA_TYPE = "vestibulum:identity-config";

/**
 * Metadata payload stored on the construct node so synth-time aspects
 * (B's `MagicLinkAuthSite`, C's app-client / federation aspects) can read
 * federation-relevant config without a class-import cycle.
 */
export interface IdentityConfigMetadata {
  readonly federationEnabled: boolean;
  readonly hostedUiDomain: HostedUiDomainProps | undefined;
  readonly customAttributes: readonly CustomAttributeDeclaration[];
  readonly immutableAttributeSeverity: ImmutableAttributeSeverity;
}

// ---------------------------------------------------------------------------
// The construct
// ---------------------------------------------------------------------------

/**
 * Stateful CDK L3 construct that provisions all Vestibulum identity
 * infrastructure.
 *
 * Logical IDs on stateful resources (`Pool`, `TokenTable`, `RateLimitTable`,
 * `DenylistTable`, `SesIdentity`) are pinned and MUST NOT change across
 * vestibulum-cdk versions — they are part of the public CloudFormation
 * contract.
 */
// NOTE: this class intentionally does NOT use `implements IMagicLinkIdentity`.
// Under `exactOptionalPropertyTypes`, CDK's concrete `dynamodb.Table` is not
// assignable to `dynamodb.ITable` (the `tableStreamArn` optionality differs),
// so an `implements` clause fails to compile. The `addAppClient` method below
// matches `IMagicLinkIdentity.addAppClient`; a compile-time guard in the test
// suite asserts that signature (this is the method 0.3.3 shipped missing).
export class MagicLinkIdentity extends Construct {
  /** The Cognito User Pool backing the magic-link auth flow. */
  readonly cognitoPool: cognito.UserPool;

  /** DynamoDB table for single-use magic-link token hashes (SHA-256). */
  readonly tokenTable: dynamodb.Table;

  /** DynamoDB table for per-email rate-limit counters. */
  readonly rateLimitTable: dynamodb.Table;

  /** DynamoDB table for the bounce/complaint denylist (HMAC-hashed). */
  readonly denylistTable: dynamodb.Table;

  /** SNS topic receiving SES bounce + complaint notifications. */
  readonly bounceTopic: sns.Topic;

  /** Consumer-supplied PreTokenGeneration Lambda, if provided. */
  readonly preTokenGeneration: lambda.IFunction | undefined;

  /** Consumer-supplied PostConfirmation Lambda, if provided. */
  readonly postConfirmation: lambda.IFunction | undefined;

  /** Pool-wide ID-token validity default for `addAppClient`. */
  readonly defaultIdTokenValidity: Duration;

  /** Pool-wide refresh-token validity default for `addAppClient`. */
  readonly defaultRefreshTokenValidity: Duration;

  /** Whether federation is enabled on this identity. */
  readonly federationEnabled: boolean;

  /** Hosted UI domain attached to the pool, if `hostedUiDomain` was set. */
  readonly hostedUiDomain: cognito.UserPoolDomain | undefined;

  /** Frozen array of custom-attribute declarations. */
  readonly customAttributes: readonly CustomAttributeDeclaration[];

  /** Resolved signup-mode (always defined — defaults to `'open'`). */
  readonly signupMode: SignupMode;

  /** Resolved advanced-security mode (always defined — defaults to `'off'`). */
  readonly advancedSecurity: AdvancedSecurityMode;

  /** N3 severity for the federation aspect's immutable-attribute rule. */
  readonly immutableAttributeSeverity: ImmutableAttributeSeverity;

  /** The five trigger Lambdas — exposed for tests / IAM grants. */
  readonly preSignUpFn: lambda.Function;
  readonly defineAuthFn: lambda.Function;
  readonly createAuthFn: lambda.Function;
  readonly verifyAuthFn: lambda.Function;
  readonly bounceHandlerFn: lambda.Function;

  /**
   * Resources created by the optional cost-DoS guard (S7). Present only
   * when `props.costDosGuard?.enabled === true`; `undefined` otherwise.
   */
  readonly costDosGuard: CostDosGuardResources | undefined;

  constructor(scope: Construct, id: string, props: MagicLinkIdentityProps) {
    super(scope, id);

    // -----------------------------------------------------------------------
    // Synth-time prop validation
    // -----------------------------------------------------------------------

    // Mark this construct as the root of a Vestibulum subtree so the
    // synth-time Aspects (DisabledAuthFlowsAspect, federation aspects)
    // can scope themselves and stay inert outside Vestibulum.
    this.node.addMetadata(VESTIBULUM_SUBTREE_MARKER_TYPE, true, {
      stackTrace: false,
    });

    const senderDomain = validateSesIdentitySender(props.sesIdentitySender);
    // Hosted-zone name may be a CDK token (when imported via fromLookup
    // it's a string; from fromHostedZoneAttributes it can be tokenised).
    // Only validate when both are concrete strings.
    const zoneName = props.hostedZone.zoneName;
    if (!zoneName.startsWith("${")) {
      validateSenderMatchesHostedZone(senderDomain, zoneName);
    }

    this.customAttributes = Object.freeze([...(props.customAttributes ?? [])]);
    validateCustomAttributeDeclarations(this.customAttributes);

    const tokenSizeResult = validateTokenSize(this.customAttributes);

    this.federationEnabled = props.federationEnabled ?? false;

    // B-I: signupMode is now a required-when-federation prop.
    validateSignupModeForFederation({
      federationEnabled: this.federationEnabled,
      signupMode: props.signupMode,
    });
    this.signupMode = props.signupMode ?? "open";

    this.advancedSecurity = props.advancedSecurity ?? "off";
    this.immutableAttributeSeverity = props.immutableAttributeSeverity ?? "error";

    // featureTier mapping — synth warning when federation is enabled but
    // tier is unset or 'Lite'.
    if (
      this.federationEnabled &&
      (props.featureTier === undefined || props.featureTier === "Lite")
    ) {
      Annotations.of(this).addWarning(
        `[vestibulum-cdk:MagicLinkIdentity] federationEnabled: true but ` +
          `featureTier is ${props.featureTier ?? "unset"}. The federation ` +
          `Lambda templates use V2 pre-token-generation events; on 'Lite' ` +
          `they degrade to ID-token-only claim overrides. Set ` +
          `featureTier: 'Essentials' to enable V2.`,
      );
    }

    // Hosted UI synth checks (federationEnabled requires hostedUiDomain;
    // custom-domain ACM cert must be us-east-1).
    if (this.federationEnabled && props.hostedUiDomain === undefined) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] federationEnabled: true requires ` +
          `a hostedUiDomain — federation goes through the OAuth code flow ` +
          `served from the Cognito Hosted UI. Set hostedUiDomain to either ` +
          `{ kind: 'cognito', prefix: '...' } or { kind: 'custom', ` +
          `domainName, acmCertArn }.`,
      );
    }
    if (props.hostedUiDomain !== undefined && props.hostedUiDomain.kind === "custom") {
      const region = extractAcmRegion(props.hostedUiDomain.acmCertArn);
      if (region !== undefined && region !== "us-east-1") {
        throw new MagicLinkIdentityPropsError(
          `[vestibulum-cdk:MagicLinkIdentity] custom Hosted UI domain ` +
            `requires an ACM cert in us-east-1; got region '${region}' ` +
            `for ARN '${props.hostedUiDomain.acmCertArn}'.`,
        );
      }
    }

    if (tokenSizeResult.warning !== undefined) {
      Annotations.of(this).addWarning(tokenSizeResult.warning);
    }

    // -----------------------------------------------------------------------
    // Derived sizing / TTLs
    // -----------------------------------------------------------------------

    const tokenTtlMinutes = props.tokenTtlMinutes ?? 15;
    const tokenSendsPerWindow = props.tokenSendsPerWindow ?? 3;
    const signUpsPerWindow = props.signUpsPerWindow ?? 3;
    this.defaultIdTokenValidity = props.defaultIdTokenValidity ?? Duration.minutes(15);
    this.defaultRefreshTokenValidity = props.defaultRefreshTokenValidity ?? Duration.hours(24);

    // -----------------------------------------------------------------------
    // HMAC secret
    // -----------------------------------------------------------------------

    const hmacSecret = new secretsmanager.Secret(this, "HmacKey", {
      description: "HMAC-SHA-256 key for hashing email addresses in Vestibulum bounce handler.",
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // DynamoDB tables
    // -----------------------------------------------------------------------

    this.tokenTable = new dynamodb.Table(this, "TokenTable", {
      partitionKey: {
        name: "token_hash",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
      partitionKey: { name: "bucket_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.denylistTable = new dynamodb.Table(this, "DenylistTable", {
      partitionKey: { name: "email_hmac", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // SNS bounce topic
    // -----------------------------------------------------------------------

    this.bounceTopic = new sns.Topic(this, "BounceTopic", {
      displayName: "Vestibulum SES Bounce/Complaint Topic",
    });

    // -----------------------------------------------------------------------
    // Common Lambda env vars
    // -----------------------------------------------------------------------

    const commonEnv: Record<string, string> = {
      [RuntimeEnv.TOKEN_TABLE_NAME]: this.tokenTable.tableName,
      [RuntimeEnv.RATE_LIMIT_TABLE_NAME]: this.rateLimitTable.tableName,
      [RuntimeEnv.DENYLIST_TABLE_NAME]: this.denylistTable.tableName,
      [RuntimeEnv.SES_FROM]: props.sesIdentitySender,
      [RuntimeEnv.SES_REGION]: Stack.of(this).region,
      // VESTIBULUM_DOMAIN — the front-door domain the magic-link URL points at
      // (`https://<domain>/login/callback#token=...`), built by the
      // CreateAuthChallenge handler. Without it that handler throws and Cognito
      // returns the generic "Authentication failed". This MUST equal the
      // `domain` passed to MagicLinkAuthSite (which serves `/login/callback`).
      // Defaulted to the SES sender apex, which equals the site domain in the
      // apex-aligned topology; a consumer serving the site on a domain other
      // than the sender apex must align the two.
      [RuntimeEnv.DOMAIN]: senderDomain,
      [RuntimeEnv.TOKEN_TTL_MINUTES]: String(tokenTtlMinutes),
      [RuntimeEnv.TOKEN_SENDS_PER_WINDOW]: String(tokenSendsPerWindow),
      [RuntimeEnv.SIGN_UPS_PER_WINDOW]: String(signUpsPerWindow),
      [RuntimeEnv.ALLOWED_EMAIL_DOMAINS]: JSON.stringify(props.allowedEmailDomains),
      [RuntimeEnv.BOUNCE_HMAC_SECRET]: hmacSecret.secretArn,
    };

    // -----------------------------------------------------------------------
    // Trigger Lambdas — Code.fromAsset on pre-built bundles (B-C)
    // -----------------------------------------------------------------------

    const commonLambdaProps: Omit<lambda.FunctionProps, "code" | "handler"> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      logRetention: logs.RetentionDays.ONE_MONTH,
      reservedConcurrentExecutions: 10,
      environment: { ...commonEnv },
    };

    this.preSignUpFn = new lambda.Function(this, "PreSignUpFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveBundlePath("pre-signup")),
      handler: "index.handler",
      environment: {
        ...commonEnv,
        // B-I: signup mode injected directly here — no `_setSignupMode`.
        [RuntimeEnv.SIGNUP_MODE]: this.signupMode,
      },
    });

    this.defineAuthFn = new lambda.Function(this, "DefineAuthFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveBundlePath("define-auth")),
      handler: "index.handler",
    });

    this.createAuthFn = new lambda.Function(this, "CreateAuthFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveBundlePath("create-auth")),
      handler: "index.handler",
    });

    this.verifyAuthFn = new lambda.Function(this, "VerifyAuthFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveBundlePath("verify-auth")),
      handler: "index.handler",
    });

    this.bounceHandlerFn = new lambda.Function(this, "BounceHandlerFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveBundlePath("bounce-handler")),
      handler: "index.handler",
    });

    // -----------------------------------------------------------------------
    // IAM grants
    // -----------------------------------------------------------------------

    this.rateLimitTable.grantWriteData(this.preSignUpFn);

    this.tokenTable.grantWriteData(this.createAuthFn);
    this.denylistTable.grantReadData(this.createAuthFn);
    this.rateLimitTable.grantReadWriteData(this.createAuthFn);
    // CreateAuthChallenge sends the magic-link email via SES SendEmail from the
    // verified sender identity. Without this grant the handler throws and
    // Cognito returns "CreateAuthChallenge failed: ... not authorized to
    // perform ses:SendEmail ...". Scoped to this construct's sender identity.
    this.createAuthFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          `arn:aws:ses:${Stack.of(this).region}:${Stack.of(this).account}:identity/${senderDomain}`,
        ],
      }),
    );

    // VerifyAuthChallenge reads the token row (GetItem) to validate the
    // submitted token, then consumes it (DeleteItem) — needs read AND write.
    this.tokenTable.grantReadWriteData(this.verifyAuthFn);

    this.denylistTable.grantWriteData(this.bounceHandlerFn);
    hmacSecret.grantRead(this.bounceHandlerFn);

    // -----------------------------------------------------------------------
    // Optional consumer-supplied triggers — same-account/region check
    // -----------------------------------------------------------------------

    this.preTokenGeneration = props.preTokenGeneration;
    this.postConfirmation = props.postConfirmation;

    if (props.preTokenGeneration) {
      validateSameAccountRegion(this, props.preTokenGeneration);
    }
    if (props.postConfirmation) {
      validateSameAccountRegion(this, props.postConfirmation);
    }

    // -----------------------------------------------------------------------
    // SES domain identity
    // -----------------------------------------------------------------------

    const sesIdentity = new ses.EmailIdentity(this, "SesIdentity", {
      identity: ses.Identity.domain(senderDomain),
      dkimSigning: true,
    });
    // B3 (cold-SES-domain fix): DESTROY, not RETAIN. With the
    // verification-wait below, a cold deploy now converges in the happy
    // path (no rollback). RETAIN previously left a PENDING identity behind
    // on a failed deploy, which then collided ("EmailIdentity already
    // exists") on the next attempt and blocked recovery. DESTROY means any
    // failed deploy cleans up fully and the retry starts from a clean slate.
    sesIdentity.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const dkimTokens = [
      { name: sesIdentity.dkimDnsTokenName1, value: sesIdentity.dkimDnsTokenValue1 },
      { name: sesIdentity.dkimDnsTokenName2, value: sesIdentity.dkimDnsTokenValue2 },
      { name: sesIdentity.dkimDnsTokenName3, value: sesIdentity.dkimDnsTokenValue3 },
    ];

    const dkimRecords = dkimTokens.map(
      (token, i) =>
        new route53.CnameRecord(this, `DkimCname${i + 1}`, {
          zone: props.hostedZone,
          // `token.name` is a deploy-time CFN attribute (Fn::GetAtt
          // DkimDNSTokenName*) that resolves to the *already* fully-qualified
          // `<token>._domainkey.<senderDomain>`. CDK's RecordSet decides
          // whether to append the zone apex with a synth-time
          // `recordName.endsWith(zoneName)` check — but at synth the value is
          // an opaque token, the check fails, and CDK appends the zone anyway,
          // producing a doubled `..._domainkey.<sender>.<zone>` that SES can
          // never find (DKIM stays PENDING → verification-wait times out).
          // Appending a trailing dot marks the name absolute, short-circuiting
          // the append. (`domain(senderDomain)` is kept, not
          // `publicHostedZone()`, because the sender may be a subdomain of the
          // zone — see validateSenderMatchesHostedZone — which the
          // zone-apex-keyed publicHostedZone() helper would get wrong.)
          recordName: `${token.name}.`,
          domainName: token.value,
          ttl: Duration.hours(1),
          comment: `Vestibulum DKIM CNAME ${i + 1} for ${senderDomain}`,
        }),
    );

    new route53.TxtRecord(this, "SpfRecord", {
      zone: props.hostedZone,
      recordName: senderDomain,
      values: ["v=spf1 include:amazonses.com ~all"],
      ttl: Duration.hours(1),
      comment: `Vestibulum SPF record for ${senderDomain}`,
    });

    new route53.TxtRecord(this, "DmarcRecord", {
      zone: props.hostedZone,
      recordName: `_dmarc.${senderDomain}`,
      values: [`v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${senderDomain}`],
      ttl: Duration.hours(1),
      comment: `Vestibulum DMARC record for ${senderDomain}`,
    });

    // -----------------------------------------------------------------------
    // SES domain verification-wait (B3 — cold-SES-domain fix)
    //
    // A CloudFormation custom resource that blocks until the SES sender
    // domain is verified for sending. The Cognito pool below depends on it,
    // so the pool's CREATE (which Cognito validates against SES sending
    // status) only runs once the domain is actually usable. Without this,
    // a fresh (unverified) domain makes the pool CREATE fail and the stack
    // roll back, never converging.
    // -----------------------------------------------------------------------

    const sesVerifyOnEvent = new lambda.Function(this, "SesVerifyOnEventFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(SES_VERIFY_ON_EVENT_SOURCE),
      timeout: Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description:
        "Vestibulum SES verification-wait onEvent handler: returns a stable " +
        "physical id; the SES poll lives in the isComplete handler.",
    });

    const sesVerifyIsComplete = new lambda.Function(this, "SesVerifyIsCompleteFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(SES_VERIFY_IS_COMPLETE_SOURCE),
      timeout: Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description:
        "Vestibulum SES verification-wait isComplete handler: polls SESv2 " +
        "GetEmailIdentity until the domain is verified for sending.",
    });

    // GetEmailIdentity does not support resource-level permissions, so the
    // statement must be on `*` (scoped by action only).
    sesVerifyIsComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:GetEmailIdentity"],
        resources: ["*"],
      }),
    );

    const sesVerifyProvider = new customResources.Provider(this, "SesVerifyProvider", {
      onEventHandler: sesVerifyOnEvent,
      isCompleteHandler: sesVerifyIsComplete,
      queryInterval: Duration.seconds(30),
      totalTimeout: Duration.minutes(45),
    });

    const sesVerifyWait = new CustomResource(this, "SesVerifyWait", {
      serviceToken: sesVerifyProvider.serviceToken,
      resourceType: "Custom::VestibulumSesVerification",
      properties: {
        domain: senderDomain,
        // Stable salt — bound to the domain so the resource is only
        // re-polled when the target domain changes, not on every deploy.
        salt: `ses-verify-${senderDomain}`,
      },
    });

    // Poll only after the DKIM CNAMEs (and the identity) are published —
    // verification can't complete before the records exist.
    sesVerifyWait.node.addDependency(sesIdentity);
    for (const record of dkimRecords) {
      sesVerifyWait.node.addDependency(record);
    }

    // cdk-nag suppressions for the verification-wait resources. These are
    // a Provider framework + two short inline handlers; the findings below
    // are inherent to that CDK pattern and accepted here.
    NagSuppressions.addResourceSuppressions(
      sesVerifyProvider,
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "Provider framework Lambda runtime is managed by aws-cdk-lib's " +
            "custom_resources.Provider; its runtime is pinned by the CDK " +
            "version, not consumer-controllable.",
        },
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Provider framework role uses the CDK-managed " +
            "AWSLambdaBasicExecutionRole for its own CloudWatch Logs; this " +
            "is the framework default and not consumer-controllable.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Provider framework grants lambda:InvokeFunction on the two " +
            "handler functions (and their versions, hence a '*' on the " +
            "version suffix); CDK-managed and scoped to this provider's " +
            "own handlers.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      [sesVerifyOnEvent, sesVerifyIsComplete],
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Inline verification-wait handlers use the CDK-managed " +
            "AWSLambdaBasicExecutionRole for CloudWatch Logs only.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ses:GetEmailIdentity does not support resource-level " +
            "permissions, so the statement is scoped by action on '*'. " +
            "This is read-only and cannot mutate any SES resource.",
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // Cognito User Pool
    // -----------------------------------------------------------------------

    const standardAttributes: cognito.StandardAttributes = {
      email: { required: true, mutable: false },
    };

    const consumerCustomAttributes = this.toCognitoCustomAttributes(this.customAttributes);
    const combinedCustomAttributes: Record<string, cognito.ICustomAttribute> = {
      email_quarantined: new cognito.BooleanAttribute({ mutable: true }),
      ...consumerCustomAttributes,
    };

    this.cognitoPool = new cognito.UserPool(this, "Pool", {
      signInAliases: { email: true },
      selfSignUpEnabled: true,
      standardAttributes,
      customAttributes: combinedCustomAttributes,
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      email: cognito.UserPoolEmail.withSES({
        fromEmail: props.sesIdentitySender,
        fromName: "Vestibulum",
        sesRegion: Stack.of(this).region,
        sesVerifiedDomain: senderDomain,
      }),
      lambdaTriggers: {
        preSignUp: this.preSignUpFn,
        defineAuthChallenge: this.defineAuthFn,
        createAuthChallenge: this.createAuthFn,
        verifyAuthChallengeResponse: this.verifyAuthFn,
        ...(props.preTokenGeneration ? { preTokenGeneration: props.preTokenGeneration } : {}),
        ...(props.postConfirmation ? { postConfirmation: props.postConfirmation } : {}),
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // B3: the pool's CREATE validates against SES sending status, so it must
    // not begin until the verification-wait reports the domain verified.
    this.cognitoPool.node.addDependency(sesVerifyWait);

    // Inject pool ID into the bounce-handler env (after pool creation;
    // the four trigger Lambdas don't need it — Cognito passes userPoolId
    // on the event, and adding the env var would create a DependsOn cycle).
    this.bounceHandlerFn.addEnvironment(
      RuntimeEnv.COGNITO_USER_POOL_ID,
      this.cognitoPool.userPoolId,
    );

    // Bounce-handler: scoped Cognito IAM (no wildcards).
    this.bounceHandlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminDisableUser"],
        resources: [this.cognitoPool.userPoolArn],
      }),
    );

    this.bounceTopic.addSubscription(new snsSubscriptions.LambdaSubscription(this.bounceHandlerFn));

    // -----------------------------------------------------------------------
    // Cognito Advanced Security (B-H — opt-in)
    // -----------------------------------------------------------------------

    const cfnPool = this.cognitoPool.node.defaultChild as cognito.CfnUserPool;

    if (this.advancedSecurity !== "off") {
      // Cost disclosure: emit a synth annotation so the choice is visible
      // in `cdk synth` output and review.
      Annotations.of(this).addInfo(
        `[vestibulum-cdk:MagicLinkIdentity] advancedSecurity='${this.advancedSecurity}' ` +
          `attaches a CfnUserPoolRiskConfigurationAttachment. Cognito ` +
          `Advanced Security is billed per MAU above the free-tier cap ` +
          `($0.05/MAU thereafter, current at AWS publishing time). ` +
          `Default 'off' keeps the line absent.`,
      );

      cfnPool.userPoolAddOns = {
        advancedSecurityMode: this.advancedSecurity === "enforced" ? "ENFORCED" : "AUDIT",
      };

      const actionShape =
        this.advancedSecurity === "enforced"
          ? { eventAction: "BLOCK" as const, notify: true }
          : { eventAction: "NO_ACTION" as const, notify: true };

      new cognito.CfnUserPoolRiskConfigurationAttachment(this, "RiskConfig", {
        userPoolId: this.cognitoPool.userPoolId,
        clientId: "ALL",
        accountTakeoverRiskConfiguration: {
          actions: {
            highAction: actionShape,
            mediumAction: actionShape,
            lowAction: actionShape,
          },
        },
        compromisedCredentialsRiskConfiguration: {
          actions: {
            eventAction: this.advancedSecurity === "enforced" ? "BLOCK" : "NO_ACTION",
          },
        },
      });
    }

    // -----------------------------------------------------------------------
    // featureTier mapping
    // -----------------------------------------------------------------------

    if (props.featureTier !== undefined) {
      cfnPool.userPoolTier = props.featureTier;
    }

    // PreTokenGeneration trigger version. The L2 `lambdaTriggers` wires the
    // trigger as V1_0; a V2 handler (claimsAndScopeOverrideDetails) needs the
    // pool's PreTokenGenerationConfig.LambdaVersion set to V2_0, or Cognito
    // silently drops its claims. Override the L1 here when requested. (V2_0
    // requires an Essentials/Plus feature plan.)
    if (props.preTokenGeneration && props.preTokenGenerationVersion === "V2_0") {
      cfnPool.addPropertyOverride(
        "LambdaConfig.PreTokenGenerationConfig.LambdaVersion",
        "V2_0",
      );
    }

    // -----------------------------------------------------------------------
    // Hosted UI domain
    // -----------------------------------------------------------------------

    this.hostedUiDomain = props.hostedUiDomain
      ? attachHostedUiDomain(this, "HostedUiDomain", this.cognitoPool, props.hostedUiDomain)
      : undefined;

    // -----------------------------------------------------------------------
    // Cost-DoS guard (S7) — opt-in via props.costDosGuard.
    //
    // Provisioned after the pool + SES identity exist so the alarm can
    // be dimensioned by the SES identity name and the self-defence
    // handler can be IAM-scoped to the pool ARN.
    // -----------------------------------------------------------------------

    this.costDosGuard = props.costDosGuard?.enabled === true
      ? installCostDosGuard(this, {
          sesIdentityName: senderDomain,
          cognitoPoolArn: this.cognitoPool.userPoolArn,
          cognitoPoolId: this.cognitoPool.userPoolId,
          guard: props.costDosGuard,
        })
      : undefined;

    // -----------------------------------------------------------------------
    // Identity-config metadata (for sibling constructs & aspects)
    // -----------------------------------------------------------------------

    const identityMetadata: IdentityConfigMetadata = {
      federationEnabled: this.federationEnabled,
      hostedUiDomain: props.hostedUiDomain,
      customAttributes: this.customAttributes,
      immutableAttributeSeverity: this.immutableAttributeSeverity,
    };
    this.node.addMetadata(VESTIBULUM_IDENTITY_METADATA_TYPE, identityMetadata, {
      stackTrace: false,
    });
  }

  /**
   * Convert declarative custom-attribute declarations to the CDK L2
   * `cognito.ICustomAttribute` map.
   */
  private toCognitoCustomAttributes(
    declarations: readonly CustomAttributeDeclaration[],
  ): Record<string, cognito.ICustomAttribute> {
    const result: Record<string, cognito.ICustomAttribute> = {};
    for (const decl of declarations) {
      const mutable = decl.mutable ?? true;
      switch (decl.dataType) {
        case "String":
          result[decl.name] = new cognito.StringAttribute({
            ...(decl.minLength !== undefined ? { minLen: decl.minLength } : {}),
            ...(decl.maxLength !== undefined ? { maxLen: decl.maxLength } : {}),
            mutable,
          });
          break;
        case "Number":
          result[decl.name] = new cognito.NumberAttribute({ mutable });
          break;
        case "Boolean":
          result[decl.name] = new cognito.BooleanAttribute({ mutable });
          break;
        case "DateTime":
          result[decl.name] = new cognito.DateTimeAttribute({ mutable });
          break;
      }
    }
    return result;
  }

  /**
   * Adds a Cognito app client with magic-link-compatible auth flows.
   *
   * CUSTOM_AUTH is always enabled and password / SRP flows are always
   * disabled (via {@link buildAppClientOptions}); `generateSecret: true`
   * is rejected — vestibulum app clients are public (SPA / browser).
   *
   * Implements {@link IMagicLinkIdentity.addAppClient}; `MagicLinkAuthSite`
   * calls this to provision its website client.
   */
  addAppClient(id: string, props: AddAppClientProps): cognito.UserPoolClient {
    const options = buildAppClientOptions({
      federationEnabled: this.federationEnabled,
      defaultIdTokenValidity: this.defaultIdTokenValidity,
      defaultRefreshTokenValidity: this.defaultRefreshTokenValidity,
      props: {
        ...(props.oauth !== undefined && { oAuth: props.oauth }),
        ...(props.generateSecret !== undefined && {
          generateSecret: props.generateSecret,
        }),
        ...(props.idTokenValidity !== undefined && {
          idTokenValidity: props.idTokenValidity,
        }),
        ...(props.refreshTokenValidity !== undefined && {
          refreshTokenValidity: props.refreshTokenValidity,
        }),
      },
    });
    return this.cognitoPool.addClient(id, options);
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Same-account / same-region check for consumer-supplied trigger Lambdas.
 * Cross-account / cross-region trigger ARNs are a confused-deputy vector.
 */
function validateSameAccountRegion(scope: Construct, fn: lambda.IFunction): void {
  const stack = Stack.of(scope);
  const arn = fn.functionArn;

  if (arn.includes("${")) {
    return; // tokens — defer to CFn-level validation.
  }

  const parts = arn.split(":");
  const arnRegion = parts[3];
  const arnAccount = parts[4];

  if (arnRegion !== undefined && arnRegion.length > 0 && !arnRegion.startsWith("${")) {
    if (arnRegion !== stack.region && !stack.region.startsWith("${")) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] consumer-supplied trigger Lambda ` +
          `must be in the same region. Got ARN region '${arnRegion}', stack ` +
          `region '${stack.region}'. Cross-region triggers are a ` +
          `confused-deputy vector.`,
      );
    }
  }

  if (arnAccount !== undefined && arnAccount.length > 0 && !arnAccount.startsWith("${")) {
    if (arnAccount !== stack.account && !stack.account.startsWith("${")) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] consumer-supplied trigger Lambda ` +
          `must be in the same AWS account. Got ARN account '${arnAccount}', ` +
          `stack account '${stack.account}'. Cross-account triggers are a ` +
          `confused-deputy vector.`,
      );
    }
  }
}

/**
 * Attach a Cognito user-pool domain per the `HostedUiDomainProps` shape.
 */
function attachHostedUiDomain(
  scope: Construct,
  id: string,
  userPool: cognito.IUserPool,
  props: HostedUiDomainProps,
): cognito.UserPoolDomain {
  if (props.kind === "cognito") {
    return new cognito.UserPoolDomain(scope, id, {
      userPool,
      cognitoDomain: { domainPrefix: props.prefix },
    });
  }
  const cert = acm.Certificate.fromCertificateArn(scope, `${id}Cert`, props.acmCertArn);
  return new cognito.UserPoolDomain(scope, id, {
    userPool,
    customDomain: {
      domainName: props.domainName,
      certificate: cert,
    },
  });
}

/**
 * Extract the region from an ACM cert ARN. Returns `undefined` if the
 * ARN is unresolved (CDK token) or malformed.
 */
function extractAcmRegion(arn: string): string | undefined {
  if (arn.includes("${")) {
    return undefined;
  }
  const parts = arn.split(":");
  if (parts.length < 6 || parts[2] !== "acm") {
    return undefined;
  }
  return parts[3];
}

/** Re-export for testing / introspection. */
export const LOCK_MANIFEST_BUNDLED_VERSION = LOCK_MANIFEST.vestibulumVersion;
