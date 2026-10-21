import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYaml } from "../../shared/core/yaml";

describe("vendored yaml", () => {
  it("is the version declared in package.json (regenerate with `npm run vendor:yaml`)", () => {
    const banner = fs.readFileSync("shared/vendor/yaml.js", "utf8").split("\n")[0];
    const installed = JSON.parse(fs.readFileSync("node_modules/yaml/package.json", "utf8")).version;
    expect(banner).toContain(`yaml@${installed}`);
    expect(fs.readFileSync("shared/vendor/yaml.LICENSE", "utf8")).toContain("ISC");
  });
  it("has no node: imports (shared/ is also bundled for the client)", () => {
    expect(fs.readFileSync("shared/vendor/yaml.js", "utf8")).not.toMatch(/(?:from|import\(|require\()\s*["']node:/);
  });
  it("round-trips, writing multi-line text as a block", () => {
    const value = { a: "line1\nline2\n", b: [1, true, null], c: { d: "x: y" } };
    const text = stringifyYaml(value);
    expect(text).toContain("|");
    expect(parseYaml(text)).toEqual(value);
  });
  it("rejects alias bombs instead of hanging", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n");
    expect(() => parseYaml(bomb)).toThrow();
  });
});
