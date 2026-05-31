/**
 * `OidcIdpManager` — tenant-aware wrapper around Cognito's
 * OIDC IdP CRUD APIs.
 *
 * Reads the plaintext OIDC client secret from Secrets Manager
 * during {@link OidcIdpManager.upsert} and passes the literal
 * value to `CreateIdentityProvider` / `UpdateIdentityProvider`.
 * Cognito stores the literal secret internally; there is no
 * ARN-dereference at token-exchange time
 * ([CreateIdentityProvider API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateIdentityProvider.html)).
 *
 * The plaintext lives only on the call stack of `upsert` —
 * never logged, never returned, never stored.
 *
 * IAM the upsert path needs:
 *   - `cognito-idp:CreateIdentityProvider`
 *   - `cognito-idp:UpdateIdentityProvider`
 *   - `cognito-idp:DescribeIdentityProvider`
 *   - `cognito-idp:DeleteIdentityProvider`
 *   - `cognito-idp:DescribeUserPoolClient`
 *   - `cognito-idp:UpdateUserPoolClient`
 *   - `secretsmanager:GetSecretValue` (scoped to the secret
 *     prefix the consumer configured on `IdpSecretsClient`).
 *
 * See doc/federation/02-runtime-api.md § OidcIdpManager.
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

import { IdpManagerError } from "../errors.js";
import { normaliseIdpName } from "./idp-name.js";
import { getSecretValue } from "../secrets/read-internal.js";
import type { IdpSecretsClient } from "../secrets/secrets-client.js";
import { secretRef, type SecretRef } from "@de-otio/saas-foundation";

/** Idp identifier constraints per Cognito's CreateIdentityProvider docs. */
const IDP_IDENTIFIER_MAX_COUNT = 50;
const IDP_IDENTIFIER_MAX_LENGTH = 40;
const IDP_IDENTIFIER_REGEX = /^[\w\s+=.@-]+$/;

/** Default scopes per design doc § Per-provider profiles. */
const DEFAULT_SCOPES: readonly string[] = ["openid", "email", "profile"];

/** Default attribute mapping (generic OIDC profile). */
const DEFAULT_ATTRIBUTE_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  email: "email",
  email_verified: "email_verified",
  given_name: "given_name",
  family_name: "family_name",
  name: "name",
});

export interface OidcIdpManagerProps {
  /** Cognito user-pool ID this manager binds to. */
  userPoolId: string;
  /** AWS region. Defaults to `AWS_REGION` env var. */
  region?: string;
  /**
   * Secrets client whose `secretName` and underlying SDK
   * client are reused to read the plaintext OIDC client
   * secret during `upsert`.
   */
  secretsClient: IdpSecretsClient;
  /** Injectable for tests. */
  cognitoClient?: CognitoIdentityProviderClient;
}

export interface OidcIdpInput {
  /** Free-form tenant identifier; sanitised internally. */
  tenantId: string;
  /** OIDC issuer URL. Already validated by `probeOidcIssuer` at admin save time. */
  issuer: string;
  /** OIDC client ID registered at the IdP. */
  clientId: string;
  /**
   * Secrets Manager ARN where the plaintext OIDC client
   * secret is stored. The manager reads the plaintext value
   * from the secret's canonical name (derived from
   * `secretsClient.secretName(tenantId)`); the ARN is
   * informational, returned in the record for consumer
   * bookkeeping.
   */
  clientSecretArn: string;
  /** Defaults to `['openid', 'email', 'profile']`. */
  scopes?: string[];
  /** Cognito user-pool attribute → OIDC claim name. */
  attributeMapping?: Record<string, string>;
  /** Email-domain etc. identifiers; ≤50 entries, ≤40 chars, regex `[\w\s+=.@-]+`. */
  idpIdentifiers?: string[];
}

export interface OidcIdpRecord {
  tenantId: string;
  cognitoIdpName: string;
  status: "ACTIVE" | "PENDING" | "ERROR";
  attachedAppClientIds: string[];
  lastSyncedAt: Date;
  /**
   * @deprecated Use {@link OidcIdpRecord.clientSecret} (a pinned
   * `SecretRef`) instead. Echoed back from the input for legacy
   * consumer bookkeeping. May be removed in a future minor.
   */
  clientSecretArn?: string;
  /**
   * S-V2: pinned `SecretRef` for the OIDC client secret. Populated
   * by `upsert(...)`: the `versionId` field is the value Secrets
   * Manager actually served when the manager last pushed the
   * plaintext to Cognito. Persist this on the consumer's
   * `TenantIdentityProvider` row — drift between the pinned
   * version and `AWSCURRENT` is the signal that Cognito is
   * holding a stale secret.
   *
   * Absent on `get(...)` responses (no read happened, so no
   * version can be pinned). The consumer should persist the
   * `clientSecret` from `upsert(...)` rather than re-derive it.
   */
  clientSecret?: SecretRef;
}

export class OidcIdpManager {
  private readonly client: CognitoIdentityProviderClient;
  private readonly userPoolId: string;
  private readonly secretsClient: IdpSecretsClient;

  constructor(props: OidcIdpManagerProps) {
    this.userPoolId = props.userPoolId;
    this.secretsClient = props.secretsClient;
    this.client =
      props.cognitoClient ??
      new CognitoIdentityProviderClient(props.region !== undefined ? { region: props.region } : {});
  }

  /**
   * Idempotent create-or-update.
   *
   * Reads the plaintext OIDC client secret from Secrets
   * Manager and passes it as `client_secret` in the
   * `ProviderDetails` payload. The plaintext is never stored
   * on the instance or echoed in the return value.
   */
  async upsert(input: OidcIdpInput): Promise<OidcIdpRecord> {
    validateIdpIdentifiers(input.idpIdentifiers);

    const providerName = normaliseIdpName(input.tenantId, new Map());

    // SECRET — read plaintext only inside this call; do not assign
    // to long-lived state. `read.plaintext` lives on this stack
    // frame only; the returned record captures only the pinned
    // SecretRef (S-V2), never the plaintext.
    const read = await getSecretValue(this.secretsClient, input.tenantId);

    const attributeMapping = {
      ...DEFAULT_ATTRIBUTE_MAPPING,
      ...(input.attributeMapping ?? {}),
    };
    const scopes = (input.scopes ?? DEFAULT_SCOPES).join(" ");
    const providerDetails: Record<string, string> = {
      client_id: input.clientId,
      client_secret: read.plaintext,
      attributes_request_method: "GET",
      oidc_issuer: input.issuer,
      authorize_scopes: scopes,
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
          ProviderType: "OIDC",
          ProviderDetails: providerDetails,
          AttributeMapping: attributeMapping,
          IdpIdentifiers: input.idpIdentifiers,
        }),
      );
    }

    // S-V2: pin the SecretRef to the version Secrets Manager
    // actually served. `secretRef(...)` validates ARN shape; if
    // the ARN from Secrets Manager is malformed (it shouldn't be),
    // the validation error surfaces here rather than silently
    // accepting a bad pin.
    const pinnedClientSecret = secretRef(read.arn, read.versionId);

    return {
      tenantId: input.tenantId,
      cognitoIdpName: providerName,
      status: "ACTIVE",
      attachedAppClientIds: [],
      lastSyncedAt: new Date(),
      clientSecretArn: input.clientSecretArn,
      clientSecret: pinnedClientSecret,
    };
  }

  /**
   * Read the current state of the IdP. Returns undefined if
   * no IdP is registered under the derived name.
   */
  async get(tenantId: string): Promise<OidcIdpRecord | undefined> {
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

  /**
   * Delete the IdP and detach its name from every supplied
   * app client. Cognito has no conditional-write primitive on
   * app-client mutations — racing admin calls can lose
   * updates. The manager does not own a state store; if
   * strict serialisation is required, the consumer must
   * serialise calls at their HTTP layer.
   */
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
        // Idempotent delete.
        return;
      }
      throw err;
    }
  }

  /**
   * Add the IdP to one or more app clients'
   * `SupportedIdentityProviders` lists. Idempotent per app
   * client (no duplicate entries).
   */
  async attachToAppClients(tenantId: string, appClientIds: string[]): Promise<void> {
    const providerName = normaliseIdpName(tenantId, new Map());
    for (const id of appClientIds) {
      await this.attachToAppClient(providerName, id);
    }
  }

  // --------------- private helpers ---------------

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
        // Echo back the fields Cognito requires to be re-stated.
        // CDK and console pre-set these; SDK callers must too.
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
        return; // App client gone; nothing to detach from.
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
