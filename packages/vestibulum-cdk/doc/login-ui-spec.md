# MagicLinkAuthSite login-UI completion — spec

Status: **draft for review**. The shipped `login-pages/` (login.html, login.css,
login-callback.html) is a non-functional shell: the behavioural JS
(`login.js`, `callback.js`) was never written, the `/login` CloudFront behaviour
serves the wrong S3 key (`login`, not `login.html`), and the page assets are
gated by the default check-auth behaviour. This spec defines the completion.

## Protocol (already implemented server-side — do not change)

Derived from `@de-otio/vestibulum`:
`handlers/create-auth-challenge/magic-link-email.ts` and
`handlers/auth-verify/index.ts`.

1. **Request link** — client calls Cognito `InitiateAuth` (`AuthFlow=CUSTOM_AUTH`,
   `USERNAME=email`). `DefineAuthChallenge`→`CreateAuthChallenge` mints a token,
   stores it, and SES-emails the link. `InitiateAuth` returns a `Session` +
   `ChallengeName=CUSTOM_CHALLENGE`.
2. **Email link** — `https://<domain>/login/callback#token=<token>`. Token is in
   the URL **fragment** (never query — referer/scanner safety). Copy says
   "open in the **same browser** you started in".
3. **Complete** — the callback page reads `#token`, scrubs it with
   `history.replaceState`, and POSTs to `/auth-verify`:
   `{ session, challengeAnswer: token, email }`.
4. **auth-verify** (regional Lambda, behind CloudFront OAC) — Origin-header CSRF
   check (`Origin === https://<domain>`), `RespondToAuthChallenge`
   (CUSTOM_CHALLENGE, session, USERNAME=email, ANSWER=token), then sets
   `id-token` (HttpOnly, Secure, SameSite=Lax, path=/, 15 min) and `refresh-token`
   (path=/auth-verify, SameSite=Strict, 24 h) cookies; returns `200 {ok:true}`.
5. **check-auth** (viewer-request L@E) reads the `id-token` cookie, verifies the
   JWT, and lets the request through (else 302→/login).

Key consequence: the **`Session` + `email` from step 1 must persist in the
browser** until the link is clicked (same browser), because step 3 needs them.
That is what the missing JS must carry.

## Work items (in `@de-otio/vestibulum-cdk`)

### 1. `login-pages/login.js` (new, vanilla — no bundler)
- On `#login-form` submit: read email.
- If `signupMode === 'open'`: `SignUp(email, random throwaway password)` first,
  ignoring `UsernameExistsException` (PreSignUp auto-confirms allowed domains).
  If `admin-invite-only`: skip SignUp.
- `InitiateAuth(CUSTOM_AUTH, USERNAME=email)` via raw `fetch` to
  `https://cognito-idp.<region>.amazonaws.com/` with header
  `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth` (no SDK — keeps
  the page dependency-free).
- Persist `{ session, email }` in `sessionStorage` (cleared after use).
- Show the success message ("check your email"); on error show the generic
  error. Enumeration parity: always show success copy regardless of whether the
  user exists.

### 2. `login-pages/login-callback.js` (new, vanilla)
- Read `token` from `location.hash`; `history.replaceState` to scrub.
- Read `{ session, email }` from `sessionStorage`; if absent, show
  "open the link in the same browser you started in".
- `fetch('/auth-verify', { method:'POST', credentials:'include', body:
  JSON.stringify({ session, challengeAnswer: token, email }) })`. Browser sets
  the `Origin` header automatically (CSRF check passes).
- On 200: clear sessionStorage, redirect to `/` (or a configurable post-login
  path). On 401: show "link expired or already used".

### 3. Runtime config injection (new)
`login.js` needs `region` + `clientId` (+ optional `cognitoEndpoint`,
`postLoginPath`). Inject at deploy via an extra `BucketDeployment` source:
`s3deploy.Source.jsonData("login-config.json", { region, clientId })` (or a
`config.js` defining `window.__VESTIBULUM__`). `login.js`/`callback.js` fetch
`/login/config.json` (covered by the `/login*` behaviour below). The construct
already has the pool + client at deploy time.

### 4. CloudFront routing + asset behaviours (the 403 fix)
- Replace the exact `/login` and `/login/callback` behaviours with a single
  **`/login*`** behaviour → login S3 origin (no check-auth).
- Add a **CloudFront Function** (viewer-request, cheap) on that behaviour that
  rewrites page paths to objects:
  `/login` → `/login.html`, `/login/callback` → `/login-callback.html`;
  everything else (`/login.css`, `/login.js`, `/login-callback.js`,
  `/login/config.json`) passes through unchanged.
- Make asset refs in the HTML **absolute** (`/login.css`, `/login.js`,
  `/login-callback.js`) so they resolve under the `/login*` behaviour rather
  than relative paths that escape it.

### 5. Tests
- Unit: `login.js`/`callback.js` pure helpers (hash parsing, body shape) via the
  same inline-module harness used for the SES-verify handler.
- CDK assertion: a `/login*` behaviour exists, bound to the login origin, with
  the rewrite function and **no** check-auth edge-lambda; `login.js`,
  `login-callback.js`, `login-config.json` are in the BucketDeployment.
- Manual/e2e: browser hits `/` → `/login` (200 HTML) → submit → email → click →
  `/login/callback` → `/auth-verify` 200 → cookie set → `/` serves the app.

## Open decisions for review
1. **Config delivery** — `login-config.json` fetched at runtime (recommended,
   cache-friendly) vs. a templated `config.js` `<script>`. → recommend JSON.
2. **No-SDK raw fetch to Cognito** (recommended, zero-dep static page) vs.
   bundling `amazon-cognito-identity-js` (needs a build step for the pages).
   → recommend raw fetch.
3. **Post-login redirect target** — always `/`, or honour a `redirect` param
   captured by check-auth? → start with `/`, add redirect later.
4. **Scope** — ship as `@de-otio/vestibulum-cdk` 0.3.10.
