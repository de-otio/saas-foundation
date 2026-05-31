/**
 * `SamlIdpManager` — tenant-aware wrapper around Cognito's
 * SAML IdP CRUD APIs.
 *
 * Differs from {@link OidcIdpManager} in three ways:
 * 1. No client secret. Trust is established via the IdP's
 *    X.509 signing certificate, which lives in the metadata.
 * 2. Metadata is supplied as either a URL Cognito refetches
 *    periodically (~every 6 hours) or as a pasted XML blob.
 * 3. **Unsigned metadata is rejected by default** —
 *    `SamlIdpManager.upsert` requires an explicit
 *    `acceptUnsignedMetadata: true` to proceed. Pasted
 *    metadata is the entire trust anchor; phishing an admin
 *    into pasting hostile metadata is a credible attack
 *    surface.
 *
 * IAM the upsert path needs:
 *   - `cognito-idp:CreateIdentityProvider`
 *   - `cognito-idp:UpdateIdentityProvider`
 *   - `cognito-idp:DescribeIdentityProvider`
 *   - `cognito-idp:DeleteIdentityProvider`
 *   - `cognito-idp:DescribeUserPoolClient`
 *   - `cognito-idp:UpdateUserPoolClient`
 *
 * See doc/federation/02-runtime-api.md § SamlIdpManager and
 * doc/federation/04-saml.md.
 */

import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  ResourceNotFoundException,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { IdpManagerError, SamlMetadataError } from "../errors.js";
import { normaliseIdpName } from "./idp-name.js";
import {
  parseSamlMetadata,
  type ParseSamlMetadataOptions,
  type SamlMetadata,
  type SamlMetadataSource,
} from "../discovery/saml-metadata.js";

const IDP_IDENTIFIER_MAX_COUNT = 50;
const IDP_IDENTIFIER_MAX_LENGTH = 40;
const IDP_IDENTIFIER_REGEX = /^[\w\s+=.@-]+$/;

/** Default attribute mapping — generic SAML profile (schemas.xmlsoap.org URIs). */
const DEFAULT_ATTRIBUTE_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  given_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  family_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
});

export interface SamlIdpManagerProps {
  userPoolId: string;
  region?: string;
  cognitoClient?: CognitoIdentityProviderClient;
  /**
   * Injectable parser for tests; defaults to
   * {@link parseSamlMetadata}.
   */
  parseMetadata?: (
    source: SamlMetadataSource,
    options?: ParseSamlMetadataOptions,
  ) => Promise<SamlMetadata>;
}

export interface SamlIdpInput {
  tenantId: string;
  metadata: SamlMetadataSource;
  attributeMapping?: Record<string, string>;
  idpIdentifiers?: string[];
  /** Default `true` — Cognito signs its AuthnRequest. */
  signRequest?: boolean;
  /** Default `true` if the IdP metadata advertises an encryption cert. */
  encryptAssertions?: boolean;
  /** Default `false`. Default-reject is the security-critical behaviour. */
  acceptUnsignedMetadata?: boolean;
}

export interface SamlIdpRecord {
  tenantId: string;
  cognitoIdpName: string;
  status: "ACTIVE" | "PENDING" | "ERROR";
  /** `<md:EntityDescriptor validUntil="…">` if present in the metadata. */
  metadataExpiresAt?: Date;
  /** Earliest `notAfter` across all signing certs in the metadata. */
  signingCertNotAfter?: Date;
  attachedAppClientIds: string[];
  lastSyncedAt: Date;
}

export class SamlIdpManager {
  private readonly client: CognitoIdentityProviderClient;
  private readonly userPoolId: string;
  private readonly parseMetadata: NonNullable<SamlIdpManagerProps["parseMetadata"]>;

  constructor(props: SamlIdpManagerProps) {
    this.userPoolId = props.userPoolId;
    this.client =
      props.cognitoClient ??
      new CognitoIdentityProviderClient(props.region !== undefined ? { region: props.region } : {});
    this.parseMetadata = props.parseMetadata ?? parseSamlMetadata;
  }

  /**
   * Idempotent create-or-update.
   *
   * Parses the supplied metadata (URL or XML) to extract
   * `signingCertNotAfter` / `metadataExpiresAt` and to apply
   * the default-reject-unsigned policy. The raw metadata
   * (URL or XML) is then passed to Cognito unchanged.
   */
  async upsert(input: SamlIdpInput): Promise<SamlIdpRecord> {
    validateIdpIdentifiers(input.idpIdentifiers);

    const parsed = await this.parseMetadata(input.metadata);
    if (!parsed.isSigned && input.acceptUnsignedMetadata !== true) {
      throw new SamlMetadataError(
        "unsigned",
        `Refusing to register an SAML IdP with unsigned metadata for tenant "${input.tenantId}". ` +
          `Pass acceptUnsignedMetadata: true to override, and surface a warning in your admin UI ` +
          `(see doc/federation/04-saml.md § Trust on paste).`,
      );
    }
    if (parsed.signingCertificates.length === 0) {
      throw new SamlMetadataError(
        "no_signing_cert",
        `SAML metadata for tenant "${input.tenantId}" contains no signing certificate`,
      );
    }

    const providerName = normaliseIdpName(input.tenantId, new Map());

    const providerDetails: Record<string, string> = {
      IDPSignout: "false",
      RequestSigningAlgorithm: "rsa-sha256",
      EncryptedResponses: deriveEncryptedResponses(parsed, input.encryptAssertions),
    };
    if (input.metadata.kind === "url") {
      providerDetails["MetadataURL"] = input.metadata.url;
    } else {
      providerDetails["MetadataFile"] = input.metadata.xml;
    }

    const attributeMapping = {
      ...DEFAULT_ATTRIBUTE_MAPPING,
      ...(input.attributeMapping ?? {}),
    };

    const exists = await this.describeExisting(providerName);
    if (exists) {
      await this.client.send(
        new UpdateIdentityProviderCommand({
          UserPoolId: this.userPoolId,
          ProviderName: providerName,
          ProviderDetails: providerDetails,
          AttributeMapping: attributeMapping,
          IdpIdentifiers: input.idpIdentifiers,
        }),
      );
    } else {
      await this.client.send(
        new CreateIdentityProviderCommand({
          UserPoolId: this.userPoolId,
          ProviderName: providerName,
          ProviderType: "SAML",
          ProviderDetails: providerDetails,
          AttributeMapping: attributeMapping,
          IdpIdentifiers: input.idpIdentifiers,
        }),
      );
    }

    const metadataExpiresAt = parsed.validUntil;
    const signingCertNotAfter = earliestCertExpiry(parsed);
    return {
      tenantId: input.tenantId,
      cognitoIdpName: providerName,
      status: "ACTIVE",
      ...(metadataExpiresAt !== undefined ? { metadataExpiresAt } : {}),
      ...(signingCertNotAfter !== undefined ? { signingCertNotAfter } : {}),
      attachedAppClientIds: [],
      lastSyncedAt: new Date(),
    };
  }

  async get(tenantId: string): Promise<SamlIdpRecord | undefined> {
    const providerName = normaliseIdpName(tenantId, new Map());
    const existing = await this.describeExisting(providerName);
    if (!existing) {
      return undefined;
    }
    return {
      tenantId,
      cognitoIdpName: providerName,
      status: "ACTIVE",
      attachedAppClientIds: [],
      lastSyncedAt:
        existing.LastModifiedDate instanceof Date ? existing.LastModifiedDate : new Date(),
    };
  }

  async delete(tenantId: string, appClientIds: string[] = []): Promise<void> {
    const providerName = normaliseIdpName(tenantId, new Map());
    for (const id of appClientIds) {
      await this.detachFromAppClient(providerName, id);
    }
    try {
      await this.client.send(
        new DeleteIdentityProviderCommand({
          UserPoolId: this.userPoolId,
          ProviderName: providerName,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return;
      }
      throw err;
    }
  }

  async attachToAppClients(tenantId: string, appClientIds: string[]): Promise<void> {
    const providerName = normaliseIdpName(tenantId, new Map());
    for (const id of appClientIds) {
      await this.attachToAppClient(providerName, id);
    }
  }

  // ---------------- private helpers ----------------

  private async describeExisting(
    providerName: string,
  ): Promise<{ LastModifiedDate?: Date | undefined } | undefined> {
    try {
      const out = await this.client.send(
        new DescribeIdentityProviderCommand({
          UserPoolId: this.userPoolId,
          ProviderName: providerName,
        }),
      );
      return out.IdentityProvider ?? undefined;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw err;
    }
  }

  private async attachToAppClient(providerName: string, clientId: string): Promise<void> {
    const desc = await this.client.send(
      new DescribeUserPoolClientCommand({
        UserPoolId: this.userPoolId,
        ClientId: clientId,
      }),
    );
    const c = desc.UserPoolClient;
    if (!c) {
      throw new IdpManagerError("not_found", `App client ${clientId} not found`);
    }
    const current = c.SupportedIdentityProviders ?? [];
    if (current.includes(providerName)) {
      return;
    }
    await this.client.send(
      new UpdateUserPoolClientCommand({
        UserPoolId: this.userPoolId,
        ClientId: clientId,
        SupportedIdentityProviders: [...current, providerName],
        AllowedOAuthFlows: c.AllowedOAuthFlows,
        AllowedOAuthFlowsUserPoolClient: c.AllowedOAuthFlowsUserPoolClient,
        AllowedOAuthScopes: c.AllowedOAuthScopes,
        CallbackURLs: c.CallbackURLs,
        LogoutURLs: c.LogoutURLs,
        ExplicitAuthFlows: c.ExplicitAuthFlows,
      }),
    );
  }

  private async detachFromAppClient(providerName: string, clientId: string): Promise<void> {
    let desc;
    try {
      desc = await this.client.send(
        new DescribeUserPoolClientCommand({
          UserPoolId: this.userPoolId,
          ClientId: clientId,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return;
      }
      throw err;
    }
    const c = desc.UserPoolClient;
    if (!c) {
      return;
    }
    const current = c.SupportedIdentityProviders ?? [];
    if (!current.includes(providerName)) {
      return;
    }
    const next = current.filter((n) => n !== providerName);
    await this.client.send(
      new UpdateUserPoolClientCommand({
        UserPoolId: this.userPoolId,
        ClientId: clientId,
        SupportedIdentityProviders: next,
        AllowedOAuthFlows: c.AllowedOAuthFlows,
        AllowedOAuthFlowsUserPoolClient: c.AllowedOAuthFlowsUserPoolClient,
        AllowedOAuthScopes: c.AllowedOAuthScopes,
        CallbackURLs: c.CallbackURLs,
        LogoutURLs: c.LogoutURLs,
        ExplicitAuthFlows: c.ExplicitAuthFlows,
      }),
    );
  }
}

function deriveEncryptedResponses(parsed: SamlMetadata, explicit: boolean | undefined): string {
  if (typeof explicit === "boolean") {
    return explicit ? "true" : "false";
  }
  return parsed.encryptionCertificates.length > 0 ? "true" : "false";
}

function earliestCertExpiry(parsed: SamlMetadata): Date | undefined {
  const all = [...parsed.signingCertificates, ...parsed.encryptionCertificates];
  if (all.length === 0) {
    return undefined;
  }
  let earliest: Date | undefined;
  for (const cert of all) {
    if (!earliest || cert.notAfter < earliest) {
      earliest = cert.notAfter;
    }
  }
  return earliest;
}

function validateIdpIdentifiers(identifiers: string[] | undefined): void {
  if (!identifiers) {
    return;
  }
  if (identifiers.length > IDP_IDENTIFIER_MAX_COUNT) {
    throw new IdpManagerError(
      "idp_identifier_invalid",
      `idpIdentifiers exceeds Cognito's ${IDP_IDENTIFIER_MAX_COUNT}-item cap (got ${identifiers.length})`,
    );
  }
  for (const id of identifiers) {
    if (typeof id !== "string" || id.length === 0 || id.length > IDP_IDENTIFIER_MAX_LENGTH) {
      throw new IdpManagerError(
        "idp_identifier_invalid",
        `idpIdentifiers entry must be 1-${IDP_IDENTIFIER_MAX_LENGTH} chars (got "${id}")`,
      );
    }
    if (!IDP_IDENTIFIER_REGEX.test(id)) {
      throw new IdpManagerError(
        "idp_identifier_invalid",
        `idpIdentifiers entry "${id}" violates Cognito's regex [\\w\\s+=.@-]+`,
      );
    }
  }
}
