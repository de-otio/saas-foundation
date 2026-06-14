/**
 * Tests for HouseTaggingAspect and validateHouseTaggingApplied.
 *
 * Synthesises a fixed test stack containing a NodejsLambda (which carries
 * the house-construct metadata marker), applies the aspect, and inspects
 * the resulting CloudFormation template / annotations.
 */

import * as path from "node:path";
import * as url from "node:url";

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import {
  Annotations as AssertAnnotations,
  Match,
  Template,
} from "aws-cdk-lib/assertions";
import { describe, it, expect } from "vitest";
import {
  HouseTaggingAspect,
  HOUSE_TAGGING_APPLIED_METADATA_KEY,
  HOUSE_TAGGING_KEYS,
  validateHouseTaggingApplied,
} from "../../lib/aspects/index.js";
import { NodejsLambda } from "../../lib/nodejs-lambda/nodejs-lambda.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_ENTRY = path.join(__dirname, "../nodejs-lambda/fixtures/handler.ts");

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

const GOOD_PROPS = {
  environment: "prod",
  service: "magic-link-auth",
  costCenter: "trellis-platform",
  owner: "platform-team",
} as const;

function makeStack(name: string): { app: cdk.App; stack: cdk.Stack } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
  return { app, stack };
}

function addNodejsLambda(stack: cdk.Stack, id: string, fnName: string): NodejsLambda {
  return new NodejsLambda(stack, id, {
    entry: HANDLER_ENTRY,
    functionName: fnName,
  });
}

describe("HouseTaggingAspect — applies tags", () => {
  it("applies all four tags to a stack containing a NodejsLambda", () => {
    const { app, stack } = makeStack("TagAppliedStack");
    addNodejsLambda(stack, "Fn", "tag-applied-fn");
    Aspects.of(app).add(new HouseTaggingAspect(GOOD_PROPS));

    const template = Template.fromStack(stack);
    // arrayWith requires its patterns to match in array order. Apply
    // four separate assertions to side-step that constraint — CDK is
    // free to emit tags in any order.
    template.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "Environment", Value: "prod" }]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "Service", Value: "magic-link-auth" }]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "CostCenter", Value: "trellis-platform" }]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "Owner", Value: "platform-team" }]),
    });

    // No errors should be emitted on the happy path.
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("records the applied marker on every visited stack", () => {
    const { app, stack } = makeStack("TagMarkerStack");
    addNodejsLambda(stack, "Fn", "tag-marker-fn");
    Aspects.of(app).add(new HouseTaggingAspect(GOOD_PROPS));

    // Force the synth that invokes the aspect.
    Template.fromStack(stack);

    const hasMarker = stack.node.metadata.some(
      (m) => m.type === HOUSE_TAGGING_APPLIED_METADATA_KEY,
    );
    expect(hasMarker).toBe(true);
  });

  it("ignores non-Stack constructs", () => {
    // Apply directly to a Construct that is not a Stack — visit() should
    // early-return without throwing or emitting errors.
    const { stack } = makeStack("TagNonStackScopeStack");
    addNodejsLambda(stack, "Fn", "tag-nonstack-fn");
    // Apply at a child scope (the function construct) rather than the stack.
    Aspects.of(stack.node.findChild("Fn")).add(new HouseTaggingAspect(GOOD_PROPS));

    Template.fromStack(stack);

    const hasMarker = stack.node.metadata.some(
      (m) => m.type === HOUSE_TAGGING_APPLIED_METADATA_KEY,
    );
    expect(hasMarker).toBe(false);
  });

  it("exposes the canonical four tag keys", () => {
    expect(HOUSE_TAGGING_KEYS).toStrictEqual([
      "Environment",
      "Service",
      "CostCenter",
      "Owner",
    ]);
  });
});

describe("HouseTaggingAspect — missing tag value emits error", () => {
  it("emits an error when environment is empty", () => {
    const { app, stack } = makeStack("TagMissingEnvStack");
    addNodejsLambda(stack, "Fn", "tag-missing-env-fn");
    Aspects.of(app).add(
      new HouseTaggingAspect({ ...GOOD_PROPS, environment: "" }),
    );

    Template.fromStack(stack);
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("missing required tag value.*environment"),
      ),
    ).not.toHaveLength(0);
  });

  it("emits an error when service is empty", () => {
    const { app, stack } = makeStack("TagMissingServiceStack");
    addNodejsLambda(stack, "Fn", "tag-missing-service-fn");
    Aspects.of(app).add(
      new HouseTaggingAspect({ ...GOOD_PROPS, service: "" }),
    );

    Template.fromStack(stack);
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("missing required tag value.*service"),
      ),
    ).not.toHaveLength(0);
  });

  it("emits an error when costCenter is empty", () => {
    const { app, stack } = makeStack("TagMissingCostCenterStack");
    addNodejsLambda(stack, "Fn", "tag-missing-cc-fn");
    Aspects.of(app).add(
      new HouseTaggingAspect({ ...GOOD_PROPS, costCenter: "" }),
    );

    Template.fromStack(stack);
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("missing required tag value.*costCenter"),
      ),
    ).not.toHaveLength(0);
  });

  it("emits an error when owner is empty", () => {
    const { app, stack } = makeStack("TagMissingOwnerStack");
    addNodejsLambda(stack, "Fn", "tag-missing-owner-fn");
    Aspects.of(app).add(new HouseTaggingAspect({ ...GOOD_PROPS, owner: "" }));

    Template.fromStack(stack);
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("missing required tag value.*owner"),
      ),
    ).not.toHaveLength(0);
  });

  it("lists every missing key in a single error when multiple are empty", () => {
    const { app, stack } = makeStack("TagMissingMultipleStack");
    addNodejsLambda(stack, "Fn", "tag-missing-multi-fn");
    Aspects.of(app).add(
      new HouseTaggingAspect({
        environment: "",
        service: "",
        costCenter: "trellis-platform",
        owner: "",
      }),
    );

    Template.fromStack(stack);
    const annotations = AssertAnnotations.fromStack(stack);
    const matches = annotations.findError(
      "*",
      Match.stringLikeRegexp("environment.*service.*owner"),
    );
    expect(matches).not.toHaveLength(0);
  });

  it("does NOT apply the marker or tags when validation fails", () => {
    const { app, stack } = makeStack("TagSkipApplyOnErrorStack");
    addNodejsLambda(stack, "Fn", "tag-skip-fn");
    Aspects.of(app).add(
      new HouseTaggingAspect({ ...GOOD_PROPS, environment: "" }),
    );

    const template = Template.fromStack(stack);

    // The aspect should have early-returned, so the marker is absent.
    const hasMarker = stack.node.metadata.some(
      (m) => m.type === HOUSE_TAGGING_APPLIED_METADATA_KEY,
    );
    expect(hasMarker).toBe(false);

    // And no Tags should have been added to the Lambda — the resource
    // emits a Tags property only when at least one tag is present.
    const resources = template.findResources("AWS::Lambda::Function");
    const values = Object.values(resources);
    expect(values).toHaveLength(1);
    const firstResource = values[0];
    expect(firstResource).toBeDefined();
    const properties = firstResource?.Properties as
      | { Tags?: ReadonlyArray<{ Key: string; Value: string }> }
      | undefined;
    expect(properties?.Tags).toBeUndefined();
  });
});

describe("validateHouseTaggingApplied — aspect not applied", () => {
  it("emits an error when a stack contains a house construct but the aspect was not applied", () => {
    const { app, stack } = makeStack("TagNotAppliedStack");
    addNodejsLambda(stack, "Fn", "tag-not-applied-fn");
    // Note: no Aspects.of(app).add(HouseTaggingAspect) call.

    validateHouseTaggingApplied(app);

    // Force synthesis so the validator aspect runs.
    Template.fromStack(stack);

    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("HouseTaggingAspect not applied"),
      ),
    ).not.toHaveLength(0);
  });

  it("emits no error when the aspect IS applied", () => {
    const { app, stack } = makeStack("TagAppliedNoErrorStack");
    addNodejsLambda(stack, "Fn", "tag-applied-noerror-fn");
    Aspects.of(app).add(new HouseTaggingAspect(GOOD_PROPS));
    validateHouseTaggingApplied(app);

    Template.fromStack(stack);

    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("HouseTaggingAspect not applied"),
      ),
    ).toHaveLength(0);
  });

  it("emits no error when no house constructs are present", () => {
    const { app, stack } = makeStack("TagNoHouseConstructsStack");
    // Stack is empty — no NodejsLambda / SingleTable / QueueWithDlq.
    validateHouseTaggingApplied(app);
    Template.fromStack(stack);

    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("flags only stacks with house constructs in a multi-stack app", () => {
    const app = new cdk.App();
    const taggedStack = new cdk.Stack(app, "TaggedSiblingStack", {
      env: TEST_ENV,
      stackName: "TaggedSiblingStack",
    });
    const untaggedStack = new cdk.Stack(app, "UntaggedSiblingStack", {
      env: TEST_ENV,
      stackName: "UntaggedSiblingStack",
    });
    addNodejsLambda(taggedStack, "Fn", "tagged-sibling-fn");
    // The plain stack contains no house constructs — should not be flagged.

    validateHouseTaggingApplied(app);
    Template.fromStack(taggedStack);
    Template.fromStack(untaggedStack);

    const taggedAnnotations = AssertAnnotations.fromStack(taggedStack);
    expect(
      taggedAnnotations.findError(
        "*",
        Match.stringLikeRegexp("HouseTaggingAspect not applied"),
      ),
    ).not.toHaveLength(0);

    const untaggedAnnotations = AssertAnnotations.fromStack(untaggedStack);
    expect(
      untaggedAnnotations.findError(
        "*",
        Match.stringLikeRegexp("HouseTaggingAspect not applied"),
      ),
    ).toHaveLength(0);
  });

  it("works when scope is a Stack rather than the App", () => {
    const { stack } = makeStack("TagValidateStackScopeStack");
    addNodejsLambda(stack, "Fn", "tag-validate-stack-fn");

    // Pass the stack directly, not the app.
    validateHouseTaggingApplied(stack);
    Template.fromStack(stack);

    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError(
        "*",
        Match.stringLikeRegexp("HouseTaggingAspect not applied"),
      ),
    ).not.toHaveLength(0);
  });
});
