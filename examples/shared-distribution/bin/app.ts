#!/usr/bin/env node
/**
 * SharedDistributionIdentity example CDK app.
 *
 * Synthesises a single stack that instantiates the multi-tenant
 * shared-pool identity construct. Designed to `cdk synth` cleanly with
 * minimal context — operators tweaking the example for a real deploy
 * should adjust the env block and the props passed in
 * `lib/example-stack.ts`.
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";

import { ExampleStack } from "../lib/example-stack.js";

const app = new cdk.App();

// Build the env object conditionally so `exactOptionalPropertyTypes`
// doesn't see an explicit `undefined` account when CDK_DEFAULT_ACCOUNT
// is unset (which happens during account-less `cdk synth` in CI).
const env: cdk.Environment = {
  region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
  ...(process.env.CDK_DEFAULT_ACCOUNT
    ? { account: process.env.CDK_DEFAULT_ACCOUNT }
    : {}),
};

new ExampleStack(app, "SharedDistributionExample", {
  env,
  description:
    "Example: SharedDistributionIdentity (multi-tenant shared-pool topology).",
});

app.synth();
