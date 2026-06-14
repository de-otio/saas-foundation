/**
 * Bundle entry wrapper for the default Cognito PostConfirmation trigger.
 *
 * Wired only when the consumer does NOT supply their own `postConfirmation`
 * Lambda on `MagicLinkIdentityProps`. The default provisioner is a no-op —
 * a successful sign-up confirmation proceeds without side effects.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createPostConfirmationHandler } from "@de-otio/vestibulum";

export const handler = createPostConfirmationHandler({
  provision: async () => {
    /* default: no-op */
  },
});
