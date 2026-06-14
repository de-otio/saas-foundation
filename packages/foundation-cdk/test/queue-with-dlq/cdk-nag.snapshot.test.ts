/**
 * cdk-nag snapshot test for QueueWithDlq.
 *
 * Applies AwsSolutionsChecks to a stack containing QueueWithDlq and snapshots
 * the resulting warnings/errors. The snapshot serves two purposes:
 *   1. Regression detection: future construct changes that accidentally regress
 *      a nag rule surface as a snapshot diff.
 *   2. Documentation: intentional violations are recorded here with rationale.
 *
 * Intentional violations:
 *   - AwsSolutions-SQS3: "The SQS queue does not have a dead-letter queue enabled."
 *     Rationale: The DLQ itself does not have a further DLQ. A DLQ-of-a-DLQ
 *     (graveyard queue) is not part of v0.1; it would be confusing noise on this
 *     construct's own DLQ resource. Acknowledged.
 *   - AwsSolutions-SQS4: "The SQS queue does not require SSL requests."
 *     Rationale: Encryption-in-transit enforcement via queue policy is out of
 *     scope for v0.1. Consumers who need it can attach a policy post-construction.
 *     Acknowledged.
 */

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { describe, it, expect } from "vitest";
import { QueueWithDlq } from "../../lib/queue-with-dlq/index.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

describe("QueueWithDlq cdk-nag snapshot", () => {
  it("produces the expected nag findings for a default QueueWithDlq", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "NagTestStack", {
      env: TEST_ENV,
      stackName: "NagTestStack",
    });

    const construct = new QueueWithDlq(stack, "Q", { queueName: "nag-test-queue" });

    // Suppress the intentional violations with documented rationale
    NagSuppressions.addResourceSuppressions(
      construct.dlq,
      [
        {
          id: "AwsSolutions-SQS3",
          reason:
            "DLQ-of-a-DLQ (graveyard queue) is intentionally out of scope for v0.1. " +
            "Consumers who need a redrive policy on the DLQ can configure it post-construction.",
        },
        {
          id: "AwsSolutions-SQS4",
          reason:
            "SSL-only queue policy is out of scope for v0.1. " +
            "Consumers may attach a restrictive policy via queue.addToResourcePolicy().",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      construct.queue,
      [
        {
          id: "AwsSolutions-SQS4",
          reason:
            "SSL-only queue policy is out of scope for v0.1. " +
            "Consumers may attach a restrictive policy via queue.addToResourcePolicy().",
        },
      ],
      true,
    );

    // Apply nag
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));
    const synth = app.synth({ force: true });
    const messages = synth.getStackArtifact(stack.artifactId).messages;

    // Snapshot the messages for regression tracking
    expect(messages).toMatchSnapshot();
  });
});
