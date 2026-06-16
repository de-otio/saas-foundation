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

import { hmacEmail } from "../../shared/email-hmac.js";

/**
 * Returns true if the email is on the denylist.
 *
 * The denylist primary key is `HMAC-SHA-256(lowercased-email, sharedKey)` — we
 * never store the raw address in the denylist row's PK so a snapshot of the
 * table doesn't leak the address list, and the HMAC key (not just the hash)
 * keeps the low-entropy email space un-brute-forceable from a snapshot. The
 * bounce-handler MUST write with the same {@link hmacEmail} and key, or this
 * read silently never matches (the original bug: write used keyed HMAC, read
 * used a plain unkeyed sha256).
 *
 * A missing table is treated as "denylist disabled" — the construct creates
 * the table unconditionally, so this only happens in tests where the env var
 * is intentionally unset.
 */
export async function isDenylisted(
  client: DynamoDBClient,
  tableName: string | undefined,
  email: string,
  hmacKey: string,
): Promise<boolean> {
  if (tableName === undefined || tableName === "") {
    return false;
  }

  const emailHash = hmacEmail(email, hmacKey);

  try {
    const result = await client.send(
      new GetItemCommand({
        TableName: tableName,
        // PK attribute is `email_hmac` — must match the DenylistTable schema.
        Key: { email_hmac: { S: emailHash } },
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
