/**
 * Local subset of the Lambda Function URL event/result shapes.
 *
 * `@types/aws-lambda` is not a dependency of this package; we keep the
 * shape narrow and well-typed in-tree, following the same pattern as
 * `cloudfront-types.ts` in the edge module.
 *
 * Shapes based on AWS Lambda Function URL documentation:
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 */

/** IAM authorizer context populated by Function URL's AWS_IAM auth. */
export interface IamAuthorizerContext {
  readonly accessKey?: string;
  readonly accountId?: string;
  readonly callerId?: string;
  readonly principalOrgId?: string;
  readonly userArn?: string;
  readonly userId?: string;
  readonly cognitoIdentity?: unknown;
  [key: string]: unknown;
}

/** Authorizer context on the Function URL event's request context. */
export interface FunctionUrlAuthorizerContext {
  readonly iam?: IamAuthorizerContext;
}

/** HTTP context on the Function URL event's request context. */
export interface FunctionUrlHttpContext {
  readonly method: string;
  readonly path: string;
  readonly protocol: string;
  readonly sourceIp: string;
  readonly userAgent: string;
}

/** Function URL event request context. */
export interface FunctionUrlRequestContext {
  readonly accountId: string;
  readonly apiId: string;
  readonly authorizer?: FunctionUrlAuthorizerContext;
  readonly domainName?: string;
  readonly domainPrefix?: string;
  readonly http: FunctionUrlHttpContext;
  readonly requestId: string;
  readonly routeKey: string;
  readonly stage?: string;
  readonly time?: string;
  readonly timeEpoch?: number;
}

/** Lambda Function URL event shape (POST body, headers, etc.). */
export interface LambdaFunctionURLEvent {
  readonly version: string;
  readonly routeKey: string;
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryStringParameters?: Readonly<Record<string, string>>;
  readonly requestContext: FunctionUrlRequestContext;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
}

/** Lambda Function URL result shape. */
export interface LambdaFunctionURLResult {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly cookies?: readonly string[];
}
