import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cxapi from "aws-cdk-lib/cx-api";

/**
 * A CDK App whose stacks skip asset bundling.
 *
 * `NodejsLambda` extends `NodejsFunction`, which runs esbuild synchronously
 * at construction time: roughly 0.35 s per construct locally, and several
 * times that on a busy CI runner. The suites that use this helper check the
 * CloudFormation template, not what is in the bundle, so the bundling time is
 * wasted.
 *
 * An empty `aws:cdk:bundling-stacks` list is the same switch that
 * `cdk synth --exclusively` uses. Each asset gets a placeholder hash made from
 * its construct path, and the rest of the template does not change. A test
 * that needs real bundling should create a plain `new cdk.App()` instead.
 */
export function unbundledApp(): cdk.App {
  return new cdk.App({ context: { [cxapi.BUNDLING_STACKS]: [] } });
}

/**
 * Timeout for {@link warmUpSynth}. The warm-up takes about 0.9 s locally and
 * has taken more than 5 s on a CI runner, which is why it gets its own limit.
 */
export const SYNTH_WARM_UP_TIMEOUT_MS = 30_000;

/**
 * Synthesizes an empty stack once, so that no test pays for the first synth.
 *
 * The first `Template.fromStack` in a worker costs about 0.9 s locally, even
 * for an empty stack, because aws-cdk-lib loads its synthesis machinery on
 * first use. After that, synthesizing a NodejsLambda stack takes about 0.1 s.
 * Test files run in isolation, so every file pays this cost again, and it lands
 * on whichever hook or test synthesizes first. On CI, with coverage on and
 * other test files running at the same time, that first `beforeAll` took more
 * than the 5 s `hookTimeout`.
 *
 * Call it from a top-level hook so it runs before every other hook and test,
 * whatever order they run in, and give it its own timeout:
 * `beforeAll(warmUpSynth, SYNTH_WARM_UP_TIMEOUT_MS)`. The other hooks and
 * tests keep the strict 5 s default.
 */
export function warmUpSynth(): void {
  Template.fromStack(new cdk.Stack(unbundledApp(), "SynthWarmUp"));
}
