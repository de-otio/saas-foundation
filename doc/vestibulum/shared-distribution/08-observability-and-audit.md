# 08 — Observability and audit

Cross-cutting doc covering audit logging, CloudWatch metrics, alarms,
edge log groups, and recommended ops integrations. Carved out of
[`03-tenant-onboarding.md`](03-tenant-onboarding.md),
[`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md), and
[`07-security-and-isolation.md`](07-security-and-isolation.md) where
those topics were scattered across narrower contexts.

## Audit logging

Every mutating admin-Lambda action emits a structured CloudWatch
Logs entry. Format:

```json
{
  "@timestamp": "2026-05-25T14:23:11.123Z",
  "level": "INFO",
  "event": "admin.tenant.update",
  "action": "updateTenant",
  "tenantId": "acme",
  "subdomain": "acme",
  "callerArn": "arn:aws:iam::123456789012:role/AdminDeployRole",
  "callerSessionContext": { "...": "from requestContext.authorizer.iam" },
  "before": { "allowedEmailDomains": ["acme.example"] },
  "after":  { "allowedEmailDomains": ["acme.example", "attacker.example"] },
  "requestId": "01J1FZ7H8K9MX5N7QABCDEF123"
}
```

The caller IAM identity is taken from
`event.requestContext.authorizer.iam` (populated by Function URL's
AWS_IAM auth — includes ARN, account ID, user ID, and session
context).

Emitted on: `createTenant`, `updateTenant`, `deleteTenant`. NOT on
read-only ops (`getTenant`, `listTenants`) — those are still logged
at INFO level but without the `event: "admin.tenant.*"` discriminator.

## CloudWatch metrics

| Metric                                                          | Emitted by                                          | Cardinality        | Purpose                                          |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------ | ------------------------------------------------ |
| `Vestibulum/SharedDistribution/TenantCreated`                   | admin Lambda                                        | per `tenantId`     | Onboarding rate, billing input                   |
| `Vestibulum/SharedDistribution/TenantUpdated`                   | admin Lambda                                        | per `tenantId`     | Config-drift surface                             |
| `Vestibulum/SharedDistribution/TenantDeleted`                   | admin Lambda                                        | per `tenantId`     | Deletion rate, anomaly source                    |
| `Vestibulum/SharedDistribution/AllowlistChanged`                | admin Lambda                                        | per `tenantId`     | High-blast-radius op, real-time alarm            |
| `Vestibulum/SharedDistribution/CompensationTriggered`           | admin Lambda's `createTenant` rollback path         | per `subdomain`    | Real-time failure signal                         |
| `Vestibulum/SharedDistribution/OrphanedAppClients`              | reconciler Lambda                                   | scalar             | Hourly orphan detection                          |
| `Vestibulum/SharedDistribution/OrphanedConfigRows`              | reconciler Lambda                                   | scalar             | Hourly orphan detection (reverse)                |
| `Vestibulum/SharedDistribution/PreSignUpRejected`               | PreSignUp Lambda                                    | per `subdomain`    | Allowlist denials per tenant                     |
| `Vestibulum/SharedDistribution/CreateAuthChallengeFailed`       | CreateAuthChallenge Lambda                          | per `subdomain`    | Fail-closed DDB errors per tenant                |
| `Vestibulum/SharedDistribution/PreTokenGenerationFailed`        | PreTokenGen Lambda                                  | per `subdomain`    | Token-mint failures per tenant                   |
| `Vestibulum/SharedDistribution/EdgeCheckRefused`                | Lambda@Edge                                         | per `refuseReason` | Cross-tenant rejection rate; trip-wire for B1/H1 |
| `Vestibulum/SharedDistribution/JWKSFetchErrors`                 | Lambda@Edge                                         | scalar             | JWKS endpoint health; alarms on bursts           |
| `Vestibulum/SharedDistribution/BounceQuarantine`                | bounce handler                                      | per `tenantId`     | Bounce rate per tenant, DoS detection            |

Cardinality note: metrics dimensioned on `tenantId` /`subdomain`
multiply CloudWatch cost. Default emission strategy: scalar metrics
without dimensions; structured-log entries carry tenant context for
log-based detail queries. Consumers needing per-tenant dashboards
opt in via `SharedDistributionIdentityProps.perTenantMetrics: boolean`
(default `false`).

## CloudWatch alarms (built-in)

| Alarm                                          | Metric                         | Threshold / sustain                    | Severity |
| ---------------------------------------------- | ------------------------------ | -------------------------------------- | -------- |
| `AllowlistChanged-RealTime`                    | `AllowlistChanged`             | `> 0`, zero-delay                      | HIGH     |
| `TenantDeleted-RealTime`                       | `TenantDeleted`                | `> 0`, zero-delay                      | HIGH     |
| `CompensationTriggered`                        | `CompensationTriggered`        | `> 0`, zero-delay                      | HIGH     |
| `OrphanedAppClients-Sustained`                 | `OrphanedAppClients`           | `> 0`, sustained 1 hour                | MEDIUM   |
| `OrphanedConfigRows-Sustained`                 | `OrphanedConfigRows`           | `> 0`, sustained 1 hour                | MEDIUM   |
| `JWKSFetchErrors-Burst`                        | `JWKSFetchErrors`              | `> 5 / 5 min`                          | HIGH     |
| `EdgeCheckRefused-Spike`                       | `EdgeCheckRefused`             | `> baseline × 10`, sustained 15 min    | MEDIUM   |
| `PreSignUpRejected-Spike`                      | `PreSignUpRejected`            | `> baseline × 10`, sustained 15 min    | LOW      |

Alarm action: consumer-provided SNS topic (construct prop
`alarmTopic?: sns.ITopic`). If unset, alarms exist but are
unsubscribed — operator-visible by console polling. Consumers in
production environments **must** set `alarmTopic`.

## Edge logging

Lambda@Edge logs land in 5–10 regional CloudWatch log groups per
identity (one per active CloudFront PoP region). The construct
exposes them as
`SharedDistributionIdentity.edgeLogGroups: logs.ILogGroup[]` for the
consumer to wire into their observability stack:

```typescript
// Consumer pattern: subscribe all edge log groups to one Firehose
// stream → central log destination.
import { SubscriptionFilter, FilterPattern } from 'aws-cdk-lib/aws-logs';
import { KinesisDestination } from 'aws-cdk-lib/aws-logs-destinations';

for (const lg of identity.edgeLogGroups) {
  new SubscriptionFilter(this, `${lg.logGroupName}-Subscription`, {
    logGroup: lg,
    destination: new KinesisDestination(centralLogStream),
    filterPattern: FilterPattern.allEvents(),
  });
}
```

Aggregation is **not** baked into the construct. Consumers' existing
observability stacks vary (Kinesis → OpenSearch, CloudWatch Insights
cross-region queries, third-party SIEM); the construct exposes the
log groups and stops there.

Important caveat: Lambda@Edge log entries appear in the **PoP's
region**, not the home region. A user request from Frankfurt hits
the Frankfurt PoP; logs land in `eu-central-1`. A request from
Sydney hits the Sydney PoP; logs land in `ap-southeast-2`. The
construct discovers all active regions at synth-time via the
CloudFront distribution's regional endpoints, but PoPs come and go;
log groups are created on first invocation. The
`edgeLogGroups` field reflects the currently-known set, may need a
post-deploy refresh.

## Recommended ops integrations

### IAM Access Analyzer

[AWS docs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
recommend IAM Access Analyzer for monitoring Function URL access
patterns. Free service; detects external access and permission
drift on the admin Lambda's resource-based policy.

Enable at the account level:

```bash
aws accessanalyzer create-analyzer --analyzer-name shared-distribution-policy-analyzer --type ACCOUNT
```

The analyzer flags any new external principal granted access to the
admin Function URL or its underlying Lambda. Integrate findings into
the consumer's security review workflow (Security Hub, ticketing
system).

### CloudTrail

Already-enabled at the AWS-account level for most consumers. The
admin Lambda's actions on Cognito (`CreateUserPoolClient`,
`DeleteUserPoolClient`) and DynamoDB (`TransactWriteItems`,
`UpdateItem`, `DeleteItem`) are logged by CloudTrail with the
admin Lambda's execution role as the principal. Cross-reference
against the application-level audit log emitted by the admin Lambda
itself; mismatches indicate either:

- Direct console / CLI access bypassing the admin Lambda (operational
  red flag).
- Audit-log emission failure (correctness bug; alarm on missing
  audit entries).

### Application-log + CloudTrail join

For every `AllowlistChanged` alarm fire:

1. Pull the audit-log entry by `requestId`.
2. Pull the corresponding CloudTrail `UpdateItem` event on
   `ClientConfig`.
3. Compare callers, timestamps, and request bodies.

A discrepancy (CloudTrail says one thing, app log says another)
indicates either log tampering or the admin Lambda being bypassed.
Both are HIGH severity.

## Dashboards (recommended template)

The construct does **not** ship a CloudWatch dashboard; instead it
provides a CloudFormation Output naming all the metrics so consumers
can build one. A minimum-viable dashboard includes:

1. **Top-line panel:** `TenantCreated` + `TenantDeleted` rates by
   hour (24-hour window).
2. **Real-time alarms:** count of `AllowlistChanged`,
   `CompensationTriggered`, `TenantDeleted` in last 15 min (zero-
   threshold).
3. **Orphan tracker:** current `OrphanedAppClients` +
   `OrphanedConfigRows` values.
4. **Edge health:** `JWKSFetchErrors` rate + `EdgeCheckRefused`
   refused-by-reason breakdown (where the reason discriminator
   includes `tenant-mismatch`, `no-tenant-claim`, `wrong-iss`,
   `wrong-token-use`, `expired`, `bad-signature`).
5. **Cognito-side health:** `PreSignUpRejected` and
   `CreateAuthChallengeFailed` rates per tenant (if
   `perTenantMetrics` enabled).

## Open question (intentional defer to v0.3)

**Per-tenant log isolation.** Today, all tenant log entries land in
the same set of CloudWatch log groups, distinguishable only by
structured field. Consumers requiring strict per-tenant log
boundaries (e.g. GDPR right-to-erasure on a per-tenant basis) need
a downstream log routing pipeline — outside the construct's scope.
The hard-isolation variant (separate `SharedDistributionIdentity`)
gives per-identity log separation for tenants with that contract.
