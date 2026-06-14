/**
 * Custom-attribute declarations + validation helpers for `MagicLinkIdentity`.
 *
 * Cognito does not permit adding custom attributes to an existing user pool;
 * the declarations supplied via `MagicLinkIdentityProps.customAttributes`
 * become a permanent part of the pool schema. The helpers in this module
 * validate the declarations at synth time so consumers see Cognito's rules
 * surfaced before deploy rather than as a CloudFormation rollback.
 *
 * Cognito's rules:
 * - Custom attribute names match `[a-zA-Z0-9_]+`.
 * - Each name is 1–20 chars (excluding the `custom:` prefix Cognito adds).
 * - At most 50 custom attributes per pool (hard quota).
 * - `required + immutable` is rejected at synth time.
 *
 * Federation-specific additional checks (rejecting `mutable: false`,
 * worst-case token-size warnings) live in `FederationCustomAttributesAspect`.
 */

import * as cognito from "aws-cdk-lib/aws-cognito";

/**
 * Declarative description of a single Cognito custom attribute to declare
 * on the user pool at creation time.
 *
 * The bare name (without the `custom:` prefix Cognito adds automatically) is
 * what consumers reference in their claim-resolver callbacks.
 */
export interface CustomAttributeDeclaration {
  /**
   * Bare attribute name, without the `custom:` prefix.
   *
   * Must match `[a-zA-Z0-9_]+` and be 1–20 chars. Cognito adds the prefix
   * automatically; consumers reference the attribute as `custom:{name}`.
   */
  readonly name: string;

  /**
   * Cognito attribute data type.
   *
   * `String` is the only type that honours `minLength` / `maxLength`.
   * `required` is ignored for non-String types (Cognito limitation).
   */
  readonly dataType: "String" | "Number" | "Boolean" | "DateTime";

  /**
   * Whether the attribute is mutable after first set.
   *
   * **Federation note:** `mutable: false` on a `federationEnabled: true` pool
   * is rejected by `FederationCustomAttributesAspect` (configurable severity).
   * The default `true` is the only safe value for federation pools.
   *
   * @default true
   */
  readonly mutable?: boolean;

  /**
   * Whether the attribute is required at user-creation time.
   *
   * Ignored for non-String data types. `required: true` + `mutable: false`
   * is rejected at synth time.
   *
   * @default false
   */
  readonly required?: boolean;

  /**
   * Minimum string length. Only meaningful for `dataType: 'String'`.
   */
  readonly minLength?: number;

  /**
   * Maximum string length. Only meaningful for `dataType: 'String'`.
   *
   * Used by `FederationCustomAttributesAspect` for the worst-case
   * ID-token-size estimate.
   */
  readonly maxLength?: number;
}

/** Maximum total custom attributes per Cognito user pool (hard quota). */
export const MAX_CUSTOM_ATTRIBUTES_PER_POOL = 50;

/**
 * Maximum length of a custom attribute name (excluding the `custom:` prefix).
 * Cognito enforces 1–20 characters at `CreateUserPool` time.
 */
export const MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH = 20;

/** Regex Cognito uses for custom-attribute names. */
export const CUSTOM_ATTRIBUTE_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

/**
 * Validates an array of `CustomAttributeDeclaration` against Cognito's rules.
 *
 * Throws on the first violation with a message naming the offending attribute.
 */
export function validateCustomAttributeDeclarations(
  declarations: readonly CustomAttributeDeclaration[],
): void {
  if (declarations.length > MAX_CUSTOM_ATTRIBUTES_PER_POOL) {
    throw new Error(
      `[vestibulum:customAttributes] Cognito permits at most ` +
        `${MAX_CUSTOM_ATTRIBUTES_PER_POOL} custom attributes per user pool; ` +
        `got ${declarations.length}. Cognito does not permit removing custom ` +
        `attributes after pool creation — reduce the list before deploying.`,
    );
  }

  const seenNames = new Set<string>();
  for (const decl of declarations) {
    if (!CUSTOM_ATTRIBUTE_NAME_REGEX.test(decl.name)) {
      throw new Error(
        `[vestibulum:customAttributes] custom attribute name '${decl.name}' ` +
          `does not match Cognito's required regex /[a-zA-Z0-9_]+/. ` +
          `Names must contain only ASCII alphanumerics and underscores; the ` +
          `'custom:' prefix is added by Cognito automatically.`,
      );
    }
    if (decl.name.length < 1 || decl.name.length > MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH) {
      throw new Error(
        `[vestibulum:customAttributes] custom attribute name '${decl.name}' ` +
          `is ${decl.name.length} chars; Cognito enforces a 1–` +
          `${MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH}-char limit (excluding the ` +
          `'custom:' prefix).`,
      );
    }
    if (seenNames.has(decl.name)) {
      throw new Error(
        `[vestibulum:customAttributes] duplicate custom attribute name ` +
          `'${decl.name}'. Each attribute name must be unique within the pool.`,
      );
    }
    seenNames.add(decl.name);

    if (decl.required === true && decl.mutable === false) {
      throw new Error(
        `[vestibulum:customAttributes] custom attribute '${decl.name}' is ` +
          `both required and immutable (mutable: false). A federated user ` +
          `whose upstream IdP does not supply this attribute can never be ` +
          `created. Pick one: required, or immutable, not both.`,
      );
    }

    if (
      decl.dataType !== "String" &&
      (decl.minLength !== undefined || decl.maxLength !== undefined)
    ) {
      throw new Error(
        `[vestibulum:customAttributes] custom attribute '${decl.name}' is ` +
          `${decl.dataType}; minLength/maxLength are only meaningful for ` +
          `String attributes.`,
      );
    }

    if (
      decl.minLength !== undefined &&
      decl.maxLength !== undefined &&
      decl.minLength > decl.maxLength
    ) {
      throw new Error(
        `[vestibulum:customAttributes] custom attribute '${decl.name}' has ` +
          `minLength (${decl.minLength}) greater than maxLength ` +
          `(${decl.maxLength}).`,
      );
    }
  }
}

/**
 * Convert a `CustomAttributeDeclaration` array into the
 * `cognito.UserPoolProps.customAttributes` map shape expected by the CDK L2
 * `UserPool` construct.
 *
 * Validation runs as a side effect. The map keys are bare attribute names
 * (Cognito adds `custom:` automatically at pool-creation time).
 */
export function toCognitoCustomAttributes(
  declarations: readonly CustomAttributeDeclaration[],
): Record<string, cognito.ICustomAttribute> {
  validateCustomAttributeDeclarations(declarations);

  const result: Record<string, cognito.ICustomAttribute> = {};
  for (const decl of declarations) {
    result[decl.name] = buildCognitoAttribute(decl);
  }
  return result;
}

function buildCognitoAttribute(decl: CustomAttributeDeclaration): cognito.ICustomAttribute {
  const mutable = decl.mutable ?? true;
  switch (decl.dataType) {
    case "String":
      return new cognito.StringAttribute({
        mutable,
        ...(decl.minLength !== undefined ? { minLen: decl.minLength } : {}),
        ...(decl.maxLength !== undefined ? { maxLen: decl.maxLength } : {}),
      });
    case "Number":
      return new cognito.NumberAttribute({ mutable });
    case "Boolean":
      return new cognito.BooleanAttribute({ mutable });
    case "DateTime":
      return new cognito.DateTimeAttribute({ mutable });
  }
}
