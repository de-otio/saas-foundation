# 2026-05-29 — AWS Well-Architected Cost Pillar review

Fourth design-review pass. Audits the four packages against the
[AWS Well-Architected Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html),
which is structured around five focus areas:

1. **Practice cloud financial management** — cost ownership, FinOps
   capability, disclosure.
2. **Expenditure and usage awareness** — tagging, attribution,
   budgets, anomaly detection, observability of spend.
3. **Cost-effective resources** — service selection, pricing model,
   right-sizing, data lifecycle.
4. **Manage demand and supply resources** — throttling, queues,
   buffering, scaling envelopes.
5. **Optimize over time** — review cadence, decommissioning, picking
   up new services and price changes.

Prior reviews
([`2026-05-24-initial-design-pass`](2026-05-24-initial-design-pass.md),
[`2026-05-24-foundation-cdk-and-aws-verification`](2026-05-24-foundation-cdk-and-aws-verification.md),
[`2026-05-25-shared-distribution-design-review`](2026-05-25-shared-distribution-design-review.md))
have already addressed several high-cost items: PITR cost disclosure
(H1), Cognito Advanced Security default and disclosure (B-H),
ATP-opt-in not opt-out (B-G), reserved-concurrency made optional
(B2), ARM64 Lambda default, `PRICE_CLASS_100` CloudFront default.
This pass does **not** re-litigate those; it covers what the cost
pillar asks that those reviews did not.

## TL;DR

- **BLOCKERs (0)**.
- **HIGH-security (0)**. None of the findings are confidentiality /
  integrity issues; the pillar is about money.
- **SIGNIFICANT (8)** — missing tagging aspect; no per-tenant cost
  attribution doc for shared-distribution; PITR window default at
  the maximum (35d); no S3 lifecycle policy on created buckets;
  CloudWatch dashboard/alarm cost not disclosed under the
  paid-default axiom; log-retention heterogeneity + no
  CloudWatch Logs **Infrequent Access** class option; SES not
  inside the documented cost-DoS envelope; no provisioned-capacity
  crossover guidance for `SingleTable`.
- **NITs (7)** — Budgets / Cost Anomaly Detection mention in the
  consumer cookbook; tag-propagation-to-Lambda@Edge caveat; Lambda
  memory right-sizing guidance; X-Ray cost disclosure under the
  axiom; reserved-concurrency cost-DoS callout in the auth-site
  doc; quarterly cost-pillar checkup template under `doc/review/`;
  Pricing Calculator links per deployment archetype.

The standing verdict from the three prior reviews holds: the design
is well-shaped for *cost-effective resources*. The gaps here are in
*cost visibility, attribution, and governance* — the areas least
visible at design time and most painful to retrofit at scale,
particularly under a SaaS multi-tenant topology.

## What's already aligned with the cost pillar

These were established by earlier reviews / the design and should
not be lost on follow-up work:

- **Paid-by-default disclosure axiom**
  ([`doc/01-scope-and-philosophy.md:165-178`](../01-scope-and-philosophy.md))
  — any construct that turns on a per-MAU / per-resource paid
  feature must disclose a concrete cost order-of-magnitude in the
  prop doc. Maps directly to *Cloud Financial Management*. The
  fixes below are mostly applications of this axiom to features the
  axiom predates.
- **Synth-time annotations** when expensive features are enabled
  (Cognito Advanced Security: `magic-link-identity.ts:767-772`,
  `identity.ts:571-578`). Maps to *Expenditure awareness*.
- **ARM64 Lambda default**
  (`packages/foundation-cdk/lib/nodejs-lambda/nodejs-lambda.ts:184`).
  ~20% cheaper than x86 per the construct doc; AWS docs cite "up
  to 34% better price-performance" overall (per the second review's
  AWS-fact check).
- **`PRICE_CLASS_100`** default on both CloudFront flavours
  (`magic-link-auth-site.ts:495`, `cloudfront-distribution.ts:233`).
  Aligns with the EU-residency posture; ~30% saving vs
  `PRICE_CLASS_All` in typical traffic mixes.
- **Cost-DoS envelope is a first-class design concept**
  (`magic-link-auth-site.ts:145-184`) — WAF per-IP rate-limit +
  Lambda reserved-concurrency cap + OAC, layered. Most teams
  discover this on the bill.
- **ATP opt-in, not opt-out** (review B-G). Avoided a ~$200/mo
  default-on trap; Account Takeover Protection is irrelevant to
  passwordless flows.
- **GSI1 opt-out** on `SingleTable` (review S4). Write-cost
  doubling is now a consumer choice.
- **Reserved concurrency made optional** (review B2). The hard
  100-unit unreserved floor would have made the previous mandatory
  default a footgun.
- **Shared-distribution amortises CloudFront + ACM + Route53 across
  tenants**
  ([`doc/vestibulum/shared-distribution/01-architecture.md:122-145`](../vestibulum/shared-distribution/01-architecture.md))
  with an explicit N-CloudFront comparison. This is a *Manage
  Demand and Supply* pattern done as a topology choice.

## SIGNIFICANT findings

### S1 — No cost-allocation tagging aspect

**File:** [`packages/foundation-cdk/lib/aspects/metadata-tags.ts`](../../packages/foundation-cdk/lib/aspects/metadata-tags.ts);
[`doc/foundation-cdk/06-aspects.md`](../foundation-cdk/06-aspects.md).

**Issue:** The only tag set by the package today is the internal
`de-otio:houseConstruct` marker used by `HouseDefaultsAspect` to
detect its own constructs. There is no `Environment`, `Service`,
`CostCenter`, `Owner`, or `Tenant` propagation. Without these,
neither Cost Explorer nor AWS Budgets can slice spend by anything
the consumer cares about. A grep across `doc/` and `packages/` for
the strings "cost allocation", "tag policy", "aws budgets", "cost
explorer", "savings plan", and "cost anomaly" returns **zero hits**
— this gap is not documented, not deferred, not on the roadmap.

The cost pillar's first focus area (Practice Cloud Financial
Management) treats cost-allocation tags as a precondition for every
other discipline in the pillar. The paid-default disclosure axiom
solves the in-prop-doc half of this; tag propagation is the
in-deployment half.

**Suggested fix:** Add a `HouseTaggingAspect` to
`packages/foundation-cdk/lib/aspects/`. The aspect takes a required
`{ environment, service, costCenter, owner }` object at stack /
app level and applies them via
`cdk.Tags.of(scope).add(key, value)`. Document the required tag set
in [`doc/foundation-cdk/06-aspects.md`](../foundation-cdk/06-aspects.md)
and add a `cdk-nag`-style synth-time check that fails if any of the
required tags is missing on a stack containing house constructs.
Caveat (see N2 below): CloudFront does not propagate tags to
Lambda@Edge replicas.

This is the prerequisite for S2, S5, and the F3-equivalent finding
about Budgets in N1 — without it, none of those are measurable.

### S2 — No per-tenant cost attribution for shared-distribution

**File:** [`doc/vestibulum/shared-distribution/`](../vestibulum/shared-distribution/)
— specifically, no `cost-attribution.md` exists alongside the ten
existing design docs.

**Issue:** Shared-distribution mode amortises CloudFront, ACM,
Route53, the edge function, the WAF WebACL, the Cognito user pool,
the five Cognito Lambda triggers, and the `ClientConfig` /
`MagicLinkTokens` tables across all tenants on the identity. That
amortisation is itself the cost win (see the comparison table at
[`01-architecture.md:122-145`](../vestibulum/shared-distribution/01-architecture.md)).
But the moment a consumer of this library runs paid-tier SaaS on
top of it, finance will ask "how much does tenant X cost?" and
"what's our gross margin per seat?" The current design has no
answer.

Concretely, the only line-items that *can* be attributed per-tenant
without architectural change are:

- Cognito trigger Lambda invocations, if logs carry `tenantId`
  (they should — verify via `magic-link-identity.ts` triggers).
- DDB row counts in `ClientConfig` and `MagicLinkTokens`
  (effectively free at modest tenant counts).
- SES sends, if the `tenantId` is emitted at send time
  (verify in the magic-link send path).
- Edge-function invocations *cannot* be attributed without
  per-request logging — Lambda@Edge does not support env vars
  (per shared-distribution review B4) and CloudFront access logs
  go to the account-level S3 bucket.

**Suggested fix:** Add
`doc/vestibulum/shared-distribution/cost-attribution.md` that:

1. Lists what's amortised (and therefore *not* per-tenant
   attributable) vs what's metered (CloudFront requests, edge
   invocations, Lambda trigger invocations, SES sends, DDB rows).
2. Describes the proxy-metric approach: emit `tenantId` on every
   metric / log that goes through a tenant-aware code path.
3. Quantifies the amortised-vs-metered split at the 10 / 100 /
   1000-tenant scaling points.
4. Tells consumers how to back this into a chargeback model.

This is documentation only — no code change required immediately.
Per-tenant CloudWatch metric dimensions (custom metrics emit with
`tenantId`) are the implementation-level follow-up; see N6.

### S3 — DynamoDB PITR default window is the maximum (35 days)

**File:** [`packages/foundation-cdk/lib/single-table/single-table.ts:90-117`](../../packages/foundation-cdk/lib/single-table/single-table.ts);
[`doc/foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md).

**Issue:** PITR is enabled by default (load-bearing for recovery
safety; the prior review settled this at H1). But the **window**
defaults to 35 days, which is the maximum AWS allows. PITR billing
scales with both table size and the continuous-backup retention
window — the choice between 7 days and 35 days is roughly a 5×
multiplier on the PITR line item for an unchanged workload. The
previous review verified that the window is "1–35 days
configurable, not a fixed value" via `aws-knowledge`.

35 days as the default fits a "max safety unless told otherwise"
posture, but no design doc justifies the choice and AWS's own
default in the console is 35 only because the field is preselected
to the maximum — it isn't a "recommended" value. The cost pillar
asks teams to pick the cheapest setting that meets the recovery
requirement, not the safest possible.

**Suggested fix:** Drop the default to **7 days** in
`single-table.ts`. 7 days covers "we noticed corruption on Monday,
it started over the weekend" cleanly and is the conventional
recovery-window starting point. Keep 35d available via the existing
prop; document the swap and the cost ratio in the prop doc per the
paid-default axiom. Annotate at synth when the window > 14 to
mirror the Advanced-Security annotation pattern.

### S4 — No S3 lifecycle policy on created buckets

**Files:**
[`packages/vestibulum-cdk/lib/magic-link-auth-site/magic-link-auth-site.ts:407-408`](../../packages/vestibulum-cdk/lib/magic-link-auth-site/magic-link-auth-site.ts);
`packages/vestibulum-cdk/lib/shared-distribution-identity/cloudfront-distribution.ts:154`.

**Issue:** Every S3 bucket created by the package is on the default
storage class (Standard) for its entire lifetime, with no
`abortIncompleteMultipartUpload`, no Standard → IA / Glacier
Instant transition, and no expiration of old object versions. For
short-lived auth-site assets this barely matters; for any consumer
that turns on CloudFront access logs (and the design today does
not, see N5) or accumulates user uploads through downstream
features, it compounds.

`abortIncompleteMultipartUpload` is essentially a freebie — there
is no upside to leaving stranded multipart uploads on the bill —
and the cost pillar specifically calls it out under data lifecycle.

**Suggested fix:** Add a default lifecycle rule on every bucket the
package creates:

- `abortIncompleteMultipartUploadAfter: Duration.days(7)`
- `transitions: [{ storageClass: STANDARD_IA, after:
  Duration.days(30) }]` for buckets the design treats as
  immutable-asset stores
- Object-version expiration where versioning is on

Surface the lifecycle as an optional prop so consumers with cold-as-
operational requirements can override. Document under
[`doc/vestibulum-cdk/04-magic-link-auth-site.md`](../vestibulum-cdk/04-magic-link-auth-site.md).

### S5 — Dashboard and alarm costs are not disclosed under the paid-default axiom

**Files:** [`packages/foundation-cdk/lib/dashboards/`](../../packages/foundation-cdk/lib/dashboards/);
all alarm definitions in `nodejs-lambda.ts`, `single-table.ts`,
`queue-with-dlq.ts`.

**Issue:** CloudWatch dashboards are billed at $3/dashboard/month
after the first three free across the *account*. CloudWatch alarms
are billed at $0.10/alarm/month (standard resolution, most regions).
Per-construct alarm counts:

- `NodejsLambda` creates 3 alarms by default (error, throttle,
  duration).
- `SingleTable` creates 2 (write-spike, read-spike).
- `QueueWithDlq` creates 1 (DLQ-non-empty).

A modest stack with 10 Lambdas + 2 tables + 3 queues = 37 alarms ≈
$3.70/mo. Trivial in isolation, but additive across stacks and
silent in the design today. The same applies to the
`houseDashboard()` constructor — three template-driven dashboards
per stack across three stacks already crosses the free-tier.

The paid-default disclosure axiom (`01-scope-and-philosophy.md:165`)
specifically calls out "per-resource" billing as a target for
disclosure. Dashboards and alarms fit this rule but were not
classified as paid defaults when the axiom was written.

**Suggested fix:** Add a "Recurring cost" subsection to
[`doc/foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md),
[`04-single-table.md`](../foundation-cdk/04-single-table.md),
[`03-queue-with-dlq.md`](../foundation-cdk/03-queue-with-dlq.md), and
[`05-dashboards.md`](../foundation-cdk/05-dashboards.md), each
mirroring the PITR / Advanced Security format: per-resource cost
order-of-magnitude + worked example for a "10 Lambdas, 2 tables, 3
queues" representative stack. The existing `alarms: false` escape
hatches stay; this is documentation only.

### S6 — Heterogeneous log-retention defaults; no Infrequent Access class option

**Files:** `nodejs-lambda.ts:309` (30 days),
`magic-link-identity.ts:583` (1 month — same magnitude, different
unit), `magic-link-auth-site.ts:389` (1 day, edge log group).

**Issue:** Three different retention defaults across three
constructs, none of them justified in design docs. The cost pillar's
*right-size data lifecycle* practice asks for retention to track
actual access patterns, not "looked round enough." Without a
documented policy, consumers can't reason about why their app
Lambdas keep 30 days but their Cognito triggers also keep ~30 days
(why not 90?) and the edge log keeps 1 day (correct — but why?).

Separately, no construct exposes the **CloudWatch Logs Infrequent
Access** class introduced by AWS in late 2024. IA storage is
priced at roughly half the Standard rate, with the trade-off that
Logs Insights queries cost more per scanned GB. For audit /
security / compliance log streams that are written constantly but
queried rarely, the savings are material.

**Suggested fix:**

1. Add a `logClass: 'standard' | 'infrequent-access'` prop to
   `NodejsLambdaProps` (default `'standard'`). Wire through to
   `LogGroup.logClass`.
2. Document the policy in
   [`doc/foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md):
   "Standard for app code; IA for audit-stream Lambdas (`audit`,
   `bounce-handler`); 1 day for the L@E log group (which cannot
   write logs anyway — see auth-site doc)."
3. Surface the heterogeneity intentionally and explain it, so the
   pattern is reusable for downstream constructs.

### S7 — SES is not inside the documented cost-DoS envelope

**Files:** [`packages/vestibulum-cdk/lib/magic-link-identity/magic-link-identity.ts`](../../packages/vestibulum-cdk/lib/magic-link-identity/magic-link-identity.ts)
(send path); the cost-DoS envelope discussion in
[`magic-link-auth-site.ts:145-184`](../../packages/vestibulum-cdk/lib/magic-link-auth-site/magic-link-auth-site.ts).

**Issue:** The cost-DoS envelope today defends `/auth-verify`
against per-IP attack via WAF rate-limit (60 reqs / 5 min /
IP, `waf-defaults.ts:159-183`) and against region-wide saturation
via reserved concurrency (20, `magic-link-auth-site.ts:276`). It
does **not** defend the *outbound side*: a `/auth-verify` that
clears the rate-limit triggers a magic-link send via SES. An
attacker rotating through residential proxies with unique addresses
costs them very little and costs the operator at:

- SES sends: ~$0.10 per 1,000 outbound (above the daily free tier
  in EU regions).
- Reputation damage if the bounce rate climbs (Cognito feature
  plan / sandbox revocation, etc.).
- Customer-support volume.

The cost-DoS envelope is presented as comprehensive in
`magic-link-auth-site.ts:145-184`; this gap should be either fixed
or explicitly documented as out-of-envelope.

**Suggested fix:** Two layers:

1. **Per-pool absolute send-rate alarm.** A CloudWatch alarm on
   the SES sending-statistics metric for the pool, threshold
   tuned to "well above any plausible legitimate spike, well below
   any cost-disaster level." Wire to an SNS topic.
2. **Optional self-defence handler.** A `BounceHandler`-shaped
   Lambda that consumes the alarm and flips Cognito sign-up
   gating off temporarily (or sets a feature flag the trigger
   reads). Opt-in via a `costDosGuard: { enabled: true,
   sendsPerHourCap: number }` prop on `MagicLinkIdentity` and
   `SharedDistributionIdentity`.

Document the envelope extension in
[`doc/vestibulum-cdk/04-magic-link-auth-site.md`](../vestibulum-cdk/04-magic-link-auth-site.md).

### S8 — `SingleTable` has no on-demand → provisioned crossover guidance

**Files:** `single-table.ts:109` (`PAY_PER_REQUEST` hardcoded);
[`doc/foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md).

**Issue:** PAY_PER_REQUEST is correct for unknown / spiky / new
workloads — and most consumers of this package start there.
At steady-state utilisation above roughly 20–30%, **PROVISIONED
+ auto-scaling + a small Reserved Capacity commitment** is
materially cheaper. AWS publishes this crossover; the design does
not surface it.

The cost pillar's *cost-effective resources* practice specifically
asks teams to reassess pricing-model choice once steady-state load
is known. The design needs to *not* change the default — on-demand
is correct for the v0.x stage — but it should give the consumer
the cue to revisit.

**Suggested fix:** Add a "When to switch to provisioned" subsection
to [`doc/foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md)
with the AWS crossover formula and a "if you have 30+ days of
steady traffic ≥ X RCU/WCU, run this calculation" prompt. Optional
follow-up: expose `billingMode` as a prop (currently hardcoded).
Defer the prop until a real consumer asks for it — premature
flexibility costs verification time per the project's own axiom.

## NIT findings

### N1 — Consumer cookbook does not mention AWS Budgets / Cost Anomaly Detection

**File:** [`doc/06-deployment-topology.md`](../06-deployment-topology.md).

**Issue:** Both AWS Budgets and Cost Anomaly Detection are free at
modest scale and are the entry-level controls for the *Expenditure
and usage awareness* focus area. The deployment cookbook covers
identity topology and bundling but not the financial controls a
consumer should set up before going live.

**Suggested fix:** A short "Before going live" subsection: enable
Cost Anomaly Detection (free) at account level, set an AWS Budgets
monthly threshold matched to the worked-example cost from S5, wire
the budget alert to the same SNS topic as the alarms.

### N2 — Tag propagation does not reach Lambda@Edge

**File:** Wherever S1's `HouseTaggingAspect` lands.

**Issue:** `Tags.of(stack).add(...)` does *not* propagate to
Lambda@Edge replicas — CloudFront strips them when it replicates
the function. This is a CloudFront limitation, not an aspect bug,
but the tagging aspect's user will not know this. Affects S2's
attribution story too: L@E invocations cannot be split by tag.

**Suggested fix:** A one-paragraph caveat in the aspect's doc.

### N3 — No Lambda memory right-sizing guidance

**Files:** `nodejs-lambda.ts:172` (256 MB default);
[`doc/foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md).

**Issue:** 256 MB is a reasonable default but no design doc
justifies it or points consumers at AWS Lambda Power Tuner. The
project's "explain the default" pattern elsewhere is good; this is
a gap.

**Suggested fix:** Add an "explain the default" paragraph in the
construct doc citing Power Tuner; ship as part of the same
documentation pass as S5 / S6.

### N4 — X-Ray cost not disclosed under the paid-default axiom

**File:** `nodejs-lambda.ts:185` (`tracing: ACTIVE` default);
[`doc/foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md).

**Issue:** Active X-Ray tracing is free below 100k traces / month
across the account, then $5/million traces. At magic-link-auth-site
volumes this never bites; for high-RPS data-plane Lambdas it can.
The paid-default axiom applies; the disclosure is missing.

**Suggested fix:** One paragraph under "Recurring cost" in the
construct doc.

### N5 — Reserved-concurrency cost-DoS caps deserve a callout

**Files:** `magic-link-auth-site.ts:276` (`auth-verify`, 20),
`magic-link-auth-site.ts:303` (`auth-signout`, 5);
[`doc/vestibulum-cdk/04-magic-link-auth-site.md`](../vestibulum-cdk/04-magic-link-auth-site.md).

**Issue:** The 20 / 5 caps are doing real cost-DoS work — they're
the load-bearing defence after the WAF rate-limit — but they read
like ordinary tuning knobs in the construct. A consumer raising
them to 200 to "fix a throttling alarm" silently widens the
cost-DoS envelope.

**Suggested fix:** A two-line callout in the construct doc next to
the prop documentation: "this is a cost-DoS cap, not a perf tuning
knob; raise only after you have raised the WAF rate-limit and
verified the new envelope."

### N6 — No `tenantId` metric dimension for cost-attribution

**File:** [`packages/vestibulum-cdk/lib/metrics/`](../../packages/vestibulum-cdk/lib/metrics/);
[`doc/vestibulum-cdk/08-metrics.md`](../vestibulum-cdk/08-metrics.md).

**Issue:** Follow-up from S2. Custom CloudWatch metrics published
by the package don't carry a `tenantId` dimension, so post-hoc
per-tenant attribution from metric data isn't possible.

**Suggested fix:** Add a `tenantId` dimension to user-pool-derived
custom metrics in shared-distribution mode; document the
cardinality trade-off (CloudWatch charges per metric, dimensions
multiply metric count).

### N7 — No quarterly cost-pillar checkup template

**File:** New `doc/review/cost-pillar-checkup.md` template.

**Issue:** The *Optimize over time* focus area asks for a periodic
re-evaluation of cost defaults as AWS prices and free tiers shift.
The project has had three pre-launch design reviews — that pattern
should extend to recurring lightweight checkups.

**Suggested fix:** Add a `doc/review/cost-pillar-checkup.md`
template with a defaults table (PITR window, CloudFront Price
Class, ARM/x86 ratio, log retention, CMK count, alarm count,
dashboard count, X-Ray tracing on/off) to be filled in and dated
quarterly. Cheap to add, compounds across years.

## RETAIN-policy footnote

Stateful resources default to `RETAIN`: DDB tables
(`single-table.ts:119`, `magic-link-identity.ts:534`), Cognito user
pool (`magic-link-identity.ts:736`, `identity.ts:530`), SES identity
(`magic-link-identity.ts:660`), SQS queues
(`queue-with-dlq.ts:89,101`). This is **correct** for production
data safety and has been validated by the prior reviews.

For **ephemeral CI / preview / PR-stack** environments, RETAIN
creates orphan-cost: a teardown that doesn't actually tear down.
After three months of preview stacks landing, the account has N
orphan DDB tables and Cognito pools quietly accruing storage and
per-MAU costs.

Not a finding — there is no safe default for both modes — but
worth documenting as a "watch out" in
[`doc/06-deployment-topology.md`](../06-deployment-topology.md):
the preview-stack archetype should override `removalPolicy:
DESTROY` on stateful resources, and consumers running preview
infra should run an orphan-cleanup sweep quarterly. A future
`RemovalPolicyMode: 'production' | 'ephemeral'` switch on the
`*Cdk` constructs would formalise this.

## Findings table

| ID | Severity     | Area                             | Construct / doc                                 |
| -- | ------------ | -------------------------------- | ----------------------------------------------- |
| S1 | SIGNIFICANT  | Cloud financial management       | `foundation-cdk/aspects`                        |
| S2 | SIGNIFICANT  | Cloud financial management       | `vestibulum/shared-distribution/`               |
| S3 | SIGNIFICANT  | Cost-effective resources         | `foundation-cdk/single-table`                   |
| S4 | SIGNIFICANT  | Cost-effective resources         | `vestibulum-cdk/magic-link-auth-site`, `shared` |
| S5 | SIGNIFICANT  | Expenditure & usage awareness    | `foundation-cdk/{lambda,table,queue,dash}`      |
| S6 | SIGNIFICANT  | Expenditure & usage awareness    | `foundation-cdk/nodejs-lambda`                  |
| S7 | SIGNIFICANT  | Manage demand and supply         | `vestibulum-cdk/magic-link-identity`            |
| S8 | SIGNIFICANT  | Cost-effective resources         | `foundation-cdk/single-table` (doc)             |
| N1 | NIT          | Expenditure & usage awareness    | `doc/06-deployment-topology.md`                 |
| N2 | NIT          | Cloud financial management       | `foundation-cdk/aspects` (depends on S1)        |
| N3 | NIT          | Cost-effective resources         | `foundation-cdk/nodejs-lambda` (doc)            |
| N4 | NIT          | Expenditure & usage awareness    | `foundation-cdk/nodejs-lambda` (doc)            |
| N5 | NIT          | Manage demand and supply         | `vestibulum-cdk/magic-link-auth-site` (doc)    |
| N6 | NIT          | Cloud financial management       | `vestibulum-cdk/metrics` (depends on S2)        |
| N7 | NIT          | Optimize over time               | `doc/review/cost-pillar-checkup.md` (new)       |

## Suggested order of work

If only the top five are tackled, the order is:

1. **S1** (tagging aspect). Prerequisite for S2, N2, N6 and for
   AWS Budgets / Cost Explorer to be usable at all.
2. **S3** (PITR default → 7 days). Single-line code change, immediate
   cost reduction on every DDB table created by the package.
3. **S4** (S3 lifecycle policies). Single-construct change; compounds
   over the project's lifetime.
4. **S7** (SES inside the cost-DoS envelope). Closes a real gap in
   the documented envelope; analogous in spirit to the original
   `/auth-verify` rate-limit tightening (S-C8).
5. **S2** (per-tenant cost attribution doc). Documentation only;
   unblocks N6 and gives SaaS consumers an answer to the question
   they will be asked first.

S5, S6, and S8 are documentation-and-prop additions that can land
as a single PR.

None of the findings are BLOCKERs for `1.0.0`. They are tracked
into [`doc/12-remaining-work.md`](../12-remaining-work.md) under
"Cost-pillar follow-ups."
