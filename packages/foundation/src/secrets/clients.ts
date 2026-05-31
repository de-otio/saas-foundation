/**
 * Factory functions for default AWS SDK clients used by the secrets module.
 *
 * Per the foundation conventions (doc/foundation/01-package-api.md):
 *   - No module-scoped client instances. A consumer who never calls
 *     `resolveSecret` should not pay the cost of instantiating a
 *     `SecretsManagerClient`.
 *   - Constructors take their AWS SDK client as a parameter. Default
 *     factories are exposed for the common case ("just give me the
 *     default region/credentials chain"); tests inject mocked clients
 *     via `aws-sdk-client-mock` and pass them through `ResolveContext`.
 */

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";

export interface DefaultClientOptions {
  /** Override the region; defaults to the AWS SDK region resolver. */
  readonly region?: string;
}

/**
 * Build a `SecretsManagerClient` with the SDK's default credentials
 * chain. The consumer wires this at startup; foundation does not call
 * this lazily.
 */
export function createDefaultSecretsManagerClient(
  options?: DefaultClientOptions,
): SecretsManagerClient {
  return new SecretsManagerClient(options?.region !== undefined ? { region: options.region } : {});
}

/**
 * Build an `SSMClient` with the SDK's default credentials chain.
 */
export function createDefaultSsmClient(options?: DefaultClientOptions): SSMClient {
  return new SSMClient(options?.region !== undefined ? { region: options.region } : {});
}
