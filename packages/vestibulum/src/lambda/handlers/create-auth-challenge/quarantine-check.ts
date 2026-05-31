/**
 * Denylist lookup used by `CreateAuthChallenge`.
 *
 * The bounce-handler Lambda writes hard-bounce and complaint addresses into the
 * denylist table. Every magic-link send checks the table BEFORE calling SES,
 * because re-sending to a known-bad address damages the deployment's SES
 * reputation and (for complaints) is the legal definition of harassment.
 *
 * Why a DynamoDB lookup and not a Cognito user attribute: the denylist must
 * work for addresses that have not (yet) successfully signed up, and for
 * non-Cognito flows that share the same construct.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "crypto";

/**
 * Returns true if the email is on the denylist.
 *
 * The denylist primary key is `SHA-256(lowercased-email)` — we never store the
 * raw address in the denylist row's PK so a snapshot of the table doesn't
 * leak the address list. The bounce-handler writes the same hash.
 *
 * A missing table is treated as "denylist disabled" — the construct creates
 * the table unconditionally, so this only happens in tests where the env var
 * is intentionally unset.
 */
export async function isDenylisted(
  client: DynamoDBClient,
  tableName: string | undefined,
  email: string,
): Promise<boolean> {
  if (tableName === undefined || tableName === "") {
    return false;
  }

  const emailHash = createHash("sha256").update(email.toLowerCase()).digest("hex");

  try {
    const result = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { email_hash: { S: emailHash } },
        ConsistentRead: true,
      }),
    );
    return result.Item !== undefined;
  } catch (err) {
    // A missing table is non-fatal — fail open for the denylist (treat as not
    // denylisted) rather than block all signins. The rate limiter and SES
    // bounce notifications still apply. This is the same posture as having
    // no denylist configured at all.
    if (err instanceof ResourceNotFoundException) {
      return false;
    }
    throw err;
  }
}
