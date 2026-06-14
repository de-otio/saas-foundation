# 09 — Operational notes

Patterns that aren't part of the construct's configuration surface
but matter for safe operation of a vestibulum-cdk-based deployment.
Each section is short and consumer-side; vestibulum-cdk's docs flag
them because they're easy to forget.

This file scopes to **CDK-specific operational concerns** —
day-2 deployment-topology concerns that span foundation +
vestibulum + vestibulum-cdk are in
[`../06-deployment-topology.md`](../06-deployment-topology.md) when
that doc lands.

## DKIM drift detection

`MagicLinkIdentity` creates DKIM CNAMEs in the consumer's Route 53
hosted zone at deploy time. If someone later removes those records
(manual edit, infrastructure drift, accidental zone replacement),
SES silently keeps sending unsigned mail and inbox-provider
deliverability degrades over days.

**Recommended consumer-side guard:** a daily Route 53 health check
on each DKIM CNAME, alarming when any record disappears.
Vestibulum-cdk doesn't ship this because health-check destinations
and notification channels are consumer infrastructure, but the
pattern is two CDK resources per CNAME and worth setting up on day
one.

```typescript
const dkimHealthCheck = new HealthCheck(this, "DkimCheck1", {
  type: HealthCheckType.RECORD_SET,
  recordSetId: "<dkim-cname-record-id>",
  // ...
});

new Alarm(this, "DkimDriftAlarm", {
  metric: dkimHealthCheck.metricHealthCheckStatus(),
  threshold: 1,
  comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
  // ... SNS topic on the consumer's alerting channel
});
```

## Quartz-friendly CSP

The default `responseHeadersPolicy` on `MagicLinkAuthSite` ships a
strict CSP (see
[`04-magic-link-auth-site.md § Response-headers
policy`](04-magic-link-auth-site.md#response-headers-policy)).
Consumers whose protected origin is a Quartz
([quartz.jzhao.xyz](https://quartz.jzhao.xyz/)) build need to relax
it: Quartz's Lunr search inlines a script and Quartz themes
occasionally inline styles.

The relaxation:

```typescript
new MagicLinkAuthSite(this, "Site", {
  domain,
  origin,
  edge,
  identity,
  responseHeadersPolicy: new ResponseHeadersPolicy(this, "Headers", {
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'", // Lunr
          "style-src 'self' 'unsafe-inline'", // theme styles
          "img-src 'self' data:",
          "font-src 'self'",
          "connect-src 'self'",
        ].join("; "),
        override: true,
      },
      // ... HSTS, X-Frame-Options, etc. unchanged from defaults
    },
  }),
});
```

If the consumer's Quartz config emits hashed inline scripts,
`'unsafe-inline'` on `script-src` can be replaced with `'sha256-...'`
hashes; same for `style-src`. Most consumers won't bother.

### Cross-origin CSP when `/auth-verify` is on a different CloudFront

The default CSP's `connect-src 'self'` assumes the login pages and
`/auth-verify` are served from the same CloudFront distribution
(the common case — vestibulum-cdk wires them this way). A consumer
who splits the login pages onto one distribution
(`app.example.com`) and `/auth-verify` onto another
(`auth.example.com`) needs to widen `connect-src` to cover the
auth-verify origin, otherwise the `fetch()` from `login-callback.html`
fails the CSP check:

```
connect-src 'self' https://auth.example.com;
```

Keep `form-action 'self'` tight unless the cross-origin POST is
explicit. The two CloudFront distributions must also share a common
parent for the `SameSite=Lax` cookie scoping to work — typically by
setting the cookie on `.example.com` rather than the specific
subdomain.

## Custom attributes and `loginPageBucket` coupling

`customAttributes` (e.g. tenant-routing or federation attributes)
declares Cognito custom attributes on the pool at creation time. The
bundled `/login` HTML collects only `email` — sufficient for the
default `customAttributes: []` case.

**Consumers who declare custom attributes that the signup flow must
populate must also provide a custom `loginPageBucket`** with signup
pages that gather and submit the additional fields, or the signup
flow will not capture them.

Vestibulum-cdk doesn't bundle a "configurable signup form" because
the form is the consumer's UX surface (styling, copy, validation
messages, accessibility). The escape-hatch pattern — provide your
own pages — matches how vestibulum-cdk handles other UI
customisation.

**Immutability footgun.** Cognito custom attributes cannot be added
to an existing pool — adding one requires a pool replacement, which
the `RETAIN` policy on `MagicLinkIdentity` will block at deploy time.
Decide the attribute set up front and treat it as a one-shot schema
decision; don't expect to evolve it through small CDK changes. See
[`07-cdk-changes-from-trellis.md § Migration for existing
consumers`](07-cdk-changes-from-trellis.md#migration-for-existing-consumers).

## Verifying the installed bundle

The Lambda@Edge `check-auth` function (and the regional handlers)
ships pre-built inside the published `@de-otio/vestibulum-cdk`
tarball. Consumers running a defence-in-depth check at install time
can verify the bundles match the hash manifest committed at publish
time:

```bash
node node_modules/@de-otio/vestibulum-cdk/scripts/verify-bundles.js
```

The manifest lives at
`node_modules/@de-otio/vestibulum-cdk/lambda-bundles.lock.json`. The
publish workflow's sigstore attestation (visible on the npm package
page once the monorepo is published from a public repo) ties the
manifest to a specific GitHub Actions workflow run and commit.

Full pipeline in
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md).

## Session-token-in-KVS (future construct candidate)

Vestibulum-cdk's edge gate verifies a Cognito-signed RS256 JWT in
Lambda@Edge. The `us-east-1` dependency that brings (ACM, WAFv2,
Lambda@Edge replication) is non-trivial — see
[`03-edge-resources.md § The us-east-1 dependency
(resolved)`](03-edge-resources.md#the-us-east-1-dependency-resolved).

A genuinely different architecture could swap the JWT verifier for
an **opaque session-token check in CloudFront Functions**:

- `auth-verify` (regional Lambda) creates a session row in a
  regional store and writes a `(session_id → user attrs)` entry
  into a CloudFront KeyValueStore. Returns a `Set-Cookie` with a
  random session id.
- The edge gate is a CloudFront Function that reads the cookie,
  looks up the session id in KVS, and accepts / rejects. No
  signature math — KVS is the authority.
- Revocation is immediate: delete the KVS entry and the next viewer
  request is rejected within seconds (KVS propagation).
- `EdgeResources` collapses entirely (no Lambda@Edge, no `us-east-1`
  cross-region dance — the certificate is still `us-east-1` but
  rolls into the regional stack via the
  `DnsValidatedCertificate`-equivalent CDK helpers).

Tradeoffs:

- KVS is **5 MB total / 1 KB per value** (as of mid-2026).
  Active-session count is bounded by that — fine for the
  low-traffic internal-site target, hard ceiling for anything
  larger.
- KVS is eventually consistent across edges; new sessions are
  usable within seconds of creation.
- The protected origin can no longer trust a JWT signature; session
  attributes must be passed via signed request headers from the
  edge function (or the origin trusts CloudFront via OAC alone and
  doesn't see user attributes).
- No third-party-issued JWT support — this only works if
  vestibulum-cdk owns the session-issuance path.

Out of scope for v0.x: it's a different security model with
different revocation, scaling, and multi-tenant stories than the
JWT design. If it ships, it ships as a **separate construct
package**, not as a generalisation of `@de-otio/vestibulum-cdk` —
per the "highly opinionated by design" mandate in
[`../01-scope-and-philosophy.md § @de-otio/vestibulum-cdk`](../01-scope-and-philosophy.md#de-otiovestibulum-cdk--the-entrance-hall-built).
Flagged here so it isn't forgotten.

## Bearer-token CloudFront (future construct candidate)

`MagicLinkAuthSite` is shaped for cookie-session-authed static
origins. Some consumers need a CloudFront distribution in front of
an AWS-native API origin (Bedrock AgentCore Runtime, API Gateway,
ALB-fronted Lambda) that uses **OAuth bearer tokens in
`Authorization` headers** rather than cookies. The Lambda@Edge
`check-auth` is the wrong gate for that shape (the origin validates
the JWT itself; CloudFront is just a proxy + WAF + custom-domain
layer).

This is **out of scope for v0.x of vestibulum-cdk.** A future
sibling construct (sketched name: `BearerTokenSite`) would slot in
alongside `MagicLinkAuthSite` with a different edge gate (or none —
pure proxy + WAF). Consumers needing it today build the CloudFront
distribution in-line in their own stack and reuse `EdgeResources`
for the cert + WAF.

If the sibling construct ships, it ships in a **separate package**
per the opinionated-by-design mandate; it does not generalise this
package.

## Cognito pool replacement — when you must, when you mustn't

`MagicLinkIdentity.cognitoPool` has `RemovalPolicy.RETAIN`. The
retention rule applies in three scenarios worth distinguishing:

- **`cdk destroy` of the identity stack.** The pool, DDB tables,
  SES identity, and `HmacKey` stay. The CFn stack moves to
  `DELETE_COMPLETE`; the orphaned resources stay billable. Manual
  cleanup is required if you actually want them gone.
- **Construct property changes that force a replace.** Cognito
  pools have a long list of immutable properties. Renaming the
  pool, changing the username alias, adding a custom attribute,
  changing the password policy field shape — any of these forces
  CloudFormation to **create a new pool, then delete the old**.
  Under `RETAIN`, CFn will fail to delete the old pool and the
  stack moves to `UPDATE_ROLLBACK_FAILED`. Recovery is manual.
- **Logical-ID changes.** The construct pins `Pool`, `TokenTable`,
  `RateLimitTable`, `DenylistTable`, `SesIdentity` — these MUST
  NOT change across vestibulum-cdk versions. A version bump that
  accidentally renames one of these would force a replace and
  cause the same `UPDATE_ROLLBACK_FAILED` shape.

The bundle-verification CI gate (see
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md))
catches Lambda-code drift but doesn't catch logical-ID drift.
Vestibulum-cdk's CI suite includes a snapshot test on the
identity-stack CloudFormation output to catch logical-ID changes
before release.

### Replace-on-update traps — the prop list

The props that force a pool replace, in one place for operational
reference. Treat any change to one of these on a deployed
`MagicLinkIdentity` as a planned migration, not an in-place update:

| Prop / property                            | Trigger                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signInAliases`                            | Cognito's username-alias config is immutable; any change replaces the pool.                                                                                                              |
| `email` mutable / required status          | Changing the standard-attribute schema (specifically `email`'s `required` / `mutable` flags) forces replacement.                                                                         |
| Password policy field shape                | Adding or removing fields on `passwordPolicy` (vs adjusting values within an existing shape) forces replacement.                                                                         |
| `customAttributes` _additions_             | Cognito custom attributes cannot be added to an existing pool. Plan ahead per the federation-migration discipline in [`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md). |
| `lambdaTriggers` execution-role changes    | Changing the execution role on any of the four `CUSTOM_AUTH` triggers cascades into a trigger-config change that, in some CFn paths, forces pool replacement.                            |

Mirrored in
[`02-magic-link-identity.md § Replace-on-update traps`](02-magic-link-identity.md#replace-on-update-traps)
and cross-referenced from the prop tables in
[`01-package-api.md`](01-package-api.md).

## Log retention

The `LogRetentionRequiredAspect` enforces explicit `logRetention` on
every regional Lambda in the vestibulum-cdk subtree. Defaults shipped
by the constructs:

- Cognito triggers + bounce handler: `RetentionDays.ONE_MONTH` (30 days).
- `auth-verify` / `auth-signout`: `RetentionDays.ONE_MONTH`.
- Lambda@Edge `check-auth`: `RetentionDays.ONE_DAY` (and the role
  cannot write to logs anyway — Mandatory Mitigation 1).

Consumers wanting longer retention pass the constructs custom log
retention via per-handler escape hatches (the construct surface
doesn't expose a single "all handlers" prop today). For shorter
retention, the aspect requires the value to be set explicitly so
"never expire" can't sneak in.

## IAM rotation — consumer-supplied trigger Lambdas

The same-account/same-region check on
`identity.preTokenGeneration` / `postConfirmation` is a synth-time
check, not a runtime check. A consumer who rotates their Lambda's
ARN by:

- Re-creating the function in a different region: caught at synth.
- Re-creating in a different account: caught at synth.
- Re-creating with a new function name in the same account/region:
  not caught — the construct only validates the ARN's account and
  region segments. The Lambda's execution role and behaviour are
  the consumer's responsibility.

Consumers using rotating cross-account roles for shared trigger
Lambdas should design their rotation runbook with the assumption
that the construct does not validate the function's identity beyond
ARN account/region.

## Open questions

- **Per-handler `logRetention` prop on each construct?** Today
  consumers reach the escape hatch and override per-Lambda. A prop
  on the construct would shadow the aspect's default. Probably
  worth adding once a consumer asks.
- **Should the construct emit `CfnOutput`s by default?** Today the
  consumer's stack handles outputs. Pro-emit: less boilerplate.
  Anti-emit: every output is a CFn-stack-export surface that
  consumers may not want polluted. Stays consumer-owned.
- **Bundle-verification on `npm install` (postinstall script)?**
  The standalone-vestibulum docs hinted at an opt-in postinstall
  verification. In the monorepo, postinstall scripts are increasingly
  fraught for security (and npm warns on them). Lean toward
  documenting the manual verification command but not
  auto-running.
