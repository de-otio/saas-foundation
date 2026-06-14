/**
 * Unit test for the unsorted-toequal CI gate.
 *
 * The gate's pure logic (`findUnsortedAssertions`) is exercised here
 * against synthetic file-text snippets. No real filesystem access is
 * needed — the CLI walk is tested end-to-end by running the script
 * against the real package tree in CI.
 *
 * The four required coverage areas (per the workstream spec):
 *   (a) flagged: expect(Object.keys(x)).toEqual(...)
 *   (b) flagged: expect([...someSet]).toEqual(...)  (spread of Set)
 *   (c) clean:   expect([1,2,3]).toEqual(...)       — must NOT be flagged
 *   (d) escape:  // sorted-ok suppresses a finding
 */

import { describe, expect, it } from "vitest";

import { findUnsortedAssertions } from "./check-unsorted-toequal.js";

describe("check-unsorted-toequal: findUnsortedAssertions", () => {
  // -------------------------------------------------------------------------
  // (a) Object.keys / Object.values / Object.entries as direct subject
  // -------------------------------------------------------------------------

  it("(a) flags expect(Object.keys(x)).toEqual(...)", () => {
    const text = `
    it("has the right keys", () => {
      expect(Object.keys(result)).toEqual(["a", "b", "c"]);
    });
    `.trim();

    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("Object.keys/values/entries");
  });

  it("(a) flags expect(Object.values(x)).toStrictEqual(...)", () => {
    const text = `expect(Object.values(mapping)).toStrictEqual(["x", "y"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
  });

  it("(a) flags expect(Object.entries(x)).toEqual(...)", () => {
    const text = `expect(Object.entries(obj)).toEqual([["k", "v"]]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
  });

  it("(a) does NOT flag expect(Object.keys(x).sort()).toEqual(...) — sorted first", () => {
    const text = `expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(a) does NOT flag expect(Object.keys(x).length).toBeGreaterThan(0) — not an equality check", () => {
    const text = `expect(Object.keys(fns).length).toBeGreaterThan(0);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (b) Spread of a Map/Set iterator
  // -------------------------------------------------------------------------

  it("(b) flags toEqual([...someSet]) where name contains 'set'", () => {
    const text = `expect([...someSet]).toEqual(["a", "b"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("Map/Set");
  });

  it("(b) flags toEqual([...x.keys()]) spread of iterator", () => {
    const text = `expect([...theMap.keys()]).toEqual(["a", "b"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
  });

  it("(b) flags toEqual([...x.values()]) spread of iterator", () => {
    const text = `expect([...registry.values()]).toStrictEqual([1, 2, 3]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
  });

  it("(b) flags toEqual([...myMap]) where name contains 'Map'", () => {
    const text = `expect([...myMap]).toEqual([["k", "v"]]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (c) Clean patterns — must NOT be flagged
  // -------------------------------------------------------------------------

  it("(c) does NOT flag expect([1, 2, 3]).toEqual([1, 2, 3]) — literal array", () => {
    const text = `expect([1, 2, 3]).toEqual([1, 2, 3]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(c) does NOT flag expect(someArbitraryArray).toEqual([...]) — no data-flow", () => {
    const text = `expect(results).toEqual(["a", "b", "c"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(c) does NOT flag expect([...sortedArr]).toEqual([...]) — no set/map heuristic match", () => {
    const text = `expect([...sortedArr]).toEqual(["a", "b", "c"]);`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(c) does NOT flag a const assignment that uses Object.values — not an assertion", () => {
    const text = `const alarmList = Object.values(alarms) as Array<{ Properties: unknown }>;`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (d) Escape hatch: // sorted-ok
  // -------------------------------------------------------------------------

  it("(d) suppresses a finding when // sorted-ok is on the same line", () => {
    const text =
      `expect(Object.keys(result)).toEqual(["a", "b", "c"]); // sorted-ok`;
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(d) suppresses a finding when // sorted-ok is on the line immediately above", () => {
    const text = [
      `// sorted-ok`,
      `expect(Object.keys(result)).toEqual(["a", "b", "c"]);`,
    ].join("\n");
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(0);
  });

  it("(d) does NOT suppress when // sorted-ok is two lines above", () => {
    const text = [
      `// sorted-ok`,
      ``,
      `expect(Object.keys(result)).toEqual(["a", "b", "c"]);`,
    ].join("\n");
    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Reporting metadata
  // -------------------------------------------------------------------------

  it("returns correct line numbers for multi-line input", () => {
    const text = [
      `it("test", () => {`,
      `  const x = 1;`,
      `  expect(Object.keys(obj)).toEqual(["a"]);`,
      `});`,
    ].join("\n");

    const findings = findUnsortedAssertions(text, "fake.test.ts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.filePath).toBe("fake.test.ts");
  });
});
