#!/usr/bin/env node
/**
 * scripts/build/topo.mjs
 *
 * Topological build runner for the saas-foundation monorepo.
 *
 * Reads each package's dependencies / peerDependencies to determine
 * topological order, then runs `npm run build --workspace=<pkg>` for
 * each package in dependency order.
 *
 * Valid topo order (derived from the dependency graph in
 * doc/03-package-relationships.md):
 *   foundation → foundation-cdk → vestibulum → vestibulum-cdk
 *
 * The script computes this dynamically from package.json so adding
 * a package only requires declaring its deps correctly.
 *
 * Usage:
 *   node scripts/build/topo.mjs
 *
 * See doc/02-monorepo-layout.md § Build orchestration.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

function readPackageJson(pkgDir) {
  const content = readFileSync(join(pkgDir, "package.json"), "utf8");
  return JSON.parse(content);
}

function discoverPackages() {
  const packagesDir = join(ROOT, "packages");
  const dirs = readdirSync(packagesDir);

  const packages = new Map();
  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    try {
      const pkg = readPackageJson(pkgDir);
      packages.set(pkg.name, {
        name: pkg.name,
        dir: pkgDir,
        deps: [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
        ].filter((d) => d.startsWith("@de-otio/")),
      });
    } catch {
      // skip non-package dirs
    }
  }
  return packages;
}

/**
 * Topological sort (Kahn's algorithm).
 * Returns package names in build order.
 */
function topoSort(packages) {
  const names = [...packages.keys()];
  const inDegree = new Map(names.map((n) => [n, 0]));
  const edges = new Map(names.map((n) => [n, []]));

  for (const [name, pkg] of packages) {
    for (const dep of pkg.deps) {
      if (packages.has(dep)) {
        edges.get(dep).push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }
  }

  const queue = names.filter((n) => inDegree.get(n) === 0).sort();
  const order = [];

  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const dependent of (edges.get(node) ?? []).sort()) {
      const deg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, deg);
      if (deg === 0) {
        queue.push(dependent);
      }
    }
  }

  if (order.length !== names.length) {
    throw new Error("Cycle detected in package dependency graph. Check package.json deps.");
  }

  return order;
}

function buildPackage(pkg) {
  console.log(`\nBuilding ${pkg.name}...`);
  execSync(`npm run build --workspace=${pkg.name}`, {
    stdio: "inherit",
    cwd: ROOT,
  });
  console.log(`Built ${pkg.name}.`);
}

function main() {
  const packages = discoverPackages();

  if (packages.size === 0) {
    console.log("No packages found under packages/.");
    process.exit(0);
  }

  let buildOrder;
  try {
    buildOrder = topoSort(packages);
  } catch (err) {
    console.error("Topological sort failed:", err.message);
    process.exit(1);
  }

  console.log(`Build order: ${buildOrder.join(" → ")}`);

  for (const name of buildOrder) {
    const pkg = packages.get(name);
    try {
      buildPackage(pkg);
    } catch (err) {
      console.error(`\nBuild failed for ${name}:`, err.message);
      process.exit(1);
    }
  }

  console.log("\nAll packages built successfully.");
}

main();
