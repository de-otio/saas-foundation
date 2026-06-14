# 01 — Architecture

## Topology

```
                           Internet
                              │
            ┌─────────────────▼─────────────────┐
            │     CloudFront distribution       │
            │   (one, EU-resident origins)      │
            │                                   │
            │   alternate names:                │
            │     *.tenants.example.com         │
            │                                   │
            │   viewer cert:                    │
            │     ACM *.tenants.example.com     │
            │     (us-east-1)                   │
            │                                   │
            │   ┌─────────────────────────────┐ │
            │   │  Lambda@Edge: check-auth    │ │
            │   │  - parses Host header       │ │
            │   │  - verifies JWT (iss/sig)   │ │
            │   │  - asserts custom:tenant_id │ │
            │   │    matches Host's subdomain │ │
            │   └─────────────────────────────┘ │
            └─────────┬───────────────────┬─────┘
                      │                   │
        ┌─────────────▼──────┐   ┌────────▼──────────┐
        │   S3 login pages   │   │  Function URLs    │
        │   (static, shared) │   │  - auth-verify    │
        └────────────────────┘   │  - auth-signout   │
                                 │  (Host-aware)     │
                                 └────────┬──────────┘
                                          │
                  ┌───────────────────────┴──────────────────────┐
                  │                                              │
        ┌─────────▼────────────┐                    ┌────────────▼────────────┐
        │  Cognito user pool   │                    │   DDB: ClientConfig     │
        │  (shared)            │                    │   PK: clientId          │
        │                      │                    │   ─ siteBaseUrl         │
        │  trigger Lambdas:    │                    │   ─ allowedEmailDomains │
        │  ─ PreSignUp         │◄───────────────────┤   ─ tenantId            │
        │  ─ CreateAuthChall   │   read on cold     │                         │
        │  ─ VerifyAuthChall   │   start + TTL      └─────────────────────────┘
        │  ─ DefineAuthChall   │                                ▲
        │  ─ PreTokenGen (new) │                                │ writes
        │                      │                                │
        │  app clients:        │                    ┌───────────┴──────────────┐
        │  ─ tenant-a (data)   │                    │  Admin Lambda            │
        │  ─ tenant-b (data)   │◄───────────────────┤  Function URL (AWS_IAM)  │
        │  ─ tenant-c (data)   │   CreateUserPool   │  ─ POST   /tenants       │
        │  ─ ...               │   Client (SDK)     │  ─ DELETE /tenants/{id}  │
        └──────────────────────┘                    │  ─ PUT    /tenants/{id}  │
                                                    └──────────────────────────┘

        ┌──────────────────┐
        │  DDB: MagicLink  │  ┌───────────────────────┐
        │  Tokens          │  │  SES + bounce-handler │
        │  (per-token)     │  │  (shared)             │
        └──────────────────┘  └───────────────────────┘
```

The user-facing surface is one CloudFront distribution; tenants are
distinguished by subdomain at the edge (`tenant-a.tenants.example.com`
vs. `tenant-b.tenants.example.com`), validated against the JWT's
`custom:tenant_id` claim.

The administrative surface is the admin Lambda's Function URL, called
by the consumer's tenant-management code (or a human operator) with
SigV4 IAM auth.

## What's deployed once, what's data per tenant

| Resource                                    | Once per identity | Per tenant |
| ------------------------------------------- | :---------------: | :--------: |
| CloudFront distribution                     |         ✓         |            |
| ACM wildcard cert (us-east-1)               |         ✓         |            |
| Route 53 wildcard A-alias                   |         ✓         |            |
| Lambda@Edge `check-auth`                    |         ✓         |            |
| S3 login pages bucket (optional)            |         ✓         |            |
| Function URL: `auth-verify` (Host-aware)    |         ✓         |            |
| Function URL: `auth-signout` (Host-aware)   |         ✓         |            |
| Cognito user pool                           |         ✓         |            |
| Trigger Lambdas (5)                         |         ✓         |            |
| `ClientConfig` DDB table                    |         ✓         |            |
| `MagicLinkTokens` DDB table                 |         ✓         |            |
| SES identity + bounce handler               |         ✓         |            |
| Admin Lambda + Function URL                 |         ✓         |            |
| Cognito app client                          |                   |     ✓      |
| `ClientConfig` row                          |                   |     ✓      |

Onboarding a tenant: two AWS SDK calls (`CreateUserPoolClient` +
`PutItem`). Both performed by the admin Lambda from a single
authenticated request. No CFN events, no edge propagation wait, no
DNS provisioning.

## Single-tenant identification: how the edge knows the tenant

Two redundant signals, both checked at the edge:

1. **`Host` header.** The browser carries the subdomain the user is
   visiting (`acme.tenants.example.com`). The edge parses the
   leftmost label as the tenant identifier.
2. **`custom:tenant_id` claim** in the JWT, injected by
   `PreTokenGeneration` from `ClientConfig[event.callerContext.clientId].tenantId`.

The edge rejects the request unless **both** signals are present and
**equal**. A token issued for tenant `acme` presented at
`bob.tenants.example.com` fails. A token presented at
`acme.tenants.example.com` with no `custom:tenant_id` fails. See
[`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) for the
full check sequence.

The `aud` claim is **not** matched against an allowlist at the edge.
The issuer (`iss`) check is sufficient to prove the token came from
*our* pool; any `aud` value Cognito issued on that pool is by
construction one of our app clients. The structural binding is
`Host` ↔ `custom:tenant_id`, not `Host` ↔ `aud`. This avoids needing
the edge function to know about every tenant — onboarding a new
tenant does not require re-deploying the edge function.

## Comparison with N-CloudFront (the prototype)

|                              | N-CloudFront (prototype)              | Shared-distribution (this design)            |
| ---------------------------- | ------------------------------------- | -------------------------------------------- |
| Onboarding                   | `cdk deploy` per tenant               | 2 SDK calls, < 5 seconds                     |
| CloudFront count             | N                                     | 1                                            |
| Edge function count          | N (each pinned to one `aud`)          | 1 (multi-tenant, Host-aware)                 |
| Edge function blast radius   | 1 tenant per bug                      | all tenants per bug                          |
| Per-tenant CloudFront config | possible (cache, WAF)                 | impossible — single config                   |
| Edge propagation per tenant  | ~5–10 min wait on onboard             | 0 (no edge change)                           |
| ACM cert                     | N (per subdomain) or wildcard         | 1 (wildcard)                                 |
| Route 53 records             | N (per subdomain alias)               | 1 (wildcard alias)                           |
| App client creation          | CDK (`addAppClient`)                  | SDK (`CreateUserPoolClient`)                 |
| Tenant deletion              | `cdk deploy` (resource removal)       | 2 SDK calls (delete client + row)            |
| Tenant rename                | Possible via CDK                      | Logout + new client + new row                |
| Tenant scaling ceiling       | ~50 (CloudFront-distribution churn)   | ~thousands (Cognito client limit is 1000 per pool default; raisable) |
| Cross-tenant cookie leakage  | impossible (different distributions)  | impossible (subdomain-scoped cookies)        |
| Cross-tenant token replay    | rejected by per-tenant `aud` pin      | rejected by Host ↔ `custom:tenant_id` check  |

The trade you make for pure-data onboarding: edge-function bugs and
wildcard-cert compromise become single-blast-radius events across all
tenants on the identity, rather than per-tenant events. See
[`07-security-and-isolation.md`](07-security-and-isolation.md) for the
mitigations.

## Scaling ceilings

| Constraint                                       | Default limit | Raisable? | Notes                                                          |
| ------------------------------------------------ | ------------: | --------- | -------------------------------------------------------------- |
| Cognito app clients per user pool                |        1,000 | yes       | Hard ceiling on tenant count per identity                      |
| Cognito user pool quota requests/sec             |          120 | yes       | Pool-wide, shared across all tenants                           |
| CloudFront alternate names per distribution      |          100 | yes       | Not relevant — we use one wildcard, not N explicit names       |
| DDB `ClientConfig` table size                    |          n/a | n/a       | Trivial — KB per row                                           |
| CFN stack resource count                         |          500 | no        | Easily satisfied — fixed per-identity, ~30 resources           |
| ACM cert subjects per cert                       |           10 | yes       | Not relevant — single `*.tenants.example.com` SAN              |
| Lambda@Edge memory                               |       128 MB | no        | Sufficient for JWT verify + Host parse                         |

The first row is the real ceiling for shared-distribution mode. Past
~1,000 tenants on one identity, the consumer either requests a quota
raise or sharded identities. See
[`07-security-and-isolation.md`](07-security-and-isolation.md) §
sharding.

## What the consumer's CDK code looks like

```typescript
import { SharedDistributionIdentity } from '@de-otio/vestibulum-cdk';

const identity = new SharedDistributionIdentity(this, 'Identity', {
  tenantSubdomainParent: 'tenants.example.com',
  // Wildcard cert + wildcard A-record + CloudFront alternate name
  // are all derived from this one prop.

  sesIdentitySender: 'no-reply@example.com',
  // ...other props mostly identical to MagicLinkIdentity...
});

// That's it. No `MagicLinkAuthSite` per tenant.
// Tenants are added at runtime via identity.adminFunctionUrl.
```

To onboard a tenant at runtime, the consumer invokes the admin
Function URL:

```bash
aws lambda invoke \
  --function-name $(... identity.adminLambdaName) \
  --payload '{
    "action": "createTenant",
    "subdomain": "acme",
    "allowedEmailDomains": ["acme.example"],
    "tenantId": "acme"
  }' \
  /tmp/out.json
```

Or via a SigV4-signed HTTP request to `identity.adminFunctionUrl`.
The admin Lambda returns the new `clientId` and any other
caller-facing handles. See
[`03-tenant-onboarding.md`](03-tenant-onboarding.md).

## Domains for one identity vs. multi-identity

One `SharedDistributionIdentity` owns one parent subdomain
(`*.tenants.example.com`). For multiple parent subdomains
(e.g. `*.tenants.example.com` and `*.partners.example.com`), instantiate
two `SharedDistributionIdentity` constructs — they're cheap relative
to per-tenant resources, and giving each its own wildcard cert is the
cleanest cookie-domain story.

A consumer who wants single-tenant deployments alongside shared-
distribution ones uses both `MagicLinkIdentity` (single-tenant) and
`SharedDistributionIdentity` (multi-tenant) in the same stack. Both
exist in `@de-otio/vestibulum-cdk` as siblings — the multi-tenant
construct is not a "mode" prop on `MagicLinkIdentity`, because the
prop matrix would be unmanageable. See
[`02-construct-api.md`](02-construct-api.md).
