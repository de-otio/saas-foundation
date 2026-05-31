/**
 * The `identity` discriminator carried by both
 * {@link ClaimResolverInput} and {@link ProvisionerInput}.
 *
 * Lets consumer callbacks distinguish federated logins from
 * native (magic-link) Cognito logins without parsing the
 * `identities` JWT claim themselves.
 */
export type Identity =
  | { readonly kind: "cognito" }
  | {
      readonly kind: "federated";
      /**
       * The Cognito-side IdP name (e.g. `tenant-acme`).
       * Derived from `tenantId` via the package-internal
       * idp-name.ts normalisation.
       */
      readonly providerName: string;
      readonly providerType: "OIDC" | "SAML";
    };
