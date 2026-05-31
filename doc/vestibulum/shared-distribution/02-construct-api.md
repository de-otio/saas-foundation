# 02 — Construct API

## Decision: sibling construct

`SharedDistributionIdentity` is a sibling of `MagicLinkIdentity`, not
a mode prop on it. Reasons:

- **Prop matrix would be unmanageable.** `MagicLinkIdentity` has
  ~25 props today; shared-distribution needs a different ~12, with
  most of the single-tenant props (single `siteBaseUrl`, single
  `domain`) no longer applicable. A `mode: 'single' | 'shared'`
  prop forces consumers (and reviewers) to read both surfaces every
  time to know which props are valid.
- **`MagicLinkAuthSite` doesn't exist in shared-distribution.**
  Forcing `MagicLinkIdentity` to either expose or hide AuthSite
  registration based on a mode prop is exactly the API design
  smell that the prop matrix represents.
- **Both constructs live in v0.2+.** Single-tenant `MagicLinkIdentity`
  is already a v0.1 surface; making it depend on a future mode prop
  reshape is unnecessary churn.

The price of two constructs is mostly internal — both share the
Cognito pool wiring, the trigger handlers, and the SES/bounce
machinery via internal helpers. Public-surface duplication is small.

## Surface

```typescript
import {
  type aws_cognito as cognito,
  type aws_certificatemanager as acm,
  type aws_route53 as route53,
  type aws_dynamodb as dynamodb,
  type aws_lambda as lambda,
  type CfnElement,
  Duration,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

export interface SharedDistributionIdentityProps {
  /**
   * Parent subdomain that all tenants share. Tenants are onboarded
   * onto leftmost-label subdomains under this — e.g. with
   * `tenants.example.com`, tenant `acme` lands at
   * `acme.tenants.example.com`.
   *
   * Single-level wildcard only (no `eu.tenants.example.com`-style
   * two-level tenant slugs). See `05-wildcard-infra.md`.
   */
  readonly tenantSubdomainParent: string;

  /**
   * SES verified identity used as the magic-link sender. Same
   * semantics as `MagicLinkIdentity.sesIdentitySender`.
   */
  readonly sesIdentitySender: string;

  /**
   * Route 53 hosted zone for the parent domain. If provided, the
   * construct creates the wildcard A-alias record and an ACM
   * cert with DNS validation. If omitted, the consumer is
   * responsible for the wildcard DNS record and provides the
   * cert via `existingWildcardCertificateArn`.
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * ARN of an existing ACM wildcard cert in us-east-1 covering
   * `*.<tenantSubdomainParent>`. Required if `hostedZone` is not
   * provided. Mutually exclusive with `hostedZone`.
   */
  readonly existingWildcardCertificateArn?: string;

  /**
   * Subdomain labels that may not be used as tenant identifiers.
   * Defaults to `['www', 'admin', 'api', 'cdn', 'static', 'auth',
   *  'mail', 'ftp', 'localhost']`. Validation lives in the admin
   * Lambda; this list is the synth-time default.
   */
  readonly reservedSubdomains?: readonly string[];

  /**
   * Regex (anchored) that tenant subdomain labels must match.
   * Defaults to `^[a-z][a-z0-9-]{1,62}[a-z0-9]$` (DNS-label-shaped,
   * non-numeric prefix, no trailing dash).
   */
  readonly tenantSubdomainPattern?: RegExp;

  /**
   * Magic-link cookie TTL. Default: 30 days.
   */
  readonly sessionCookieTtl?: Duration;

  /**
   * IAM principal allowed to invoke the admin Lambda Function URL.
   * Must be set explicitly — there is no default. Pass the
   * consumer's deployment role / CLI principal / EventBridge rule.
   *
   * Starting October 2025, AWS Function URLs require both
   * `lambda:InvokeFunctionUrl` AND `lambda:InvokeFunction`
   * permissions; the construct grants both to this principal.
   * Cross-account principals additionally require their own
   * identity-based policy granting these permissions.
   */
  readonly adminInvokePrincipal: iam.IPrincipal;

  /**
   * KMS key for `ClientConfig` and `MagicLinkTokens` DDB tables.
   * If unset, tables use AWS-managed encryption (DDB-owned KMS key,
   * visible in the KMS console). Pass a customer-managed key for
   * compliance frameworks requiring key visibility.
   *
   * Default: AWS_MANAGED (not AWS_OWNED).
   */
  readonly tableKmsKey?: kms.IKey;

  /**
   * WAF web ACL associated with the CloudFront distribution. If
   * unset, the construct creates a default ACL with: per-IP rate
   * limit (1000 req / 5 min), `AWSManagedRulesCommonRuleSet`, and
   * `AWSManagedRulesKnownBadInputsRuleSet`. See
   * `07-security-and-isolation.md` § WAF.
   */
  readonly cloudFrontWebAclArn?: string;

  /**
   * WAF web ACL associated with the Cognito user pool. If unset,
   * the construct creates a default ACL with a per-IP rate-limit
   * rule on `InitiateAuth` and `SignUp` to defend against direct
   * Cognito API abuse (bypassing CloudFront).
   */
  readonly cognitoPoolWebAclArn?: string;

  /**
   * CloudFront Response Headers Policy. If unset, the construct
   * applies a hardened default: HSTS with preload, CSP, X-Content-
   * Type-Options, Referrer-Policy, X-Frame-Options DENY,
   * Permissions-Policy default-disabled. See
   * `04-multi-aud-edge-check.md` § Security headers.
   */
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

  /**
   * Edge `check-auth` JWKS cache TTL. Default 15 min — matches AWS's
   * standard JWKS posture. Reduce for environments where the 15-min
   * stale-key window is unacceptable (at the cost of more JWKS
   * fetches from edge containers). Minimum 1 min.
   */
  readonly jwksTtl?: Duration;

  /**
   * Default ID token validity. Default 60 min. Reduce for
   * environments where `deleteTenant`'s post-deletion token-validity
   * window must be shorter. Minimum 5 min (Cognito floor).
   */
  readonly idTokenValidity?: Duration;

  // ...remaining props identical to MagicLinkIdentity for things
  // like KMS keys, removal policies, logging, observability...
}

export class SharedDistributionIdentity extends Construct {
  /** The shared Cognito user pool. */
  readonly userPool: cognito.IUserPool;

  /** The ClientConfig DDB table. Public so consumers can read it. */
  readonly clientConfigTable: dynamodb.ITable;

  /** The admin Lambda Function URL. IAM-auth'd. */
  readonly adminFunctionUrl: string;

  /**
   * Lambda@Edge log groups (one per active CloudFront PoP region).
   * Public so consumers can subscribe them to a central log
   * destination (Kinesis Firehose, OpenSearch, third-party).
   * See `08-observability-and-audit.md` § Edge logging.
   */
  readonly edgeLogGroups: logs.ILogGroup[];

  /** The admin Lambda function name (for SDK invocation). */
  readonly adminLambdaName: string;

  /** The wildcard ACM cert ARN (whether created or passed in). */
  readonly wildcardCertificateArn: string;

  /** The CloudFront distribution. Exposed for tagging / metrics wiring. */
  readonly distribution: cloudfront.IDistribution;

  /**
   * Grant the Lambda IAM read access to the ClientConfig table and
   * inject `VESTIBULUM_CLIENT_CONFIG_TABLE` into its environment.
   *
   * The same helper from the prototype's Change 1 — see
   * `06-trigger-handlers.md`. Used to wire consumer-side
   * PreTokenGeneration replacements (rare; the construct's built-in
   * `PreTokenGeneration` already does this).
   */
  grantReadClientConfig(fn: lambda.Function): void;

  /**
   * Add an additional Cognito Lambda trigger (e.g. a custom
   * PostConfirmation). Same shape as `MagicLinkIdentity` for parity.
   */
  preTokenGeneration(fn: lambda.IFunction): void;
  postConfirmation(fn: lambda.IFunction): void;
  // ...etc for the standard trigger surface.
}
```

## `MagicLinkAuthSite` in shared-distribution mode

**Not used.** A tenant doesn't get a `MagicLinkAuthSite` — it gets a
row in `ClientConfig` and an app client created by the admin Lambda.

If a consumer needs a dedicated CloudFront + edge for one tenant
(hard isolation), they instantiate a standalone `MagicLinkIdentity`
+ `MagicLinkAuthSite` *in addition to* the
`SharedDistributionIdentity` — but that tenant's auth flow is on a
different identity entirely, not on the shared one. See
[`07-security-and-isolation.md`](07-security-and-isolation.md) §
hard-isolation escape hatch.

## What the consumer must wire themselves

The construct ships everything but the **admin invocation surface**.
The admin Lambda's Function URL is IAM-protected; the consumer chooses
how to call it:

- **CLI invocation** by an operator with the deployment role —
  works out of the box.
- **EventBridge rule** triggered by an external onboarding workflow
  (e.g. Stripe webhook → EventBridge → admin Lambda).
- **Self-service portal**: the consumer's web app calls
  `signer.fetch(adminFunctionUrl, ...)` with SigV4. The portal
  itself is the consumer's code; vestibulum-cdk doesn't ship one.

The construct grants the configured `adminInvokePrincipal`
`lambda:InvokeFunctionUrl` on the admin Lambda's Function URL. Other
principals get IAM-rejected at the URL.

## `PreTokenGeneration` is built in

In the prototype's Change 2, the consumer wired their own
`PreTokenGeneration` Lambda to read `ClientConfig` and inject
`custom:tenant_id`. In shared-distribution mode, this is
load-bearing for the edge check — there is no graceful degradation
if a token lacks `custom:tenant_id`. So the construct ships
`PreTokenGeneration` as built-in trigger code (factory in
`@de-otio/vestibulum`), not consumer-wired:

```typescript
// Inside SharedDistributionIdentity, internal:
const preTokenGen = new NodejsLambda(this, 'PreTokenGen', {
  entry: '...lambda-bundles/pre-token-generation/...',
  environment: {
    VESTIBULUM_CLIENT_CONFIG_TABLE: this.clientConfigTable.tableName,
  },
});
this.clientConfigTable.grantReadData(preTokenGen);
userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, preTokenGen);
```

A consumer who needs to extend the claim-injection logic (e.g. add
custom claims beyond `custom:tenant_id`) replaces the trigger
entirely using the `wrapPreTokenHandler` helper at
`packages/vestibulum/src/lambda/shared-distribution/shared/wrap-pre-token-handler.ts`
(there is no `@de-otio/vestibulum/lambda/shared` subpath export —
the package declares a single `"."` export, so the bundled handler
imports the helper via its relative module path). The wrapper
pre-injects `custom:tenant_id` from the `ClientConfigRow` and
asserts the consumer's handler didn't overwrite or suppress it. See
[`06-trigger-handlers.md`](06-trigger-handlers.md) §
PreTokenGeneration customisation.

```typescript
// Consumer's PreTokenGen Lambda source (bundled by vestibulum-cdk):
import { wrapPreTokenHandler } from '../shared/wrap-pre-token-handler.js';

export const handler = wrapPreTokenHandler(async (event, ctx) => {
  event.response.claimsOverrideDetails.claimsToAddOrOverride['custom:role']
    = lookupRoleFromMyDb(event.userName);
  return event;
});
```

```typescript
// Consumer's CDK code wiring it up:
const customPreTokenGen = new lambda.Function(this, 'CustomPreTokenGen', { ... });
identity.grantReadClientConfig(customPreTokenGen);
identity.preTokenGeneration(customPreTokenGen);
```

No Lambda-to-Lambda invoke at runtime; the wrapper runs in the
consumer's single Lambda. `custom:tenant_id` is contract-enforced.

## Decision: prop overlap with `MagicLinkIdentity`

`SharedDistributionIdentity` and `MagicLinkIdentity` share several
prop names with **identical semantics** (`sesIdentitySender`,
`sessionCookieTtl`, KMS keys, etc.). The chosen approach is to
**duplicate the prop interface verbatim**, with a shared internal
`BaseIdentityProps` type both constructs extend:

```typescript
// Internal — not exported from the public package surface.
interface BaseIdentityProps {
  readonly sesIdentitySender: string;
  readonly sessionCookieTtl?: Duration;
  readonly kmsKey?: kms.IKey;
  // ...other shared shape...
}

// Public — what consumers see.
export interface MagicLinkIdentityProps extends BaseIdentityProps {
  readonly siteBaseUrl: string;
  // ...single-tenant-only props...
}

export interface SharedDistributionIdentityProps extends BaseIdentityProps {
  readonly tenantSubdomainParent: string;
  // ...multi-tenant-only props...
}
```

Rejected alternatives:

- **`SharedDistributionIdentityProps extends MagicLinkIdentityProps`** —
  bleeds `siteBaseUrl` and other single-tenant props into the
  multi-tenant surface; consumers see invalid options.
- **Common props as a freestanding `MagicLinkSharedConfig` sub-field** —
  awkward consumer API (`new ...({ shared: { ses: ..., kms: ... }, ...})`).

Trade: internal refactor cost on every addition to `BaseIdentityProps`
is borne by us, not consumers. Stable public surface beats internal
ergonomics.
