// Minimal Lambda handler used as an entry path for NodejsLambda construct
// tests. The construct invokes esbuild during synth; this file gives it
// something to bundle. The handler body is irrelevant — only the bundle
// output's existence matters for the test assertions.

export function handler(): { statusCode: number } {
  return { statusCode: 200 };
}
