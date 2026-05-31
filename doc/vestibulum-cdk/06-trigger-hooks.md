# 06 — Cognito trigger extension hooks

`@de-otio/vestibulum-cdk` owns the four `CUSTOM_AUTH` triggers
(`PreSignUp`, `DefineAuthChallenge`, `CreateAuthChallenge`,
`VerifyAuthChallengeResponse`) plus the bounce-handler. Consumers
commonly need two more triggers for application-specific logic;
vestibulum-cdk exposes these as **generic extension hooks** rather
than baking in any particular consumer's needs.

The runtime side of the trigger story — claim-resolver callbacks,
provisioner hooks, the typed `ClaimResolverInput` / `ProvisionerInput`
shapes — lives in the vestibulum runtime API. The construct side
(this file) is just the wiring: how a consumer-supplied Lambda gets
attached to the pool, what guarantees the construct makes about IAM,
and the trust-boundary caveats.

## Available hooks

- **`preTokenGeneration`** — invoked by Cognito just before each
  token issuance. Common uses: per-app-client claim filtering
  (suppress claims for one client, preserve for another), injection
  of custom claims (`tenant_id`, `role`, etc.).
- **`postConfirmation`** — invoked after a user completes signup.
  Common uses: bootstrap entries in application-side tables, send
  welcome emails, register the user in an authorisation service.

## Wiring behaviour

When the prop is provided, `MagicLinkIdentity`:

1. Attaches the function as the corresponding Cognito trigger.
2. Grants Cognito permission to invoke it.
3. Surfaces the function reference back as a readonly property on
   the construct (`identity.preTokenGeneration`,
   `identity.postConfirmation`).
4. Validates the function is in the same AWS account and region as
   the construct (see [Trust model](#trust-model)).

When the prop is unset, no trigger is configured — Cognito's
defaults apply.

**No bundled defaults.** Vestibulum-cdk ships no default Lambda for
either trigger. Claim names, bootstrap shapes, and similar
application-specific logic live in the consumer's Lambda, not in
vestibulum-cdk.

## Trust model

Consumer-supplied `preTokenGeneration` and `postConfirmation`
Lambdas run **inside the auth boundary** with token-issuance
privileges. A buggy or compromised consumer Lambda can:

- Mint claims that include `cognito:groups` and escalate the user's
  effective permissions in downstream services.
- Read or write to any resource vestibulum-cdk has granted it
  (vestibulum-cdk grants nothing — see below — but a consumer who
  wires extra IAM into their own role can unintentionally widen the
  blast radius).
- Throw, locking out signups or token issuance for all users.
- Make outbound HTTP calls and exfiltrate user data.

Vestibulum-cdk's guarantees:

1. **No IAM grants from vestibulum-cdk to consumer Lambdas.** The
   consumer constructs the Lambda in their own stack with their own
   execution role. Vestibulum-cdk only wires the Cognito trigger
   association and grants Cognito permission to invoke.
2. **Same-account, same-region check** at synth time. The Lambda ARN
   must be in the same account and region as the `MagicLinkIdentity`
   construct. Cross-account / cross-region trigger ARNs are a
   confused-deputy vector and are rejected.
3. **Reserved claim names.** For `preTokenGeneration`, vestibulum-cdk
   reserves the following claim names — overriding them via
   `claimsToAddOrOverride` is undefined behaviour and may break edge
   JWT verification:
   - `cognito:*` (all Cognito-managed claims)
   - `iss`, `aud`, `exp`, `iat`, `nbf`, `sub`
   - `token_use`

   Add `tenant_id`, `role`, application-namespaced claims (`custom:*`
   or app-specific prefixes) — never override the reserved set.

## Recipe: per-app-client claim filtering

The common shape for `preTokenGeneration` dispatches on
`event.callerContext.clientId`, suppresses claims for some clients,
and adds custom claims for others:

```typescript
export const handler = async (event) => {
  const clientId = event.callerContext.clientId;

  if (clientId === WEBSITE_CLIENT_ID) {
    event.response = {
      claimsOverrideDetails: {
        claimsToSuppress: ["email"],
      },
    };
  } else if (clientId === API_CLIENT_ID) {
    event.response = {
      claimsOverrideDetails: {
        claimsToAddOrOverride: {
          tenant_id: await resolveTenant(event.userName),
        },
      },
    };
  }

  return event;
};
```

The example is documentation only — vestibulum-cdk doesn't ship it
as code. Consumers building this on top of the vestibulum runtime's
typed claim-resolver helpers get a higher-level shape; consumers
hand-rolling the handler match the example above.

## Recipe: post-confirmation bootstrap

The `postConfirmation` Lambda typically writes a row into the
consumer's authorisation or role table:

```typescript
export const handler = async (event) => {
  const sub = event.userName;
  const email = event.request.userAttributes.email;

  await dynamodb.send(
    new PutItemCommand({
      TableName: ROLE_TABLE,
      Item: {
        cognito_sub: { S: sub },
        email: { S: email },
        role: { S: "default" },
        created_at: { S: new Date().toISOString() },
      },
    }),
  );

  return event;
};
```

The Lambda's IAM role needs the appropriate write permission on the
consumer's table; vestibulum-cdk doesn't grant it automatically
(since the table isn't vestibulum-cdk's).

**Reentrancy hazard.** If the consumer's role table has DynamoDB
Streams enabled and the stream handler calls back into Cognito (e.g.
`AdminUpdateUserAttributes` to set a default role), every Cognito
write potentially re-triggers `preTokenGeneration` on the next
session. Keep stream-handler logic idempotent and avoid
write-amplification loops; vestibulum-cdk does not detect this at
synth time.

## Why hooks, not bundled features

The alternative — vestibulum-cdk bakes in `tenant_id` / `role` /
`space` claim handling, or ships an opinionated role-table schema —
couples the construct to one consumer's vocabulary and pulls in
scope it doesn't want. The hook pattern is the right abstraction
layer: vestibulum-cdk provides the plumbing, consumers provide the
policy.

The vestibulum runtime API exposes typed helpers
(`ClaimResolverInput`, `ProvisionerInput`, the trigger-template
factories) that take the boilerplate out of the consumer's Lambda
while keeping the per-consumer logic in the consumer's repo. The
construct doesn't need to know about those helpers — it just wires
whichever `lambda.IFunction` the consumer hands it.
