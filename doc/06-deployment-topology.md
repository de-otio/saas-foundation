# 06 — Deployment topology

The consumer's-eye-view cookbook. How a backend application picks
which packages to install, wires the runtime primitives together,
and deploys the result. Three archetypes, ordered from
least-opinionated to most-opinionated.

This doc references per-package designs heavily — it is not a
re-implementation of them. When a section says "see
`[foundation/03-secrets.md]`", that's the source of truth; this doc
sketches the integration shape.

## Three archetypes

| Archetype | foundation | vestibulum | foundation-cdk | vestibulum-cdk | Typical consumer                                    |
| --------- | ---------- | ---------- | -------------- | -------------- | --------------------------------------------------- |
| A         | yes        | optional   | optional       | no             | Multi-tenant SaaS API behind any front end          |
| B         | yes        | yes        | optional       | yes            | Magic-link auth in front of a CloudFront site       |
| C         | yes        | yes        | optional       | partial        | SaaS API plus a small admin UI with magic-link auth |

The three are not exclusive — a consumer can run an Archetype A API
plus an Archetype B admin site in the same AWS account. The
difference is what each _workload_ installs.

`foundation-cdk` is "optional" in all three archetypes because every
consumer needs Lambdas, queues, and tables in some form, but
foundation-cdk's house defaults (ARM64, mandatory concurrency caps,
DLQ-on-every-queue, single-table pattern) are an opinion the
consumer adopts or doesn't. A consumer who wants the house defaults
installs it; one with idiosyncratic infra writes their own
constructs with raw `aws-cdk-lib`. See
[`09-foundation-cdk-package.md`](09-foundation-cdk-package.md).

## Archetype A — multi-tenant SaaS API

The most common shape. A backend service that accepts authenticated
requests, scopes work to tenants, persists data, emits audit events,
and runs on AWS. Identity is via a Cognito user pool the consumer
operates (vestibulum optional); the front end can be anything.

### Install

```jsonc
// package.json
{
  "dependencies": {
    "@de-otio/saas-foundation": "^0.2.0",
    "@de-otio/vestibulum": "^0.2.0", // optional; only if Cognito
    "hono": "^4.0.0",
    "@hono/zod-openapi": "^0.x", // if you want OpenAPI
    "helmet-csp": "^1.x", // or framework alternative
    "cockatiel": "^3.x", // if you need retry policy
    "zod": "^3.x",
    "ulid": "^2.x",
  },
  "engines": { "node": ">=24.0.0" },
}
```

The OSS-reuse picks are settled by
[`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#design-principles):
Hono for HTTP, helmet for security headers, cockatiel for retry,
zod for validation, ulid for IDs.

### Startup wiring

A minimal `server.ts` that exercises every foundation primitive:

```typescript
import { Hono } from "hono";
import { configureRootLogger, getRequestContext } from "@de-otio/saas-foundation/logger";
import { SsmSecretsLoader, resolveSecret } from "@de-otio/saas-foundation/secrets";
import { DynamoKv } from "@de-otio/saas-foundation/kv";
import { S3Storage } from "@de-otio/saas-foundation/storage";
import { SqsQueue } from "@de-otio/saas-foundation/queue";
import { SubdomainTenantResolver } from "@de-otio/saas-foundation/tenant";
import { requestContextMiddleware } from "@de-otio/saas-foundation/request-context";
import { auditMiddleware, DynamoAuditStore } from "@de-otio/saas-foundation/audit";
import { trustedClientIp } from "@de-otio/saas-foundation/net";
import { createMultiPoolVerifier } from "@de-otio/vestibulum";

// 1. Logger first — every other module logs through it.
configureRootLogger({
  service: "my-api",
  environment: process.env.ENVIRONMENT ?? "dev",
});

// 2. Secrets loader — used to resolve credentials below.
const secrets = new SsmSecretsLoader({
  region: process.env.AWS_REGION,
  cacheTtlSeconds: 300,
});

// 3. Cloud primitives.
const kv = new DynamoKv({ tableName: process.env.KV_TABLE });
const storage = new S3Storage({ bucket: process.env.MEDIA_BUCKET });
const queue = new SqsQueue({ queueUrl: process.env.WORK_QUEUE_URL });

// 4. Audit store.
const auditStore = new DynamoAuditStore({
  tableName: process.env.AUDIT_TABLE,
});

// 5. Tenant resolver — strategy depends on URL shape.
const tenantResolver = new SubdomainTenantResolver({
  rootDomain: "app.example.com",
});

// 6. JWT verification (only if using Cognito).
const verifier = createMultiPoolVerifier([
  {
    poolKey: "b2c",
    userPoolId: process.env.COGNITO_B2C_POOL_ID!,
    clientId: process.env.COGNITO_B2C_CLIENT_ID!,
    region: process.env.AWS_REGION!,
    tokenUse: "access",
  },
]);

// 7. Hono app with foundation middleware in the right order.
const app = new Hono();

app.use(
  requestContextMiddleware({
    tenantResolver,
    clientIpResolver: trustedClientIp,
  }),
);

app.use(auditMiddleware({ store: auditStore }));

// 8. Auth on protected routes.
app.use("/api/*", async (c, next) => {
  const token = c.req.header("authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const verified = await verifier.verify(token);
  const ctx = getRequestContext();
  ctx.principal = { kind: "user", userSub: verified.claims.sub, sessionId: verified.claims.jti };
  await next();
});

// 9. Routes.
app.get("/api/hello", (c) => c.json({ ok: true }));

export default app;
```

Wiring order is load-bearing:

- **Logger before everything else.** Other modules log on init.
- **Secrets loader before AWS clients that need credentials.** Most
  AWS clients use the default credential chain, but bootstrap
  secrets (third-party API keys, encryption salts) come from
  `secrets`.
- **`requestContextMiddleware` before `auditMiddleware`.** Audit
  events read tenant/principal from the context.
- **Both before auth middleware.** Auth populates `principal`; it
  doesn't construct the context.

Detailed semantics in
[`foundation/07-logger-and-request-context.md`](foundation/07-logger-and-request-context.md),
[`foundation/05-tenant-context.md`](foundation/05-tenant-context.md),
[`foundation/06-audit-log.md`](foundation/06-audit-log.md),
[`vestibulum/05-jwt-verification.md`](vestibulum/05-jwt-verification.md).

### Deployment shape

Foundation does not prescribe an execution environment. The
following are all valid:

- **ECS Fargate** behind an ALB. Trellis ships this today; the
  trusted-proxy IP derivation handles ALB headers natively.
- **Lambda + API Gateway / Function URL.** Foundation modules are
  Lambda-cold-start-friendly (no heavy bootstrap; AWS clients
  lazily initialized).
- **Lambda + Lambda@Edge.** Lambda@Edge has restrictions (no env
  vars, `us-east-1` only) — foundation modules that need env
  config don't run there; the JWT verifier and the IP derivation
  do.
- **EKS / EC2.** Same shape as ECS, with the consumer's own load
  balancer.

The choice does not affect which foundation modules you install —
only the deployment manifest changes. CDK constructs for these
shapes are out of scope for saas-foundation;
[`01-scope-and-philosophy.md`](01-scope-and-philosophy.md) §
"vestibulum-cdk" pins this.

### IAM the consumer's runtime role needs

Minimum IAM for the example above (the per-module docs spell out
the exact actions):

- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`,
  `DeleteItem` on the KV table.
- `s3:GetObject`, `PutObject`, `DeleteObject` on the media bucket.
- `sqs:SendMessage`, `ReceiveMessage` on the work queue.
- `dynamodb:PutItem`, `Query` on the audit table.
- `ssm:GetParameter`, `secretsmanager:GetSecretValue` on the
  secret ARNs the consumer reads.

The audit-store write permission is the most security-sensitive —
restricting it to `PutItem` only (no `UpdateItem`, no `DeleteItem`)
enforces the append-only invariant at the IAM layer, not just the
application layer.

## Archetype B — magic-link CloudFront site

The canonical opinionated topology. A static or low-traffic web
origin behind CloudFront, with passwordless magic-link
authentication, Lambda@Edge JWT verification, EU-residency-friendly
data plane. This is what `@de-otio/vestibulum-cdk` was built for.

### Install

```jsonc
{
  "dependencies": {
    "@de-otio/saas-foundation": "^0.2.0",
    "@de-otio/vestibulum": "^0.2.0",
  },
  "devDependencies": {
    "@de-otio/vestibulum-cdk": "^0.3.0",
    "@de-otio/saas-foundation-cdk": "^0.3.0", // optional — if the
    // app also defines
    // Lambdas / queues /
    // tables behind the
    // magic-link site
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0",
  },
  "engines": { "node": ">=24.0.0" },
}
```

vestibulum-cdk and foundation-cdk are devDeps because CDK runs at
deploy time, not in any runtime process. The two CDK packages
compose without overlap — vestibulum-cdk owns the magic-link
identity topology; foundation-cdk owns generic deployment plumbing
(Lambdas behind the site, async queues, DDB tables).

### Minimal CDK app

```typescript
// bin/app.ts
import { App, Stack } from "aws-cdk-lib";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { EdgeResources, MagicLinkIdentity, MagicLinkAuthSite } from "@de-otio/vestibulum-cdk";

const app = new App();

// Edge resources MUST live in us-east-1 (Lambda@Edge + ACM cert).
const globalStack = new Stack(app, "AppGlobal", {
  env: { region: "us-east-1" },
  crossRegionReferences: true,
});
const edge = new EdgeResources(globalStack, "Edge", {
  domain: "app.example.com",
  hostedZone: HostedZone.fromLookup(globalStack, "Zone", {
    domainName: "example.com",
  }),
});

// Identity stack — pick your residency region.
const identityStack = new Stack(app, "AppIdentity", {
  env: { region: "eu-central-1" },
  crossRegionReferences: true,
});
const identity = new MagicLinkIdentity(identityStack, "Identity", {
  hostedZone: HostedZone.fromLookup(identityStack, "Zone", {
    domainName: "example.com",
  }),
  domain: "app.example.com",
  emailFrom: "no-reply@example.com",
});

// Site stack — origin + edge auth + identity wiring.
const siteStack = new Stack(app, "AppSite", {
  env: { region: "eu-central-1" },
  crossRegionReferences: true,
});
new MagicLinkAuthSite(siteStack, "Site", {
  edge,
  identity,
  // origin: ... your S3 bucket or other origin
});
```

Three stacks because Lambda@Edge / ACM require `us-east-1` while
the rest of the deployment can live anywhere. The construct
documentation spells out the constraints in detail:
[`vestibulum-cdk/03-edge-resources.md`](vestibulum-cdk/03-edge-resources.md),
[`vestibulum-cdk/02-magic-link-identity.md`](vestibulum-cdk/02-magic-link-identity.md),
[`vestibulum-cdk/04-magic-link-auth-site.md`](vestibulum-cdk/04-magic-link-auth-site.md).

### What the constructs deploy

- **`EdgeResources`** → CloudFront distribution, ACM cert,
  Route 53 alias, Lambda@Edge function (JWT verifier bundled from
  vestibulum), WAF web ACL.
- **`MagicLinkIdentity`** → Cognito user pool with `CUSTOM_AUTH`,
  three Cognito trigger Lambdas (define-auth / create-auth /
  verify-auth, bundled from vestibulum), DynamoDB code-challenge
  table with TTL, SES identity, IAM roles.
- **`MagicLinkAuthSite`** → S3 origin (if static), CloudFront
  behaviors, the login pages from `vestibulum-cdk/lib/login-pages/`.

The bundled vestibulum runtime ships with the construct package; no
separate install. The bundle pipeline is documented in
[`vestibulum-cdk/10-lambda-bundle-pipeline.md`](vestibulum-cdk/10-lambda-bundle-pipeline.md).

### Backend wiring (if there is one)

If the CloudFront origin is an API rather than static content, that
API is an Archetype A workload that additionally trusts JWTs
minted by `MagicLinkIdentity`. The
`createMultiPoolVerifier` configuration uses the Cognito pool ID
the construct exposes via stack output.

## Archetype C — hybrid

A SaaS API (Archetype A) plus a magic-link admin site (Archetype B
fragment) in one AWS account. Useful when the consumer wants:

- A B2B-or-B2C API at `api.example.com` with its own auth flow.
- An internal admin UI at `admin.example.com` protected by magic-link
  for the operator team.

Both workloads share `@de-otio/saas-foundation` (one version) and
`@de-otio/vestibulum` (one version, peer-dep on foundation). The
admin UI deploys via vestibulum-cdk; the API deploys via the
consumer's own CDK or other tool. The two Cognito user pools are
separate (one per workload), wired into the multi-pool verifier
per [`vestibulum/06-pool-topology.md`](vestibulum/06-pool-topology.md).

## Local development

Foundation's primitives are AWS-backed in production. For
development, three options:

1. **Real AWS, dev account.** Cheap for low-volume dev work; the
   primitives just work. Set `AWS_PROFILE=dev`, use throwaway
   table / bucket names. The default for most developers.
2. **LocalStack.** Most AWS SDKs target LocalStack endpoints via
   `AWS_ENDPOINT_URL_*`. Foundation modules pick this up via the
   SDK's default endpoint resolution. Audit log query patterns
   should be exercised against real DynamoDB at least once; the
   GSI semantics differ subtly under LocalStack.
3. **DynamoDB Local + MinIO + ElasticMQ.** Lighter than LocalStack
   if all you need is the cloud primitives. Foundation does not
   provide a `docker-compose.yml` — the consumer's stack
   conventions should drive that.

Cognito has **no local emulator**. For vestibulum integration
testing, a dedicated `dev` user pool in a real AWS account is the
only viable option. The magic-link flow can be exercised against a
real SES sandbox; SMS is harder (use SNS sandbox with verified
numbers).

## CI / CD

The consumer's pipeline integrates with saas-foundation packages
through normal npm dependency management. No special build steps
needed. Two points worth flagging:

- **Foundation version pin discipline.** Pre-1.0, each
  `@de-otio/saas-foundation` MINOR bump may be breaking
  ([`05-versioning-and-releases.md`](05-versioning-and-releases.md)).
  The consumer's CI should fail fast on a foundation MINOR bump
  by gating on `npm outdated` or similar.
- **Lambda@Edge bundle integrity.** If the consumer deploys
  vestibulum-cdk, the published artifact includes the
  `lambda-bundles.lock.json` manifest. The CI gate documented in
  [`vestibulum-cdk/10-lambda-bundle-pipeline.md`](vestibulum-cdk/10-lambda-bundle-pipeline.md)
  verifies the bundle hashes match — recommended for any consumer
  with compliance requirements.

## Common gotchas

A digest of the per-package "Caveats" sections, in the order they
typically hit consumers:

- **`SessionCookie` requires an explicit salt.** Not a default.
  See [`foundation/04-session-crypto.md`](foundation/04-session-crypto.md).
- **`TenantId` must be branded — raw strings are rejected.** Use
  the `tenantId(value)` constructor at boundaries.
- **`requestContextMiddleware` must come before `auditMiddleware`.**
  See the wiring order above.
- **`createMultiPoolVerifier` does exact `iss` matching.** No
  trailing-slash tolerance, no substring matching. Unknown issuers
  are rejected.
- **Lambda@Edge has no env vars.** Configuration baked into the
  bundle at deploy time. See
  [`vestibulum-cdk/10-lambda-bundle-pipeline.md`](vestibulum-cdk/10-lambda-bundle-pipeline.md).
- **DynamoDB rate limiter requires conditional writes.** Non-DynamoDB
  KV backends work for dev but are not race-safe in production.
  See [`foundation/08-rate-limit.md`](foundation/08-rate-limit.md).
- **`MagicLinkIdentity` cannot be relocated post-deploy.** The
  Cognito user pool ID changes across regions; rebuild is the only
  migration. See
  [`vestibulum-cdk/09-operational-notes.md`](vestibulum-cdk/09-operational-notes.md).
- **Cognito has no local emulator** — see "Local development"
  above.
- **Frozen-set types require RFC for changes.** See
  [`04-shared-vocabulary.md`](04-shared-vocabulary.md) and
  [`05-versioning-and-releases.md`](05-versioning-and-releases.md).

## Before going live

Two account-level controls that cost nothing at modest scale and
save significant pain later. Set these up before the first production
deployment, not after the first surprise bill.

### AWS Cost Anomaly Detection

Enable at the account level via the AWS Cost Management console or
CLI. Free for the first account-level monitor; charged only if you
add Service-level monitors. For a fresh saas-foundation deployment,
one account-level monitor with a daily `ABSOLUTE` threshold of $10
catches most surprises (a runaway Lambda, an unexpected data-transfer
spike, a forgotten CloudFormation stack).

```bash
aws ce create-anomaly-monitor \
  --anomaly-monitor '{"MonitorName":"AccountMonitor","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}'
aws ce create-anomaly-subscription \
  --anomaly-subscription '{
    "SubscriptionName":"DailyAlert",
    "MonitorArnList":["<monitor-arn-from-above>"],
    "Subscribers":[{"Address":"<your-ops-sns-topic-arn>","Type":"SNS"}],
    "Threshold":10,
    "Frequency":"DAILY"
  }'
```

Wire the subscription to the same SNS topic that your CloudWatch
alarms use. That way cost anomalies and infra alarms land in the same
channel.

### AWS Budgets

Set a monthly budget matched to the expected steady-state cost for
your deployment archetype. Reference the recurring-cost worked example
from the cost-pillar review (S5) once those numbers land; for now, a
starting threshold of 1.5× your estimated monthly bill catches
unexpected growth without paging on normal variation.

```bash
aws budgets create-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget '{
    "BudgetName": "saas-foundation-monthly",
    "BudgetLimit": { "Amount": "50", "Unit": "USD" },
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{
      "SubscriptionType": "SNS",
      "Address": "<your-ops-sns-topic-arn>"
    }]
  }]'
```

Wire the subscriber to the same SNS topic as Cost Anomaly Detection
and CloudWatch alarms. One ops topic, three signal sources.

> **Note:** AWS Budgets charges $0.02/day per budget above the first
> two free budgets. A single monthly budget is free.

## Watch out: RETAIN policy and ephemeral stacks

Stateful resources created by saas-foundation constructs default to
`RemovalPolicy.RETAIN`: DDB tables (`SingleTable`, `MagicLinkIdentity`
code-challenge table), the Cognito user pool, the SES identity, and
SQS queues. This is correct for production data safety and has been
validated by the prior design reviews.

For **ephemeral CI / preview / PR-stack** environments, `RETAIN`
creates orphan-cost: a teardown (`cdk destroy`) that does not actually
tear down the stateful resources. After a few months of preview stacks
landing, the account accumulates orphaned DDB tables and Cognito pools
that quietly accrue storage and per-MAU charges.

If your deployment workflow includes ephemeral stacks (PR previews,
per-branch environments, CI smoke-test stacks):

1. **Override `removalPolicy: RemovalPolicy.DESTROY`** on every
   stateful construct in the preview stack. Do this unconditionally
   — never derive it from a runtime flag that might be wrong.

   ```typescript
   // In your preview/PR stack only — never in the production stack.
   const identity = new MagicLinkIdentity(this, 'Identity', {
     // ...
     removalPolicy: RemovalPolicy.DESTROY,
   });
   ```

2. **Run an orphan-cleanup sweep quarterly.** Even with `DESTROY`
   overrides, leftover stacks from interrupted or failed destroys
   accumulate. Query for DDB tables and Cognito pools whose names
   carry your preview-stack prefix and were last modified more than
   30 days ago; delete manually if the originating stack is gone.

3. **A future `removalPolicyMode: 'production' | 'ephemeral'`** switch
   on the `*Cdk` constructs would formalise this pattern — ephemeral
   mode would automatically apply `DESTROY` to all stateful resources.
   That switch is not on the current roadmap; use the manual override
   above until it lands.

## Status

This doc is the consumer cookbook. It cross-references the
per-package designs heavily and is the right place for any future
"how do I do X" addition that spans more than one package.
Single-package questions stay in the per-package doc.
