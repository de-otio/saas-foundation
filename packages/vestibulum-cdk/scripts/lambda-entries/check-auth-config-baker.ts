/**
 * check-auth-config-baker — CloudFormation custom-resource onEvent handler.
 *
 * The Lambda@Edge `check-auth` function cannot read environment variables, and
 * the consumer supplies the Cognito pool/client ids as deploy-time CloudFormation
 * tokens (concrete only at deploy, never at synth). So the construct ships the
 * function with `PLACEHOLDER_*` seams and this custom resource bakes the real
 * values in at deploy time:
 *
 *   1. read the PRISTINE base bundle staged next to this handler
 *      (`check-auth-base.mjs`) — NOT the deployed function code, so a
 *      config-only change always re-bakes from clean placeholders;
 *   2. string-replace the three `PLACEHOLDER_*` seams with concrete values;
 *   3. `UpdateFunctionCode` on the us-east-1 check-auth function, wait, then
 *      `PublishVersion`;
 *   4. return the new version ARN as `FunctionVersionArn` — the CloudFront
 *      viewer-request association points at it.
 *
 * Self-contained (no `@de-otio/vestibulum` import): pure deploy plumbing.
 * `@aws-sdk/client-lambda` is provided by the Lambda runtime; `adm-zip` is
 * bundled in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LambdaClient,
  UpdateFunctionCodeCommand,
  PublishVersionCommand,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import AdmZip from "adm-zip";

interface CrEvent {
  readonly RequestType: "Create" | "Update" | "Delete";
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: {
    readonly FunctionName: string;
    readonly FunctionRegion: string;
    readonly UserPoolId: string;
    readonly ClientId: string;
    readonly HomeRegion: string;
    /** Changes when the base bundle changes — forces a re-bake. Unused at runtime. */
    readonly BaseSha?: string;
  };
}

interface CrResult {
  readonly PhysicalResourceId: string;
  readonly Data?: { readonly FunctionVersionArn: string };
}

/** The three deploy-time injection seams in the base bundle (see check-auth/index.ts). */
const SEAMS = {
  PLACEHOLDER_USER_POOL_ID: "UserPoolId",
  PLACEHOLDER_CLIENT_ID: "ClientId",
  PLACEHOLDER_REGION: "HomeRegion",
} as const;

export async function handler(event: CrEvent): Promise<CrResult> {
  const physicalId = event.PhysicalResourceId ?? `check-auth-bake-${event.ResourceProperties.FunctionName}`;

  // Delete: nothing to undo — the function itself is owned by CloudFormation.
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalId };
  }

  const props = event.ResourceProperties;

  // Patch the PRISTINE base, never the (already-patched) deployed code.
  const basePath = fileURLToPath(new URL("./check-auth-base.mjs", import.meta.url));
  let code = readFileSync(basePath, "utf8");
  code = code
    .split("PLACEHOLDER_USER_POOL_ID").join(props.UserPoolId)
    .split("PLACEHOLDER_CLIENT_ID").join(props.ClientId)
    .split("PLACEHOLDER_REGION").join(props.HomeRegion);

  // Fail closed: never publish a function that still carries a placeholder.
  for (const seam of Object.keys(SEAMS)) {
    if (code.includes(seam)) {
      throw new Error(`check-auth-config-baker: seam ${seam} survived injection`);
    }
  }

  const zip = new AdmZip();
  zip.addFile("index.mjs", Buffer.from(code, "utf8"));

  const client = new LambdaClient({ region: props.FunctionRegion });
  await client.send(
    new UpdateFunctionCodeCommand({ FunctionName: props.FunctionName, ZipFile: zip.toBuffer() }),
  );
  await waitUntilFunctionUpdatedV2(
    { client, maxWaitTime: 120 },
    { FunctionName: props.FunctionName },
  );
  const published = await client.send(
    new PublishVersionCommand({ FunctionName: props.FunctionName }),
  );
  if (published.FunctionArn === undefined) {
    throw new Error("check-auth-config-baker: PublishVersion returned no FunctionArn");
  }

  return {
    PhysicalResourceId: physicalId,
    Data: { FunctionVersionArn: published.FunctionArn },
  };
}
