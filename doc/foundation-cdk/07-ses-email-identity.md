# 07 — SesEmailIdentity

The `SesEmailIdentity` construct. An opinionated SES sending setup for a
domain identity: verified domain with Easy DKIM, custom MAIL FROM subdomain
with SPF alignment, a TLS-required configuration set, DMARC record, and an
SNS topic for bounce/complaint feedback.

## Why a house wrapper instead of raw `ses.EmailIdentity`

CDK's `ses.EmailIdentity` (the L2 construct) bundles the verified domain and
Easy DKIM, but leaves reputation tracking and deliverability best practices
to the consumer:

- No configuration set (no reputation metrics, no event feedback).
- No custom MAIL FROM domain (SPF alignment defaults to amazonses.com).
- No DMARC record (receiver-supplied policy is unclear).
- No SNS topic for bounce/complaint processing (feedback is silently dropped
  unless the consumer manually wires event destinations).
- No least-privilege `grantSend()` helper — the consumer writes their own IAM
  policy.

These pieces are not optional for reputable transactional sending — every major
sender uses them. A house wrapper bundles them into one shape and provides two
DNS modes: automatic (Route53) or manual (CfnOutputs for hand-entry into
whatever DNS provider is in use).

## Props

```typescript
import * as route53 from "aws-cdk-lib/aws-route53";

export interface SesDmarcOptions {
  /**
   * The DMARC failure policy (`p=` tag). Default: `"none"` (monitor only).
   *
   * Progression: start at `none` to collect feedback without rejecting mail,
   * move to `quarantine` to filter suspected spoofed mail into spam, finally
   * to `reject` to hard-fail any non-DMARC-passing mail.
   */
  readonly policy?: "none" | "quarantine" | "reject";

  /**
   * Aggregate-report destination. When provided, a `rua=mailto:<rua>` tag is
   * appended so receivers send aggregate reports there (e.g., daily summaries
   * of SPF/DKIM/DMARC pass/fail counts from each sender).
   *
   * @default - no rua tag (no aggregate reports requested)
   */
  readonly rua?: string;
}

export interface SesEmailIdentityProps {
  /**
   * The domain to verify for sending, e.g. `mail.example.com` or
   * `noreply.example.org`.
   */
  readonly domainName: string;

  /**
   * The Route53 hosted zone for `domainName`. When provided, ALL required DNS
   * records are created automatically (Easy DKIM CNAMEs, the custom MAIL FROM
   * MX + SPF records, and the DMARC TXT record). When omitted, the construct
   * emits the equivalent record values as `CfnOutput`s for manual entry into
   * whatever DNS provider hosts the zone.
   *
   * @default - no records created; DNS values emitted as CfnOutputs
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Label for the custom MAIL FROM subdomain. The MAIL FROM domain resolves
   * to `${mailFromSubdomain}.${domainName}`. A custom MAIL FROM domain aligns
   * SPF records with your domain (rather than amazonses.com) and improves
   * deliverability — most receivers trust mail from your domain more than
   * mail from AWS's shared bounce domain.
   *
   * @default "mail"
   */
  readonly mailFromSubdomain?: string;

  /**
   * DMARC record configuration. A DMARC record is published at
   * `_dmarc.${domainName}` and instructs receivers how to treat mail that
   * fails DMARC alignment.
   *
   * @default - policy "none" (monitor only), no rua
   */
  readonly dmarc?: SesDmarcOptions;

  /**
   * Physical name for the SES configuration set. When unset, CDK generates
   * a name for you.
   *
   * @default - CloudFormation-generated name
   */
  readonly configurationSetName?: string;

  /**
   * Publish reputation metrics (bounce/complaint rates) for the configuration
   * set to CloudWatch. Strongly recommended — SES monitors reputation scores
   * and can temporarily pause sending on a single domain if the bounce or
   * complaint rate is high. CloudWatch metrics let you see the scores in
   * real time and alert on degradation before SES pauses you.
   *
   * @default true
   */
  readonly enableReputationMetrics?: boolean;
}
```

## Class shape

```typescript
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";

export class SesEmailIdentity extends Construct {
  /** The verified SES domain identity (Easy DKIM enabled). */
  public readonly identity: ses.EmailIdentity;

  /** The configuration set attached to the identity (TLS required). */
  public readonly configurationSet: ses.ConfigurationSet;

  /** SNS topic receiving BOUNCE and COMPLAINT events. */
  public readonly bounceComplaintTopic: sns.Topic;

  /** The verified domain, e.g. `mail.example.com`. */
  public readonly domainName: string;

  /** The resolved custom MAIL FROM domain, e.g. `mail.mail.example.com`. */
  public readonly mailFromDomain: string;

  constructor(scope: Construct, id: string, props: SesEmailIdentityProps) {
    // ... wires all components
  }

  /**
   * Grants a principal permission to send email through this identity.
   *
   * Grants `ses:SendEmail` and `ses:SendRawEmail` scoped to this identity's
   * ARN (never a wildcard resource). When `fromAddresses` is supplied, a
   * `ses:FromAddress` condition further restricts which From addresses the
   * principal may use.
   */
  public grantSend(
    grantee: iam.IGrantable,
    fromAddresses?: string[],
  ): iam.Grant;
}
```

## What it creates

### EmailIdentity

A verified SES domain identity (`ses.EmailIdentity`) with Easy DKIM enabled.
Easy DKIM uses three CNAME records to prove domain ownership and enable DKIM
signing.

When a `hostedZone` is supplied, the underlying L2 construct creates the three
DKIM CNAMEs in Route53 automatically. When `hostedZone` is not supplied, the
DKIM DNS token names and values are emitted as CfnOutputs.

### ConfigurationSet

A SES configuration set with two key properties:

- **TLS Required** (`tlsPolicy: REQUIRE`): SES only delivers email messages
  through this configuration set if the SMTP connection is encrypted. This
  blocks downgrade attacks and improves reputation with receivers who monitor
  TLS adoption rates.

- **Reputation Metrics** (default enabled): SES publishes bounce/complaint
  rates and reputation score to CloudWatch under the `AWS/SES` namespace. See
  § Reputation tracking and CloudWatch alerts for the metric names and
  thresholds.

### Custom MAIL FROM Domain

When a `hostedZone` is supplied, the L2 creates:

- An **MX record** at `${mailFromSubdomain}.${domainName}` pointing to the SES
  bounce endpoint for the region.
- An **SPF record** (TXT) at the same domain authorizing SES to send mail on
  your behalf.

This is called a "custom MAIL FROM domain" — it replaces the default
`bounce.amazonses.com` as the envelope sender (MAIL FROM / Return-Path). Most
receivers trust mail from your domain more than mail from AWS's shared bounce
domain, improving deliverability. When `hostedZone` is not supplied, these
record values are emitted as CfnOutputs.

### Bounce/Complaint Topic

An SNS topic that receives SES `BOUNCE` and `COMPLAINT` events via the
configuration set's event destinations. Bounce events fire when a recipient's
mailbox does not exist or is full; complaint events fire when a recipient
marks your mail as spam. Subscribe a Lambda or email address to this topic to:

- Suppress future sends to permanently-bounced addresses.
- Investigate complaint sources and refine targeting.
- Alert on high bounce/complaint rates (a sign of list quality issues).

The topic is always created; its name is CDK-auto-generated. The consumer
can subscribe later by calling `topic.addSubscription(...)`.

### DMARC Record

A DMARC (Domain-based Message Authentication, Reporting, and Conformance) TXT
record published at `_dmarc.${domainName}`. DMARC tells receivers how to treat
mail that fails SPF or DKIM checks.

The record value is built from the `dmarc` prop:

```
v=DMARC1; p=<policy>; [rua=mailto:<rua>]
```

When `hostedZone` is supplied, the construct creates the record in Route53.
When `hostedZone` is not supplied, the record value is emitted as a CfnOutput.

## Two DNS modes: automatic vs. manual

### Automatic (Route53)

When a `hostedZone` is passed:

```typescript
const zone = route53.HostedZone.fromLookup(this, "Zone", {
  domainName: "example.com",
});

const identity = new SesEmailIdentity(this, "EmailIdentity", {
  domainName: "mail.example.com",
  hostedZone: zone,
  dmarc: { policy: "quarantine", rua: "dmarc@example.com" },
});
```

All DNS records are created immediately:

- 3 × Easy DKIM CNAMEs (via `ses.EmailIdentity`)
- Custom MAIL FROM MX record (via `ses.EmailIdentity`)
- Custom MAIL FROM SPF record (via `ses.EmailIdentity`)
- DMARC record (via the construct)

The SES sending setup is complete after CDK deploy finishes.

### Manual (CfnOutputs)

When `hostedZone` is omitted:

```typescript
const identity = new SesEmailIdentity(this, "EmailIdentity", {
  domainName: "mail.example.com",
  dmarc: { policy: "none" },
});
```

No Route53 records are created. Instead, the construct emits four CfnOutputs:

1. **DkimRecord1, DkimRecord2, DkimRecord3** — the CNAME records for Easy DKIM.
2. **MailFromMxRecord** — the MX record for custom MAIL FROM.
3. **MailFromSpfRecord** — the SPF (TXT) record for custom MAIL FROM.
4. **DmarcRecordOutput** — the DMARC (TXT) record.

After deploy, the operator views the stack outputs and manually creates the
records in their DNS provider. SES cannot send through the domain until all
records are present and propagated.

**Note**: DKIM requires only the three CNAME records. MX + SPF are required for
custom MAIL FROM alignment. DMARC is not required for sending but strongly
recommended for reputation. It is safe to deploy the identity first and add
DMARC later (the identity can send immediately; DMARC just adds a receiver-side
policy layer).

## Reputation tracking and CloudWatch alerts

When `enableReputationMetrics` is true (the default), the configuration set
publishes two metrics to CloudWatch under the `AWS/SES` namespace:

| Metric | Dimensions | Interpretation |
|--------|-----------|-----------------|
| `Reputation.BounceRate` | `Domain=<domainName>`, `ConfigurationSet=<name>` | Percentage of messages bounced. SES may pause sending if this exceeds 5% (the hard threshold is per account, not per domain, but a single hot domain can affect the whole account). |
| `Reputation.ComplaintRate` | `Domain=<domainName>`, `ConfigurationSet=<name>` | Percentage of messages reported as spam by recipients. SES may pause sending if this exceeds 0.1%. |

Both metrics are point-in-time (refreshed daily by SES, not real-time). Wire
CloudWatch alarms on these to catch reputational drift before SES pauses you:

```typescript
new cloudwatch.Alarm(this, "BounceAlarm", {
  metric: identity.configurationSet.metricBounceRate({
    dimensions: { Domain: identity.domainName },
  }),
  threshold: 3, // 3% bounce rate (safety margin below SES's 5% threshold)
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  alarmDescription: "Bounce rate trending high; check list quality",
});
```

## GrantSend and least-privilege permissions

The construct provides a `grantSend()` helper to grant a principal (Lambda,
container role, service role) least-privilege permission to send through this
identity:

```typescript
const myLambda = new NodejsLambda(this, "Mailer", {
  entry: "src/mailer.ts",
  functionName: "mailer-fn",
});

// Grant permission to send through the identity
identity.grantSend(myLambda, ["noreply@mail.example.com"]);
```

The grant adds an IAM policy allowing:

- **Actions**: `ses:SendEmail` and `ses:SendRawEmail`.
- **Resource**: This identity's ARN (scoped, never a wildcard).
- **Conditions** (optional): If `fromAddresses` are supplied, a
  `ses:FromAddress` condition restricts which email addresses the principal
  may use:

```json
{
  "Effect": "Allow",
  "Action": ["ses:SendEmail", "ses:SendRawEmail"],
  "Resource": "arn:aws:ses:region:account:identity/mail.example.com",
  "Condition": {
    "StringEquals": {
      "ses:FromAddress": ["noreply@mail.example.com"]
    }
  }
}
```

If `fromAddresses` is omitted, the condition is not added (the principal can
send from any address in the identity). If any address in `fromAddresses`
contains a `*` wildcard, the condition uses `StringLike` instead of
`StringEquals`:

```typescript
// Allows noreply@mail.example.com and any address matching alerts+*.example.com
identity.grantSend(myLambda, [
  "noreply@mail.example.com",
  "alerts+*@mail.example.com",
]);
```

This produces a `StringLike` condition because of the `*` in the second address.

## DMARC policy progression

DMARC policies have three levels; the recommended progression is:

### Phase 1: `none` (Monitor-only)

```typescript
dmarc: { policy: "none", rua: "dmarc-reports@example.com" }
```

Receivers monitor and report DMARC results but do not reject mail. Use this
phase to:

- Verify that your SPF and DKIM alignment is correct (check aggregate reports).
- Identify third-party senders that need to be brought into alignment.
- Establish a baseline bounce/complaint rate with the policy disabled.

Typically lasts 1–4 weeks. Move to `quarantine` when the reports show alignment
is solid and there are no surprises (like a critical service suddenly failing
DKIM).

### Phase 2: `quarantine` (Soft fail)

```typescript
dmarc: { policy: "quarantine", rua: "dmarc-reports@example.com" }
```

Receivers move mail that fails DMARC alignment into the spam folder (still
delivered, but filtered). Use this to:

- Test real-world impact. Some legitimate services may fail alignment and get
  spamfoldered; adjust your SPF/DKIM configuration accordingly.
- Protect inboxes from common spoofing campaigns while retaining a fallback
  (spam folder).

Typically lasts 1–8 weeks. Move to `reject` once you are confident no critical
senders are misaligned and your reputation is stable.

### Phase 3: `reject` (Hard fail)

```typescript
dmarc: { policy: "reject", rua: "dmarc-reports@example.com" }
```

Receivers reject mail that fails DMARC alignment (not delivered at all).
Strongest protection against spoofing; any misaligned sender — your app, a
third-party integration, or an attacker — bounces.

Use only when:

- Your SPF and DKIM alignment is rock-solid.
- You have monitoring in place to catch misaligned senders quickly.
- All critical integrations (scheduled reports, alerts, notifications) are
  verified to pass alignment.

Stay at `reject` long-term for production sending domains.

### Aggregate reports

The `rua` (Reporting URI for Aggregate reports) is optional but strongly
recommended. It sends aggregate feedback — daily or weekly — from receivers
showing pass/fail counts. Use the reports to:

- Detect sudden alignment breakage.
- Spot a third-party service that is impersonating your domain.
- Track adoption of your domain across different receivers.

Aggregate reports are lightweight and rarely noisy; set `rua` from the start.

## Removal posture

`SesEmailIdentity` does not set a `removalPolicy` — SES domain identities are
control-plane configuration without operational data. The default
`DESTROY` is correct. DNS records created by the construct or the L2
(Route53 records) are also destroyed when the stack is deleted.

**Important**: Deleting the stack deletes the SES domain identity. SES ceases
to recognize the domain as verified, so sending through it fails. If you are
migrating the identity to a different stack or account, remove the identity
from the stack definition _before_ deleting the stack (so it is not destroyed),
or export the domain to a separate identity-only stack that can be retained.

## Recurring cost

Per the [paid-by-default cost-disclosure
principle](../01-scope-and-philosophy.md#design-principles), the
default-on paid resources created by this construct:

| Resource                 | Count per construct | Cost shape | Opt-out |
|--------------------------|---------------------|-----------|---------|
| SES domain identity      | 1                   | $0.15/month (`us-east-1`; same in most regions). Charged only when the domain is verified. | n/a — the identity exists as soon as the construct is instantiated |
| SES email sending        | variable            | First 62,000 emails/month free (across the account, all identities). $0.10 per 1,000 emails beyond the free tier. | n/a |
| SES reputation tracking  | 1 per configuration set | Included with the configuration set; no separate charge. Metrics are free CloudWatch metrics (`AWS/SES` namespace). | Set `enableReputationMetrics: false` to omit |
| SNS topic (bounce/complaint) | 1              | $0.50 per million requests (first 1,000 requests free, so negligible until volume is high). | Topic is always created; the consumer can keep it empty (subscribe nothing) if feedback is not needed |
| Route53 records (optional) | 0–7 (depends on hostedZone prop) | $0.40 per hosted zone/month + $0.40 per million queries. If the hostedZone is passed, this construct creates 1 record (DMARC); the L2 creates 2 records (DKIM + MAIL FROM). Total ≈ **$0.40/month for a active zone + query costs**. | n/a — records are free if you use a pre-existing hosted zone; not created if `hostedZone` is omitted |

### Worked example

A single identity with a hostedZone, default reputation metrics, and aggregate
DMARC reports (moderate email volume, ~5k/month):

- **Identity**: $0.15/month
- **Sending**: free (within 62k/month free tier)
- **Reputation tracking**: free (CloudWatch metrics)
- **Bounce/complaint topic**: free (under 1,000 SNS requests)
- **DMARC reports**: free (aggregate reports are SNS deliveries)
- **Route53**: ~$0.40/month (already paying for the zone if it's shared)

**Total**: ~$0.55/month (identity cost + DNS zone share).

For high-volume sending (~1M emails/month):

- **Identity**: $0.15/month
- **Sending**: $90/month (0.94M beyond free tier × $0.10/1k)
- **Reputation tracking**: free
- **Bounce/complaint topic**: ~$0.50/month (SNS requests proportional to bounce/complaint rate; assuming 1% = 10k events)
- **Route53**: ~$0.40/month

**Total**: ~$91/month (dominated by sending cost).

## Synth-time validations

No construct-level synth-time validation is performed. The underlying L2
`ses.EmailIdentity` validates that the domain name and DKIM signing are valid
per AWS limits. Custom validations to consider:

- **DMARC policy progression**: A future helper (not v0.1) could warn if a
  domain is moved from `none` directly to `reject` without an intermediate
  `quarantine` phase. Not implemented; the construct trusts the operator's
  judgment.

## Open questions

- **Should there be a `reportingAddress` prop to auto-subscribe to the
  bounce/complaint topic?** Currently the consumer must call
  `topic.addSubscription()` by hand. A prop could streamline this; defer until
  a consumer needs it.
- **Should the construct validate that `domainName` matches the `hostedZone`?**
  A domain-zone mismatch is an easy mistake (e.g., passing the root zone when
  the domain is a subdomain); a synth-time check could catch it. Deferred;
  AWS returns a clear error at deploy if the domain is not in the zone.
- **DMARC alignment (SPF/DKIM) validation?** The construct could query DNS to
  verify that DKIM records exist and SPF is correct before sending is
  attempted. Too heavy for synth time; belongs in a separate operational script
  if needed.
