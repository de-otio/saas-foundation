/**
 * Synth-time aspect: federation-enabled pools must have a Hosted UI domain;
 * custom-domain ACM certs must live in us-east-1.
 *
 * - `federationEnabled: true` + no `hostedUiDomain` set → synth error.
 * - `hostedUiDomain.kind === 'custom'` + ACM cert not in us-east-1 → synth error.
 *
 * The aspect inspects the construct directly via metadata rather than its L1
 * children — the `hostedUiDomain` prop is stored on the construct, not in
 * CloudFormation, so the aspect's input comes from a typed handle.
 *
 * The aspect is subtree-scoped — inert outside a Vestibulum subtree.
 */

import { IAspect } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import { type HostedUiDomainProps, extractAcmRegion } from "../hosted-ui-domain/index.js";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * Metadata type used by `MagicLinkIdentity` to expose its federation-related
 * configuration to the aspect without a class-import cycle.
 */
export const VESTIBULUM_HOSTED_UI_METADATA_TYPE = "vestibulum:hosted-ui-config";

/**
 * Payload shape stored under `VESTIBULUM_HOSTED_UI_METADATA_TYPE`.
 */
export interface HostedUiMetadata {
  readonly federationEnabled: boolean;
  readonly hostedUiDomain?: HostedUiDomainProps;
}

/**
 * Mark a construct node with hosted-UI configuration so
 * `HostedUiDomainAspect` can inspect it at synth time.
 *
 * Called by `MagicLinkIdentity`'s constructor.
 */
export function markHostedUiConfig(scope: IConstruct, metadata: HostedUiMetadata): void {
  scope.node.addMetadata(VESTIBULUM_HOSTED_UI_METADATA_TYPE, metadata, {
    stackTrace: false,
  });
}

/**
 * Read a `HostedUiMetadata` payload off a construct node. Returns
 * `undefined` if the node carries no such metadata.
 */
export function readHostedUiConfig(node: IConstruct): HostedUiMetadata | undefined {
  for (const entry of node.node.metadata) {
    if (entry.type === VESTIBULUM_HOSTED_UI_METADATA_TYPE) {
      return entry.data as HostedUiMetadata;
    }
  }
  return undefined;
}

/**
 * Synth-time aspect that enforces the two Hosted UI invariants.
 */
export class HostedUiDomainAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!isInsideVestibulumSubtree(node)) {
      return;
    }
    const config = readHostedUiConfig(node);
    if (config === undefined) {
      return;
    }

    if (config.federationEnabled && config.hostedUiDomain === undefined) {
      throw new Error(
        `[vestibulum:HostedUiDomainAspect] MagicLinkIdentity at ` +
          `'${node.node.path}' has federationEnabled: true but no ` +
          `hostedUiDomain. Federation requires the Cognito Hosted UI for ` +
          `the OAuth code flow. Set hostedUiDomain to either ` +
          `{ kind: 'cognito', prefix: '...' } or { kind: 'custom', ` +
          `domainName, acmCertArn }.`,
      );
    }

    if (config.hostedUiDomain !== undefined && config.hostedUiDomain.kind === "custom") {
      const region = extractAcmRegion(config.hostedUiDomain.acmCertArn);
      if (region !== undefined && region !== "us-east-1") {
        throw new Error(
          `[vestibulum:HostedUiDomainAspect] MagicLinkIdentity at ` +
            `'${node.node.path}' has a custom Hosted UI domain backed by ` +
            `an ACM cert in '${region}'. Cognito requires custom-domain ` +
            `certs in us-east-1 (identical to CloudFront's requirement); ` +
            `the cert ARN is '${config.hostedUiDomain.acmCertArn}'. ` +
            `Re-issue the cert in us-east-1.`,
        );
      }
    }
  }
}
