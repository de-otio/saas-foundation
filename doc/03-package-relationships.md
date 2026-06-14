# 03 — Package relationships

The dependency arrows in one place. What each package may import,
what it must not, and how the runtime/build/peer-dep distinctions
work out at the consumer's `package.json`. Most of the rules are
already implied by [`01-scope-and-philosophy.md`](01-scope-and-philosophy.md)
and [`02-monorepo-layout.md`](02-monorepo-layout.md); this doc names
them and pins the edge cases.

## The dependency graph

```
                    ┌──────────────────────────┐
                    │     consumer app         │
                    └────────────┬─────────────┘
                                 │
        ┌──────────────────┬─────┴──────┬───────────────────┐
        │                  │            │                   │
        ▼                  ▼            ▼                   ▼
  ┌───────────┐    ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐
  │ saas-     │    │ vestibulum  │  │ saas-            │  │ vestibulum-cdk  │
  │ foundation│    │  (runtime)  │  │ foundation-cdk   │  │  (CDK)          │
  └─────┬─────┘    └──────┬──────┘  └─────────┬────────┘  └────────┬────────┘
        │                 │                   │                    │
        │  ◄────peer──────┤                   │                    │
        │                                     │                    │
        │     (transitively, via bundle)      │                    │
        │  ◄──────────────────────────────────┼────────────────────┤
        │                                     │  ◄──optional peer──┤
        │                                     │                    │
        └─── (no upward deps) ────            ▼                    ▼
                                       ┌──────────────────────────────┐
                                       │ aws-cdk-lib, constructs      │
                                       └──────────────────────────────┘
```

Four published packages, six arrows worth naming:

| Arrow                                               | Kind                    | Form                 |
| --------------------------------------------------- | ----------------------- | -------------------- |
| `vestibulum` → `saas-foundation`                    | peerDependency          | `^0.x.0`             |
| `vestibulum-cdk` → `vestibulum`                     | build-time only         | bundled, no npm dep  |
| `vestibulum-cdk` → `aws-cdk-lib`, `constructs`      | peerDependency          | `^2.x`, `^10.x`      |
| `saas-foundation-cdk` → `aws-cdk-lib`, `constructs` | peerDependency          | `^2.x`, `^10.x`      |
| `vestibulum-cdk` → `saas-foundation-cdk`            | optional peerDependency | `^0.x.0` (deferred)  |
| `saas-foundation` → anything in this repo           | forbidden               | —                    |
| `saas-foundation-cdk` → `saas-foundation*` (value)  | forbidden               | type-only imports OK |

There are no upward dependencies, ever. `foundation` cannot import
from `vestibulum`; `vestibulum` cannot import from `vestibulum-cdk`;
`foundation-cdk` cannot import (at value level) from `foundation`,
`vestibulum`, or `vestibulum-cdk`. This is what makes the layering
load-bearing. Position and rationale for the fourth package live in
[`09-foundation-cdk-package.md`](09-foundation-cdk-package.md).

## Per-package rules

### `@de-otio/saas-foundation`

**May depend on:**

- AWS SDK v3 clients (`@aws-sdk/client-dynamodb`,
  `@aws-sdk/client-s3`, `@aws-sdk/client-sqs`,
  `@aws-sdk/client-ssm`, `@aws-sdk/client-secrets-manager`).
- Specific OSS utilities, chosen per the "Don't reinvent OSS"
  principle ([`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#design-principles)):
  - `zod` — boundary validation (session-payload schemas,
    feature-toggle config, etc.).
  - `ulid` — sortable ID generation. Used internally by the audit
    module; not re-exported as a foundation primitive.
  - `pino` (or equivalent) — structured logging. Decision pinned
    in `foundation/07-logger-and-request-context.md` when that
    doc lands.
  - `cockatiel` — internal use inside foundation modules that need
    retry / circuit-breaking (e.g., DynamoDB transient failures).
    **Not re-exposed publicly.** Consumers wanting retry policy
    depend on cockatiel themselves.
- Node built-ins.

**Must not depend on:**

- Any other package in this monorepo.
- `aws-cdk-lib` or `constructs` (enforced by ESLint
  `no-restricted-imports` in foundation's override).
- `@aws-sdk/client-cognito-identity-provider` or `aws-jwt-verify` —
  these are identity concerns. Foundation has no identity opinions.
- HTTP framework libraries (`hono`, `express`, `fastify`),
  `helmet`, CSRF middleware, OpenAPI generators. These are the
  consumer's choice; foundation is framework-agnostic.

**Intra-package rule:** modules within foundation may import each
other, but the import graph stays acyclic. Specifically: `audit`
may import `logger` but `logger` must not import `audit` (logging
is the foundational concern; audit is layered on top and emits
through the logger). Same shape for any future pair where one is
"more foundational" than the other. See § Cycle prevention.

### `@de-otio/vestibulum`

**May depend on:**

- `@de-otio/saas-foundation` (peer).
- `@aws-sdk/client-cognito-identity-provider`,
  `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ses` /
  `client-sns` as required by IdP flows.
- `aws-jwt-verify` (for the multi-pool verifier).
- Generic OSS utilities.

**Must not depend on:**

- `@de-otio/vestibulum-cdk`.
- `aws-cdk-lib` or `constructs` (CDK is a deploy-time concern;
  runtime code has no business with synth-time APIs).

**Peer-dependency rationale:** declaring `@de-otio/saas-foundation`
as `peerDependency` (not `dependency`) means the consumer's
`package.json` installs _one_ copy of foundation, regardless of how
many of these packages they pull in. If vestibulum had foundation
as a regular dep, npm could resolve two copies (different versions)
and the frozen-set types would have two distinct identities — a
`TenantId` from one copy would not be a `TenantId` to the other.
Peer-dep prevents this class of bug.

### `@de-otio/saas-foundation-cdk`

**May depend on:**

- `aws-cdk-lib`, `constructs` (peer).
- Node built-ins.
- **Type-only** imports from `@de-otio/saas-foundation` are
  permitted (e.g., `import type { TenantId } from
'@de-otio/saas-foundation'`). These are erased at compile time
  and add no runtime dep.

**Must not depend on:**

- `@de-otio/saas-foundation` at the _value_ level. CDK code runs
  in the consumer's synth process and must not pull AWS SDK
  runtime into synth. Enforced by a custom ESLint rule
  (`no-restricted-imports` with the value-vs-type distinction)
  in the package's override.
- `@de-otio/vestibulum` or `@de-otio/vestibulum-cdk`. Foundation-cdk
  is identity-agnostic; the dependency arrow points the other way.
- AWS SDK clients (`@aws-sdk/*`). Synth-time CDK code should not
  reach for SDK clients.

**Why a separate package and not part of vestibulum-cdk:** scope.
vestibulum-cdk is opinionated about one identity topology;
foundation-cdk is opinionated about house deployment defaults but
topology-agnostic. Mixing them would force every magic-link consumer
to live with foundation-cdk's opinions and every plumbing consumer
to live with vestibulum-cdk's opinions. See
[`09-foundation-cdk-package.md`](09-foundation-cdk-package.md).

### `@de-otio/vestibulum-cdk`

**May depend on:**

- `aws-cdk-lib`, `constructs` (peer).
- Build-time only: `@de-otio/vestibulum` (as input to esbuild). Not
  declared as a runtime dep — the Lambda code is bundled into the
  published artifact.
- `@de-otio/saas-foundation-cdk` (optional peer, deferred). When
  vestibulum-cdk adopts a foundation-cdk construct internally
  (e.g., `QueueWithDlq` for the SES bounce queue) the peer-dep
  becomes mandatory. v0.1 does not assume adoption.

**Must not depend on:**

- `@de-otio/saas-foundation` directly. If the construct code needs
  a foundation type, it imports it from `@de-otio/vestibulum` (which
  re-exports the relevant frozen types). This keeps a single import
  surface per package and means changing the dependency chain
  affects only one `package.json`.
- Anything from `@de-otio/vestibulum` at runtime — the construct
  code itself (running in the consumer's CDK synth process) must
  not pull Cognito SDK into the synth. The bundled Lambda code is
  the only path by which vestibulum runtime ends up in the
  deployed system.

**Why bundle and not depend:** if vestibulum-cdk declared
`@de-otio/vestibulum` as a runtime dep, every CDK app would pull
Cognito SDK + foundation into its synth process — slow, irrelevant,
and a footgun (CDK constructs accidentally calling Cognito SDK at
synth time is a real failure mode). Bundling once at publish time
isolates the runtime to the deployed Lambda; the consumer's synth
process never sees vestibulum source.

## Cycle prevention

Three rules, enforced mechanically:

1. **No cross-package cycles.** Trivially true given the directed
   acyclic graph above. The graph is kept acyclic by the declared
   `peerDependencies` + `devDependencies` structure in each
   `package.json`, verified by `scripts/ci/check-peerdep-ranges.ts`
   and enforced by ESLint `import/no-cycle` across workspace imports.
2. **No intra-package cycles via ESLint.** The `import/no-cycle`
   rule (eslint-plugin-import) flags any cyclic chain of
   in-workspace imports.
3. **Layering rule inside foundation.** Modules are conceptually
   layered:

   ```
   audit, rate-limit, feature-toggles, region          (layer 3: composed)
   tenant-context, session, secrets                    (layer 2: identity-adjacent)
   logger, request-context, kv, queue, storage, ip     (layer 1: primitives)
   types/frozen                                        (layer 0: cross-cutting types)
   ```

   **Any layer may import from layer 0** (the frozen-set type
   definitions). A higher non-zero layer may import a lower
   non-zero layer; the reverse is prohibited. The layering is a
   documented convention enforced by ESLint `import/no-cycle`
   and review discipline. Adding a new module requires explaining
   its layer placement if it is not obvious.

   **Why layer 0 exists.** `RequestContext` (layer 1) carries a
   `TenantId` (a layer-2 concept under tenant-context). If the
   type definitions lived with their logic, layer 1 could not
   reference layer 2 — a contradiction with the very first frozen
   type. Splitting types from logic lets both layers import the
   frozen-set types without violating the rule. The frozen-set
   directory is also the single path the CI fanout gate watches
   per [`05-versioning-and-releases.md`](05-versioning-and-releases.md#ci-gates).

The layering rule is the only one that's not just "no cycles" — it
prevents subtle layering breaks where, e.g., `kv` starts emitting
audit events directly (which would force every audit consumer to
include the KV implementation).

## The bundling relationship in detail

`vestibulum-cdk`'s build step:

1. Reads `@de-otio/vestibulum`'s entry points for each Cognito
   trigger (`createPreTokenGenerationHandler`,
   `createPostConfirmationHandler`).
2. esbuild bundles each into a single self-contained `.js` file:
   ESM, no external deps except Node built-ins and AWS SDK
   (which is provided by the Lambda runtime).
3. SHA-256-hashes each bundle; writes
   `packages/vestibulum-cdk/lambda-bundles.lock.json` with the
   hashes.
4. CDK constructs reference the bundled files at synth time via
   `lambda.Code.fromAsset(...)`.

**Version-bump consequences:**

- A vestibulum change that only affects non-Lambda code (e.g., the
  IdP managers used by an admin HTTP handler) does **not** require
  re-publishing vestibulum-cdk. Bump vestibulum, leave vestibulum-cdk
  alone.
- A vestibulum change that touches Lambda handler code requires
  re-bundling and re-publishing vestibulum-cdk with the bumped
  `lambda-bundles.lock.json`. The CI gate `verify-bundles` catches
  the case where someone tries to publish vestibulum-cdk without
  re-bundling.
- A consumer who installs `@de-otio/vestibulum@0.2.0` and
  `@de-otio/vestibulum-cdk@0.1.5` (the latter bundling
  `vestibulum@0.1.4`) is fine, _unless_ they expect their Lambda
  triggers to run the 0.2.0 code. They won't — Lambdas run the
  bundled-at-publish-time code. The consumer-facing docs make this
  explicit.

## Frozen-set re-exports

`vestibulum` re-exports the frozen-set types from foundation:

```typescript
// packages/vestibulum/src/index.ts
export type { TenantId, AuditEvent, RequestContext, SecretRef } from "@de-otio/saas-foundation";

export type {
  ClaimResolverInput,
  ClaimResolverOutput,
  ProvisionerInput,
} from "./types/frozen/callbacks.js";
```

Consumers of vestibulum get a single import surface; they don't have
to know which package the type was minted in. `vestibulum-cdk`'s
construct code does the same — it imports from `@de-otio/vestibulum`,
not from foundation directly.

The full frozen-set definition lives in foundation
([`04-shared-vocabulary.md`](04-shared-vocabulary.md), once written).
Re-export, never re-define — duplicate type definitions in two
packages create two distinct identities and the type checker loses
its ability to catch shape mismatches.

## Consumer-side topology

A typical consumer's `package.json`:

```json
{
  "dependencies": {
    "@de-otio/saas-foundation": "^0.2.0",
    "@de-otio/vestibulum": "^0.2.0"
  },
  "devDependencies": {
    "@de-otio/vestibulum-cdk": "^0.3.0",
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0"
  }
}
```

Three things worth noting:

- Foundation and vestibulum are runtime deps because the consumer's
  API process imports them at runtime.
- vestibulum-cdk is a devDep because CDK runs at deploy time (in CI
  or a local synth), not in the consumer's API process. (CDK apps
  that have their CDK code colocated with their API code may put
  vestibulum-cdk as a regular dep; both work.)
- aws-cdk-lib and constructs are devDeps because they're peer deps
  of vestibulum-cdk — the consumer brings their own version.

A consumer who wants only foundation (no identity layer — e.g., a
backend with custom auth) installs just `@de-otio/saas-foundation`.
A consumer who wants identity-runtime but not the magic-link CDK
shape installs foundation + vestibulum and writes their own CDK,
optionally pulling in `@de-otio/saas-foundation-cdk` for the
generic plumbing constructs. A consumer who wants only the plumbing
constructs (no identity) installs `@de-otio/saas-foundation` +
`@de-otio/saas-foundation-cdk`.

## Open questions

- **Foundation re-exports from vestibulum?** No — foundation cannot
  see upward. Consumers wanting both import both.
- **vestibulum exposes a `cdk-bundle-target` entrypoint?** Currently
  vestibulum-cdk picks specific files to bundle. Cleaner would be
  for vestibulum to declare its own bundle-target exports
  (`@de-otio/vestibulum/lambda/pre-token`,
  `@de-otio/vestibulum/lambda/post-confirmation`). Decide in
  [`vestibulum/01-package-api.md`](vestibulum/) when that doc
  lands; it affects vestibulum's exports map.
- **Example apps as workspace members?** If an example needs to be
  type-checked alongside the packages, it benefits from workspace
  membership. Counter: examples consuming via `file:` paths are
  _more realistic_. Keep examples non-workspace by default; if a
  specific example needs workspace status, move it.
