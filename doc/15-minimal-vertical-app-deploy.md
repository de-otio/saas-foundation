# 15 — Deploying a minimal vertical app for testing

How to stand up a minimal, throwaway end-to-end instance of a vertical
app — the `trellis` API running on `@de-otio/saas-foundation` — so you can
exercise the full stack for testing, including the multi-tenant data
isolation work in [`14-multi-tenancy/`](14-multi-tenancy/).

> **Read this first — what does and does not exist.** Neither this repo nor
> `trellis` contains turnkey "deploy the app" infrastructure. `trellis`
> ships as an npm package and a `Dockerfile`; the live AWS environment (ECS
> service, ALB, RDS, queues, tables) is owned by a separate consuming/infra
> repo that is **not** part of either codebase here. `saas-foundation`
> ships generic CDK *constructs* (`NodejsLambda`, `QueueWithDlq`,
> `SingleTable`, dashboards, aspects) and identity constructs
> (`MagicLinkIdentity`, `SharedDistributionIdentity`) — **there is no
> ECS/Fargate/ALB construct anywhere in this repo**. So a real AWS deploy of
> the API container must be authored by you (or recovered from the infra
> repo). This guide gives the two realistic test paths and is explicit about
> every gap.

## What you are deploying

| Piece | Where it lives | Status |
| --- | --- | --- |
| API process | `trellis/apps/api` — `src/server.ts` (plain `node:http` wrapping a Hono app from `src/lib/app.ts`), `apps/api/Dockerfile` (Node 22-alpine, `EXPOSE 3000`, `CMD node dist/server.js`) | exists; runs anywhere a container runs |
| Datastore (primary) | PostgreSQL via Prisma (`trellis/prisma/schema.prisma`, migrations in `prisma/migrations/`) | exists; you provision the DB |
| Identity | A real Cognito user pool (JWT verified against its JWKS) | **you provision** — `MagicLinkIdentity` (`@de-otio/vestibulum-cdk`) can supply it, or a bare pool |
| KV / audit / queues / storage | DynamoDB (KV), SQS, S3; **audit is Postgres-backed** (`PostgresAuditStore`), not DynamoDB | optional for a single request (see §4) |
| Container infra (ECS/ALB/etc.) | — | **does not exist in either repo; author it** |

The "vertical app" is therefore: **the trellis API container + a Postgres +
a Cognito pool**, with DynamoDB/S3/SQS only if your test exercises those
routes.

---

## Path A — local, via docker-compose (fastest; recommended for testing)

`trellis` already ships everything for a local stack. This is the right
path for exercising the API, the multi-tenancy schema, and most foundation
primitives without paying for AWS.

```bash
cd trellis

# 1. Bring up Postgres 16, DynamoDB-local, LocalStack (s3/sqs/ses).
docker compose up -d            # docker-compose.yml

# 2. One-shot setup: creates the DynamoDB table, SQS queues, runs
#    `prisma migrate dev`, seeds feature toggles.
bash scripts/dev-setup.sh

# 3. Required env (the API exits at startup without these — see
#    apps/api/src/env.ts validateEnv):
export SESSION_SECRET="$(openssl rand -hex 24)"   # >=32 chars
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/trellis"
export COGNITO_USER_POOL_ID="<real pool id>"      # see the identity caveat
export COGNITO_APP_CLIENT_ID="<real app client id>"

# 4. Run the API.
npm run dev        # or: node apps/api/dist/server.js after a build
```

### The one local gap: identity

There is **no offline token path.** JWT verification is asymmetric
(`@de-otio/vestibulum`'s `createMultiPoolVerifier`, ID-token use, against
the pool's JWKS — `apps/api/src/lib/auth/cognito-jwt.ts`). LocalStack does
not usefully emulate Cognito JWT signing. So even for local testing you
need a **real Cognito pool** to mint a verifiable token, and
`COGNITO_USER_POOL_ID` / `COGNITO_APP_CLIENT_ID` are hard-required just to
boot. See §3 for the cheapest way to get a usable token.

Everything else (DB, KV, queues, audit) runs locally.

---

## Path B — minimal AWS test deploy

When you need a real cloud instance. Five pieces; only the first three are
needed to serve one authenticated, tenant-scoped request.

### B1. PostgreSQL

One small RDS PostgreSQL 16 (or Aurora Serverless v2). Put the credentials
in Secrets Manager and point `DB_SECRET_ARN` at them (JSON
`{username,password,host,port,dbname}`), or set `DATABASE_URL` directly.
Apply the schema:

```bash
cd trellis
DATABASE_URL=... DIRECT_DATABASE_URL=... npm run prisma:migrate:deploy
```

The tenancy schema lands via `prisma/migrations/20260502094501_add_tenancy_model`
(+ `20260503000000_add_tenant_region`), plus the `tenant_id` columns added
for the multi-tenancy work (see [`14-multi-tenancy/`](14-multi-tenancy/)).

### B2. Cognito identity

Two options:

- **`MagicLinkIdentity` (`@de-otio/vestibulum-cdk`)** — provisions the pool,
  triggers, code-challenge table, and SES. To emit trellis's claims, declare
  the custom attributes trellis reads — `activeTenantId`, `userId`,
  `globalRole`, `tenantSlug`, `tenantRole`, `handle`, `dataRegion` (bare
  names; Cognito prefixes `custom:`) — and attach trellis's own
  `pre-token-generation` Lambda (`apps/api/src/lambda/pre-token-generation.ts`)
  via the construct's `preTokenGeneration` prop. See
  [`06-deployment-topology.md`](06-deployment-topology.md) Archetype B and
  the `examples/shared-distribution/` app for the construct-wiring shape.
- **Bare pool + admin attributes (cheapest for a static test user)** — create
  a plain Cognito user pool, declare the custom attributes, then for one test
  user `admin-set-user-attributes` `custom:activeTenantId` and
  `custom:userId` to CUIDs that you *also* insert into Postgres (`tenants`,
  `tenant_members`, `users`). `admin-initiate-auth` returns an ID token. This
  skips the trigger Lambdas and the magic-link/SES flow entirely.

> **Why `custom:activeTenantId` matters:** `apps/api/src/lib/auth/auth-middleware.ts`
> requires `sub`/`custom:userId` **and** `custom:activeTenantId` (both
> CUID-shaped). It's normally minted per-request by the DB-backed
> pre-token-generation trigger; for a static test user, the admin-attribute
> approach above sets it once.

### B3. The API container (you author this)

There is no CDK/IaC for the container in either repo. Build from
`apps/api/Dockerfile` and run it as an ECS Fargate service behind an ALB (the
README's intended shape; `TRUSTED_PROXY=alb` makes IP derivation handle ALB
headers), or — for a throwaway — `docker run` on a single EC2 box. Wire the
env from §B-checklist below.

### B4. Optional datastores

Only if your test request touches them:

- **DynamoDB** — one on-demand table (`DYNAMODB_TABLE`, default
  `${STAGE}-trellis`; pk/sk + gsi1 per `scripts/dev-setup.sh`). Wrapped as
  the `*_KV` namespaces in `apps/api/src/env.ts`.
- **S3** — `MEDIA_BUCKET_NAME`, `EXPORTS_BUCKET_NAME`.
- **SQS** — five queues (URLs derived from `AWS_ACCOUNT_ID`/`AWS_REGION`).
- **Audit needs none** — it writes to Postgres via `PostgresAuditStore`.

### B5. Get a token and call the API

```bash
TOKEN=$(aws cognito-idp admin-initiate-auth ... --query 'AuthenticationResult.IdToken' --output text)
curl -H "Authorization: Bearer $TOKEN" https://<your-api>/api/...
```

---

## Environment / resource / secret checklist

Source of truth: `trellis/apps/api/src/env.ts` (`Env` interface + `buildEnv`
+ `validateEnv`). Secrets resolve a local env var first, else AWS Secrets
Manager (`@de-otio/saas-foundation/secrets`).

| Var | Purpose | Minimal-test value |
| --- | --- | --- |
| `SESSION_SECRET` (or `SESSION_SECRET_ARN`) | session-cookie encryption; fail-closed | any ≥32-char string |
| `COGNITO_USER_POOL_ID` | JWT verifier pool | **real pool id** (§3/§B2) |
| `COGNITO_APP_CLIENT_ID` | JWT verifier audience | **real app client id** |
| `DATABASE_URL` (or `DB_SECRET_ARN`) + `DIRECT_DATABASE_URL` | Postgres / migrations | local URL or RDS creds |
| `STAGE` | resource-name prefix | `dev` |
| `AWS_REGION` | SDK + verifier region | e.g. `eu-central-1` |
| `PORT` | HTTP port | `3000` |
| `TRUSTED_PROXY` | client-IP derivation | `alb` behind an ALB; unset locally |
| `DYNAMODB_TABLE` | KV single table | only if a route hits KV |
| `MEDIA_BUCKET_NAME`, `EXPORTS_BUCKET_NAME` | S3 | only if media/export routes |
| `RATE_LIMIT_TABLE` | DynamoDB rate limiter | optional — **falls back to in-memory when unset** |
| `TENANT_SCOPE_MODE` | tenant scoping | `off` (default) / `shadow` / `enforce` — see §multi-tenancy |
| `OPENAI_API_KEY[_ARN]` | optional feature | unset unless needed |

**Thinnest boot:** `SESSION_SECRET` + `DATABASE_URL` + the two `COGNITO_*`
vars. Adapters for DynamoDB/S3/SQS are constructed at boot but only *hit*
when a route touches them (e.g. `/health` and many simple reads don't).

### IAM (Path B)

Per [`06-deployment-topology.md`](06-deployment-topology.md) §"IAM the
consumer's runtime role needs": DynamoDB item/query on the KV table, S3
get/put/delete on the buckets, SQS send/receive on the queues,
`secretsmanager:GetSecretValue` on the secret ARNs, and Postgres reached
over the network. Audit is Postgres, so no separate audit-table grant.

---

## saas-foundation wiring and in-memory test doubles

trellis imports these subpath exports: `@de-otio/saas-foundation` (root),
`/audit`, `/audit/prisma`, `/feature-toggles/prisma`, `/kv`, `/logger`,
`/net`, `/queue`, `/rate-limit`, `/region`, `/secrets`, `/storage`,
`/tenant`, `/types/frozen`, plus `@de-otio/vestibulum` (the verifier).

For tests that should not touch AWS, the published package ships in-memory
doubles you can inject through `buildEnv`'s `ResolveContext` seam:

- `MemorySecretStore` — `@de-otio/saas-foundation/secrets` (added in 0.2.4).
- in-memory KV — `@de-otio/saas-foundation/kv`.
- in-memory token-bucket limiter — `@de-otio/saas-foundation/rate-limit`.
- in-memory feature-toggle store — `@de-otio/saas-foundation/feature-toggles`.
- **Audit has no in-memory double** — but trellis uses `PostgresAuditStore`,
  so audit rides on the Postgres you already have.

For a *deployed* test it is simpler to set the secret env vars directly than
to wire the doubles.

---

## Testing the multi-tenancy / RLS path

State of the work (see [`14-multi-tenancy/deep-dive/06-implementation-plan.md`](14-multi-tenancy/deep-dive/06-implementation-plan.md)):

- **Shipped in trellis:** every tenant-owned table has non-null `tenant_id`
  (P1); the app-level Prisma scoping extension (`apps/api/src/lib/tenant-scope.ts`,
  gated by `TENANT_SCOPE_MODE`); the ambient tenant set per request in
  `apps/api/src/lib/app.ts` from the verified `custom:activeTenantId`; and a
  `withTenantTx` wrapper (`apps/api/src/lib/database-connection-manager.ts`)
  that issues `SELECT set_config('app.current_tenant', $tid, true)` —
  **dormant; not yet wired into request paths.**
- **Not yet implemented (you must author to test the DB boundary):**
  1. a migration creating a non-`BYPASSRLS` `app_rw` role (+ a separate
     migrator/operator role) — an infra/DB change;
  2. `ENABLE` + `FORCE ROW LEVEL SECURITY` + `USING`/`WITH CHECK
     (tenant_id = current_setting('app.current_tenant', true))` policies on
     the tenant-owned tables (the P0-validated template is in
     [`14-multi-tenancy/deep-dive/07-spike-results.md`](14-multi-tenancy/deep-dive/07-spike-results.md));
  3. routing request DB access through `withTenantTx`, and connecting the API
     as `app_rw`.

To exercise scoping **today** without RLS: set `TENANT_SCOPE_MODE=shadow`
(logs unscoped call sites) or `enforce` (app-level filter). Note the
deep-dive's warning: `enforce` alone is only a *partial* app-layer defense —
it cannot cover `findUnique`-by-id, raw SQL, or by-relation models. **RLS
(the DB backstop) is what actually isolates tenants**, and it is the
not-yet-built part. Federation/async paths that have no ambient tenant must
use `runUnscoped`.

---

## Known gaps / blockers (read before estimating effort)

1. **No API-container IaC** in either repo — author the ECS/Fargate/ALB (and
   RDS/queues/tables) wiring, or recover it from the infra repo. There is no
   ECS construct in `saas-foundation`.
2. **No offline token** — JWT verification is JWKS-only; a real Cognito pool
   is required even locally, and the two `COGNITO_*` vars are required to
   boot.
3. **`custom:activeTenantId` is DB-derived** (pre-token-generation Lambda),
   not a static signup attribute — correct claims need Postgres tenancy rows
   + a claims-cache DynamoDB table, or the manual admin-attribute shortcut
   (§B2) for a static test user.
4. **RLS does not exist yet** — `TENANT_SCOPE_MODE=enforce` is only the
   partial app-layer filter; testing the DB boundary requires authoring the
   `app_rw` role + policies + `withTenantTx` wiring first.
5. **SES sandbox** blocks the magic-link email flow unless recipients are
   verified or users are provisioned via admin APIs.

## Recommended approach for a first test

Start with **Path A** (docker-compose) for the API, DB, KV, queues, and the
multi-tenancy schema; pair it with a **single throwaway Cognito pool** (the
only piece local can't supply) and a static test user via admin attributes.
That gets you an authenticated, tenant-tagged request end-to-end with no
container IaC and no AWS data-plane cost. Promote to Path B only when you
need the cloud-realistic shape or to test RLS against real RDS.
