/**
 * Default S3 client factory.
 *
 * ## What the AWS SDK already does, and what it does not
 *
 * Verified against `@aws-sdk/client-s3` 3.1101 rather than assumed, because the
 * answer determines whether an S3-compatible provider needs code at all:
 *
 * - **Endpoint — already handled, no code needed.** The SDK resolves
 *   `AWS_ENDPOINT_URL_S3` (and the generic `AWS_ENDPOINT_URL`) natively, via
 *   `@smithy/core`'s `getEndpointUrlConfig`. A client constructed with nothing
 *   but a region picks it up. So "a client built from region alone cannot reach
 *   a non-AWS endpoint" is false — setting the variable is sufficient.
 *
 * - **Path-style addressing — supported in code only.** There is no
 *   `AWS_S3_FORCE_PATH_STYLE` environment variable; the SDK ignores it. Only
 *   the `forcePathStyle` constructor flag works, which is why this factory
 *   exposes one. Note that most S3-compatible providers wildcard their bucket
 *   DNS (`<bucket>.s3.<region>.<provider>` CNAMEs to the base host), in which
 *   case virtual-hosted addressing works and this flag is unnecessary. Set it
 *   only when the provider genuinely requires it.
 *
 * - **Credentials — the real gap, and the reason this file changed.** The SDK
 *   reads exactly ONE credential pair from the environment,
 *   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, shared by every service. That
 *   is fine on AWS, where one principal covers everything. It is not fine on a
 *   platform whose object storage and message queue issue SEPARATE credentials
 *   — the ambient pair belongs to one of them, and the other service gets a
 *   correctly-formed request signed by the wrong principal, which fails as 403
 *   rather than as a configuration error.
 *
 * So this factory adds one thing the SDK cannot express: an optional,
 * S3-specific credential pair. Everything else is left to the SDK.
 *
 * **Nothing changes for AWS deployments.** With none of the `S3_*` variables
 * set, this returns exactly what it always did — region only, ambient
 * credential chain.
 */

import { S3Client } from "@aws-sdk/client-s3";

export interface DefaultS3ClientOptions {
  /** Override the region; defaults to `AWS_REGION`, then `us-east-1`. */
  readonly region?: string;
  /** Read configuration from here instead of `process.env` (tests). */
  readonly source?: NodeJS.ProcessEnv;
}

/**
 * Resolve the S3-specific credential pair, or `undefined` to leave the SDK's
 * default chain in place.
 *
 * Both halves are required: a half-configured pair is a deployment mistake, and
 * silently falling back to the ambient credentials would sign requests as the
 * wrong principal — the exact failure this exists to prevent. Fail loudly
 * instead, at client construction, where the message can name the cause.
 */
function resolveS3Credentials(
  source: NodeJS.ProcessEnv,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  const accessKeyId = source["S3_ACCESS_KEY_ID"];
  const secretAccessKey = source["S3_SECRET_ACCESS_KEY"];

  // Explicit rather than truthiness-tested: an unset key in a container
  // manifest commonly arrives as `""`, and "" must count as absent, not as a
  // credential. This is the same absent-vs-present distinction the whole
  // module is about.
  const hasAccessKeyId = accessKeyId !== undefined && accessKeyId !== "";
  const hasSecretAccessKey = secretAccessKey !== undefined && secretAccessKey !== "";

  if (!hasAccessKeyId && !hasSecretAccessKey) return undefined;
  if (!hasAccessKeyId || !hasSecretAccessKey) {
    throw new Error(
      "S3 credentials are half-configured: set BOTH S3_ACCESS_KEY_ID and " +
        "S3_SECRET_ACCESS_KEY, or neither (to use the ambient credential chain).",
    );
  }
  return { accessKeyId, secretAccessKey };
}

export function createDefaultS3Client(options?: DefaultS3ClientOptions): S3Client {
  const source = options?.source ?? process.env;
  const credentials = resolveS3Credentials(source);

  return new S3Client({
    region: options?.region ?? source["AWS_REGION"] ?? "us-east-1",
    // Only the exact string "true" enables path style, so a stray value cannot
    // silently change addressing.
    ...(source["S3_FORCE_PATH_STYLE"] === "true" ? { forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
}
