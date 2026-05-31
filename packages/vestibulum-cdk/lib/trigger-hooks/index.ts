/**
 * Wiring helpers that attach vestibulum runtime trigger Lambdas
 * (preTokenGeneration, postConfirmation) to a Cognito user pool.
 *
 * These are **consumer-supplied** Lambdas, not bundled ones. Vestibulum-cdk
 * provides the plumbing (trigger association + Cognito invocation permission);
 * consumers provide the policy (claim logic, bootstrap shape).
 *
 * The vestibulum runtime exposes typed helpers (`ClaimResolverInput`,
 * `ProvisionerInput`, trigger-template factories) for constructing the Lambda
 * handler bodies, but the construct does not need to know about those helpers
 * — it just wires whichever `lambda.IFunction` the consumer hands it.
 *
 * Trust model:
 * 1. No IAM grants from vestibulum-cdk to consumer Lambdas.
 * 2. Same-account, same-region check at synth time — cross-account /
 *    cross-region trigger ARNs are a confused-deputy vector.
 * 3. Reserved claim names in `preTokenGeneration` (documented; not enforced
 *    in the construct since the Lambda body is opaque at synth time).
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Stack } from "aws-cdk-lib";

/**
 * Props for the trigger-wiring helpers.
 *
 * Both hooks are optional. When a prop is unset, no trigger is configured
 * and Cognito's defaults apply.
 */
export interface TriggerHooksProps {
  /**
   * Consumer-supplied Lambda to invoke as the `PreTokenGeneration` trigger.
   *
   * Common uses: per-app-client claim filtering, injection of custom claims
   * (`tenant_id`, `role`, etc.).
   *
   * **Trust boundary:** this Lambda runs inside the auth boundary with
   * token-issuance privileges. See module-level trust-model notes.
   */
  readonly preTokenGeneration?: lambda.IFunction;

  /**
   * Consumer-supplied Lambda to invoke as the `PostConfirmation` trigger.
   *
   * Common uses: bootstrap entries in application-side tables, welcome
   * emails, registering the user in an authorisation service.
   *
   * **Trust boundary:** this Lambda runs after signup with access to user
   * attributes. See module-level trust-model notes.
   */
  readonly postConfirmation?: lambda.IFunction;
}

/**
 * Validate that a consumer-supplied trigger Lambda is in the same account
 * and region as the user pool. Cross-account / cross-region trigger ARNs
 * are a confused-deputy vector.
 *
 * ARN parsing is best-effort; if the ARN contains unresolved CDK tokens
 * (indicated by `${`), validation is skipped and the deploy-time check
 * from CloudFormation applies.
 *
 * @throws Error if the Lambda's account or region differs from the pool.
 */
export function validateTriggerLambdaLocality(fn: lambda.IFunction, poolStack: Stack): void {
  const arn = fn.functionArn;

  // Skip validation for unresolved CDK tokens.
  if (typeof arn !== "string" || arn.includes("${")) {
    return;
  }

  // ARN format: arn:{partition}:{service}:{region}:{account}:{resource}
  const parts = arn.split(":");
  if (parts.length < 6) {
    return;
  }

  const lambdaRegion = parts[3];
  const lambdaAccount = parts[4];

  if (lambdaRegion !== undefined && lambdaRegion !== "" && lambdaRegion !== poolStack.region) {
    throw new Error(
      `[vestibulum:TriggerHooks] trigger Lambda '${arn}' is in region ` +
        `'${lambdaRegion}' but the user pool is in '${poolStack.region}'. ` +
        `Cross-region Cognito triggers are a confused-deputy vector. ` +
        `The Lambda must be in the same region as the user pool.`,
    );
  }

  if (lambdaAccount !== undefined && lambdaAccount !== "" && lambdaAccount !== poolStack.account) {
    throw new Error(
      `[vestibulum:TriggerHooks] trigger Lambda '${arn}' is in account ` +
        `'${lambdaAccount}' but the user pool is in '${poolStack.account}'. ` +
        `Cross-account Cognito triggers are a confused-deputy vector. ` +
        `The Lambda must be in the same account as the user pool.`,
    );
  }
}

/**
 * Wire consumer-supplied trigger Lambdas onto a Cognito user pool.
 *
 * For each supplied Lambda, this helper:
 * 1. Attaches the function as the corresponding Cognito trigger.
 * 2. Grants Cognito permission to invoke it.
 * 3. Validates the function is in the same account and region as the pool.
 *
 * When a prop is unset, no trigger is configured.
 *
 * @param userPool The Cognito user pool to attach triggers to.
 * @param props The trigger hook configuration.
 */
export function attachTriggerHooks(userPool: cognito.UserPool, props: TriggerHooksProps): void {
  const poolStack = Stack.of(userPool);

  if (props.preTokenGeneration !== undefined) {
    validateTriggerLambdaLocality(props.preTokenGeneration, poolStack);
    userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, props.preTokenGeneration);
  }

  if (props.postConfirmation !== undefined) {
    validateTriggerLambdaLocality(props.postConfirmation, poolStack);
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, props.postConfirmation);
  }
}
