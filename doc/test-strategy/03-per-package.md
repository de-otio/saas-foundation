# 03 — Per-package plan

What each package is responsible for *proving*, the layers ([`02-test-layers.md`](02-test-layers.md))
it leans on, and the highest-risk modules that warrant the heaviest tests.

| Package | Test files (approx.) | Dominant layers | Highest-risk surface |
|---|---|---|---|
| `foundation` | ~53 | 1–4, frozen 2 | frozen vocab, session crypto, audit, rate-limit |
| `vestibulum` | ~40 | 4–5, frozen 2 | JWT verify, SSRF probe, SAML parse, edge/admin |
| `foundation-cdk` | ~12 | 6–7 | IAM defaults, DLQ wiring, house Aspects |
| `vestibulum-cdk` | ~39 | 6–9 | edge auth, WAF, cost-DoS guard, bundles |
| `scripts` | 1 | pure unit | frozen-fanout gate logic |

---

## `@de-otio/saas-foundation`

**Responsibility:** the runtime core every consumer depends on. A defect
here is a defect everywhere. No identity opinions, so the tests are about
correctness of the cloud-primitive shims and the frozen types.

**Must prove:**

- **Frozen vocabulary holds** (Layer 2, ≥95%). `TenantId`, `AuditEvent`,
  `RequestContext`, `SecretRef` brand construction/round-trip/rejection.
  This is the single most important obligation in the repo — it is the
  cross-package and cross-release contract.
- **Session crypto is correct and tamper-evident** (Layer 1). Cookie
  seal/unseal, key derivation, JSON unsealing, and rejection of tampered
  or expired payloads — `test/session/*`. Crypto with an injected key/RNG;
  no real entropy in tests.
- **Cloud shims issue the right commands and map errors** (Layer 4) for
  `kv` (DynamoDB + Cloudflare-typed + in-memory), `queue` (SQS), `storage`
  (S3 + presign), `secrets` (Secrets Manager / SSM + cache + resolve),
  `rate-limit` (DynamoDB + in-memory + token-bucket core).
- **Audit pipeline integrity** (Layers 1, 3, 4). PII filtering, retention,
  multi-store fan-out, the Prisma and DynamoDB stores, the quarantine
  fixture path (`test/audit/prisma-quarantine-fixture.test.ts`), and the
  **least-privilege IAM shape** (`test/audit/iam-shape.test.ts`).
- **Tenant resolution** across composite / subdomain / custom-domain
  strategies and the `AsyncLocalStorage` context plumbing (`test/tenant/*`,
  `test/request-context/*`) — including the error cases in `errors.ts`.
- **Region / residency** detection and the EU-residency guarantees
  (`test/region/*`).
- **Net derivation** (`test/net/*`) — trusted-hop IP derivation and
  RFC6890 reserved-range classification (security-adjacent; see
  [`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md)).

**Notes:** the in-memory implementations (`memory.ts`, `memory-secret-store.ts`,
`memory-store.ts`, `memory-limiter.ts`) are both shipped test doubles for
consumers *and* the reference behaviour the AWS-backed implementations must
match — test them as first-class code, not as fixtures.

## `@de-otio/vestibulum`

**Responsibility:** the identity runtime. Cognito-shaped, security-bearing,
the most adversarial test surface in the repo.

**Must prove:**

- **Multi-pool JWT verification rejects cross-pool / wrong-issuer /
  expired / wrong-audience tokens** (`verify/multi-pool-verifier`) — Layer
  4/5 over `aws-jwt-verify`. The cross-pool confusion case is the headline
  abuse test.
- **OIDC issuer probe defends against SSRF** (`discovery/oidc-probe`,
  `discovery/private-ip`) — Layer 1/4. Probes to private/loopback/link-local
  ranges must be refused; redirect-to-internal must be refused.
- **SAML metadata parsing and signature checking** (`discovery/saml-metadata`,
  `idp/saml-manager`, `saml/sp-metadata`) — resist signature wrapping and
  malformed XML. Fixtures are built at suite start via the `globalSetup`
  `test/fixtures/saml/build-fixtures.ts`.
- **Cognito Lambda triggers behave per branch** (Layer 5) — both the
  single-tenant handlers (`lambda/handlers/*`) and the shared-distribution
  triggers (`lambda/shared-distribution/triggers/*`): create/verify/define
  auth challenge, pre-signup, pre-token-generation, signout, bounce.
- **Shared-distribution edge auth** (`lambda/shared-distribution/edge/*`) —
  `check-auth`, `verify-jwt`, JWKS caching, tenant-subdomain extraction,
  the response builders. A bypass here exposes private origins.
- **Admin reconciler / actions** (`lambda/shared-distribution/admin/*`) —
  schema-guarded tenant CRUD, the reconciler, metrics, and audit logging
  of admin actions.
- **Frozen callbacks** (`src/types/frozen/`) — the claim-resolver callback
  contract, held at ≥95% and included in coverage.

## `@de-otio/saas-foundation-cdk`

**Responsibility:** identity-agnostic AWS plumbing. Tests are almost
entirely Layer 6/7 — assert the synthesised template.

**Must prove:**

- `NodejsLambda` applies house defaults: log retention, alarms,
  iterator-age alarm, Prisma bundling option, sane runtime/arch.
- `QueueWithDlq` wires a DLQ with the right redrive policy and alarm.
- `SingleTable` produces the intended key schema, GSIs, billing mode, and
  removal/termination policy per environment (dev DESTROY / prod RETAIN —
  the multi-env mandate).
- The house **Aspects** (`tagging`, `house-defaults`, `metadata-tags`)
  apply across a synthesised tree and don't double-apply.
- The dashboard templates emit the expected widgets against the
  `contracts.ts` metric shape.

**Coverage:** 80% floor across `lib/**` (barrels and `.d.ts` excluded).

## `@de-otio/vestibulum-cdk`

**Responsibility:** the opinionated magic-link + edge-auth topology, single
tenant and shared-pool. Layers 6–9, plus the bundle-integrity gate.

**Must prove:**

- `MagicLinkIdentity` / `MagicLinkAuthSite` synthesise Cognito
  `CUSTOM_AUTH`, the CloudFront edge, SES validation, and auth-verify paths
  correctly; prop validation rejects bad configs (`prop-validation.ts`,
  `magic-link-identity/errors.ts`).
- `SharedDistributionIdentity` wires the shared Cognito pool, the
  client-config / reservations tables, the wildcard cert, the CloudFront
  distribution, edge function, WAF, and security headers — each module is
  in the explicit coverage `include` list.
- **`cdk-nag` rules pass** and the custom vestibulum checks fire:
  `cloudfront-viewer-protocol-redirect`, `lambda-edge-no-logs`,
  `vestibulum-checks`. Enforcement Aspects (`waf-required`,
  `log-retention-required`, `disabled-auth-flows`) must trip on a
  non-compliant tree.
- **Cost-DoS guard** (`_internal/cost-dos-guard.ts`) and **S3 lifecycle
  defaults** (`_internal/s3-lifecycle.ts`) — the cost-pillar findings
  folded into code; both are in the coverage include list.
- **Bundle integrity** (Layer 9): `verify-bundles` matches
  `lambda-bundles.lock.json`; the shared-distribution example synthesises.

**Coverage:** 80% floor, but applied to an explicit `include` allow-list of
the constructs that carry behaviour (see
[`04-coverage-and-ci-gates.md`](04-coverage-and-ci-gates.md)) — pure glue
and index barrels are excluded so the number reflects real coverage of
real logic.

## `scripts/` (cross-package CI gates) {#scripts}

**Responsibility:** enforce release discipline that no single package can
enforce alone.

**Must prove** (`scripts/ci/check-frozen-fanout.test.ts` today; the others
warrant tests as they grow):

- **`check-frozen-fanout`** — a change touching a frozen type is
  accompanied by a coordinated changeset across every affected package.
  This is the runtime backstop for P4.
- **`check-changesets`** — a non-trivial change carries a changeset.
- **`check-peerdep-ranges`** — peer-dependency ranges between the packages
  stay mutually satisfiable (e.g. `vestibulum`'s `^0.2.0` on `foundation`).

These run against a base-branch diff in CI and are themselves unit-testable
because the diff is injected, not read from a live `git` invocation.
