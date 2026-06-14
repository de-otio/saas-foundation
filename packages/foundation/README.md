# @de-otio/saas-foundation

Runtime core for de-otio multi-tenant SaaS backends. Provides the
Cloudflare-compatible cloud shims over AWS primitives (KV, queue,
storage), an AES-GCM session crypto layer, a structured logger
with request-id correlation, an append-only audit log, a KV-backed
token-bucket rate limiter, region / residency routing, feature
toggles, trusted-proxy IP derivation, and the frozen-set brand types
(`TenantId`, `AuditEvent`, `RequestContext`, `SecretRef`, …) that
the rest of the package family share.

Sibling packages (`@de-otio/vestibulum`, `@de-otio/saas-foundation-cdk`,
`@de-otio/vestibulum-cdk`) depend on this one as a peer.

## Install

```bash
npm install @de-otio/saas-foundation
```

Requires Node ≥ 24.

## Example

```ts
import { S3Storage } from "@de-otio/saas-foundation/storage";

const storage = new S3Storage({ bucket: "uploads", region: "eu-central-1" });
await storage.put("hello.txt", new TextEncoder().encode("hi"));
const obj = await storage.get("hello.txt");
console.log(await obj?.text());
```

Each capability is also reachable via a sub-path import — `/kv`,
`/queue`, `/storage`, `/secrets`, `/session`, `/tenant`, `/audit`,
`/logger`, `/request-context`, `/rate-limit`, `/region`,
`/feature-toggles`, `/net`, `/types/frozen` — so consumers pay only
for what they use.

## Design docs

See [`doc/`](https://github.com/de-otio/saas-foundation/tree/main/doc)
in the source repository, in particular
[`01-scope-and-philosophy.md`](https://github.com/de-otio/saas-foundation/blob/main/doc/01-scope-and-philosophy.md),
[`04-shared-vocabulary.md`](https://github.com/de-otio/saas-foundation/blob/main/doc/04-shared-vocabulary.md),
and the
[`foundation/`](https://github.com/de-otio/saas-foundation/tree/main/doc/foundation)
subfolder.

## License

Apache-2.0.
