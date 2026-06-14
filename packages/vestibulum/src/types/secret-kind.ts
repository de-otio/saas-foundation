/**
 * Open string union for {@link IdpSecretsClient} secret kinds.
 *
 * Known values get autocomplete; unknown strings are accepted
 * so future SCIM bearer tokens and other kinds don't require
 * a breaking API change.
 */
export type SecretKind =
  | "oidc-client-secret"
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  | (string & {});
