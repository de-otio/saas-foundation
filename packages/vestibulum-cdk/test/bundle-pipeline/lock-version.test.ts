/**
 * U20 / 01-evidence §6: the shipped bundles were built from 0.5.0 source while
 * the lock still said 0.3.6, so the lock was misleading about what was inside.
 * `vestibulumVersion` in the lock must equal the runtime package's version.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;

describe("lambda-bundles.lock.json", () => {
  const lock = readJson(path.resolve(HERE, "../../lambda-bundles.lock.json"));
  const runtimePkg = readJson(path.resolve(HERE, "../../../vestibulum/package.json"));

  it("records the version of the vestibulum source the bundles were built from", () => {
    expect(lock["vestibulumVersion"]).toBe(runtimePkg["version"]);
  });

  it("lists every bundle the constructs consume", () => {
    const bundles = Object.keys(lock["bundles"] as object);
    for (const name of [
      "auth-login",
      "auth-verify",
      "auth-signout",
      "create-auth",
      "verify-auth",
      "define-auth",
      "bounce-handler",
      "check-auth",
    ]) {
      expect(bundles).toContain(name);
    }
  });
});
