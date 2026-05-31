# 11 — Implementation plan

> Status: Executed — historical build-order record. See doc/12 for current state.

The synthesis doc. Sequences the work described across
[`07-vestibulum-migration.md`](07-vestibulum-migration.md),
[`08-trellis-migration.md`](08-trellis-migration.md), and the
per-package designs into a concrete, maximally-parallelized plan
sized to this machine. Assigns each unit of work to the appropriate
Claude model, bakes in the 80% test-coverage threshold, and names
the MCP consultation checkpoints.

## Constraints

### Machine

Apple M2 Pro, 12 cores (8 performance + 4 efficiency), 32 GB RAM.

Realistic concurrency envelope (after measurement on similar
AI-maintained TypeScript projects):

- **~4 concurrent Claude Code agents** at peak without saturating
  the responsiveness of the host. Each agent's own footprint is
  modest; the load comes from the test/build processes the agents
  spawn.
- **~4–6 vitest workers per agent** at 1 GB/process. That's ~16–24
  test processes total under the cap, ~16–24 GB peak.
- **One agent at a time for shared-state mutations** (root
  `package.json`, root `tsconfig.json`, `.changeset/`, frozen-set
  files). Everything else parallelizes.

The trellis `apps/api` test process uses 4 GB because of Prisma +
large fixtures. Foundation tests are lighter — no Prisma in the
runtime modules (Prisma sub-paths are isolated), no fixture data of
that scale. Budget 1 GB/test-process; raise per-module if a real
measurement shows otherwise.

### Coordination

The frozen-set ([`04-shared-vocabulary.md`](04-shared-vocabulary.md))
is the single point of cross-agent contention. Two agents editing
frozen types simultaneously is a guaranteed merge conflict and a
silent type-identity bug. Rule: **frozen-set work is serialized in
Phase 1; subsequent phases treat the frozen set as sacrosanct**
(the CI fanout gate enforces). Outside the frozen set, agents own
their package + module and do not cross.

### Coverage

**80% line, function, branch, statement coverage** per package
([`02-monorepo-layout.md § Test framework`](02-monorepo-layout.md#test-framework)).
Enforced by `vitest --coverage` threshold config (`v8` provider) and
a CI gate that fails the build when any threshold drops below 80%.
The threshold applies to _new and modified files_ in a PR — existing
files that fall below 80% trigger a soft warning, not a failure (so
incremental adoption doesn't gate on retrofitting the whole repo).

Property-based tests count toward coverage where they exercise the
code path; AI-generated unit tests count too. Coverage of pure
functions is cheap (one input → one output); coverage of the impure
boundaries (AWS SDK calls, ALS, network) is achieved via
`aws-sdk-client-mock` and `undici`'s `MockAgent`, both already
established in trellis and vestibulum.

## Parallelization topology

The dependency graph below shows what can run in parallel and where
the hard ordering kicks in. Layer numbers match
[`03-package-relationships.md § Cycle prevention`](03-package-relationships.md#cycle-prevention).

```
P0 (serial) ───►  P1 (serial) ──┬─►  P2  ──┬─►  P3  ──┬─►  P4  ──►  P5
                                │          │          │
   skeleton          frozen set │ founda-  │ founda-  │ founda-
   + tooling         brand      │ tion L1  │ tion L2  │ tion L3
                     checkers   │ (6 mods) │ (3 mods) │ (4 mods)
                                │          │          │
                                ├─► founda-┼──────────┴──────►
                                │ tion-cdk │ (independent)
                                │ (4 cons- │
                                │ tructs + │
                                │ aspects) │
                                │          │
                                └─►        ├─► vestibulum  ──► vestibulum-cdk
                                           │ runtime           bundle pipeline
                                           │ (migration        + constructs
                                           │ from existing     (depends on
                                           │ repo)             vestibulum at
                                                               build time)
```

Concretely: P0 and P1 are serial. P2 onward runs in parallel,
constrained by the ~4-agent / 32 GB machine cap.

## Phases

Each phase identifies the work units, the model that should do the
work, the agent count, and the acceptance criteria. Times are
elapsed wall-clock at ~4-agent concurrency; "model-hours" is the
cumulative compute time across all agents.

### P0 — Tooling skeleton (1 agent, ~1 hour wall-clock)

**Goal:** Repo composes and builds even though no module has code yet.

| Task                                                                                                                                  | Model      | Acceptance                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `package.json`, workspaces, `.nvmrc`, `.gitignore`, `LICENSE`                                                                    | **Haiku**  | `npm install` succeeds; `npm test` exits 0 (no tests yet); `npm run typecheck` exits 0 (no source yet)                                                    |
| `tsconfig.base.json`, root `tsconfig.json` (project references), per-package `tsconfig.json`                                          | **Sonnet** | `tsc --build` exits 0 across the workspace graph                                                                                                          |
| ESLint root + per-package overrides (cross-package import ban, foundation-cdk no-value-imports-of-foundation rule)                    | **Sonnet** | `npm run lint` exits 0; ESLint correctly errors on a hand-crafted violation in `packages/foundation/test/eslint-fixtures/cross-package-import.ts.fixture` |
| Prettier config (transplant from trellis)                                                                                             | **Haiku**  | `npm run format` exits 0                                                                                                                                  |
| Vitest workspace config + per-package vitest config                                                                                   | **Sonnet** | `npm test` exits 0; `vitest --coverage` produces a report (empty); coverage thresholds wired                                                              |
| `scripts/build/topo.mjs`, `scripts/ci/check-changesets.ts`, `scripts/ci/check-frozen-fanout.ts`, `scripts/ci/check-peerdep-ranges.ts` | **Sonnet** | Each script runs on a hand-crafted input fixture; CI YAML wires them as gates                                                                             |
| `.changeset/` init + first empty changeset for the skeleton PR                                                                        | **Haiku**  | `changeset version` is a no-op                                                                                                                            |
| `.github/workflows/{ci,publish,release}.yml`                                                                                          | **Sonnet** | Workflow lint passes; OIDC trusted-publisher block per [user-global notes](../../../.claude/CLAUDE.md) (Node 24, no `NODE_AUTH_TOKEN`, `registry-url`)    |

**Single agent, serial work, ~1 hour.** This is the only phase that
must be 1 agent — the root `package.json` and tsconfig changes are
small but interlocking; concurrent edits create merge conflicts for
no parallelism gain. Use **Sonnet** for the agent (most tasks are
Sonnet-class; the few Haiku tasks fold into Sonnet's working window
without measurable cost).

**MCP checkpoint:** Verify `Runtime.NODEJS_LATEST` vs pinned `NODEJS_24_X`
in the `.github/workflows` Node setup matches what the constructs
will pin ([`foundation-cdk/02-nodejs-lambda.md`](foundation-cdk/02-nodejs-lambda.md)).

### P1 — Frozen set + brand checkers (1 agent, ~1 hour wall-clock)

**Goal:** Cross-package types exist; nothing else depends on a
later phase.

| Task                                                                                                                               | Model      | Acceptance                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/foundation/src/types/frozen/{tenant,audit,request-context,secrets}.ts` — type definitions + brand checkers + Zod schemas | **Opus**   | Each type matches [`04-shared-vocabulary.md`](04-shared-vocabulary.md) verbatim; brand checkers enforce documented constraints; all interfaces are `readonly`/`Readonly<>` per [`10-ai-maintained-conventions.md § Immutability is the default`](10-ai-maintained-conventions.md#1-immutability-is-the-default) |
| `packages/vestibulum/src/types/frozen/callbacks.ts` — `ClaimResolverInput`, `ClaimResolverOutput`, `ProvisionerInput`              | **Opus**   | Same                                                                                                                                                                                                                                                                                                            |
| Property-based tests via `fast-check` for every brand checker                                                                      | **Sonnet** | 1000-input fuzz per checker; valid + invalid generators; round-trip invariants; coverage ≥ 95% on the brand-checker files                                                                                                                                                                                       |
| Frozen-fanout CI gate end-to-end test against a fixture diff                                                                       | **Sonnet** | Gate fires on a synthetic frozen-set diff that lacks the cross-package changeset; passes when changesets are present in all dependent packages                                                                                                                                                                  |

**Single agent, serial, ~1 hour.** Frozen-set work is the highest-
stakes type-system code in the repo (one mistake ripples everywhere)
and it's a small surface — Opus is correct here. The tests fall to
Sonnet because the patterns are mechanical once the types exist.

After P1 the frozen set is **closed for v0.1 unless a per-RFC
re-opening**; subsequent agents read frozen types but do not write
them.

### P2 — Foundation L1 modules + foundation-cdk constructs (4 agents in parallel, ~3 hours wall-clock)

**Goal:** Cloud primitives and CDK constructs exist; layer-1
foundation depends only on the frozen set.

**Agent A (Opus)** — security/crypto primitives:

- `foundation/src/secrets/` (~600 LOC + tests). MCP checkpoint:
  AWS SDK v3 SSM/Secrets Manager client init patterns; least-privilege
  IAM grant.
- `foundation/src/session/` (AES-GCM cookie crypto, the encryption
  layer of trellis `session-manager.ts`, ~400 LOC). PBKDF2 iterations
  raised to OWASP 2023 (600k) per first-review S-Sec4.

**Agent B (Sonnet)** — cloud shims (mechanical translation from trellis):

- `foundation/src/kv/` (DynamoDB shim, Cloudflare-`KVNamespace`-compat).
  MCP checkpoint: DynamoDB v3 client config for retries (cockatiel
  policy per first-review S-F).
- `foundation/src/queue/` (SQS shim).
- `foundation/src/storage/` (S3 shim).

**Agent C (Sonnet)** — observability primitives:

- `foundation/src/logger/` (pino-backed, ALS-bound child).
- `foundation/src/request-context/` (AsyncLocalStorage carrier).
- `foundation/src/net/` (`trustedClientIp`, IP allowlist with the
  TEST-NET-1/2/3 + Class E + broadcast entries from first-review B-E).

**Agent D (Sonnet)** — foundation-cdk constructs (independent of runtime):

- `foundation-cdk/lib/queue-with-dlq/` + tests.
- `foundation-cdk/lib/single-table/` + tests. MCP checkpoint:
  DynamoDB PITR billing semantics (already in
  [`foundation-cdk/04-single-table.md`](foundation-cdk/04-single-table.md));
  confirm the cost figures still match docs at implementation time.
- `foundation-cdk/lib/dashboards/` + JSON templates transplanted
  from trellis-platform.

**Acceptance criteria across P2:**

- 80% coverage on every new file in every module.
- `npm test` passes across the workspace.
- `aws-sdk-client-mock` used for AWS SDK boundaries; no real network.
- Property-based tests for any new validator or shape predicate.
- Determinism rules ([§ Determinism rules](02-monorepo-layout.md#determinism-rules))
  observed — no time-of-day, no unseeded random, snapshot inputs pinned.

**Why this parallelism:** the four streams have zero cross-stream
imports during P2. Agent A reads `tenant/index.ts` (will exist as a
stub barrel; the implementation lands in P3) but not its types. Agent
D reads no foundation runtime at all. Coordination is via the
shared `package.json` only, and additions there are append-only
during P2.

### P3 — Foundation L2 modules + vestibulum runtime migration + foundation-cdk Lambda construct (4 agents in parallel, ~3 hours wall-clock)

**Goal:** Identity-adjacent foundation modules + vestibulum runtime
folded into the monorepo + the most security-sensitive
foundation-cdk construct.

**Agent A (Opus)** — multi-tenancy + audit (security-critical):

- `foundation/src/tenant/` (resolver + AsyncLocalStorage carrier;
  cut to Subdomain + CustomDomain + Composite per first-review H-2).
- `foundation/src/audit/` (append-only event log with
  `DynamoAuditStore` + `MultiAuditStore` + `PiiFilter`; Put-only IAM
  grant documented per first-review H-1; `emitAwait` shape per
  S-F15).
- `foundation/src/audit/prisma.ts` sub-path (`PostgresAuditStore`,
  isolated import to keep the optional peer working).

**Agent B (Sonnet)** — vestibulum runtime migration (mechanical-ish,
many files):

- Per [`07-vestibulum-migration.md`](07-vestibulum-migration.md), fold
  the standalone `vestibulum` repo into `packages/vestibulum/`.
- Port from jest to vitest (`vi.fn()`, `vi.mock`, `aws-sdk-client-mock-vitest`).
- Move lambda handlers from `lib/lambda-handlers/` + `lib/lambda-edge/`
  into `packages/vestibulum/src/lambda/` and add the eight factory
  exports per first-review B-B.

**Agent C (Opus)** — `NodejsLambda` construct (security-relevant
because it sets X-Ray, encryption, alarm defaults that affect every
deployed Lambda):

- `foundation-cdk/lib/nodejs-lambda/` per
  [`foundation-cdk/02-nodejs-lambda.md`](foundation-cdk/02-nodejs-lambda.md).
- The Prisma bundling helper.
- The X-Ray-VPC reachability synth check.
- The `addQueueIteratorAgeAlarm` method.

**Agent D (Sonnet)** — `HouseDefaultsAspect`:

- `foundation-cdk/lib/aspects/` per
  [`foundation-cdk/06-aspects.md`](foundation-cdk/06-aspects.md).
- cdk-nag snapshot test fixtures for the three v0.1 constructs.

**MCP checkpoints during P3:**

- DynamoDB on-demand vs provisioned at audit-log scale (Agent A).
- Cognito user pool + Hosted UI provisioning patterns (Agent B,
  for the runtime triggers — though full vestibulum-cdk lands in P5).
- Lambda Powertools testing patterns for `aws-sdk-client-mock` use
  ([source](https://docs.aws.amazon.com/powertools/typescript/latest/contributing/testing/)).

**Acceptance criteria:** same as P2; plus the audit-log Put-only IAM
grant must be encoded in the construct (a CI lint rejects
`UpdateItem`/`DeleteItem` in any file under `src/audit/`).

### P4 — Foundation L3 modules + vestibulum identity flows (3 agents in parallel, ~2 hours wall-clock)

**Goal:** Operational primitives + identity provider flows complete.
Foundation runtime is feature-complete after P4.

**Agent A (Sonnet)** — foundation operational primitives:

- `foundation/src/rate-limit/` (KV-backed token bucket; consider
  `@upstash/ratelimit` swap per first-review S-F8 — decision logged
  in implementation PR).
- `foundation/src/feature-toggles/` (in-memory + Prisma sub-path
  isolation).
- `foundation/src/region/` (detection + residency).

**Agent B (Opus)** — vestibulum IdP federation (security-sensitive):

- `vestibulum/src/oidc/` — issuer probe with SSRF defence (IPv4
  allowlist with TEST-NET-1/2/3 + Class E + broadcast).
- `vestibulum/src/saml/` — metadata parser, signing-cert rotation.
- `vestibulum/src/triggers/` — pre-token-generation,
  post-confirmation Lambda templates.
- The select-by-iss multi-pool JWT verifier per first-review B-J.

**Agent C (Sonnet)** — vestibulum admin + pool topology:

- `vestibulum/src/pools/` — B2C/B2B pool separation per
  [`vestibulum/06-pool-topology.md`](vestibulum/06-pool-topology.md).
- `vestibulum/src/scim/` reserved namespace per
  [`vestibulum/07-scim-forward-compat.md`](vestibulum/07-scim-forward-compat.md).
- Vestibulum CRUD operations (`OidcIdpManager`, `SamlIdpManager`,
  `IdpSecretsClient`).

**MCP checkpoints during P4:**

- Cognito custom attribute mutability — confirm the
  AdminLinkProviderForUser empirical claim
  ([second-review N3](review/2026-05-24-foundation-cdk-and-aws-verification.md))
  against a real test pool before treating it as a hard-error in
  the federation aspect.
- WAF managed rule groups pricing and rate-limit-per-IP semantics
  for the edge-resources design (lands in P5; the data informs the
  defaults).

### P5 — Vestibulum-cdk (3 agents in parallel, ~3 hours wall-clock)

**Goal:** Magic-link CDK topology ships. The only phase with a
build-time cross-package dependency (the Lambda bundle pipeline).

**Agent A (Opus)** — Lambda bundle pipeline + identity construct:

- `vestibulum-cdk/scripts/build-bundles.ts` and `verify-bundles.ts`
  per [`vestibulum-cdk/10-lambda-bundle-pipeline.md`](vestibulum-cdk/10-lambda-bundle-pipeline.md).
  Must produce SHA-256-hashed bundles and a committed lock manifest;
  the verify gate fails on hash drift.
- `vestibulum-cdk/lib/magic-link-identity/` per
  [`vestibulum-cdk/02-magic-link-identity.md`](vestibulum-cdk/02-magic-link-identity.md).
  Federation expansion, `signupMode`, custom attributes aspect with
  the empirical-pending downgrade if P4's verification fails.

**Agent B (Opus)** — edge + auth-site (Lambda@Edge — high stakes):

- `vestibulum-cdk/lib/edge-resources/` per
  [`vestibulum-cdk/03-edge-resources.md`](vestibulum-cdk/03-edge-resources.md).
  ATPRuleSet removed per first-review B-G; WAF rate-limit tightened
  to 30–60/5min on `/auth-verify` per S-C8.
- `vestibulum-cdk/lib/magic-link-auth-site/` per
  [`vestibulum-cdk/04-magic-link-auth-site.md`](vestibulum-cdk/04-magic-link-auth-site.md).
  Login pages, bounce handler, SES setup.

**Agent C (Sonnet)** — app-clients, triggers, metrics, ops:

- `vestibulum-cdk/lib/app-clients/` per
  [`vestibulum-cdk/05-app-clients.md`](vestibulum-cdk/05-app-clients.md).
- `vestibulum-cdk/lib/trigger-hooks/` per
  [`vestibulum-cdk/06-trigger-hooks.md`](vestibulum-cdk/06-trigger-hooks.md).
- Metrics + operational notes integration per `08-metrics.md` and
  `09-operational-notes.md`.

**MCP checkpoints during P5:**

- CloudFront + ACM us-east-1 cross-region pattern.
- Cognito Hosted UI domain prefix uniqueness behaviour.
- SES domain identity validation at synth (per first-review S-C11).
- `cdk_best_practices` re-check before each construct lands.

**Acceptance criteria for P5:**

- Bundle pipeline produces stable hashes across two runs from the
  same source (deterministic build).
- cdk-nag snapshot tests pass for every construct; intentional
  violations documented in the snapshot.
- Synth-only e2e: the `examples/shared-distribution/` reference
  app synthesises cleanly (no deploy in CI; deploy is a manual gate
  for the first release).
- 80% coverage on every new file.

## Test coverage strategy (80%)

### Vitest config

Each package's `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      // Threshold applies to new/modified files only.
      // Existing files below 80% emit warnings, not failures.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "src/**/types/**"],
    },
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: "fixed-per-package" },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
```

### CI gate

`.github/workflows/ci.yml` step:

```yaml
- name: Coverage gate
  run: npm test -- --coverage --reporter=verbose
  # vitest exits non-zero when any threshold drops below 80%
```

### How coverage compounds across parallel agents

Each agent's PR includes its own module's tests; the coverage
threshold applies per PR, not globally. A merged PR that drops a
sibling module's coverage (it shouldn't, because agents work on
distinct modules) trips the gate against the sibling's existing
files, which is the right outcome.

The frozen-set brand checkers from P1 should hit ≥95% (small
surface, easy to exhaust); the cloud shims and CDK constructs
should hit ~85–90% (some edge paths are AWS-error-shape branches
that aren't worth exercising); the identity flows hit 80%+ with the
aws-sdk-client-mock + undici MockAgent combination already proven
in vestibulum.

## Model-assignment summary

| Model          | Use for                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opus 4.7**   | Frozen types & brand checkers · session/secrets/audit · IdP federation (OIDC, SAML, JWT, triggers) · tenant resolver · NodejsLambda construct · MagicLinkIdentity & EdgeResources constructs · Lambda bundle pipeline                                                                                  | Security-critical, type-system-heavy, AWS-nuanced, or first-of-kind construct work where a subtle mistake compounds. Reasoning depth matters.                         |
| **Sonnet 4.6** | Cloud shims · logger/request-context/net · rate-limit/feature-toggles/region · vestibulum runtime migration · foundation-cdk QueueWithDlq/SingleTable/dashboards · HouseDefaultsAspect · vestibulum-cdk app-clients/triggers/metrics · Tooling scripts · CI workflows · Property-based test generation | Well-specified mechanical implementation work where the design doc names the shape. Sonnet matches the design with high fidelity and writes the bulk of code + tests. |
| **Haiku 4.5**  | package.json scaffolds · tsconfig files · Prettier config · CHANGELOG initial entries · barrel `index.ts` files · ESLint-fix sweeps · dashboard JSON template transplants · CDK snapshot-test boilerplate (after the first one is written)                                                             | Repetitive scaffolding with no design judgement. Throughput matters more than depth.                                                                                  |

The split is roughly **20% Opus / 65% Sonnet / 15% Haiku** by
estimated total model-time across the plan.

## MCP consultation checkpoints (consolidated)

Each marked spot below means "before the agent commits, verify the
named AWS fact via `aws-knowledge` or `aws-iac` MCP." Caller-side
verification, not LLM training knowledge.

| Phase | Module / construct                 | Verify                                                                                                                     |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P0    | CI workflow Node setup             | Lambda Node 24 vs `NODEJS_LATEST` posture matches [foundation-cdk/02-nodejs-lambda.md](foundation-cdk/02-nodejs-lambda.md) |
| P2    | `kv`, `queue`, `storage`           | AWS SDK v3 retry policy + cockatiel pairing                                                                                |
| P2    | `secrets`                          | SSM vs Secrets Manager IAM least-privilege grants                                                                          |
| P2    | `foundation-cdk/SingleTable`       | PITR cost figures (re-confirm $/GB-month)                                                                                  |
| P3    | `audit`                            | DynamoDB Put-only IAM grant shape; DDB Streams → S3 Object Lock for immutable secondary                                    |
| P3    | `NodejsLambda`                     | Lambda Powertools `aws-sdk-client-mock` patterns; X-Ray VPC interface endpoint                                             |
| P4    | `vestibulum/triggers`              | Cognito feature plan V2/V3 event versions; pre-token-generation V2 features matrix                                         |
| P4    | `vestibulum-cdk` federation aspect | `AdminLinkProviderForUser` immutable-attribute behaviour against a real test pool (resolves second-review N3)              |
| P5    | `EdgeResources`                    | WAF managed rule groups pricing + rate-limit semantics; Lambda@Edge revocation latency                                     |
| P5    | `MagicLinkAuthSite`                | SES sandbox limits, SES domain identity at synth                                                                           |
| P5    | `MagicLinkIdentity`                | Cognito Hosted UI custom domain ACM in us-east-1 requirement                                                               |
| P5    | `cdk-nag` snapshot tests           | `aws-iac__cdk_best_practices` re-run before each construct lands; document intentional violations in the snapshot          |

## Coordination and conflict avoidance

### Frozen-set discipline

After P1, no agent edits files under `src/types/frozen/` without an
RFC. The CI fanout gate enforces; reviewers (human + cdk-nag) catch
the subtler cases.

### Shared-file coordination

Three files are append-only after P0:

- Root `package.json` (workspace members, no deletions).
- Root `tsconfig.json` (project references, additions only).
- `vitest.workspace.ts` (paths, additions only).

Each phase's agents append in alphabetical order on package name to
make conflict detection mechanical. If two agents touch the same
shared file simultaneously, the second to merge rebases.

### Per-package ownership

Within a phase, agents own a package or a module exclusively. No
cross-module edits except by the trellis-migration cutover agent
(which is its own dedicated phase below) and the vestibulum-cdk
agents touching the bundle pipeline (which is the documented
cross-package build-time arrow).

### Trellis-migration cutover (separate, post-P4)

The trellis-side cutover ([`08-trellis-migration.md`](08-trellis-migration.md))
is a separate workstream that runs **after** P4 completes (foundation

- vestibulum runtime are feature-complete). It is **one PR per
  trellis lib module replacement**, 1 agent (Sonnet — mechanical
  import swaps), serial. Each PR: bump dependency, swap imports,
  delete local file, run trellis test suite. The serial constraint
  exists because the trellis test suite uses 4 GB/process per the
  trellis CLAUDE.md note; parallel cutover PRs would saturate.

### Consumer-side cutover (separate, post-P5)

Once foundation-cdk 0.1.0 ships, the trellis-platform
`infra/lib/constructs/` swap is one PR per construct (3 PRs total),
1 agent (Sonnet), serial. The consumer owns its own CI; this is out
of scope of this plan and into the consumer's release cycle.

## Estimate and rollup

| Phase     | Wall-clock           | Agents | Concurrent peak | Model split (rough)                |
| --------- | -------------------- | ------ | --------------- | ---------------------------------- |
| P0        | ~1 h                 | 1      | 1               | 1× Sonnet                          |
| P1        | ~1 h                 | 1      | 1               | 1× Opus                            |
| P2        | ~3 h                 | 4      | 4               | 1× Opus + 3× Sonnet                |
| P3        | ~3 h                 | 4      | 4               | 2× Opus + 2× Sonnet                |
| P4        | ~2 h                 | 3      | 3               | 1× Opus + 2× Sonnet                |
| P5        | ~3 h                 | 3      | 3               | 2× Opus + 1× Sonnet                |
| **Total** | **~13 h wall-clock** | —      | 4 peak          | ~20% Opus / 65% Sonnet / 15% Haiku |

These are optimistic. Realistic with the verification overhead
([`10-ai-maintained-conventions.md`](10-ai-maintained-conventions.md)
— specs first, run-discipline, push-back) is probably 1.5–2× the
nominal figure. Trellis and consumer cutovers add a tail of ~5–8
hours each at serial pace; both can proceed against a v0.1 release.

## Acceptance criteria for "v0.1 ready to publish"

The plan is complete when:

- [ ] All four packages build cleanly via `npm run build` at root.
- [ ] All tests pass: `npm test`. Coverage threshold met (80% lines/functions/branches/statements per package on new/modified files).
- [ ] `npm run typecheck` clean across the project-reference graph.
- [ ] `npm run lint` clean; the four custom ESLint rules (cross-package imports, foundation no-cdk, foundation-cdk no-value-imports-of-foundation, Prisma sub-path) enforce.
- [ ] CI gates pass: changeset gate, frozen-fanout gate, peerdep-range gate, vestibulum-cdk bundle-verify gate, cdk-nag snapshot gate.
- [ ] Frozen-set brand checkers ≥ 95% covered; identity flows ≥ 80%.
- [ ] AdminLinkProviderForUser empirical claim ([N3](review/2026-05-24-foundation-cdk-and-aws-verification.md)) confirmed against a real test pool — Aspect severity (error vs warning) reflects the result.
- [ ] `examples/shared-distribution/` synthesises cleanly.
- [ ] Each package's `README.md` includes the public API surface and a five-line consumer example.
- [ ] `CHANGELOG.md` per package lists every changeset since the skeleton PR.

## Risks and mitigations

| Risk                                                               | Likelihood | Mitigation                                                                                                                                              |
| ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen-set agent over-runs P1 and blocks P2                        | Medium     | Single agent, Opus, tight P1 scope. If P1 exceeds 2 hours, halt and split frozen-set into per-package P1a/P1b.                                          |
| Two parallel agents in P2/P3 collide on a shared file              | Low        | Append-only discipline on `package.json` / `tsconfig.json` / `vitest.workspace.ts`. Rebase the second agent.                                            |
| Vestibulum migration drift (P3 Agent B) breaks existing tests      | Medium     | Land the migration as its own PR before any code modification; only then port jest→vitest; then any behavioural change. Three PRs, not one.             |
| AWS fact stale at implementation time (CDK API drift, runtime EOL) | Low        | MCP checkpoints per phase re-verify at implementation time.                                                                                             |
| Test memory spike (Prisma in `audit/prisma.ts` tests)              | Medium     | Prisma tests run serially per the trellis CLAUDE.md note; isolate to a separate vitest project with `maxThreads: 1`.                                    |
| AdminLinkProviderForUser empirical claim turns out false           | Low–Medium | Aspect severity is parameterized (`error` vs `warning`); fallback is `warning` with the empirical note documented. No code change blocks the v0.1 ship. |
| `cdk-nag` flags issues the constructs intentionally violate        | High       | Each construct's snapshot captures intentional violations; snapshot diff is the review surface. Not a blocker; just visible.                            |

## Status

Executed. Phases P0–P5 (plus fix-up passes) have landed; this plan is
retained as a record of the build order and rationale. See
[`12-remaining-work.md`](12-remaining-work.md) for the
post-implementation state.
