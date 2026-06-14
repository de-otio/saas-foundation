/**
 * Named error for `MagicLinkIdentity` synth-time prop validation failures.
 *
 * Distinct from runtime `Error` so consumers writing programmatic
 * validation (e.g., a CI pre-check that synthesises a stack and
 * categorises failures) can `instanceof`-check.
 */
export class MagicLinkIdentityPropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagicLinkIdentityPropsError";
  }
}
