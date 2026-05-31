/**
 * Synth-time aspect: catches custom-attribute mistakes on federation-enabled
 * Cognito user pools.
 *
 * Raises **errors** for:
 * - Any `mutable: false` custom attribute on a federation-enabled pool
 *   (configurable severity via `immutableAttributeSeverity` — default 'error').
 *   Cognito's `AdminLinkProviderForUser` is reported to refuse users with
 *   immutable custom attributes. Note: this is an empirical observation from
 *   a real pool, not an AWS-documented guarantee. Downgrade to 'warning' if
 *   the constraint is unconfirmed for your target Cognito version.
 * - Required + immutable combinations (a federated user whose IdP does not
 *   supply the attribute can never be created).
 *
 * Raises **warnings** for:
 * - `federationEnabled: true` with zero custom attributes.
 * - More than 10 custom attributes.
 * - Worst-case ID-token-size estimate above 5 KiB (warning) or 6 KiB (error).
 *   Baseline overhead is 2.5 KiB for federated Cognito tokens (empirical;
 *   re-measure against a real sample pool before treating as load-bearing).
 *
 * The aspect is subtree-scoped — inert outside a Vestibulum subtree.
 */

import { Annotations, IAspect } from "aws-cdk-lib";
import { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import { IConstruct } from "constructs";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * Soft warning threshold for worst-case ID-token size (bytes).
 *
 * Browser cookies start hitting limits around 4 KiB per cookie; the
 * 5 KiB soft threshold gives a buffer before the hard error at 6 KiB.
 */
export const TOKEN_SIZE_WARNING_THRESHOLD_BYTES = 5 * 1024;

/**
 * Hard error threshold for worst-case ID-token size (bytes).
 *
 * Above 6 KiB the token is likely to break in production traffic
 * (cookie truncation, HTTP header limits at some proxies).
 */
export const TOKEN_SIZE_ERROR_THRESHOLD_BYTES = 6 * 1024;

/**
 * Base overhead for the standard JWT claims used in the worst-case
 * token-size estimate.
 *
 * Raised from the 1.5 KiB trellis baseline to 2.5 KiB per review S-C3,
 * reflecting real federated Cognito ID tokens (standard claim set +
 * `cognito:*` namespace + federation provider-name claim + any access-token
 * customisations). This is an empirical figure — re-measure against a
 * real sample pool before treating as load-bearing.
 */
export const BASE_CLAIMS_OVERHEAD_BYTES = 2560;

/**
 * Threshold beyond which the aspect emits a "too many attributes" warning.
 */
export const TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD = 10;

/**
 * Severity for the `mutable: false` federation rule.
 *
 * - `'error'` (default): synth fails. Use when following the empirical
 *   `AdminLinkProviderForUser` constraint as a hard rule.
 * - `'warning'`: synth continues with a diagnostic. Use when the constraint
 *   is unconfirmed for your Cognito region / tier or when you have a written
 *   reason for accepting the risk.
 */
export type ImmutableAttributeSeverity = "error" | "warning";

/**
 * Options for `FederationCustomAttributesAspect`.
 */
export interface FederationCustomAttributesAspectProps {
  /**
   * Whether federation is enabled on the pool the aspect guards.
   *
   * The aspect only raises the `mutable: false` / required+immutable
   * errors when federation is enabled. The warnings (zero attributes;
   * >10 attributes; token size) apply unconditionally.
   */
  readonly federationEnabled: boolean;

  /**
   * Severity for the `mutable: false` rule on federation-enabled pools.
   *
   * Default `'error'`. Downgrade to `'warning'` if the
   * `AdminLinkProviderForUser` empirical constraint does not hold for
   * your Cognito region / tier, or if you have a written security
   * review accepting the risk.
   *
   * @default 'error'
   */
  readonly immutableAttributeSeverity?: ImmutableAttributeSeverity;
}

/**
 * Synth-time CDK aspect enforcing federation-related custom-attribute
 * invariants. Wired in by `MagicLinkIdentity` at construct time.
 */
export class FederationCustomAttributesAspect implements IAspect {
  private readonly federationEnabled: boolean;
  private readonly immutableAttributeSeverity: ImmutableAttributeSeverity;

  constructor(props: FederationCustomAttributesAspectProps) {
    this.federationEnabled = props.federationEnabled;
    this.immutableAttributeSeverity = props.immutableAttributeSeverity ?? "error";
  }

  public visit(node: IConstruct): void {
    if (!(node instanceof CfnUserPool)) {
      return;
    }
    if (!isInsideVestibulumSubtree(node)) {
      return;
    }

    const schema = readSchema(node);
    const customAttrs = schema.filter((s) => isCustomAttribute(s));

    if (this.federationEnabled && customAttrs.length === 0) {
      Annotations.of(node).addWarning(
        "[vestibulum:FederationCustomAttributesAspect] federation is enabled " +
          "but no custom attributes are declared. Federation consumers " +
          "typically need custom attributes for tenant/role claims. Adding " +
          "them later requires destroying and rebuilding the user pool.",
      );
    }

    if (customAttrs.length > TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD) {
      Annotations.of(node).addWarning(
        `[vestibulum:FederationCustomAttributesAspect] ${customAttrs.length} ` +
          "custom attributes declared. Cognito permits 50, but each attribute " +
          "consumes a per-user storage row; many attributes per user is a " +
          "code smell. Consider moving bulky claims into a server-side lookup.",
      );
    }

    if (this.federationEnabled) {
      for (const attr of customAttrs) {
        const name = attr.name ?? "(unnamed)";

        if (attr.mutable === false) {
          const msg =
            `[vestibulum:FederationCustomAttributesAspect] CfnUserPool at ` +
            `'${node.node.path}' declares custom attribute '${name}' with ` +
            `Mutable: false. Empirical observation: Cognito's ` +
            `AdminLinkProviderForUser refuses users with immutable custom ` +
            `attributes. Custom attributes cannot be removed after pool ` +
            `creation, so this permanently blocks account-linking. Set ` +
            `mutable: true (default). Downgrade this to a warning by ` +
            `passing immutableAttributeSeverity: 'warning' if the ` +
            `constraint is unconfirmed for your Cognito version.`;
          if (this.immutableAttributeSeverity === "error") {
            throw new Error(msg);
          } else {
            Annotations.of(node).addWarning(msg);
          }
        }
      }
    }

    const estimatedBytes = estimateTokenSizeBytes(customAttrs);
    if (estimatedBytes > TOKEN_SIZE_ERROR_THRESHOLD_BYTES) {
      throw new Error(
        `[vestibulum:FederationCustomAttributesAspect] worst-case ID-token ` +
          `size estimate is ${estimatedBytes} bytes (hard error threshold: ` +
          `${TOKEN_SIZE_ERROR_THRESHOLD_BYTES}). Tokens above ~8 KiB break ` +
          `in production traffic (cookie truncation, proxy header limits). ` +
          `Reduce maxLength on the largest attributes, or move bulky claims ` +
          `to a server-side lookup keyed by 'sub'.`,
      );
    } else if (estimatedBytes > TOKEN_SIZE_WARNING_THRESHOLD_BYTES) {
      Annotations.of(node).addWarning(
        `[vestibulum:FederationCustomAttributesAspect] worst-case ID-token ` +
          `size estimate is ${estimatedBytes} bytes (soft threshold: ` +
          `${TOKEN_SIZE_WARNING_THRESHOLD_BYTES}). Cookie storage and HTTP ` +
          `header limits may apply above ~6 KiB at some proxies and edge ` +
          `networks. Consider reducing maxLength or moving large claims ` +
          `server-side.`,
      );
    }
  }
}

/**
 * Minimal projection of `cognito.CfnUserPool.SchemaAttributeProperty`.
 * Imported by value would create a runtime cycle if the type ever moves.
 */
interface SchemaAttribute {
  readonly name?: string;
  readonly attributeDataType?: string;
  readonly mutable?: boolean;
  readonly required?: boolean;
  readonly stringAttributeConstraints?: {
    readonly maxLength?: string;
    readonly minLength?: string;
  };
}

function readSchema(node: CfnUserPool): readonly SchemaAttribute[] {
  const raw = node.schema as unknown;
  if (Array.isArray(raw)) {
    return raw as SchemaAttribute[];
  }
  return [];
}

/**
 * Standard Cognito attribute names per the OpenID Connect 1.0 core spec
 * plus Cognito's extensions. Used to exclude standard attributes from the
 * custom-attribute count.
 */
const COGNITO_STANDARD_ATTRIBUTE_NAMES = new Set([
  "address",
  "birthdate",
  "email",
  "email_verified",
  "family_name",
  "gender",
  "given_name",
  "locale",
  "middle_name",
  "name",
  "nickname",
  "phone_number",
  "phone_number_verified",
  "picture",
  "preferred_username",
  "profile",
  "updated_at",
  "website",
  "zoneinfo",
  "sub",
]);

function isCustomAttribute(attr: SchemaAttribute): boolean {
  if (attr.name == null) {
    return false;
  }
  return !COGNITO_STANDARD_ATTRIBUTE_NAMES.has(attr.name);
}

/**
 * Estimate worst-case ID-token size given the custom-attribute declarations.
 *
 * Sums per-attribute `maxLength` (defaulting to 256 for attributes without
 * an explicit cap) plus JSON encoding overhead (~12 bytes per claim key)
 * and adds the base claims overhead constant.
 */
function estimateTokenSizeBytes(attrs: readonly SchemaAttribute[]): number {
  let total = BASE_CLAIMS_OVERHEAD_BYTES;
  for (const attr of attrs) {
    const maxLenStr = attr.stringAttributeConstraints?.maxLength;
    const maxLen =
      maxLenStr !== undefined && !Number.isNaN(parseInt(maxLenStr, 10))
        ? parseInt(maxLenStr, 10)
        : 256;
    const keyOverhead = `"custom:${attr.name ?? ""}":"",`.length;
    total += maxLen + keyOverhead;
  }
  return total;
}
