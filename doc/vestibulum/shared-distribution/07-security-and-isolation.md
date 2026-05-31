# 07 — Security and isolation

The deltas vs. the prototype's N-CloudFront design, the threat
model, the hard-isolation escape hatch, and the cross-tenant
properties that are intentional rather than bugs.

## Tenant-isolation properties

Three independent isolating mechanisms, each sufficient on its own
for one class of attack, layered for defence-in-depth:

1. **Cookies scoped to exact subdomain.** `Set-Cookie:
   Domain=<subdomain>.<parent>; ...` with **no leading dot**.
   Browser will not send `tenant-a`'s cookies to `tenant-b`.
   Verified by:
   - Edge function's `Set-Cookie` writer: always uses exact-host
     scoping, no leading-dot variant.
   - Property test: cookies issued for any tenant A, presented at
     any tenant B (B ≠ A), are not sent by the user agent.

2. **Edge `Host` ↔ `custom:tenant_id` check.** Defined in
   [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md).
   Even if cookie scoping fails (e.g. malicious browser
   extension, attacker who exfiltrates cookies), the structural
   check at the edge rejects mismatched tokens.

3. **Issuer pinning + RS256-only signature verification.** The
   edge accepts only tokens issued by *our* Cognito pool. A
   forged token from another pool — or an HS256-signed token
   from anywhere — is rejected at signature verification
   before any tenant logic runs.

Any one of these failing falls back to the next. Two failing
together (e.g. cookie scoping bug AND structural check bug)
is the cross-tenant breach scenario.

## Blast radius: what changes vs. the prototype

| Failure mode                       | N-CloudFront (prototype)                     | Shared-distribution (this design)            |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Edge function bug (logic)          | 1 tenant affected (function pinned to that tenant) | All tenants on the identity                 |
| Edge function deployment failure   | 1 tenant affected                             | All tenants                                   |
| Cert compromise (private-key leak) | 1 tenant (per-tenant cert) or all (wildcard) | All tenants                                   |
| DNS provider outage                | All tenants (was shared DNS anyway)           | All tenants (no change)                       |
| CloudFront distribution outage     | 1 tenant per distribution                    | All tenants on the shared distribution       |
| WAF rule misconfiguration          | 1 tenant (per-distribution WAF)              | All tenants                                   |
| Cognito pool outage                | All tenants (shared pool in both designs)    | All tenants (no change)                       |
| Admin Lambda compromise            | Cognito pool compromise (creates rogue clients) | Same                                         |
| `ClientConfig` table corruption    | All tenants (shared table in both designs)   | All tenants (no change)                       |
| SES sender reputation              | All tenants (shared SES identity)            | All tenants (no change)                       |

The four rows where shared-distribution is worse are all related
to the single CloudFront / single edge function. The mitigation
strategy is **structural** (the cross-tenant check is hard to
mis-wire and is property-tested), not **per-tenant isolation**.

## Hard-isolation escape hatch

For tenants who contractually require per-tenant blast radius —
their own CloudFront, their own edge function, their own cert,
their own dashboard — the answer is **a separate identity**, not a
mode toggle on the shared one.

Two options:

1. **Separate `MagicLinkIdentity`** (the single-tenant construct
   from v0.1). Most isolated; the consumer instantiates a full
   per-tenant identity stack. Cost: full per-tenant CDK deploy,
   per-tenant Cognito pool, per-tenant SES identity. This is the
   "we'll never share infra with other customers" tier.
2. **Separate `SharedDistributionIdentity`** (this design,
   instantiated again). Less isolated than option 1 (still a
   shared CloudFront + pool, just one of two), but cheaper to
   stand up. Useful for grouping tenants into trust tiers (e.g.
   one identity for free-tier tenants, one for paid).

Both options are out-of-band: they require a `cdk deploy`, are
done at the consumer's discretion, and don't impact the rest of
the multi-tenant fleet.

## Cross-tenant properties that are intentional

These are NOT bugs:

### Bounce-handler quarantine is global on `sub`

If the same human signs up against tenant A and tenant B with the
same email, they get one Cognito user `sub`. The bounce handler
quarantines that `sub` based on SES bounce notifications — which
do not carry tenant context. Side-effect: a hard bounce against
tenant A's outbound email blocks future magic links to that user
on tenant B too.

**Why intentional.** It's the same mailbox. SES sender reputation
is the resource being protected; that reputation is shared across
tenants on this identity. Suppressing one tenant while continuing
to send to a bouncing address from another tenant would burn the
sender reputation for everyone.

**Known cross-tenant DoS vector.** An attacker who controls one
tenant's `allowedEmailDomains` (either via legitimate ownership of
a tenant or via admin-Lambda compromise) can:

1. Sign up a victim's email at the attacker-controlled tenant.
2. Trigger magic-link emails to the victim's address.
3. Configure the attacker's mail server to hard-bounce.

Result: the victim's `sub` is quarantined globally; they cannot
receive magic links on any tenant on the shared identity. This is
a targeted denial-of-service against a specific user across the
entire identity.

Mitigations available today:

- Operator can manually un-quarantine via direct DDB write to the
  bounce table (operator-level access required; not exposed via
  admin Lambda).
- SIEM correlation on the bounce-by-tenant ratio (most legitimate
  bounces come from a mix of tenants; one-tenant-only hard bounces
  for a `sub` are suspicious).

Deferred to v0.3+: per-tenant bounce counters keyed on
`(sub, clientId)` with operator-level unquarantine per tenant.

**Operator escape (full isolation).** If a consumer needs per-tenant
bounce isolation as a contract requirement, they need per-tenant
SES identities, which means the hard-isolation variant (separate
identity entirely).

### PreSignUp rate limits are global on email

The rate-limit bucket keys on email, not `(email, tenant)`. One
human attempting magic-link sign-in to tenants A and B in rapid
succession exhausts the bucket for both.

**Why intentional.** Same mailbox = same abuse surface. The
rate limit defends the inbox, not the tenant. Per-tenant buckets
would let an attacker who controls multiple tenant subdomains
multiplicatively bypass the rate limit by alternating subdomains.

### One user `sub` can authenticate against any client whose
allowlist admits their email

A user with email `alice@example.com` can sign up against tenants
A and B if both list `example.com` in their `allowedEmailDomains`.
The same `sub` will issue tokens for both clients.

**Why intentional.** Cognito's user pool is the user directory;
clients are how applications authenticate against that directory.
Wanting one mailbox = one user across applications is consistent
with how every other Cognito-using product works. Per-tenant
user partitioning means per-tenant Cognito pools (the hard-
isolation variant).

### `ClientConfig` row is readable from the home region by all trigger Lambdas

There's no per-tenant access partitioning in the `ClientConfig`
table. Every trigger Lambda reads any row.

**Why intentional.** The trigger Lambdas service requests for any
tenant; they can't know in advance which row they'll need. IAM
scoping to "your own row" doesn't make sense for a trigger
handler whose identity isn't tenant-bound.

The escape: encrypt sensitive per-tenant fields with a per-tenant
KMS key. Today there are no such fields; if a future field
warrants it (e.g. per-tenant signing keys, per-tenant API
secrets), introduce a KMS-key-per-tenant pattern then.

## Cross-tenant properties that are bugs and must be tested

The complement of the previous list: things that **must not**
cross tenants. Each is the subject of at least one property test:

| Property                                                   | Where tested                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Token for tenant A never authorises a request on tenant B   | [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) tests   |
| Cookie set for tenant A never sent by browser to tenant B   | Edge function `Set-Cookie` review + manual browser test           |
| Magic link issued for tenant A never redeemable at tenant B | [`06-trigger-handlers.md`](06-trigger-handlers.md) tests           |
| Signup against tenant B with email matching tenant A's allowlist (but not tenant B's) → rejected | `PreSignUp` test |
| Forged `custom:tenant_id` claim → rejected at signature verify | Edge function tests                                         |
| Cross-tenant CSRF (action initiated on tenant A redirects to tenant B with tenant A's token) | Magic-link callback validation tests |

Property-test seed pinned (`0xc0ffee`); `numRuns: 1000`; CI failure
on any property fail blocks merge.

## WAF: two-layer posture

The shared distribution faces two distinct attack surfaces, each
needing its own WAF web ACL:

### CloudFront-side WAF (browser-facing traffic)

Attached to the CloudFront distribution. Protects against
unauthenticated request floods that consume Lambda@Edge invocations
and drive up cost. Default rules:

1. **Per-IP rate limit.** `RateBasedStatement` with default 1000
   requests per 5 minutes per IP. Tunable via construct prop.
2. **`AWSManagedRulesCommonRuleSet`.** Generic OWASP-style rules
   (SQL injection, XSS, oversized bodies, command injection).
3. **`AWSManagedRulesKnownBadInputsRuleSet`.** Targets recently
   disclosed vulnerabilities; AWS keeps it current.
4. **Optional geographic restriction.** For consumers with strict
   EU-residency posture, a `GeoMatchStatement` allowing only EEA
   countries can be enabled via construct prop.

Consumer can replace the entire web ACL via
`SharedDistributionIdentityProps.cloudFrontWebAclArn`.

### Cognito-side WAF (direct-API traffic)

[AWS docs](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-waf.html)
support attaching a WAF web ACL **directly to the user pool**,
inspecting hosted-UI, managed-login, and public API operations
(`SignUp`, `InitiateAuth`, `ConfirmSignUp`, etc.). The shared-
distribution design exposes Cognito public APIs to credential-
stuffing that bypasses CloudFront entirely — every tenant's app
client is one `InitiateAuth` call away from the public internet.

Default rules:

1. **Per-IP rate limit on `InitiateAuth`.** 100 attempts per 5 min
   per IP (tighter than CloudFront because each call costs
   meaningfully more than a static asset fetch).
2. **Per-IP rate limit on `SignUp`.** 20 attempts per 5 min per IP.
3. **`AWSManagedRulesAmazonIpReputationList`.** Block known
   malicious source IPs.

Important constraint per AWS docs: WAF rules **cannot** match on
PII fields (`username`, `password`), but can match on non-confidential
metadata (User-Agent, IP, geographic, request size).

Consumer can replace via
`SharedDistributionIdentityProps.cognitoPoolWebAclArn`.

### Blast-radius update

The WAF rows in the blast-radius table below already reflect that
WAF misconfiguration affects all tenants. With the two-layer WAF
now specified, the new failure modes are:

| Failure                                          | Effect                                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| CloudFront WAF misconfiguration                  | All tenants; static-asset and edge layers exposed       |
| Cognito-pool WAF misconfiguration                | All tenants; direct-API credential stuffing exposed     |
| Both WAFs misconfigured                          | Full surface exposed; alarm both via CloudWatch metric  |

## Admin Lambda compromise scenarios

The admin Lambda is the highest-blast-radius component in the
shared-distribution design (after the Cognito pool's signing key,
which is AWS-managed and out of our control). Specific concerns:

### Compromise → rogue tenant creation

An attacker who can invoke the admin Lambda can create a tenant
matching a legitimate subdomain — but only if there isn't already
a tenant on that subdomain (uniqueness enforced by the GSI). So
the threat is **squatting unused subdomains**, not impersonating
existing ones.

Mitigation:

- Admin Lambda IAM-restricted; `adminInvokePrincipal` is a single
  named principal.
- Every admin-Lambda invocation is logged with caller identity to
  the audit log (`@de-otio/saas-foundation/audit`).
- Reserved-subdomains list rejects common impersonation targets
  (`admin`, `www`).

### Compromise → existing tenant takeover

The admin Lambda can `updateTenant` to change `allowedEmailDomains`
for an existing tenant. Attacker adds their domain to the allowlist
→ signs up at the tenant → has a valid account.

This requires the attacker to:

1. Compromise the admin Lambda's IAM caller.
2. Issue a SigV4-authenticated update call.
3. Sign up via the legitimate magic-link flow (their email goes
   through the tenant's PreSignUp + CreateAuthChallenge).
4. Get the magic-link email at their own address.

The attacker has a working account but doesn't have any existing
user's tokens — they've just added themselves as a new user.

**Real-time detection** ([`08-observability-and-audit.md`](08-observability-and-audit.md)):

- `Vestibulum/SharedDistribution/AllowlistChanged` metric emitted
  on every `updateTenant` that changes `allowedEmailDomains`.
- CloudWatch alarm fires on `count > 0` with **zero-minute delay**
  (not the orphan-detection 1-hour sustain).
- Audit-log entry includes caller IAM identity from the Function
  URL's `requestContext.authorizer.iam`, before/after values, and
  timestamp.

Detection latency target: < 5 minutes from change to alarm.
Compare to the un-mitigated window: 60-minute ID-token validity +
30-day refresh-token validity. Real-time alerting is
non-negotiable.

### Compromise → tenant deletion

The admin Lambda can delete tenants. Attacker deletes tenant
records to disrupt service.

Mitigation:

- Audit log + alarm on unexpected deletions.
- DDB PITR enabled on `ClientConfig` table (default in the design)
  → recover row.
- Cognito app client deletion is reversible only via Cognito
  console (manual recreate); document recovery procedure in the
  ops runbook.

## What attackers can't do

Even with admin Lambda compromise, attackers **cannot**:

- Forge `custom:tenant_id` for an existing tenant on demand —
  they can only update `ClientConfig.tenantId` for a client they
  create, not for one they didn't.
- Issue tokens signed with our pool's signing key without going
  through Cognito (the key is AWS-internal).
- Bypass the edge's `Host` ↔ `custom:tenant_id` check by adding
  attacker-controlled DNS — they don't control DNS, the consumer
  does.
- Read existing users' passwords — Cognito hashes are not
  retrievable.

The trust anchor is: admin Lambda IAM + Cognito IAM + DNS
control. Compromise one of the first two and they can disrupt
or squat, but not impersonate cross-tenant. Compromise all three
and the design's protections fall — at which point the consumer
has bigger problems.

## Sharding past the per-pool ceiling

Default Cognito limit: 1,000 app clients per user pool. Past
~800 (90% to leave headroom), the consumer needs multiple
`SharedDistributionIdentity` instances.

**Decision: subdomain-based sharding.** Each shard owns a
non-overlapping subdomain space — e.g. `*.tenants-eu.example.com`
served by identity A, `*.tenants-us.example.com` served by
identity B. Routing is implicit in the subdomain a tenant lives
under; no router needed.

Rejected alternative: **subdomain-hash sharding** with one parent
domain and an edge router mapping subdomain → shard. Requires an
extra Lambda@Edge layer, cross-shard uniqueness coordination, and
more complex failure modes. Over-engineered until someone produces
a use case that subdomain-based sharding can't handle.

The 1,000-tenant ceiling is rarely the real ceiling — operational
overhead per tenant (support, billing, customisation requests) is
usually the bottleneck first. The construct supports the simple
shape; consumers compose multiple identities themselves when they
need to.

## RoPA / data-flow updates

The Record-of-Processing-Activities at
`packages/vestibulum-cdk/RoPA.md` needs a "Shared-distribution
deployments" section covering:

- **Data subject categories.** One identity serves multiple tenant
  populations; the data subject set is the union across tenants.
- **Recipient categories.** Bounce handler sees email-status events
  across all tenants on the pool. Trigger Lambdas see request
  context across all tenants.
- **Cross-tenant linkability.** Documented in this doc — one
  `sub` can authenticate against any tenant admitting their email
  domain.
- **Storage.** `ClientConfig` table holds no personal data; opaque
  `tenantId` plus DNS strings.
- **Deletion.** Tenant deletion via admin Lambda removes the app
  client and `ClientConfig` row but not user `sub` entries.
  User-level deletion via `AdminDeleteUser` is consumer-side.
- **Data residency.** Single pool, single home region — same as
  single-tenant.

The RoPA changes are documentation; no operational deltas beyond
what the design above already covers.
