# 09 — Implementation plan

Maximally-parallel plan for landing the shared-distribution v0.2
design as `@de-otio/vestibulum` runtime additions +
`@de-otio/vestibulum-cdk` construct additions. Targets the same
machine envelope as v0.1's
[`../../11-implementation-plan.md`](../../11-implementation-plan.md).
Inherits the 80 % coverage threshold and frozen-set discipline; the
review's 21 decisions and 21 review findings are pre-integrated into
the design docs.

## Constraints (same as v0.1)

### Machine

Apple M2 Pro, 12 cores (8P + 4E), 32 GB RAM. Concurrency envelope:
~4 concurrent agents, ~4–6 vitest workers each at 1 GB/process,
~16–24 test processes total. One agent at a time for shared-state
mutations (root `package.json`, `.changeset/`, frozen-set files).

### Coverage

**80 % line, function, branch, statement coverage** per modified
file, enforced by `vitest --coverage` (v8 provider) + CI gate. Plus,
specific to v0.2:

- **100 % branch coverage on the edge-function `check-auth` handler.**
  This is the load-bearing security surface. Every refuse-reason
  branch is property-tested and unit-tested.
- **100 % branch coverage on `wrapPreTokenHandler`.** Each of the
  three contract-enforcement assertions (overrides, suppressions,
  missing config) requires a positive and negative test.
- **fast-check property tests pinned to seed `0xc0ffee`,
  `numRuns: 1000`** for the cross-tenant rejection properties (see
  [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) §
  required property tests).

### Coordination

The frozen-set
([`../../04-shared-vocabulary.md`](../../04-shared-vocabulary.md))
gains two types in v0.2:

- `TenantSubdomain` — branded string for the tenant subdomain
  shape (frozen-set member).
- `ClientConfigRow` — the `ClientConfig` table item shape (frozen
  for consumer-facing API).

These are added in P0; all subsequent phases treat them as
sacrosanct.

Outside the frozen-set, no cross-agent file contention is expected
because v0.2 adds files rather than modifying v0.1 files. The
exceptions are:

- `packages/vestibulum/src/index.ts` — exports a new module barrel.
- `packages/vestibulum-cdk/lib/index.ts` — exports new construct.
- `packages/vestibulum-cdk/package.json` — adds new bundle entries.

Each of these is touched once, by the coordinator agent, after the
parallel-agent work returns.

## Parallelization topology

```
P0 ─────► P1 ──┬──► P2 ──┬──► P3 ──► P4 ──► P5
   (serial)    │         │
   frozen-set  │ runtime │ CDK
   + skeleton  │ side    │ side
               │ (3 ag-  │ (3 ag-
               │  ents)  │  ents)
```

### P0 — Frozen-set + skeleton (1 agent, serial, ~30 min)

**Owner:** Sonnet
**Deps:** v0.1 merged

Tasks:

- Add `TenantSubdomain` and `ClientConfigRow` to the frozen-set
  module (`packages/foundation/src/types/frozen/`). Brand checker +
  100 % coverage. CI fanout gate updated.
- Create directory skeletons:
  - `packages/vestibulum/src/lambda/shared-distribution/` (handlers
    + wrapper + helpers).
  - `packages/vestibulum-cdk/lib/shared-distribution-identity/`
    (construct + sub-components).
  - `packages/vestibulum-cdk/scripts/lambda-entries/` (new bundle
    entries).
- Add stub `package.json` exports for both packages so downstream
  tasks can import.
- Bump both packages' versions in `.changeset/` to `0.2.0-beta.0`.

Acceptance: empty modules build, tests run (zero tests, 100 %
coverage trivially), lint passes.

### P1 — Runtime modules (3 agents, parallel, ~3 h)

Three independent agents on three module groups. No cross-file
contention.

#### P1a — Shared helpers (Sonnet, ~2 h)

`packages/vestibulum/src/lambda/shared-distribution/shared/`:

- `client-config-loader.ts` — DDB read + 5-min TTL cache (carryover
  from prototype). 80 % coverage.
- `ttl-cache.ts` — promise-only cache, no `undefined` race
  (review fix N2). Property tests for resolution, expiry,
  coalescing, error eviction. 100 % branch coverage.
- `extract-tenant-subdomain.ts` — including trailing-dot fix and
  all 11 test cases from
  [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) §
  subdomain extraction.
- `wrap-pre-token-handler.ts` — wrapper with override AND
  suppression guards (review fixes B1).

Tests: unit + property tests for each. Total ~40 tests.

#### P1b — Cognito trigger handlers (Sonnet, ~2 h)

`packages/vestibulum/src/lambda/shared-distribution/triggers/`:

- `pre-signup.ts` — reads `ClientConfig`, fail-closed on DDB error
  (carryover from prototype + per-client allowlist semantics).
- `create-auth-challenge.ts` — same shape, fail-closed.
- `pre-token-generation.ts` — built-in handler that injects
  `custom:tenant_id`; uses `wrapPreTokenHandler` internally for
  symmetry with the consumer-customisation pattern.
- `auth-verify.ts` — refresh-token flow via
  `GetTokensFromRefreshToken` (review fix B5), not
  `REFRESH_TOKEN_AUTH`.
- `auth-signout.ts` — Host-aware cookie-clear.

Tests: unit tests with `aws-sdk-client-mock` for Cognito and DDB.
Required fail-closed tests for every handler that reads DDB. ~80
tests total.

#### P1c — Edge `check-auth` handler (Opus, ~3 h)

`packages/vestibulum/src/lambda/shared-distribution/edge/`:

- `check-auth.ts` — the full multi-`aud` edge function:
  - `extractTenantSubdomain` (imported from shared).
  - JWT verify with `iss` pin, RS256-only.
  - `token_use === 'id'` (review fix N6).
  - `Host` ↔ `custom:tenant_id` structural binding.
  - JWKS cache with full-replace-on-refresh semantics
    (review fix H6).
- `edge-config-types.ts` — type declarations for the generated
  `edge-config.ts` module that the bundle pipeline writes.

Tests required (Opus because this is the load-bearing security
surface):

- Unit tests for every refuse reason (`no-host`,
  `host-not-tenant-shape`, `tenant-mismatch`, `no-tenant-claim`,
  `wrong-iss`, `wrong-token-use`, `bad-signature`, `expired`).
- Property tests:
  - Cross-tenant rejection: token for A presented at B → refuse.
  - Missing claim: token without `custom:tenant_id` → refuse.
  - Wrong key: signed with wrong key → refuse.
  - Wrong issuer → refuse.
  - Expired → refuse.
  - Access token (`token_use: 'access'`) → refuse.
- 100 % branch coverage. CI gate fails below 100 % on this file.

### P2 — CDK constructs (3 agents, parallel, ~4 h)

Three agents on three sub-component groups within
`packages/vestibulum-cdk/lib/shared-distribution-identity/`. No
cross-file contention between sub-components.

#### P2a — Core identity construct (Opus, ~3 h)

`shared-distribution-identity/identity.ts`:

- The main `SharedDistributionIdentity` construct.
- Shared Cognito user pool with the v0.2 settings (refresh-token
  rotation enabled, `ALLOW_REFRESH_TOKEN_AUTH` excluded).
- `ClientConfig` table with `AWS_MANAGED` encryption default,
  customer-managed KMS option (review fix N4).
- `MagicLinkTokens` table (carryover from single-tenant, same
  encryption posture).
- Subdomain + tenantId reservation table with TTL.
- Trigger-Lambda wiring (PreSignUp, CreateAuthChallenge,
  PreTokenGeneration, DefineAuthChallenge,
  VerifyAuthChallengeResponse).
- Admin Lambda + Function URL with Oct-2025 dual-permission grant
  (review fix H8).

cdk-nag snapshot test required; pass list of documented
intentional violations.

Tests: synth snapshot + ~40 unit tests covering construct props,
removalPolicy, KMS key wiring, IAM grants.

#### P2b — CloudFront + edge + WAF (Opus, ~3 h)

`shared-distribution-identity/edge.ts`,
`shared-distribution-identity/waf.ts`,
`shared-distribution-identity/security-headers.ts`:

- CloudFront distribution with wildcard cert.
- Lambda@Edge `check-auth` function via
  `cloudfront.experimental.EdgeFunction` (enforces no-env-vars).
- Bundle generator that writes
  `lambda-bundles/check-auth/generated/edge-config.ts` at synth
  time (review fix B4).
- CloudFront WAF web ACL with default rules (per-IP rate limit,
  AWS Managed Rules) — review fix H2.
- Cognito-pool WAF web ACL with rate-limit on `InitiateAuth` and
  `SignUp` — review fix H3.
- `ResponseHeadersPolicy` with HSTS, CSP, X-Frame-Options, etc.
  — review fix H4.

Tests: synth snapshots, cdk-nag passes, WAF rule presence
assertions, security-header policy assertions. ~50 tests.

#### P2c — Admin Lambda + reconciler (Sonnet, ~2 h)

`shared-distribution-identity/admin-lambda.ts`,
`shared-distribution-identity/reconciler.ts`:

- Admin Lambda code: discriminated-union request parsing with Zod
  (review fix N7), all five actions with the corrected flows
  (tenantId immutable, idempotency-key composite, reservation
  TTL condition, compensation metric).
- Reconciler Lambda: hourly EventBridge schedule, orphan-detection
  logic, CloudWatch metric emission.
- CloudWatch alarms: `AllowlistChanged` zero-delay,
  `CompensationTriggered` zero-delay, `OrphanedAppClients` 1-h
  sustain.
- Function URL with AWS_IAM auth + Oct-2025 grants.

Tests: ~50 unit tests with `aws-sdk-client-mock`.
Specifically required:
- `createTenant` reservation TTL race (concurrent calls →
  one wins).
- `createTenant` compensation (Cognito succeeds, DDB fails →
  client deleted).
- `updateTenant` rejects `tenantId` mutation (Zod strict parse).
- `deleteTenant` with `revokeActiveSessions: true` calls
  `AdminUserGlobalSignOut` per user.
- Idempotency-key mismatch → 409.
- Unknown action → 400 with `UNKNOWN_ACTION`.

### P3 — Integration (1 agent, ~2 h)

**Owner:** Sonnet
**Deps:** P1 + P2 all-merged

Tasks:

- Wire P1 runtime modules into P2 constructs via bundle pipeline
  (`scripts/lambda-entries/` + `scripts/build-bundles.ts`).
- Update `lambda-bundles.lock.json` with new bundle hashes.
- Add new construct + helper exports to package barrels
  (`packages/vestibulum/src/index.ts`,
  `packages/vestibulum-cdk/lib/index.ts`).
- Update `package.json` exports maps.

cdk-nag snapshot tests run end-to-end. Bundle verifier
(`scripts/verify-bundles.ts`) runs against the lock manifest.

### P4 — Examples app (1 agent, ~3 h)

**Owner:** Opus
**Deps:** P3 merged

Build `examples/shared-distribution/`:

- `bin/app.ts` instantiating `SharedDistributionIdentity` with
  realistic props (configurable parent subdomain, demo
  `adminInvokePrincipal`).
- `cdk synth` runs cleanly.
- README walks an operator through synth → deploy → onboard a
  tenant via the admin Function URL.
- Two demo subdomains pre-configured so the synth output is
  representative.

CI workflow: `cdk synth` on every PR against the example app
(synth-only, the pattern the root `examples/` apps follow).

### P5 — Fix-up + publish (1 agent, ~2 h)

**Owner:** Sonnet
**Deps:** P4 merged

Tasks:

- Run full test suite: typecheck, lint, coverage, cdk-nag
  snapshots.
- Address any failures from the integration.
- Generate per-package `CHANGELOG.md` entries via
  `npx changeset`.
- Pre-flight check on the publish workflow (Node 24, public-repo
  provenance, etc., per global CLAUDE.md).
- Mark version `0.2.0` (final).

## MCP consultation checkpoints

Same pattern as v0.1: agents consult `aws-knowledge` and `aws-iac`
MCP servers at fixed points to avoid AWS-specific mistakes.

| Checkpoint | Phase / agent | Topic                                                                   |
| ---------- | ------------- | ----------------------------------------------------------------------- |
| C1         | P1c (Opus)    | Lambda@Edge restrictions: confirm bundle-baked config pattern           |
| C2         | P2a (Opus)    | Cognito V1 PreTokenGeneration claim format + refresh-token rotation API |
| C3         | P2b (Opus)    | CloudFront `EdgeFunction` construct vs. manual edge wiring              |
| C4         | P2b (Opus)    | WAF managed rule group names (the exact ARNs change)                    |
| C5         | P2c (Sonnet)  | Function URL `lambda:InvokedViaFunctionUrl` condition key syntax        |
| C6         | P3            | `verify-bundles` cross-region invocation patterns                       |

If a checkpoint reveals a design assumption that's wrong, the agent
opens a HIGH-severity finding for human review before continuing.

## Risk register

| Risk                                                                    | Probability | Impact | Mitigation                                                                                       |
| ----------------------------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------ |
| `EdgeFunction` construct's no-env-vars enforcement throws unexpectedly  | LOW         | LOW    | C1 confirms; bundle-baked pattern is well-trodden                                                |
| Cognito refresh-token-rotation API differs from documented shape         | MEDIUM      | MEDIUM | C2 confirms; rotate-back to `InitiateAuth(REFRESH_TOKEN_AUTH)` only if rotation API is broken    |
| WAF Managed Rule ARN drift between regions                              | LOW         | LOW    | C4 confirms current ARNs; CDK pattern handles this with the `wafv2` managed rules helper         |
| cdk-nag false-positives on shared distribution constructs                | MEDIUM      | LOW    | Document each suppression in `cdk-nag-suppressions.md`; same approach as v0.1                    |
| Bundle pipeline complexity (generated config files) breaks reproducibility | MEDIUM    | HIGH   | Tests in P3 + `verify-bundles` end-to-end run; hash-mismatch on rerun = fail-loud                |
| Edge function property tests fail on cross-tenant rejection             | LOW         | HIGH   | Property tests are the gating CI check; failure blocks merge regardless of phase                 |
| Admin Lambda dual-permission grant (Oct-2025 change) syntax-mismatched    | MEDIUM      | MEDIUM | C5 + dedicated test in P2c                                                                       |

## Acceptance criteria for v0.2 publish

- [ ] All four packages typecheck under the project-reference graph.
- [ ] All tests pass; coverage gate green on every file.
- [ ] 100 % branch coverage on `check-auth` and
      `wrapPreTokenHandler`.
- [ ] cdk-nag snapshot test passes for `SharedDistributionIdentity`
      with documented suppressions.
- [ ] Property tests (cross-tenant rejection, etc.) pass on the
      pinned seed.
- [ ] `verify-bundles` end-to-end passes (re-builds in tmpdir +
      lock manifest match).
- [ ] Examples app synthesises cleanly; CI gate green.
- [ ] All 21 review decisions are reflected in the code (verified
      by reading the integration commit against the review doc).
- [ ] Pre-flight check on publish workflow passes (Node 24,
      provenance, etc., per global CLAUDE.md).
- [ ] CHANGELOG entries written for both
      `@de-otio/vestibulum@0.2.0` and
      `@de-otio/vestibulum-cdk@0.2.0`.

## Wall-clock estimate

If P1a, P1b, P1c run in parallel (~3 h max) and P2a, P2b, P2c run
in parallel (~3 h max) on the machine envelope above:

```
P0 (30 min)
P1 (3 h, parallel) ──┐
P2 (3 h, parallel) ──┤
P3 (2 h)             │
P4 (3 h)             │
P5 (2 h)             │
                     ▼
Total wall-clock:  ~13.5 h, mostly compute-bound on test+synth.
```

Single-agent serial estimate: ~25 h. Parallelisation buys ~45 %.

## Model assignments summary

- **Opus**: P1c (edge `check-auth`), P2a (identity construct), P2b
  (CloudFront + edge + WAF), P4 (examples app).
- **Sonnet**: P0 (skeleton), P1a (shared helpers), P1b (trigger
  handlers), P2c (admin Lambda + reconciler), P3 (integration), P5
  (publish prep).
- **Haiku**: not used. The work is sufficiently load-bearing-
  per-task that the cost differential isn't worth the risk.

## What happens after publish

Same chain as v0.1's
[`../../12-remaining-work.md`](../../12-remaining-work.md): per-
package READMEs, CI dry-run, commit/PR strategy, examples-app smoke
test. These are mechanical post-implementation tasks; not part of
the implementation plan.

When v0.2 is published, the standalone vestibulum clone at
`/Users/rmyers/repos/dot/vestibulum/` is fully obsolete and can be
deleted (per
[`../08-shared-pool-multi-tenancy.md`](../08-shared-pool-multi-tenancy.md)
§ Recommendation).
