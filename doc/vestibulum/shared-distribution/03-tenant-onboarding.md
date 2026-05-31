# 03 — Tenant onboarding

The load-bearing surface that makes onboarding "data, not deploy".
A single Lambda — the **admin Lambda** — exposes a small JSON API
behind a SigV4 IAM-auth'd Function URL. Three operations:
`createTenant`, `updateTenant`, `deleteTenant`. Each maps to ≤ 2 AWS
SDK calls (one to Cognito, one to DDB).

## Function URL contract

The admin Lambda is invoked via Function URL with
`AuthType: AWS_IAM`. Only principals named in
`SharedDistributionIdentityProps.adminInvokePrincipal` can invoke it
(plus the standard CloudWatch / lifecycle service principals). The
Function URL is **not** behind API Gateway — Gateway adds latency,
WAF cost, and another resource without buying anything that Function
URLs don't already give us (IAM auth, request/response, CORS).

### IAM permissions (Oct 2025 change)

Starting October 2025, new Function URLs require both
`lambda:InvokeFunctionUrl` AND `lambda:InvokeFunction` permissions
([AWS docs](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)).
The construct's grant to `adminInvokePrincipal` covers both, with
the `lambda:InvokedViaFunctionUrl` condition key to restrict
`InvokeFunction` to Function URL calls only:

```typescript
adminFn.addPermission('AdminInvoke', {
  principal: props.adminInvokePrincipal,
  action: 'lambda:InvokeFunctionUrl',
  functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
});
adminFn.addPermission('AdminInvokeFn', {
  principal: props.adminInvokePrincipal,
  action: 'lambda:InvokeFunction',
  // Restrict to Function URL invocations only
  conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
});
```

Cross-account principals additionally need their own identity-based
policy granting these actions; document in ops runbook. AWS
recommends IAM Access Analyzer for monitoring; see
[`08-observability-and-audit.md`](08-observability-and-audit.md) §
IAM Access Analyzer.

### Unknown action handling

Request parsing uses Zod (or equivalent) with a discriminated union
on `action`. Unknown values **must** be rejected:

```typescript
const RequestSchema = z.discriminatedUnion('action', [
  CreateTenantRequestSchema,
  UpdateTenantRequestSchema,
  DeleteTenantRequestSchema,
  GetTenantRequestSchema,
  ListTenantsRequestSchema,
]);

// In handler:
const parse = RequestSchema.safeParse(body);
if (!parse.success) {
  return { statusCode: 400, body: JSON.stringify({ error: 'INVALID_REQUEST', detail: parse.error.format() }) };
}
```

The exhaustive switch on parsed `action` uses `default: never` for
compile-time exhaustiveness. Unrecognised actions never reach the
switch; they fail validation up front.

### CORS

Default: `AllowOrigins: []` (no CORS). The admin Function URL is
intended for server-side or CLI invocation. Consumers who want a
browser-based self-service portal calling the URL directly must opt
into CORS explicitly via construct prop:

```typescript
new SharedDistributionIdentity(this, 'Identity', {
  // ...
  adminFunctionUrlCors: {
    allowOrigins: ['https://admin.example.com'],
    allowMethods: ['POST'],
    allowHeaders: ['content-type', 'authorization', 'x-amz-date', 'x-amz-security-token'],
    maxAge: Duration.hours(1),
  },
});
```

The construct refuses `AllowOrigins: ['*']` at synth time — IAM-auth'd
Function URLs called with credentials must not be wildcard-CORS.

Request schema (one POST per call, payload-discriminated by `action`):

```typescript
type AdminRequest =
  | CreateTenantRequest
  | UpdateTenantRequest
  | DeleteTenantRequest
  | GetTenantRequest
  | ListTenantsRequest;

interface CreateTenantRequest {
  readonly action: 'createTenant';

  /**
   * Leftmost-label subdomain under the identity's
   * `tenantSubdomainParent`. E.g. `'acme'` → `acme.tenants.example.com`.
   *
   * Validated against the identity's `tenantSubdomainPattern` and
   * `reservedSubdomains`.
   */
  readonly subdomain: string;

  /**
   * Opaque tenant identifier — what gets injected as
   * `custom:tenant_id` in JWTs issued against this tenant's
   * app client. Recommended: same as `subdomain` for traceability,
   * but the consumer can pass any string.
   *
   * Must match `^[a-zA-Z0-9_-]{1,64}$`.
   */
  readonly tenantId: string;

  /**
   * Email-domain allowlist for signups against this tenant's app
   * client. Empty list = signups disabled.
   *
   * No wildcards. Domains normalised on write (lowercased, trimmed).
   */
  readonly allowedEmailDomains: readonly string[];

  /**
   * Idempotency key. If the same key is presented twice, the
   * second call returns the first call's response without
   * re-creating the resources. 24-hour deduplication window.
   */
  readonly idempotencyKey: string;
}

interface CreateTenantResponse {
  readonly tenantId: string;
  readonly subdomain: string;
  readonly siteBaseUrl: string;          // derived: `https://<subdomain>.<parent>`
  readonly clientId: string;              // Cognito app client ID
  readonly createdAt: string;             // ISO-8601
}
```

Update is symmetric (`updateTenant` with the same fields except
`subdomain`, which is immutable post-creation; rename is a delete +
recreate flow). Delete takes just `tenantId`. Get / List are
read-only debugging endpoints.

## `createTenant` flow

Three SDK calls total: one reservation write, one Cognito client
create, one config-row write. Order matters and is enforced by the
implementation.

```typescript
async function createTenant(req: CreateTenantRequest): Promise<CreateTenantResponse> {
  // (0) idempotency check — key scoped to subdomain to prevent
  //     cross-tenant collisions if callers reuse idempotency keys.
  const idempotencyKey = `${req.idempotencyKey}#${req.subdomain}`;
  const existing = await ddb.getItem({
    TableName: IDEMPOTENCY_TABLE,
    Key: { idempotencyKey: { S: idempotencyKey } },
  });
  if (existing.Item) {
    const stored = JSON.parse(existing.Item.response.S!) as CreateTenantResponse;
    // Defensive verification: stored response must match this request's
    // subdomain + tenantId. Mismatch → caller reused the key for a
    // different tenant (programmer error or weak UUID).
    if (stored.subdomain !== req.subdomain || stored.tenantId !== req.tenantId) {
      throw new ConflictError('Idempotency key reused with different tenant identity');
    }
    return stored;
  }

  // (1) validate input
  validateSubdomain(req.subdomain);
  validateTenantId(req.tenantId);
  validateAllowedEmailDomains(req.allowedEmailDomains);

  // (2) reserve subdomain + tenantId atomically.
  //
  //     The condition `attribute_not_exists OR expiresAt < :now`
  //     handles DDB's eventually-consistent TTL deletion: an
  //     expired-but-not-yet-deleted reservation is treated as
  //     absent (DDB TTL can lag by minutes-to-hours, blocking
  //     legitimate retries if we only checked attribute_not_exists).
  const now = Math.floor(Date.now() / 1000);
  await ddb.transactWriteItems({
    TransactItems: [
      {
        Put: {
          TableName: RESERVATIONS_TABLE,
          Item: {
            key: { S: `subdomain#${req.subdomain}` },
            expiresAt: { N: String(now + 60) },
          },
          ConditionExpression: 'attribute_not_exists(#k) OR #exp < :now',
          ExpressionAttributeNames: { '#k': 'key', '#exp': 'expiresAt' },
          ExpressionAttributeValues: { ':now': { N: String(now) } },
        },
      },
      {
        Put: {
          TableName: RESERVATIONS_TABLE,
          Item: {
            key: { S: `tenantId#${req.tenantId}` },
            expiresAt: { N: String(now + 60) },
          },
          ConditionExpression: 'attribute_not_exists(#k) OR #exp < :now',
          ExpressionAttributeNames: { '#k': 'key', '#exp': 'expiresAt' },
          ExpressionAttributeValues: { ':now': { N: String(now) } },
        },
      },
    ],
  });

  const siteBaseUrl = `https://${req.subdomain}.${TENANT_PARENT}`;

  // (3) create Cognito app client
  //
  //     `ALLOW_REFRESH_TOKEN_AUTH` is EXCLUDED because refresh-token
  //     rotation (security best practice, enabled below) is
  //     incompatible with that auth flow. Refresh uses the
  //     `GetTokensFromRefreshToken` API instead — see 06 § auth-verify.
  let clientId: string;
  try {
    const clientResp = await cognito.createUserPoolClient({
      UserPoolId: USER_POOL_ID,
      ClientName: `tenant-${req.subdomain}`,
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH'],  // NO REFRESH_TOKEN_AUTH
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      // Refresh-token rotation: invalidate old refresh token on each
      // refresh, with a 60-second grace period for retry. Required for
      // the security posture; incompatible with REFRESH_TOKEN_AUTH.
      RefreshTokenRotation: {
        Feature: 'ENABLED',
        RetryGracePeriodSeconds: 60,
      },
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
      AccessTokenValidity: 60,
      IdTokenValidity: 60,        // construct-overridable; see 02 § idTokenValidity
      RefreshTokenValidity: 30,
      ReadAttributes: [...],
      WriteAttributes: [...],
      CallbackURLs: [`${siteBaseUrl}/login/callback`],
      LogoutURLs: [`${siteBaseUrl}/logout`],
      AllowedOAuthFlows: [],
      SupportedIdentityProviders: ['COGNITO'],
    });
    clientId = clientResp.UserPoolClient!.ClientId!;
  } catch (err) {
    await releaseReservations(req.subdomain, req.tenantId);
    throw err;
  }

  const createdAt = new Date().toISOString();

  // (4) write ClientConfig row
  try {
    await ddb.putItem({
      TableName: CLIENT_CONFIG_TABLE,
      Item: {
        clientId: { S: clientId },
        subdomain: { S: req.subdomain },
        tenantId: { S: req.tenantId },
        siteBaseUrl: { S: siteBaseUrl },
        allowedEmailDomains: { SS: [...req.allowedEmailDomains] },
        createdAt: { S: createdAt },
      },
      ConditionExpression: 'attribute_not_exists(clientId)',
    });
  } catch (err) {
    // Compensation: app client was created but row write failed.
    // Roll back to avoid an orphan. The reconciler (below) is the
    // safety net if this delete also fails.
    await cognito.deleteUserPoolClient({ UserPoolId: USER_POOL_ID, ClientId: clientId });
    await releaseReservations(req.subdomain, req.tenantId);
    throw err;
  }

  const response: CreateTenantResponse = {
    tenantId: req.tenantId,
    subdomain: req.subdomain,
    siteBaseUrl,
    clientId,
    createdAt,
  };

  // (5) persist idempotency
  await ddb.putItem({
    TableName: IDEMPOTENCY_TABLE,
    Item: {
      idempotencyKey: { S: req.idempotencyKey },
      response: { S: JSON.stringify(response) },
      expiresAt: { N: String(Math.floor(Date.now() / 1000) + 86400) },
    },
  });

  // (6) release reservation rows (they have a 60s TTL anyway, but
  //     explicit release frees the namespace immediately for retries)
  await releaseReservations(req.subdomain, req.tenantId);

  return response;
}
```

End-to-end latency: ~300–500 ms warm (one extra DDB transact call
vs. the simpler design), ~1.5–2 s cold start. No edge propagation.
The tenant is live the moment the response returns.

### Why the reservation step

`assertNoTenantWithSubdomain` via GSI lookup + `PutItem` is not
atomic. Two concurrent `createTenant` calls for the same subdomain
could both pass the lookup (the second call's GSI read happens
before the first's write is visible), then both call
`CreateUserPoolClient`, then one of the row writes fails on
`attribute_not_exists(clientId)` but the *clientId is distinct*
because Cognito generated two — so the condition doesn't catch the
collision.

The reservation table closes the race: the `TransactWriteItems`
with `attribute_not_exists` ensures one of the two callers fails
fast on the reservation step, before any Cognito work. The 60-second
TTL handles the case where the admin Lambda crashes mid-flow
without releasing.

The reservations table is small (one short-lived row per in-flight
onboarding) and has its own TTL attribute for DDB-managed cleanup.

### Why the compensation step matters

Cognito's `CreateUserPoolClient` is not transactional with DDB.
If we create the app client and then the DDB write fails (throughput
exception, table missing), the pool now has an orphan client that
can issue tokens with no corresponding `ClientConfig` row. Those
tokens would fail `PreTokenGeneration` (no `tenantId` lookup) and
`PreSignUp` (no `allowedEmailDomains`) — fail-closed semantics catch
it — but the orphan accumulates noise and is hard to detect later.

The compensation step (delete the app client on row-write failure)
is the cheapest cleanup. The deletion can itself fail (network
partition); the reconciler below is the safety net.

### Reconciler Lambda

An EventBridge-scheduled Lambda runs **hourly** (`rate(1 hour)`)
to detect orphans in either direction. The compensation step in
`createTenant` also emits a real-time
`Vestibulum/SharedDistribution/CompensationTriggered` metric so
operators see failures immediately rather than waiting for the next
reconciler tick:

- Cognito app clients on the pool that have no matching `ClientConfig`
  row → "client without row" orphan.
- `ClientConfig` rows whose `clientId` doesn't match any Cognito app
  client → "row without client" orphan.

The reconciler:

1. Lists all app clients via `ListUserPoolClients` (paginated).
2. Scans `ClientConfig` (paginated). The table is small enough that a
   full scan once an hour is cheap.
3. Compares the two sets.
4. **Does not auto-delete.** Orphans may be in-flight onboardings
   (the hourly window catches steady-state, not transient state).
5. Emits CloudWatch metrics:
   - `Vestibulum/SharedDistribution/OrphanedAppClients` (count)
   - `Vestibulum/SharedDistribution/OrphanedConfigRows` (count)
6. Logs orphan details (clientId, subdomain, age) for operator
   inspection.

The construct ships a CloudWatch alarm on each metric: `count > 0`
sustained for 1 hour → alarm. (Down from a daily-scale window —
crash-loop accumulation should not be invisible to monitoring.) The
1-hour sustain absorbs onboarding-burst false positives while
catching genuine orphan accumulation within one operator-action
window.

The reconciler runs in the home region; takes ~1–5 seconds for
hundreds of tenants. No effect on the auth path.

Operator runbook for clearing orphans:

- **Client without row** likely means a botched onboarding past the
  compensation window. Delete via `aws cognito-idp delete-user-pool-client`
  after confirming the client was never authenticated against (check
  CloudTrail for `InitiateAuth` calls).
- **Row without client** likely means a botched deletion. Delete the
  row via `aws dynamodb delete-item` after confirming the clientId
  isn't otherwise referenced.

## `deleteTenant` flow

```typescript
async function deleteTenant({ tenantId, revokeActiveSessions }: DeleteTenantRequest): Promise<void> {
  const row = await ddb.queryByTenantId(tenantId);
  if (!row) throw new TenantNotFoundError(tenantId);

  // (1) Optionally revoke active sessions for users whose last
  //     authentication was against this client. Closes the
  //     post-deletion token-validity window (see below).
  if (revokeActiveSessions) {
    await revokeAllSessionsForClient(row.clientId);  // iterates users + AdminUserGlobalSignOut
  }

  // (2) Delete app client first → Cognito refuses new token issuance.
  await cognito.deleteUserPoolClient({
    UserPoolId: USER_POOL_ID,
    ClientId: row.clientId,
  });
  // (3) Delete ClientConfig row → trigger handlers fail-closed for any
  //     in-flight requests using stale cached tokens.
  await ddb.deleteItem({
    TableName: CLIENT_CONFIG_TABLE,
    Key: { clientId: { S: row.clientId } },
  });

  emitMetric('Vestibulum/SharedDistribution/TenantDeleted', 1, {
    tenantId,
    subdomain: row.subdomain,
    revokedSessions: String(revokeActiveSessions ?? false),
  });
}
```

### Post-deletion token-validity window

**After `deleteTenant`, already-issued ID tokens remain valid at the
edge until they expire** (default 60 min via `IdTokenValidity`).
Cognito's `deleteUserPoolClient` only prevents *new* token issuance;
it does not invalidate JWTs that the pool has already signed. The
edge function verifies signature + Host ↔ `custom:tenant_id`, both
of which remain valid for the token's lifetime.

Three mitigation paths:

1. **`revokeActiveSessions: true` flag** (recommended for sensitive
   deletions). Iterates all users whose last-auth was on this client
   and calls `AdminUserGlobalSignOut`. Adds latency proportional to
   user count but closes the window.
2. **Reduce `IdTokenValidity` globally** via construct prop. Minimum
   5 min. Trades higher token-refresh load for a shorter risk window.
3. **Accept the window** for low-risk deletions (test tenants,
   stale-cleanup). Document the window in audit-log entries so SIEM
   can correlate.

The order matters: app client first, then row. If the row deletion
fails after the client deletion, you have a `ClientConfig` row
referencing a non-existent app client. That's safe — token issuance
is impossible, the row is just garbage. The reconciler picks it up.

The reverse order (row first, then client) would let a token issued
mid-delete pass `PreTokenGeneration` (row gone, fail-closed), but
edge cases around in-flight authentication flows are harder to reason
about. App-client-first means the moment the deletion succeeds,
Cognito refuses to issue further tokens against that client.

What `deleteTenant` does **not** clean up:

- **Users (`sub` entries) in the pool.** Users in a shared pool are
  not partitioned by app client; one user can have authenticated
  against multiple clients. Deleting the client doesn't delete the
  user. Tenant deletion in the user-data sense is a separate
  operation (`AdminDeleteUser` per user — out of scope for the
  admin Lambda).
- **Magic-link tokens in `MagicLinkTokens`.** They TTL-expire on
  their own.
- **The DNS entry.** Wildcard DNS means the subdomain still
  resolves; requests will hit the edge, the edge can't find a
  matching `ClientConfig` for any token, and the user gets a
  generic "not signed in" → magic-link flow which fails at
  `PreSignUp` (no row → no allowlist → "signup not allowed"). The
  pages render but no auth flow completes. This is acceptable; if
  the operator wants the subdomain to 404 instead, that's a
  CloudFront cache behaviour change — out of scope for the admin
  Lambda.

## `updateTenant` flow

Only `allowedEmailDomains` is mutable. **`tenantId` and `subdomain`
are immutable post-creation** — rename = delete + recreate.

The immutability of `tenantId` is a security guarantee, not a
convenience constraint: `custom:tenant_id` is the load-bearing
claim that downstream authorization systems may key on, and
allowing it to change without forced session invalidation creates
windows of claim/identity drift that complicate audit attribution
and could become a privilege-escalation vector if `tenantId` is
ever used as an authorization key.

```typescript
async function updateTenant(req: UpdateTenantRequest): Promise<UpdateTenantResponse> {
  const row = await ddb.queryByTenantId(req.tenantId);
  if (!row) throw new TenantNotFoundError(req.tenantId);

  await ddb.updateItem({
    TableName: CLIENT_CONFIG_TABLE,
    Key: { clientId: { S: row.clientId } },
    UpdateExpression: 'SET allowedEmailDomains = :ed, updatedAt = :now',
    ExpressionAttributeValues: {
      ':ed': { SS: [...req.allowedEmailDomains] },
      ':now': { S: new Date().toISOString() },
    },
    ConditionExpression: 'attribute_exists(clientId)',
  });

  // Real-time alerting on allowlist change — high-blast-radius
  // operation. See 08 § Audit logging.
  emitMetric('Vestibulum/SharedDistribution/AllowlistChanged', 1, {
    tenantId: req.tenantId,
    subdomain: row.subdomain,
  });
}
```

`UpdateTenantRequest` accepts `allowedEmailDomains` only. The
schema does not include `newTenantId`. The wrapper rejects unknown
fields (Zod `.strict()`) so accidental attempts to mutate
`tenantId` or `subdomain` fail at parse time.

## ClientConfig table shape

```typescript
interface ClientConfigItem {
  clientId: string;                      // PK
  subdomain: string;                     // GSI 1 PK
  tenantId: string;                      // GSI 2 PK
  siteBaseUrl: string;
  allowedEmailDomains: Set<string>;
  createdAt: string;
}
```

Two global secondary indexes:

- **`SubdomainIndex`** (PK `subdomain`) — used by:
  - The admin Lambda's `assertNoTenantWithSubdomain` check.
  - The `auth-verify` / `auth-signout` Function URLs'
    `loadClientConfigBySubdomain` lookup. (The Lambda@Edge
    check-auth function does **not** read DDB — see
    [`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md) §
    "Why no `aud` allowlist via DDB lookup at the edge".)

- **`TenantIdIndex`** (PK `tenantId`) — used by:
  - The admin Lambda's `getTenant`, `deleteTenant`, `updateTenant`.

Provisioned capacity: pay-per-request. Tenant adds are rare; reads
are bursty (every cold-start of every trigger Lambda) but absorbed
by the 5-min in-memory TTL cache. PITR enabled (per the design's
default for stateful resources).

**Encryption**: defaults to `AWS_MANAGED` (DDB-owned KMS key visible
in the KMS console). NOT `AWS_OWNED` (the silent default): consumers
in compliance-driven environments need key visibility, and migrating
from `AWS_OWNED` to KMS-managed later requires table recreation.
Consumers needing customer-managed encryption pass `tableKmsKey` via
construct prop ([`02-construct-api.md`](02-construct-api.md)). The
`MagicLinkTokens` table receives the same treatment with a higher
urgency — that table holds short-lived secrets, not just config.

### Important: the edge function doesn't read ClientConfig

The Lambda@Edge `check-auth` function **cannot** read DDB directly
(Lambda@Edge runs in regions distinct from the table's home region;
cross-region DDB calls from the edge defeat the latency budget and
introduce a circular dependency on the table's availability for the
auth path). The edge's tenant identification comes entirely from
the JWT (`custom:tenant_id`) and the `Host` header. The
`ClientConfig` table is read only by:

- The admin Lambda (write + read for management ops).
- `PreSignUp` (read on signup).
- `CreateAuthChallenge` (read on magic-link issuance).
- `PreTokenGeneration` (read on every token mint, to inject
  `custom:tenant_id`).

All four of those run in the home region. The edge function
operates on what's already in the token. See
[`04-multi-aud-edge-check.md`](04-multi-aud-edge-check.md).

## Validation rules

| Field                  | Rule                                                                  | Reason                                        |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `subdomain`            | Matches `tenantSubdomainPattern` (default `^[a-z][a-z0-9-]{1,62}[a-z0-9]$`) | DNS-label-shaped, no leading number / hyphen  |
| `subdomain`            | Not in `reservedSubdomains`                                           | Reserve `admin`, `www`, etc. for infra        |
| `subdomain`            | Unique under this identity (GSI lookup)                              | Two tenants on one subdomain ill-defined      |
| `tenantId`             | Matches `^[a-zA-Z0-9_-]{1,64}$`                                       | Cognito attribute value charset / length      |
| `tenantId`             | Unique under this identity                                            | Used as claim value; collisions = cross-leak  |
| `allowedEmailDomains`  | Each entry matches `^[a-z0-9.-]+\.[a-z]{2,}$`                         | Conservative DNS-name shape                   |
| `allowedEmailDomains`  | All lowercased, trimmed                                               | Match what `PreSignUp` compares against       |
| `idempotencyKey`       | Matches `^[a-zA-Z0-9_-]{8,128}$`                                      | Avoid path traversal / SQL-injection shapes   |

All failures return 400 with a structured error code. The admin
Lambda never returns 500 for caller-input issues.

## What the admin Lambda does NOT do

- **No user management.** Creating, deleting, listing, exporting
  users is a separate concern; consumers use `AdminCreateUser`,
  `AdminDeleteUser` etc. on the user pool directly.
- **No app-client config beyond what's pre-baked.** Token
  validity, callback URLs, allowed OAuth flows are all set
  identically across tenants from the construct's deploy-time
  config. To change them for a specific tenant: delete and
  recreate that tenant's client. To change them for all
  tenants: redeploy the identity (CDK).
- **No DNS provisioning.** Wildcard DNS does the work. If a
  consumer has chosen *not* to use wildcard DNS (e.g., point each
  subdomain at the CloudFront distribution individually for
  observability reasons), they manage DNS themselves; the admin
  Lambda doesn't talk to Route 53.
- **No multi-region replication.** One identity, one region.

## SigV4 invocation example

```bash
# Operator invocation, IAM-auth'd
aws lambda invoke-url \
  --function-name $IDENTITY_ADMIN_LAMBDA \
  --payload '{
    "action": "createTenant",
    "subdomain": "acme",
    "tenantId": "acme",
    "allowedEmailDomains": ["acme.example"],
    "idempotencyKey": "01J1FZ7H8K9MX5N7QABCDEF123"
  }' /tmp/response.json
```

Or from consumer code:

```typescript
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';

const signer = new SignatureV4({ /* ...credentials... */ });
const signedReq = await signer.sign(new HttpRequest({
  method: 'POST',
  hostname: new URL(identityAdminUrl).hostname,
  path: '/',
  body: JSON.stringify(req),
  headers: { 'content-type': 'application/json', host: new URL(identityAdminUrl).hostname },
}));

const resp = await fetch(identityAdminUrl, { method: 'POST', headers: signedReq.headers, body: signedReq.body });
```

The construct exposes both `identity.adminFunctionUrl` (for HTTP)
and `identity.adminLambdaName` (for direct Lambda invoke).
