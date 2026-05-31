// This file is an ESLint test fixture. It intentionally violates the
// feature-toggles-prisma-quarantine rule:
//
//   Only `src/feature-toggles/prisma.ts` may top-level import
//   `@prisma/client`. Any other file under `src/feature-toggles/`
//   pulling this in breaks the optional-peer-dep pattern documented in
//   doc/foundation/01-package-api.md § Prisma sub-paths.
//
// The CI gate test invokes eslint over this file path with --no-ignore
// to assert the rule fires.
//
// File is excluded from tsc compilation via the `eslint-fixtures`
// exclusion and from normal vitest runs (vitest.config.ts excludes
// test/eslint-fixtures/**).

// VIOLATION: only src/feature-toggles/prisma.ts may import @prisma/client
// at the top level. Any other file under src/feature-toggles/ breaks
// the optional-peer-dep pattern.
import { PrismaClient } from "@prisma/client";

// Reference so unused-import lints don't fire over the import we
// actually care about exercising.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _leak(): void {
  void PrismaClient;
}
