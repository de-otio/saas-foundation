/**
 * Default DynamoDB client factory.
 *
 * Returns a `DynamoDBClient` configured from the environment. Consumers who
 * need custom credentials, region, or endpoint override create their own
 * client and pass it to `DynamoKv` directly.
 *
 * This factory is intentionally thin — it is a convenience for the common
 * case (AWS Lambda, EC2, ECS with ambient credentials), not an abstraction.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export function createDefaultDynamoClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env["AWS_REGION"] ?? "us-east-1",
  });
}
