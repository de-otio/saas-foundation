# 05 — Wildcard cert + wildcard DNS

The prerequisites that make pure-data onboarding possible. Without
wildcard cert + wildcard DNS, every new tenant requires (a) an ACM
cert SAN add and (b) a DNS record provisioning — both of which
require AWS API calls plus propagation waits, putting them firmly
in "deploy, not data" territory.

## ACM wildcard cert

Required: a single ACM certificate in **us-east-1** (CloudFront
requirement) covering `*.<tenantSubdomainParent>`.

```typescript
// In SharedDistributionIdentity constructor:
const cert = new acm.Certificate(this, 'WildcardCert', {
  domainName: `*.${props.tenantSubdomainParent}`,
  // Also include the parent itself? See below.
  subjectAlternativeNames: [props.tenantSubdomainParent],
  validation: acm.CertificateValidation.fromDns(props.hostedZone),
});
```

Notes:

- **Single-level wildcard only.** `*.tenants.example.com` matches
  `acme.tenants.example.com` but **not**
  `eu.acme.tenants.example.com`. ACM does not support
  multi-level wildcards (`*.*.example.com`). Tenants needing
  two-level subdomain structures need either separate wildcard
  certs per intermediate level or different design (out of scope).
- **Cert renewal is automatic.** ACM-managed certs renew without
  operator intervention provided the DNS validation records remain
  in place (Route 53 hosted-zone provides them automatically; if
  the consumer manages DNS elsewhere, they must keep the CNAME
  validation records persistent).
- **us-east-1 is non-negotiable for CloudFront.** Edge certs come
  from us-east-1 regardless of the rest of the deployment's home
  region (typically eu-central-1 for the EU-residency posture).
  The construct uses `acm.DnsValidatedCertificate` cross-region
  variant or pre-deployed cert via `existingWildcardCertificateArn`
  prop.
- **The parent domain (`tenants.example.com` itself) is optional
  in the SAN list.** If included, the apex of the tenant space
  also gets the cert — useful if the consumer wants a landing
  page at the parent that says "you need a tenant subdomain to
  proceed". If omitted (recommended), the parent doesn't get a
  valid cert and browsers visiting `https://tenants.example.com`
  see a name-mismatch error — a clean "no, you're not in the
  right place" UX. Decide per consumer; default: include.

## Wildcard DNS

Required: an A-alias (or AAAA-alias) record for
`*.<tenantSubdomainParent>` pointing to the CloudFront distribution.

```typescript
// In SharedDistributionIdentity constructor, if hostedZone provided:
new route53.ARecord(this, 'WildcardA', {
  zone: props.hostedZone,
  recordName: `*.${props.tenantSubdomainParent.replace(/\.[^.]+\.[^.]+$/, '')}`,
  // e.g. for tenants.example.com in zone example.com → '*.tenants'
  target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
});
new route53.AaaaRecord(this, 'WildcardAAAA', { /* ... */ });
```

If the consumer doesn't pass a `hostedZone`:

- **They manage DNS themselves.** The construct outputs the
  CloudFront distribution domain (`d111111abcdef8.cloudfront.net`);
  the operator creates a wildcard CNAME `*.<parent>` → that
  hostname at their DNS provider.
- **Wildcard CNAMEs have an edge case at the parent.** Some DNS
  providers don't allow CNAMEs at the apex of a delegated zone.
  Operators may need to choose: ALIAS (provider-specific), or a
  one-record-per-tenant approach (defeating wildcards). For
  Route 53 the A-alias avoids this. The construct documents
  Route 53 as the recommended provider; other providers are
  supported but with caveats called out in the ops runbook.

## Reserved subdomains

Default reserved list (admin Lambda rejects these as tenant
subdomains):

```
admin     # the admin portal, if the consumer builds one
www       # the consumer's main landing page
api       # API endpoints, if any
cdn       # CDN-fronted static assets
static    # ditto
auth      # generic auth landing
mail      # webmail or marketing
ftp       # legacy
localhost # blocked for sanity
```

Consumers can extend or replace this list via
`SharedDistributionIdentityProps.reservedSubdomains`. The default
covers the most common collisions.

## Single-level constraint and the subdomain pattern

The default `tenantSubdomainPattern`:

```typescript
/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/
```

Rationale:

- DNS-label-shaped: must match what ACM and CloudFront accept as
  a domain label.
- Lowercase: cookie domain matching is case-insensitive in
  browsers but lowercasing on creation avoids any normalisation
  drift between Cognito attributes, JWT claims, and the edge's
  Host parse.
- Leading letter: many DNS resolvers historically rejected numeric
  prefixes; safer to require alpha-start.
- 3–64 characters: matches Cognito user pool client name constraints
  (1–128) and is well under DNS label max (63).
- No trailing dash: DNS-invalid.

Operators with stricter or looser requirements override the
pattern via the construct prop. The pattern is also enforced at
the **edge** (subdomain extraction returns null on non-matching
labels) to defend against an admin Lambda misconfiguration.

## Cert rotation: what happens, what the consumer notices

ACM auto-rotates certs ~60 days before expiry. The new cert is
attached to CloudFront automatically via the cert ARN reference;
no consumer action needed.

Failure mode: ACM's DNS validation can fail if the validation
records were removed from the zone (or the zone was deleted, or
the consumer migrated DNS providers and didn't carry the records
across). ACM emits a warning event 45 days before expiry and an
alarm 30 days before. Construct ships a CloudWatch alarm on
`AWS/CertificateManager DaysToExpiry < 30` wired to the
configured alarm topic; if the consumer doesn't pass one, the
alarm is created but not subscribed (operator-visible by polling).

Manual rotation: the construct supports
`SharedDistributionIdentityProps.existingWildcardCertificateArn`
so the consumer can pre-bake a cert (e.g. one with an organisation
validation chain rather than DNS validation) and pass it in. The
construct doesn't manage that cert's lifecycle.

## DNS provider failure modes

| Failure                                          | Effect on tenants                                              | Recovery                                |
| ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------- |
| Route 53 hosted zone deleted                     | All tenants → DNS resolution fails → site unreachable           | Restore zone from backup                |
| Wildcard A-record deleted                        | Same                                                            | Recreate the record                     |
| Cert DNS-validation records deleted               | Cert renewal fails at next 60-day cycle (delayed effect)        | Recreate validation records             |
| DNS provider outage                              | All tenants → resolution fails per provider's outage scope     | Wait for provider; CloudFront still up  |
| CloudFront distribution disabled                 | All tenants → 403 / connection refused                          | Re-enable in console / CDK redeploy     |
| ACM cert revoked or expired                      | All tenants → browser-side cert error                           | Issue new cert, update distribution     |

These are single-blast-radius failures by design. Tenants
contracted for hard isolation get their own identity (and their
own cert + DNS path); see
[`07-security-and-isolation.md`](07-security-and-isolation.md).

## Cost

Single CloudFront, single cert, single wildcard DNS record. The
cost story is "fixed cost regardless of tenant count" — the
opposite of the prototype's "linear in tenant count" model. For
50+ tenants, this is significantly cheaper:

- N CloudFront distributions: $N × ~$1/month minimum charges +
  per-request fees.
- 1 CloudFront distribution: ~$1/month + per-request fees,
  independent of tenant count.

The wildcard cert itself is free (ACM doesn't charge for public
certs).

## Apex / parent landing page

The default: parent domain included in the cert SAN list,
CloudFront cache behaviour routes the parent to a static landing
page at `packages/vestibulum-cdk/login-pages/tenant-parent.html`.
Edge `check-auth` detects the Host matches the parent exactly (not
a tenant subdomain) and passes through without an auth check.

The landing page is overridable via construct prop:

```typescript
new SharedDistributionIdentity(this, 'Identity', {
  // ...
  tenantParentLandingPage: '/path/to/custom.html',  // local file bundled into S3
});
```

Consumers who want browsers visiting the parent to see a cert error
instead (cleaner "you're definitely in the wrong place" UX, but
harder operationally) override the cert SAN list:

```typescript
new SharedDistributionIdentity(this, 'Identity', {
  // ...
  certificateSubjectAlternativeNames: [],  // wildcard only, no parent
});
```

## Multi-region considerations

Wildcard cert is regional (us-east-1 for CloudFront).
CloudFront is global. The home region (where Cognito, DDB,
trigger Lambdas live) is separate.

What's regional:

- ACM cert: us-east-1 only (consumed by CloudFront).
- CloudFront: global, no region.
- Lambda@Edge `check-auth`: replicates globally, source in us-east-1.
- Cognito pool: home region (typically eu-central-1).
- DDB tables: home region.
- Trigger Lambdas: home region.
- Admin Lambda: home region.
- SES: home region (matters for sender reputation).

A multi-region tenant identity isn't a "second region" of one
identity — it's a separate `SharedDistributionIdentity` with its
own Cognito pool, its own admin Lambda, its own ClientConfig table.
Out of scope for v0.2; flagged in
[`07-security-and-isolation.md`](07-security-and-isolation.md).

## Resolved design questions

- **Wildcard cert, not SAN-with-N-pre-baked.** A SAN cert with
  explicit names would be operationally more visible (each onboard
  shows up in cert events) but requires a CloudFront redeploy per
  tenant, defeating the pure-data property. Onboarding events are
  logged via the audit log instead.
- **Include parent domain in cert SAN list.** Default
  `subjectAlternativeNames: [tenantSubdomainParent]` lets the
  consumer ship a static "you need a tenant subdomain to proceed"
  landing page at `https://tenants.example.com`. Consumer can
  override the SAN list to omit if they want browsers visiting the
  parent to see a clean cert error instead.
- **DNSSEC: not enabled by default.** Adds a KMS key cost and isn't
  load-bearing for the design. Consumers who enable DNSSEC on their
  hosted zone get it for free (the construct doesn't fight it).
  Documented as a "recommended posture" item in the ops runbook,
  not as a construct prop.
- **IDN / punycode tenant names: defer to v0.3+.** The default
  pattern (`[a-z][a-z0-9-]{1,62}[a-z0-9]$`) rejects IDN forms.
  Supporting IDN requires a custom pattern, punycode-aware
  normalisation in the admin Lambda, and a display-name vs.
  storage-name distinction in `ClientConfig`. No consumer has
  asked; not in scope for v0.2.
