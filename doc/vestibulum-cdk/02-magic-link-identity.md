# 02 — `MagicLinkIdentity`

The stateful CDK L3 construct: Cognito User Pool, four `CUSTOM_AUTH`
trigger Lambdas, three DynamoDB tables, SES domain identity with
DKIM, and the bounce-handler circuit breaker. Defaults to
`RemovalPolicy.RETAIN` on every persistent resource.

This is the load-bearing identity construct in vestibulum-cdk. Most of
its complexity is in the Cognito wiring, the IAM grants, and the
SES + DKIM + DMARC DNS records. The bundled Lambda code (four
triggers + bounce-handler) is built from the
[`@de-otio/vestibulum`](../vestibulum/) runtime — see
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md) for the
build-time pipeline.

## Resources at a glance

| Resource                           | Logical ID                 | Notes                                                                                              |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| Cognito User Pool                  | `Pool`                     | `CUSTOM_AUTH` flow, no passwords, MFA off, `RETAIN`                                                |
| Cognito UserPoolDomain (opt.)      | `HostedUiDomain`           | Only present when `hostedUiDomain` prop is set                                                     |
| Cognito risk config attachment     | `RiskConfig`               | Only present when `advancedSecurity !== 'off'` (default off; see § Cognito Advanced Security mode) |
| PreSignUp Lambda                   | `PreSignUpFn`              | `lambda.Function` + `Code.fromAsset`, bundled from `@de-otio/vestibulum`                           |
| DefineAuthChallenge Lambda         | `DefineAuthFn`             | "                                                                                                  |
| CreateAuthChallenge Lambda         | `CreateAuthFn`             | "                                                                                                  |
| VerifyAuthChallengeResponse Lambda | `VerifyAuthFn`             | "                                                                                                  |
| Bounce handler Lambda              | `BounceHandlerFn`          | "                                                                                                  |
| DynamoDB token table               | `TokenTable`               | Single-use token hashes + TTL                                                                      |
| DynamoDB rate-limit table          | `RateLimitTable`           | Per-email counter + TTL                                                                            |
| DynamoDB denylist table            | `DenylistTable`            | HMAC-hashed quarantined addresses                                                                  |
| SNS bounce topic                   | `BounceTopic`              | KMS-encrypted, subscribed by `BounceHandlerFn`                                                     |
| SES domain identity                | `SesIdentity`              | DKIM signing enabled, `RETAIN`                                                                     |
| Route 53 CNAMEs                    | `DkimCname1`/`2`/`3`       | DKIM tokens published as CNAME records                                                             |
| Route 53 TXT records               | `SpfRecord`, `DmarcRecord` | SPF + DMARC at `p=quarantine`                                                                      |
| Secrets Manager secret             | `HmacKey`                  | HMAC-SHA-256 key for hashing email addresses in bounce-handler logs                                |

Logical IDs on stateful resources (`Pool`, `TokenTable`,
`RateLimitTable`, `DenylistTable`, `SesIdentity`) are pinned and MUST
NOT change across vestibulum-cdk versions — they are part of the
public CloudFormation contract. Renaming would force a
replace-on-update on the consumer's deployed pool, which the `RETAIN`
policy will block at deploy time and which would lose every user.

## Cognito User Pool

The pool ships locked-down by default:

```typescript
new cognito.UserPool(this, "Pool", {
  signInAliases: { email: true },
  selfSignUpEnabled: true,
  standardAttributes: {
    email: { required: true, mutable: false },
  },
  customAttributes: {
    email_quarantined: new cognito.BooleanAttribute({ mutable: true }),
    // + props.customAttributes
  },
  mfa: cognito.Mfa.OFF,
  accountRecovery: cognito.AccountRecovery.NONE,
  passwordPolicy: {
    /* tightest defaults; no password flows enabled */
  },
  email: cognito.UserPoolEmail.withSES({
    fromEmail: props.sesIdentitySender,
    fromName: "Vestibulum",
    sesRegion: Stack.of(this).region,
    sesVerifiedDomain: domain,
  }),
  lambdaTriggers: {
    /* four triggers, see below */
  },
  removalPolicy: RemovalPolicy.RETAIN,
});
```

Properties worth calling out:

- **No passwords.** Password policy fields are set to a placeholder
  minimum because Cognito requires _some_ policy object; the
  password-based auth flows are disabled at the app-client level by
  the `DisabledAuthFlowsAspect`.
- **No MFA, no account recovery.** The magic link itself is the
  authentication factor; "account recovery" via SMS/email reset
  doesn't apply.
- **`email` is `mutable: false`.** A user's email is the routing key
  for every magic link; mutating it breaks the audit story and
  invalidates active tokens.
- **`email_quarantined` custom attribute** is owned by the
  construct, used by the bounce handler to flag addresses. It is
  always present, regardless of `props.customAttributes`.
- **Cognito Advanced Security is OFF by default.** Opt-in via the
  `advancedSecurity` prop (see § Cognito Advanced Security mode).
  When enabled, the construct sets `userPoolAddOns.advancedSecurityMode`
  via the L1 escape hatch and attaches the risk configuration
  documented below.

### Custom attributes (`props.customAttributes`)

Cognito **does not permit adding custom attributes to an existing
pool**. If the pool ships without `custom:tenantId` (or whatever the
consumer chose), no future runtime call can add it. The
`customAttributes` prop declares them at pool creation; the
[`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md) doc
covers the federation-driven attribute discipline.

Validation (run at construct-construction time via
`validateCustomAttributeDeclarations`):

- Names match `[a-zA-Z0-9_]+` and are **1–20 characters** (Cognito's
  per-attribute name length, excluding the `custom:` prefix).
- Total attribute count ≤ 50 (Cognito quota), counting the
  package-internal `email_quarantined`.
- Required + `mutable: false` combinations are rejected — a federated
  user whose IdP doesn't supply the attribute cannot be created.
- When `federationEnabled: true`, any `mutable: false` attribute is
  rejected: `AdminLinkProviderForUser` refuses any user whose profile
  contains an immutable custom attribute, permanently blocking the
  account-link operation.

### Cognito Advanced Security mode

Cognito Advanced Security (CAS) is **opt-in**, gated by the
`advancedSecurity?: 'off' | 'audit' | 'enforced'` prop on
`MagicLinkIdentityProps`. Default: `'off'`.

```typescript
interface MagicLinkIdentityProps {
  // ...
  advancedSecurity?: "off" | "audit" | "enforced";
}
```

When `advancedSecurity !== 'off'`, the construct:

1. Sets `userPoolAddOns.advancedSecurityMode` via the L1 escape
   hatch on the pool (`'AUDIT'` or `'ENFORCED'`).
2. Attaches a `CfnUserPoolRiskConfigurationAttachment` with the
   actions wired according to the mode:

```typescript
// Only when advancedSecurity !== 'off'
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
```

**Cost surface.** Both `'audit'` and `'enforced'` modes are billed
per MAU above the Cognito Advanced Security free-tier MAU cap (free
allowance, $0.05/MAU thereafter; AWS publishes the current cap on
the Cognito pricing page). The default `'off'` keeps the per-MAU
billing line absent for consumers who do not need risk-based
detection. Mandatory Mitigation 5 is "free _up to_ the CAS free-tier
MAU cap, paid thereafter" — see
[`01-package-api.md § Mandatory mitigations baked in`](01-package-api.md#mandatory-mitigations-baked-in).

**Why not default-on `'audit'`.** Defaulting to `'audit'` would be a
silent recurring bill for any deployment that exceeds the free-tier
cap. The previous design's "free-tier compensating control" framing
(pairing the AUDIT-mode pool with the WAF `AWSManagedRulesATPRuleSet`)
was wrong on two counts: ATPRuleSet itself is paid, and ATP's
password-inspection signal is meaningless on a passwordless magic-link
flow (the "credential" is an opaque random token). The construct
makes both choices explicit opt-ins instead.

## The four `CUSTOM_AUTH` trigger Lambdas

All four are `lambda.Function` instances whose code is loaded via
`lambda.Code.fromAsset(...)` from the pre-built bundles produced by
the build script in
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md). The
runtime source for the handler factories lives in
[`@de-otio/vestibulum`](../vestibulum/) under
`packages/vestibulum/src/lambda/handlers/` — see
[`../07-vestibulum-migration.md § Lambda handler source move`](../07-vestibulum-migration.md#lambda-handler-source-move--the-cross-package-bundling-prerequisite).
Bundling happens at vestibulum-cdk publish time; consumers' synth
processes never run esbuild.

Sketch (the same shape for all four triggers):

```typescript
this.preSignUpFn = new lambda.Function(this, "PreSignUpFn", {
  code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda-bundles/pre-signup")),
  handler: "index.handler",
  runtime: lambda.Runtime.NODEJS_22_X,
  reservedConcurrentExecutions: 10,
  logRetention: logs.RetentionDays.ONE_MONTH,
  environment: {
    /* see RuntimeEnv table below */
  },
});
```

No `NodejsFunction`: the consumer's deploy role doesn't need to grant
esbuild-at-synth permissions for any vestibulum-cdk-managed Lambda.

Shared environment via the `RuntimeEnv` registry — every handler that
reads a runtime env var pulls the key from this registry so the CDK
side and the runtime side agree on the name:

| Env var                             | Value (set at synth)                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `RuntimeEnv.TOKEN_TABLE_NAME`       | `this.tokenTable.tableName`                                                    |
| `RuntimeEnv.RATE_LIMIT_TABLE_NAME`  | `this.rateLimitTable.tableName`                                                |
| `RuntimeEnv.DENYLIST_TABLE_NAME`    | `this.denylistTable.tableName`                                                 |
| `RuntimeEnv.SES_FROM`               | `props.sesIdentitySender`                                                      |
| `RuntimeEnv.SES_REGION`             | `Stack.of(this).region`                                                        |
| `RuntimeEnv.TOKEN_TTL_MINUTES`      | `String(tokenTtlMinutes)`                                                      |
| `RuntimeEnv.TOKEN_SENDS_PER_WINDOW` | `String(tokenSendsPerWindow)`                                                  |
| `RuntimeEnv.SIGN_UPS_PER_WINDOW`    | `String(signUpsPerWindow)`                                                     |
| `RuntimeEnv.ALLOWED_EMAIL_DOMAINS`  | `JSON.stringify(props.allowedEmailDomains)`                                    |
| `RuntimeEnv.BOUNCE_HMAC_SECRET`     | `hmacSecret.secretArn`                                                         |
| `RuntimeEnv.COGNITO_USER_POOL_ID`   | injected via `addEnvironment` AFTER pool creation (avoids a `DependsOn` cycle) |
| `RuntimeEnv.SIGNUP_MODE`            | `props.signupMode ?? 'open'` (set on `PreSignUpFn` at synth time)              |

Common Lambda defaults:

- `runtime: NODEJS_22_X`
- `reservedConcurrentExecutions: 10` (cost-DoS guard, prop-overridable)
- `logRetention: ONE_MONTH` (30 days; not Lambda's default of "never
  expire")
- Bundling: `minify: true`, no source maps in production bundles.

### `PreSignUpFn`

- **Trigger:** Cognito `PreSignUp` (run on `SignUp` API call).
- **Reads:** `RateLimitTable` (conditional write for per-email-and-IP
  rate limit).
- **IAM:** `dynamodb:PutItem`, `dynamodb:UpdateItem` on
  `RateLimitTable`.
- **Behaviour:** allowlist check against
  `props.allowedEmailDomains`; per-email-per-source-IP rate limit
  (`signUpsPerWindow`); throws the generic `"Signup not allowed"`
  error (Mandatory Mitigation 4) when either check fails. Logs the
  rejected **domain only** (not the full email) for forensic queries.
- **Signup mode (`props.signupMode`):** when set to
  `'admin-invite-only'`, the handler rejects every signup API call.
  The only path to create a user becomes `AdminCreateUser`. See
  [§ Signup mode](#signup-mode-propssignupmode) below for the
  full policy; the Identity owns the `PreSignUpFn` and therefore
  owns the signup-mode policy.

### `DefineAuthFn`

- **Trigger:** Cognito `DefineAuthChallenge`.
- **Reads/writes:** nothing — pure state-machine.
- **IAM:** none beyond `AWSLambdaBasicExecutionRole`.
- **Behaviour:** orchestrates the `CUSTOM_AUTH` state machine. Issues
  `CUSTOM_CHALLENGE` on first call, then `succeed`/`fail` based on
  the `VerifyAuthFn` answer. Bounded retries.

### `CreateAuthFn`

- **Trigger:** Cognito `CreateAuthChallenge`.
- **Reads/writes:** writes `TokenTable` (new token row), reads
  `DenylistTable` (quarantine check), writes `RateLimitTable`
  (per-email send-rate counter).
- **IAM:** `dynamodb:PutItem` / `UpdateItem` on `TokenTable` and
  `RateLimitTable`; `dynamodb:GetItem` on `DenylistTable`;
  `ses:SendEmail` (scoped to the SES verified-domain identity).
- **Behaviour:**
  1. Generate 32 bytes from `crypto.randomBytes`, base64url-encode →
     the magic-link token.
  2. Check the denylist (quarantine). If quarantined, return the same
     generic challenge object as a successful path (no enumeration
     leak — caller sees no difference).
  3. Race-safe rate-limit: conditional `UpdateItem` on
     `RateLimitTable` keyed by `email`; condition
     `attribute_not_exists(count) OR (count < :limit AND window_start
     > :cutoff)`. `ConditionalCheckFailedException` → silent skip
     > (caller gets the same response).
  4. Store `SHA-256(token)` (not the raw token) in `TokenTable` with
     TTL = `tokenTtlMinutes` minutes from now.
  5. Send the email via SES with the token in the URL **fragment**
     (Mandatory Mitigation 3): `https://{domain}/login/callback#token=…`.
  6. Set `event.response.publicChallengeParameters` and
     `privateChallengeParameters` so Cognito carries the
     `SHA-256(token)` through to `VerifyAuthChallengeResponse`.

### `VerifyAuthFn`

- **Trigger:** Cognito `VerifyAuthChallengeResponse`.
- **Reads/writes:** conditional `DeleteItem` on `TokenTable`.
- **IAM:** `dynamodb:DeleteItem` on `TokenTable`.
- **Behaviour:**
  1. Hash the submitted token; compare to the private challenge
     parameter `SHA-256(token)` using `crypto.timingSafeEqual` after
     equal-length normalisation.
  2. Conditional `DeleteItem` with
     `ConditionExpression: attribute_exists(token_hash)`. Atomic
     single-use enforcement — replay attempts (or two concurrent
     verify attempts) see one success and one
     `ConditionalCheckFailedException`.
  3. Either exception (timing mismatch, conditional fail, expired
     TTL row) is mapped to the same `answerCorrect: false` response.
     Replay/exists/expiry are indistinguishable to the caller.

## Signup mode (`props.signupMode`)

Federation-aware policy that gates self-registration. Owned by
`MagicLinkIdentity` because the policy is enforced inside its
`PreSignUpFn`; `MagicLinkAuthSite` does not reach across the
construct boundary to mutate Identity behaviour.

```typescript
interface MagicLinkIdentityProps {
  // ...
  /**
   * Sign-up policy enforced by PreSignUpFn.
   *
   * - 'open' (default for magic-link-only pools): anyone with an
   *   email matching allowedEmailDomains (or any email, if the list
   *   is empty) can request a magic link and self-register.
   * - 'admin-invite-only': the PreSignUpFn rejects every SignUp API
   *   call. The only way to create a user on this pool becomes
   *   AdminCreateUser. Existing users continue to receive magic
   *   links; new self-registration is blocked at the Cognito
   *   boundary, not at the application layer.
   *
   * REQUIRED when federationEnabled: true — the open-registration
   * default would let strangers self-register into a B2B pool that
   * federation is supposed to gate, and the construct fails synth
   * with a clear message rather than silently inheriting 'open'.
   */
  signupMode?: "open" | "admin-invite-only";
}
```

Behaviour matrix:

| `federationEnabled` | `signupMode` default | Synth-time check                                                              |
| ------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `false`             | `'open'`             | No check; consumer may set `'admin-invite-only'` explicitly                   |
| `true`              | **required**         | Error if unset: "federation-enabled pools must declare signupMode explicitly" |

The construct sets `RuntimeEnv.SIGNUP_MODE` on `PreSignUpFn` at
synth time; no post-construction setters, no reaching across into
the Identity from `MagicLinkAuthSite`. `allowedEmailDomains: []`
keeps its semantics ("no domain restriction") and applies independently
of `signupMode` — a consumer wanting both an invite-only B2B pool
and a domain filter sets both together.

The B2B-pool threat model that motivates `'admin-invite-only'` is in
[`07-cdk-changes-from-trellis.md § Signup-mode policy for
federation-adjacent use`](07-cdk-changes-from-trellis.md#signup-mode-policy-for-federation-adjacent-use).

## DynamoDB tables

Three tables, all PAY_PER_REQUEST, PITR enabled, `RemovalPolicy.RETAIN`:

### `TokenTable`

```typescript
new dynamodb.Table(this, "TokenTable", {
  partitionKey: { name: "token_hash", type: STRING },
  billingMode: PAY_PER_REQUEST,
  timeToLiveAttribute: "expires_at",
  pointInTimeRecovery: true,
  removalPolicy: RETAIN,
});
```

Key: `SHA-256(token)` (base64url). The raw token is **never stored**,
so a leaked table snapshot does not yield working magic links.

Attributes per row:

- `token_hash` (PK)
- `expires_at` (TTL — seconds since epoch, 15 min default)
- `email` (the address the token was sent to — read on verify to
  identify the user)
- `created_at` (audit forensic field)

### `RateLimitTable`

```typescript
new dynamodb.Table(this, "RateLimitTable", {
  partitionKey: { name: "bucket_id", type: STRING },
  billingMode: PAY_PER_REQUEST,
  timeToLiveAttribute: "expires_at",
  pointInTimeRecovery: true,
  removalPolicy: RETAIN,
});
```

Key: `bucket_id` is a composite of `email + window` (or `email +
sourceIp + window` for the PreSignUp rate limit). 15-minute TTL.

### `DenylistTable`

```typescript
new dynamodb.Table(this, "DenylistTable", {
  partitionKey: { name: "email_hmac", type: STRING },
  billingMode: PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RETAIN,
});
```

Key: HMAC-SHA-256 of the lowercased email, keyed by the `HmacKey`
secret (so an attacker who reads the table cannot trivially enumerate
quarantined addresses). No TTL — rows persist until manually cleared.

## SES domain identity + DKIM + SPF + DMARC

`MagicLinkIdentity` provisions an SES `EmailIdentity` for the domain
derived from `props.sesIdentitySender`. DKIM signing is enabled; the
CDK construct emits three DKIM tokens (`dkimDnsTokenName1..3`,
`dkimDnsTokenValue1..3`) which the construct publishes as Route 53
`CNAME` records (`DkimCname1`, `DkimCname2`, `DkimCname3`) on the
consumer-supplied hosted zone.

**Synth-time domain check.** The construct validates at construction
time that the domain of `props.sesIdentitySender` matches, or is a
subdomain of, `props.hostedZone.zoneName`. The check has access to
both values at construct-construction (they're plain string props,
no token resolution required) and fails with a clear message
otherwise:

```typescript
const senderDomain = props.sesIdentitySender.split("@")[1];
const zone = props.hostedZone.zoneName;
const matches = senderDomain === zone || senderDomain.endsWith(`.${zone}`);
if (!matches) {
  throw new Error(
    `sesIdentitySender domain '${senderDomain}' must match or be a ` +
      `subdomain of the hosted zone '${zone}'. Without the match, ` +
      `DKIM / SPF / DMARC records cannot be published into the zone ` +
      `and SES verification will fail.`,
  );
}
```

Catches the most common misconfiguration (sender on a different
domain than the hosted zone the construct can write to) at synth
rather than at SES verification failure later.

In addition:

- **SPF TXT** record on the apex of the SES domain:
  `v=spf1 include:amazonses.com ~all`. Soft-fail (`~all`) leaves a
  consumer's existing SPF intact when other senders also need to send
  for the domain; consumers who want hard-fail can override at the
  zone level.
- **DMARC TXT** record at `_dmarc.{domain}`:
  `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@{domain}`. The
  `p=quarantine` policy is the design minimum; `p=reject` is the
  consumer's escalation.

DKIM-drift detection (the day-2 risk where someone removes the
CNAMEs and SES silently keeps sending unsigned mail) is the
consumer's responsibility — see
[`09-operational-notes.md § DKIM drift detection`](09-operational-notes.md#dkim-drift-detection).

## The bounce-handler circuit breaker

The bounce handler is the most operationally important Lambda in
`MagicLinkIdentity`. It is not just an alarm source — it is the
**circuit breaker** that stops SES re-sends to known-bad addresses.

Wiring:

```typescript
this.bounceTopic = new sns.Topic(this, "BounceTopic", {
  /* KMS */
});
// SES is configured (via the SES identity's event-destination setup)
// to publish bounce + complaint events to this topic.

const bounceHandlerFn = new lambda.Function(this, "BounceHandlerFn", {
  code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda-bundles/bounce-handler")),
  handler: "index.handler",
  runtime: lambda.Runtime.NODEJS_22_X,
  logRetention: logs.RetentionDays.ONE_MONTH,
});
this.bounceTopic.addSubscription(new snsSubscriptions.LambdaSubscription(bounceHandlerFn));

// IAM: scoped to this pool only — no wildcards.
bounceHandlerFn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminDisableUser"],
    resources: [this.cognitoPool.userPoolArn],
  }),
);

this.denylistTable.grantWriteData(bounceHandlerFn);
hmacSecret.grantRead(bounceHandlerFn);
```

Handler behaviour:

1. On hard bounce or complaint, HMAC the email address (with the
   `HmacKey` secret) and write a `DenylistTable` row.
2. If the email maps to a known Cognito user, set
   `custom:email_quarantined=true` via
   `AdminUpdateUserAttributes` and disable the user via
   `AdminDisableUser`.
3. Emit the `sesBounceRate` / `sesComplaintRate` metrics (see
   [`08-metrics.md`](08-metrics.md)).

`CreateAuthFn` reads the denylist **before** calling SES. Quarantined
addresses get the same generic challenge object as other failures —
no enumeration leak.

## HMAC secret (`HmacKey`)

A 64-character secret in Secrets Manager, `RemovalPolicy.RETAIN`,
auto-generated. Used by:

- the bounce handler (hashing emails before they land in the
  `DenylistTable` and before they appear in CloudWatch metric
  dimensions).

Not used by the three `CUSTOM_AUTH` triggers — they don't store
emails in derived form.

## Consumer-supplied `preTokenGeneration` / `postConfirmation`

Optional. When provided, the construct:

1. Validates the Lambda is in the **same AWS account and same region**
   as the `MagicLinkIdentity` construct. Cross-account / cross-region
   trigger ARNs are a confused-deputy vector and rejected at synth
   time.
2. Wires the function as the corresponding Cognito trigger.
3. Grants Cognito permission to invoke it.
4. Surfaces the reference back as `identity.preTokenGeneration` /
   `identity.postConfirmation`.

The construct does **not** grant any IAM permissions to the
consumer's Lambda. The consumer's stack is responsible for the
execution role and the policies. See
[`06-trigger-hooks.md`](06-trigger-hooks.md) for the trust model and
recipes.

## CloudFormation outputs

The construct does not emit `CfnOutput`s itself — the consumer's
stack decides what to expose. Consumers typically `CfnOutput` the
following for downstream IaC:

- `identity.cognitoPool.userPoolId`
- `identity.cognitoPool.userPoolArn`
- The website client's ID (from `MagicLinkAuthSite.websiteClient`).

## IAM-grants summary

| Resource         | Grant                                                    | Grantee                                                            |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `TokenTable`     | `grantWriteData` (`PutItem`, `UpdateItem`, `DeleteItem`) | `CreateAuthFn`, `VerifyAuthFn`                                     |
| `RateLimitTable` | `grantWriteData`                                         | `PreSignUpFn`                                                      |
| `RateLimitTable` | `grantReadWriteData`                                     | `CreateAuthFn`                                                     |
| `DenylistTable`  | `grantReadData`                                          | `CreateAuthFn`                                                     |
| `DenylistTable`  | `grantWriteData`                                         | `BounceHandlerFn`                                                  |
| `HmacKey` secret | `grantRead`                                              | `BounceHandlerFn`                                                  |
| Cognito pool     | scoped `AdminUpdateUserAttributes`, `AdminDisableUser`   | `BounceHandlerFn`                                                  |
| SES identity     | `ses:SendEmail`                                          | `CreateAuthFn` (via L2 SES integration on the pool's email config) |

No wildcards. Every grant is the minimum the handler needs.

## Encryption

The construct does **not** provision a customer-managed KMS key. Each
at-rest boundary it owns uses the relevant service's default
encryption (AWS-owned / AWS-managed keys):

| Resource                                       | Default encryption                                             |
| ---------------------------------------------- | -------------------------------------------------------------- |
| DynamoDB tables (Token / RateLimit / Denylist) | DynamoDB default at-rest encryption (AWS-owned key)            |
| Secrets Manager `HmacKey`                      | Secrets Manager default (`aws/secretsmanager` AWS-managed key) |
| SNS bounce topic                               | SNS default (AWS-managed key)                                  |
| SES at-rest                                    | Managed by SES; not a consumer-tunable surface                |

There is no `useAwsManagedKey` prop and no construct-managed CMK.
Consumers who need customer-managed keys (cost, residency, or
organisational policy) reach the escape hatches
(`identity.tokenTable`, `identity.bounceTopic`, etc.) and reapply
encryption with their own key. A first-class CMK prop is a candidate
for a future version; it is not implemented today.

**TLS in flight:** all DynamoDB / SES / SNS / Cognito SDK calls go
over HTTPS.

## Replace-on-update traps

Cognito has a long list of pool properties that force a
_replace-on-update_ — CloudFormation creates a new pool, then deletes
the old. Under `RemovalPolicy.RETAIN`, the delete step fails and the
stack moves to `UPDATE_ROLLBACK_FAILED`; recovery is manual. The
construct pins logical IDs to defend against most accidental
replacement, but a consumer who changes one of the following props
on a deployed pool will hit this trap:

| Prop / property                            | Why it forces replacement                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signInAliases`                            | Cognito treats username-alias config as immutable; any change creates a new pool.                                                                                                        |
| `email` mutable / required status          | Changing the standard-attribute schema (in particular `email`'s `required` / `mutable` flags) forces replacement.                                                                        |
| Password policy field shape                | Adding or removing fields on `passwordPolicy` (vs adjusting values within an existing shape) forces replacement.                                                                         |
| `customAttributes` _additions_             | Cognito custom attributes cannot be added to an existing pool. Plan ahead per the federation-migration discipline in [`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md). |
| `lambdaTriggers` execution-role changes    | Changing the execution role on any of the four `CUSTOM_AUTH` triggers cascades into a trigger-config change that, in some CFn paths, forces pool replacement.                            |

The pinned logical IDs (`Pool`, `TokenTable`, `RateLimitTable`,
`DenylistTable`, `SesIdentity`) defend against accidental
construct-internal replacement; the props in the table above are
consumer-supplied and require operational discipline. See
[`09-operational-notes.md § Cognito pool replacement — when you must,
when you mustn't`](09-operational-notes.md#cognito-pool-replacement--when-you-must-when-you-mustnt)
for the recovery story.

## Open questions

None at this level. The CMK-by-default decision is settled in
§ Encryption above; the signupMode-ownership decision is settled in
§ Signup mode; the advanced-security-default decision is settled in
§ Cognito Advanced Security mode.
