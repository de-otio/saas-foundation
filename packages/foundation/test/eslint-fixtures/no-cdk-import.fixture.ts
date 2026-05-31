// This file is an ESLint test fixture. It intentionally violates the
// no-aws-cdk-lib-in-foundation rule.
// It is excluded from tsc compilation via tsconfig and skipped in
// normal vitest runs. The CI eslint-fixture check runs eslint on this
// file explicitly to verify the rule fires.

// VIOLATION: foundation must never import aws-cdk-lib
import type {} from "aws-cdk-lib";
