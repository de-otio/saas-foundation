# Initial design-pass review — 2026-05-24

Critical review of the design docs produced during the first full
design pass (~40 files, ~13,580 lines). Four review streams ran in
parallel: one per package (`foundation/`, `vestibulum/`,
`vestibulum-cdk/`) and a cross-package security review.

This is the **punch list** for resolving issues before any code lands.
Items are grouped by severity, then by theme. Three issues flagged at
the end of the design pass for explicit validation
(`audit retention`, `Prisma optional peer-dep`, `TenantResolver`
set) are validated up-front, then the comprehensive list follows.

## TL;DR

- **BLOCKERS (12)** — must resolve before code; six are
  architecture-level (layering, frozen-type location, bundle pipeline
  disconnect), six are concrete bugs in the docs (regex, IPv4
  allowlist gaps, missing IAM constraints, hidden costs).
- **HIGH security (3)** — audit-IAM enforcement, tenant-resolver
  trust model, `clientMetadata` provenance — all shape API design,
  cheaper to fix in the docs than in code.
- **SIGNIFICANT (29)** — surface-coherence, cost surprises, API
  inconsistencies, missing validation.
- **NITs (24)** — readability, naming, residual transplant drift.

The design is structurally sound — none of the BLOCKERs require
abandoning the package split or the frozen-type discipline. They
require **one cross-package architecture decision** (where do frozen
types live?) and a **handful of doc edits**.

## Validation of the three flagged decisions

### 1. Audit retention widening — **NOT VALIDATED**

The 7-year `error` floor is asserted without citation. Common
regulatory frames: SOC 2 = 1 year minimum, HIPAA = 6 years, SOX = 7
years (financials), PCI-DSS = 1 year, GDPR = upper bounds (storage
minimisation), not floors. A _generic_ SaaS foundation aimed at
DACH/EU SaaS workloads has no business defaulting to the SOX
maximum. GDPR's storage-minimisation principle argues for _shorter_
defaults; over-long retention is itself a compliance risk.

**Recommendation:** Lower defaults to `info` 30d / `warning` 180d /
`error` 400d. Per-deployment override (already well-designed) handles
regulated-vertical consumers who genuinely need more.

### 2. Prisma optional peer-dep — **NOT VALIDATED as currently designed**

The optional-peer pattern in `package.json` is correct, but the
runtime mechanics are not. If `PostgresAuditStore` /
`PrismaFeatureToggleStore` are re-exported from the package barrel
(`foundation/01-package-api.md` does this), the top-level
`import { PrismaClient } from '@prisma/client'` executes at module
load. Consumers who didn't install Prisma hit `MODULE_NOT_FOUND`
during process boot — no observable benefit from the optional peer.

**Recommendation:** Move Prisma-using classes to dedicated sub-path
exports (`@de-otio/saas-foundation/audit/prisma`,
`/feature-toggles/prisma`) that are _not_ re-exported from the
barrel. Add a CI gate forbidding top-level `from '@prisma/client'`
in `src/audit/` and `src/feature-toggles/` outside the prisma
sub-paths.

### 3. TenantResolver strategy set — **NOT VALIDATED**

Two distinct problems:

- **Scope creep.** Five strategies + `Composite` for v0.1, of which
  only two (`Subdomain`, `CustomDomain`) have a named consumer
  (trellis). `Header`, `Claim`, `PathPrefix` have no current
  consumer. Inverts the "ship if a consumer asks" discipline used
  elsewhere in the docs.
- **Security models per strategy not documented.** `Header` is
  client-spoofable; `PathPrefix` invites IDOR; `Subdomain` has
  subdomain-takeover concerns; `Composite`'s "first non-null wins"
  lets an untrusted header pre-empt a trusted subdomain. The
  security review flagged this as a HIGH-severity issue (H-2).

**Recommendation:** v0.1 ships `Subdomain` + `CustomDomain` +
`Composite` only, with explicit per-strategy security framing.
Header / Path / Claim move to a "candidate" section with
"first-asking-consumer ships it" disposition.

## BLOCKERS

### B-A — Architecture: where do frozen types live?

**Files:** `04-shared-vocabulary.md`, `03-package-relationships.md`,
`foundation/05-tenant-context.md`,
`foundation/07-logger-and-request-context.md`.

**Issue:** Three concrete symptoms of the same underlying problem:

1. `RequestContext` is in layer 1 (request-context) but contains a
   `TenantId` from layer 2 (tenant). Layer 1 cannot import from
   layer 2 per `03-package-relationships.md` § Cycle prevention —
   the very first frozen type breaks the layering rule.
2. `04-shared-vocabulary.md` line 336 says frozen types live under
   `packages/foundation/src/types/frozen/` and the CI fanout gate
   watches that path. But the per-module docs put types in
   `src/tenant/`, `src/audit/`, `src/request-context/`,
   `src/secrets/`. The CI gate will never fire on a real frozen-type
   diff.
3. The `Logger`'s child-binding from `RequestContext` involves layer
   1 reading layer 2 fields — same violation pattern.

**Suggested fix:** Move all frozen-set type _definitions_ to a
layer-0 `src/types/frozen/` module that every layer can import. Logic
lives in the per-module directories; types live with the CI gate.
Update `03-package-relationships.md` to add layer 0; update
per-module docs to import types from the central location.

### B-B — Bundle pipeline references handlers the runtime doesn't export

**Files:** `vestibulum-cdk/10-lambda-bundle-pipeline.md`,
`07-vestibulum-migration.md`.

**Issue:** The pipeline doc describes bundling eight handlers
(`createPreSignupHandler`, `createDefineAuthChallengeHandler`,
`createCreateAuthChallengeHandler`,
`createVerifyAuthChallengeResponseHandler`, `createBounceHandler`,
`createAuthVerifyHandler`, `createAuthSignoutHandler`,
`createEdgeCheckAuthHandler`) from `@de-otio/vestibulum`. The
standalone vestibulum runtime exports **none** of these — they
currently live in `vestibulum/lib/lambda-handlers/` and
`vestibulum/lib/lambda-edge/`, i.e., inside the CDK package. The
bundling story is unimplementable as designed.

**Suggested fix:** The vestibulum-migration plan (`07-`) must
explicitly include moving `lib/lambda-handlers/*` and
`lib/lambda-edge/*` into `packages/vestibulum/src/lambda/` and
adding the eight factory exports to vestibulum's `index.ts`. Without
this, the cross-package bundling story collapses to "vestibulum-cdk
bundles itself."

### B-C — Construct docs contradict bundle pipeline on Lambda construction

**Files:** `vestibulum-cdk/02-magic-link-identity.md`,
`vestibulum-cdk/04-magic-link-auth-site.md`,
`vestibulum-cdk/10-lambda-bundle-pipeline.md`.

**Issue:** The two construct deep-design docs use
`lambdaNodejs.NodejsFunction`. The pipeline doc explicitly says
`NodejsFunction` is **wrong** — it runs esbuild in the consumer's
synth process, defeating the bundle-and-hash-verify story. The
correct pattern is `lambda.Function` + `Code.fromAsset(bundlePath)`.

**Suggested fix:** Edit the two construct docs to use
`lambda.Function` + `Code.fromAsset` consistent with the pipeline.
"Bundled from the runtime source" stays correct; only the
constructor call changes.

### B-D — TenantId regex bug in both definitions

**Files:** `04-shared-vocabulary.md` line 42,
`foundation/05-tenant-context.md` line 207.

**Issue:** Both validators use `[\s -]` — a _character range_ from
space (0x20) to dash (0x2D), which matches whitespace plus
`!"#$%&'()*+,-`. Intent (per prose) is "no whitespace or control
chars." Tenant IDs like `acme!` or `acme'corp` would be rejected
spuriously.

**Suggested fix:** Use `[\s\x00-\x1f]` or `[\s\p{Cc}]` (with the
`u` flag). Pin the validator to one location (resolves with B-A so
the two don't drift again).

### B-E — IPv4 SSRF allowlist missing reserved blocks

**File:** `vestibulum/01-package-api.md` § Issuer probe, lines
332-340.

**Issue:** Missing from the deny list: `192.0.2.0/24` (TEST-NET-1),
`198.51.100.0/24` (TEST-NET-2), `203.0.113.0/24` (TEST-NET-3),
`240.0.0.0/4` (Class E reserved), `255.255.255.255/32` (limited
broadcast). The benchmarking comment is on the wrong line —
`192.0.0.0/24` is the Protocol Assignments block;
`198.18.0.0/15` is the benchmarking block.

**Suggested fix:** Add the five missing entries; fix the
benchmarking comment. Consider switching to an audited IP-CIDR
library rather than maintaining the list inline.

### B-F — `wafManagedRules` declared on the wrong construct props

**File:** `vestibulum-cdk/01-package-api.md` line 366.

**Issue:** The Web ACL is owned by `EdgeResources` (cross-region in
us-east-1). `MagicLinkAuthSiteProps` lists a `wafManagedRules` prop
that has no resource to apply to. The construct deep-design doc
(`04-magic-link-auth-site.md`) correctly omits it.

**Suggested fix:** Drop `wafManagedRules` from
`MagicLinkAuthSiteProps` in `01-package-api.md`.

### B-G — AWS Managed `ATPRuleSet` is paid; defaulted on without disclosure

**Files:** `vestibulum-cdk/01-package-api.md` line 458,
`vestibulum-cdk/03-edge-resources.md` line 113.

**Issue:** WAF Account Takeover Prevention is a paid managed-rule
group (monthly fee + per-request charges). Defaulting it on is a
non-trivial cost surprise. Worse, the doc maps `passwordField: /token`
to ATP — but the magic-link token is opaque random bytes (passwordless),
so ATP produces no useful signal while still billing.

**Suggested fix:** Drop ATPRuleSet from the default rule set. The
"compensating control for `LogOnly` Cognito risk config" claim is
removed with it. Document as an opt-in via prop if a consumer
wants it.

### B-H — Cognito Advanced Security `AUDIT` mode is paid; defaulted on without disclosure

**Files:** `vestibulum-cdk/01-package-api.md` line 451,
`vestibulum-cdk/02-magic-link-identity.md` line 89.

**Issue:** `LogOnly` requires `advancedSecurityMode: 'AUDIT'` or
`'ENFORCED'`. Both incur per-MAU charges past the small free tier.
Defaulting `AUDIT` on is a hidden recurring cost.

**Suggested fix:** Restore the per-MAU cost disclosure (it was in
the standalone vestibulum doc but dropped in transplant). Reframe as
"free _up to_ the Cognito Advanced Security free-tier MAU cap, paid
thereafter." Consider making `advancedSecurityMode` an opt-in prop
rather than default-on.

### B-I — `MagicLinkAuthSite` breaks construct boundary via private setter

**File:** `vestibulum-cdk/04-magic-link-auth-site.md` lines
391-395.

**Issue:** `MagicLinkAuthSite` calls `identity._setSignupMode(...)`
to inject behaviour into the Identity's `PreSignUpFn` after
construction. Identity's behaviour depends on whether/which AuthSite
attaches — contradicts the "Identity is stateful, deploy rarely"
lifecycle promise.

**Suggested fix:** Move `signupMode` onto `MagicLinkIdentityProps`.
The Identity owns the `PreSignUpFn`; the Identity should own the
policy that drives it.

### B-J — JWT verifier "try each pool" pseudocode produces noisy failures

**File:** `vestibulum/05-jwt-verification.md`, sample code lines
150-164.

**Issue:** The shown iteration pattern (`try { verify } catch { try
next }`) generates N−1 `invalid_signature` exceptions per legitimate
request when N pools are configured. The doc's prose says "more
efficient" alternatives exist but doesn't show the canonical
pattern: read the unverified `iss` to _select_ the verifier, then
let the verifier check signature (the verifier is bound to a pinned
JWKS, so `iss` is never trusted before signature).

**Suggested fix:** Replace the iteration sample with the
select-by-iss pattern. Explain the security property: `iss` is
trusted only after the matching verifier returns. Drop the
"try each verifier" prose entirely.

### B-K — `ClaimResolverInput.userAttributes`, `clientMetadata` drift between vocabulary and package-api

**Files:** `04-shared-vocabulary.md` lines 271-294,
`vestibulum/01-package-api.md` lines 689-744.

**Issue:** `04-shared-vocabulary.md` uses plain `Record<string,
string>`; `vestibulum/01-package-api.md` uses `Readonly<Record<...>>`.
`triggerSource: string` in `04-` lacks the `| (string & {})`
open-union sentinel. Frozen-set definitions drift between the two
docs that both claim canonical status. `ClaimResolverOutput` is
exported and forms part of the consumer contract but is not listed
as frozen.

**Suggested fix:** Make `04-shared-vocabulary.md` the verbatim
source of truth — the per-package doc quotes it. Add
`ClaimResolverOutput` to the frozen set (deployed Lambdas pass
inputs _and_ receive outputs from consumer callbacks; changing
either silently breaks deployed code).

### B-L — `setRequestContext` semantic conflict with frozen-set immutability

**Files:** `04-shared-vocabulary.md` lines 225-228,
`vestibulum/05-jwt-verification.md` lines 292-305.

**Issue:** `04-` says `RequestContext` is `Object.freeze`d at
construction; "mutating mid-request is heisenbug territory." But
vestibulum's JWT verification example does
`setRequestContext({...getRequestContext(), poolKey, principal})`
post-construction. If `setRequestContext` exists, the immutability
promise needs to be reframed (replacement vs mutation); if it
doesn't, the JWT design needs a different shape (e.g., principal
attached during initial construction via late-bound auth middleware
ordering).

**Suggested fix:** Reconcile in `04-` — state explicitly whether
`setRequestContext` exists and at what points it may be called
(e.g., "during the auth phase but never inside a handler"). Pick
one and update both docs.

## HIGH — security

### H-1. Audit log lacks IAM-enforced append-only

**Files:** `foundation/06-audit-log.md`,
`08-trellis-migration.md`.

**Threat:** `AuditStore.put` interface allows `PutItem`, but
nothing in the design prevents the same IAM principal from calling
`UpdateItem` / `DeleteItem`. An attacker with RCE on the API process
can silently delete audit rows covering their intrusion.

**Suggested fix:** (1) Document that the audit-table IAM grant must
be `PutItem`-only for the application role (no `UpdateItem`, no
`DeleteItem`). (2) Recommend DynamoDB Streams → S3 with Object Lock
as the immutable secondary. (3) Add a code-review gate: no
`UpdateItem` / `DeleteItem` calls in `DynamoAuditStore`. The
`AuditLog.emit` swallow-errors behaviour (foundation S15) compounds
this — fail-closed-on-write or dual-store should be the default for a
security event log.

### H-2. Tenant-resolver trust model not load-bearing in the API

**Files:** `foundation/05-tenant-context.md`,
`04-shared-vocabulary.md`.

**Threat:** Five resolver strategies have fundamentally different
trust properties. `Subdomain` and `Claim` are server-controlled
(verified); `Header` and `PathPrefix` are client-controlled
(unverified). The API does not make this distinction load-bearing —
a consumer using `HeaderTenantResolver` without a paired
authorization check trivially permits cross-tenant access.

**Suggested fix:** (1) Add an explicit security warning per
strategy. (2) `CompositeTenantResolver`: document that strategies
should be ordered by trust (claim > custom-domain > subdomain > path

> header), and consider a `TenantAuthorizationGuard` composition
> helper. (3) Cut the strategy set per the "NOT VALIDATED"
> recommendation above.

### H-3. `clientMetadata` is caller-supplied but documented as if trusted

**Files:** `vestibulum/04-cognito-triggers.md` line 138,
`04-shared-vocabulary.md` line 293.

**Threat:** Cognito passes `clientMetadata` from `InitiateAuth`
unmodified and unvalidated. A malicious client injects arbitrary
key-value pairs. If a consumer's `resolveClaims` callback reads
`clientMetadata.requestedRole` for an authorization decision, that's
a privilege-escalation vector.

**Suggested fix:** Rename to `untrustedClientMetadata` in
`ClaimResolverInput` to make the trust boundary visible at the type
level. Add an explicit warning: "MUST NOT be trusted for
authorization decisions. Use only for non-security-sensitive routing
hints."

## SIGNIFICANT

### Foundation surface

- **S-F1.** `severity` migration story leaves `medium → ?` ambiguous.
  Pick `medium → warning` deterministically.
  (`foundation/06-audit-log.md` lines 130-143.)
- **S-F2.** Audit retention overshoot. (See "NOT VALIDATED" above.)
- **S-F3.** Retention override mechanism uses string keys without
  exporting `AuditSeverity`; missing fallback semantics for partial
  records. (`foundation/06-audit-log.md` line 152.)
- **S-F4.** Tenant resolver security models not documented. (See
  "NOT VALIDATED" above.)
- **S-F5.** Five tenant resolver strategies is too many. (Same.)
- **S-F6.** Optional Prisma peer broken at module-load. (See "NOT
  VALIDATED" above.)
- **S-F7.** `PostgresAuditStore` constructor missing `retentionDays`
  option; no sweeper-job design for Postgres retention.
  (`foundation/06-audit-log.md` lines 286-288.)
- **S-F8.** `TokenBucketLimiter` discriminator breaks the
  `KVNamespace`-shim abstraction. Reframe as
  `DynamoTokenBucketLimiter` directly, or consume an OSS
  rate-limiter (`@upstash/ratelimit`, `rate-limiter-flexible`).
  (`foundation/08-rate-limit.md` lines 144-168.)
- **S-F9.** `getLogger()` private-symbol shape works with
  `Object.freeze` but needs explicit `defineProperty`-before-freeze
  semantics documented. (`foundation/07-logger-and-request-context.md`
  lines 137-169.)
- **S-F10.** pino `redact.paths` shape ≠ audit denylist shape. Spell
  out the path globs explicitly.
  (`foundation/07-logger-and-request-context.md` lines 250-264.)
- **S-F11.** `parseCookieHeader` violates OSS-reuse — use the
  `cookie` npm package. (`foundation/04-session-crypto.md` lines
  13-17.)
- **S-F12.** `LogLevel` count inconsistency (six vs five) within
  `07-logger-and-request-context.md`. Trivial fix.
- **S-F13.** `S3Storage.body` vs `.arrayBuffer()` vs `.text()`
  cannot all stream from the same `result.Body`. Pick one streaming
  contract. (`foundation/02-cloud-primitives.md` lines 230-256.)
- **S-F14.** Three `configureX` process-global functions undermine
  the "no singletons" principle. Keep `configureRootLogger` (with
  its self-justification); convert the other two to passable
  registry instances. (`07-`, `09-`, `11-`.)
- **S-F15.** `AuditLog.emit` swallows errors. Compounds H-1.
  Either default to `emitAwait` semantics or make the dual-store
  recipe prominent. (`foundation/06-audit-log.md` lines 192-198,
  378-384.)

### Vestibulum surface

- **S-V1.** `MultiPoolVerifierError.reason` union missing
  `'wrong_pool'` in `01-package-api.md`. (`vestibulum/01-package-api.md`
  lines 654-662.)
- **S-V2.** `IdpSecretsClient.refFor` returns unpinned but
  `OidcIdpRecord` has no field for the pinned version actually
  used. Add `clientSecret: SecretRef` to `OidcIdpRecord`.
- **S-V3.** `OidcIdpManager.delete` concurrency race — foundation's
  `kv` module makes this resolvable; document the pattern or flag
  as open question. (`vestibulum/01-package-api.md` lines 144-162.)
- **S-V4.** `RESERVED_CLAIMS` export's stability status undocumented.
  Tracks Cognito's docs; should be marked external-driven. Use
  `RESERVED_CLAIMS.has(...)` over hardcoded list.
- **S-V5.** `ClaimResolverOutput` missing from frozen set. (See B-K.)
- **S-V6.** `tokenUse: null` permitted but discouraged; pin the
  safer default. (`vestibulum/05-jwt-verification.md` lines 82-88.)
- **S-V7.** SAML signature failure mode collapsed to boolean
  (`isSigned: false`) loses diagnostic information.
  (`vestibulum/03-saml-flows.md` lines 76-84.)
- **S-V8.** SCIM doc mixes `string` ARN and `SecretRef` shapes in
  the same record. (`vestibulum/07-scim-forward-compat.md` line 132.)
- **S-V9.** `identity.providerName → TenantId` reverse-map round-trip
  needs an explicit callout in `ClaimResolverInput`. (See review
  B3 — promoted to SIGNIFICANT since it's a documentation gap, not
  an architectural defect.)

### Vestibulum-cdk surface

- **S-C1.** `addAppClient` prop shape (`oauth: { flows: [strings] }`)
  is non-CDK-idiomatic and inconsistent with the
  `MagicLinkAuthSite`'s own auto-creation (CDK's `OAuthSettings`).
  Use `UserPoolClientOptions`. (`vestibulum-cdk/05-app-clients.md`.)
- **S-C2.** Custom-attribute name length ambiguity ("≤20" vs "<20").
  State Cognito's actual "1–20 characters".
- **S-C3.** ID-token-size baseline (1.5 KB) underestimates real
  federated tokens (2-3 KB). Raise the baseline; lower the warning
  threshold. (`vestibulum-cdk/07-cdk-changes-from-trellis.md` lines
  336-340.)
- **S-C4.** `MagicLinkIdentity` pool-replacement traps need
  explicit enumeration. (`vestibulum-cdk/09-operational-notes.md`.)
- **S-C5.** `aws-jwt-verify` externalised but not provided by L@E
  runtime — `MODULE_NOT_FOUND` at runtime. Inline for L@E bundle
  only. (`vestibulum-cdk/10-lambda-bundle-pipeline.md` lines 75-78.)
- **S-C6.** `console.*` stripping in L@E requires `drop: ['console']`
  in esbuild — currently only mentioned as a CI assertion, not a
  build-time guarantee. (`vestibulum-cdk/04-magic-link-auth-site.md`
  lines 176-206.)
- **S-C7.** "EU-residency-friendly" topology but CMK-by-default
  deferred to "Open questions." Move to design — this is the
  package's stated purpose. (`vestibulum-cdk/02-magic-link-identity.md`
  lines 450-462.)
- **S-C8.** WAF rate-limit (2000/5min/IP) is wrong scale for
  magic-link pumping. Tighten to 30-60/5min on `/auth-verify`.
  (`vestibulum-cdk/03-edge-resources.md` line 114.)
- **S-C9.** Cost-DoS envelope of L@E + concurrency cap not
  disclosed.
- **S-C10.** `crossRegionReferences: true` SSM permission shape
  needs positive requirement statement.
  (`vestibulum-cdk/03-edge-resources.md` lines 178-194.)
- **S-C11.** `MagicLinkIdentity` SES sender domain not validated at
  synth against `hostedZone.zoneName`. Add the check.
- **S-C12.** `Vestibulum*` branding leaks into resource and metric
  names. Make namespace and prefix overridable.

### Security medium

- **S-Sec1 (M-1).** `SecretCache` plaintext in-memory, no
  zeroization. Document limitation; use `Buffer` for cache storage.
- **S-Sec2 (M-2).** `AuditEvent.metadata` size cap needed (32 KB)
  — currently an open question, but oversize-write enables audit
  evasion. Promote to required.
- **S-Sec3 (M-3).** `unsealJson<T>` performs unchecked type
  assertion. Add optional `schema: ZodSchema<T>` parameter.
- **S-Sec4 (M-4).** PBKDF2 100k iterations below OWASP 2023
  recommendation (600k). Raise default.
- **S-Sec5 (M-5).** Rate-limit fallback to `'unknown'` IP creates
  shared bucket. Document degraded mode.
- **S-Sec6 (M-6).** Lambda@Edge revocation latency (15-30 min) —
  document the dual-verification requirement explicitly.

## NITs

Aggregated from all four reviews. Each is a one-line fix.

- Foundation: `AuditSeverity` not exported from barrel; `MemoryFeatureToggleStore` exported but in-memory KV not (inconsistency); `04-` open question on `idp` field unresolved; `peek()` race wording; secrets `delete` `ForceDeleteWithoutRecovery: true` default; `Composite` error semantics under-specified; CSRF-token-in-session pattern undocumented.
- Vestibulum: `V1/V2` vs `V1/V2/V3` normalisation comment drift; `oidcProfileGeneric.attributeMapping` convention unexplained; `Option A settled against` unlinked; `onError` no-throw guarantee not in public API doc; `getRequestContext`/`setRequestContext` not cross-referenced; "read-only" re-export wording confused.
- vestibulum-cdk: `lib/login-pages/` path is transplant residue (now `packages/vestibulum-cdk/login-pages/`); `lib/lambda-handlers/` similarly; README transplant table understates merge of two sources; `crypto.subtle.digest` CSP note; `EdgeResources` cert lacks SAN support but `07-` suggests cert reuse.
- Security low: `TenantId` regex permits injection-unsafe chars; IP anonymization hash needs algorithm version prefix; secret-delete default; `Composite` ordering security note; esbuild binary not hashed in bundle manifest.

## Recommendations — priority

Fix order, by leverage:

1. **B-A (frozen-type location)** — unblocks the layering rule, the
   CI gate, B-D, and S-V5 / B-K. One architectural decision, several
   doc edits.
2. **B-B + B-C (bundle pipeline disconnect)** — unblocks
   vestibulum-cdk's entire reason for existing. Coordinate the
   vestibulum runtime move with the construct doc edits.
3. **H-1 + S-F15 + S-Sec2 (audit integrity)** — three related
   issues; resolving together gets a coherent audit-log security
   story.
4. **H-2 + S-F4 + S-F5 (tenant resolver)** — cut to 2-3 strategies,
   document security per strategy, ship.
5. **B-G + B-H + S-C7 (vestibulum-cdk cost/security defaults)** —
   default-off the paid features; surface CMK decision.
6. **B-E + B-J + B-K (vestibulum surface bugs)** — IPv4 list,
   JWT iteration pattern, frozen-set drift. Each is a focused edit.
7. **B-L + S-F6 (architecture choices needing decision)** —
   `setRequestContext` semantics; Prisma sub-path structure.

Items 1-2 are architectural; items 3-5 are policy; items 6-7 are
concrete edits. Implementation should not begin until 1 and 2 are
resolved.

## Status

This punch list reflects four parallel reviews as of 2026-05-24. Not
all reviewer findings are blocking — some are nits or already
covered as open questions in the docs. Resolving the BLOCKER and
HIGH items is the gate for committing to the design.
