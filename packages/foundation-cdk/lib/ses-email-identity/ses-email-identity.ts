import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "../aspects/metadata-tags.js";

/**
 * DMARC policy options.
 *
 * `p=` in the DMARC record instructs receivers how to treat mail that fails
 * DMARC alignment (SPF/DKIM). Start at `none` (monitor only) and tighten to
 * `quarantine` / `reject` once you have confidence in your authenticated
 * sending.
 */
export interface SesDmarcOptions {
  /**
   * The DMARC failure policy (`p=` tag). Default: `"none"` (monitor only).
   */
  readonly policy?: "none" | "quarantine" | "reject";

  /**
   * Aggregate-report destination. When provided, a `rua=mailto:<rua>` tag is
   * appended so receivers send aggregate reports there.
   *
   * @default - no rua tag (no aggregate reports requested)
   */
  readonly rua?: string;
}

export interface SesEmailIdentityProps {
  /**
   * The domain to verify for sending, e.g. `mail.example.com`.
   */
  readonly domainName: string;

  /**
   * The Route53 hosted zone for `domainName`. When provided, ALL required DNS
   * records are created automatically (Easy DKIM CNAMEs, the custom MAIL FROM
   * MX + SPF records, and the DMARC TXT record). When omitted, the equivalent
   * records are emitted as `CfnOutput`s for manual entry into whatever DNS
   * provider hosts the zone.
   *
   * @default - no records created; DNS values emitted as CfnOutputs
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Label for the custom MAIL FROM subdomain. The MAIL FROM domain resolves to
   * `${mailFromSubdomain}.${domainName}`. A custom MAIL FROM domain aligns SPF
   * with your domain (rather than amazonses.com) and improves deliverability.
   *
   * @default "mail"
   */
  readonly mailFromSubdomain?: string;

  /**
   * DMARC record configuration. A DMARC record is published at
   * `_dmarc.${domainName}`.
   *
   * @default - policy "none" (monitor only), no rua
   */
  readonly dmarc?: SesDmarcOptions;

  /**
   * Physical name for the SES configuration set.
   *
   * @default - a CloudFormation-generated name
   */
  readonly configurationSetName?: string;

  /**
   * Publish reputation metrics (bounce/complaint rates) for the configuration
   * set to CloudWatch. Strongly recommended — SES can pause sending on a
   * reputation account, and you want the metrics to see it coming.
   *
   * @default true
   */
  readonly enableReputationMetrics?: boolean;
}

const DEFAULT_MAIL_FROM_SUBDOMAIN = "mail";

/**
 * Builds the DMARC record value string, e.g.
 * `v=DMARC1; p=none;` or `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com`.
 */
function buildDmarcValue(dmarc: SesDmarcOptions | undefined): string {
  const policy = dmarc?.policy ?? "none";
  let value = `v=DMARC1; p=${policy};`;
  if (dmarc?.rua !== undefined && dmarc.rua.length > 0) {
    value += ` rua=mailto:${dmarc.rua}`;
  }
  return value;
}

/**
 * An opinionated SES sending setup for a domain identity.
 *
 * Bundles the best-practice pieces you want for reputable transactional
 * sending into one construct:
 *
 *  - A verified domain **EmailIdentity** with **Easy DKIM** enabled.
 *  - A **custom MAIL FROM** subdomain so SPF aligns with your domain.
 *  - A **ConfigurationSet** that requires TLS in transit and (by default)
 *    publishes reputation metrics to CloudWatch.
 *  - An **SNS topic** wired as an event destination for `BOUNCE` and
 *    `COMPLAINT` events, so you can process feedback programmatically.
 *  - A **DMARC** TXT record.
 *  - A least-privilege {@link grantSend} helper scoped to this identity's ARN.
 *
 * When a `hostedZone` is supplied every required DNS record is created in
 * Route53. When it is not, the record values are emitted as CfnOutputs for
 * manual entry.
 *
 * Note on MAIL FROM / DKIM records: the underlying `ses.EmailIdentity` L2
 * already creates the Easy DKIM CNAMEs and the MAIL FROM MX + SPF records when
 * the identity is built from a public hosted zone
 * (`ses.Identity.publicHostedZone`). This construct therefore does not
 * duplicate those records — it only adds the DMARC record the L2 omits — to
 * avoid conflicting Route53 record sets.
 */
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
    super(scope, id);

    // Mark this construct so house aspects can identify it.
    this.node.addMetadata(HOUSE_CONSTRUCT_METADATA_KEY, "SesEmailIdentity");

    this.domainName = props.domainName;
    const mailFromSubdomain = props.mailFromSubdomain ?? DEFAULT_MAIL_FROM_SUBDOMAIN;
    this.mailFromDomain = `${mailFromSubdomain}.${props.domainName}`;

    // --- Configuration set (create first so it can be attached to the identity) ---
    // TLS REQUIRE => messages are only delivered over an encrypted connection.
    this.configurationSet = new ses.ConfigurationSet(this, "ConfigSet", {
      ...(props.configurationSetName !== undefined
        ? { configurationSetName: props.configurationSetName }
        : {}),
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      reputationMetrics: props.enableReputationMetrics ?? true,
    });

    // --- Domain identity + Easy DKIM ---
    // With a hosted zone we use publicHostedZone(), which makes the L2 create
    // the DKIM CNAMEs and (because mailFromDomain is set) the MAIL FROM MX+SPF
    // records automatically. Without one we use domain() and emit outputs.
    const identitySource = props.hostedZone
      ? ses.Identity.publicHostedZone(props.hostedZone)
      : ses.Identity.domain(props.domainName);

    this.identity = new ses.EmailIdentity(this, "Identity", {
      identity: identitySource,
      configurationSet: this.configurationSet,
      dkimSigning: true,
      mailFromDomain: this.mailFromDomain,
    });

    // --- Bounce/complaint handling ---
    this.bounceComplaintTopic = new sns.Topic(this, "BounceComplaintTopic");
    this.configurationSet.addEventDestination("BounceComplaint", {
      destination: ses.EventDestination.snsTopic(this.bounceComplaintTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT],
    });

    // --- DMARC + (when no hosted zone) manual DNS outputs ---
    const dmarcValue = buildDmarcValue(props.dmarc);

    if (props.hostedZone) {
      // The L2 already created the DKIM CNAMEs and MAIL FROM MX/SPF records.
      // Only the DMARC record remains for us to add.
      new route53.TxtRecord(this, "DmarcRecord", {
        zone: props.hostedZone,
        recordName: `_dmarc.${props.domainName}`,
        values: [dmarcValue],
      });
    } else {
      // No hosted zone: emit every required record as a CfnOutput so an
      // operator can create them by hand in their DNS provider.
      for (let i = 1; i <= 3; i++) {
        const name = this.identity[`dkimDnsTokenName${i}` as keyof ses.EmailIdentity] as string;
        const value = this.identity[`dkimDnsTokenValue${i}` as keyof ses.EmailIdentity] as string;
        new cdk.CfnOutput(this, `DkimRecord${i}`, {
          description: `SES Easy DKIM CNAME #${i} — create in DNS: name -> value`,
          value: `${name} CNAME ${value}`,
        });
      }

      new cdk.CfnOutput(this, "MailFromMxRecord", {
        description: "Custom MAIL FROM MX record to create in DNS",
        value: `${this.mailFromDomain} MX 10 feedback-smtp.${cdk.Stack.of(this).region}.amazonses.com`,
      });

      new cdk.CfnOutput(this, "MailFromSpfRecord", {
        description: "Custom MAIL FROM SPF (TXT) record to create in DNS",
        value: `${this.mailFromDomain} TXT "v=spf1 include:amazonses.com ~all"`,
      });

      new cdk.CfnOutput(this, "DmarcRecordOutput", {
        description: "DMARC (TXT) record to create in DNS",
        value: `_dmarc.${props.domainName} TXT "${dmarcValue}"`,
      });
    }
  }

  /**
   * Grants a principal permission to send email through this identity.
   *
   * Grants `ses:SendEmail` and `ses:SendRawEmail` scoped to this identity's
   * ARN (never a wildcard resource). When `fromAddresses` is supplied, a
   * `ses:FromAddress` condition further restricts which From addresses the
   * principal may use — `StringLike` if any entry contains a `*` wildcard,
   * otherwise `StringEquals`.
   */
  public grantSend(grantee: iam.IGrantable, fromAddresses?: string[]): iam.Grant {
    let conditions: Record<string, Record<string, unknown>> | undefined;
    if (fromAddresses !== undefined && fromAddresses.length > 0) {
      const operator = fromAddresses.some((a) => a.includes("*")) ? "StringLike" : "StringEquals";
      conditions = { [operator]: { "ses:FromAddress": fromAddresses } };
    }

    return iam.Grant.addToPrincipal({
      grantee,
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      resourceArns: [this.identity.emailIdentityArn],
      ...(conditions !== undefined ? { conditions } : {}),
    });
  }
}
