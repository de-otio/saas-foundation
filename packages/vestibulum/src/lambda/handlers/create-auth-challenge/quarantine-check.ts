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
 * The denylist could not be consulted (`signin_fails_closed`). The caller must
 * treat the request as unanswerable and mail nothing. The message is a closed
 * string: it never carries an address, a table name or an SDK error body.
 */
export class DenylistUnavailableError extends Error {
  constructor() {
    super("denylist unavailable");
    this.name = "DenylistUnavailableError";
  }
}

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
 * **Fails closed.** A denylist that cannot be read is not an empty denylist:
 *
 * - an unset or empty table name (a deployment error) throws
 *   {@link DenylistUnavailableError};
 * - `ResourceNotFoundException` (the table is gone) throws
 *   {@link DenylistUnavailableError};
 * - any other error propagates as thrown.
 *
 * `CreateAuthChallenge` turns every one of these into "unanswerable, no mail"
 * and a `SignInSuppressed` metric, so no exception reaches Cognito.
 */
export async function isDenylisted(
  client: DynamoDBClient,
  tableName: string | undefined,
  email: string,
  hmacKey: string,
): Promise<boolean> {
  if (tableName === undefined || tableName === "") {
    throw new DenylistUnavailableError();
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
    if (err instanceof ResourceNotFoundException) {
      throw new DenylistUnavailableError();
    }
    throw err;
  }
}
