# @de-otio/vestibulum

## 0.3.6

### Patch Changes

- 4bb875d: check-auth: bake Cognito config into the Lambda@Edge gate at deploy time

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

## 0.3.5

### Patch Changes

- Add a server-side **`auth-login`** Function-URL handler that performs the
  magic-link sign-in initiation (SignUp + InitiateAuth) on the backend instead
  of the browser calling Cognito directly, gated by a **per-client-IP rate
  limit** (default 10 / 15 min, keyed on the CloudFront-attested viewer IP).
  This closes the per-IP/volumetric gap on login initiation independently of the
  WAF. New `RuntimeEnv.LOGIN_IP_PER_WINDOW`.
- Harden `create-auth-challenge`: when the app client has
  `PreventUserExistenceErrors` enabled, an unknown address (no `email`
  attribute) now returns a fail-closed challenge instead of throwing — removing
  a user-existence oracle (400 vs 200) on the public InitiateAuth endpoint.

## 0.3.4

### Patch Changes

- Apply the Function-URL cookie fix to the **multi-tenant `shared-distribution`**
  `auth-verify` and `auth-signout` handlers (0.3.3 fixed only the single-tenant
  `handlers/` variants). They returned cookies via
  `multiValueHeaders["Set-Cookie"]`, which Lambda Function URLs (payload format
  2.0) silently drop — so a successful tenant sign-in set no `id-token` cookie.
  Both now return the `cookies` array, which Function URLs emit as `set-cookie`
  headers (per AWS docs, "Invoking Lambda function URLs" § Cookies).

## 0.3.3

### Patch Changes

- Fix the `auth-verify` and `auth-signout` handlers' Set-Cookie response for
  Lambda Function URLs. They returned cookies via `multiValueHeaders["Set-Cookie"]`
  (API Gateway / ALB shape), which Lambda Function URLs (payload format 2.0)
  silently drop — so a successful sign-in set no `id-token` cookie. Both handlers
  now return the `cookies` array, which Function URLs emit as `set-cookie`
  headers (per AWS docs, "Invoking Lambda function URLs" § Cookies). The
  multi-tenant `shared-distribution` variants are unaffected by this change.

## 0.3.2

### Patch Changes

- Fix three related defects in magic-link email hashing that made the bounce/
  complaint denylist non-functional and the `email_hmac` pepper effectively
  public.

  - **HMAC keyed on the secret id, not its value.** `VESTIBULUM_BOUNCE_HMAC_SECRET`
    holds the Secrets Manager **id** (ARN), and the handlers used that string
    directly as the HMAC key — so the pepper was low-entropy and effectively
    public (the ARN appears in IAM policies, the console, CloudFormation), letting
    anyone who knows it brute-force the low-entropy email space from a table
    snapshot. The key is now resolved from Secrets Manager at runtime via
    `GetSecretValue` (cached per warm container), and `MagicLinkIdentity` grants
    `secretsmanager:GetSecretValue` to CreateAuthChallenge and
    VerifyAuthChallengeResponse (the bounce handler already had it).
  - **Denylist read/write hashed differently.** The bounce handler wrote denylist
    entries with a keyed HMAC, but the CreateAuthChallenge quarantine check read
    with a plain **unkeyed** `sha256` — so a bounced/complained address was never
    actually blocked from requesting new magic links.
  - **Inconsistent canonicalisation.** The bounce-handler write did not lowercase
    the address while the reads did, so a mixed-case address would have escaped the
    denylist even once the keys matched.

  All email hashing now funnels through one canonical `hmacEmail(email, key)` that
  always lowercases and always keys, so the issue/verify and write/read sides
  cannot drift. Adds regression tests covering lowercasing, keying, the per-warm-
  container cache, and read==write equality across mixed case.

## 0.3.1

### Patch Changes

- Upgrade the `undici` runtime dependency from 7 to 8. No API or behaviour
  change in vestibulum itself; consumers receive the updated transitive
  dependency.

## 0.3.0

### Minor Changes

- 9a4e9fd: Upgrade major dependency versions.
  - **zod 3 → 4** (`@de-otio/saas-foundation`, `@de-otio/vestibulum`). Foundation
    re-exports zod schemas as public API, so this is a breaking change to the
    published type surface: consumers must also be on zod 4. The `z.ZodType<T, Def, In>`
    three-argument form is replaced by `z.ZodType<T, In>` (the `ZodTypeDef` type
    parameter was removed in zod 4). Runtime schema behaviour is unchanged.
  - **cockatiel 3 → 4** (`@de-otio/saas-foundation`, internal). The `handleWhen`
    predicate now receives `unknown` rather than `Error`; the internal retry
    predicate was widened accordingly. No public API change.
  - **TypeScript 5 → 6** (build toolchain). Node built-in module specifiers and
    `@types/node` are now declared explicitly for the CDK packages.
  - **@prisma/client dev pin 5 → 7** (`@de-otio/saas-foundation` build only). The
    `@prisma/client` peer-dependency range stays `>=5.0.0`; the Prisma-backed
    adapters operate on a consumer-supplied client via structural interfaces, so
    consumers on Prisma 5, 6, or 7 are all supported.

### Patch Changes

- Updated dependencies [9a4e9fd]
  - @de-otio/saas-foundation@0.3.0

## 0.2.0

### Minor Changes

- Add shared-distribution mode: shared Cognito pool + multi-aud Lambda@Edge handler factories, `wrapPreTokenHandler`, `loadClientConfig`. Pure-data tenant onboarding via the admin Lambda.

## 0.1.0

### Minor Changes

- Initial release: magic-link auth, multi-pool JWT verifier, Cognito trigger factories, Lambda@Edge check-auth, admin Lambda bundles, and CDK constructs (MagicLinkIdentity, MagicLinkAuthSite, EdgeResources).
