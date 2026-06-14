# 05 — App clients and token TTLs

`MagicLinkAuthSite` auto-creates one Cognito app client for the
website. Many consumers need additional app clients on the same pool —
for example, an OAuth-based API server, a mobile app, or a separate
MCP server. This file specifies how to add them, and how token TTLs
flow across the pool / app-client boundary.

## `MagicLinkIdentity.addAppClient(id, props)`

The convenience method wraps `cognitoPool.addClient` with magic-link-
compatible auth flows pre-configured. The `props` shape is the
standard CDK `cognito.UserPoolClientOptions` — the same shape
`MagicLinkAuthSite` uses internally when it auto-creates the website
client — so consumers don't have to learn a bespoke prop dialect:

```typescript
import * as cognito from "aws-cdk-lib/aws-cognito";

identity.addAppClient("mcp", {
  oAuth: {
    flows: { authorizationCodeGrant: true },
    callbackUrls: ["http://localhost/oauth/callback", "http://localhost:8080/oauth/callback"],
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
  },
  generateSecret: false,

  // Token TTL overrides — fall back to MagicLinkIdentity
  // defaults if omitted.
  idTokenValidity: Duration.minutes(15),
  refreshTokenValidity: Duration.hours(24),
});
```

PKCE is **implicit** when `flows.authorizationCodeGrant: true` and
`generateSecret: false` (Cognito mandates PKCE on public clients
using the authorization-code flow); no separate `pkce: true` flag
exists or is needed.

Returns the underlying `cognito.UserPoolClient`. The construct
guarantees:

- `CUSTOM_AUTH` flow is on (so magic-link still works for this
  client).
- `ALLOW_USER_PASSWORD_AUTH` is off (passwords aren't enabled on the
  pool at all).
- Refresh-token revocation is enabled.
- Token validity defaults inherit from
  `MagicLinkIdentity.defaultIdTokenValidity` /
  `defaultRefreshTokenValidity` if not overridden.
- `generateSecret: false` is enforced by `DisabledAuthFlowsAspect` —
  vestibulum-cdk app clients are public (SPA / browser / mobile).

## Token TTL hierarchy

TTLs are resolved in this order, most-specific to least-specific:

1. **Per-app-client overrides** — `idTokenValidity` /
   `refreshTokenValidity` on the props passed to `addAppClient` (or
   on `MagicLinkAuthSite` for the auto-created website client).
2. **Pool-wide defaults on `MagicLinkIdentity`** —
   `defaultIdTokenValidity` (vestibulum-cdk default: 15 min) and
   `defaultRefreshTokenValidity` (vestibulum-cdk default:
   **24 hours**). Applied to any app client that doesn't override.
3. **Cognito's own defaults** — last fallback, never reached if
   either of the above is set.

The 15-min / 24-h defaults are deliberate, not a port of Cognito's
own conservative defaults (1 h / 30 d). The edge JWT verifier
signature-checks tokens without a per-request revocation lookup, so
**the worst-case offboarding window is bounded by `idTokenValidity`
for active sessions and by `refreshTokenValidity` for sessions that
have stopped refreshing**. 24 h matches the security-conscious
posture vestibulum-cdk advertises; Cognito's 30-day default would
not.

Two additional revocation mechanisms close the rest of the gap:

- **`auth-signout` calls `cognito-idp:GlobalSignOut`** (not just
  clears cookies). Refresh tokens are invalidated server-side;
  subsequent refresh attempts fail. The ID-token cookie remains
  valid at the edge until its 15-min expiry — that's the residual
  window.
- **For near-real-time revocation** (offboarding before ID-token
  expiry), implement a denylist pattern in Lambda@Edge: an in-memory
  cache of `sub`s backed by either (a) periodic Cognito `GetUser`
  calls with short TTL, or (b) a DynamoDB denylist table that the
  edge function fetches with module-scope caching. Vestibulum-cdk
  doesn't bake the pattern in because the operational shape (which
  population offboards, how fast) is consumer-specific.

## Patterns

### Single client (the simplest case)

Default. `MagicLinkAuthSite` creates the website client. No
`addAppClient` calls needed.

### Two clients: website + API

```typescript
const identity = new MagicLinkIdentity(this, "Identity", {
  hostedZone,
  allowedEmailDomains: ["example.com"],
  sesIdentitySender: "noreply@example.com",
});

new MagicLinkAuthSite(this, "Site", { domain, origin, edge, identity });

// Second app client for an API server using OAuth.
identity.addAppClient("api", {
  oAuth: {
    flows: { authorizationCodeGrant: true },
    callbackUrls: ["http://localhost/oauth/callback"],
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
  },
  generateSecret: false,
});
```

### Per-app-client claim filtering

If the website client should not carry the `email` claim but the API
client should, configure a `preTokenGeneration` Lambda on
`MagicLinkIdentity` that dispatches on
`event.callerContext.clientId`. See
[`06-trigger-hooks.md § Recipe: per-app-client claim filtering`](06-trigger-hooks.md#recipe-per-app-client-claim-filtering).

### Federation-enabled app clients

When `identity.federationEnabled: true`,
`MagicLinkIdentity.addAppClient` applies federation defaults: the
OAuth code flow is permitted, `supportedIdentityProviders` defaults
to `['COGNITO']` (runtime IdP CRUD via the vestibulum runtime API
adds per-tenant entries — see the vestibulum runtime API docs),
HTTPS-only callback URLs are enforced outside localhost, and
`prevent_user_existence_errors: 'ENABLED'` is set automatically.
The full federation-aware app-client spec is in
[`07-cdk-changes-from-trellis.md § App-client federation flags`](07-cdk-changes-from-trellis.md#app-client-federation-flags).

## Why a helper, not just `cognitoPool.addClient`

`cognitoPool.addClient` is the underlying primitive and is exposed as
an escape hatch via `identity.cognitoPool`. Consumers can call it
directly. `addAppClient` is a thin convenience layer that:

- Sets the magic-link-compatible flags so consumers don't have to
  remember which flags interact with vestibulum-cdk's bundled
  triggers.
- Inherits the pool-wide TTL defaults if the consumer doesn't
  override.
- Returns a regular `UserPoolClient` (no custom return type) so
  consumers can use idiomatic CDK from there.

If a consumer wants behaviours `addAppClient` doesn't support (e.g.
enabling password auth on a specific client — vestibulum-cdk's helper
actively disables this), they fall back to `cognitoPool.addClient`
directly. The `DisabledAuthFlowsAspect` will fail synth if they
re-enable a blocked flow that way, so the escape hatch is powerful
without being unsafe.
