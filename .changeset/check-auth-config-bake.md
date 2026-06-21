---
"@de-otio/vestibulum": patch
"@de-otio/vestibulum-cdk": patch
---

check-auth: bake Cognito config into the Lambda@Edge gate at deploy time

The `check-auth` viewer-request gate shipped with `PLACEHOLDER_*` pool/client/region
config (Lambda@Edge can't read env vars, and consumers supply these as deploy-time
CloudFormation tokens), and its ID-token cookie name had drifted from what
`auth-verify` sets. As a result the gate rejected **every** valid token —
`302 → /login` — and browser login could never complete.

- **vestibulum:** single source of truth for the auth cookie names
  (`ID_TOKEN_COOKIE_NAME` / `REFRESH_TOKEN_COOKIE_NAME`), wired into
  `auth-verify`, `auth-signout`, and the edge `check-auth` gate.
- **vestibulum-cdk:** a `CheckAuthConfigBaker` custom resource injects the
  concrete Cognito config into a pristine copy of the edge bundle at deploy
  time, republishes the function version, and the CloudFront viewer-request
  association points at that baked version. Fails closed if any placeholder
  survives; narrowly-scoped IAM on the single function.
