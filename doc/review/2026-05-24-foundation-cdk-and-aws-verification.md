# Second review pass — 2026-05-24

Focused review covering (a) the newly added `@de-otio/saas-foundation-cdk`
package, which had no prior review coverage, and (b) AWS-fact
verification across the existing design using the `aws-iac` and
`aws-knowledge` MCP servers.

The first review pass
([`2026-05-24-initial-design-pass.md`](2026-05-24-initial-design-pass.md))
remains the canonical punch list for the three original packages. This
pass does not re-litigate those findings; it identifies new ones,
verifies AWS-specific claims against current docs, and flags follow-ups
where the initial review's resolutions surfaced second-order issues.

## TL;DR

- **BLOCKERS (2)** — Lambda Node 22 is no longer the latest LTS
  (Node 24 shipped Nov 2025; supported until Apr 2028); mandatory
  `reservedConcurrentExecutions` collides with AWS's 100-unit floor.
- **HIGH-security (2)** — DDB PITR cost-disclosure parity with prior
  review's WAF/Cognito cost call-outs; dashboard substitution helper
  is unsafe by default for arbitrary string values.
- **SIGNIFICANT (11)** — CDK best-practice deviations, cross-construct
  validation gaps, alarm-name collisions, missing iterator-age alarm
  on the QueueWithDlq+NodejsLambda composition.
- **NITs (5)** — number tightening, prop completeness.

Foundation-cdk's overall shape is sound: subclassing `NodejsFunction`,
exposing alarms as public properties, the deliberate "constructs not
stacks" choice, and the wrap-trellis-patterns posture all match CDK
guidance. The blockers are concrete and contained.

## AWS-fact verifications (MCP)

Sources: `aws-iac__cdk_best_practices`, `aws-knowledge` search results
on Lambda runtimes, Cognito feature plans, Lambda concurrency, DDB
PITR, Lambda ARM64.

| Design claim                                                                                                                             | Verified?                                                                                                                                                                                                                                                                                                                                                                                               | Source                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "NODEJS_22_X is the longest-supported LTS in the Lambda runtime list" ([foundation-cdk/02](../foundation-cdk/02-nodejs-lambda.md))       | **No.** Node 24 shipped Nov 2025, supported until Apr 2028; Node 22 ends Apr 2027.                                                                                                                                                                                                                                                                                                                      | [Lambda + Node.js 24](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-lambda-nodejs-24/)                                                                                        |
| ARM64 default = "~20% cheaper, ~10% faster cold-start" ([foundation-cdk/02](../foundation-cdk/02-nodejs-lambda.md))                      | Conservative. AWS docs cite "up to 34% better price-performance" (19% perf + 20% cost).                                                                                                                                                                                                                                                                                                                 | [Lambda Graviton2 blog](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/) |
| Cognito feature tiers Lite/Essentials/Plus, V2/V3 event versions ([vestibulum-cdk/07](../vestibulum-cdk/07-cdk-changes-from-trellis.md)) | Yes. CDK exposes `FeaturePlan` enum; Essentials includes access-token customization via pre-token-gen V2.                                                                                                                                                                                                                                                                                               | [Cognito feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html)                                                                  |
| Cognito custom attributes immutable post-create ([vestibulum-cdk/07](../vestibulum-cdk/07-cdk-changes-from-trellis.md))                  | Yes (substantive — "required attributes must be set during user pool creation and cannot be changed afterward"). The specific `AdminLinkProviderForUser` claim about immutable attributes blocking link operations is plausible but I could not find a direct citation in the public docs; the design's footnote should be marked "empirical observation" rather than implying a documented constraint. | [Cognito user attributes](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html)                                                                |
| Cognito Hosted UI custom domain ACM cert must be in us-east-1 ([vestibulum-cdk/07](../vestibulum-cdk/07-cdk-changes-from-trellis.md))    | Yes. Same constraint as CloudFront.                                                                                                                                                                                                                                                                                                                                                                     | (well-established)                                                                                                                                                                     |
| DDB PITR continuous backup; restore creates a new table ([foundation-cdk/04](../foundation-cdk/04-single-table.md))                      | Yes; recovery window is 1–35 days **configurable**, not a fixed value.                                                                                                                                                                                                                                                                                                                                  | [DDB PITR](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)                                                                       |
| Reserved concurrency has no extra charge ([foundation-cdk/02](../foundation-cdk/02-nodejs-lambda.md))                                    | Yes — but **the account has a hard 100-unit unreserved floor** (see B2 below).                                                                                                                                                                                                                                                                                                                          | [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)                                                                             |

## BLOCKERS

### B1 — `NodejsLambda` hardcodes Node.js 22; not the latest LTS

**File:** [`foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md) (House defaults table, "runtime" row; § Open questions on `runtime` default vs prop).

**Issue:** Doc says "Node 22 is the longest-supported LTS in the
Lambda runtime list at v0.1." As of 2026-05-24, AWS Lambda has
supported Node 24 since Nov 2025; Node 24 is the longest-supported
LTS (Apr 2028 deprecation vs Node 22's Apr 2027). The design's
justification ("longest support window") points at Node 24.

CDK best-practice guidance also now recommends `Runtime.NODEJS_LATEST`
to auto-track LTS, with the trade-off that runtime upgrades happen on
CDK release rather than under consumer control.

**Suggested fix:** Pick one of:

1. Bump the pin to `Runtime.NODEJS_24_X`. Keep the "we pin Node runtime in the construct" position.
2. Switch to `Runtime.NODEJS_LATEST` and revise the open question ("`runtime` default vs prop") to: pin to LATEST, override per-construct via prop if a consumer needs determinism.

Recommend (1) — the predictability outweighs the auto-track ergonomic
gain at the construct level.

### B2 — Mandatory `reservedConcurrentExecutions` collides with the 100-unit unreserved floor

**File:** [`foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md) § Props, `reservedConcurrentExecutions: number; // Required (not optional).`

**Issue:** AWS Lambda requires that "at least 100 units of unreserved
concurrency must remain in the account for other functions." Default
account concurrency is 1000 in most regions. If every Lambda created
via `NodejsLambda` _must_ have a non-zero reserved value, a consumer
with ~20–30 Lambdas at modest caps (50–100 each) exhausts the
unreserved pool and **cannot deploy new functions** until they raise
their account quota or shrink reservations. Worse, this fails at
_deploy time_ with a non-obvious error.

The construct also conflates two distinct concerns: (a) cap a
function for downstream protection (low value); (b) guarantee
capacity for a critical function (high value). The "mandatory cap"
posture assumes every function wants (a), which isn't true for
infrequent crons or admin endpoints.

**Suggested fix:**

1. Make `reservedConcurrentExecutions` _optional_ with no default (CDK default is unreserved).
2. Add a _separate_ opt-in prop `concurrencyCap?: number` that explicitly _caps_ (calls `setReservedConcurrency`) — names the intent.
3. Document the 100-unit floor explicitly and the sum-of-reservations consequence.
4. Add an Aspect that warns at synth if the sum of reservations across a stack exceeds `accountQuota - 100`.

This preserves the discipline intent ("think about concurrency for
critical functions") without forcing the trap. Trellis-side review
discipline (every Lambda has a cap) can stay as a project-level
policy, not a construct-level enforcement.

## HIGH-security

### H1 — DDB PITR cost-disclosure parity with prior review (B-G/B-H)

**File:** [`foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md) (House defaults, "PITR" row says "Recovery is cheap; data loss is expensive.").

**Issue:** PITR is **billed continuously based on table size**,
including LSIs. For a 100 GB table the cost is non-trivial ($0.20/GB-month
in us-east-1 = $20/month, per table, indefinitely). The "PITR is cheap"
line is the same shape as the WAF/Cognito-AdvancedSecurity cost
surprises the initial review flagged as B-G and B-H — paid feature
defaulted on without disclosure.

Unlike B-G/B-H, the _default-on_ posture is correct here (data loss
risk dominates cost risk for most consumers). The problem is the
prose understates the recurring cost.

**Suggested fix:**

1. Replace "Recovery is cheap; data loss is expensive" with the
   billed-by-table-size disclosure and a sample monthly figure.
2. Add a prop `pointInTimeRecovery?: boolean` (default `true`) for
   consumers who knowingly opt out (e.g., ephemeral CI tables).
3. Surface the **configurable recovery window (1–35 days)** as a
   prop. Per AWS docs the window length doesn't affect PITR billing
   directly, but does affect the restore granularity. Defaulting to
   35 (maximum) is generous; consumers who only need 7 days could
   reasonably want a tighter window for compliance reasons.

### H2 — `houseDashboard()` string substitution is unsafe for arbitrary values

**File:** [`foundation-cdk/05-dashboards.md`](../foundation-cdk/05-dashboards.md) § Substitution semantics.

**Issue:** "Substitution is a string operation, not a JSON-AST
traversal." If a substituted value contains a `"`, `\`, newline, or
the literal sequence `${...}`, the resulting JSON is malformed or
mis-parsed. Likely values from a CDK stack — `apiFn.functionName`,
`alb.loadBalancerName` — are safe because CDK generates predictable
identifiers, but consumer-supplied values (e.g., a stage name read
from `cdk.context.json`) could include unsafe characters.

The post-substitution `JSON.parse` check catches _malformed_ JSON
but does not catch _semantically wrong_ JSON (e.g., a value that
breaks out of its string context and is now interpreted as a JSON
object).

**Suggested fix:**

1. JSON-escape every substituted value automatically (`JSON.stringify(value).slice(1, -1)` for string-context substitutions).
2. Document explicitly that the helper handles only string-context substitutions; non-string contexts (number, boolean, array) require AST-based templating.
3. Add a synth-time check that rejects any substituted value containing characters that require escaping if (1) is not adopted.

A consumer who reads a stage name from a context lookup and passes
it to `houseDashboard({ STAGE_NAME: stage })` should not be the one
discovering this. The default must be safe.

## SIGNIFICANT

### S1 — Alarm names embed physical resource name → cross-stack collision risk

**Files:** [`foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md), [`foundation-cdk/03-queue-with-dlq.md`](../foundation-cdk/03-queue-with-dlq.md), [`foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md).

CloudWatch alarm names are unique per region per account. The
constructs generate alarm names like `${functionName}-throttled` and
`${tableName}-write-spike`. If two stacks pick the same
`functionName` or `tableName` (e.g., per-stage names that drop the
stage prefix), the second stack fails synth or — worse — silently
overwrites the first. Trellis avoids this by stage-prefixing every
physical name; foundation-cdk inherits the risk without surfacing it.

**Suggested fix:** Document that physical names must be globally
unique within the account+region; or let CDK auto-generate alarm
names (drop the explicit `alarmName`) and only set the
`alarmDescription`.

### S2 — `QueueWithDlq` + `NodejsLambda` composition missing iterator-age alarm

**File:** [`foundation-cdk/03-queue-with-dlq.md`](../foundation-cdk/03-queue-with-dlq.md) § Cross-construct composition.

The canonical signal for "queue consumer is falling behind" is
Lambda's `IteratorAge` metric on SQS event sources. The construct
docs show the composition pattern but no construct creates this
alarm. A DLQ alarm tells you the consumer _gave up_ on a message;
iterator-age tells you the consumer is _struggling_. Both matter.

**Suggested fix:** When `NodejsLambda` is wired to a queue event
source, expose an `addQueueIteratorAgeAlarm(queue)` helper on
`NodejsLambda`, or create the alarm automatically via the public
`alarms` prop family. The threshold is workload-dependent; default
to 5 minutes with a clear "override per workload" note.

### S3 — `QueueWithDlq` does not validate visibility-timeout vs Lambda timeout

**File:** [`foundation-cdk/03-queue-with-dlq.md`](../foundation-cdk/03-queue-with-dlq.md) § House defaults.

When `QueueWithDlq.queue` is wired to a `NodejsLambda` event source,
AWS guidance is that the SQS visibility timeout should be **at least
6× the Lambda timeout** to avoid duplicate message processing. The
default (30s visibility timeout, 30s Lambda timeout) violates this
1:1. The construct docs don't warn or enforce.

**Suggested fix:** At synth (in the `NodejsLambda.addEventSource(sqs)`
codepath, or via a `Vibility` aspect), validate the ratio and warn
on `visibilityTimeout < 6 × functionTimeout`. Document the 6×
multiplier explicitly.

### S4 — `SingleTable` GSI1 always-on; consumer pays for unused GSI

**File:** [`foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md) § Props ("Out").

GSI1 is hardcoded on. GSI doubles write cost (every base-table write
hits the index too) and adds storage. A consumer who hasn't yet
designed an access pattern that uses `gsi1pk/gsi1sk` pays the cost
with no benefit. Removing a GSI from a populated table later is also
non-trivial — it's a `DeleteGlobalSecondaryIndex` operation that
blocks until the GSI is drained.

**Suggested fix:** Add `enableGsi1?: boolean` (default `true`). The
"opinionated single-table pattern" stays — GSI1 is the canonical
pattern — but a consumer can opt out at table-creation time with a
known-tradeoff prop. Drop-after-create is the consumer's
responsibility.

### S5 — `NodejsLambda` X-Ray active + VPC = silent trace drop without endpoint

**File:** [`foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md) § House defaults (X-Ray ACTIVE) + § Open questions ("X-Ray + VPC Lambdas need NAT egress").

The open question correctly identifies the issue but defers to "warns
and documents, doesn't auto-wire." For an opinionated house construct,
this is too permissive: X-Ray traces silently disappear, which is a
debug-the-debugger failure mode. Promote to significant.

**Suggested fix:** At synth (Aspect or constructor check): if `vpc`
is set and `tracing` is `ACTIVE`, fail unless the consumer has either
(a) declared a NAT path (default subnets configuration allows it), or
(b) opted into `acknowledgeXrayVpc?: boolean` to silence the check.
Document the X-Ray VPC interface endpoint pattern as the
recommended fix.

### S6 — No CDK Aspects shipped for compliance enforcement

**Files:** All [`foundation-cdk/`](../foundation-cdk/) docs.

CDK best practices: "Don't rely solely on wrapper constructs for
compliance — they can be circumvented. Use Aspects and CDK-Nag for
validation." Foundation-cdk currently ships wrappers; a consumer who
does `new dynamodb.Table(...)` directly bypasses every house default.
The package design doesn't address this.

**Suggested fix:** Ship a `HouseDefaultsAspect` that warns at synth
when:

- a raw `lambda.Function` or `lambda.NodejsFunction` exists outside `NodejsLambda`
- a raw `dynamodb.Table` exists outside `SingleTable`
- a raw `sqs.Queue` exists outside `QueueWithDlq` (with deadLetterQueue unset)

Severity: warning, not error — consumers may legitimately opt out
per resource. Foundation-cdk also bundles `cdk-nag` as an opt-in
("set `Aspects.of(app).add(new AwsSolutionsChecks())` to enable")
with a brief note in [`01-package-api.md`](../foundation-cdk/01-package-api.md) §
Testing posture. Currently no shipped aspect, no cdk-nag wiring,
no compliance posture.

### S7 — `houseDashboard()` returns L1 (`CfnDashboard`); CDK guidance is L2

**File:** [`foundation-cdk/05-dashboards.md`](../foundation-cdk/05-dashboards.md) § API.

CDK best practice: "Always prefer L2 constructs over L1." The L2
`cloudwatch.Dashboard` is available and provides `addWidgets()` /
`metric*()` helpers. The design justifies L1 ("templates flow more
naturally through the L1's `dashboardBody` raw-JSON prop") but doesn't
acknowledge the deviation.

**Suggested fix:** Acknowledge the deviation explicitly. The L1 choice
is defensible here (template-with-substitution is hard to compose with
L2 widgets), but the next reader should not wonder why.

### S8 — Per-package `package.json` snippets show no `cdk-nag` dev-dep

**File:** [`foundation-cdk/01-package-api.md`](../foundation-cdk/01-package-api.md) § package.json sketch.

CDK best practices encourage CDK-Nag for compliance. The foundation-cdk
`package.json` sketch has no `cdk-nag` dev-dep; the README has no
cdk-nag note. If the package's _test suite_ doesn't snapshot-assert
against CDK-Nag warnings on the synth output of each construct, drift
will happen.

**Suggested fix:** Add `cdk-nag` as a devDependency. In each
construct's test file, synth a throwaway stack with the construct,
apply `AwsSolutionsChecks`, and assert the warnings against a
snapshot. The snapshot serves two purposes: (a) catches regressions
when the construct grows, (b) documents which nag rules the construct
intentionally violates.

### S9 — No CloudWatch Logs encryption posture documented for `NodejsLambda`

**File:** [`foundation-cdk/02-nodejs-lambda.md`](../foundation-cdk/02-nodejs-lambda.md) § House defaults.

Lambda CloudWatch Logs are encrypted by AWS-managed KMS by default
(adequate for most workloads). For consumers with stricter compliance
postures (EU residency, customer-managed keys), the construct should
accept a `logsEncryptionKey?: kms.IKey`. Not addressed.

Same shape as `QueueWithDlq`'s already-present `encryption.customer-managed`
discriminated-union — apply the same pattern to log groups.

### S10 — `cdk.context.json` commit-to-VCS guidance absent

**File:** [`02-monorepo-layout.md`](../02-monorepo-layout.md), [`foundation-cdk/`](../foundation-cdk/) docs.

CDK best practice: commit `cdk.context.json` so AZ lookups / VPC
lookups / AMI lookups are deterministic. Not mentioned in the
monorepo-layout doc or any per-package doc. Affects examples
(`examples/magic-link-on-cloudfront/`) once the CDK example app
materialises.

**Suggested fix:** Add a one-paragraph note to
[`02-monorepo-layout.md § Examples`](../02-monorepo-layout.md#examples)
about committing `cdk.context.json` per example app, and a sentence
to the foundation-cdk and vestibulum-cdk READMEs reminding consumers
of the same.

### S11 — `SingleTable` doesn't address streams / Kinesis attachment

**File:** [`foundation-cdk/04-single-table.md`](../foundation-cdk/04-single-table.md) § Open questions.

Already an open question, but worth promoting: DDB Streams is the
canonical change-data-capture mechanism. Consumers wiring an event-
driven workflow want it from day one. The construct should accept
`stream?: dynamodb.StreamViewType` and expose `table.tableStreamArn`
for downstream wiring. Trellis doesn't need it; the next backend
might.

Defer to v0.2 if the next consumer doesn't ask immediately, but
mention it explicitly in the README's "what does not ship" list.

## NITs

- **N1.** ARM64 cost-perf claim in [foundation-cdk/02](../foundation-cdk/02-nodejs-lambda.md) ("~20% cheaper, ~10% faster cold-start") is conservative. AWS docs cite "up to 34% better price-performance" (19% perf + 20% cost). Tighten to match the citation, or drop the specific percentages and link to AWS docs.

- **N2.** PITR recovery window not a prop. [foundation-cdk/04](../foundation-cdk/04-single-table.md) implies a single fixed setting; AWS supports 1–35 days configurable. Add the prop.

- **N3.** `AdminLinkProviderForUser` immutable-attribute claim in [vestibulum-cdk/07 § FederationCustomAttributesAspect](../vestibulum-cdk/07-cdk-changes-from-trellis.md). I could not find a direct AWS-docs citation; the claim is plausible (the operation has documented constraints on attribute conflicts) but the design implies it's a documented constraint. Reframe as "empirical observation — confirm against a real test pool before treating as a hard rule" or add the citation.

- **N4.** Lambda runtime auto-bump strategy: with `Runtime.NODEJS_24_X` pinned in the construct, every Lambda LTS rotation requires a foundation-cdk minor bump and consumer-side cascade. Document this rotation cadence (Apr 2027 = Node 22 EOL → bump; Apr 2028 = Node 24 EOL → bump). Adds about one minor every 18 months.

- **N5.** `featureTier: 'Lite'/'Essentials'/'Plus'` naming matches CDK's `FeaturePlan` enum (verified via MCP). The design's type union is correct; consider re-exporting CDK's `cognito.FeaturePlan` instead of duplicating the string union — fewer drift surfaces.

## Cross-cutting observations

### Coherence with prior review

- **B-A (frozen-type location)** — design status claims integration. Worth a follow-up spot-check that the foundation-cdk doc's "type-only imports from saas-foundation allowed" rule (a new boundary the initial review didn't anticipate) is consistent with the resolved layer-0 design.
- **B-G / B-H (paid features defaulted on)** — the _pattern_ is recurring. H1 above is the same shape on PITR. Worth canonicalising a "default-on paid features must surface monthly cost in the props doc" rule in [`01-scope-and-philosophy.md`](../01-scope-and-philosophy.md). Foundation-cdk's PITR, vestibulum-cdk's WAF managed rules, Cognito Advanced Security, future WAF rule packs all need the same treatment.
- **S-C12 (Vestibulum branding leaks)** — same risk for foundation-cdk: alarm names contain `${tableName}-write-spike`, dashboard JSON contains `${API_NAME}` placeholders. No "house" branding leaks yet, but the next construct (e.g., a `HouseAlb`) should remember to make namespace overridable.

### What the design got right

- Subclassing `NodejsFunction` (vs wrapping in `Construct`) — direct port from trellis, matches CDK's "extend L2 to change defaults" pattern.
- Public alarm properties — composable, matches the open question's lean.
- "Constructs not stacks" position in [09-foundation-cdk-package.md](../09-foundation-cdk-package.md) — matches CDK guidance ("Model with constructs, deploy with stacks").
- Prisma bundling as opt-in, externalising `@aws-sdk/*` — both correct and well-documented.
- Type-only imports from foundation runtime — defensible, prevents synth-time SDK pollution.

### Recommendations — priority

1. **B1 (Node 24 bump)** — single-line change in the construct; cascades to the docs. Land before the first foundation-cdk publish.
2. **B2 (reserved-concurrency mandatory)** — design change, not single-line. Decide before any code. This is the highest-leverage fix; current design ships a trap.
3. **H1 + H2 (PITR cost disclosure, dashboard substitution safety)** — both small doc/code fixes; bundle together.
4. **S1 + S2 + S3 + S5 (cross-construct validations and alarm coverage)** — these define the foundation-cdk composability posture. Decide as a group.
5. **S6 + S8 (Aspects + cdk-nag wiring)** — strategic; affects every future construct.
6. **NITs** — sweep at the same time as B1.

Items 1–3 are concrete edits; items 4–5 are policy choices that should
settle before the v0.1 construct implementations begin.

## Status

**Integrated 2026-05-24.** All BLOCKER (2), HIGH-security (2),
SIGNIFICANT (11), and NIT (5) items have been folded into the design
docs. Specifically:

- **B1, B2, S1, S5, S9, N1, N4** → [foundation-cdk/02-nodejs-lambda.md](../foundation-cdk/02-nodejs-lambda.md)
  (Node 24 pin; reserved-concurrency optional + floor disclosure;
  CDK-auto-generated alarm names; synth-time X-Ray-VPC check;
  `logsEncryptionKey` prop; ARM64 numbers tightened; LTS rotation
  cadence section).
- **S1, S2, S3** → [foundation-cdk/03-queue-with-dlq.md](../foundation-cdk/03-queue-with-dlq.md)
  (auto-generated alarm names; companion iterator-age alarm via
  `NodejsLambda.addQueueIteratorAgeAlarm`; 6× visibility-timeout
  validation at event-source attach).
- **H1, S1, S4, S11, N2** → [foundation-cdk/04-single-table.md](../foundation-cdk/04-single-table.md)
  (PITR cost disclosure + `pointInTimeRecovery` /
  `pointInTimeRecoveryDays` props; `enableGsi1` opt-out; `stream`
  prop for DDB Streams; auto-generated alarm names; cost-disclosure
  summary).
- **H2, S7** → [foundation-cdk/05-dashboards.md](../foundation-cdk/05-dashboards.md)
  (JSON-string-escape auto-substitution; L1-vs-L2 deviation
  acknowledged).
- **S6** → new [foundation-cdk/06-aspects.md](../foundation-cdk/06-aspects.md)
  (`HouseDefaultsAspect`).
- **S8** → [foundation-cdk/01-package-api.md](../foundation-cdk/01-package-api.md)
  (`cdk-nag` as devDep; snapshot-asserted testing posture).
- **S10** → [02-monorepo-layout.md § Examples](../02-monorepo-layout.md#examples)
  (`cdk.context.json` commit-to-VCS note).
- **N3** → [vestibulum-cdk/07-cdk-changes-from-trellis.md](../vestibulum-cdk/07-cdk-changes-from-trellis.md)
  (AdminLinkProviderForUser claim reframed as empirical pending
  verification).
- **N5** → same doc (re-export CDK `FeaturePlan` rather than
  duplicating the string union).
- **Cross-cutting (paid-defaults rule)** → new design principle in
  [01-scope-and-philosophy.md § Design principles](../01-scope-and-philosophy.md#design-principles).

The first-pass review's BLOCKER and HIGH items remain the canonical
punch list for foundation / vestibulum / vestibulum-cdk (separately
status-tracked in the initial-design-pass doc).

Next concrete step: the tooling-only skeleton PR (root
`package.json`, workspace layout, empty package dirs) per the root
[README's status section](../../README.md#status).
