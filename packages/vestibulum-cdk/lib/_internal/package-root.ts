/**
 * Locates the package root for `@de-otio/vestibulum-cdk` at runtime.
 *
 * Both the source build (`packages/vestibulum-cdk/`) and the published
 * tarball install (`node_modules/@de-otio/vestibulum-cdk/`) need the
 * package root to resolve `lambda-bundles.lock.json` and the
 * `lambda-bundles/` directory.
 *
 * From a compiled `dist/<subdir>/<module>.js` the package root is two
 * directory levels above `dist/`. Resolving relative to `import.meta.url`
 * keeps the result correct in both layouts.
 */

import * as path from "node:path";
import * as url from "node:url";

/**
 * Returns the absolute path to the `vestibulum-cdk` package root
 * given an `import.meta.url` from any module inside `lib/` (or its
 * compiled `dist/` mirror).
 */
export function packageRootFrom(importMetaUrl: string): string {
  const here = url.fileURLToPath(importMetaUrl);
  // From `<root>/dist/<subdir>/<file>.js` (or `<root>/lib/<subdir>/<file>.ts`)
  // back up two directory levels.
  return path.resolve(path.dirname(here), "..", "..");
}
