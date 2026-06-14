/**
 * Wildcard ACM cert + wildcard DNS for `SharedDistributionIdentity`.
 *
 * Per [05-wildcard-infra.md]:
 *
 * - Cert lives in **us-east-1** (CloudFront requirement).
 * - SAN list includes both `*.<parent>` and `<parent>` by default
 *   (override-able via `certificateSubjectAlternativeNames`).
 * - Wildcard A-alias + AAAA-alias records are created if a hostedZone
 *   is provided, but they are **deferred** — CloudFront distribution
 *   is owned by P2b, so the alias records are created by P2b at
 *   distribution time. This module owns just the cert.
 *
 * Two operating modes:
 *
 * 1. `hostedZone` provided → create a new cert with DNS validation.
 *    The cert's resolved ARN is exposed via {@link certificateArn}.
 * 2. `existingWildcardCertificateArn` provided → import the existing
 *    cert by ARN. The ARN is passed through unchanged.
 *
 * The two are mutually exclusive. The construct refuses both unset
 * or both set at synth time.
 *
 * **Cross-region note.** When `hostedZone` is provided AND the stack
 * is not us-east-1, the consumer MUST set `crossRegionReferences: true`
 * on the stack (or provide an `existingWildcardCertificateArn`
 * produced by a separate us-east-1 stack). The construct emits a
 * clear annotation in that case but does not synth-fail — CDK's
 * cross-stack reference machinery handles the SSM-backed indirection
 * when configured correctly.
 */

import * as path from "node:path";

import { Annotations, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

// Suppress unused-path for now; reserved for future bundle-path resolution.
void path;

export interface WildcardCertProps {
  /**
   * Parent subdomain. Tenants land at
   * `<tenant>.<tenantSubdomainParent>`.
   */
  readonly tenantSubdomainParent: string;

  /**
   * Route 53 hosted zone. If provided, the cert is created with DNS
   * validation against this zone. Mutually exclusive with
   * {@link existingWildcardCertificateArn}.
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Pre-existing wildcard cert in us-east-1. Mutually exclusive with
   * {@link hostedZone}.
   */
  readonly existingWildcardCertificateArn?: string;

  /**
   * Override the cert SAN list. Default `[*.<parent>, <parent>]` per
   * [05-wildcard-infra.md] § Apex / parent landing page. Pass `[]`
   * (or just `['*.<parent>']`) to exclude the parent from the cert
   * so browsers visiting the parent see a name-mismatch error.
   *
   * The wildcard SAN (`*.<parent>`) is always added — the consumer's
   * override controls whether the parent itself is also covered.
   */
  readonly certificateSubjectAlternativeNames?: readonly string[];
}

export class WildcardCertConfigError extends Error {
  public override readonly name = "WildcardCertConfigError";
  public constructor(message: string) {
    super(message);
  }
}

export class WildcardCert extends Construct {
  /** Resolved cert ARN — works whether we created it or imported it. */
  readonly certificateArn: string;

  /** The underlying CDK cert handle, useful for `addTags` / cross-construct refs. */
  readonly certificate: acm.ICertificate;

  /**
   * The SAN list actually applied to the cert. Empty if importing an
   * existing cert (we don't know what the consumer's pre-baked cert
   * covers).
   */
  readonly subjectAlternativeNames: readonly string[];

  constructor(scope: Construct, id: string, props: WildcardCertProps) {
    super(scope, id);

    if (props.hostedZone == null && (props.existingWildcardCertificateArn == null || props.existingWildcardCertificateArn === '')) {
      throw new WildcardCertConfigError(
        `[vestibulum-cdk:SharedDistributionIdentity] one of 'hostedZone' ` +
          `or 'existingWildcardCertificateArn' must be set. The construct ` +
          `creates the wildcard ACM cert via DNS validation when a hosted ` +
          `zone is supplied; otherwise it imports an existing cert by ARN.`,
      );
    }
    if (props.hostedZone != null && props.existingWildcardCertificateArn != null && props.existingWildcardCertificateArn !== '') {
      throw new WildcardCertConfigError(
        `[vestibulum-cdk:SharedDistributionIdentity] 'hostedZone' and ` +
          `'existingWildcardCertificateArn' are mutually exclusive.`,
      );
    }

    const wildcardDomain = `*.${props.tenantSubdomainParent}`;

    if (props.existingWildcardCertificateArn != null && props.existingWildcardCertificateArn !== '') {
      this.certificate = acm.Certificate.fromCertificateArn(
        this,
        "ImportedWildcardCert",
        props.existingWildcardCertificateArn,
      );
      this.certificateArn = props.existingWildcardCertificateArn;
      this.subjectAlternativeNames = [];
      return;
    }

    // hostedZone path — create the cert.
    //
    // Default SAN list per [05-wildcard-infra.md]: include the parent.
    // Pass `[]` (or a different list) to exclude.
    const defaultSans = [props.tenantSubdomainParent];
    const sans =
      props.certificateSubjectAlternativeNames !== undefined
        ? [...props.certificateSubjectAlternativeNames]
        : defaultSans;
    this.subjectAlternativeNames = Object.freeze(sans);

    // Cross-region guard. CloudFront requires the cert in us-east-1.
    // We don't synth-fail because consumers may legitimately use
    // `crossRegionReferences: true` to produce the cert in a separate
    // us-east-1 stack and reference it from a regional stack. P2b
    // wires that integration when it consumes `certificateArn`.
    const region = Stack.of(this).region;
    if (region && region !== "us-east-1" && !/Token/.test(region)) {
      Annotations.of(this).addInfo(
        `[vestibulum-cdk:SharedDistributionIdentity] wildcard cert created ` +
          `in stack region '${region}', but CloudFront requires us-east-1 ` +
          `for viewer certs. Ensure the stack is configured with ` +
          `'crossRegionReferences: true' so the cert ARN resolves through ` +
          `the cross-region SSM machinery, or provide an ` +
          `'existingWildcardCertificateArn' produced by a us-east-1 stack.`,
      );
    }

    const cert = new acm.Certificate(this, "WildcardCert", {
      domainName: wildcardDomain,
      ...(sans.length > 0 ? { subjectAlternativeNames: [...sans] } : {}),
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });
    this.certificate = cert;
    this.certificateArn = cert.certificateArn;
  }
}
