# 04 — `MagicLinkAuthSite`

The stateless CDK L3 construct: CloudFront distribution with WAF
attached, Lambda@Edge JWT verifier on viewer-request, `auth-verify`
and `auth-signout` Lambda Function URLs gated by CloudFront Origin
Access Control, login-page S3 bucket + `BucketDeployment`, and the
auto-created Cognito website app client. Safe to replace freely.

Composes [`EdgeResources`](03-edge-resources.md) (required prop) for
the `us-east-1` ACM cert + WAF, and
[`MagicLinkIdentity`](02-magic-link-identity.md) (required prop) for
the Cognito pool the website client is attached to and the DynamoDB
tables `auth-verify` reads.

## Resources at a glance

| Resource                      | Logical ID              | Notes                                                                                   |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Cognito website app client    | _via_ `addAppClient`    | OAuth code flow on the Hosted UI (PKCE-style; no client secret)                         |
| `auth-verify` Lambda          | `AuthVerifyFn`          | `lambda.Function` + `Code.fromAsset`, Function URL, OAC-gated                           |
| `auth-signout` Lambda         | `AuthSignoutFn`         | "                                                                                       |
| `check-auth` Lambda@Edge      | `CheckAuthFn`           | `cloudfront.experimental.EdgeFunction` + `Code.fromAsset`, auto-replicated to us-east-1 |
| `check-auth` CloudWatch group | `CheckAuthLogGroup`     | 1-day retention; the role cannot write logs anyway                                      |
| Login-page S3 bucket          | `LoginPageBucket`       | Private, `BlockPublicAccess.BLOCK_ALL`, OAC origin                                      |
| Login-page deployment         | `LoginPagesDeploy`      | `BucketDeployment` of `packages/vestibulum-cdk/login-pages/`                            |
| Response-headers policy       | `ResponseHeadersPolicy` | HSTS, strict CSP, COOP, CORP, Permissions-Policy                                        |
| CloudFront distribution       | `Distribution`          | `PriceClass_100` default, HTTP/2 + HTTP/3, TLSv1.2_2021 minimum                         |

## Cognito website app client

The auto-created app client is provisioned by calling
`identity.addAppClient('WebsiteClient', ...)` so it inherits the
magic-link-compatible flags and TTL defaults from
`MagicLinkIdentity`. See [`05-app-clients.md`](05-app-clients.md) for
the full `addAppClient` spec.

```typescript
this.websiteClient = identity.addAppClient("WebsiteClient", {
  oauth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
    callbackUrls: [`https://${domain}/login/callback`],
  },
  generateSecret: false,
  idTokenValidity: props.idTokenValidity, // overrides pool default
  refreshTokenValidity: props.refreshTokenValidity, // overrides pool default
});
```

`generateSecret: false` is enforced by `DisabledAuthFlowsAspect`
regardless — vestibulum-cdk app clients are public (SPA / browser).
The OAuth code flow is the canonical login path; magic-link runs
through the same client via `CUSTOM_AUTH`.

`MagicLinkAuthSite` exposes the client as `site.websiteClient` (the
underlying `cognito.UserPoolClient`) so downstream IaC can read its
ID and pass it elsewhere.

## `auth-verify` and `auth-signout` Lambdas

Both are `lambda.Function` instances whose code is loaded via
`lambda.Code.fromAsset(...)` from the pre-built bundles produced by
the build script in
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md). The
synth process does not run esbuild and does not require esbuild
permissions on the consumer's deploy role. Both use Function URLs
gated by CloudFront Origin Access Control — direct hits to the
Function URL hostname get 403 at the IAM layer before the handler
code runs.

### `auth-verify`

```typescript
const authVerifyFn = new lambda.Function(this, "AuthVerifyFn", {
  code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda-bundles/auth-verify")),
  handler: "index.handler",
  runtime: lambda.Runtime.NODEJS_22_X,
  reservedConcurrentExecutions: props.reservedConcurrency?.authVerify ?? 20,
  logRetention: logs.RetentionDays.ONE_MONTH,
  environment: {
    [RuntimeEnv.COGNITO_USER_POOL_ID]: identity.cognitoPool.userPoolId,
    [RuntimeEnv.COGNITO_CLIENT_ID]: this.websiteClient.userPoolClientId,
    [RuntimeEnv.DOMAIN]: domain,
  },
});

// IAM: RespondToAuthChallenge scoped to the pool.
authVerifyFn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["cognito-idp:RespondToAuthChallenge"],
    resources: [identity.cognitoPool.userPoolArn],
  }),
);

identity.tokenTable.grantReadWriteData(authVerifyFn);
identity.denylistTable.grantReadData(authVerifyFn);
```

**Behaviour:**

1. Receives the magic-link token from the `/login/callback` page via
   POST (the page reads the token from the URL fragment and POSTs it;
   see Mandatory Mitigation 3 and the login-pages section below).
2. Calls Cognito `InitiateAuth` + `RespondToAuthChallenge` to drive
   the `CUSTOM_AUTH` flow.
3. On success, issues the `Set-Cookie` headers for the
   `HttpOnly`/`Secure`/`SameSite=Lax` ID-token cookie and the
   `HttpOnly`/`Secure`/`SameSite=Strict` refresh-token cookie (scoped
   to `/auth-verify` for refresh-only).
4. On any failure (replay, expiry, condition fail, timing mismatch),
   returns the same generic error response — see
   [`02-magic-link-identity.md § VerifyAuthFn`](02-magic-link-identity.md#verifyauthfn).

### `auth-signout`

Same shape as `auth-verify`, but the IAM scope is `GlobalSignOut`
only:

```typescript
authSignoutFn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["cognito-idp:GlobalSignOut"],
    resources: [identity.cognitoPool.userPoolArn],
  }),
);
```

**Behaviour:**

1. Calls Cognito `GlobalSignOut` — revokes the refresh token
   server-side so subsequent refresh attempts fail.
2. Emits `Set-Cookie` headers that expire the ID-token and
   refresh-token cookies.
3. The residual ID-token cookie remains valid at the edge until its
   expiry (15 min default). Consumers needing near-real-time
   revocation use a denylist pattern in Lambda@Edge — see
   [`05-app-clients.md § Token TTL hierarchy`](05-app-clients.md#token-ttl-hierarchy).

Reserved concurrency defaults: `auth-verify` **20**, `auth-signout`
**5** (cost-DoS guard; prop-overridable via `reservedConcurrency`).
The auth-verify default was lowered from 50 to 20 in line with the
cost-DoS envelope below — 20 concurrent verifications still covers
the legitimate burst for a low-traffic internal site while halving
the worst-case Lambda + CloudFront cost under attack.

> **Cost-DoS cap, not a perf tuning knob (N5).** The `auth-verify`
> reservation (20) is doing real cost-DoS work — it is the
> load-bearing defence after the WAF rate-limit. Raise only after you
> have raised the WAF rate-limit and verified the new envelope. A
> bump to 200 to "fix a throttling alarm" silently widens the cost-DoS
> envelope by 10×.

> **Cost-DoS cap, not a perf tuning knob (N5).** The `auth-signout`
> reservation (5) is also a cost-DoS cap. Sign-out is a cold path;
> raise only after you have raised the WAF rate-limit and verified
> the new envelope.

### Cost-DoS envelope

The auth-verify path is the most expensive request shape vestibulum-cdk
exposes — every call invokes Lambda@Edge `check-auth`, then a
regional Function URL `auth-verify` Lambda, then Cognito
`InitiateAuth` + `RespondToAuthChallenge`, and (when the flow
completes a `CreateAuthChallenge`) an outbound SES `Send` carrying
the magic-link email. Under sustained attack the cost surface is:

- **CloudFront request charges** — per-request, billed at CloudFront
  rates. The cheapest line item in this stack.
- **Lambda@Edge invocations** — billed per request and per GB-second.
  Replicated across edge regions, so a single attacker IP can hit a
  geographically close edge while another hits a far edge.
- **Regional Lambda invocations** — `auth-verify` Function URL,
  bounded above by `reservedConcurrentExecutions: 20`. The
  reservation is the load-bearing concurrency cap; beyond 20 in
  flight, callers get throttled responses.
- **Cognito API calls** — `InitiateAuth` / `RespondToAuthChallenge`
  are billed per MAU once the free tier is exceeded. An attack that
  drives synthetic MAU is the most expensive case.
- **SES sends (cost-pillar S7).** The outbound side, brought inside
  the envelope when `costDosGuard.enabled` is set on
  `MagicLinkIdentity` / `SharedDistributionIdentity`. Line items at
  risk:
  - **Direct send cost** — ~$0.10 per 1,000 outbound (above the EU
    free tier).
  - **Reputation damage** — bounce rate climbing toward Cognito
    feature-plan / sandbox-revocation thresholds. Operationally
    expensive to recover from; one-way ratchet on poor reputation.
  - **Customer-support volume** — confused legitimate users
    contacted by your transactional mailer demand investigation.

**Layered controls (cheapest first):**

1. **WAF rate-limit (primary, inbound).** The
   `VestibulumAuthRateLimit` rule on the auth path (see
   [`03-edge-resources.md § Default rule set`](03-edge-resources.md#the-default-rule-set-defaultwafrules))
   blocks per-IP request bursts at the CloudFront edge before any
   Lambda is invoked. 60 requests / 5 min / IP at the construct
   default.
2. **Reserved concurrency caps (secondary, inbound).** `auth-verify`
   = 20 and `auth-signout` = 5, both prop-overridable via
   `reservedConcurrency`. See the N5 callouts above — these are
   cost-DoS caps, not perf tuning knobs.
3. **SES `Send` alarm (tertiary, outbound — opt-in via S7).** A
   CloudWatch alarm on `AWS/SES` `Send` dimensioned by the pool's
   SES domain identity, threshold `costDosGuard.sendsPerHourCap`.
   Catches the case where an attacker has enough IP diversity to
   slip past WAF and stays under the concurrency cap on each IP.
4. **Self-defence handler (quaternary, outbound — opt-in via S7
   `selfDefence: true`).** Subscribes to the alarm's SNS topic; on
   alarm-state, calls Cognito `UpdateUserPool` to disable
   self-sign-up pool-wide (sets `AdminCreateUserConfig.
   AllowAdminCreateUserOnly: true`). Operators re-enable via the
   AWS console / API once the attack subsides.

Consumers running this construct in production should:

- Keep the WAF rate-limit at the construct default unless they have
  measured traffic justifying a looser limit.
- Configure CloudWatch alarms on
  `authVerifyErrors` and `edgeAuthDenies`
  (see [`08-metrics.md`](08-metrics.md)) to detect the cost-spike
  signal.
- Resist raising `reservedConcurrentExecutions` past ~50 without a
  legitimate-burst reason; the cost ceiling scales with the cap.
- Set `costDosGuard: { enabled: true, sendsPerHourCap: ... }` on the
  Identity construct once legitimate-traffic baseline is known — the
  outbound side is otherwise unmonitored and unbounded.

### Function URL + CloudFront OAC

Both Function URLs use `AuthType: AWS_IAM` (required for OAC). The
CloudFront behaviour uses `FunctionUrlOrigin.withOriginAccessControl(url)`,
which:

- creates a CloudFront `OriginAccessControl` configured for SigV4
  (`signing-behavior: always`, `signing-protocol: sigv4`);
- adds a resource-based policy on the Lambda granting
  `lambda:InvokeFunctionUrl` only to `cloudfront.amazonaws.com` with
  the `AWS:SourceArn` condition scoped to this distribution's ARN.

Direct calls to the Function URL hostname get 403 at the IAM layer
before any handler code runs — attackers cannot reach the Lambda by
bypassing CloudFront / WAF.

**POST/PUT caveat:** OAC requires the _client_ to include
`x-amz-content-sha256: <hex-sha256-of-body>` on POST and PUT requests
so SigV4 can sign the payload. The bundled `login.js` / `callback.js`
compute the hash via `crypto.subtle.digest('SHA-256', body)` and send
it on every fetch; consumers replacing the login pages must preserve
this.

This replaces an earlier (pre-vestibulum-cdk) design that used a
synth-time shared header secret stored in SSM SecureString
(`X-Vestibulum-Origin-Token`) that handlers validated. OAC obsoletes
that mechanism — no secret to store, rotate, audit, or fetch at
runtime, and no SSM-SDK dependency in the Lambda bundle.

## `check-auth` Lambda@Edge

The viewer-request gate. Verifies the Cognito JWT cookie before the
request reaches the consumer's origin.

```typescript
const checkAuthFn = new cloudfront.experimental.EdgeFunction(this, "CheckAuthFn", {
  runtime: lambda.Runtime.NODEJS_20_X, // Lambda@Edge runtime coverage
  handler: "index.handler",
  code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda-bundles/check-auth")),
});
```

`EdgeFunction` itself wraps the cross-region replication; the asset
is the pre-built bundle from
[`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md), which
has `drop: ['console']` applied at build time (Mandatory Mitigation 1
enforced in the bundled bytes) and inlines `aws-jwt-verify` (no
runtime `MODULE_NOT_FOUND`).

Authored in `us-east-1` (CDK's `EdgeFunction` handles the cross-region
replication via its own internal stack); CloudFront then replicates
the code to every edge region.

### Mandatory Mitigation 1 — log suppression

The edge role grants **no** `logs:*` action. The default
`AWSLambdaBasicExecutionRole` managed policy is stripped via L1
override:

```typescript
const cfnRole = edgeRole.node.defaultChild as iam.CfnRole;
cfnRole.managedPolicyArns = []; // strip AWSLambdaBasicExecutionRole

edgeRole.addToPrincipalPolicy(
  new iam.PolicyStatement({
    sid: "PutVestibulumMetrics",
    actions: ["cloudwatch:PutMetricData"],
    resources: ["*"],
    conditions: {
      StringEquals: { "cloudwatch:namespace": "Vestibulum/AuthSite" },
    },
  }),
);
```

Only `cloudwatch:PutMetricData` is allowed, scoped to the
`Vestibulum/AuthSite` namespace via an IAM condition.

The edge bundle is built with `drop: ['console']` (see
[`10-lambda-bundle-pipeline.md § Lambda@Edge specifics`](10-lambda-bundle-pipeline.md#lambdaedge-specifics)),
so the published bytes contain no `console.*` call sites at all. A
CI integration test grep'd the bundle for `console.` as
defence-in-depth; both mechanisms catch the same class of regression
independently. An auto-created CloudWatch log group with 1-day
retention is provisioned as belt-and-braces; the role cannot write
to it anyway.

This is the load-bearing data-residency mitigation: Lambda@Edge runs
in every CloudFront edge region globally, and CloudWatch Logs from
those regions would create cross-border data flows outside the
consumer's chosen residency boundary. The IAM shape is the
mechanical enforcement.

### Verifier behaviour

The bundled `check-auth` uses `aws-jwt-verify` (Cognito-aware,
strict `alg` allow-list). Guarantees:

- **`alg` allow-list = `RS256` only.** Rejects `none`, `HS*`, and any
  unexpected algorithm (closes the classic `alg: none` /
  HS256-key-confusion holes).
- `kid` required; must match the cached JWKS.
- Issuer = `https://cognito-idp.<region>.amazonaws.com/<poolId>`,
  audience = website client ID, `exp`/`iat`/`nbf` checked with
  ≤60 s clock skew.
- **Fail-closed** on JWKS unavailability — return 401 rather than
  allow.
- **JWKS caching:** in-memory cache with hard 1 h TTL. Cognito
  rotates JWKS rarely (≈once a year in normal operation); cache-miss
  fetches go to the pool's `.well-known/jwks.json`.

On verify success, the edge function passes the request to the
origin. On failure, it returns a 302 redirect to `/login`.

### Multi-region JWKS resolution

The verifier needs to know which region's Cognito issuer to fetch
JWKS from. The edge function reads the issuer region from the JWT's
`iss` claim — extracting the region from
`https://cognito-idp.<region>.amazonaws.com/<poolId>`. Hard-coded
region in the bundled config would defeat multi-region pool
deployments; the `iss`-driven resolver is the bundled default.

## Login-page S3 bucket + deployment

```typescript
const loginPageBucket = new s3.Bucket(this, "LoginPageBucket", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

new s3deploy.BucketDeployment(this, "LoginPagesDeploy", {
  sources: [s3deploy.Source.asset(/* bundled login-pages directory */)],
  destinationBucket: loginPageBucket,
  prune: true,
});
```

The bundled login pages are:

- `login.html` — the email-entry page. Submits to `/auth-verify` to
  start `CUSTOM_AUTH`.
- `login-callback.html` — the post-magic-link landing page. Reads
  the token from the URL fragment, **scrubs the fragment via
  `history.replaceState`** before any other code runs (Mandatory
  Mitigation 3 — prevents bookmark / copy-URL / browser-back leak),
  POSTs the token to `/auth-verify`, follows the resulting redirect.
- `login.css` — minimal styling, no third-party fonts or scripts.

`prune: true` removes stale pages from the bucket on deployment, so
a consumer downgrading vestibulum-cdk doesn't end up with orphan
files.

### Consumer overrides

`props.loginPageBucket` lets a consumer pre-create the bucket and
deploy their own HTML. This is the right escape hatch when:

- the consumer declares `customAttributes` the signup flow must
  populate beyond `email` (see
  [`09-operational-notes.md § Custom attributes`](09-operational-notes.md#custom-attributes-and-loginpagebucket-coupling));
- the consumer needs branded styling, SSO branding rules, or i18n;
- the consumer needs the callback page to do extra work (telemetry,
  feature-flag fetch, etc.) before submitting to `/auth-verify`.

Consumers replacing the pages MUST preserve:

- The fragment-scrub via `history.replaceState`.
- The `x-amz-content-sha256` header on every fetch (OAC requirement,
  see above).
- The cookie-fail-closed behaviour (no fallback to URL token after
  the scrub).

## Response-headers policy

The response-headers policy name uses the `resourceNamePrefix`
prop (default `'Vestibulum'`) so consumers can avoid the vestibulum
branding leaking into resource names:

```typescript
new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
  responseHeadersPolicyName: `${prefix}AuthSite-${region}-${domain.replace(/\./g, '-')}`,
  securityHeadersBehavior: {
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(730),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentSecurityPolicy: {
      contentSecurityPolicy: /* strict default CSP */,
      override: true,
    },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: DENY, override: true },
    referrerPolicy: { referrerPolicy: STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
  },
  customHeadersBehavior: {
    customHeaders: [
      { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
      { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
      { header: 'Permissions-Policy', value: /* deny camera, geo, mic, payment, usb */, override: true },
    ],
  },
});
```

Default CSP:

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

Strict by default. Consumers with origins that need looser CSP (e.g.,
Quartz with inline Lunr) override `props.responseHeadersPolicy`
entirely — see
[`09-operational-notes.md § Quartz-friendly CSP`](09-operational-notes.md#quartz-friendly-csp).

## CloudFront distribution

```typescript
this.distribution = new cloudfront.Distribution(this, "Distribution", {
  domainNames: [domain],
  certificate: edge.certificate,
  webAclId: edge.webAcl.attrArn,
  priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_100,
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  // ... behaviours below
});
```

### Behaviours

Five behaviours, in path-specificity order:

| Path              | Origin                                                         | Lambda@Edge                 | Cache               | Methods                            |
| ----------------- | -------------------------------------------------------------- | --------------------------- | ------------------- | ---------------------------------- |
| `/login`          | `LoginPageBucket` via `S3BucketOrigin.withOriginAccessControl` | _none_                      | `CACHING_DISABLED`  | `GET`, `HEAD`                      |
| `/login/callback` | `LoginPageBucket` via OAC                                      | _none_                      | `CACHING_DISABLED`  | `GET`, `HEAD`                      |
| `/auth-verify*`   | `authVerifyFn` Function URL via OAC                            | _none_                      | `CACHING_DISABLED`  | `ALL`                              |
| `/auth-signout`   | `authSignoutFn` Function URL via OAC                           | _none_                      | `CACHING_DISABLED`  | `ALL`                              |
| `default` (`/*`)  | `props.origin` (consumer)                                      | `check-auth` viewer-request | `CACHING_OPTIMIZED` | `GET`, `HEAD` (CloudFront default) |

Notes:

- The login pages and the auth endpoints intentionally **bypass** the
  `check-auth` Lambda@Edge — they are the entry points to the auth
  flow. Adding the edge gate to `/login` would force a redirect loop.
- The default behaviour applies the edge gate to **all** other paths,
  including arbitrary sub-paths the consumer's origin serves.
  Consumers who want to expose a `/public/*` carve-out add an extra
  behaviour after construction:
  `site.distribution.addBehavior('/public/*', publicOrigin, { ... })`
  with no `edgeLambdas`.

### TLS posture

- `minimumProtocolVersion: TLS_V1_2_2021` — disallows TLSv1.0/1.1 and
  weak ciphers (the AWS-recommended minimum for modern CloudFront).
- `httpVersion: HTTP2_AND_3` — enables HTTP/3 (QUIC) negotiation
  alongside HTTP/2 fallback.
- All viewer-protocol policies are `REDIRECT_TO_HTTPS`.

## Sign-up mode

`signupMode` is owned by `MagicLinkIdentity`, not by
`MagicLinkAuthSite`. The Identity holds the single `PreSignUpFn`,
so the Identity owns the policy that drives it. The federation-aware
default ("error if federationEnabled and signupMode unset") and the
behaviour matrix are documented in
[`02-magic-link-identity.md § Signup mode`](02-magic-link-identity.md#signup-mode-propssignupmode).

`MagicLinkAuthSite` does not accept a `signupMode` prop. The
construct does not call any private setter on the Identity — the
Identity's behaviour is fully determined by its own props at
construct-construction time, consistent with the "Identity is
stateful, deploy rarely" lifecycle promise.

## Origin shape

`props.origin` is a standard CloudFront `IOrigin`. Typical:

- **Private S3 bucket** via `S3BucketOrigin.withOriginAccessControl(bucket)`.
  The construct does not create the bucket — consumers want control
  over versioning, lifecycle, encryption keys.
- **ALB origin** — `HttpOrigin('alb-dns-name')` with an `OriginAccessControl`
  for ALB-to-CloudFront SigV4. Rarer; the construct is shaped for
  static origins.

The construct attaches the `check-auth` edge gate on the default
behaviour regardless of origin type — the JWT verification is origin-
agnostic.

## CloudFormation outputs

The construct does not emit `CfnOutput`s itself. Consumers typically
output:

- `site.distribution.distributionDomainName` — for DNS records.
- `site.authVerifyUrl.url` — for clients that need to call the
  endpoint directly (rare).
- `site.websiteClient.userPoolClientId` — for downstream IaC.

## What `MagicLinkAuthSite` does NOT cover

- **Cognito pool, DynamoDB tables, SES, and the four `CUSTOM_AUTH`
  triggers** — see [`02-magic-link-identity.md`](02-magic-link-identity.md).
- **The ACM cert and WAF Web ACL in `us-east-1`** — see
  [`03-edge-resources.md`](03-edge-resources.md).
- **Adding additional Cognito app clients** — see
  [`05-app-clients.md`](05-app-clients.md).
- **Route 53 alias record pointing at the CloudFront distribution** —
  the consumer's stack owns it. Typically:
  `new route53.ARecord(this, 'Alias', { zone, recordName: domain,
target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(site.distribution)) })`.

## SES cost-DoS guard (cost-pillar S7)

The cost-DoS envelope above documents WAF rate-limit + reserved
concurrency as the inbound defences for `auth-verify`. They do not
defend the *outbound* side — a request that clears the rate-limit
and the concurrency cap triggers an SES `Send`. The `costDosGuard`
prop on [`MagicLinkIdentity`](02-magic-link-identity.md) and
[`SharedDistributionIdentity`](../vestibulum/shared-distribution/02-construct-api.md)
brings SES inside the documented envelope.

### Prop spec

```typescript
interface CostDosGuardProps {
  // Activate the guard. When false (or the prop is omitted), neither
  // the alarm nor the self-defence handler is provisioned. Default
  // (prop unset): no alarm, no handler — current behaviour preserved.
  enabled: boolean;

  // Threshold for the per-pool SES Send alarm, in sends per hour.
  // Required when enabled: true.
  sendsPerHourCap: number;

  // When true, deploy the self-defence handler that disables Cognito
  // self-sign-up on alarm. Default false — alarm-only.
  selfDefence?: boolean;

  // SNS topic to receive the alarm. When omitted, an internal topic
  // is created and exposed as `identity.costDosGuard.alarmTopic`.
  alarmTopic?: sns.ITopic;
}
```

### Worked example: setting `sendsPerHourCap`

For an auth flow seeing **N** legitimate sends/hour at peak, set
`sendsPerHourCap` to **5–10 × N**. Tune well above any plausible
legitimate spike, well below any cost-disaster level. Examples:

- Internal-staff app seeing 20 legitimate logins/hour at peak →
  `sendsPerHourCap: 100–200`.
- Public consumer app seeing 2,000 sign-ins/hour at peak →
  `sendsPerHourCap: 10,000–20,000`.

Tune by observing the SES `Send` metric for two weeks before
flipping the prop on. The alarm trips at threshold; tripping it once
under legitimate load is operator-disruptive (especially with
`selfDefence: true` which gates further sign-up).

### SNS topic destination

When `alarmTopic` is omitted, the construct auto-creates a dedicated
topic named `CostDosAlarmTopic` and exposes it as
`identity.costDosGuard.alarmTopic`. Operators typically:

1. **Reuse an existing alarm topic.** Pass the same SNS topic the
   rest of the stack's operator alarms publish to so there is one
   pager-on-call endpoint to maintain.
2. **Add a human-readable subscription.** The auto-created topic has
   no subscribers — the self-defence handler subscribes itself when
   `selfDefence: true`, but a human-targeted subscription (email,
   PagerDuty, Slack via Chatbot) is required for the operator-only
   variant.

### Self-defence handler — admin Cognito action

When `selfDefence: true`, the construct deploys a tiny Node.js 22
ARM64 Lambda (128 MB, 30 s timeout, reserved concurrency 1, inline
code) that subscribes to the alarm's SNS topic. On every
`ALARM`-state notification, the handler calls Cognito
`UpdateUserPool` to flip
`AdminCreateUserConfig.AllowAdminCreateUserOnly: true` on the
pool — which disables self-sign-up. New sign-up attempts fail before
the PreSignUp trigger runs; no further magic-link emails are emitted
on the sign-up path.

**Why admin Cognito action, not env-var feature flag:** mutating a
deployed Lambda's environment in response to a runtime signal
creates IaC drift (the next `cdk deploy` resets it) and is
intrusive. Disabling self-sign-up via `UpdateUserPool` is the
canonical Cognito admin action for exactly this scenario, leaves a
single auditable CloudTrail event, and is undone with one further
admin call (or a click in the AWS console) when the attack subsides.

The handler is idempotent — subsequent invocations while sign-up is
already disabled are no-ops. The IAM grant is scoped to
`cognito-idp:DescribeUserPool` + `cognito-idp:UpdateUserPool` on the
pool ARN only.

### Defaults preserved

When `costDosGuard` is unset (or `enabled: false`), no alarm, no
handler, no SNS topic, no IAM grants — the previous behaviour is
byte-identical. The CloudFormation template diff for an existing
stack adopting this prop change is restricted to the three new
resources (alarm + topic + optional handler).

## Open questions

- **Should `MagicLinkAuthSite` create the Route 53 alias record?** The
  consumer's stack does it today. Pro-create: less boilerplate.
  Anti-create: the consumer may want to apex-alias vs subdomain,
  or override TTL. Probably keep it consumer-owned.
- **A second WAF in the regional stack for the auth Lambdas?** Today
  the Function URLs are gated by OAC; only requests that come via
  CloudFront reach them, so the CloudFront WAF is the only WAF
  needed. A second regional WAF would add cost and complexity
  without a new security guarantee. Stays as-is.
- **Path-based caching tweaks for HEAD vs GET on the default
  behaviour?** The default is `CACHING_OPTIMIZED` which keys on
  query string. Some origins want different caching for different
  paths. Today the consumer adds behaviours after construction;
  exposing a cleaner prop is future work.

## S3 lifecycle defaults (cost-pillar S4)

The auto-created `LoginPageBucket` ships with a default S3 lifecycle
policy. The login pages are immutable static assets that are read
rarely after the first CloudFront edge cache fill, so the default
shape favours storage-cost reduction over retrieval performance:

| Rule property                          | Default            |
| -------------------------------------- | ------------------ |
| `abortIncompleteMultipartUploadAfter`  | 7 days             |
| Transition: Standard → Standard-IA     | After 30 days      |
| `noncurrentVersionExpiration`          | 90 days            |

**Why these defaults:**

- `abortIncompleteMultipartUpload` is essentially free savings. AWS
  bills stranded multipart-upload parts indefinitely until they are
  explicitly aborted. Seven days is the conventional cut-off — any
  legitimate `BucketDeployment` upload completes well within that
  window.
- The Standard → Standard-IA transition is roughly half the per-GB
  storage cost (S3 Standard ~$0.023/GB-month vs Standard-IA
  ~$0.0125/GB-month in us-east-1, as of 2026). Standard-IA charges
  a per-GB retrieval fee, which is irrelevant when CloudFront caches
  the assets at the edge — the bucket is hit on cache-miss and
  invalidation only.
- The noncurrent-version expiration is a no-op while versioning is
  off (the default), but is cheap insurance if a consumer turns
  versioning on later — the bucket never accumulates an unbounded
  history of overwritten login pages.

### Overriding the default

The `lifecycle` prop accepts an optional `BucketLifecycleProps`:

```typescript
new MagicLinkAuthSite(stack, "Site", {
  // ...other props...
  lifecycle: {
    rules: [
      {
        id: "consumer-cold-archive",
        enabled: true,
        abortIncompleteMultipartUploadAfter: Duration.days(3),
        expiration: Duration.days(365),
      },
    ],
  },
});
```

**Override semantics (matches the package's existing pattern for
`responseHeadersPolicy`, `loginPageBucket`, etc.):**

- `lifecycle` omitted → defaults apply.
- `lifecycle: { rules: [] }` → lifecycle is explicitly disabled (no
  rules attached to the bucket). Use this for cold-as-operational
  workloads where the per-GB retrieval fee from Standard-IA would
  exceed the storage savings.
- `lifecycle: { rules: [...non-empty] }` → the consumer rules
  replace the default entirely (replace semantics, not merge — pass
  the abort-multipart rule explicitly if you want to keep it).

The `lifecycle` prop has **no effect** when `loginPageBucket` is
consumer-supplied: the construct does not mutate a bucket it did
not create. Configure the lifecycle on your own bucket directly.

The same default and override surface is also wired into
`SharedDistributionIdentity`'s
[`CloudFrontDistribution`](../vestibulum/shared-distribution/01-architecture.md)
auto-created login-page bucket, with identical semantics.
