/**
 * cdk-nag snapshot test for NodejsLambda.
 *
 * Applies AwsSolutionsChecks to a stack containing a default NodejsLambda
 * (no VPC, default alarms) and snapshots the resulting warnings/errors.
 *
 * Intentional violations:
 *   - AwsSolutions-IAM4: "The IAM user, role, or group uses AWS managed policies."
 *     Rationale: NodejsFunction (the L2 we extend) attaches AWSLambdaBasicExecutionRole
 *     by default to enable CloudWatch Logs writes. Replacing this with an inline
 *     least-privilege policy is a separate effort tracked under future "iam-tightening"
 *     work; the managed policy is the AWS-documented baseline for Lambda execution.
 *     Acknowledged.
 *   - AwsSolutions-IAM5: "The IAM entity contains wildcard permissions and does not
 *     have a cdk-nag rule suppression with evidence for those permissions."
 *     Rationale: AWSLambdaBasicExecutionRole grants logs:CreateLogStream and
 *     logs:PutLogEvents against the function's own log group; cdk-nag flags the
 *     wildcard portion of the managed-policy ARN. The scope is bounded to the
 *     Lambda's own log group by AWS; acknowledged at the construct level.
 *
 * NOT suppressed (real findings should surface):
 *   - Any S3 / KMS / ENI / VPC-endpoint nag findings — those are consumer-stack
 *     decisions, not construct decisions.
 */

import * as path from "node:path";
import * as url from "node:url";

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { NodejsLambda } from "../../lib/nodejs-lambda/nodejs-lambda.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_ENTRY = path.join(__dirname, "fixtures/handler.ts");
const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

describe("NodejsLambda cdk-nag snapshot", () => {
  it("produces the expected nag findings for a default NodejsLambda", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "NodejsLambdaNagStack", {
      env: TEST_ENV,
      stackName: "NodejsLambdaNagStack",
    });

    const fn = new NodejsLambda(stack, "Fn", {
      entry: HANDLER_ENTRY,
      functionName: "nag-test-fn",
    });

    NagSuppressions.addResourceSuppressions(
      fn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is the AWS-documented baseline managed policy " +
            "for Lambda log writes. Replacing it with an inline least-privilege policy " +
            "is deferred to future iam-tightening work; not v0.1 scope.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard portions are scoped to the function's own CloudWatch log group via " +
            "the AWS-managed policy; acknowledged as the documented Lambda execution baseline.",
        },
      ],
      true,
    );

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));
    const synth = app.synth({ force: true });
    const messages = synth.getStackArtifact(stack.artifactId).messages;

    expect(messages).toMatchSnapshot();
  });
});
