# 03 — `EdgeResources`

The stateless CDK L3 construct that owns the `us-east-1`
cross-region dependencies of a vestibulum-cdk auth-site: the ACM
certificate for the CloudFront distribution and the WAFv2 Web ACL
attached to it. Both resources MUST live in `us-east-1`. The
construct is small — most of its weight is in the WAF default rule
set and the region-pin discipline.

## Why `us-east-1` at all

CloudFront's edge configuration has three resources whose region is
not the consumer's choice:

- **ACM viewer certificate** for the CloudFront distribution: must
  be in `us-east-1`.
- **WAFv2 Web ACL** in `CLOUDFRONT` scope: must be in `us-east-1`.
- **Lambda@Edge functions**: must be authored in `us-east-1`;
  CloudFront then replicates the code globally.

This is a CloudFront constraint, not a vestibulum-cdk one — every
AWS deployment that fronts a distribution with a custom domain and a
WAF lives with it.

`EdgeResources` owns the first two; the Lambda@Edge function lives
inside `MagicLinkAuthSite` (see
[`04-magic-link-auth-site.md`](04-magic-link-auth-site.md)) because
its lifecycle tracks the site, not the cert/WAF.

The three together force the **global stack** in
[`01-package-api.md § Multi-stack handling`](01-package-api.md#multi-stack-handling).
The consumer instantiates `EdgeResources` in that stack and passes
the resulting handle into the regional `MagicLinkAuthSite` via
`crossRegionReferences: true`.

## Resources

| Resource        | Logical ID    | Region      | Notes                                                         |
| --------------- | ------------- | ----------- | ------------------------------------------------------------- |
| ACM certificate | `Certificate` | `us-east-1` | DNS-validated against the consumer's Route 53 hosted zone     |
| WAFv2 Web ACL   | `WebAcl`      | `us-east-1` | Scope: `CLOUDFRONT`. Default rule set per `defaultWafRules()` |

Both resources have `RemovalPolicy.DESTROY` (the resources themselves
are stateless — they can be replaced cleanly). The stateful pieces
of vestibulum-cdk live in `MagicLinkIdentity` instead.

## Region guard — fail fast at synth time

The construct checks `Stack.of(this).region` in its constructor.
Anything other than `us-east-1` (and not a CDK token) throws
immediately:

```typescript
const region = Stack.of(this).region;
if (region && region !== "us-east-1" && !/Token/.test(region)) {
  throw new Error(
    `EdgeResources must be instantiated in a us-east-1 stack ` +
      `(got region '${region}'). CloudFront ACM certificates and ` +
      `CloudFront-scoped WAFv2 Web ACLs are us-east-1-only.`,
  );
}
```

The `/Token/` check lets unit tests with `env: undefined` pass (the
region resolves to a CDK token). Real consumer stacks set
`env.region` explicitly; an explicit non-`us-east-1` value fails at
synth time with a clear message rather than at `cdk deploy` with a
CloudFormation `INVALID_REQUEST` for the wrong region.

## ACM certificate

```typescript
this.certificate = new acm.Certificate(this, "Certificate", {
  domainName: props.domain,
  subjectAlternativeNames: props.subjectAlternativeNames,
  validation: acm.CertificateValidation.fromDns(props.hostedZone),
});
```

- DNS-validated via the consumer's Route 53 hosted zone. The cert
  is provisioned automatically (no human approval step).
- **`subjectAlternativeNames?: string[]`** — optional SAN list on
  the cert. The common reason to set this is to cover both the
  CloudFront distribution (`app.example.com`) and the Cognito
  Hosted UI custom domain (`auth.example.com`) with a single cert.
  See [`07-cdk-changes-from-trellis.md § hostedUiDomain`](07-cdk-changes-from-trellis.md#hosteduidomain)
  for the cert-reuse pattern.
- Consumers with more exotic multi-domain needs (split certs per
  origin, wildcard-with-exclusions) use the L2 `acm.Certificate`
  directly and import the result into `EdgeResources` via the
  `IEdgeResources` interface (see
  [Escape-hatch handles](#escape-hatch-handles) below).
- `RemovalPolicy.DESTROY` — the cert is a stateless artifact;
  destroying and re-creating it across stack rebuilds is fine.

## WAFv2 Web ACL

```typescript
this.webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
  scope: "CLOUDFRONT",
  defaultAction: { allow: {} },
  visibilityConfig: {
    /* metrics on per dimensions */
  },
  rules: props.wafManagedRules ?? defaultWafRules(),
});
```

Default action `allow` with a managed-rule allowlist; consumers who
want default-`block` override `wafManagedRules` entirely.

### The default rule set (`defaultWafRules()`)

Four rules at non-consecutive priorities so consumers can interleave
custom rules without renumbering:

| Priority | Name                                        | Action  | Purpose                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10       | `AWS-AWSManagedRulesCommonRuleSet`          | managed | OWASP-style baseline (XSS, injection patterns, etc.)                                                                                                                                                                                                                              |
| 20       | `AWS-AWSManagedRulesKnownBadInputsRuleSet`  | managed | Known exploit-payload signatures                                                                                                                                                                                                                                                  |
| 30       | `AWS-AWSManagedRulesAmazonIpReputationList` | managed | IP-reputation drop                                                                                                                                                                                                                                                                |
| 50       | `VestibulumAuthRateLimit`                   | `block` | Rate-based statement: **30–60 requests per 5-min window per IP** on `/auth-verify`. Magic-link-pumping guard — every request triggers an SES send + Cognito API call, so the bar is much lower than generic bot-rate-limit. Configurable via `authVerifyRateLimit` (default: 60). |
| 60       | `VestibulumLoginRateLimit`                  | `block` | Looser rate-based statement: **200 requests per 5-min window per IP** on `/login` GET. Generic bot-protection layer; doesn't catch magic-link pumping (`/auth-verify`) but does deter scraping of the login page itself. Configurable via `loginRateLimit` (default: 200).        |

Notes worth re-stating:

- **Why a function, not a const:** WAFv2 `RuleProperty` objects are
  inert data, but the consuming construct (`MagicLinkAuthSite` via
  `EdgeResources`) may mutate the array when it merges in
  consumer-passed overrides. Returning a fresh array each call
  prevents two stacks in the same app from sharing the same
  underlying object.
- **Why two separate rate-limits:** the `/auth-verify` endpoint
  triggers SES sends and Cognito API calls — every request is
  expensive and observable. A 30–60 req/5min/IP cap is tight enough
  that legitimate use (one click on a magic link, plus a few retries
  for typos) passes while pumping attacks fail almost immediately.
  The `/login` GET endpoint serves a static HTML page; 200/5min/IP
  catches scrapers without affecting normal use. Splitting the two
  is the right scale because the threat profiles are different
  (cost-DoS via SES vs reconnaissance scraping).
- **No `AWSManagedRulesATPRuleSet`** by default. ATP is a paid
  managed rule group (monthly fee plus per-request charges) and is
  semantically meaningless on the magic-link flow: the "credential"
  is an opaque random token, there is no password field for ATP to
  inspect. Consumers who want it can opt in via
  `extraWafManagedRuleGroups` (see below).
- The rate-based statements are scoped to specific URI paths so a
  burst of static-site traffic doesn't get blocked.

Consumers can supply their own rule set via `props.wafManagedRules`
— it replaces the default entirely, so passing a single custom rule
removes the AWS-managed rules. Most consumers should `extend`
`defaultWafRules()` rather than replace it.

#### Cost surface — opt-in paid rule groups

```typescript
interface EdgeResourcesProps {
  // ...
  /**
   * Additional AWS-managed rule groups to append to the default
   * rule set. Useful for paid groups (e.g. ATPRuleSet, BotControl)
   * the consumer specifically wants to enable.
   *
   * Each entry is appended at priority 100+; reorder by passing
   * wafManagedRules explicitly.
   */
  extraWafManagedRuleGroups?: ManagedRuleGroup[];
}
```

Common paid groups:

- **`AWSManagedRulesATPRuleSet`** — monthly fee + per-request
  charges. Useful only if a consumer pairs vestibulum-cdk with a
  password-based flow elsewhere; the bundled magic-link path
  cannot benefit from it.
- **`AWSManagedRulesBotControlRuleSet`** — monthly fee + per-request
  charges. Worth considering for high-traffic public sites; less
  useful on the low-traffic internal-site target vestibulum-cdk is
  optimised for.
- **`AWSManagedRulesACFPRuleSet`** (account creation fraud
  prevention) — monthly fee + per-request charges. Could overlap
  with the `PreSignUpFn` rate limiting; benchmark before opting in.

All three are silent recurring bills if defaulted on. The
`extraWafManagedRuleGroups` opt-in keeps the cost-surface decision
on the consumer side, where the rest of the per-MAU / per-request
billing model already lives.

### Visibility config

Each rule has `cloudWatchMetricsEnabled: true` and
`sampledRequestsEnabled: true`. The Web ACL itself also has metrics
enabled, with a metric name derived from the `resourceNamePrefix`
prop (default `'Vestibulum'`) and the consumer's `domain`:

```typescript
visibilityConfig: {
  cloudWatchMetricsEnabled: true,
  metricName: `${prefix}Waf-${props.domain.replace(/\./g, '-')}`,
  sampledRequestsEnabled: true,
},
```

`resourceNamePrefix` is overridable so consumers can avoid the
vestibulum branding in their CloudWatch dashboards. See
[`08-metrics.md § Naming overrides`](08-metrics.md#naming-overrides).

WAF metrics land in `us-east-1`. Consumers who want a cross-region
dashboard pull them via a CloudWatch metric stream.

## Escape-hatch handles

`EdgeResources` implements the `IEdgeResources` handle so a consumer
who needs a non-vestibulum-managed cert or WAF (e.g., one shared
across multiple distributions, or one with a `subjectAlternativeNames`
list vestibulum-cdk doesn't expose yet) can hand-roll a handle:

```typescript
class CustomEdge implements IEdgeResources {
  public readonly certificate: acm.ICertificate;
  public readonly webAcl: wafv2.CfnWebACL;
  // ... construct your own
}

new MagicLinkAuthSite(siteStack, "Site", {
  edge: new CustomEdge(globalStack, "Edge"),
  // ...
});
```

The `IEdgeResources` interface is intentionally minimal — only
`certificate` and `webAcl` — so a consumer hand-rolling it doesn't
have to match an exotic surface.

## Cross-region SSM exposure (consequence of `crossRegionReferences: true`)

CDK implements `crossRegionReferences: true` by writing SSM
parameters in `us-east-1` with predictable names. The ACM cert ARN
and WAFv2 Web ACL ARN travel that way.

**Deploy-role requirement.** The consumer's deploy role needs
`ssm:GetParameter` (and `ssm:PutParameter` on the publishing side) on
`arn:aws:ssm:us-east-1:<account-id>:parameter/cdk/exports/*`, scoped
to the **same account** in **`us-east-1`**. That's the positive
permission statement; no cross-account grant is required for the
cross-region reference mechanism itself. A typical CDK deploy role
already includes this via the `cdk-bootstrap` stack's standard
policies.

**Parameter-name fingerprinting.** SSM parameter names are not
secrets but their pattern (`/cdk/exports/<stack-name>/<export-name>`)
fingerprints vestibulum-cdk-using accounts. Low-risk; documented
for completeness.

## What's deliberately _not_ in `EdgeResources`

- **Lambda@Edge functions.** They live in `MagicLinkAuthSite`
  because their lifecycle tracks the site (CloudFront distribution
  replacement when the edge function changes signature), not the
  cert/WAF.
- **Route 53 record for the CloudFront distribution.** The site
  stack owns the DNS record (an `A`/`AAAA` alias pointing at the
  CloudFront domain), because the CloudFront distribution is in
  the site stack. `EdgeResources` only uses the hosted zone for
  ACM DNS validation.
- **WAF logging configuration.** A consumer who wants WAF logs
  configures a `CfnLoggingConfiguration` on `edge.webAcl` in their
  own stack — WAF log destinations are policy / billing decisions
  that don't belong in the construct's default.
- **A second WAF Web ACL for non-CloudFront resources.** WAFv2 in
  `CLOUDFRONT` scope is the only one we own. Consumers with regional
  ALB/API-Gateway WAF needs use a separate `wafv2.CfnWebACL` in the
  regional stack.

## The `us-east-1` dependency (resolved)

Everything in `EdgeResources` exists because Lambda@Edge must live in
`us-east-1`. An early design question asked whether a **CloudFront
Function** with the JWKS in a CloudFront **KeyValueStore** could
replace Lambda@Edge and collapse the `us-east-1` stack.

**Spike result: not viable for Cognito JWT verification.** CloudFront
Functions JS runtime 2.0 only exposes `crypto.createHash`
(md5/sha1/sha256) and `crypto.createHmac` (md5/sha1/sha256). There
is no RSA verify, no `crypto.verify`, no `crypto.subtle` / WebCrypto.
Cognito signs ID tokens with RS256 (asymmetric RSA-SHA256); without
an RSA-verify primitive in the runtime, a CloudFront Function cannot
cryptographically verify a Cognito JWT. The AWS-samples
[`kvs-jwt-verify`](https://github.com/aws-samples/amazon-cloudfront-functions/tree/main/kvs-jwt-verify)
example sidesteps this by using HMAC, which only works if the
verifier shares the signing secret with the issuer — Cognito does not.

A pure-JS RSA verify would in principle be possible (modexp of
signature against the modulus, compare to padded SHA-256), but the
10 KB code-size cap and the compute-utilisation budget make it
impractical at edge scale, and CloudFront Functions don't expose
`BigInt`.

**Implications:**

- `EdgeResources` stays. `us-east-1` stack is mandatory.
- The Lambda@Edge JWT verifier (`check-auth`) in `MagicLinkAuthSite`
  is the only viable edge-gate shape for the Cognito-issued-JWT
  design.
- The cross-border-transfer surface (Lambda@Edge running in regions
  outside the consumer's chosen residency boundary) is unavoidable
  for this topology; the controller-side mitigation is SCCs + a
  Transfer Impact Assessment.

**A genuinely different future architecture** could swap Cognito-issued
JWTs for **opaque session tokens stored in KVS** — CloudFront Function
reads the cookie, looks up the session in KVS, accepts/rejects without
any signature math. That is feasible within CloudFront Functions
today, but it is a different library (different security model,
different revocation story, different scaling envelope) — out of
scope for `@de-otio/vestibulum-cdk`. Flagged in
[`09-operational-notes.md § Session-token-in-KVS`](09-operational-notes.md#session-token-in-kvs-future-construct-candidate).

## What `EdgeResources` does NOT cover

- **Lambda@Edge `check-auth` wiring** — see
  [`04-magic-link-auth-site.md`](04-magic-link-auth-site.md).
- **CloudFront distribution itself, behaviours, OAC, response
  headers** — also `04-magic-link-auth-site.md`.
