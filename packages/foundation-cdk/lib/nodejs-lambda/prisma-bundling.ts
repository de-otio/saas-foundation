import type { ICommandHooks } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * Which Prisma query-engine binaries to copy into the Lambda bundle.
 *
 * - `rhel` — `libquery_engine-rhel-openssl-*` for Amazon Linux 2 / 2023
 *   running on x86_64 Lambda.
 * - `linux-arm64` — `libquery_engine-linux-arm64-openssl-*` for the
 *   ARM_64 architecture (which is the construct default).
 * - `darwin` / `darwin-arm64` — local-dev parity if the consumer's
 *   bundling toolchain pulls from a host-shared `.prisma/client` dir.
 */
export type PrismaEngine = "rhel" | "linux-arm64" | "darwin" | "darwin-arm64";

export interface PrismaBundlingOptions {
  /**
   * Engines to copy. Default: ['rhel', 'linux-arm64'].
   *
   * ARM_64 is the construct default architecture, so `linux-arm64` is
   * the engine Lambda actually loads at runtime. `rhel` is kept in the
   * default set because some consumers cut over from x86_64 incrementally
   * (a function on x86_64 in the same stack needs the rhel binary, and
   * one default keeps the cross-stack story simple).
   */
  readonly engines?: ReadonlyArray<PrismaEngine>;
}

/**
 * Build the esbuild bundling configuration that copies the generated
 * Prisma client + the requested query-engine binaries into the Lambda
 * output dir. The caller is responsible for adding `@prisma/client` to
 * the externalModules list (otherwise esbuild inlines it and the
 * after-bundling copies are redundant).
 *
 * Returns just the {@code commandHooks} portion; the construct merges
 * it with its own `externalModules` set so the consumer's
 * {@code externalModules} prop is honoured.
 */
export function buildPrismaCommandHooks(opts: PrismaBundlingOptions = {}): ICommandHooks {
  const engines: ReadonlyArray<PrismaEngine> = opts.engines ?? ["rhel", "linux-arm64"];

  return {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (inputDir: string, outputDir: string): string[] => {
      const engineCopies = engines.map(
        (engine) =>
          `cp ${inputDir}/node_modules/.prisma/client/libquery_engine-${engine}* ` +
          `${outputDir}/node_modules/.prisma/client/ 2>/dev/null || true`,
      );
      return [
        `mkdir -p ${outputDir}/node_modules/.prisma/client`,
        `mkdir -p ${outputDir}/node_modules/@prisma`,
        `cp -r ${inputDir}/node_modules/@prisma/client ${outputDir}/node_modules/@prisma/client`,
        `cp ${inputDir}/node_modules/.prisma/client/index.js ${outputDir}/node_modules/.prisma/client/`,
        `cp ${inputDir}/node_modules/.prisma/client/default.js ${outputDir}/node_modules/.prisma/client/`,
        `cp ${inputDir}/node_modules/.prisma/client/schema.prisma ` +
          `${outputDir}/node_modules/.prisma/client/ 2>/dev/null || true`,
        ...engineCopies,
      ];
    },
  };
}
