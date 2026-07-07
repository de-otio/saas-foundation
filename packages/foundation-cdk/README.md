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

## Constructs

### NodejsLambda

```ts
import { NodejsLambda } from "@de-otio/saas-foundation-cdk";

new NodejsLambda(this, "Worker", {
  entry: "src/worker.ts",
  prisma: { engine: "rhel-openssl-3.0.x" },
  alarmOnIteratorAge: { thresholdMinutes: 5 },
});
```

A Lambda function with house defaults (ARM64, X-Ray tracing, 30-day log retention, optional Prisma client bundling, and optional alarms for errors/throttles). See [`doc/foundation-cdk/02-nodejs-lambda.md`](https://github.com/de-otio/saas-foundation/tree/main/doc/foundation-cdk/02-nodejs-lambda.md).

### SesEmailIdentity

```ts
import { SesEmailIdentity } from "@de-otio/saas-foundation-cdk";

const identity = new SesEmailIdentity(this, "EmailIdentity", {
  domainName: "mail.example.com",
  hostedZone: zone,
  dmarc: { policy: "quarantine", rua: "dmarc@example.com" },
});

// Grant a Lambda permission to send through this identity
identity.grantSend(myLambda, ["noreply@example.com"]);
```

Provisions a domain identity for transactional email with Easy DKIM, custom MAIL FROM (SPF-aligned), DMARC record, TLS-required configuration set, and SNS topic for bounce/complaint events. When a Route53 hosted zone is provided, all DNS records are created automatically; otherwise they are emitted as CloudFormation outputs for manual entry.

**Properties:**
- `identity`: The verified `ses.EmailIdentity` (Easy DKIM enabled)
- `configurationSet`: The TLS-required configuration set
- `bounceComplaintTopic`: SNS topic receiving bounce and complaint events
- `domainName`: The verified domain (e.g. `mail.example.com`)
- `mailFromDomain`: The custom MAIL FROM domain (e.g. `mail.mail.example.com`)

**Method:**
- `grantSend(grantee, fromAddresses?)`: Grants `ses:SendEmail` and `ses:SendRawEmail` permission scoped to this identity, optionally restricted to specific `fromAddresses`.

See [`doc/foundation-cdk/07-ses-email-identity.md`](https://github.com/de-otio/saas-foundation/tree/main/doc/foundation-cdk/07-ses-email-identity.md) for detailed configuration options and DMARC policy guidance.

## Additional resources

Aspects (`HouseDefaultsAspect`) and the dashboard helpers
(`houseDashboard`, `listHouseDashboards`) are exported from the same
package root.

## Design docs

See [`doc/foundation-cdk/`](https://github.com/de-otio/saas-foundation/tree/main/doc/foundation-cdk)
in the source repository and the position paper at
[`doc/09-foundation-cdk-package.md`](https://github.com/de-otio/saas-foundation/blob/main/doc/09-foundation-cdk-package.md).

## License

Apache-2.0.
