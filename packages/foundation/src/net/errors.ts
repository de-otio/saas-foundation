/**
 * Named error types for the net module.
 */

export class InvalidIpError extends Error {
  override readonly name = "InvalidIpError" as const;
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`Invalid IP address: ${reason} (got: ${input})`);
    this.input = input;
  }
}

export class TrustedProxyError extends Error {
  override readonly name = "TrustedProxyError" as const;
}
