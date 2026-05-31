/**
 * Local subset of the CloudFront viewer-request Lambda@Edge event shape.
 *
 * `@types/aws-lambda` is not a dependency of this package; we keep the
 * shape narrow and well-typed in-tree. The single-tenant prototype at
 * `packages/vestibulum/src/lambda/edge/check-auth/index.ts` follows the
 * same pattern.
 */

/** One `key`/`value` entry within a CloudFront header. */
export interface CloudFrontHeaderEntry {
  readonly key?: string;
  readonly value: string;
}

/** CloudFront represents headers as a map from lowercased name → entries. */
export type CloudFrontHeaders = Record<string, CloudFrontHeaderEntry[]>;

/** Viewer-request `request` shape (read+write surface for Lambda@Edge). */
export interface CloudFrontRequest {
  /** Lowercased-name-indexed header map. */
  readonly headers?: CloudFrontHeaders;
  /** Request URI (no query). */
  readonly uri?: string;
  /** Request method (uppercase). */
  readonly method?: string;
  /** Query string, no leading `?`. */
  readonly querystring?: string;
}

/** Synthesised response shape Lambda@Edge returns for refuse/redirect. */
export interface CloudFrontResultResponse {
  readonly status: string;
  readonly statusDescription: string;
  readonly headers: CloudFrontHeaders;
  readonly body?: string;
}

/** Top-level event the handler is invoked with. */
export interface CloudFrontRequestEvent {
  readonly Records: ReadonlyArray<{
    readonly cf: {
      readonly request: CloudFrontRequest;
    };
  }>;
}

/** Handler return: either pass through (the request) or a synthesized response. */
export type CloudFrontRequestResult = CloudFrontRequest | CloudFrontResultResponse;

/** Standard handler signature. */
export type CloudFrontRequestHandler = (
  event: CloudFrontRequestEvent,
) => Promise<CloudFrontRequestResult>;
