import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { beforeEach, describe, expect, it } from "vitest";
import { SesEmailIdentity } from "../../lib/ses-email-identity/index.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name = "TestStack"): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

describe("SesEmailIdentity", () => {
  describe("with a hosted zone", () => {
    let template: Template;
    let stack: cdk.Stack;

    beforeEach(() => {
      stack = makeStack("SesZoneStack");
      const zone = new route53.PublicHostedZone(stack, "Zone", {
        zoneName: "example.com",
      });
      new SesEmailIdentity(stack, "Ses", {
        domainName: "example.com",
        hostedZone: zone,
        dmarc: { policy: "quarantine", rua: "dmarc@example.com" },
      });
      template = Template.fromStack(stack);
    });

    it("creates an EmailIdentity", () => {
      template.resourceCountIs("AWS::SES::EmailIdentity", 1);
    });

    it("enables Easy DKIM signing on the identity", () => {
      template.hasResourceProperties("AWS::SES::EmailIdentity", {
        DkimAttributes: { SigningEnabled: true },
      });
    });

    it("configures the custom MAIL FROM domain", () => {
      template.hasResourceProperties("AWS::SES::EmailIdentity", {
        MailFromAttributes: { MailFromDomain: "mail.example.com" },
      });
    });

    it("attaches the configuration set to the identity", () => {
      template.hasResourceProperties("AWS::SES::EmailIdentity", {
        ConfigurationSetAttributes: {
          ConfigurationSetName: Match.anyValue(),
        },
      });
    });

    it("creates a configuration set requiring TLS", () => {
      template.hasResourceProperties("AWS::SES::ConfigurationSet", {
        DeliveryOptions: { TlsPolicy: "REQUIRE" },
      });
    });

    it("publishes reputation metrics by default", () => {
      template.hasResourceProperties("AWS::SES::ConfigurationSet", {
        ReputationOptions: { ReputationMetricsEnabled: true },
      });
    });

    it("creates an SNS topic", () => {
      template.resourceCountIs("AWS::SNS::Topic", 1);
    });

    it("creates a config-set event destination for BOUNCE and COMPLAINT", () => {
      template.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: Match.arrayWith(["bounce", "complaint"]),
          SnsDestination: { TopicARN: Match.anyValue() },
        },
      });
    });

    it("creates the MAIL FROM MX record (via the L2) on the mail subdomain", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "mail.example.com.",
        Type: "MX",
        ResourceRecords: ["10 feedback-smtp.eu-west-1.amazonses.com"],
      });
    });

    it("creates the MAIL FROM SPF TXT record (via the L2)", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "mail.example.com.",
        Type: "TXT",
        ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
      });
    });

    it("creates the DMARC TXT record with the requested policy and rua", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "_dmarc.example.com.",
        Type: "TXT",
        ResourceRecords: ['"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"'],
      });
    });

    it("creates the three Easy DKIM CNAME records (via the L2)", () => {
      const records = template.findResources("AWS::Route53::RecordSet", {
        Properties: { Type: "CNAME" },
      });
      expect(Object.keys(records).length).toBe(3);
    });

    it("does not emit CfnOutputs when a hosted zone is provided", () => {
      const outputs = template.findOutputs("*");
      expect(Object.keys(outputs).length).toBe(0);
    });
  });

  describe("DMARC default policy", () => {
    it("defaults to p=none with no rua", () => {
      const stack = makeStack("SesDmarcDefaultStack");
      const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.org" });
      new SesEmailIdentity(stack, "Ses", { domainName: "example.org", hostedZone: zone });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "_dmarc.example.org.",
        Type: "TXT",
        ResourceRecords: ['"v=DMARC1; p=none;"'],
      });
    });
  });

  describe("without a hosted zone", () => {
    let template: Template;

    beforeEach(() => {
      const stack = makeStack("SesNoZoneStack");
      new SesEmailIdentity(stack, "Ses", { domainName: "example.net" });
      template = Template.fromStack(stack);
    });

    it("still creates the EmailIdentity and configuration set", () => {
      template.resourceCountIs("AWS::SES::EmailIdentity", 1);
      template.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    });

    it("creates no Route53 records", () => {
      template.resourceCountIs("AWS::Route53::RecordSet", 0);
    });

    it("emits CfnOutputs for the manual DNS records (DKIM x3, MX, SPF, DMARC)", () => {
      const outputs = template.findOutputs("*");
      const keys = Object.keys(outputs);
      // 3 DKIM + MAIL FROM MX + SPF + DMARC = 6
      expect(keys.length).toBe(6);
    });

    it("emits a MAIL FROM MX output referencing the stack region", () => {
      template.hasOutput("*", {
        Value: Match.objectLike({
          "Fn::Join": Match.anyValue(),
        }),
      });
    });

    it("configures the MAIL FROM domain on the identity", () => {
      template.hasResourceProperties("AWS::SES::EmailIdentity", {
        MailFromAttributes: { MailFromDomain: "mail.example.net" },
      });
    });
  });

  describe("custom mailFromSubdomain and reputation disabled", () => {
    it("honors a custom subdomain and disables reputation metrics", () => {
      const stack = makeStack("SesCustomStack");
      const zone = new route53.PublicHostedZone(stack, "Zone", { zoneName: "example.com" });
      new SesEmailIdentity(stack, "Ses", {
        domainName: "example.com",
        hostedZone: zone,
        mailFromSubdomain: "bounce",
        enableReputationMetrics: false,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::SES::EmailIdentity", {
        MailFromAttributes: { MailFromDomain: "bounce.example.com" },
      });
      template.hasResourceProperties("AWS::SES::ConfigurationSet", {
        ReputationOptions: { ReputationMetricsEnabled: false },
      });
    });
  });

  describe("configurationSetName", () => {
    it("passes through the explicit configuration set name", () => {
      const stack = makeStack("SesNamedStack");
      new SesEmailIdentity(stack, "Ses", {
        domainName: "example.io",
        configurationSetName: "my-config-set",
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::SES::ConfigurationSet", {
        Name: "my-config-set",
      });
    });
  });

  describe("public members", () => {
    it("exposes identity, configurationSet, bounceComplaintTopic, domainName, mailFromDomain", () => {
      const stack = makeStack("SesMembersStack");
      const construct = new SesEmailIdentity(stack, "Ses", { domainName: "example.com" });
      expect(construct.identity).toBeDefined();
      expect(construct.configurationSet).toBeDefined();
      expect(construct.bounceComplaintTopic).toBeDefined();
      expect(construct.domainName).toBe("example.com");
      expect(construct.mailFromDomain).toBe("mail.example.com");
    });
  });

  describe("grantSend", () => {
    it("grants scoped SendEmail/SendRawEmail without a wildcard resource", () => {
      const stack = makeStack("SesGrantStack");
      const construct = new SesEmailIdentity(stack, "Ses", { domainName: "example.com" });
      const role = new iam.Role(stack, "SenderRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      construct.grantSend(role);
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ["ses:SendEmail", "ses:SendRawEmail"],
              Effect: "Allow",
              Resource: Match.not("*"),
            }),
          ]),
        },
      });
    });

    it("adds a StringEquals ses:FromAddress condition for exact addresses", () => {
      const stack = makeStack("SesGrantExactStack");
      const construct = new SesEmailIdentity(stack, "Ses", { domainName: "example.com" });
      const role = new iam.Role(stack, "SenderRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      construct.grantSend(role, ["noreply@example.com"]);
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Condition: { StringEquals: { "ses:FromAddress": ["noreply@example.com"] } },
            }),
          ]),
        },
      });
    });

    it("uses StringLike when a From address contains a wildcard", () => {
      const stack = makeStack("SesGrantWildcardStack");
      const construct = new SesEmailIdentity(stack, "Ses", { domainName: "example.com" });
      const role = new iam.Role(stack, "SenderRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      construct.grantSend(role, ["*@example.com"]);
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Condition: { StringLike: { "ses:FromAddress": ["*@example.com"] } },
            }),
          ]),
        },
      });
    });
  });
});
