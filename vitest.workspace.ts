import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/foundation",
  "packages/vestibulum",
  "packages/foundation-cdk",
  "packages/vestibulum-cdk",
  // Cross-package CI gate scripts have their own test suite.
  "scripts",
]);
