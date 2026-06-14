# 01 — Package API

The construct surface a consumer of `@de-otio/vestibulum-cdk` writes
against. What gets exported, the three primary constructs and how they
compose, the configuration props, and the five mandatory mitigations
enforced in code.

## Package exports

The package has a **single public entry point** — `package.json`
`exports` declares only `"."` (`./dist/index.js`). There are no
sub-path exports; everything a consumer needs is re-exported from the
top-level barrel, which is hand-curated (not `export * from ...` for
every module). The internal `from "./..."` module paths shown below
reflect the real `lib/` layout (`./magic-link-identity/`,
`./shared-distribution-identity/`, `./aspects/`, etc.).

The barrel re-exports, by area:

```typescript
// packages/vestibulum-cdk/lib/index.ts (curated barrel)

// Single-tenant magic-link constructs.
export { MagicLinkIdentity } from "./magic-link-identity/index.js";
export { EdgeResources } from "./edge-resources/index.js";
export { MagicLinkAuthSite } from "./magic-link-auth-site/index.js";
// Prop / handle types (MagicLinkIdentityProps, MagicLinkAuthSiteProps,
// EdgeResourcesProps, AuthSiteMetricsNamespace, AuthLambdaConcurrencyProps,
// CustomAttributeDeclaration, HostedUiDomainProps, FeatureTier,
// AdvancedSecurityMode, ImmutableAttributeSeverity, IMagicLinkIdentity,
// IEdgeResources, ...) come from the same module index files.

// Runtime-env key registry — the env-var names the bundled Lambdas
// read. Exposed for consumers writing their own helper Lambdas.
export { RuntimeEnv, type RuntimeEnvKey } from "./_internal/runtime-env.js";

// Synth-time Aspects (applied automatically; re-exported so consumers
// can re-apply at App / Stack scope).
export {
  DisabledAuthFlowsAspect,
  type DisabledAuthFlowsAspectProps,
  WafRequiredAspect,
  LogRetentionRequiredAspect,
  FederationCustomAttributesAspect,
  type FederationCustomAttributesAspectProps,
  HostedUiDomainAspect,
  // ... plus the subtree-marker helpers
} from "./aspects/index.js";

// cdk-nag custom rule pack and WAF default rules.
export * from "./cdk-nag-rules/index.js";
export * from "./waf/index.js";

// Metric builders (see 08-metrics.md § Metric builders).
export {
  DEFAULT_METRICS_NAMESPACE,
  DEFAULT_METRIC_PERIOD,
  buildIdentityMetrics,
  buildAuthSiteMetrics,
  buildSharedDistributionMetrics,
  type IdentityMetrics,
  type AuthSiteMetricCollection,
  type SharedDistributionMetrics,
  type BuildIdentityMetricsInput,
  type BuildAuthSiteMetricsInput,
  type BuildSharedDistributionMetricsInput,
} from "./metrics/index.js";

// v0.2 shared-distribution constructs (additive — see below).
export {
  SharedDistributionIdentity,
  WildcardCert,
  AdminLambda,
  Reconciler,
  CloudFrontDistribution,
  EdgeFunction,
  Waf,
  ClientConfigTable,
  ReservationsTable,
  SharedDistributionTriggers,
  // ... + the props/error types and default constants for each
} from "./shared-distribution-identity/index.js";
```

`AdvancedSecurityMode` is intentionally **not** re-exported at the top
level — the name collides with the single-tenant `MagicLinkIdentity`'s
own `AdvancedSecurityMode`. Consumers needing the shared-distribution
variant import it directly from
`./shared-distribution-identity` (the common
`'off'`/`'audit'`/`'enforced'` values are identical, so most consumers
won't need the deeper import).

No re-exports from `aws-cdk-lib` and no re-exports from
`@de-otio/vestibulum`. Consumers import directly from those packages
when they need types the constructs expose as readonly properties
(e.g., `cognito.UserPool` for the `identity.cognitoPool` escape hatch).

## The three primary constructs

Three L3 constructs with deliberately separate lifecycle concerns:

### `MagicLinkIdentity` — stateful, `RETAIN`

Owns persistent identity infrastructure:

- **Cognito User Pool** + four trigger Lambdas (`PreSignUp`,
  `DefineAuthChallenge`, `CreateAuthChallenge`,
  `VerifyAuthChallengeResponse`) implementing the passwordless
  magic-link `CUSTOM_AUTH` flow.
- **Three DynamoDB tables**: single-use token table (15-min TTL),
  rate-limit table, bounce/complaint denylist table.
- **SES domain identity** + DKIM + SPF + DMARC at `p=quarantine`
  minimum (when the caller passes a Route 53 hosted zone) +
  bounce-handler Lambda subscribed to the SES bounce/complaint SNS
  topic. The bounce handler doubles as the **circuit breaker** that
  suppresses re-sends to bouncing addresses.
- **HMAC secret** in Secrets Manager for hashing email addresses in
  the bounce-handler log path.

All resources default to `RemovalPolicy.RETAIN`. Deep design in
[`02-magic-link-identity.md`](02-magic-link-identity.md).

### `EdgeResources` — stateless, `us-east-1` only

Owns the cross-region pieces CloudFront forces into `us-east-1`:

- **ACM certificate** in `us-east-1` (DNS-validated via the consumer's
  Route 53 hosted zone).
- **WAFv2 Web ACL** in `CLOUDFRONT` scope (also `us-east-1`-only), with
  the Vestibulum default managed rule set.

Stateless. Synth-time region guard throws a clear error when the
construct is instantiated in any non-`us-east-1` stack. Deep design in
[`03-edge-resources.md`](03-edge-resources.md).

### `MagicLinkAuthSite` — stateless, regional

Owns the CloudFront-facing edge of the auth flow:

- **CloudFront distribution** with the WAFv2 Web ACL from
  `EdgeResources` attached, `PriceClass_100` default, response-headers
  policy with strict CSP / HSTS / COOP / CORP defaults.
- **Lambda@Edge** `check-auth` function (verifies the Cognito JWT
  cookie on viewer-request) — bundled from the vestibulum runtime.
- **`auth-verify` and `auth-signout` Lambdas** with Function URLs
  gated by CloudFront Origin Access Control (OAC) at the IAM layer.
- **Login-page S3 bucket** + `BucketDeployment` of the bundled
  `/login` and `/login/callback` HTML.
- **Auto-created Cognito website app client** via the
  `IMagicLinkIdentity.addAppClient` interface method (consumed
  internally by `MagicLinkAuthSite` against the identity it receives).

Stateless. Safe to replace freely. Deep design in
[`04-magic-link-auth-site.md`](04-magic-link-auth-site.md).

### Composition

```
┌──────────────────────────────────────────────────────────────┐
│                       App                                    │
│                                                              │
│  ┌──────────────────┐                                        │
│  │  global stack    │                                        │
│  │  (us-east-1)     │                                        │
│  │                  │     ┌───────────────────────────────┐  │
│  │  EdgeResources   │◄────┤  site stack (regional)        │  │
│  │  ├ ACM cert      │     │                               │  │
│  │  └ WAFv2 Web ACL │     │  MagicLinkAuthSite            │  │
│  └──────────────────┘     │  ├ CloudFront                 │  │
│                           │  ├ Lambda@Edge check-auth     │  │
│                           │  ├ auth-verify / auth-signout │  │
│                           │  └ login pages                │  │
│                           └─────────────┬─────────────────┘  │
│                                         │                    │
│                           ┌─────────────▼─────────────────┐  │
│                           │  identity stack (regional)    │  │
│                           │                               │  │
│                           │  MagicLinkIdentity            │  │
│                           │  ├ Cognito pool + 4 triggers  │  │
│                           │  ├ TokenTable / RateLimit /   │  │
│                           │  │   Denylist (DynamoDB)      │  │
│                           │  ├ SES + DKIM                 │  │
│                           │  └ bounce handler             │  │
│                           └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

`MagicLinkAuthSite` has required-prop edges into both `EdgeResources`
(cross-region SSM reference, via `crossRegionReferences: true` at the
stack level) and `MagicLinkIdentity` (cross-stack reference within the
regional environment).

## Consumer API — minimum example

```typescript
import { App, Stack } from "aws-cdk-lib";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { EdgeResources, MagicLinkIdentity, MagicLinkAuthSite } from "@de-otio/vestibulum-cdk";

const app = new App();

// Global stack: us-east-1 (forced by CloudFront / WAFv2 / ACM).
class GlobalStack extends Stack {
  readonly edge: EdgeResources;
  constructor(scope: App, id: string) {
    super(scope, id, {
      env: { region: "us-east-1" },
      crossRegionReferences: true,
    });
    this.edge = new EdgeResources(this, "Edge", {
      domain: "app.example.com",
      hostedZone: HostedZone.fromLookup(this, "Zone", {
        domainName: "example.com",
      }),
    });
  }
}

// Stateful stack: Cognito + DynamoDB + SES (eu-central-1).
// Deploy rarely. Resources default to RemovalPolicy.RETAIN.
class IdentityStack extends Stack {
  readonly identity: MagicLinkIdentity;
  constructor(scope: App, id: string) {
    super(scope, id, {
      env: { region: "eu-central-1" },
      crossRegionReferences: true,
    });
    this.identity = new MagicLinkIdentity(this, "Identity", {
      hostedZone: HostedZone.fromLookup(this, "Zone", {
        domainName: "example.com",
      }),
      allowedEmailDomains: ["example.com"],
      sesIdentitySender: "noreply@example.com",
    });
  }
}

// Stateless stack: CloudFront + Lambda@Edge + auth endpoints
// (eu-central-1). Safe to replace freely.
class SiteStack extends Stack {
  constructor(scope: App, id: string, edge: EdgeResources, identity: MagicLinkIdentity) {
    super(scope, id, {
      env: { region: "eu-central-1" },
      crossRegionReferences: true,
    });

    const bucket = new Bucket(this, "SiteBucket", {
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    new MagicLinkAuthSite(this, "Site", {
      domain: "app.example.com",
      origin: S3BucketOrigin.withOriginAccessControl(bucket),
      edge,
      identity,
    });
  }
}

const global = new GlobalStack(app, "AppGlobal");
const identity = new IdentityStack(app, "AppIdentity");
new SiteStack(app, "AppSite", global.edge, identity.identity);
```

That's the whole consumer surface for a typical single-region
deployment. Everything else has sensible defaults.

Consumers who want to update CloudFront config or swap the origin run
`cdk deploy AppSite` — the identity stack is not in scope and its
resources are not touched.

## Multi-stack handling

The three-stack pattern is mandatory because of two independent
constraints:

**Region constraint** (us-east-1):

- CloudFront's ACM cert MUST live in `us-east-1`.
- WAFv2 in `CLOUDFRONT` scope MUST live in `us-east-1`.
- Lambda@Edge functions MUST be authored in `us-east-1` (CloudFront
  then replicates the code globally).

**Lifecycle constraint** (stateful vs stateless):

- Cognito pools and DynamoDB tables hold persistent data and must be
  isolated from resources that may be replaced on update.
- CloudFront distributions, Lambda functions, and auth endpoints are
  replaceable and should be freely deployable without touching the
  identity stack.

Vestibulum-cdk surfaces this as three construct types, each with a
natural stack home:

| Construct           | Stack                     | Region      | Lifecycle  |
| ------------------- | ------------------------- | ----------- | ---------- |
| `EdgeResources`     | consumer's global stack   | `us-east-1` | stateless  |
| `MagicLinkIdentity` | consumer's identity stack | regional    | **RETAIN** |
| `MagicLinkAuthSite` | consumer's site stack     | regional    | stateless  |

The multi-stack split stays the consumer's responsibility because:

- CDK convention is one stack per region; constructs shouldn't hide
  that.
- The consumer may want other resources in the global stack (their
  own Lambda@Edge functions, other CloudFront distributions);
  auto-creating stacks inside a construct would collide.
- `crossRegionReferences: true` requires the consumer to pass
  `env: { region: ... }` explicitly on both cross-region stacks
  anyway, so the construct can't hide it.
- Separating `IdentityStack` from `SiteStack` is a consumer decision —
  some consumers may want them in the same regional stack
  (acceptable), while others may want separate deploy pipelines.

### Cross-region wiring — `crossRegionReferences: true`

CDK implements `crossRegionReferences: true` via SSM parameters in
`us-east-1` with predictable names. The ACM cert ARN and the
identity-side references travel through SSM.

**Deploy-role requirement.** The consumer's deploy role needs
`ssm:GetParameter` on
`arn:aws:ssm:us-east-1:<account-id>:parameter/cdk/exports/*`,
scoped to the **same account** in **`us-east-1`**. The cdk-bootstrap
stack's standard deploy-role policy already covers this — most
consumers won't need to grant anything extra. See
[`03-edge-resources.md § Cross-region SSM exposure`](03-edge-resources.md#cross-region-ssm-exposure-consequence-of-crossregionreferences-true).

SSM parameter names are not secrets but their pattern
(`/cdk/exports/<stack-name>/<export-name>`) fingerprints
vestibulum-cdk-using accounts. Low-risk; documented for completeness.

## Configuration surface

### `MagicLinkIdentityProps`

Required:

| Prop                  | Type          | Purpose                                                                                   |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `hostedZone`          | `IHostedZone` | Route 53 zone for DKIM + SPF/DMARC records                                                |
| `allowedEmailDomains` | `string[]`    | `PreSignUp` allowlist (e.g. `['example.com']`); empty array means "no domain restriction" |
| `sesIdentitySender`   | `string`      | `From` address for magic-link emails                                                      |

Optional:

| Prop                           | Default                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenTtlMinutes`              | `15`                                                            | Magic-link token TTL                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tokenSendsPerWindow`          | `3`                                                             | Max sends per email per 15-min window. Enforced in `CreateAuthChallenge` via conditional `UpdateItem` against the rate-limit table.                                                                                                                                                                                                                                                                                                                                                     |
| `signUpsPerWindow`             | `3`                                                             | Max signup attempts per email + per source IP per 15-min window (`PreSignUp` rate limit). Mailbomb / enumeration guard.                                                                                                                                                                                                                                                                                                                                                                 |
| `signupMode`                   | `'open'` (error in federation-enabled pools — must be explicit) | `'open'` or `'admin-invite-only'`. Invite-only makes `PreSignUpFn` reject every `SignUp` API call; `AdminCreateUser` becomes the only path to create a user. **REQUIRED** when `federationEnabled: true`. See [`02-magic-link-identity.md § Signup mode`](02-magic-link-identity.md#signup-mode-propssignupmode).                                                                                                                                                                        |
| `customAttributes`             | `[]`                                                            | Cognito **custom** attribute declarations (federation, tenant routing, etc.). Immutable once declared. **Cognito custom attributes cannot be added to an existing pool** — declare every attribute up front; adding one to a deployed pool forces a replace and the `RETAIN` policy blocks deletion. See [`07-cdk-changes-from-trellis.md § customAttributes`](07-cdk-changes-from-trellis.md#customattributes) and [`02-magic-link-identity.md § Replace-on-update traps`](02-magic-link-identity.md#replace-on-update-traps).                                                                                                          |
| `hostedUiDomain`               | _none_                                                          | Cognito Hosted UI domain (required for OAuth code flow / federation).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `federationEnabled`            | `false`                                                         | Enable federation auth flows on the pool and its app clients. Default preserves the magic-link-only v0.1 behaviour.                                                                                                                                                                                                                                                                                                                                                                     |
| `featureTier`                  | _Cognito default_                                               | `Lite` / `Essentials` / `Plus` Cognito feature plan. Gates pre-token-generation event versions V2 / V3.                                                                                                                                                                                                                                                                                                                                                                                 |
| `advancedSecurity`             | `'off'`                                                         | Cognito Advanced Security mode: `'off'`, `'audit'`, or `'enforced'`. Paid feature (per-MAU above the CAS free-tier cap); default-off keeps the bill predictable. See [`02-magic-link-identity.md § Cognito Advanced Security mode`](02-magic-link-identity.md#cognito-advanced-security-mode).                                                                                                                                                                                          |
| `immutableAttributeSeverity`   | `'error'`                                                       | Severity for the `FederationCustomAttributesAspect` rule that rejects `mutable: false` custom attributes (N3): `'error'` (default) or `'warning'`. The default matches the empirical claim that `AdminLinkProviderForUser` refuses any user carrying an immutable custom attribute; downgrade to `'warning'` only if you've shown the rule doesn't hold in your environment.                                                                                                            |
| `defaultIdTokenValidity`       | `Duration.minutes(15)`                                          | Pool-wide ID-token TTL default (per-app-client overridable).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `defaultRefreshTokenValidity`  | `Duration.hours(24)`                                            | Pool-wide refresh-token TTL default. **24 h, not Cognito's 30-day default**, because the edge JWT verifier doesn't consult Cognito on every request — the offboarding window is bounded by this TTL.                                                                                                                                                                                                                                                                                    |
| `preTokenGeneration`           | _none_                                                          | Optional consumer-supplied Lambda for Cognito `PreTokenGeneration` trigger. **Runs inside the auth boundary with token-issuance privileges** — see [`06-trigger-hooks.md § Trust model`](06-trigger-hooks.md#trust-model).                                                                                                                                                                                                                                                              |
| `postConfirmation`             | _none_                                                          | Optional consumer-supplied Lambda for Cognito `PostConfirmation` trigger. Same trust-boundary caveat as `preTokenGeneration`.                                                                                                                                                                                                                                                                                                                                                           |
| `costDosGuard`                 | _none_ (`enabled: false`)                                       | SES cost-DoS guard (v0.3, cost-pillar S7): deploys a CloudWatch alarm on `AWS/SES` `Send` with threshold `sendsPerHourCap`, and optionally (`selfDefence: true`) a handler that disables Cognito self-sign-up when the alarm fires. Default off — opt in when SES spend needs an envelope. See [`04-magic-link-auth-site.md § SES cost-DoS guard`](04-magic-link-auth-site.md#ses-cost-dos-guard).  |

### `MagicLinkAuthSiteProps`

Required:

| Prop       | Type                 | Purpose                                         |
| ---------- | -------------------- | ----------------------------------------------- |
| `domain`   | `string`             | Public-facing domain (e.g. `app.example.com`)   |
| `origin`   | `IOrigin`            | Protected origin (S3 bucket, ALB, etc.)         |
| `edge`     | `IEdgeResources`     | Cross-region reference from the us-east-1 stack |
| `identity` | `IMagicLinkIdentity` | Cross-stack reference from the identity stack   |

Optional:

| Prop                    | Default                                | Purpose                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priceClass`            | `PriceClass_100`                       | CloudFront edge geography. NA + EU **cache** edges only. Note: this does NOT restrict Lambda@Edge replication regions — those are separate; the Lambda@Edge log-suppression mitigation covers that.             |
| `responseHeadersPolicy` | sensible defaults                      | Override CSP / HSTS / Permissions-Policy etc.                                                                                                                                                                   |
| `loginPageBucket`       | auto-created                           | Where the `/login` HTML lives                                                                                                                                                                                   |
| `idTokenValidity`       | `identity.defaultIdTokenValidity`      | Override for the auto-created website app client.                                                                                                                                                               |
| `refreshTokenValidity`  | `identity.defaultRefreshTokenValidity` | Override for the auto-created website app client.                                                                                                                                                               |
| `reservedConcurrency`   | sensible per-handler defaults          | Override `reservedConcurrency` for `auth-verify` / `auth-signout`. Defaults: **20 / 5**. Cost-DoS guard — see [`04-magic-link-auth-site.md § Cost-DoS envelope`](04-magic-link-auth-site.md#cost-dos-envelope). |
| `metricsNamespace`      | `'Vestibulum/AuthSite'`                | Override the CloudWatch namespace for custom metrics.                                                                                                                                                           |
| `namespacePrefix`       | `'Vestibulum'`                         | Override the resource-name prefix used in physical resource names (the response-headers policy name, CloudFront distribution comment, etc.).                                                                    |

`signupMode` lives on `MagicLinkIdentityProps`, not here — the
Identity owns the `PreSignUpFn` that enforces the policy. See
[`02-magic-link-identity.md § Signup mode`](02-magic-link-identity.md#signup-mode-propssignupmode).

`wafManagedRules` and the WAF Web ACL belong to `EdgeResources` (the
Web ACL lives in `us-east-1`); see `EdgeResourcesProps` below.

### `EdgeResourcesProps`

| Prop                        | Type                                                 | Purpose                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`                    | `string`                                             | Domain name on the ACM cert + WAF dimensions                                                                                                                                                                                                 |
| `hostedZone`                | `IHostedZone`                                        | Route 53 zone for DNS-validated ACM                                                                                                                                                                                                          |
| `subjectAlternativeNames`   | `string[]` (optional)                                | Additional SANs on the ACM cert (e.g. `auth.example.com` for the Cognito Hosted UI custom domain). See [`03-edge-resources.md § ACM certificate`](03-edge-resources.md#acm-certificate).                                                     |
| `wafManagedRules`           | `RuleProperty[]` (optional)                          | Override the default WAF rule set entirely                                                                                                                                                                                                   |
| `extraWafManagedRuleGroups` | `ManagedRuleGroup[]` (optional)                      | Append paid managed rule groups (ATP, BotControl, ACFP) to the default set. Opt-in because these are billed per-MAU or per-request. See [`03-edge-resources.md § Cost surface`](03-edge-resources.md#cost-surface--opt-in-paid-rule-groups). |
| `authVerifyRateLimit`       | `number` (optional)                                  | Override the per-IP rate-limit on `/auth-verify` (default 60 / 5 min — magic-link-pumping guard).                                                                                                                                            |
| `loginRateLimit`            | `number` (optional)                                  | Override the per-IP rate-limit on `/login` GET (default 200 / 5 min — generic bot deterrent).                                                                                                                                                |
| `metricsNamespace`          | `string` (optional, default `'Vestibulum/AuthSite'`) | Override the CloudWatch namespace for WAF visibility metrics.                                                                                                                                                                                |
| `resourceNamePrefix`        | `string` (optional, default `'Vestibulum'`)          | Override the resource-naming prefix used in WAF metric names.                                                                                                                                                                                |

## Mandatory mitigations baked in

A set of mitigations is required for a safe deployment of this shape
and MUST be enforced by the construct, not left as caller homework.
Five mitigations are the load-bearing security story; detailed wiring
is in the per-construct deep designs.

### 1. Lambda@Edge log suppression

**Why:** Lambda@Edge runs in every CloudFront edge region, including
regions outside the consumer's chosen data-residency boundary.
CloudWatch logs from these functions are written _in the edge region_,
not the home region. If the function logs anything containing user
data (email addresses, tokens, IPs), that data lands in a region the
consumer didn't authorise.

**How:** the construct creates the edge function's execution role
WITHOUT `logs:PutLogEvents` permission (the default
`AWSLambdaBasicExecutionRole` managed policy is stripped via a CDK
override) and ensures the bundled function source contains no
`console.*` calls. Auto-created CloudWatch log groups have retention
pinned to 1 day as a belt-and-braces measure. An integration test
asserts both the IAM shape and the absence of `console.` source
occurrences.

### 2. `PriceClass_100`

**Why:** `PriceClass_100` restricts CloudFront **cache** regions to
North America and Europe. For an EU-residency-conscious deployment,
this avoids edge caching in regions with weaker data-protection
regimes. It is the closest CloudFront knob to "EU-only" — true
EU-only isn't an option without disabling the CDN.

**How:** `PriceClass_100` is the default in the construct. Changing
it requires explicitly passing `priceClass` in props, making the
choice discoverable in code review rather than silent.

**Note:** `PriceClass_100` does NOT restrict Lambda@Edge replication
regions — those are separate and broader. Mitigation 1 (log
suppression) covers that surface independently.

### 3. Fragment-based magic-link tokens

**Why:** putting the magic-link token in the URL query string leaks
it to (a) `Referer` headers on outbound requests from the landing
page and (b) URL link scanners (Microsoft Safe Links, Google,
corporate proxies) that follow the link before the user does,
single-use-consuming the token. The fix is to put the token in the
URL **fragment** (`#token=...`) — fragments are not sent in `Referer`
and most link scanners do not execute JS.

**How:** the bundled `CreateAuthChallenge` Lambda emits magic-link
URLs with the token in the fragment, and the default
`/login/callback` HTML page reads the fragment, **immediately scrubs
it via `history.replaceState`** (otherwise a bookmark / copy-URL /
browser-back still leaks), then POSTs the token to `auth-verify`.
Not configurable.

### 4. Generic `PreSignUp` rejection message

**Why:** a `PreSignUp` Lambda that throws `Error("Signup not allowed
for domain X")` leaks the allowlist contents to anyone who probes.

**How:** the bundled `PreSignUp` always throws the generic
`Error("Signup not allowed")`. The rejected domain is written to
CloudWatch (server-side only) for forensic queries. Not configurable.

### 5. Cognito risk configuration — opt-in, audit-or-enforced

**Why:** Cognito Advanced Security (CAS) provides risk-based
detection of account takeover and compromised credentials. AWS bills
CAS per MAU above the Cognito Advanced Security free-tier MAU cap;
the feature is **free _up to_ the free-tier cap, paid thereafter**.
Defaulting CAS on would create a silent recurring bill for any
deployment that exceeds the cap.

**How:** `advancedSecurity` on `MagicLinkIdentityProps` is `'off'`
by default. Consumers who want risk-based detection set
`advancedSecurity: 'audit'` (logs signals, no enforcement) or
`'enforced'` (Cognito takes action on detected risks). When the
prop is set, the construct attaches a
`CfnUserPoolRiskConfigurationAttachment` with the actions
configured per mode. See
[`02-magic-link-identity.md § Cognito Advanced Security mode`](02-magic-link-identity.md#cognito-advanced-security-mode).

There is no "free compensating control" in the default rule set —
`AWSManagedRulesATPRuleSet` is itself a paid managed rule group and
its password-field inspection is semantically meaningless on a
passwordless magic-link flow. Consumers wanting ATP opt in via
`extraWafManagedRuleGroups` on `EdgeResourcesProps` (see
[`03-edge-resources.md § Cost surface`](03-edge-resources.md#cost-surface--opt-in-paid-rule-groups)).

## Synth-time Aspects

The construct constructors apply a small set of CDK Aspects scoped to
the vestibulum-cdk subtree (marked via a `cdk.context` tag at
construction time):

- **`DisabledAuthFlowsAspect`** — fails synth if any
  `CfnUserPoolClient` under `MagicLinkIdentity` declares one of the
  forbidden auth flows (`ALLOW_USER_PASSWORD_AUTH`,
  `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_AUTH`, and
  `ALLOW_USER_SRP_AUTH` unless `allowSrpAuth: true` is set). Federation
  mode (see [`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md))
  permits the OAuth code flow; SDK-based password / SRP / USER_AUTH
  flows stay blocked regardless of mode.
- **`FederationCustomAttributesAspect`** — warns or errors on common
  mistakes around `customAttributes` (required + immutable conflict,
  worst-case ID-token-size estimate, mutable-false-when-federation-on).
- **`HostedUiDomainAspect`** — fails synth if `federationEnabled: true`
  and `hostedUiDomain` is unset, or if a custom `hostedUiDomain` ACM
  cert ARN is not in `us-east-1`.
- **`WafRequiredAspect`** — every CloudFront distribution in the
  subtree must have a Web ACL.
- **`LogRetentionRequiredAspect`** — every non-edge Lambda in the
  subtree must have explicit `logRetention` set.

Aspects are scoped via a metadata-marker on the vestibulum-cdk
subtree root so applying them at App or Stack scope is inert outside
the vestibulum-cdk subtree.

## L3 with escape hatches

Both stateful and stateless constructs expose their internals as
readonly properties so consumers can use idiomatic CDK without
fighting the library.

`MagicLinkIdentity` escape hatches:

- `identity.cognitoPool` — for raw L2 manipulation.
- `identity.tokenTable`, `identity.rateLimitTable`,
  `identity.denylistTable` — DynamoDB tables for IAM grants to
  external read-only consumers.
- `identity.bounceTopic` — the SNS topic, for adding extra subscribers.
- `identity.preTokenGeneration` / `identity.postConfirmation` — Lambda
  references if either was provided as a prop.

**Adding extra app clients.** The concrete `MagicLinkIdentity` class
does NOT have an `addAppClient` method. (`addAppClient` appears on the
`IMagicLinkIdentity` interface, which `MagicLinkAuthSite` consumes
internally to auto-create the website client.) To provision additional
Cognito app clients, use the exported `buildAppClientOptions` helper
to derive federation-aware, security-defaulted
`UserPoolClientOptions`, then call `identity.cognitoPool.addClient(id,
options)` directly:

```typescript
import { buildAppClientOptions } from "@de-otio/vestibulum-cdk";

const options = buildAppClientOptions({
  federationEnabled: identity.federationEnabled,
  defaultIdTokenValidity: identity.defaultIdTokenValidity,
  defaultRefreshTokenValidity: identity.defaultRefreshTokenValidity,
  props: { /* cognito.UserPoolClientOptions overrides */ },
});
identity.cognitoPool.addClient("MobileClient", options);
```

Full spec in [`05-app-clients.md`](05-app-clients.md).

`MagicLinkAuthSite` escape hatches:

- `site.distribution` — the CloudFront distribution for adding
  behaviours, headers, or extra origins.
- `site.authVerifyUrl` — the Function URL of `auth-verify`, for
  clients that need to call it directly.
- `site.websiteClient` — the auto-created Cognito app client, for
  downstream IaC that needs the client ID.

No `aws-cdk-lib` types are hidden behind library wrappers — the
constructs expose the native types. The synth-time Aspects fail the
build if the escape hatches are used to re-enable a disabled flow,
so the escape hatches are powerful without being unsafe.

## Bundled Lambda code — packaging note

The Lambda handler code (four Cognito `CUSTOM_AUTH` triggers,
bounce-handler, `auth-verify`, `auth-signout`, `check-auth` for
Lambda@Edge, the optional `pre-token-generation` and
`post-confirmation` defaults, plus the v0.2 shared-distribution
`admin` and `reconciler` handlers — 12 bundle entry points in total) is
**bundled into this package at build time** from the
[`@de-otio/vestibulum`](../vestibulum/) runtime source. `vestibulum-cdk`
does not declare `@de-otio/vestibulum` as an npm dependency — the
bundles are committed to the tarball and verified against a hash
manifest. See
[`../07-vestibulum-migration.md § Lambda handler source move`](../07-vestibulum-migration.md#lambda-handler-source-move--the-cross-package-bundling-prerequisite).

This matters for consumers in two ways:

- A consumer's CDK synth process never imports the vestibulum
  runtime; the Cognito SDK is not pulled into synth.
- A change to vestibulum runtime that touches the Lambda handler
  surface requires re-publishing `vestibulum-cdk` to take effect at
  the edge. A consumer who installs a new vestibulum runtime version
  alongside an old vestibulum-cdk version is fine, but the Lambda
  triggers will run the _bundled_ (older) code.

Full pipeline in [`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md);
relationships explained in
[`../03-package-relationships.md § The bundling relationship in
detail`](../03-package-relationships.md#the-bundling-relationship-in-detail).

## Origin shape

The construct accepts a standard CloudFront `IOrigin`. Typical
consumers will pass:

- A private S3 bucket via `S3BucketOrigin.withOriginAccessControl(bucket)`.
- An ALB (rarer; CloudFront → private ALB is a defensible pattern
  but not the common case for this construct).

The construct does NOT create the origin bucket itself — consumers
want control over versioning, lifecycle, encryption keys, replication.

## v0.2 shared-distribution constructs

v0.2 adds an **additive** shared-distribution mode for the
multi-tenant "one CloudFront distribution, many tenant subdomains"
topology, alongside the single-tenant constructs above. These
constructs are exported from the same top-level barrel
(`lib/shared-distribution-identity/index.js`):

| Construct                     | Role                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `SharedDistributionIdentity`  | Shared Cognito pool + triggers for the multi-tenant distribution.                         |
| `WildcardCert`                | ACM wildcard certificate (`*.example.com`) for the shared CloudFront distribution.        |
| `AdminLambda`                 | Function-URL admin handler (IAM-authed) for tenant provisioning — backed by the `admin` bundle. |
| `Reconciler`                  | Scheduled handler detecting orphaned app clients / ClientConfig rows — backed by the `reconciler` bundle. |
| `CloudFrontDistribution`      | The shared multi-tenant CloudFront distribution.                                          |
| `EdgeFunction`                | The edge config + Lambda@Edge / CloudFront-Function gate for the shared distribution.     |
| `Waf`                         | WAF Web ACL with the CloudFront + Cognito default rule sets.                               |
| `ClientConfigTable`           | DynamoDB table mapping tenant subdomain / clientId → config (with GSIs).                   |
| `ReservationsTable`           | DynamoDB table reserving tenant subdomains.                                                |
| `SharedDistributionTriggers`  | The trigger-Lambda bundle for the shared pool.                                             |

Each ships with its `*Props` type plus default constants
(`DEFAULT_TENANT_SUBDOMAIN_PATTERN`, `DEFAULT_RESERVED_SUBDOMAINS`,
`DEFAULT_JWKS_TTL`, the default WAF rule builders / CSP / HSTS
constants, etc.) and helpers (`resolveEdgeConfig`,
`renderEdgeConfigModule`, `createDefaultResponseHeadersPolicy`).

The **design** for the shared-distribution topology lives in the
runtime doc tree under
[`../vestibulum/shared-distribution/`](../vestibulum/shared-distribution/README.md)
— in particular
[`02-construct-api.md`](../vestibulum/shared-distribution/02-construct-api.md)
(construct surface),
[`03-tenant-onboarding.md`](../vestibulum/shared-distribution/03-tenant-onboarding.md)
(`AdminLambda` / `Reconciler` flows),
[`05-wildcard-infra.md`](../vestibulum/shared-distribution/05-wildcard-infra.md)
(`WildcardCert` / `CloudFrontDistribution`), and
[`04-multi-aud-edge-check.md`](../vestibulum/shared-distribution/04-multi-aud-edge-check.md)
(`EdgeFunction`). This `vestibulum-cdk` doc tree (`01`–`10`) still
documents the single-tenant constructs in depth; the shared-
distribution constructs are documented via that cross-link.

## What this file doesn't cover

- **Cognito pool, DynamoDB tables, SES, and trigger wiring details** —
  see [`02-magic-link-identity.md`](02-magic-link-identity.md).
- **CloudFront, Lambda@Edge, and login-page wiring details** — see
  [`04-magic-link-auth-site.md`](04-magic-link-auth-site.md).
- **App-client provisioning and token-TTL hierarchy** — see
  [`05-app-clients.md`](05-app-clients.md).
- **Lambda-bundle pipeline (esbuild, hash manifest, CI gate)** — see
  [`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md).
