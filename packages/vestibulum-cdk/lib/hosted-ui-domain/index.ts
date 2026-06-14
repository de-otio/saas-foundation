/**
 * `HostedUiDomainProps` discriminated union + helpers to wire it onto a
 * Cognito user pool.
 *
 * Two shapes:
 * 1. Cognito-managed subdomain of `auth.{region}.amazoncognito.com`
 *    (`kind: 'cognito'`). Cheapest path; no DNS or ACM cert required.
 * 2. Custom domain backed by an ACM cert (`kind: 'custom'`). The ACM cert
 *    MUST be in us-east-1 (Cognito's requirement, identical to CloudFront's).
 *
 * The synth-time `HostedUiDomainAspect` raises errors for:
 * - `federationEnabled: true` and `hostedUiDomain` unset.
 * - `kind: 'custom'` with an ACM cert ARN outside us-east-1.
 */

import { aws_certificatemanager as acm, aws_cognito as cognito } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * Discriminated union of the two Hosted UI domain shapes Cognito supports.
 */
export type HostedUiDomainProps = CognitoHostedUiDomainProps | CustomHostedUiDomainProps;

/**
 * Cognito-managed Hosted UI subdomain. The prefix must be globally unique
 * within the AWS region.
 *
 * Recommended naming pattern: `{org}-{environment}-{purpose}`
 * (e.g. `acme-prod-auth`).
 */
export interface CognitoHostedUiDomainProps {
  readonly kind: "cognito";

  /**
   * Subdomain prefix. The fully-qualified Hosted UI URL becomes
   * `https://{prefix}.auth.{region}.amazoncognito.com`.
   *
   * Cognito enforces lower-case ASCII, digits, and hyphens; no underscores.
   */
  readonly prefix: string;
}

/**
 * Custom Hosted UI domain backed by an ACM certificate.
 *
 * The ACM cert MUST be in us-east-1.
 */
export interface CustomHostedUiDomainProps {
  readonly kind: "custom";

  /**
   * Fully-qualified custom domain (e.g. `auth.example.com`).
   */
  readonly domainName: string;

  /**
   * ARN of an ACM cert in us-east-1 covering `domainName`.
   *
   * The `HostedUiDomainAspect` raises a synth-time error if the ARN's
   * region is not `us-east-1`.
   */
  readonly acmCertArn: string;
}

/**
 * Regex for Cognito-managed prefix domains: lowercase alphanumerics and
 * hyphens; no leading or trailing hyphen.
 */
export const COGNITO_DOMAIN_PREFIX_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Extract the region component of an ACM cert ARN. Returns `undefined` if
 * the ARN is malformed or contains a CDK token.
 */
export function extractAcmRegion(arn: string): string | undefined {
  if (arn.includes("${")) {
    // Unresolved CDK token; can't validate at synth time.
    return undefined;
  }
  const parts = arn.split(":");
  // arn:partition:service:region:account:resource
  if (parts.length < 6 || parts[2] !== "acm") {
    return undefined;
  }
  return parts[3];
}

/**
 * Validate a `HostedUiDomainProps` at synth time. Throws on malformed
 * values; called from `MagicLinkIdentity`'s constructor.
 */
export function validateHostedUiDomainProps(props: HostedUiDomainProps): void {
  if (props.kind === "cognito") {
    if (!COGNITO_DOMAIN_PREFIX_REGEX.test(props.prefix)) {
      throw new Error(
        `[vestibulum:hostedUiDomain] Cognito subdomain prefix ` +
          `'${props.prefix}' is invalid. Cognito requires lowercase ASCII ` +
          `alphanumerics and hyphens; no leading/trailing hyphen, no ` +
          `underscores.`,
      );
    }
    return;
  }
  // kind: 'custom'
  if (props.domainName.length === 0) {
    throw new Error(
      `[vestibulum:hostedUiDomain] custom hosted-UI domain requires a ` + `non-empty domainName.`,
    );
  }
  if (props.acmCertArn.length === 0) {
    throw new Error(
      `[vestibulum:hostedUiDomain] custom hosted-UI domain requires an ` +
        `acmCertArn (an ACM certificate ARN in us-east-1 covering ` +
        `${props.domainName}).`,
    );
  }
}

/**
 * Attach a Cognito user pool domain to the given user pool per the
 * `HostedUiDomainProps` shape.
 *
 * @param scope The construct scope (typically the `MagicLinkIdentity`).
 * @param id Construct ID for the `UserPoolDomain`.
 * @param userPool The Cognito user pool the domain attaches to.
 * @param props The Hosted UI domain configuration.
 * @returns The created `UserPoolDomain`.
 */
export function attachHostedUiDomain(
  scope: Construct,
  id: string,
  userPool: cognito.IUserPool,
  props: HostedUiDomainProps,
): cognito.UserPoolDomain {
  validateHostedUiDomainProps(props);

  if (props.kind === "cognito") {
    return new cognito.UserPoolDomain(scope, id, {
      userPool,
      cognitoDomain: { domainPrefix: props.prefix },
    });
  }

  const cert = acm.Certificate.fromCertificateArn(scope, `${id}Cert`, props.acmCertArn);
  return new cognito.UserPoolDomain(scope, id, {
    userPool,
    customDomain: {
      domainName: props.domainName,
      certificate: cert,
    },
  });
}
