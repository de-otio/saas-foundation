# @de-otio/vestibulum-cdk

AWS CDK constructs for the de-otio magic-link auth topology: Cognito
`CUSTOM_AUTH` user pool, CloudFront distribution with a `check-auth`
Lambda@Edge, SES bounce / complaint plumbing, and the
`SharedDistributionIdentity` construct that hosts many tenants under a
single CloudFront / wildcard certificate with per-tenant Cognito app
clients. Lambda bundles ship in the package (a SHA-256 lock pins each
one); CDK code reads them at synth time, so consumers don't need
esbuild or a separate bundling step.

`@de-otio/vestibulum` is declared as a peer.

## Install

```bash
npm install @de-otio/vestibulum-cdk @de-otio/vestibulum aws-cdk-lib constructs cdk-nag
```

Requires Node ≥ 24 and `aws-cdk-lib@^2.200`.

## Example

```ts
import { SharedDistributionIdentity } from "@de-otio/vestibulum-cdk";

new SharedDistributionIdentity(this, "Identity", {
  hostedZone,
  rootDomain: "example.com",
  ses: { fromAddress: "noreply@example.com" },
});
```

The package also exports a cdk-nag rule pack and several
construct-tree aspects (`HostedUiDomainAspect`,
`FederationCustomAttributesAspect`, `WafRequiredAspect`, …) that
enforce identity-specific compliance defaults.

## Design docs

See [`doc/vestibulum-cdk/`](https://github.com/de-otio/saas-foundation/tree/main/doc/vestibulum-cdk)
and the runnable consumer at
[`examples/shared-distribution/`](https://github.com/de-otio/saas-foundation/tree/main/examples/shared-distribution).

## License

Apache-2.0.
