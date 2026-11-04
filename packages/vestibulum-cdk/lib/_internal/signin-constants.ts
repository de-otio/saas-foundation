/**
 * Constants shared with the runtime handlers in `@de-otio/vestibulum`
 * (`src/lambda/shared/signin.ts`).
 *
 * The CDK package cannot import the runtime package at synth time (it is a
 * dev-only dependency used by the bundler), so the values are duplicated here
 * and a test (`test/signin/constants-agreement.test.ts`) fails if they drift.
 */

/**
 * DynamoDB attribute holding a row's expiry (epoch seconds). Tables name it as
 * their `timeToLiveAttribute`; handlers write it and compare it with the clock.
 */
export const TTL_ATTRIBUTE = "expires_at";

/** Link lifetime bounds, minutes. Cognito `AuthSessionValidity` allows 3–15. */
export const MIN_TOKEN_TTL_MINUTES = 3;
export const MAX_TOKEN_TTL_MINUTES = 15;
export const DEFAULT_TOKEN_TTL_MINUTES = 10;

/**
 * `auth-login` response floor in milliseconds (`signin_request_indistinguishable`).
 * Must exceed the p99 of the eligible path; see the measurement note beside the
 * runtime constant. The Lambda timeout is 10 s, so the ceiling leaves headroom
 * for the real work that runs inside the floor.
 */
export const DEFAULT_SIGNIN_FLOOR_MS = 2500;
export const MIN_SIGNIN_FLOOR_MS = 500;
export const MAX_SIGNIN_FLOOR_MS = 6000;

/**
 * CreateAuthChallenge response floor in milliseconds. Measured live: at 400 ms
 * the SES sending path exceeded the floor (p90 439 ms, max 870 ms) while the
 * silent path did not, so the default is 1000 ms. Re-measure per stage.
 */
export const DEFAULT_CREATE_FLOOR_MS = 1000;
export const MIN_CREATE_FLOOR_MS = 100;
export const MAX_CREATE_FLOOR_MS = 5000;
