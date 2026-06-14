/**
 * Read-only interface that `MagicLinkIdentity` exposes to downstream
 * constructs (notably `MagicLinkAuthSite`). Owned jointly by Agent A
 * (Identity) and Agent B (Site); kept in `_internal/` so neither
 * construct module owns it outright.
 *
 * Integrated security fix B-I: there is NO `_setSignupMode` method
 * on this interface. `signupMode` lives on `MagicLinkIdentityProps`
 * — the Identity owns the `PreSignUpFn`, so the Identity owns the
 * policy that drives it. `MagicLinkAuthSite` does NOT mutate the
 * Identity post-construction.
 */

import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as sns from "aws-cdk-lib/aws-sns";

import type { Duration } from "aws-cdk-lib";

/**
 * Props for `IMagicLinkIdentity.addAppClient`. Convenience wrapper
 * over `cognito.UserPoolClientOptions`; pre-configures CUSTOM_AUTH
 * and disables password auth flows regardless of consumer input.
 */
export interface AddAppClientProps {
  /**
   * OAuth2 configuration for this app client. `CUSTOM_AUTH` is always
   * enabled regardless of this setting; password / SRP / USER_AUTH
   * are always disabled.
   */
  readonly oauth?: cognito.OAuthSettings;
  /**
   * Whether Cognito should generate a client secret. Public clients
   * (SPAs, mobile) should leave this `false` (the default).
   * @default false
   */
  readonly generateSecret?: boolean;
  /**
   * ID-token validity override for this app client. Falls back to
   * the pool's `defaultIdTokenValidity` when omitted.
   */
  readonly idTokenValidity?: Duration;
  /**
   * Refresh-token validity override. Falls back to the pool's
   * `defaultRefreshTokenValidity` when omitted.
   */
  readonly refreshTokenValidity?: Duration;
}

/**
 * Read-only interface that `MagicLinkIdentity` exposes to downstream
 * constructs. Consumers can implement this themselves to hand-roll
 * a substitute identity, but doing so bypasses the integrated security
 * defaults — not recommended.
 */
export interface IMagicLinkIdentity {
  /** The Cognito User Pool backing the magic-link auth flow. */
  readonly cognitoPool: cognito.IUserPool;
  /** DynamoDB table holding single-use magic-link token SHA-256 hashes. */
  readonly tokenTable: dynamodb.ITable;
  /** DynamoDB table used for per-email rate limiting in CreateAuthChallenge. */
  readonly rateLimitTable: dynamodb.ITable;
  /** DynamoDB table holding the bounce/complaint denylist. */
  readonly denylistTable: dynamodb.ITable;
  /** SNS topic receiving SES bounce/complaint notifications. */
  readonly bounceTopic: sns.ITopic;
  /** Optional consumer-supplied PreTokenGeneration Lambda. */
  readonly preTokenGeneration: lambda.IFunction | undefined;
  /** Optional consumer-supplied PostConfirmation Lambda. */
  readonly postConfirmation: lambda.IFunction | undefined;
  /** Whether federation is enabled on this identity. */
  readonly federationEnabled: boolean;
  /**
   * Adds an additional Cognito app client with magic-link-compatible
   * auth flows. CUSTOM_AUTH is always on, password flows always off.
   */
  addAppClient(id: string, props: AddAppClientProps): cognito.UserPoolClient;
}
