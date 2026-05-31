/**
 * Default SQS client factory.
 */

import { SQSClient } from "@aws-sdk/client-sqs";

export function createDefaultSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  });
}
