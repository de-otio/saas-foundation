# Shared-distribution mode — pure-data tenant onboarding

Status: **implemented** in `@de-otio/vestibulum` and
`@de-otio/vestibulum-cdk` (v0.2).

This subfolder describes the topology that lets a consumer onboard a
new tenant to a running deployment **without deploying any
infrastructure** — no `cdk deploy`, no new CloudFront, no new
Lambda@Edge, no Route 53 changes per tenant. Onboarding is two AWS
SDK calls: `CreateUserPoolClient` on the shared Cognito pool, and
`PutItem` on a `ClientConfig` DDB table.

## Why a separate design

The previous "shared-pool multi-tenancy" prototype documented in
[`../08-shared-pool-multi-tenancy.md`](../08-shared-pool-multi-tenancy.md)
took a different shape: **N `MagicLinkAuthSite` instances per shared
`MagicLinkIdentity`**, each AuthSite carrying its own CloudFront,
Lambda@Edge, app client, and S3 bucket. Onboarding required a
`cdk deploy` per tenant. The prototype itself flagged a
**shared-distribution mode** as the alternative, but listed it as out
of scope: triggered only when tenant count exceeds ~50 or the
N-distributions model becomes operationally painful.

The constraint "pure-data onboarding" makes shared-distribution mode
the right shape from day one, not a future migration. The prototype's
N-CloudFront design encodes choices (per-tenant pinned `aud`, per-tenant
edge function, per-tenant CFN custom resource) that don't apply.
The trigger-handler changes (`ClientConfig` table + per-client
plumbing) **do** apply and are carried forward.

## What's deployed once, what's data per tenant

**Deployed once via CDK, per identity:**

- CloudFront distribution with wildcard alternate name (`*.tenants.example.com`)
- Wildcard ACM cert in us-east-1
- One Lambda@Edge `check-auth` (multi-`aud`, Host-aware)
- One S3 bucket for static login pages (or none — pages served from CloudFront cache only)
- Shared Cognito user pool
- Trigger Lambdas: `PreSignUp`, `CreateAuthChallenge`, `VerifyAuthChallengeResponse`, `DefineAuthChallenge`, `PreTokenGeneration` (new for this mode)
- Function URLs for `auth-verify` and `auth-signout` (Host-aware)
- `ClientConfig` DDB table
- `MagicLinkTokens` DDB table
- SES identity + bounce handler
- **Admin Lambda** exposing tenant lifecycle (`POST/DELETE/PUT /tenants`) via IAM-auth'd Function URL
- Route 53 wildcard A-record alias to the CloudFront distribution (or a wildcard CNAME if the consumer manages DNS)

**Data per tenant (no CDK):**

- One Cognito app client on the shared pool (created via SDK by the admin Lambda)
- One `ClientConfig` row keyed on that `clientId` (written via SDK by the admin Lambda)

## Numbered docs

Read 01 first; the rest are sectional and can be read in any order.

- [`01-architecture.md`](01-architecture.md) — topology, what's deployed once vs. what's data, comparison with the prototype's N-CloudFront design, blast-radius story, scaling ceilings.
- [`02-construct-api.md`](02-construct-api.md) — new construct `SharedDistributionIdentity` as a sibling of `MagicLinkIdentity`, exported helpers, what `MagicLinkAuthSite` is and isn't in this mode.
- [`03-tenant-onboarding.md`](03-tenant-onboarding.md) — the pure-data flow, admin Lambda Function URL shape, request/response schema, validation rules, idempotency, deletion semantics.
- [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) — the load-bearing security change: Host ↔ `custom:tenant_id` structural binding, `iss` pinning, why no explicit `aud` allowlist, JWKS caching, fail-closed semantics, required property tests.
- [`05-wildcard-infra.md`](05-wildcard-infra.md) — wildcard cert + wildcard DNS, reserved subdomains, single-level wildcard limitation, cert rotation, ops runbook.
- [`06-trigger-handlers.md`](06-trigger-handlers.md) — `PreSignUp`, `CreateAuthChallenge`, and new `PreTokenGeneration` reading from `ClientConfig`. Fail-closed posture. `TtlCache` helper. Carries forward from the prototype's Change 1.
- [`07-security-and-isolation.md`](07-security-and-isolation.md) — tenant-isolation properties, blast-radius differences vs. the prototype, hard-isolation escape hatch (separate identity), cross-tenant rate-limit and bounce-quarantine semantics, two-layer WAF posture (CloudFront-side + Cognito-side).
- [`08-observability-and-audit.md`](08-observability-and-audit.md) — audit-log format, CloudWatch metrics catalogue, built-in alarms (real-time on `AllowlistChanged` etc.), edge log-group exposure, recommended ops integrations (IAM Access Analyzer, CloudTrail join).
- [`09-implementation-plan.md`](09-implementation-plan.md) — maximally-parallel implementation plan for v0.2 shared-distribution mode, six phases, agent-per-phase concurrency sized for the host machine, 80% coverage threshold, MCP consultation checkpoints.

## Out of scope even in this design

- **Per-tenant CloudFront customisation** (different cache rules, different WAF). Single distribution = single config. Tenants needing this contract for the hard-isolation variant (a separate `SharedDistributionIdentity` or single-tenant `MagicLinkIdentity`).
- **Tenant provisioning UI / customer self-service portal.** The admin Lambda's Function URL is IAM-auth'd; building a self-service web UI on top is a consumer concern, not vestibulum's.
- **Multi-region tenant routing.** Single distribution, single pool, single region (per the EU-residency posture). A second region means a second `SharedDistributionIdentity`.
- **Federation per tenant.** Shared-distribution + per-tenant external IdPs (SAML/OIDC) is doable but out of scope for v0.2; deferred to whenever federation lands on shared-pool.
- **Tenant subdomain renaming.** Once a tenant is onboarded at `acme.tenants.example.com`, that's their cookie domain. Renaming means logout + new app client + new row.

## Decisions log

The design questions originally flagged across the per-topic docs
have been resolved. Recorded here for quick reference; per-doc
sections carry the reasoning.

| Question                                                              | Decision                                                                                          | Doc        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- |
| Sibling construct vs. mode prop on `MagicLinkIdentity`                | **Sibling** (`SharedDistributionIdentity`)                                                        | 02         |
| Prop overlap with `MagicLinkIdentity`                                 | **Duplicate verbatim**, both extend internal `BaseIdentityProps`                                  | 02         |
| `token_use` at the edge                                               | **`id` token**, V1 PreTokenGeneration trigger format                                              | 04         |
| Refresh-token flow location                                           | **`auth-verify` Function URL** (Host-aware), not edge                                             | 04, 06     |
| Edge log aggregation                                                  | **Expose** `identity.edgeLogGroups`, no built-in aggregation                                      | 04         |
| Cert SAN list                                                         | **Include parent** by default for landing page; overridable                                       | 05         |
| DNSSEC                                                                | **Not enabled by default**; documented as recommended posture                                     | 05         |
| IDN / punycode tenant subdomains                                      | **Defer to v0.3+**                                                                                | 05         |
| PreTokenGeneration customisation                                      | **Replace-the-trigger** with `wrapPreTokenHandler` enforcing `custom:tenant_id` contract           | 02, 06     |
| Bundle layout                                                         | **Two parallel sets** (single-tenant + shared-distribution)                                       | 06         |
| Sharding past 1,000 tenants                                           | **Subdomain-based** (one identity per parent subdomain)                                           | 07         |
| Subdomain reservation race in `createTenant`                          | **`TransactWriteItems` against a Reservations table** with 60s TTL                                | 03         |
| Compensation reconciler                                               | **Daily EventBridge-scheduled Lambda** emitting orphan metrics; no auto-delete                    | 03         |
| Admin Function URL CORS                                               | **Empty `AllowOrigins` by default**; explicit opt-in, refuse `*`                                  | 03         |
| Lambda@Edge env-var ban                                               | **Bake config into bundle at synth time**; generated `edge-config.ts` module                       | 04         |
| Cognito refresh-token rotation                                        | **Enabled** with 60s grace; `ALLOW_REFRESH_TOKEN_AUTH` removed; refresh uses `GetTokensFromRefreshToken` | 03, 06     |
| Function URL Oct 2025 permission                                      | Grant both `lambda:InvokeFunctionUrl` AND `lambda:InvokeFunction`; conditioned via `InvokedViaFunctionUrl`  | 03         |
| CloudFront WAF                                                        | **Default web ACL** with rate-limit, AWS-managed CommonRuleSet, KnownBadInputs; consumer-overridable        | 07         |
| Cognito-pool WAF                                                      | **Direct attachment** to the user pool with rate-limit on InitiateAuth/SignUp                              | 07         |
| CloudFront security headers                                           | **Hardened Response Headers Policy** by default (HSTS preload, CSP, X-Frame-Options DENY, etc.)            | 04         |
| `tenantId` immutability                                               | **Immutable post-creation**; rename = delete + recreate                                                    | 03         |
| Reservation TTL race                                                  | Condition becomes `attribute_not_exists(#k) OR #exp < :now`                                                | 03         |
| Idempotency key scope                                                 | Composite `idempotencyKey#subdomain`; mismatch → 409                                                       | 03         |
| `wrapPreTokenHandler` suppression guard                               | Wrapper checks `claimsToSuppress` does not contain `custom:tenant_id`                                      | 06         |
| Edge `token_use`                                                      | `'id'` only; access-token path removed (would have been dead code)                                         | 04         |
| Subdomain extraction trailing dot                                     | Strip RFC-1035 trailing dot; tests added                                                                   | 04         |
| `TtlCache` resolution race                                            | Always store the promise; never an unwrapped value                                                         | 06         |
| DDB encryption mode                                                   | Default `AWS_MANAGED` (not `AWS_OWNED`); customer KMS via `tableKmsKey` prop                               | 03, 02     |
| Reconciler frequency                                                  | **Hourly** (not daily); compensation-failure metric in real time                                            | 03         |
| Admin Lambda audit logging                                            | Structured CloudWatch Logs + real-time alarms on mutating ops                                              | 08         |
| `deleteTenant` token window                                           | Documented 60-min ID-token validity window; optional `revokeActiveSessions` flag                            | 03         |
| Unknown admin action handling                                         | Zod discriminated-union with strict rejection; 400 `UNKNOWN_ACTION`                                        | 03         |

The 21 decisions above are committed; see
[`../../review/2026-05-25-shared-distribution-design-review.md`](../../review/2026-05-25-shared-distribution-design-review.md)
for the underlying security + AWS-best-practices review.

## Implementation status

Implemented in v0.2. The runtime handlers live in
`packages/vestibulum/src/lambda/shared-distribution/`; the CDK
constructs (`SharedDistributionIdentity`, the admin Lambda, the
reconciler, the wildcard cert, the multi-`aud` edge function) live in
`packages/vestibulum-cdk/`. The single-tenant `MagicLinkIdentity` +
`MagicLinkAuthSite` path remains available alongside it.
