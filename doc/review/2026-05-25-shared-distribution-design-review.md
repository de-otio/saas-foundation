# 2026-05-25 — Shared-distribution design review

Combined security review + AWS-best-practices audit of
[`doc/vestibulum/shared-distribution/`](../vestibulum/shared-distribution/),
the v0.2 design for pure-data tenant onboarding on a shared Cognito
pool fronted by one CloudFront distribution with a multi-`aud`
Lambda@Edge.

Sources:

- Independent security-reviewer pass (focused on the design's threat
  model + cross-tenant isolation + admin-Lambda compromise).
- MCP queries against `aws-knowledge` and `aws-iac` for service-specific
  best practices (Lambda@Edge restrictions, Cognito refresh-token
  rotation, Function URL permission changes, CloudFront security
  headers, WAF on Cognito).

Findings table at the bottom.

## BLOCKERs (must be fixed before implementation)

### B1: `wrapPreTokenHandler` does not guard against `claimsToSuppress`

The wrapper enforces `custom:tenant_id` in `claimsToAddOrOverride` but
ignores `claimsToSuppress`. A consumer handler can set
`claimsToSuppress: ['custom:tenant_id']` while leaving overrides
intact. Cognito processes suppressions; final token lacks the claim;
edge silently refuses every request. Bug-invisible failure mode.

**Fix:** Wrapper asserts `claimsToSuppress` does not contain
`'custom:tenant_id'`, throws on violation. Property test required.

### B2: `tenantId` mutability + no uniqueness check on update

`updateTenant` allows changing `tenantId` without re-validating
uniqueness via the reservation table. Two tenants on different
subdomains could end up with the same `custom:tenant_id` claim,
breaking audit attribution and creating a downstream-authorization
escalation path if `tenantId` is used as a key elsewhere.

**Fix:** Make `tenantId` immutable after `createTenant`. Rename =
delete + recreate. Matches the existing `subdomain` immutability
constraint. Simpler than enforcing transactional update.

### B3: Reservation `attribute_not_exists` ignores TTL deletion lag

DDB's TTL deletion is eventually consistent (minutes to days, not
instant). A reservation row whose `expiresAt` has passed but which
DDB hasn't yet deleted still satisfies `attribute_exists`, blocking
legitimate retries for an indeterminate period.

**Fix:** Change the condition to
`'attribute_not_exists(#k) OR #exp < :now'` where `:now` is the
current epoch. Atomicity is preserved.

### B4 (MCP): Lambda@Edge does not support environment variables

[AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)
explicitly forbid environment variables on Lambda@Edge functions
(except reserved AWS-set ones). The design at
[`04-multi-aud-edge-check.md`](../vestibulum/shared-distribution/04-multi-aud-edge-check.md)
§ Bundle implications references `TENANT_PARENT`, `TENANT_PATTERN`,
`POOL_ISSUER` as env vars baked at synth time — but Lambda@Edge will
reject deployment with env vars set. CDK's `EdgeFunction` construct
has an explicit `removeInEdge` flag and will throw at synth.

**Fix:** Bake config values directly into the bundle's TypeScript
source via the bundle pipeline. The bundle generator reads the
construct's synth-time props and emits a module like:

```typescript
// generated/edge-config.ts (committed to lambda-bundles/, hashed)
export const TENANT_PARENT = 'tenants.example.com';
export const TENANT_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
export const POOL_ISSUER = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_xxxxx';
```

The bundle hash (already in `lambda-bundles.lock.json`) covers the
generated values; changing tenant parent / pool ID at synth time
produces a new hash and explicit reviewer ack. This is how the
prototype's edge function already handled this; the design just
didn't document it correctly.

### B5 (MCP): Cognito refresh-token rotation incompatible with `REFRESH_TOKEN_AUTH`

[AWS docs](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
state that refresh-token rotation (a security best practice) is
**incompatible** with the `REFRESH_TOKEN_AUTH` auth flow. The design's
`createUserPoolClient` config at
[`03-tenant-onboarding.md`](../vestibulum/shared-distribution/03-tenant-onboarding.md)
§ `createTenant` flow specifies
`ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']`,
which would prevent enabling rotation.

**Fix:** Remove `ALLOW_REFRESH_TOKEN_AUTH` from `ExplicitAuthFlows`.
Enable refresh-token rotation (`RefreshTokenRotation.feature =
ENABLED`) with a 60-second `RetryGracePeriodSeconds`. The
`auth-verify` Function URL refresh path uses the
`GetTokensFromRefreshToken` API (not `InitiateAuth` with
`REFRESH_TOKEN_AUTH`). Update the
[`06-trigger-handlers.md`](../vestibulum/shared-distribution/06-trigger-handlers.md)
§ `auth-verify` section accordingly.

## HIGH (should fix before publish)

### H1: Host header trailing-dot bypass

`extractTenantSubdomain` doesn't strip the trailing dot from RFC-1035
FQDN form (`acme.tenants.example.com.`). Browsers don't usually send
it but HTTP clients can. Fail-closed but produces unhelpful denials.

**Fix:** `hostNoPort.replace(/\.$/, '')` after lowercase. Add test
cases for trailing-dot Host (with and without port). Also normalise
`TENANT_PARENT` at bundle-generation time.

### H2: WAF rules absent for the shared CloudFront distribution

The design mentions WAF misconfiguration as a blast-radius row but
doesn't specify minimum rules. For a multi-tenant distribution, no
rate limiting at the edge means an attacker can amplify floods across
N subdomains, driving up Lambda@Edge cost without authentication.

**Fix:** Add a WAF section to
[`07-security-and-isolation.md`](../vestibulum/shared-distribution/07-security-and-isolation.md)
specifying minimum rules:

1. Per-IP rate limit at CloudFront (1000 req / 5 min default).
2. Request-size limit (defense-in-depth for Lambda@Edge's 1 MB cap).
3. AWS Managed Rules: `AWSManagedRulesCommonRuleSet` and
   `AWSManagedRulesKnownBadInputsRuleSet`.
4. Optional geographic restriction (EU-residency posture).

Expose `wafWebAcl` as a construct prop; consumer can override
defaults. Default web ACL is created if not provided.

### H3 (MCP): Cognito user pool WAF web ACL absent

[AWS docs](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-waf.html)
support associating a WAF web ACL **directly with the user pool**,
inspecting requests to hosted UI, managed login, and public API
operations (`SignUp`, `InitiateAuth`, `ConfirmSignUp`, etc.). The
shared-pool design is exposed to credential stuffing via direct
Cognito API calls (bypassing CloudFront entirely). The CloudFront-
side WAF doesn't help here.

**Fix:** Construct creates a WAF web ACL associated with the user
pool itself with at minimum a per-IP rate-limit rule for
`InitiateAuth` and `SignUp`. Document in
[`07-security-and-isolation.md`](../vestibulum/shared-distribution/07-security-and-isolation.md)
the two-layer WAF posture (CloudFront-side + Cognito-side).

### H4 (MCP): CloudFront response headers not specified

The design doesn't mention HSTS, CSP, frame-options, or other browser
security headers. For login pages served from CloudFront, this is
table-stakes.

**Fix:** Add a CloudFront Response Headers Policy with:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy` (configurable; default tight enough for the
  login flow's static pages)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy: default-disabled`

Expose as `responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy`
construct prop with the defaults above. Document in 04.

### H5: Admin Lambda audit logging not real-time alerting

The design says "audit log records the update call; SIEM watches for
unexpected allowlist changes" — but does not specify format,
destination, or alarm. Attacker has the full token validity window
(60 min ID, 30 d refresh) before detection.

**Fix:** Admin Lambda emits structured CloudWatch Logs entries for
every mutating action (`createTenant`/`updateTenant`/`deleteTenant`)
including caller IAM identity from the Function URL request context.
Metric Filter + CloudWatch Alarm fires on `updateTenant`/`deleteTenant`
with threshold > 0. Specifically
`Vestibulum/SharedDistribution/AllowlistChanged` metric emitted when
`updateTenant` changes `allowedEmailDomains`. Pulled into
[`08-observability-and-audit.md`](../vestibulum/shared-distribution/08-observability-and-audit.md)
(new file).

### H6: JWKS 15-min TTL stale-key window + availability tail

Two issues conflated:

1. **Stale-key acceptance window.** Up to 15 min after Cognito rotates
   a key out of JWKS, edge containers with cached JWKS will accept
   tokens signed with that key.
2. **Availability tail.** Cache eviction on fetch errors (per
   `TtlCache` design) means transient JWKS endpoint failures cause
   all auth to fail until recovery. Fail-closed but full blast radius.

**Fix:** Document the 15-min window as an explicit accepted risk.
Explicitly assert at cache refresh: new JWKS set fully replaces old
(no union). Expose `jwksTtl?: Duration` (default 15 min) as a
construct prop for high-security consumers. For the availability
tail, consider a separate "last-known-good" fallback with a hard
cap (e.g. 24 h beyond `jwksTtl`) and aggressive alarm rather than
strict fail-closed — but this is a v0.3 enhancement, not v0.2.

### H7: Idempotency key not scoped to tenant

The idempotency table is keyed on `idempotencyKey` alone. Collision
between two callers (UUID reuse, copy-paste) → cross-tenant info leak
on the second call's response.

**Fix:** Composite key: `PK = idempotencyKey#subdomain` (or
`idempotencyKey#tenantId`). On hit, verify stored response's
`subdomain` and `tenantId` match current request; mismatch → 409
Conflict.

### H8 (MCP): Function URL Oct 2025 permission change

[AWS docs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
state that starting October 2025, new Function URLs require BOTH
`lambda:InvokeFunctionUrl` AND `lambda:InvokeFunction` permissions
(currently only the former). Cross-account also requires both
identity-based AND resource-based policies.

**Fix:** Construct's grant for `adminInvokePrincipal` includes both
permissions. Document the cross-account caveat. Add IAM Access
Analyzer to the ops runbook as recommended.

## SIGNIFICANT (should fix soon)

### N1: `deleteTenant` 60-min token-validity window not explicit

After `deleteTenant`, refresh tokens against the deleted client fail
at Cognito, but already-issued ID tokens remain valid at the edge for
up to 60 min (the `IdTokenValidity` setting).

**Fix:** Document the window in `03` `deleteTenant`. Add optional
`revokeActiveSessions: boolean` flag that iterates users and calls
`AdminUserGlobalSignOut` before client deletion. Note consumer
alternative of reducing `IdTokenValidity` to 5 min for high-churn
deployments.

### N2: `TtlCache` race between resolution and value read

Narrow microtask-ordering race: third caller after promise resolution
but before `.then()` runs sees `undefined` cast as `T`. For
`loadClientConfig`, this returns null → fail-closed but transient
auth failures under load.

**Fix:** Refactor `getOrLoad` to always check `entry.promise` first,
regardless of expiry. If pending → return promise. Otherwise → return
resolved `value`. Eliminates the dual-path `promise ??
Promise.resolve(value)` race.

### N3: Cross-tenant bounce DoS via targeted hard-bounce

Bounce-handler quarantine is global on `sub`. Attacker who controls
tenant A signs up victim's email, triggers magic link, hard-bounces.
Victim is quarantined across all tenants. Documented as intentional
(SES sender reputation) but the attack vector isn't.

**Fix:** Document explicitly in `07-security-and-isolation.md` as a
known cross-tenant DoS vector with mitigation guidance. Recommend
per-tenant bounce counters keyed on `(sub, clientId)` for v0.3 with
operator-level unquarantine. For v0.2: document only.

### N4: DDB encryption mode not specified

`ClientConfig` table encryption defaults to `AWS_OWNED` (no KMS
visibility). `allowedEmailDomains` is business-sensitive.
`MagicLinkTokens` contains short-lived secrets.

**Fix:** Default both tables to `AWS_MANAGED` (DDB-owned KMS key
visible in console). Expose `tableKmsKey?: kms.IKey` construct prop
for customer-managed encryption. Costs nothing at runtime; preserves
migration path.

### N5: Reconciler frequency too low; compensation failures not metricked

Reconciler runs daily; 24-hour sustain window on alarm. Crash-loops
could accumulate orphans invisibly.

**Fix:** Reconciler runs hourly (`rate(1 hour)`); alarm sustain 1 h.
Emit `Vestibulum/SharedDistribution/CompensationTriggered` metric
from the compensation step itself, in real time. Reconciler cost is
~1–5 s per run.

### N6: Edge accepts `access` token_use but custom claim only in `id` tokens

Edge's `token_use` check accepts both `id` and `access`. Under V1
PreTokenGeneration trigger, `custom:tenant_id` is only in `id`
tokens, so access tokens always fail the structural check. Dead
security code → maintenance hazard.

**Fix:** Restrict edge `token_use` to `'id'` only. Comment why.
Future V2-trigger support gated behind an explicit prop.

### N7: Unknown `action` field not validated

If implementation has `switch` without `default`, unknown actions
return 200/empty. Info-leak (probing valid actions) + missing error
path.

**Fix:** Use Zod (or equivalent) discriminated-union parse with
strict `unknown action` rejection. Unrecognized → 400
`{error: 'UNKNOWN_ACTION'}`. Exhaustive switch with `default: never`.

### N8 (MCP): IAM Access Analyzer not in ops runbook

AWS recommends IAM Access Analyzer for monitoring Function URL access
patterns and detecting permission drift.

**Fix:** Document in `08-observability-and-audit.md` as recommended
ops integration. No construct change.

## Notes (worth knowing, no doc change needed)

- **Cookie scoping vs. malicious browser extensions.** Adequately
  addressed by structural edge check (layer 2).
- **Multiple Host headers, IPv6 brackets.** CloudFront normalises both;
  no edge concern.
- **Refresh token against deleted client.** Cognito returns
  `ResourceNotFoundException`; existing design assumption correct.
- **Function URL Host header for `auth-verify` / `auth-signout`.**
  These Function URLs must be invoked **through CloudFront** (as
  origin/behaviour pair), never directly. Direct invocation breaks
  Host-based tenant resolution. Document in
  [`06-trigger-handlers.md`](../vestibulum/shared-distribution/06-trigger-handlers.md)
  as a constraint.

## Findings table

| ID  | Severity    | Title                                                                                | File / section                                              |
| --- | ----------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| B1  | BLOCKER     | `wrapPreTokenHandler` does not guard `claimsToSuppress`                              | 06 § wrapper                                                |
| B2  | BLOCKER     | `tenantId` mutability allows duplicate claims                                        | 03 § updateTenant                                           |
| B3  | BLOCKER     | Reservation TTL condition doesn't account for DDB TTL deletion lag                   | 03 § createTenant reservation                               |
| B4  | BLOCKER     | Lambda@Edge env vars unsupported — bake into bundle                                  | 04 § bundle implications                                    |
| B5  | BLOCKER     | Cognito refresh-token rotation incompatible with `REFRESH_TOKEN_AUTH`                | 03 § createUserPoolClient, 06 § auth-verify                 |
| H1  | HIGH        | Trailing-dot Host bypass in subdomain extraction                                     | 04 § extractTenantSubdomain                                 |
| H2  | HIGH        | WAF rules absent for shared CloudFront                                               | 07 (new section)                                            |
| H3  | HIGH        | Cognito user-pool WAF absent                                                         | 07 (new section), 01                                        |
| H4  | HIGH        | CloudFront security headers not specified                                            | 04, 02 (new prop)                                           |
| H5  | HIGH        | Admin Lambda audit logging not real-time                                             | 08 (new file)                                               |
| H6  | HIGH        | JWKS 15-min stale window + availability tail                                         | 04 § JWKS posture, 02 (new prop)                            |
| H7  | HIGH        | Idempotency key not scoped to tenant                                                 | 03 § idempotency                                            |
| H8  | HIGH        | Function URL Oct 2025 permission change                                              | 02 § principal, 03 § Function URL contract                  |
| N1  | SIGNIFICANT | `deleteTenant` 60-min token window not explicit                                      | 03 § deleteTenant                                           |
| N2  | SIGNIFICANT | `TtlCache` resolution-vs-read race                                                   | 06 § TtlCache                                               |
| N3  | SIGNIFICANT | Cross-tenant bounce DoS                                                              | 07 (note)                                                   |
| N4  | SIGNIFICANT | DDB encryption mode default                                                          | 02 (new prop), 03                                           |
| N5  | SIGNIFICANT | Reconciler frequency + compensation metrics                                          | 03 § reconciler                                             |
| N6  | SIGNIFICANT | Edge `token_use` access path is dead code                                            | 04 § sequence                                               |
| N7  | SIGNIFICANT | Unknown admin `action` not validated                                                 | 03 § Function URL contract                                  |
| N8  | SIGNIFICANT | IAM Access Analyzer not in ops runbook                                               | 08 (new file)                                               |

Five BLOCKERs, eight HIGHs, eight SIGNIFICANTs. All integrated into
the design docs in this commit; implementation plan at
[`../vestibulum/shared-distribution/09-implementation-plan.md`](../vestibulum/shared-distribution/09-implementation-plan.md).
