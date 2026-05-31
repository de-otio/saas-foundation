# @de-otio/saas-foundation-cdk

AWS CDK constructs for the deployment plumbing every de-otio SaaS
back-end needs: an opinionated `NodejsLambda` (esbuild bundling with
optional Prisma engine packaging, IteratorAge alarms, log-group
retention defaults), a `QueueWithDlq` SQS + DLQ pair, a `SingleTable`
DynamoDB construct with on-demand billing and PITR defaults, three
ready-to-render CloudWatch dashboard templates, and a
`HouseDefaultsAspect` that enforces them across a stack via
construct-tree introspection (raw resources are detected by tag).

Pure constructs library — no runtime dependency on
`@de-otio/saas-foundation`.

## Install

```bash
npm install @de-otio/saas-foundation-cdk aws-cdk-lib constructs
```

Requires Node ≥ 24 and `aws-cdk-lib@^2.200`.

## Example

```ts
import { NodejsLambda } from "@de-otio/saas-foundation-cdk";

new NodejsLambda(this, "Worker", {
  entry: "src/worker.ts",
  prisma: { engine: "rhel-openssl-3.0.x" },
  alarmOnIteratorAge: { thresholdMinutes: 5 },
});
```

Aspects (`HouseDefaultsAspect`) and the dashboard helpers
(`houseDashboard`, `listHouseDashboards`) are exported from the same
package root.

## Design docs

See [`doc/foundation-cdk/`](https://github.com/de-otio/saas-foundation/tree/main/doc/foundation-cdk)
in the source repository and the position paper at
[`doc/09-foundation-cdk-package.md`](https://github.com/de-otio/saas-foundation/blob/main/doc/09-foundation-cdk-package.md).

## License

Apache-2.0.
