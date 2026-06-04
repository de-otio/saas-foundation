---
"@de-otio/saas-foundation": minor
"@de-otio/vestibulum": minor
"@de-otio/saas-foundation-cdk": patch
"@de-otio/vestibulum-cdk": patch
---

Upgrade major dependency versions.

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
