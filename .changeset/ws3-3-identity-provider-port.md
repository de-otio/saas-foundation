---
"@de-otio/saas-foundation": minor
---

Add the `IdentityProviderPort` + Keycloak adapter (WS-3.3 identity module)

New `@de-otio/saas-foundation/identity` sub-path: a deliberately minimal,
provider-neutral identity port — `initiateMagicLink(email, opts)` (per-email
rate limiting stays with the API caller) and `deleteUser({ email })`
(absorbing the WS-2 provisional `IdentityAdminPort`, X6) — plus
`KeycloakIdentityProvider`, implementing the phasetwo magic-link REST contract
the G2 spike proved live (service-account client_credentials token,
`send_email=false` — the app owns the sign-in email, `reusable=false`) and
admin ops (get/delete user; sub-preserving `createUser` via `partialImport`
with a fail-not-overwrite collision pre-flight — G2 E-1: `POST /users`
regenerates caller ids). Fail-closed on missing config; injectable
fetch/clock. Additive/non-breaking.

Part of the same coordinated release window as the WS-1/WS-3.1 minors
(single-owner publish, EXECUTION-COORDINATION X3).
