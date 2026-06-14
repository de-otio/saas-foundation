/**
 * Vestibulum-owned frozen callback shapes.
 *
 * See doc/04-shared-vocabulary.md §§ ClaimResolverInput,
 * ClaimResolverOutput, ProvisionerInput.
 *
 * These three types form the contract between Cognito-trigger Lambda
 * templates (bundled into vestibulum-cdk at publish time) and the
 * consumer's callback code (in the consumer's repo). Changing them
 * silently means deployed Lambdas pass incompatible inputs to
 * consumer callbacks at runtime — a particularly painful failure
 * mode because it only manifests at the first post-deploy login.
 *
 * Per H-3 of the initial review, the field formerly named
 * `clientMetadata` on `ClaimResolverInput` is renamed to
 * `untrustedClientMetadata` so the trust boundary is visible at the
 * type level. Cognito passes this through from the client without
 * validation; consumers must not use it for authorization decisions.
 */

/**
 * Known Cognito trigger sources for the PreTokenGeneration trigger
 * family. Consumers match known values and treat unknown sources
 * defensively (forward compatibility).
 */
export type KnownClaimTriggerSource =
  | "TokenGeneration_Authentication"
  | "TokenGeneration_HostedAuth"
  | "TokenGeneration_NewPasswordChallenge"
  | "TokenGeneration_AuthenticateDevice"
  | "TokenGeneration_RefreshTokens";

/**
 * Known Cognito trigger sources for the PostConfirmation trigger family.
 */
export type KnownProvisionerSource =
  | "PostConfirmation_ConfirmSignUp"
  | "PostConfirmation_ConfirmForgotPassword";

/**
 * Closed: federated vs native. Adding a kind requires an RFC.
 *
 * @remarks
 * S-V9 — `providerName → TenantId` reverse-map round-trip.
 * The `providerName` field on the federated variant carries the
 * Cognito IdP name (e.g. `'tenant-abc123'`) derived by
 * `normaliseIdpName(tenantId, ...)` in the IdP manager. The
 * derivation is lossy: the manager truncates to 25 chars and
 * replaces non-`[a-z0-9-]` characters with `-`, so callbacks
 * cannot recover the original `TenantId` by string manipulation.
 *
 * Consumers that need the original `TenantId` (e.g. to scope a
 * tenant-aware DB query inside the claim resolver or provisioner)
 * MUST keep their own `{cognitoIdpName → TenantId}` mapping —
 * typically the same row that records the IdP registration —
 * and look it up here rather than re-deriving from
 * `providerName`. The IdP manager's `name_collision` refusal
 * (doc/vestibulum/01-package-api.md § Uniqueness guard) ensures
 * the mapping stays unique by construction.
 */
export type CallbackIdentity =
  | { readonly kind: "cognito" }
  | {
      readonly kind: "federated";
      /**
       * Cognito IdP `ProviderName`, derived from `TenantId` via the
       * lossy normalisation in `idp/idp-name.ts`. See class JSDoc
       * (S-V9) for the reverse-map discipline.
       */
      readonly providerName: string;
      readonly providerType: "OIDC" | "SAML";
    };

/**
 * Input passed to the consumer's claim-resolver callback on
 * PreTokenGeneration triggers.
 *
 * @remarks
 * S-V9 — `identity.providerName → TenantId` reverse mapping.
 * When `identity.kind === 'federated'`, `identity.providerName`
 * is the lossy Cognito IdP name (see {@link CallbackIdentity}).
 * Consumers that need the original `TenantId` MUST keep their
 * own `{cognitoIdpName → TenantId}` row (the same one written
 * during IdP registration) and look it up at callback time
 * rather than re-deriving from `providerName`.
 */
export interface ClaimResolverInput {
  readonly userSub: string;
  readonly userAttributes: Readonly<Record<string, string>>;
  readonly clientId: string;
  /** Open string union for forward compatibility with new trigger sources. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional open-union sentinel
  readonly triggerSource: KnownClaimTriggerSource | (string & {});
  readonly identity: CallbackIdentity;
  readonly federatedGroups: ReadonlyArray<string>;
  readonly isRefresh: boolean;
  /**
   * Caller-supplied metadata from `AdminRespondToAuthChallenge` /
   * `RespondToAuthChallenge`. **Untrusted:** Cognito passes this
   * through from the client without validation; do NOT use for
   * authorization decisions. Renamed from `clientMetadata` to make
   * the trust boundary visible at the type level (H-3 of initial review).
   */
  readonly untrustedClientMetadata: Readonly<Record<string, string>>;
}

/**
 * Output returned by the consumer's claim-resolver callback.
 *
 * Frozen because deployed Lambdas receive consumer output and pass
 * it to Cognito; a silent shape change desyncs the bundled Lambda
 * from the consumer's callback (B-K of initial review).
 */
export interface ClaimResolverOutput {
  readonly claimsToAddOrOverride?: Readonly<
    Record<string, string | number | boolean | ReadonlyArray<string>>
  >;
  readonly claimsToSuppress?: ReadonlyArray<string>;
  /** Replaces `cognito:groups` (and, where applicable, role claims). */
  readonly groupsToOverride?: ReadonlyArray<string>;
  /** Access-token scope additions. V2/V3 events only; silently ignored on V1. */
  readonly scopesToAdd?: ReadonlyArray<string>;
  /** Access-token scope suppressions. V2/V3 events only. */
  readonly scopesToSuppress?: ReadonlyArray<string>;
}

/**
 * Input passed to the consumer's provisioner callback on
 * PostConfirmation triggers.
 */
export interface ProvisionerInput {
  readonly userSub: string;
  readonly userAttributes: Readonly<Record<string, string>>;
  readonly clientId: string;
  /** Open string union for forward compatibility (e.g., SCIM provisioner paths). */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional open-union sentinel
  readonly triggerSource: KnownProvisionerSource | (string & {});
  readonly identity: CallbackIdentity;
}

/**
 * Claim names reserved by Cognito / OIDC that consumers MUST NOT
 * include in `ClaimResolverOutput.claimsToAddOrOverride`. The
 * runtime validates against this set in the trigger handler (P4);
 * exposing it here as a frozen constant lets consumers check at
 * build time.
 *
 * Source: AWS Cognito documentation on token generation triggers
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html).
 *
 * @external-driven (S-V4). The membership of this set is owned
 * upstream by AWS — the list of claim names Cognito rejects
 * override of can change when AWS adds new managed claims to
 * future token generation event versions. The set is treated as
 * "stable for the lifetime of v0.x"; a Cognito-side change that
 * adds a new reserved claim is a tracked upstream-followup
 * (revisit on each major AWS Cognito API revision), not an
 * arbitrary vestibulum break. Consumers should not rely on the
 * exhaustive list — they should treat `RESERVED_CLAIMS.has(name)`
 * as a hard refusal and tolerate the set growing in minor releases.
 */
/**
 * Build a `ReadonlySet`-shaped object that truly rejects mutation at
 * runtime. `Object.freeze(new Set(...))` is insufficient — `Set.add`
 * goes through the internal `[[SetData]]` slot, not an own property,
 * so freezing the wrapper does nothing.
 *
 * We override the mutator methods to throw and freeze the wrapper.
 */
function buildReservedClaimsSet(values: ReadonlyArray<string>): ReadonlySet<string> {
  const inner = new Set<string>(values);
  const guard = (op: string): never => {
    throw new TypeError(`RESERVED_CLAIMS is read-only; ${op} is forbidden`);
  };
  // Override mutating methods. The cast is local to this function; the
  // returned value is typed as ReadonlySet<string>.
  (inner as unknown as { add: () => never }).add = (): never => guard("add");
  (inner as unknown as { delete: () => never }).delete = (): never => guard("delete");
  (inner as unknown as { clear: () => never }).clear = (): never => guard("clear");
  return Object.freeze(inner);
}

export const RESERVED_CLAIMS: ReadonlySet<string> = buildReservedClaimsSet([
  // OIDC core / IANA-registered claims that Cognito rejects override of
  "acr",
  "amr",
  "aud",
  "auth_time",
  "azp",
  "exp",
  "iat",
  "iss",
  "jti",
  "nbf",
  "nonce",
  "sub",
  "token_use",
  // Cognito-managed identifiers
  "cognito:username",
  "cognito:groups",
  "cognito:roles",
  "cognito:preferred_role",
  "username",
  "client_id",
  "origin_jti",
  "event_id",
  "scope",
]);
