# 05 — Recommendation, stack, and reassessment

## Recommendation (decisive)

Adopt the **pool model with PostgreSQL RLS as the database-enforced isolation
boundary**, using the runtime-variable pattern set transaction-locally. Offer
**silo (dedicated database) only as a premium tier** for the few enterprise
tenants who contractually require physical isolation.

This is the only option that meets all of R1–R4 (see
[02](02-techniques-and-track-record.md)), it is what trellis's data shape forces
(personal-tenant-per-user rules out silo/bridge for the bulk), and every part of
it is a documented, time-tested, common technique.

## The exact stack

- **Database:** the existing Amazon RDS/Aurora **PostgreSQL** (no engine change).
- **Storage:** shared schema; `tenant_id` on every tenant-owned table (already
  true for the 12 content models; WS0 closes the gaps).
- **Boundary:** **RLS** on every tenant-owned table —
  `ENABLE` + `FORCE ROW LEVEL SECURITY`, `USING` + `WITH CHECK` on
  `tenant_id = current_setting('app.current_tenant')` (text compare; cuid ids).
- **App DB role:** dedicated, **not** superuser, **not** `BYPASSRLS`. Migrations
  and operator tasks use a separate privileged role.
- **Tenant context:** set per request via
  `set_config('app.current_tenant', <id>, true)` as the first statement of a
  **per-request transaction** (the tenant-scoped transaction wrapper in
  [04](04-connection-pooling-resolved.md)), sourced from the WS1 ambient tenant.
- **Pooling:** the current in-process `pg.Pool` works as-is; if/when an external
  pooler is needed, **PgBouncer in transaction mode** — **not** RDS Proxy for the
  tenant-scoped path (PG `SET` pinning).
- **Operator/cross-tenant path:** an explicit, logged `runUnscoped()` on a
  policy-exempt role — never `BYPASSRLS` on the request-path role.
- **Coverage guard:** a CI/migration check that every tenant-owned table has RLS
  enabled with a policy (DB-level analogue of the WS2 model-classification test).

## Tiering for the "RLS isn't enough" customers

AWS's pool-model guidance notes some customers won't accept logical (RLS)
separation. The time-tested response is **tier-based isolation**: keep everyone on
the pooled RLS database; offer a **dedicated-database premium tier** (silo) for
the few who require it, ideally not publicly advertised, running the same product
version so it's operated through one pane of glass. Build this **only when a
contract demands it** — not preemptively.

## Scalability ceiling (and what's next if hit)

The pool+RLS model scales to very large tenant counts on a single primary
(read-replicas + cache offload handle read load and noisy-neighbor pressure, per
the AWS pool-model page). If a single primary is eventually outgrown, the
documented next steps — in order — are:

1. **Read replicas / caching** for read-heavy load (smallest change).
2. **Vertical scale** of the primary.
3. **Horizontal sharding by `tenant_id`** (e.g. Citus / Aurora Limitless) — the
   `tenant_id` discriminator we already have is the natural distribution key, so
   the pool+RLS model is forward-compatible with sharding.

None of this is needed now; it's noted so the base model is known to have a proven
growth path.

## Honest reassessment of the earlier analysis (and what to change)

The earlier docs (`../02`, `../05`, `../06`) and PR #21 reached the right base
model (pool + RLS) but mis-framed two things; this deep dive supersedes them on
both:

1. **RLS is the boundary, not a "backstop."** The earlier framing put the
   application-level Prisma `$extends` extension as the "first line of isolation"
   and RLS as defense-in-depth. For a foundational boundary that is inverted:
   - **RLS (WS3) is the isolation guarantee and must lead.**
   - The **Prisma extension (WS2) is ergonomics + defense-in-depth only** — it
     keeps the common query path concise and adds an app-side layer, but it is
     explicitly **not** the security boundary (the PR #21 review showed it cannot
     cover `findUnique`-by-id, raw SQL, or relation models — which is *fine*,
     because RLS does). Keep it, but demote it in the docs and never rely on it
     for isolation. Enabling the extension's `enforce` mode is **not** what makes
     trellis isolated — **RLS is**.

2. **The pooling interaction is resolved, not an open "spike."**
   [04](04-connection-pooling-resolved.md) gives the documented pattern
   (transaction-scoped `set_config` + PgBouncer transaction mode / in-process
   pool; avoid RDS Proxy for this path). Remove "RDS-Proxy pinning spike" from the
   risk register as an *unknown*; it is now a *decided* design constraint.

### Revised implementation ordering

The implementation plan (`../06`) workstreams are still right, but the **emphasis
and order shift** so the boundary leads:

1. **WS0 — schema gaps** (every tenant-owned table has a non-null `tenant_id`).
   Prerequisite for RLS. (Needs a DB + migration sign-off.)
2. **WS3 — RLS** (the boundary): policies + `FORCE` + non-`BYPASSRLS` role + the
   transaction-scoped GUC wrapper + the coverage guard. **This is the foundational
   deliverable.** De-risk on a throwaway Postgres first (the wrapper + a
   cross-tenant leak test proving raw SQL and `findUnique`-by-id cannot cross
   tenants — exactly the cases the app layer can't cover).
3. **WS1 — ambient tenant** (already built; feeds the GUC wrapper).
4. **WS2 — Prisma extension** (already built; keep in `shadow`/`enforce` as
   *ergonomics*, not the guarantee).
5. **WS4 — verification**: the cross-tenant leak suite is run against **real
   Postgres with RLS on**, since RLS is the thing being verified.

The net change in practice: **lead with RLS, not the ORM extension.** PR #21
(WS1+WS2) stays as the ergonomic layer and should be described that way when it
merges; the foundational security work is WS0 → WS3.

## One-paragraph justification for the skeptic

This is not a clever or novel design. It is the shared-schema + `tenant_id` +
PostgreSQL RLS pool model that AWS documents as its recommended approach, that
PostgreSQL has shipped as a core feature since 2016, that Supabase runs across a
very large fleet, and that is documented in production write-ups across Rails,
Java, .NET, and security SaaS. The boundary is enforced by the database (so it
survives application bugs), it is index-friendly (so it scales), the one
pooling subtlety has a one-line documented fix (transaction-scoped `set_config`),
and the rare "physical isolation" requirement is met by an established tiering
pattern. Every load-bearing claim in this analysis cites a primary source.
