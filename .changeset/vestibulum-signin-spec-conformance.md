---
"@de-otio/vestibulum": minor
"@de-otio/vestibulum-cdk": minor
---

Bring the mailed-link sign-in in line with the passwordless sign-in spec
(dot-notes `doc/topics/passwordless-sign-in-aws/`, invariants `signin_*`).
**Breaking for consumers of the browser flow, the constructs and the lock.**

Security fixes

- **Browser binding.** `/auth-login` no longer returns the Cognito `Session`.
  It keeps it server-side under `SHA-256(b)` and sets `b` as an HttpOnly
  `__Host-signin` cookie; it answers `202 {}`. `/auth-verify` completes only a
  request that carries that cookie, so a forwarded or intercepted link signs
  nobody in and consumes nothing. The body is now `{ "answer": "<token>" }`
  only (no `session`, no `email`). New `MagicLinkIdentity.bindingTable`.
- **Redemption needs a click.** The callback page renders a button and POSTs
  only when it is pressed; it sends nothing on load or while prerendering.
  `/auth-verify` accepts only `POST` with `Content-Type: application/json`.
- **Unknown-user timing.** `CreateAuthChallenge` does the same reads and
  counter write for every caller and waits for a floor (`CREATE_FLOOR_MS`,
  400 ms); `/auth-login` answers the same `202 {}` on every path after
  `SIGNIN_FLOOR_MS` (default 2500 ms, new `MagicLinkAuthSite.signInFloorMs`,
  500-6000). The per-IP limit no longer answers `429`. Measured live, the
  eligible path (SES send inside Cognito's trigger chain) exceeded a 1500 ms
  floor in a third of requests, so the default is 2500 ms; a tail remains
  (about 5% over the floor), so treat the floor as a mitigation, size it per
  stage, and prefer asynchronous issuance where parity must be exact.
- **No enumeration oracle on direct Cognito calls.** The challenge's public
  parameters used to carry the address for real users and Cognito's generated
  username for unknown ones. They are now a constant for every caller.
- **Link expiry is enforced.** `AuthSessionValidity` is set on every app client
  to `tokenTtlMinutes`, which now defaults to **10** (was 15) and must be an
  integer from 3 to 15. Handlers write `expires_at` (the attribute the tables'
  TTL names; they wrote `ttl`), and Verify refuses a row at or past it. A row
  with no `expires_at` fails closed, so links issued before the upgrade stop
  working and must be re-requested.
- **Verify compares before it consumes.** A valid link presented against
  another session no longer burns the token.
- **Sign-out.** The grant is now `cognito-idp:AdminUserGlobalSignOut` (it was
  `GlobalSignOut`, so every revocation was denied and the error was swallowed).
  The user comes from a verified ID token, not an unverified cookie, and works
  with the ID-token cookie alone (the refresh cookie never reaches
  `/auth-signout`). A failed revocation emits a `SignOutRevocation` metric.

Bounces

- A configuration set whose event destination publishes bounces and complaints
  to `bounceTopic` is created and applied to every send; SES is allowed to
  publish to the topic; `ses:SendEmail` is granted on the set as well as the
  identity. The bounce handler reads the `eventType` shape SES uses for
  configuration-set events (it read only `notificationType`), and logs only an
  error name and a hash prefix. Create now honours
  `custom:email_quarantined`. The denylist table gets the TTL attribute its
  365-day expiry always assumed.

Upgrade

- All regional Lambdas and bundles move to `NODEJS_24_X` / node24 (the
  Lambda@Edge functions use `NODEJS_22_X`; the shared-distribution edge
  function was `NODEJS_20_X`).
- `aws-cdk-lib` peer and dev floor is `^2.275.0`; AWS SDK clients `^3.1161.0`.
  `lambda-bundles.lock.json` is regenerated and `vestibulumVersion` now equals
  the package version (a test enforces it).
- `IMagicLinkIdentity` gains required `bindingTable` and `tokenTtlMinutes`.
  Hand-rolled implementations must add them.
- Redeploy the login pages together with the Lambdas: the old pages and the new
  endpoints do not interoperate.
- `auth-verify` no longer holds the token table or denylist (it only deletes
  from the binding table).
