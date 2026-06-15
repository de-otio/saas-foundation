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
import { Aspects } from "aws-cdk-lib";
import {
  DotTaggingAspect,
  validateRequiredTags,
  type Environment,
} from "@de-otio/cdk-tags";

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

// Deployment stage for the canonical `dot:environment` cost-allocation
// tag. Select with `-c env=dev|staging|prod`; defaults to `dev` so the
// example synthesises cleanly without extra context.
const stage = (app.node.tryGetContext("env") ?? "dev") as Environment;

new ExampleStack(app, "SharedDistributionExample", {
  env,
  description:
    "Example: SharedDistributionIdentity (multi-tenant shared-pool topology).",
});

// Apply the shared de-otio `dot:` cost-allocation tagging convention via
// @de-otio/cdk-tags (the foundation-cdk library still exports its own
// HouseTaggingAspect for library consumers; this example now standardises
// on the shared aspect). `validateRequiredTags` fails synth if any stack
// was left untagged.
Aspects.of(app).add(
  new DotTaggingAspect({
    entity: "de_otio",
    workstream: "saas_foundation",
    project: "saas-foundation",
    environment: stage,
  }),
);
validateRequiredTags(app);

app.synth();
