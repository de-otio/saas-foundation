/**
 * Shared S3 lifecycle defaults for buckets created by vestibulum-cdk
 * constructs. Cost-pillar review S4.
 *
 * Two reasons every bucket gets a default lifecycle:
 *
 * 1. `abortIncompleteMultipartUploadAfter` is essentially free savings.
 *    AWS bills stranded multipart-upload parts indefinitely until they
 *    are explicitly aborted; there is no upside to leaving them on the
 *    bill, and seven days is the conventional cut-off.
 * 2. Immutable-asset buckets (auth-site login pages, login-page bundles
 *    for the shared distribution) hold static content that is read
 *    rarely after the initial CloudFront edge cache fill. Transitioning
 *    to Standard-IA after 30 days roughly halves the per-GB storage
 *    cost for that workload (S3 Standard ~$0.023/GB-month, Standard-IA
 *    ~$0.0125/GB-month in us-east-1 as of 2026).
 *
 * The lifecycle is surfaced as an optional `lifecycle` prop on each
 * relevant construct so consumers with cold-as-operational
 * requirements can replace the default.
 *
 * Merge semantic (chosen to match the existing prop-merging pattern in
 * the package — see `loginPageBucket`, `responseHeadersPolicy`, etc.,
 * where a supplied prop replaces the default entirely):
 *
 * - `lifecycle` omitted → defaults apply.
 * - `lifecycle: { rules: undefined }` → defaults apply (same as omitted).
 * - `lifecycle: { rules: [] }` → lifecycle is explicitly disabled
 *   (no rules attached to the bucket).
 * - `lifecycle: { rules: [...non-empty] }` → consumer rules replace
 *   the defaults entirely.
 */

import { Duration, aws_s3 as s3 } from "aws-cdk-lib";

/**
 * Optional lifecycle configuration on every bucket the package creates.
 * Defaults are applied when the prop is omitted; an explicit empty
 * `rules` array disables the lifecycle entirely.
 */
export interface BucketLifecycleProps {
  /**
   * Lifecycle rules to apply to the bucket. When omitted, the
   * construct-specific default is applied. When set to a non-empty
   * array, the consumer's rules replace the default entirely. When
   * set to an empty array, no lifecycle is attached.
   */
  readonly rules?: s3.LifecycleRule[];
}

/**
 * Default lifecycle for an immutable-asset bucket (login pages,
 * bundled static content). Applies:
 *
 * - Abort incomplete multipart uploads after 7 days.
 * - Transition current versions to Standard-IA after 30 days.
 * - Expire noncurrent versions after 90 days (cheap insurance for
 *   buckets that turn on versioning later — no-op while versioning is
 *   off).
 */
export function defaultImmutableAssetLifecycleRules(): s3.LifecycleRule[] {
  return [
    {
      id: "vestibulum-immutable-assets-lifecycle",
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(7),
      transitions: [
        {
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: Duration.days(30),
        },
      ],
      noncurrentVersionExpiration: Duration.days(90),
    },
  ];
}

/**
 * Default lifecycle for a general-purpose bucket. Applies only the
 * abort-incomplete-multipart rule and a noncurrent-version expiration
 * — no storage-class transition (the construct does not know whether
 * the workload is read-cold).
 */
export function defaultGeneralBucketLifecycleRules(): s3.LifecycleRule[] {
  return [
    {
      id: "vestibulum-bucket-lifecycle",
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(7),
      noncurrentVersionExpiration: Duration.days(90),
    },
  ];
}

/**
 * Resolve the lifecycle rules to attach to a bucket given an optional
 * consumer override and a default rule set.
 *
 * - `override` undefined → `defaults` applied.
 * - `override.rules` undefined → `defaults` applied.
 * - `override.rules` is the empty array → returns `[]` (disabled).
 * - `override.rules` is a non-empty array → returns the consumer's
 *   array (replace).
 */
export function resolveLifecycleRules(
  override: BucketLifecycleProps | undefined,
  defaults: s3.LifecycleRule[],
): s3.LifecycleRule[] {
  if (override === undefined || override.rules === undefined) {
    return defaults;
  }
  // Both `[]` and a non-empty array fall through; `[]` explicitly
  // disables the default lifecycle.
  return override.rules;
}
