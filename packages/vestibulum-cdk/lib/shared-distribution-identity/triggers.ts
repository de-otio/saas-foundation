/**
 * Shared-distribution trigger Lambdas + Function URLs.
 *
 * Provisions five Cognito-trigger Lambdas (PreSignUp, CreateAuthChallenge,
 * PreTokenGeneration, DefineAuthChallenge, VerifyAuthChallengeResponse)
 * plus two Function URL Lambdas (`auth-verify` and `auth-signout`).
 *
 * Bundle paths point to `lambda-bundles/<name>`, which P3 populates via
 * the bundle pipeline. Bundle bytes are not required to exist at synth
 * time — `Code.fromAsset` only asserts existence at `cdk synth` time,
 * so we materialize a stub directory if none is present (handled by the
 * build-bundles pipeline; out of scope for this construct).
 *
 * Per [06-trigger-handlers.md]:
 * - Each trigger Lambda receives `VESTIBULUM_CLIENT_CONFIG_TABLE` in
 *   its environment and `grantReadData` on the table.
 * - `auth-verify` / `auth-signout` additionally receive
 *   `VESTIBULUM_TENANT_PARENT` so they can extract the tenant
 *   subdomain from the `Host` header.
 * - `auth-verify` needs `cognito-idp:InitiateAuth`,
 *   `RespondToAuthChallenge`, and `GetTokensFromRefreshToken` on the
 *   user pool (added by the parent construct after pool creation).
 * - Function URLs use `AuthType: NONE` — they're publicly reachable
 *   (the handlers themselves reject direct `.on.aws` invocations by
 *   checking the Host header against `TENANT_PARENT`).
 *
 * NodejsFunction is intentionally avoided here in favour of
 * `lambda.Function + Code.fromAsset` (matching the single-tenant
 * `MagicLinkIdentity` pattern). The bundle pipeline produces a
 * deterministic asset on disk; synth-time esbuild would defeat
 * reproducibility.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Duration, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { RuntimeEnv } from "../_internal/runtime-env.js";
import type { ClientConfigTable } from "./client-config-table.js";

// ---------------------------------------------------------------------------
// Bundle-path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the absolute filesystem path of a bundle directory for use
 * with `lambda.Code.fromAsset(...)`.
 *
 * Walks from `lib/shared-distribution-identity/` (or `dist/...`) up to
 * the package root, then into `lambda-bundles/<bundleName>`.
 *
 * The directory is expected to exist at synth time. P3 produces it via
 * the bundle pipeline; CDK consumers running synth before bundles are
 * built get a clear "asset path does not exist" error from CDK.
 */
function resolveSharedBundlePath(bundleName: string): string {
  const packageRoot = path.resolve(__dirname, "..", "..");
  return path.join(packageRoot, "lambda-bundles", bundleName);
}

// ---------------------------------------------------------------------------
// Props + result shape
// ---------------------------------------------------------------------------

export interface TriggersProps {
  /**
   * The `ClientConfig` table the triggers read for per-tenant config.
   */
  readonly clientConfigTable: ClientConfigTable;

  /**
   * Parent subdomain — baked into `auth-verify` and `auth-signout`
   * env so they can extract the leftmost label from the `Host` header.
   */
  readonly tenantSubdomainParent: string;

  /**
   * SES sender address. Baked into `CreateAuthChallenge` env.
   */
  readonly sesIdentitySender: string;
}

/**
 * Result of provisioning the trigger Lambdas. Exposed so the parent
 * construct can wire them into the user pool, grant table access, and
 * surface them for `cdk-nag` suppressions.
 */
export interface TriggersResult {
  readonly preSignUp: lambda.Function;
  readonly createAuthChallenge: lambda.Function;
  readonly preTokenGeneration: lambda.Function;
  readonly defineAuthChallenge: lambda.Function;
  readonly verifyAuthChallengeResponse: lambda.Function;
  readonly authVerify: lambda.Function;
  readonly authSignout: lambda.Function;
  readonly authVerifyFunctionUrl: lambda.FunctionUrl;
  readonly authSignoutFunctionUrl: lambda.FunctionUrl;
}

// ---------------------------------------------------------------------------
// The provisioning helper
// ---------------------------------------------------------------------------

export class SharedDistributionTriggers extends Construct {
  readonly preSignUp: lambda.Function;
  readonly createAuthChallenge: lambda.Function;
  readonly preTokenGeneration: lambda.Function;
  readonly defineAuthChallenge: lambda.Function;
  readonly verifyAuthChallengeResponse: lambda.Function;
  readonly authVerify: lambda.Function;
  readonly authSignout: lambda.Function;
  readonly authVerifyFunctionUrl: lambda.FunctionUrl;
  readonly authSignoutFunctionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: TriggersProps) {
    super(scope, id);

    const region = Stack.of(this).region;

    // Common env injected into every shared-distribution trigger.
    const commonEnv: Record<string, string> = {
      [RuntimeEnv.CLIENT_CONFIG_TABLE]: props.clientConfigTable.table.tableName,
    };

    const commonLambdaProps: Omit<lambda.FunctionProps, "code" | "handler"> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      logRetention: logs.RetentionDays.ONE_MONTH,
      reservedConcurrentExecutions: 10,
      timeout: Duration.seconds(10),
      environment: { ...commonEnv },
    };

    this.preSignUp = new lambda.Function(this, "PreSignUpFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveSharedBundlePath("pre-signup")),
      handler: "index.handler",
    });

    this.createAuthChallenge = new lambda.Function(
      this,
      "CreateAuthChallengeFn",
      {
        ...commonLambdaProps,
        code: lambda.Code.fromAsset(
          resolveSharedBundlePath("create-auth"),
        ),
        handler: "index.handler",
        environment: {
          ...commonEnv,
          [RuntimeEnv.SES_FROM]: props.sesIdentitySender,
          [RuntimeEnv.SES_REGION]: region,
        },
      },
    );

    this.preTokenGeneration = new lambda.Function(
      this,
      "PreTokenGenerationFn",
      {
        ...commonLambdaProps,
        code: lambda.Code.fromAsset(
          resolveSharedBundlePath("pre-token-generation"),
        ),
        handler: "index.handler",
      },
    );

    // DefineAuthChallenge / VerifyAuthChallengeResponse: don't read
    // ClientConfig themselves (per [06-trigger-handlers.md] — unchanged
    // from single-tenant). We still bake the env in for symmetry; the
    // handlers ignore it.
    this.defineAuthChallenge = new lambda.Function(this, "DefineAuthFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveSharedBundlePath("define-auth")),
      handler: "index.handler",
    });

    this.verifyAuthChallengeResponse = new lambda.Function(
      this,
      "VerifyAuthChallengeResponseFn",
      {
        ...commonLambdaProps,
        code: lambda.Code.fromAsset(resolveSharedBundlePath("verify-auth")),
        handler: "index.handler",
      },
    );

    // auth-verify / auth-signout: Function URL Lambdas. Need TENANT_PARENT.
    //
    // These use the multi-tenant `shared-auth-*` bundles (Host-discriminated,
    // per-tenant ClientConfig from DynamoDB) — NOT the single-tenant
    // `auth-verify`/`auth-signout` bundles (fixed COGNITO_CLIENT_ID). 256 MB
    // gives headroom for the Cognito call cascade (matches the single-tenant
    // MagicLinkAuthSite auth Lambdas).
    this.authVerify = new lambda.Function(this, "AuthVerifyFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveSharedBundlePath("shared-auth-verify")),
      handler: "index.handler",
      memorySize: 256,
      environment: {
        ...commonEnv,
        [RuntimeEnv.TENANT_PARENT]: props.tenantSubdomainParent,
      },
    });

    this.authSignout = new lambda.Function(this, "AuthSignoutFn", {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(resolveSharedBundlePath("shared-auth-signout")),
      handler: "index.handler",
      memorySize: 256,
      environment: {
        ...commonEnv,
        [RuntimeEnv.TENANT_PARENT]: props.tenantSubdomainParent,
      },
    });

    // Function URLs are AuthType.NONE — the handlers themselves
    // discriminate by Host header (rejecting `.on.aws` direct
    // invocations). See [06-trigger-handlers.md] § Critical constraint.
    this.authVerifyFunctionUrl = this.authVerify.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      // CORS empty — these URLs are consumed by CloudFront, not
      // browsers cross-origin.
      cors: { allowedOrigins: [] },
    });

    this.authSignoutFunctionUrl = this.authSignout.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: { allowedOrigins: [] },
    });

    // Grant read on ClientConfig (table + GSIs) to the handlers that
    // need it. DefineAuth + VerifyAuth don't read it, but granting is
    // cheap and keeps the IAM model uniform.
    props.clientConfigTable.grantRead(this.preSignUp);
    props.clientConfigTable.grantRead(this.createAuthChallenge);
    props.clientConfigTable.grantRead(this.preTokenGeneration);
    props.clientConfigTable.grantRead(this.authVerify);
    props.clientConfigTable.grantRead(this.authSignout);
  }

  /**
   * Wire all five Cognito triggers onto the supplied user pool. Called
   * from the parent `SharedDistributionIdentity` construct.
   *
   * `auth-verify` is NOT a Cognito trigger; it's wired separately via
   * its Function URL (CloudFront, in P2b).
   *
   * `opts.includeBuiltInPreTokenGeneration: false` skips wiring the
   * built-in PreTokenGeneration Lambda — used when the consumer
   * provides their own via `SharedDistributionIdentityProps.preTokenGeneration`.
   * Cognito refuses to register two triggers for the same operation,
   * so the constructor must choose at wiring time.
   */
  attachToUserPool(
    userPool: cognito.UserPool,
    opts: { includeBuiltInPreTokenGeneration?: boolean } = {},
  ): void {
    const includeBuiltInPtg = opts.includeBuiltInPreTokenGeneration ?? true;

    userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      this.preSignUp,
    );
    userPool.addTrigger(
      cognito.UserPoolOperation.CREATE_AUTH_CHALLENGE,
      this.createAuthChallenge,
    );
    if (includeBuiltInPtg) {
      userPool.addTrigger(
        cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
        this.preTokenGeneration,
      );
    }
    userPool.addTrigger(
      cognito.UserPoolOperation.DEFINE_AUTH_CHALLENGE,
      this.defineAuthChallenge,
    );
    userPool.addTrigger(
      cognito.UserPoolOperation.VERIFY_AUTH_CHALLENGE_RESPONSE,
      this.verifyAuthChallengeResponse,
    );
  }

  /**
   * Grant the `auth-verify` Lambda the Cognito IAM actions it needs
   * to do `RespondToAuthChallenge` (magic-link redemption path) and
   * `GetTokensFromRefreshToken` (refresh path).
   *
   * Scoped to the supplied user pool ARN; `*` resources are not used.
   */
  grantAuthVerifyCognito(userPoolArn: string): void {
    this.authVerify.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:RespondToAuthChallenge",
          "cognito-idp:InitiateAuth",
          // Note: GetTokensFromRefreshToken doesn't currently have a
          // dedicated IAM action; the API is gated by
          // cognito-idp:InitiateAuth in some SDK versions. We grant the
          // broader RespondToAuthChallenge + InitiateAuth set scoped to
          // the pool ARN; refine if AWS publishes a dedicated action.
        ],
        resources: [userPoolArn],
      }),
    );
  }
}
