/**
 * Shared-distribution Cognito trigger handlers and auth Function URL handlers.
 *
 * @see doc/vestibulum/shared-distribution/06-trigger-handlers.md
 */

export { handler as preSignUpHandler } from './pre-signup.js';
export type { SharedPreSignUpEvent } from './pre-signup.js';

export {
  handler as createAuthChallengeHandler,
  createSharedCreateAuthChallengeHandler,
} from './create-auth-challenge.js';
export type {
  SharedCreateAuthChallengeEvent,
  CreateAuthChallengeDeps,
} from './create-auth-challenge.js';

export { handler as preTokenGenerationHandler } from './pre-token-generation.js';

export {
  handler as authVerifyHandler,
  createAuthVerifyHandler,
} from './auth-verify.js';
export type {
  FunctionUrlEvent as AuthVerifyEvent,
  FunctionUrlResult as AuthVerifyResult,
  AuthVerifyDeps,
} from './auth-verify.js';

export {
  handler as authSignoutHandler,
  createAuthSignoutHandler,
} from './auth-signout.js';
export type {
  FunctionUrlEvent as AuthSignoutEvent,
  FunctionUrlResult as AuthSignoutResult,
  AuthSignoutDeps,
} from './auth-signout.js';
