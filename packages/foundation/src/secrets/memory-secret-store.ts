/**
 * `MemorySecretStore` — in-memory `SecretsManagerClient` / `SSMClient`
 * doubles for tests.
 *
 * Per plans/trellis-migration/testing-strategy.md, mocking is done with
 * in-memory doubles owned by foundation rather than ad-hoc `vi.mock`
 * blocks at each call site. This store implements Path A from the
 * 1.B.4 execution plan: two thin clients that satisfy the `.send()`
 * shapes `resolveSecret` / `resolveParameter` actually invoke, fed
 * through the existing `ResolveContext`.
 *
 * Why client-side doubles (Path A) over a store-side wrapper (Path B):
 * a test using this store exercises the SAME resolve/cache/error-
 * classification code path as production. The only thing swapped out is
 * the network boundary — exactly the seam `ResolveContext` exists for.
 *
 * Faithfulness to the real AWS contract:
 *   - An unseeded secret throws an error whose `name` is
 *     `ResourceNotFoundException` — the name `resolve.ts` maps to
 *     `SecretsNotFoundError`.
 *   - An unseeded parameter throws `name === "ParameterNotFound"` — the
 *     name `resolve.ts` maps to `ParameterNotFoundError`.
 *   - `GetSecretValueCommand` reads its `SecretId` / `VersionId` off
 *     `command.input`; the response carries `SecretString`.
 *   - `GetParameterCommand` reads `Name` / `WithDecryption` off
 *     `command.input`; the response carries `Parameter.Value`.
 *
 * Each instance owns its own seed maps and call counters — there is NO
 * shared state across instances.
 */

import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SSMClient } from "@aws-sdk/client-ssm";

export interface MemorySecretSeed {
  readonly value: string;
  readonly versionId?: string;
}

export interface MemoryParameterSeed {
  readonly value: string;
  readonly type?: "String" | "SecureString" | "StringList";
}

/**
 * The error the AWS SDK throws on a missing secret/parameter. The
 * resolver classifies purely on the `name` field (see
 * `awsErrorName` in resolve.ts), so reproducing `name` is sufficient to
 * drive the real error path.
 */
class AwsNamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * The subset of a command instance our doubles inspect. The real SDK
 * command carries its parameters on `.input`; we narrow to just the
 * fields the resolver sets.
 */
interface SecretsCommandLike {
  readonly input: {
    readonly SecretId?: unknown;
    readonly VersionId?: unknown;
  };
}

interface SsmCommandLike {
  readonly input: {
    readonly Name?: unknown;
    readonly WithDecryption?: unknown;
  };
}

interface GetSecretValueResponse {
  SecretString?: string;
}

interface GetParameterResponse {
  Parameter?: { Value?: string };
}

function isSecretsCommand(command: unknown): command is SecretsCommandLike {
  return (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof (command as { input: unknown }).input === "object"
  );
}

export class MemorySecretStore {
  // Secret seeds keyed by ARN; each ARN holds version -> value plus the
  // current (unpinned) value. We model "AWSCURRENT" as a sentinel key.
  private readonly secrets = new Map<string, Map<string, string>>();
  private readonly parameters = new Map<string, MemoryParameterSeed>();
  private readonly secretCalls = new Map<string, number>();
  private readonly parameterCalls = new Map<string, number>();

  private static readonly CURRENT = "AWSCURRENT";

  /** In-memory `SecretsManagerClient` double. Pass into ResolveContext. */
  readonly secretsClient: SecretsManagerClient;
  /** In-memory `SSMClient` double. Pass into ResolveContext. */
  readonly ssmClient: SSMClient;

  constructor() {
    // The doubles only need `.send`; the resolver calls nothing else.
    // We cast at this single boundary — documented per the task's
    // strict-typing constraint. The structural surface beyond `.send`
    // is never touched by the resolver.
    const secretsDouble = {
      send: (command: unknown): Promise<GetSecretValueResponse> => this.sendSecrets(command),
    };
    const ssmDouble = {
      send: (command: unknown): Promise<GetParameterResponse> => this.sendSsm(command),
    };
    this.secretsClient = secretsDouble as unknown as SecretsManagerClient;
    this.ssmClient = ssmDouble as unknown as SSMClient;
  }

  /**
   * Seed a secret. An unversioned seed sets the current value; a
   * `versionId`-bearing seed pins that version (and also becomes the
   * current value, mirroring how a freshly-written secret's new version
   * is AWSCURRENT).
   */
  setSecret(arn: string, seed: MemorySecretSeed): void {
    let versions = this.secrets.get(arn);
    if (versions === undefined) {
      versions = new Map<string, string>();
      this.secrets.set(arn, versions);
    }
    versions.set(MemorySecretStore.CURRENT, seed.value);
    if (seed.versionId !== undefined) {
      versions.set(seed.versionId, seed.value);
    }
  }

  setParameter(name: string, seed: MemoryParameterSeed): void {
    this.parameters.set(name, seed);
  }

  /** Number of resolve calls observed for a given key (for assertions). */
  calls(kind: "secret" | "parameter", key: string): number {
    const counter = kind === "secret" ? this.secretCalls : this.parameterCalls;
    return counter.get(key) ?? 0;
  }

  /** Reset seeds + call counts. */
  clear(): void {
    this.secrets.clear();
    this.parameters.clear();
    this.secretCalls.clear();
    this.parameterCalls.clear();
  }

  private sendSecrets(command: unknown): Promise<GetSecretValueResponse> {
    if (!isSecretsCommand(command)) {
      return Promise.reject(
        new AwsNamedError("ValidationException", "MemorySecretStore: malformed secrets command"),
      );
    }
    const { SecretId, VersionId } = command.input;
    if (typeof SecretId !== "string") {
      return Promise.reject(
        new AwsNamedError("ValidationException", "MemorySecretStore: SecretId must be a string"),
      );
    }
    this.bump(this.secretCalls, SecretId);

    const versions = this.secrets.get(SecretId);
    if (versions === undefined) {
      return Promise.reject(
        new AwsNamedError("ResourceNotFoundException", `Secrets Manager can't find ${SecretId}`),
      );
    }
    const versionKey = typeof VersionId === "string" ? VersionId : MemorySecretStore.CURRENT;
    const value = versions.get(versionKey);
    if (value === undefined) {
      return Promise.reject(
        new AwsNamedError(
          "ResourceNotFoundException",
          `Secrets Manager can't find version ${versionKey} of ${SecretId}`,
        ),
      );
    }
    return Promise.resolve({ SecretString: value });
  }

  private sendSsm(command: unknown): Promise<GetParameterResponse> {
    // SSM command shares the same `{ input }` envelope as the secrets
    // command, so the same structural guard applies.
    if (!isSecretsCommand(command)) {
      return Promise.reject(
        new AwsNamedError("ValidationException", "MemorySecretStore: malformed SSM command"),
      );
    }
    const ssmInput = command.input as SsmCommandLike["input"];
    const { Name } = ssmInput;
    if (typeof Name !== "string") {
      return Promise.reject(
        new AwsNamedError("ValidationException", "MemorySecretStore: Name must be a string"),
      );
    }
    this.bump(this.parameterCalls, Name);

    const seed = this.parameters.get(Name);
    if (seed === undefined) {
      return Promise.reject(
        new AwsNamedError("ParameterNotFound", `SSM parameter not found: ${Name}`),
      );
    }
    // Real SSM returns the plaintext value for a SecureString only when
    // WithDecryption is requested; the resolver always requests it
    // (default true), so we return the value as-is. We deliberately do
    // not model ciphertext-on-no-decryption since the resolver never
    // exercises that branch.
    return Promise.resolve({ Parameter: { Value: seed.value } });
  }

  private bump(counter: Map<string, number>, key: string): void {
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }
}
