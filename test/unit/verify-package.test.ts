import { describe, expect, it } from "vitest";
import { checkFileList, packFileListFrom } from "../../scripts/verify-package.mjs";

const manifest = {
  name: "paseo-scripted-provider",
  version: "0.1.1",
  repository: { url: "git+https://github.com/quickwind/paseo-scripted-provider.git" },
};

const base = {
  files: ["package.json", "paseo-plugin.json", "index.server.ts", "shared/vendor/yaml.js"],
  required: ["package.json", "paseo-plugin.json"],
  manifest,
  name: "paseo-scripted-provider",
  expectedVersion: "0.1.1",
};

describe("packFileListFrom", () => {
  it("reads the npm 11 shape (an array of results)", () => {
    const parsed = [{ files: [{ path: "a.js" }, { path: "b.js" }] }];
    expect(packFileListFrom(parsed)).toEqual(["a.js", "b.js"]);
  });
  it("reads the npm 12 shape (an object keyed by package name)", () => {
    const parsed = { "my-package": { files: [{ path: "a.js" }] } };
    expect(packFileListFrom(parsed)).toEqual(["a.js"]);
  });
  it("returns nothing for an unexpected shape", () => {
    expect(packFileListFrom({})).toEqual([]);
    expect(packFileListFrom(undefined)).toEqual([]);
  });
});

describe("checkFileList", () => {
  it("accepts a tarball with every required file", () => {
    expect(checkFileList(base)).toEqual([]);
  });

  it("reports a missing file", () => {
    const problems = checkFileList({ ...base, files: ["package.json"] });
    expect(problems).toContain("missing from the tarball: paseo-plugin.json");
  });

  it("refuses to publish test and tooling directories", () => {
    const problems = checkFileList({ ...base, files: [...base.files, "test/unit/x.test.ts", "scripts/verify-package.mjs"] });
    expect(problems).toContain("must not be published: test/unit/x.test.ts");
    expect(problems).toContain("must not be published: scripts/verify-package.mjs");
  });

  it("checks the name and the version", () => {
    expect(checkFileList({ ...base, name: "other" })).toContain("package name is paseo-scripted-provider, expected other");
    expect(checkFileList({ ...base, expectedVersion: "0.2.0" })).toContain("package version is 0.1.1, expected 0.2.0");
  });

  it("requires a repository url for npm trusted publishing", () => {
    const problems = checkFileList({ ...base, manifest: { ...manifest, repository: undefined } });
    expect(problems.some((p) => p.includes("repository.url"))).toBe(true);
  });

  it("rejects runtime dependencies on the plugin, which the Paseo host provides", () => {
    const withDeps = { ...manifest, dependencies: { zod: "^4.4.3" } };
    const problems = checkFileList({ ...base, manifest: withDeps, forbidRuntimeDependencies: true });
    expect(problems.some((p) => p.includes("unexpected runtime dependencies: zod"))).toBe(true);
  });

  it("allows the testkit its own runtime dependencies", () => {
    const withDeps = { ...manifest, dependencies: { "@getpaseo/cli": "0.12.0" } };
    expect(checkFileList({ ...base, manifest: withDeps })).toEqual([]);
  });
});
