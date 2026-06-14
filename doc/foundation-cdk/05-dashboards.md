# 05 — House dashboards

CloudWatch dashboard JSON templates ship as data assets in the
package, together with a small `houseDashboard()` substitution
helper. The templates encode the de-otio house dashboard patterns:
api-health (request rates, p99 latency, error rates), database
(DynamoDB throughput + alarms, RDS connection counts), workers
(Lambda concurrency, queue depths, DLQ).

Source pattern: `trellis/infra/lib/dashboards/*.json`.

## Why dashboards in a constructs package

Two reasons:

- **Empirically reused.** Trellis's three dashboard JSONs already
  encode three months of dashboard-tuning iteration. The next backend
  will rebuild them from scratch otherwise.
- **House pattern carries observability opinion.** Which metrics
  matter (Lambda throttles, DLQ depth, p99 latency over p50, GSI1
  consumed capacity vs base table) is part of the house operating
  posture. Codifying it in a shipped template captures that.

The dashboards are **templates** — JSON with named placeholders. They
are not generic enough to be true constructs in v0.1; codifying the
widget structure programmatically (via CDK's
`cloudwatch.GraphWidget`) is a v0.2 ambition once the templates have
stabilised through one or two more consumers.

## What ships

Three dashboard templates in `lib/dashboards/templates/`:

| Template     | Audience                    | Widgets                                                                                                                                        |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-health` | API consumer's request path | request rate (Sum), 5xx rate (Sum), p99 latency (Percentile), Lambda invocations / errors / throttles, ALB target healthy host count           |
| `database`   | Persistence layer           | DynamoDB consumed read/write capacity (table + GSI1), throttle events, ItemCount, RDS connection count / CPU / freeable memory (if applicable) |
| `workers`    | Async/queue tier            | Queue depth (visible / not-visible), DLQ depth, Lambda invocations / errors / iterator age, throttle events                                    |

Each template is a CloudWatch dashboard body JSON (the same shape
returned by the CloudWatch API's `GetDashboard` and accepted by
`PutDashboard`). The `metrics` arrays reference variables via
`${VARIABLE_NAME}` syntax; the substitution helper resolves them at
synth time.

## API

```typescript
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";

export type HouseDashboardName = "api-health" | "database" | "workers";

export interface HouseDashboardParams {
  /**
   * Dashboard name in CloudWatch. Globally unique per account/region.
   */
  dashboardName: string;

  /**
   * Variable substitutions. Each template declares its own variables;
   * passing an unknown variable throws. See § Per-template variables.
   */
  variables: Record<string, string>;

  /**
   * AWS region for metric references. Default: the stack region.
   */
  region?: string;
}

/**
 * Create a CloudWatch dashboard from a named house template.
 *
 * Throws if the template name is unknown or required variables are
 * missing.
 */
export function houseDashboard(
  scope: Construct,
  id: string,
  template: HouseDashboardName,
  params: HouseDashboardParams,
): cloudwatch.CfnDashboard;

/**
 * List available house dashboard template names. Useful for
 * generating consumer-side validation lists.
 */
export function listHouseDashboards(): HouseDashboardName[];

/**
 * Read a named house template and apply variable substitution,
 * returning the substituted dashboard-body JSON string (no CDK
 * resource is created). The escape hatch for "house template plus
 * custom widgets" — post-process the string and pass it to
 * `new cloudwatch.CfnDashboard(...)` yourself. Takes the same
 * `HouseDashboardParams` as `houseDashboard` (the `dashboardName`
 * field is ignored).
 */
export function readHouseTemplate(
  template: HouseDashboardName,
  params: HouseDashboardParams,
): string;
```

The function returns `cloudwatch.CfnDashboard` (L1) rather than
`cloudwatch.Dashboard` (L2). This is a **knowing deviation from CDK
guidance** ("always prefer L2 over L1"). The trade-off:

- L2 (`cloudwatch.Dashboard` + `addWidgets()` + `metric*()`) is
  type-safe and composable, but builds dashboards programmatically.
  House-template substitution does not flow naturally through that
  surface — the templates are JSON, and they want to stay JSON.
- L1 (`CfnDashboard.dashboardBody`) accepts the raw JSON the
  substitution helper produces. Composing this with consumer-added
  widgets requires the consumer to post-process the JSON
  themselves (the `readHouseTemplate` escape hatch), which is the
  intended seam.

If the second consumer surfaces a strong need for L2 composition
(e.g., "I want the house api-health dashboard plus four custom
widgets, type-safe"), the right v0.2 move is to ship a parallel
`L2HouseDashboard` builder construct, not to retrofit the templates
through L2.

## Per-template variables

Each template's variable contract is declared in
`lib/dashboards/contracts.ts` as `TEMPLATE_CONTRACTS`. Every variable
listed under `required` must be supplied (missing one throws at
synth); a variable under `optional` may be omitted, in which case the
smallest enclosing widget containing the placeholder is dropped from
the output.

| Template     | Required variables                          | Optional variables |
| ------------ | ------------------------------------------- | ------------------ |
| `api-health` | `REGION`, `LAMBDA_FUNCTION`, `ALB_ARN_SUFFIX` | _none_             |
| `database`   | `REGION`, `TABLE_NAME`                       | `GSI1_NAME`        |
| `workers`    | `REGION`, `LAMBDA_FUNCTION`, `QUEUE_NAME`    | `DLQ_NAME`         |

Notes:

- **`api-health`** uses `ALB_ARN_SUFFIX` (the ALB ARN's
  `app/<name>/<id>` suffix, the form the `AWS/ApplicationELB` metric
  dimension expects) — not an ALB name — and all three variables are
  required; there are no optional ALB widgets.
- **`database`** drops the GSI1 metric rows in the read/write
  capacity widgets when `GSI1_NAME` is omitted.
- **`workers`** drops the DLQ Depth widget when `DLQ_NAME` is omitted.
- All three templates require `REGION` (the metric region) explicitly.

Calling `houseDashboard(this, 'ApiHealth', 'api-health', { ... })`
with a missing required variable throws synchronously at synth time
with the missing-variable list. The helper's substitution pass
detects unfilled `${OPTIONAL}` slots and removes the enclosing widget
when the template marks that slot as optional in the contract.

## Substitution semantics

```typescript
function substitute(
  body: string,
  variables: Record<string, string>,
  contract: VariableContract,
): string;
```

The substitution helper:

- For each `${VARIABLE_NAME}` placeholder, computes the replacement
  via **JSON-string escape** of the supplied value
  (`JSON.stringify(value).slice(1, -1)`). This auto-escapes `"`,
  `\`, control characters, and Unicode escapes so substituted values
  cannot break out of their JSON string context — even if the value
  came from a `cdk.context.json` lookup or a consumer-supplied
  identifier with unusual characters.
- Validates that every variable in `contract.required` was supplied
  (throws if not).
- For variables in `contract.optional`, if absent, removes the
  smallest JSON-object enclosing the placeholder (i.e., the widget
  containing the unfilled slot).
- Validates that no `${...}` patterns remain in the output (catches
  typos in the template).
- Parses the output once via `JSON.parse` to confirm structural
  validity; throws on parse failure with the offending substitution
  identified.

Substitution is a string operation, not a JSON-AST traversal. The
auto-escape is what makes the string-substitution approach safe: the
helper rejects no value, but every value is treated as untrusted
string content.

**Limitation: string contexts only.** The auto-escape is correct for
substitutions that land inside a JSON string (`"name": "${VAR}"`).
Templates that place placeholders in non-string contexts — number
fields, boolean fields, array elements — would be miscompiled by the
escape. The shipped templates use only string-context substitutions
by convention; the helper rejects any template that places a
placeholder outside a string at a CI lint step (regex check on the
templates, not runtime).

## Consumer usage

```typescript
import { houseDashboard } from "@de-otio/saas-foundation-cdk/dashboards";

houseDashboard(this, "ApiHealth", "api-health", {
  dashboardName: `${appName}-${stage}-api-health`,
  variables: {
    REGION: Stack.of(this).region,
    LAMBDA_FUNCTION: apiFn.functionName,
    ALB_ARN_SUFFIX: alb.loadBalancerArn.split("loadbalancer/")[1],
  },
});
```

The consumer also gets the option to read the raw template and
extend it:

```typescript
import { readHouseTemplate } from "@de-otio/saas-foundation-cdk/dashboards";

const baseBody = readHouseTemplate("api-health", {
  dashboardName: "ignored-by-readHouseTemplate",
  variables: {
    /* REGION, LAMBDA_FUNCTION, ALB_ARN_SUFFIX */
  },
});
const extendedBody = appendCustomWidgets(baseBody, [
  /* ... */
]);
new cloudwatch.CfnDashboard(this, "ApiHealth", {
  dashboardName: "...",
  dashboardBody: extendedBody,
});
```

`readHouseTemplate` returns the substituted JSON string; consumers
can post-process before creating the dashboard. This is the
escape hatch for "the house template plus three custom widgets."

## Recurring cost

Per the [paid-by-default cost-disclosure
principle](../01-scope-and-philosophy.md#design-principles), the
default-on paid resources created by this construct:

| Resource              | Count per `houseDashboard()` call | Cost shape                                                                                                       | Opt-out |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| CloudWatch dashboard  | 1                                 | $3/dashboard/month after the first **3 free across the AWS account** (not per stack, not per region — account-wide). | Do not call `houseDashboard()` for that template, or use `readHouseTemplate()` + a single merged `CfnDashboard` |

**Important: the free tier is account-wide, not per stack.** The first
three CloudWatch dashboards in the account (across all stacks,
services, and teams) are free. Every dashboard beyond three costs
$3/month. The limit resets monthly but does not roll over.

**Worked example.** Nine stacks each calling `houseDashboard()` once
(one dashboard per stack):

- 9 dashboards total.
- 3 free.
- 6 paid × $3 = **$18/month**.

The three-template pattern (one `api-health`, one `database`, one
`workers` per stack) that ships with the house patterns means a single
stack already produces three dashboards — exhausting the free tier on
its own if it is the only stack. A second stack running the same
pattern means 6 dashboards, 3 paid, **$9/month**, and so on.

**Suppressing a dashboard.** There is no `dashboards: false` prop
because `houseDashboard()` is a free function, not a construct.
To suppress a specific dashboard, simply do not call
`houseDashboard()` for that template. To suppress all three
house dashboards in a given environment (e.g., ephemeral dev stacks),
omit all three `houseDashboard()` calls from the stack. The
`readHouseTemplate()` escape hatch lets a consumer merge multiple
templates into a single `CfnDashboard`, reducing the dashboard count
and therefore the cost.

## What does not ship

- **Programmatic dashboard builders.** v0.2 candidate. CDK's
  `cloudwatch.Dashboard` + `GraphWidget` is verbose; a fluent
  builder would help. Not yet.
- **Per-construct embedded dashboards.** Could `SingleTable`
  auto-emit a small dashboard for itself? Tempting but
  speculative — consumers might want one dashboard per stack
  spanning multiple tables. Defer.
- **Per-environment dashboard nesting.** Dashboards in CloudWatch
  don't nest natively; "nesting" via prefix-naming is the
  consumer's discipline. Out of scope.

## Open questions

- **Should templates be CDK L2 constructs or stay as JSON?** JSON is
  simpler for v0.1; constructs are more type-safe. Revisit after
  the second consumer adopts. The `houseDashboard()` function
  hides the choice from the consumer either way.
- **Variable validation: types or just presence?** Currently the
  contract declares names, not types — all values are strings.
  CloudWatch dashboard JSON is JSON; non-string values mostly
  flatten to strings cleanly. Skip type-tagging the contract
  unless a bug surfaces.
- **Should the package bundle a `dashboards/raw/`
  sub-path** so consumers can `import api from
'@de-otio/saas-foundation-cdk/dashboards/raw/api-health.json'`
  and own the substitution themselves? Marginal benefit; the
  `houseDashboard()` API covers the common case and
  `readHouseTemplate()` covers the post-process case. Defer.
