# 08 — Shared-pool multi-tenancy (deferred — superseded by shared-distribution)

Status: **superseded**. The prototype design captured here was the
"N `MagicLinkAuthSite` per shared `MagicLinkIdentity`" topology that
required a `cdk deploy` per tenant onboarding. The follow-on
constraint — *pure-data tenant onboarding, no CDK deploy* — pointed at
a different topology entirely (single CloudFront, wildcard cert,
multi-`aud` edge), which lives at
[`shared-distribution/`](shared-distribution/). **Read that
subfolder for the going-forward design.** This doc is preserved for
context on what was considered and why it was set aside.

A working prototype of the older design exists on the standalone
`vestibulum` repo's `feat/shared-pool-multi-tenancy` branch (three
commits off `main`, ~950 LOC across CDK constructs + Lambda handlers
+ tests). The branch was never merged to vestibulum's `main`, was
never published, and has no current downstream consumer.

The decision is captured at the bottom under [Forward-port
decision](#forward-port-decision). Read top-to-bottom on first pass.

## Problem

Today's `MagicLinkIdentity` + `MagicLinkAuthSite` topology assumes one
identity per deployment: one Cognito user pool, one app client, one
website. The pool-level trigger Lambdas (`PreSignUp`,
`CreateAuthChallenge`) read pool-wide env vars:

- `VESTIBULUM_ALLOWED_EMAIL_DOMAINS` — one allowlist for every signup.
- `VESTIBULUM_DOMAIN` — one magic-link callback origin for every email.

This topology breaks under shared-pool, subdomain-routed
multi-tenancy: one Cognito pool, N app clients (one per tenant), each
tenant on its own subdomain (`<tenant>.example.com`), each tenant with
its own email-domain allowlist and its own magic-link callback origin.
The pool-wide envs cannot generalise to N tenants without forcing a
Lambda version bump on every tenant add/remove and hitting the 4 KB
env-var cap around 25–30 tenants.

## Target architecture: N `MagicLinkAuthSite` per shared `MagicLinkIdentity`

```
      ┌────────────────────────────────────┐
      │  MagicLinkIdentity (shared)        │
      │  ─ Cognito user pool (shared)      │
      │  ─ PreSignUp Lambda                │
      │  ─ CreateAuthChallenge Lambda      │
      │  ─ VerifyAuthChallengeResponse     │
      │  ─ DefineAuthChallenge             │
      │  ─ MagicLinkTokens DDB             │
      │  ─ ClientConfig DDB (new)          │
      │  ─ SES + bounce-handler            │
      └──────┬──────────────┬──────────────┘
             │              │
   ┌─────────▼──┐    ┌──────▼─────┐    ┌─ ... N
   │ AuthSite A │    │ AuthSite B │
   │ tenant-a.… │    │ tenant-b.… │
   │ ─ CloudFt  │    │ ─ CloudFt  │
   │ ─ check-   │    │ ─ check-   │
   │   auth     │    │   auth     │
   │ ─ app-     │    │ ─ app-     │
   │   client A │    │   client B │
   └────────────┘    └────────────┘
```

Each `MagicLinkAuthSite` remains self-contained: its own CloudFront,
its own edge `check-auth` with **single-`aud` verification pinned to
that tenant's website client**, its own auth-verify/signout Lambdas,
its own cookie scoped to its subdomain. Cross-tenant cookie isolation
follows from two independent properties:

1. Cookies issued with `Domain=<exact-subdomain>` (no leading dot) —
   browser won't send `tenant-a` cookies to `tenant-b`.
2. Each AuthSite's edge function only accepts the tenant's own `aud`
   — leaked cross-tenant tokens are rejected at the edge.

The shape deliberately scales as N AWS resources per tenant. Sized for
~50 tenants per deployment; beyond that, a shared-distribution mode
(multi-CNAME on one CloudFront, Host-routing in the edge) would be
needed. That's [out of scope](#out-of-scope-even-if-forward-ported)
even in the original design.

## The four changes the branch ships

### Change 1: Per-client config plumbing on `MagicLinkIdentity`

A new DDB table on `MagicLinkIdentity`:

- Table: `ClientConfig`, PK = `clientId: string`.
- Attributes: `siteBaseUrl: string`, `allowedEmailDomains: string[]`,
  `tenantId: string | null`.
- Exposed publicly as `MagicLinkIdentity.clientConfigTable:
  dynamodb.ITable` so consumers can wire a PreTokenGeneration Lambda
  against it.

A new internal method:

```typescript
_registerSite(config: {
  clientId: string;
  siteBaseUrl: string;
  allowedEmailDomains?: string[];
  tenantId?: string;
}): void;
```

A new public helper that grants IAM and injects the env var in one
call (preventing the common "IAM-granted but env-missing" footgun):

```typescript
grantReadClientConfig(fn: lambda.Function): void;
```

Each `MagicLinkAuthSite` calls `_registerSite` during its constructor.
`MagicLinkIdentity` materialises each row via a per-row
`AwsCustomResource` (not batch) so CFN's create/update/delete diff
cascades correctly when an AuthSite is destroyed. At 50 tenants this
adds ~50 CFN resources, well under the 500-per-stack cap.

Trigger Lambdas (`PreSignUp`, `CreateAuthChallenge`) are granted
read-only on `ClientConfig`, read their per-client config on cold
start, and cache with a 5-min TTL (`TtlCache` helper, ~30 LOC,
promise-coalescing single-key cache).

**Fail-closed posture.** If the `ClientConfig` `GetItem` call rejects,
both Lambdas throw — they MUST NOT fall back to pool-wide env. A
cross-tenant redirect is worse than a failed challenge.

### Change 2: New props on `MagicLinkAuthSite`

```typescript
interface MagicLinkAuthSiteProps {
  // ...existing props...

  /** Per-site email-domain allowlist; overrides the identity's default. */
  readonly allowedEmailDomains?: string[];

  /**
   * Opaque tenant identifier. Read by the consumer's
   * PreTokenGeneration Lambda from ClientConfig and injected as
   * `custom:tenant_id` on issued tokens.
   */
  readonly tenantId?: string;
}
```

The site passes both to `identity._registerSite`. Each AuthSite also
derives a unique app-client construct id from `node.addr`, fixing a
pre-existing collision under shared-pool deployments.

### Change 3 (nice-to-have): Reusable JWT verifier export

A new public export for downstream Lambda@Edge consumers that need
multi-`aud` verification (e.g. one CloudFront distribution fronting
agents authenticated against any per-tenant app client):

```typescript
// New: vestibulum/edge.ts
export interface VerifyCognitoJwtOptions {
  poolId: string;
  region: string;
  audiences: string[];
  customClaims?: Array<(claims: Record<string, unknown>) => void>;
  clockSkewSec?: number;
}

export async function verifyCognitoJwt(
  token: string,
  opts: VerifyCognitoJwtOptions,
): Promise<Record<string, unknown>>;
```

Implementation reuses the bundled edge check-auth's hardened posture
(RS256-only `alg` allowlist, JWKS in-memory cache with 15-min TTL,
fail-closed on JWKS errors, no PII logging). Without this export,
downstream consumers reimplement ~80 lines of JWT-verification setup
and drift out of posture-sync over time.

Marked P2 in the original plan — separable from Changes 1+2.

### Change 4: Docs (`07-multi-tenancy.md` + RoPA refresh)

A new per-package doc documenting the N-instances-per-identity
topology, the cookie-isolation story, the PreTokenGeneration wiring
pattern, and the shared-identity blast-radius caveats:

- bounce-handler quarantine is global to user `sub` (one mailbox
  state across tenants);
- `BOUNCE_HMAC_SECRET` rotation affects all tenants on the identity
  simultaneously;
- PreSignUp rate-limit buckets are keyed on email (cross-tenant by
  design — same mailbox, same abuse surface).

Plus a "Multi-tenant deployments" section in `RoPA.md` for GDPR
record-of-processing.

## Scope of the existing prototype

Three commits on `feat/shared-pool-multi-tenancy` off vestibulum's
`main`:

- **Wave 1** (`b9c5421`): `ClientConfig` table + helpers + docs.
- **Wave 2+3** (`4469ac4`): `_registerSite`, AuthSite props, handler
  refactors. 913 lines added across 11 files (constructs + handlers +
  tests + snapshots).
- **Wave 4** (`20703b6`): CHANGELOG entries.

Total: ~950 LOC of CDK + Lambda + tests. Tests added: +25 (9 MT
integration + 5 PreSignUp + 3 CreateAuthChallenge + misc). All
passing on the branch at the time of writing.

The plan files (`plans/shared-pool-multi-tenancy.md`,
`plans/shared-pool-multi-tenancy-checklist.md`) total ~1450 lines and
contain repeated references to the originally-anticipated downstream
consumer; the code itself does not. Forward-porting would require
either dropping the plan files or scrubbing them.

## Cost to forward-port

Code work:

- **`packages/vestibulum-cdk/lib/magic-link-identity/`**: add
  `client-config-table.ts` (DDB table + `_registerSite` + per-row
  `AwsCustomResource`), `grant-read-client-config.ts`. Update
  `magic-link-identity.ts` to wire them. Update CDK-nag snapshots.
- **`packages/vestibulum-cdk/lib/magic-link-auth-site/`**: add
  `allowedEmailDomains` and `tenantId` props. Add `node.addr`-derived
  app-client construct id. Call `_registerSite` in constructor.
- **`packages/vestibulum/src/lambda/shared/`**: add `ttl-cache.ts`,
  `client-config-loader.ts`.
- **`packages/vestibulum/src/lambda/handlers/pre-signup/`**: refactor
  to read `ClientConfig`, keep `VESTIBULUM_ALLOWED_EMAIL_DOMAINS` as
  fallback for raw `addAppClient` consumers.
- **`packages/vestibulum/src/lambda/handlers/create-auth-challenge/`**:
  same shape — read per-client `siteBaseUrl`, fail-closed on DDB
  error.
- **Bundle pipeline**: regenerate `lambda-bundles.lock.json` for the
  two changed bundles.
- **Tests**: port ~25 tests from the branch, raise coverage on new
  files to the 80% threshold.
- **Docs**: write `doc/vestibulum-cdk/08-multi-tenancy.md` (the plan's
  Change 4, neutralised of downstream-consumer references).

Estimated effort: **1.5–2 days** for a focused agent run, plus a
review pass. The work is mechanical translation, not novel design.

Risks added by forward-porting:

- Increases v0.1 scope. Current state is publishable; adding 950 LOC
  + tests means another full review + coverage + lint cycle.
- The design was never merged in the source repo, so no production
  burn-in. Forward-porting an unmerged design into a publish-bound
  monorepo is premature absent a consumer waiting on it.

Risks removed by forward-porting:

- The prototype's design encodes specific choices (DDB over env vars,
  per-row custom resource, fail-closed on cache miss, ITable in the
  public type, IAM+env coupled in one helper) that took real
  thinking. Discarding loses that.

## Out of scope even if forward-ported

These were [out of scope] in the original plan and remain so:

- **Shared-distribution mode** (one CloudFront with multi-CNAME,
  Host-routing in the edge, multi-`aud` in the bundled check-auth).
  Triggered only when tenant count exceeds ~50 or the N-distributions
  model becomes operationally painful.
- **Cross-tenant user roaming via federation** — one `sub`
  authenticating against multiple tenants without re-login. Current
  answer: fresh `InitiateAuth` against the target tenant's app
  client.
- **Tenant provisioning API.** Adding a tenant is a `cdk deploy` per
  tenant; vestibulum-cdk doesn't ship a provisioning helper.
- **Per-tenant rate limits.** PreSignUp rate-limit bucket is keyed on
  email, so one human signing up against tenants A and B shares one
  bucket. Intentional.
- **Per-tenant SES "From" address.** Tenants wanting their own From
  need their own SES identity (per-tenant DKIM/SPF/DMARC), which
  approaches pool-per-tenant operationally — get the "hard-isolation
  variant" (separate `MagicLinkIdentity`) instead.

## Forward-port decision

Three options, in order of cheapness:

### A. Discard

Drop the work entirely. Acceptable if shared-pool MT is unlikely to
be requested in the foreseeable future. Cheapest path: zero saas-
foundation cycles, delete the standalone repo, move on.

**Cost on regret:** rebuilding the design from scratch takes 1–2 days
of design thinking before any code (the DDB-vs-env-vars decision,
fail-closed semantics, per-row vs batch custom resource, the
`grantReadClientConfig` pattern) before writing the ~950 LOC. So
~3–5 days end-to-end if regret hits later, vs. ~2 days of
forward-port now.

### B. Forward-port now (Changes 1, 2, 4 only)

Migrate the three core changes into saas-foundation in a focused PR
sequence after v0.1 publish. Defer Change 3 (JWT verifier export) to
a follow-up. Adds the topology as a supported v0.2 feature.

**Cost:** ~1.5–2 days agent work + review. Delays v0.2 of
`@de-otio/vestibulum-cdk` by that amount. Doesn't block v0.1.

**Best fit if:** there is any expected consumer of shared-pool MT in
the next 6 months.

### C. Save as patch + design notes, then delete the standalone repo

Export `b9c5421..20703b6` as `git format-patch` files into
`doc/vestibulum/future-work/shared-pool-mt/`, alongside the
neutralised design summary already captured in this file. Delete the
standalone vestibulum clone. Forward-port later if a consumer
materialises.

**Cost now:** ~15 min. The patches won't apply cleanly to saas-
foundation's restructured layout (paths changed from `lib/` →
`packages/vestibulum-cdk/lib/`, `runtime/src/` →
`packages/vestibulum/src/`), but they remain a readable reference
for the design intent and test coverage.

**Best fit if:** shared-pool MT is plausible-but-not-imminent. This
file plus the patches together cost a future agent ~half a day to
re-orient, vs. ~1–2 days to redesign from scratch.

## Recommendation

**Discard** (option A), with the going-forward design captured at
[`shared-distribution/`](shared-distribution/).

Rationale: the user requirement "onboard a tenant without deploying
any additional resources" rules out the N-CloudFront topology this
prototype was built around. Forward-porting (B) would build the
wrong shape; patch-and-defer (C) preserves a design that, when
revisited, would still be the wrong shape. The
[`shared-distribution/`](shared-distribution/) subfolder is the
re-design that meets the pure-data-onboarding requirement.

What carries forward from this prototype into the new design (so
none of the design thinking is wasted):

- The `ClientConfig` DDB table — same shape, same purpose, same
  fail-closed posture in PreSignUp / CreateAuthChallenge. See
  [`shared-distribution/06-trigger-handlers.md`](shared-distribution/06-trigger-handlers.md).
- The 5-min TTL cache in trigger Lambdas (`TtlCache` helper).
- The fail-closed contract: a missing row never falls back to
  pool-wide config.
- The "domain allowlist normalisation" (lowercase, trim) convention.
- The reasoning that DDB beats Lambda env vars past ~25 tenants.

What does **not** carry forward:

- `MagicLinkAuthSite._registerSite` and per-tenant `AwsCustomResource`
  rows — replaced by the admin Lambda's pure-SDK write path.
- Per-tenant pinned `aud` at the edge — replaced by `Host` ↔
  `custom:tenant_id` structural binding.
- `allowedEmailDomains` and `tenantId` props on `MagicLinkAuthSite`
  — that construct doesn't exist in shared-distribution mode.

The standalone `vestibulum` clone can be deleted once this decision
is committed.
