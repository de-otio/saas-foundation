// This file is an ESLint test fixture. It intentionally violates the
// audit-prisma-quarantine rule:
//
//   Only `src/audit/prisma.ts` may top-level import `@prisma/client`.
//   The fixture lives under `test/eslint-fixtures/`, which the override
//   patterns also match via the `**/*.ts` glob — but the override is
//   actually scoped to `packages/foundation/src/audit/**/*.ts`, so this
//   fixture is positioned at `test/eslint-fixtures/` AND a CI gate runs
//   the rule with `--no-ignore` over a file path that PRETENDS to be in
//   src/audit/ via the file-path matcher.
//
// The CI gate test invokes eslint with this file specified under a
// `--config` that maps it to `src/audit/audit-prisma-leak.fixture.ts`
// for matching purposes — or, more simply, the gate test passes
// `--rule '{...}' --no-eslintrc` to assert the rule fires.
//
// File is excluded from tsc compilation via the `eslint-fixtures`
// exclusion and from normal vitest runs (vitest.config.ts excludes
// test/eslint-fixtures/**).

// VIOLATION: only src/audit/prisma.ts may import @prisma/client at the
// top level. Any other file under src/audit/ pulling this in breaks
// the optional-peer-dep pattern documented in
// doc/foundation/01-package-api.md § Prisma sub-paths.
import { PrismaClient } from "@prisma/client";

// Reference so unused-import lints don't fire over the import we
// actually care about exercising. The `_leak` symbol is intentionally
// not consumed elsewhere — its only role is to keep `PrismaClient`
// in scope so the no-restricted-imports rule sees the import line.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _leak(): void {
  void PrismaClient;
}
