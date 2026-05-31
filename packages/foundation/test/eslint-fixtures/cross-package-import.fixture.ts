// This file is an ESLint test fixture. It intentionally violates the
// cross-package relative import rule (no-restricted-imports).
// It is excluded from tsc compilation via tsconfig and skipped in
// normal vitest runs. The CI eslint-fixture check runs eslint on this
// file explicitly to verify the rule fires.

// VIOLATION: must import via published name '@de-otio/vestibulum', not relative path
import type {} from "../../vestibulum/src/index.js";
