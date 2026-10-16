import { describe, expect, it } from "vitest";
import { loadScriptTexts, resolveConfig } from "../../server/config";

describe("resolveConfig", () => {
  it("env state dir beats settings", () => {
    const c = resolveConfig({ scriptFile: "/s.json", recordFile: "/r.jsonl" }, { SCRIPTED_PROVIDER_STATE: "/state" });
    expect(c.scriptFile).toMatch(/state.scenarios\.json$/);
    expect(c.recordFile).toMatch(/state.received\.jsonl$/);
    expect(c.probeFile).toMatch(/state.probe\.jsonl$/);
  });
  it("with the env state dir, inline scripts from settings still apply (file first, inline wins)", () => {
    const c = resolveConfig({ scripts: "scenarios: {}" }, { SCRIPTED_PROVIDER_STATE: "/state" });
    expect(c.scriptText).toBe("scenarios: {}");
    expect(c.scriptFile).toMatch(/scenarios\.json$/);
  });
  it("uses settings when env is unset; trims blanks to undefined", () => {
    const c = resolveConfig({ scripts: "  ", scriptFile: " /s.json ", recordFile: "" }, {});
    expect(c).toMatchObject({ scriptText: undefined, scriptFile: "/s.json", recordFile: undefined, alignment: "warn" });
  });
  it("defaults alignment to warn and rejects garbage", () => {
    expect(resolveConfig(undefined, {}).alignment).toBe("warn");
    expect(resolveConfig({ alignment: "bogus" }, {}).alignment).toBe("warn");
    expect(resolveConfig({ alignment: "strict" }, {}).alignment).toBe("strict");
  });
});

describe("loadScriptTexts", () => {
  it("returns the file first, then the inline text", () => {
    expect(loadScriptTexts({ alignment: "warn", scriptText: "INLINE", scriptFile: "/x" }, () => "FILE")).toEqual(["FILE", "INLINE"]);
  });
  it("skips an unreadable file and returns nothing when unset", () => {
    expect(loadScriptTexts({ alignment: "warn", scriptFile: "/x" }, () => { throw new Error("nope"); })).toEqual([]);
    expect(loadScriptTexts({ alignment: "warn" })).toEqual([]);
  });
});
