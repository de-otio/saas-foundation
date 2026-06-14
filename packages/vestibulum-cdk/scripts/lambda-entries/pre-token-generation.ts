/**
 * Bundle entry wrapper for the default Cognito PreTokenGeneration trigger.
 *
 * Wired only when the consumer does NOT supply their own
 * `preTokenGeneration` Lambda on `MagicLinkIdentityProps`. The default is a
 * passthrough resolver — no custom claims are added, but the handler still
 * normalises the V1/V2 Cognito events and validates reserved-claim usage.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createPreTokenGenerationHandler } from "@de-otio/vestibulum";

export const handler = createPreTokenGenerationHandler({
  // eslint-disable-next-line @typescript-eslint/require-await
  resolveClaims: async () => ({}),
});
