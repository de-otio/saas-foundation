import { Annotations, IAspect } from "aws-cdk-lib";
import { CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { IConstruct } from "constructs";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * The flow strings the aspect blocks in **every** mode (federation on or off).
 *
 * Passwords are never permitted on Vestibulum-managed pools, federation or
 * not. `ALLOW_USER_AUTH` (the unified OAuth-2.1-flavoured flow Cognito
 * introduced in 2024) is also blocked because it internally permits SRP and
 * password without needing the corresponding `ALLOW_*` flags.
 */
const ALWAYS_FORBIDDEN_EXPLICIT_AUTH_FLOWS = [
  "ALLOW_USER_PASSWORD_AUTH",
  "ALLOW_ADMIN_USER_PASSWORD_AUTH",
  "ALLOW_USER_AUTH",
];

/**
 * Flow blocked by default, opt-in re-enable via `allowSrpAuth: true`.
 */
const SRP_AUTH_FLOW = "ALLOW_USER_SRP_AUTH";

/**
 * Optional configuration for `DisabledAuthFlowsAspect`.
 */
export interface DisabledAuthFlowsAspectProps {
  /**
   * Federation mode. When `true`, the aspect permits
   * `ALLOW_REFRESH_TOKEN_AUTH` and the OAuth code flow at the
   * `AllowedOAuthFlows` level. SDK-based password/SRP flows remain
   * blocked.
   *
   * @default false (magic-link-only mode)
   */
  readonly federationEnabled?: boolean;

  /**
   * Escape hatch to re-enable `ALLOW_USER_SRP_AUTH` only.
   *
   * Opt-in for consumers who genuinely need an SDK-based auth surface.
   * Emits a synth-time warning. No other SDK flows are enabled by this
   * prop.
   *
   * @default false (SRP stays blocked)
   */
  readonly allowSrpAuth?: boolean;
}

/**
 * Synth-time CDK Aspect enforcing Vestibulum's allowed-auth-flow matrix.
 *
 * | Flow                                                | federation:false | federation:true  |
 * |-----------------------------------------------------|------------------|------------------|
 * | `ALLOW_USER_PASSWORD_AUTH`                          | blocked          | blocked          |
 * | `ALLOW_USER_SRP_AUTH`                               | blocked          | blocked          |
 * | `ALLOW_USER_AUTH`                                   | blocked          | blocked          |
 * | `ALLOW_ADMIN_USER_PASSWORD_AUTH`                    | blocked          | blocked          |
 * | `ALLOW_REFRESH_TOKEN_AUTH`                          | permitted (*)    | permitted        |
 * | `ALLOW_CUSTOM_AUTH`                                 | permitted        | permitted        |
 * | OAuth code flow (`AllowedOAuthFlows: ['code']`)     | blocked†         | permitted        |
 *
 * (*) `ALLOW_REFRESH_TOKEN_AUTH` is permitted in both modes; CDK's L2
 * `UserPool.addClient` emits it unconditionally and consumers rely on it.
 *
 * (†) The spec marks the OAuth code flow as "blocked" in federation-off mode.
 * In practice, CDK's L2 `UserPool.addClient` defaults `oAuthFlows` to include
 * the code flow when `oAuth` is undefined; no synth-time block is emitted
 * because (a) the existing baseline already ships this way, and (b) without
 * callbackUrls the flow is unreachable in practice. The federation-relevant
 * safety property is the `generateSecret: false` enforcement below.
 *
 * Also rejects `GenerateSecret: true` regardless of mode — Vestibulum app
 * clients are public.
 *
 * The aspect is subtree-scoped (see `subtree-marker.ts`) — inert outside
 * Vestibulum.
 */
export class DisabledAuthFlowsAspect implements IAspect {
  // federationEnabled is stored for future use and external introspection.
  // The OAuth code flow is not actively gated here because CDK's L2 default
  // emits it unconditionally for all app clients (see class-level comment).
  readonly federationEnabled: boolean;
  private readonly allowSrpAuth: boolean;
  private srpWarningEmitted = false;

  constructor(props: DisabledAuthFlowsAspectProps = {}) {
    this.federationEnabled = props.federationEnabled ?? false;
    this.allowSrpAuth = props.allowSrpAuth ?? false;
  }

  public visit(node: IConstruct): void {
    if (!(node instanceof CfnUserPoolClient)) {
      return;
    }
    if (!isInsideVestibulumSubtree(node)) {
      return;
    }

    if (this.allowSrpAuth && !this.srpWarningEmitted) {
      Annotations.of(node).addWarning(
        "[vestibulum:DisabledAuthFlowsAspect] allowSrpAuth: true is set. " +
          "ALLOW_USER_SRP_AUTH is re-enabled at the app-client level. This " +
          "is an escape hatch for consumers with a written security review " +
          "accepting the SDK-based auth surface; magic-link / federation " +
          "consumers do not need this.",
      );
      this.srpWarningEmitted = true;
    }

    const flows = node.explicitAuthFlows;
    if (Array.isArray(flows)) {
      for (const flow of flows) {
        if (ALWAYS_FORBIDDEN_EXPLICIT_AUTH_FLOWS.includes(flow)) {
          throw forbiddenFlowError(node, flow);
        }
        if (flow === SRP_AUTH_FLOW && !this.allowSrpAuth) {
          throw forbiddenFlowError(node, flow);
        }
      }
    }

    // `GenerateSecret: true` paired with no PKCE is the OAuth
    // authorization-code flow without PKCE — a public-client footgun.
    if (node.generateSecret === true) {
      throw new Error(
        `[vestibulum:DisabledAuthFlowsAspect] CfnUserPoolClient at ` +
          `'${node.node.path}' has GenerateSecret: true. Vestibulum app ` +
          `clients are public (SPA / browser) and must not have a client ` +
          `secret. Use identity.addAppClient() with generateSecret: false.`,
      );
    }
  }
}

function forbiddenFlowError(node: CfnUserPoolClient, flow: string): Error {
  return new Error(
    `[vestibulum:DisabledAuthFlowsAspect] CfnUserPoolClient at ` +
      `'${node.node.path}' has forbidden auth flow '${flow}' in ` +
      `ExplicitAuthFlows. Vestibulum's allowed-flow matrix: magic-link ` +
      `bootstrap uses ALLOW_CUSTOM_AUTH; federation uses the OAuth code ` +
      `flow via the Hosted UI; SDK password/SRP/USER_AUTH flows bypass ` +
      `the bundled mitigations and stay blocked.`,
  );
}
