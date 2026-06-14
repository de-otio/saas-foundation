# Pool topology: B2C tier vs B2B federation

The Cognito feature tier (`Lite` / `Essentials` / `Plus`) is a
**per-pool** setting — every MAU in the pool pays the tier's
rate. There is no per-user override. This file analyses the two
viable topologies for a consumer that wants cheap B2C
magic-link auth alongside expensive-feature B2B federation, and
lays out the trade-offs each involves.

Background:

- `@de-otio/vestibulum-cdk`'s `MagicLinkIdentity` construct
  exposes a `featureTier` prop.
- V2/V3 pre-token-generation events
  ([`./04-cognito-triggers.md § Event version normalisation`](./04-cognito-triggers.md#event-version-normalisation))
  require Essentials. Lite pools receive V1 events only.

## Why the question exists

The natural design — one Cognito pool serving both B2C
magic-link and B2B federation users — forces the higher tier on
every user, because the pool-level setting is binary. If B2C
users outnumber B2B users (the typical mix for a SaaS product),
most of the MAU bill is paid at the higher rate even though
only the B2B users use the features that require it.

There are three reactions to this:

- **A. Pay it.** Accept Essentials for every user; simplest
  architecture.
- **B. Two pools.** B2C on Lite, B2B on Essentials; tier is
  per-pool, so this works.
- **C. Single pool on Lite.** Downgrade the feature surface to
  what V1 pre-token-generation events support; one pool, one
  rate, less code.

Option A was already settled against in the upstream design
conversation — paying Essentials per MAU on the B2C-dominant
population is the largest line item at scale, and the B2C side
genuinely doesn't use any of the V2/V3 features Essentials
gates. The cost asymmetry only worsens as B2C grows. This file
analyses B and C.

### Constraint: separate B2B and B2C accounts are acceptable

The design accepts that a human who is both a B2C consumer and
a B2B employee may hold two distinct accounts — one per role.
This removes the largest historical objection to two-pool
topologies (the "cross-pool linking is hard" problem); the two
pools are simply two independent identity surfaces by design,
and the consumer's product UX makes the separation explicit
("sign in as a personal user" vs "sign in through your
company"). The analysis below treats this as settled, not a
trade-off.

## Cost reality

Tier choice affects per-MAU pricing only. The specific rates
change over time; check the [Cognito pricing page](https://aws.amazon.com/cognito/pricing/)
for current numbers. As of writing the ratio is roughly:

- Lite: 1× (the baseline)
- Essentials: ~2.7×
- Plus: ~3.6×

At a hypothetical $0.0055/MAU Lite and $0.015/MAU Essentials,
with B2C users dominating:

| Scenario          | Option A (single Essentials) | Option B (two pools) | Option C (single Lite) |
| ----------------- | ---------------------------- | -------------------- | ---------------------- |
| 10k B2C + 500 B2B | $158/mo                      | $63/mo               | $58/mo                 |
| 100k B2C + 5k B2B | $1,575/mo                    | $625/mo              | $578/mo                |
| 1M B2C + 50k B2B  | $15,750/mo                   | $6,250/mo            | $5,775/mo              |

The B vs C delta is small (the B2B users in Option B still pay
Essentials; Option C pays Lite for everyone). The A vs B/C
delta is large and grows linearly with B2C scale.

**Implication**: at low scale (<5k MAU) the absolute cost of
any option is small enough that architectural simplicity
dominates. At high scale, Options B and C both pay back the
engineering investment; A is the option you grow out of.

## Option B: Two pools (B2C Lite + B2B Essentials)

### CDK shape

Two `MagicLinkIdentity` constructs in the consumer's CDK app:

```typescript
// B2C pool. Lite tier, magic-link only.
const b2c = new MagicLinkIdentity(b2cStack, "B2cIdentity", {
  hostedZone,
  sesIdentitySender: "noreply@example.com",
  allowedEmailDomains: [],
  // No federationEnabled, no customAttributes, no hostedUiDomain.
  // featureTier is implicit Lite.
});
new MagicLinkAuthSite(b2cStack, "B2cSite", { /* ... */ identity: b2c });

// B2B pool. Essentials tier, federation enabled, no magic-link site.
const b2b = new MagicLinkIdentity(b2bStack, "B2bIdentity", {
  hostedZone,
  sesIdentitySender: "noreply@example.com",
  allowedEmailDomains: [],
  federationEnabled: true,
  featureTier: "Essentials",
  customAttributes: [
    { name: "userId", dataType: "String", maxLength: 64, mutable: true },
    { name: "globalRole", dataType: "String", maxLength: 32, mutable: true },
    { name: "activeTenantId", dataType: "String", maxLength: 64, mutable: true },
    { name: "tenantSlug", dataType: "String", maxLength: 64, mutable: true },
    { name: "tenantRole", dataType: "String", maxLength: 32, mutable: true },
    { name: "handle", dataType: "String", maxLength: 64, mutable: true },
    { name: "idpGroups", dataType: "String", maxLength: 2048, mutable: true },
  ],
  hostedUiDomain: { kind: "custom", domainName: "auth.example.com", acmCertArn },
});
// No MagicLinkAuthSite on b2b — federation-only.
```

Each pool gets its own:

- Cognito User Pool (separate `UserPoolId`).
- Pre-token-generation Lambda (different shape per pool: B2C
  doesn't need to touch tokens at all; B2B uses V2 events).
- Post-confirmation Lambda (per-pool JIT logic).
- SES domain identity, DynamoDB tables (for the B2C pool's
  magic-link infrastructure; the B2B pool skips these since
  it's federation-only).
- Hosted UI domain (B2B only).
- Bounce handler (B2C only).

Two pools, two stacks; the duplication is material but bounded.

### Consumer data-model impact

The consumer's `User` model typically uses `cognitoSub` as the
unique identity link to Cognito. With two pools, a `cognitoSub`
is only unique _within a pool_, so the schema needs
disambiguation. Options:

1. **Add `cognitoPoolKey` column.** `cognitoSub` uniqueness
   becomes the composite `(cognitoPoolKey, cognitoSub)`
   enforced at the DB level. The value is a short stable
   identifier (`'b2c' | 'b2b'`), not the Cognito pool ID itself
   — avoids leaking the pool ID into application logs and
   matches the `poolKey` shape used by
   [`./05-jwt-verification.md`](./05-jwt-verification.md).
   Existing rows migrate by writing the current pool key into
   every row. The consumer's JWT verification has to carry the
   pool key alongside the sub.
2. **Separate columns** (`b2cCognitoSub`, `b2bCognitoSub`, both
   nullable). A user can exist in one or both pools. More
   columns, but the natural shape for "this person is a B2C
   consumer AND an employee at a B2B customer".
3. **Two `User` rows for two-pool users.** The linking happens
   in a `UserIdentityLink` table. Probably overengineered for
   the use case.

Option 1 is the lightest schema change. Option 2 matches the
user mental model better at the cost of NULL discipline.

### Cross-pool user identity (by design: separate accounts)

Per the upstream decision, a human who exists in both contexts
holds two accounts — one per pool. Cognito sees two unrelated
users; the consumer's `User` table sees two unrelated rows.
There is no cross-pool linking. This is a deliberate product
decision, not a workaround:

- **A B2C user invited to a B2B tenant** completes a fresh B2B
  sign-up through the federation flow. Their personal account
  is untouched and unrelated.
- **A B2B user wanting a personal tenant** signs up separately
  on the B2C side. Same email is fine; no automatic merging.
- **The consumer's UI disambiguates intent at sign-in** ("sign
  in as a personal user" vs "sign in through your company").
  The two experiences route to different pools and yield
  different `User` rows.

No `UserIdentityLink` table; no `AdminLinkProviderForUser`
orchestration; no "complete-your-B2B-signup" merge flow. The
simpler model.

**UX constraint (load-bearing for privacy).** Because the two
accounts may belong to different humans — an attacker can
create a B2C account under any email speculatively, including
one that later becomes a B2B tenant domain — the consumer's
product UI **must not** display any cross-pool hint to either
account. Specifically:

- The B2C profile page never shows "you also have a B2B account
  at acme.example."
- The B2B admin UI never shows "this user also exists in your
  B2C product."
- Email-collision detection during signup returns the same
  response regardless of whether the email exists in the other
  pool.

The two pools are independent identity surfaces by Cognito's
design and by the consumer's product design; treating them as
related in the UI re-introduces a cross-pool linkage that the
two-pool topology was chosen to avoid, and turns the
B2C-account-speculation attack from a nuisance into a privacy
leak.

### `/auth/discover` routing

The consumer's auth-discovery endpoint needs to pick a pool per
request:

- Email domain is a verified `TenantDomain` → B2B pool,
  federation Hosted UI for that tenant's IdP.
- Email domain is generic / personal → B2C pool, magic-link
  site.
- Same email, both contexts → ask the user.

A typical existing `/auth/discover` returning `{method:
'idp'|'password'}` extends to return `{pool, method}` — small
change.

### API-side JWT verification

The consumer's API uses vestibulum's `createMultiPoolVerifier`
helper (see [`./05-jwt-verification.md`](./05-jwt-verification.md))
rather than rolling its own dispatcher. The helper matches the
token's `iss` claim against an exact canonical-URL allowlist
(not a substring check, which is the easy-to-get-wrong
anti-pattern):

```typescript
import { createMultiPoolVerifier, requirePool } from "@de-otio/vestibulum";

const verifier = createMultiPoolVerifier([
  {
    poolKey: "b2c",
    userPoolId: process.env.B2C_USER_POOL_ID!,
    clientId: process.env.B2C_APP_CLIENT_ID!,
    region: process.env.AWS_REGION!,
    tokenUse: "access",
  },
  {
    poolKey: "b2b",
    userPoolId: process.env.B2B_USER_POOL_ID!,
    clientId: process.env.B2B_APP_CLIENT_ID!,
    region: process.env.AWS_REGION!,
    tokenUse: "access",
  },
]);

// In middleware:
const { poolKey, claims } = await verifier.verify(token);
```

Per-handler enforcement of "this operation must come from B2B
(or B2C)" uses `requirePool(token, 'b2b')` at the handler
boundary.

The consumer's `AuthContext` (or equivalent) carries which pool
the token came from so downstream handlers can apply
pool-specific logic. B2B tokens carry the `custom:*` claims;
B2C tokens carry only the standard claims (no need for tenant
claims on B2C — those users operate against their personal
Tenant only).

### What stays simpler in B

- No Lambda refactor. B2B pool keeps V2 events; B2C pool runs
  without a pre-token-generation Lambda at all (or a minimal
  one).
- Existing claim-cache implementations keep working as-is for
  the B2B pool.
- Edge JWT verification (Lambda@Edge in
  `@de-otio/vestibulum-cdk`'s CloudFront stack) accepts both
  pool issuers; `aws-jwt-verify` supports this.

### What gets harder in B

- Two pools to provision, monitor, alarm on.
- The trellis-side migration ([`../08-trellis-migration.md`](../08-trellis-migration.md))
  treats the integration as the two-pool topology; this is
  more setup than single-pool would be.
- SES identity duplicated (two `From` addresses or shared
  identity with per-pool sender — both workable but extra
  config).
- Two sets of custom attributes to maintain (B2C pool has
  none; B2B has the federation set). Future changes to either
  set are pool-redeployment-blocking in the same way
  single-pool would be.
- The consumer's API needs multi-issuer JWT verification
  dispatch — modest but real.

## Option C: Single pool on Lite + Lambda downgrade

### Architecture

One `MagicLinkIdentity`, `featureTier: 'Lite'` (or unset),
`federationEnabled: true`. Federation is **not** tier-gated —
Hosted UI, OIDC IdPs, SAML IdPs all work on Lite. Only the
V2/V3 **pre-token-generation event versions** are tier-gated.

```typescript
const identity = new MagicLinkIdentity(stack, "Identity", {
  hostedZone,
  sesIdentitySender: "noreply@example.com",
  allowedEmailDomains: [],
  federationEnabled: true,
  // featureTier omitted → Lite.
  customAttributes: [
    /* same list as B2B pool above */
  ],
  hostedUiDomain: { kind: "custom", domainName: "auth.example.com", acmCertArn },
});
new MagicLinkAuthSite(stack, "Site", { /* ... */ identity });
```

One pool. One user. One identity. The architectural simplicity
is the whole point.

### V1 vs V2 event differences

A typical V2 pre-token-generation Lambda:

```typescript
event.response = {
  claimsAndScopeOverrideDetails: {
    accessTokenGeneration: {
      claimsToAddOrOverride: {
        /* custom:* claims */
      },
    },
  },
};
```

V1 only supports ID-token claim overrides:

```typescript
event.response = {
  claimsOverrideDetails: {
    claimsToAddOrOverride: {
      /* custom:* claims */
    },
  },
};
```

V1 → V2 capability gap that matters:

- ✅ ID-token claim overrides (V1 supports).
- ❌ Access-token claim overrides (V2-only).
- ❌ Claim suppression (V2-only `claimsToSuppress`).
- ❌ Scope manipulation (V2-only).
- ❌ Complex-typed claim values, arrays, objects (V2-only; V1
  is string-only).
- ❌ Group override (V2-only).

For most consumers, the only gap that matters is "the claims
land in the ID token, not the access token". Everything else
typical consumers do is V1-compatible.

### Where claims live: ID token vs access token

Typically, a consumer's API:

1. Client sends `Authorization: Bearer {accessToken}`.
2. Middleware verifies access token via `aws-jwt-verify` (or
   vestibulum's wrapper).
3. Middleware reads `custom:userId`, `custom:activeTenantId`,
   `custom:tenantRole`, etc. from the verified access-token
   claims.
4. Constructs `AuthContext`.

On V1 events the custom claims would only be in the ID token.
Three paths:

#### Path C.1: API verifies ID tokens

Send the ID token as the bearer; verify `tokenUse: 'id'`.
Works. Slightly unconventional — OAuth 2 conventions reserve ID
tokens for the client and access tokens for resource servers —
but in practice the line is fuzzy and many APIs in the Cognito
ecosystem do this. Smallest refactor (just change `tokenUse`
in the verifier config).

#### Path C.2: API receives both tokens

Client sends ID token in a custom header (`X-Id-Token`)
alongside the access token. Middleware verifies the access
token (for authn / session validity / `aud`), then verifies
the ID token (for claims). More moving parts; every client
(web, mobile, agents) has to be updated.

#### Path C.3: API doesn't use token-embedded claims at all

Verify only the access token; resolve custom claims server-side
per request from `cognitoSub` → consumer DB. This is what the
pre-token-gen Lambda currently does inside Cognito — move it to
API middleware instead. Costs ~5ms DynamoDB GetItem per request
(or ~20ms RDS query on cache miss). A consumer with an existing
claims-cache module is already halfway there.

Benefits of C.3:

- No `featureTier` dependency at all (could even drop the
  pre-token-gen Lambda entirely).
- Custom claims are always fresh (no token-TTL staleness
  window).
- The custom attributes don't even need to be declared on the
  pool — the consumer owns the claim surface end-to-end.
- Tenant suspension propagates immediately (no cache-TTL gap).

Cost of C.3:

- Per-request RDS/DDB hit. At 100 req/s and 5ms DDB GetItem,
  that's a 500-RCU/s budget — modest.
- Need short-lived in-process cache to avoid hammering DDB on
  bursty traffic.
- The pre-token-gen Lambda becomes near-redundant; could keep
  it just for federated-role-refresh-on-token-issuance (the
  part of the current Lambda that maps `custom:idpGroups` →
  TenantRoleMapping). Or move that to middleware too.

### Recommended sub-variant: C.3

C.1 is the smallest diff but introduces an unconventional auth
shape. C.3 is the cleanest long-term design: tokens are for
authn, authorization claims are resolved per-request.
Per-request cost is real but bounded.

### What stays simpler in C

- One pool, one user, one schema. No `cognitoPoolKey` column.
  No two-account-per-human UX problem.
- B2C and B2B federation coexist on a single pool as
  vestibulum's design supports.
- `/auth/discover` returns one of `{magic-link, idp}` — no
  pool selection.
- Lowest MAU rate at all scales.

### What gets harder in C

- Claim-resolution logic moves from pre-token-gen Lambda
  (inside the auth boundary) to API middleware (request-time).
  This is a real refactor for any consumer that currently
  embeds claims at issuance.
- Per-request claim resolution adds latency (small, bounded).
- The federation-role-refresh logic in the current Lambda
  needs to move somewhere — most likely the same middleware
  path.
- If a third-party service ever needs to verify the consumer's
  tokens and read tenant claims, it has to call the consumer's
  API to resolve them rather than reading the JWT — less
  self-contained.

## Trade-off summary

| Dimension                  | Option B (two pools)                                             | Option C.3 (single Lite + middleware)              |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| Cognito MAU cost           | Lite × B2C + Essentials × B2B                                    | Lite × all                                         |
| Pool count                 | 2                                                                | 1                                                  |
| User identity              | Per-pool sub; cross-pool linking is consumer-side                | One sub, simple                                    |
| Consumer schema change     | Add `cognitoPoolKey` column                                      | None                                               |
| Lambda change              | Keep V2 Lambda for B2B; B2C pool has no Lambda or a separate one | Strip V2 features; possibly remove Lambda entirely |
| Consumer middleware change | Multi-issuer dispatcher                                          | Per-request claim resolution                       |
| API auth latency           | Token verification only                                          | Token + claim resolution (~5ms)                    |
| Federation IdP CRUD        | B2B pool only                                                    | Same pool, no change                               |
| Claim freshness            | Token-TTL-bounded                                                | Per-request, always fresh                          |
| Cross-pool user UX         | Explicit separation by design (two accounts per dual-role human) | Doesn't exist                                      |
| vestibulum design fit      | Two `MagicLinkIdentity` instances; supported                     | Direct fit, single instance                        |
| Cognito feature surface    | V2 events available on B2B                                       | V1 only; access-token customisation unavailable    |

## Recommendation framework

With the separate-accounts constraint settled, both options are
clean architecturally. The choice is between **paying slightly
more Cognito MAU cost** (B) versus **doing a consumer API
middleware refactor** (C.3).

Pick **B** if:

- The consumer-side claim-resolution refactor (moving from
  pre-token-gen Lambda to per-request middleware) is a
  non-trivial delivery risk you'd rather avoid.
- Keeping token-embedded custom claims is preferred — e.g.,
  for downstream consumers (third-party APIs, edge logic) that
  read the consumer's tokens without calling back to resolve
  claims.
- Operations is comfortable running two Cognito pools.
- The B2B MAU count stays small enough that the Essentials
  premium is bounded in absolute terms.

Pick **C.3** if:

- Long-term cost matters more than near-term delivery speed
  (B2C scales linearly, and at high MAU C.3 keeps the whole
  population on Lite).
- One pool is operationally simpler than two even though the
  per-pool work is vestibulum-managed.
- Per-request claim resolution latency (~5ms DDB) is
  acceptable in the API hot path.
- The consumer is willing to invest in moving claim-resolution
  logic from the pre-token-gen Lambda to API middleware.

**Default recommendation: B.** With separate accounts accepted,
the cross-pool problem vanishes and B becomes the lower-risk
path — the consumer's existing pre-token-gen Lambda keeps
working on the B2B pool, no API middleware refactor is
required, and the Essentials cost applies only to the B2B
subset of users (the smaller population in typical SaaS
shapes). C.3 remains the right call if cost at scale dominates
or if the API team wants to invest in the cleaner long-term
architecture, but it introduces real refactor risk that B does
not.

## Open questions

These remain open under the chosen Option B direction:

- **B2B pool bootstrap.** The first admin of a B2B tenant
  needs to sign in _before_ their IdP is configured
  (chicken-and-egg: federation requires the IdP record, which
  the admin creates). Options: (a) the B2B pool keeps a
  `MagicLinkAuthSite` reserved for bootstrap admins only,
  (b) admins are pre-created out-of-band by support, (c)
  admins use their B2C account to set up the B2B tenant, then
  switch to federated B2B sign-in. Choose per-deployment.
- **Shared SES identity across pools or per-pool?** Both work;
  per-pool is the cleaner default (each pool's bounce
  handling is isolated). Worth confirming with ops before
  deploy.
- **B2B pool MAU rate at the boundary.** Some Cognito features
  (e.g., advanced security) may be tier-gated separately from
  V2/V3 trigger events. Verify the exact Essentials feature
  set against the consumer's needs before committing the
  tier.

## Status

**Decided: Option B (two pools).** Settled in the upstream
design conversation following the separate-B2C-and-B2B-accounts
constraint acceptance. The B2C pool runs on Lite with
magic-link only; the B2B pool runs on Essentials with
federation only.

The trellis-side integration
([`../08-trellis-migration.md`](../08-trellis-migration.md))
describes the two-pool topology — see that doc for the
concrete schema, CDK, and middleware changes.

`@de-otio/vestibulum-cdk` supports the two-pool topology today
via the existing `featureTier` prop and the multi-instance
pattern; no vestibulum-side changes are required.

Option C.3 remains documented above as the alternative if the
cost trade-off shifts at scale (e.g., very high B2C MAU and a
willingness to do the API middleware refactor); the analysis
is not deleted, just deselected.
