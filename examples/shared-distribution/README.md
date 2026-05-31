# `examples/shared-distribution`

End-to-end example of `SharedDistributionIdentity` — the multi-tenant
shared-pool topology from `@de-otio/vestibulum-cdk`.

The example synthesises a single CDK stack that provisions one
CloudFront distribution, one Cognito user pool, three DynamoDB
tables, the trigger Lambdas, the edge `check-auth` function, and the
admin Function URL. **Tenants are data, not deploy** — they are
created post-deploy by invoking the admin Function URL with SigV4.

## Overview

```
   internet ──► CloudFront (one) ──► S3 / Function URLs ──► Cognito (one pool)
                  │                                            ▲
                  └── Lambda@Edge check-auth                   │
                      verifies Host ↔ custom:tenant_id        │
                                                              │
   operator ──SigV4──► admin Function URL ──► CreateUserPoolClient
                                              + ClientConfig row
```

What's deployed once vs. what's per-tenant is summarised in
[`doc/vestibulum/shared-distribution/01-architecture.md`][arch].

## Prerequisites

Before `cdk deploy` will succeed against a real account:

1. **Route 53 hosted zone** for the parent domain (in this example,
   `tenants.example.com` — replace with a zone you control).
2. **Wildcard ACM certificate** for `*.<parent>` in **us-east-1**
   (CloudFront requirement). Two paths:
   - Easiest: edit `lib/example-stack.ts` to pass
     `hostedZone: route53.HostedZone.fromLookup(...)` and add
     `crossRegionReferences: true` to the stack props. CDK provisions
     the cert in a us-east-1 sibling stack.
   - Alternative: produce the cert via a separate us-east-1 stack and
     paste its ARN into `PLACEHOLDER_WILDCARD_CERT_ARN`.
3. **SES verified sender identity** matching `SES_IDENTITY_SENDER`
   in `lib/example-stack.ts`. SES must be out of sandbox for the
   sender domain, or all recipient addresses must be SES-verified.
4. **IAM principal** to invoke the admin Function URL — replace the
   placeholder `example-tenant-admin-role` with the ARN of a real
   role (CI deploy role, EventBridge rule role, etc.).
5. **AWS CDK toolkit bootstrapped** in the deploy region AND
   us-east-1.

## Configuration

The example uses IETF-reserved test domains throughout
(`example.com`, RFC 2606). Edit `lib/example-stack.ts` to point at
your real parent domain, sender, and admin principal before deploy.

The constants at the top of `lib/example-stack.ts`:

```ts
const TENANT_SUBDOMAIN_PARENT = "tenants.example.com";
const SES_IDENTITY_SENDER = "no-reply@example.com";
const PLACEHOLDER_WILDCARD_CERT_ARN = "arn:aws:acm:us-east-1:...";
```

The synthesised stack name is `SharedDistributionExample`.

## Synth

`cdk synth` runs cleanly without an AWS account — it uses the
placeholder cert ARN baked into the example. CI runs this on every
PR to gate on construct-API regressions.

```bash
cd examples/shared-distribution
npm install
npx cdk synth
```

The synth output lists the resources the construct provisions: a
CloudFront distribution, the Cognito user pool with its triggers,
three DynamoDB tables (`ClientConfig`, `MagicLinkTokens`,
`Reservations`), the admin Lambda + Function URL, the reconciler
Lambda + hourly EventBridge schedule, the Lambda@Edge `check-auth`
function, and the supporting WAF web ACLs.

## Deploy

```bash
cd examples/shared-distribution
npm install

# Bootstrap once per account/region (and again for us-east-1 if you
# use the cross-region cert path).
npx cdk bootstrap aws://ACCOUNT/REGION
npx cdk bootstrap aws://ACCOUNT/us-east-1

# Deploy the example stack.
npx cdk deploy SharedDistributionExample
```

The deploy emits four exports:

| Export                | What it is                                        |
| --------------------- | ------------------------------------------------- |
| `AdminLambdaName`     | Admin Lambda function name (for `aws lambda invoke`) |
| `AdminFunctionUrl`    | Admin Function URL (HTTPS endpoint, SigV4 IAM auth)  |
| `DistributionDomain`  | CloudFront distribution domain name                  |
| `WildcardCertArn`     | The wildcard ACM cert ARN in use                     |

Wire `*.<parent>` to `DistributionDomain` with a wildcard `A`-alias
record in Route 53 if you did not pass `hostedZone` to the construct.

## Onboard a tenant (bash, SigV4)

The admin Function URL accepts JSON POSTs signed with SigV4. The
simplest CLI flow uses `awscurl`:

```bash
export ADMIN_FUNCTION_URL=$(aws cloudformation describe-stacks \
  --stack-name SharedDistributionExample \
  --query "Stacks[0].Outputs[?ExportName=='AdminFunctionUrl'].OutputValue" \
  --output text)

awscurl --service lambda \
  -X POST "$ADMIN_FUNCTION_URL" \
  --data '{
    "action": "createTenant",
    "subdomain": "acme",
    "tenantId": "acme",
    "allowedEmailDomains": ["acme.example"],
    "idempotencyKey": "01J1FZ7H8K9MX5N7QABCDEF123"
  }'
```

The response includes the new `clientId`, `siteBaseUrl`
(`https://acme.tenants.example.com`), and `createdAt`. The tenant
is live the moment the response returns — no edge propagation, no
DNS provisioning. The full request schema is documented in
[`doc/vestibulum/shared-distribution/03-tenant-onboarding.md`][onboard].

Reused `idempotencyKey` returns the original response without
re-creating resources. If the same key is reused with a different
`subdomain` or `tenantId`, the call fails with a 409.

You can also invoke the Lambda directly (no HTTP):

```bash
export ADMIN_LAMBDA=$(aws cloudformation describe-stacks \
  --stack-name SharedDistributionExample \
  --query "Stacks[0].Outputs[?ExportName=='AdminLambdaName'].OutputValue" \
  --output text)

aws lambda invoke \
  --function-name "$ADMIN_LAMBDA" \
  --payload '{
    "action": "createTenant",
    "subdomain": "acme",
    "tenantId": "acme",
    "allowedEmailDomains": ["acme.example"],
    "idempotencyKey": "01J1FZ7H8K9MX5N7QABCDEF123"
  }' \
  --cli-binary-format raw-in-base64-out \
  /tmp/onboard.json && cat /tmp/onboard.json
```

## Onboard a tenant (Node.js, SigV4)

From consumer code (e.g. a self-service portal's backend):

```ts
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const adminFunctionUrl = process.env.ADMIN_FUNCTION_URL!;
const region = process.env.AWS_REGION ?? "eu-central-1";

const url = new URL(adminFunctionUrl);
const body = JSON.stringify({
  action: "createTenant",
  subdomain: "acme",
  tenantId: "acme",
  allowedEmailDomains: ["acme.example"],
  idempotencyKey: crypto.randomUUID(),
});

const signer = new SignatureV4({
  service: "lambda",
  region,
  credentials: defaultProvider(),
  sha256: Sha256,
});

const signed = await signer.sign(
  new HttpRequest({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      host: url.hostname,
      "content-type": "application/json",
    },
    body,
  }),
);

const resp = await fetch(adminFunctionUrl, {
  method: "POST",
  headers: signed.headers,
  body,
});
const result = await resp.json();
console.log(result);
```

## Remove a tenant

```bash
awscurl --service lambda \
  -X POST "$ADMIN_FUNCTION_URL" \
  --data '{
    "action": "deleteTenant",
    "tenantId": "acme",
    "revokeActiveSessions": true
  }'
```

`revokeActiveSessions: true` calls `AdminUserGlobalSignOut` for every
user whose last authentication was on this tenant's app client, closing
the post-deletion token-validity window. Omit (or set `false`) for
low-risk deletions; tokens issued before deletion remain valid until
they expire (default 60 min).

What `deleteTenant` does NOT clean up: pool users (one user can have
authenticated against multiple tenants), magic-link tokens (TTL-expire
on their own), and the wildcard DNS entry (still resolves; the edge
rejects requests with no `ClientConfig` match). See
[`03-tenant-onboarding.md`][onboard] § What `deleteTenant` does NOT
clean up.

## Update a tenant

Only `allowedEmailDomains` is mutable. `tenantId` and `subdomain` are
immutable post-creation; renames are a delete + recreate flow.

```bash
awscurl --service lambda \
  -X POST "$ADMIN_FUNCTION_URL" \
  --data '{
    "action": "updateTenant",
    "tenantId": "acme",
    "allowedEmailDomains": ["acme.example", "acme.test"]
  }'
```

## Cleanup

```bash
# Optional: delete every tenant first (each deleteTenant is 2 SDK calls).
# Cognito user pool deletion does NOT cascade to clients in this scenario
# because the pool has RemovalPolicy.RETAIN by default — see the
# construct's `userPoolRemovalPolicy` prop.

npx cdk destroy SharedDistributionExample
```

Per-tenant data left after `cdk destroy`:

- The Cognito user pool (RETAIN by default — user data lives there).
- The `MagicLinkTokens` table (RETAIN; PITR'd).
- The wildcard ACM cert (if imported; CDK does not touch external
  resources).

Drop the retention policies in the construct for ephemeral
environments by passing `userPoolRemovalPolicy: RemovalPolicy.DESTROY`
in `lib/example-stack.ts`.

## Where to look next

- [`doc/vestibulum/shared-distribution/01-architecture.md`][arch] —
  topology overview.
- [`doc/vestibulum/shared-distribution/02-construct-api.md`][api] —
  the full construct prop surface.
- [`doc/vestibulum/shared-distribution/03-tenant-onboarding.md`][onboard]
  — admin Function URL contract, request schemas, error codes.
- [`doc/vestibulum/shared-distribution/07-security-and-isolation.md`][sec]
  — what's enforced where, blast-radius reasoning.

[arch]: ../../doc/vestibulum/shared-distribution/01-architecture.md
[api]: ../../doc/vestibulum/shared-distribution/02-construct-api.md
[onboard]: ../../doc/vestibulum/shared-distribution/03-tenant-onboarding.md
[sec]: ../../doc/vestibulum/shared-distribution/07-security-and-isolation.md
