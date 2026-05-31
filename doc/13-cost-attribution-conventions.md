# 13 — Cost-attribution conventions

A coordination note, not a feature. Backends built on this foundation
run across **many AWS accounts under one Organisation**, and a
back-office substrate elsewhere in the house (De Otio's *Quaestor*)
attributes spend per **project / cost-center** so that "what did
project X cost?" and a clean carve-out at spin-off are a filter, not a
month-end forensic exercise. For that to work without the foundation
taking on any back-office coupling, the *tagging the foundation already
does* and the *account placement the consumer chooses* need to follow
one convention. This doc records it.

This is a house convention, **not** a dependency: the foundation emits
a generic cost-allocation tag; any FinOps or back-office consumer
benefits. There is no `entity` type, no back-office import, and no
reference to a specific back-office in the runtime or CDK code.

## The convention

1. **`CostCenter` is the attribution key, from a controlled
   vocabulary.** The foundation-cdk tagging aspect already stamps four
   cost-allocation tags (`Environment` / `Service` / `CostCenter` /
   `Owner`; see [`foundation-cdk/06-aspects.md`](foundation-cdk/06-aspects.md)).
   `CostCenter` must carry a value from the **house cost-center
   vocabulary** (e.g. `trellis-platform`), not a free-form string. The
   allowed values are owned org-side (the back-office's controlled
   vocabulary is the source of truth); a consumer picks from it rather
   than inventing one.

2. **Account placement is the primary attribution mechanism.** A
   project may own several accounts (dev / prod, per-region), and the
   relationship project↔account is one-to-many. Group a project's
   accounts under **one OU per project** in the Organisation, and keep
   an account **single-project wherever practical** — then attribution
   is structural (by account/OU) and doesn't depend on every resource
   being tagged. Genuinely shared accounts fall back to the
   `CostCenter` tag for the in-account split.

3. **The Organisation reconciles the two.** Org-side, an **AWS Cost
   Category** maps `(linked account | OU | CostCenter tag) → cost-center`,
   and the back-office reads that dimension via consolidated billing.
   The foundation's only job is to **emit the `CostCenter` tag
   faithfully**; the OU layout and the Cost Category live in De Otio
   infrastructure, above any one repo.

## What this asks of a consumer backend

- Apply the foundation-cdk tagging aspect (you should anyway).
- Set `CostCenter` from the house cost-center vocabulary, not ad hoc.
- Deploy a project's stacks into that project's account(s) under its
  OU; flag any deliberately *shared* account so the in-account tag
  split is expected.

Per-tenant cost (a different axis from per-project) stays as it is
today — proxy metrics via the `tenantId` log field / CloudWatch
dimension (see [`vestibulum/shared-distribution/cost-attribution.md`](vestibulum/shared-distribution/cost-attribution.md)).
Project/`CostCenter` and `tenantId` are orthogonal: one is *which house
project*, the other is *which end customer*.

## Non-goals

- **No emission hook to any back-office.** The foundation does not push
  to Quaestor or anything else; consumers of cost data read
  AWS-natively (consolidated billing / CUR / CloudWatch).
- **No `entity` concept in the runtime.** `CostCenter` is a tag value,
  full stop.

The consumer-side rationale lives in the `quaestor` repo at
`doc/analysis/fleet-integration.md` (De Otio internal).
