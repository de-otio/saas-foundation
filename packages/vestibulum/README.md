# @de-otio/vestibulum

Identity runtime for de-otio SaaS backends. Provides a multi-pool
Cognito JWT verifier, OIDC and SAML IdP managers, Lambda trigger
templates (pre-token-generation, post-confirmation, pre-sign-up,
custom-auth `Define`/`Create`/`VerifyAuthChallenge`,
bounce-handler), an Edge `check-auth` handler for shared-distribution
multi-tenant topologies, plus the secret-store, OIDC-probe, and
SAML-metadata utilities those handlers compose.

Vestibulum re-exports the frozen brand types from
`@de-otio/saas-foundation` so consumers get a flat import surface;
foundation is declared as a peer dependency.

## Install

```bash
npm install @de-otio/vestibulum @de-otio/saas-foundation
```

Requires Node ≥ 24.

## Example

```ts
import { createMultiPoolVerifier } from "@de-otio/vestibulum";

const verifier = createMultiPoolVerifier([
  { region: "eu-central-1", userPoolId: "eu-central-1_abc123", clientId: "...", tokenUse: "id" },
]);
const { claims, poolKey } = await verifier.verify(idToken);
```

## Design docs

See [`doc/vestibulum/`](https://github.com/de-otio/saas-foundation/tree/main/doc/vestibulum)
in the source repository — in particular the
[Cognito triggers](https://github.com/de-otio/saas-foundation/blob/main/doc/vestibulum/04-cognito-triggers.md)
and
[shared-distribution](https://github.com/de-otio/saas-foundation/tree/main/doc/vestibulum/shared-distribution)
subfolders.

## License

Apache-2.0.
