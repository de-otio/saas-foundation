/**
 * Self-signup enrolment — the ONE module that may call Cognito `SignUp`.
 *
 * `signin_no_self_signup` (I9) says no code path calls `SignUp`. This module is
 * the explicit, documented deviation for `enrollment: "self-signup"`, the legacy
 * opt-in mode: `auth-login` signs the typed address up on the fly and the
 * PreSignUp trigger's domain allow-list is the only gate. It plants a throwaway
 * password the user never sees (the app client has no password flow).
 *
 * Keeping the import here lets a test assert, by grep, that no other handler
 * source imports `SignUpCommand`, and lets the CDK grant `cognito-idp:SignUp`
 * only in this mode.
 */

import crypto from "crypto";
import {
  SignUpCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Default throwaway password for SignUp. The user never sees or uses it — the
 * actual authentication is the CUSTOM_AUTH magic-link challenge — but Cognito
 * requires a complexity-compliant value. `Aa1!` covers the standard policy
 * (upper, lower, digit, symbol); the random suffix provides entropy.
 */
export function defaultRandomPassword(): string {
  return `Aa1!${crypto.randomBytes(24).toString("base64url")}`;
}

/**
 * SignUp, swallowing EVERY error so that "already registered", "domain not
 * allowed" (a PreSignUp rejection) and "freshly created" are indistinguishable
 * to the caller — the enumeration-parity property.
 */
export async function signUpQuietly(
  client: CognitoIdentityProviderClient,
  clientId: string,
  email: string,
  password: string,
): Promise<void> {
  try {
    await client.send(
      new SignUpCommand({
        ClientId: clientId,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }],
      }),
    );
  } catch {
    // Intentionally ignored — see above.
  }
}
