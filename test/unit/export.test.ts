import { describe, expect, it } from "vitest";
import { addScenarioToSettings, safeScenarioName, scriptFilename, serializeScript, uniqueScenarioName } from "../../shared/core/capture/export";
import { parseScript } from "../../shared/core/script";

const script = { scenarios: { rec: [{ expect: "hi", text: "yo" }] } };

describe("serializeScript", () => {
  it("round-trips through parseScript, 2-space indented with trailing newline", () => {
    const text = serializeScript(script);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "scenarios"');
    expect(parseScript(text)).toEqual({ ok: true, script });
  });
});

describe("scriptFilename", () => {
  it("sanitises the name and stamps UTC time", () => {
    expect(scriptFilename("my chat/../x", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("my-chat-x-20260102-030405.scripted.json");
  });
  it("falls back to 'script' for empty names", () => {
    expect(scriptFilename("///", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("script-20260102-030405.scripted.json");
  });
});

describe("uniqueScenarioName", () => {
  it("appends -2, -3 on collisions", () => {
    expect(uniqueScenarioName(["a"], "b")).toBe("b");
    expect(uniqueScenarioName(["a", "a-2"], "a")).toBe("a-3");
  });
});

describe("addScenarioToSettings", () => {
  it("accepts empty existing text", () => {
    const r = addScenarioToSettings("", "rec", script);
    expect(r.ok && parseScript(r.text).ok).toBe(true);
  });
  it("merges into an existing script and renames on collision", () => {
    const existing = JSON.stringify({ macros: { M: "x" }, scenarios: { rec: [{ text: "old" }] } });
    const r = addScenarioToSettings(existing, "rec", script);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = parseScript(r.text);
      expect(p.ok && Object.keys(p.script.scenarios)).toEqual(["rec", "rec-2"]);
      expect(p.ok && p.script.macros).toEqual({ M: "x" });
    }
  });
  it("rejects invalid existing text without overwriting", () => {
    expect(addScenarioToSettings("{bad", "rec", script)).toMatchObject({ ok: false });
  });
});

describe("safeScenarioName", () => {
  it("only keeps characters SCENARIO: and scripted/<name> can express", () => {
    expect(safeScenarioName("my chat/v2.1")).toBe("my-chat-v2-1");
    expect(safeScenarioName("  ")).toBe("recorded");
    expect(safeScenarioName("ok_name-1")).toBe("ok_name-1");
  });
});

describe("YAML export and merge", () => {
  const multi = { scenarios: { rec: [{ expect: "hi", text: "line 1\nline 2\n" }] } };
  it("serializeScript writes YAML that parses back, using a block for multi-line text", () => {
    const text = serializeScript(multi, "yaml");
    expect(text).toContain("text: |");
    expect(parseScript(text)).toEqual({ ok: true, script: multi });
  });
  it("scriptFilename uses the format's extension", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(scriptFilename("x", d, "yaml")).toBe("x-20260102-030405.scripted.yaml");
    expect(scriptFilename("x", d)).toBe("x-20260102-030405.scripted.json");
  });
  it("merging into an existing YAML script keeps its comments and writes YAML", () => {
    const existing = "# my scripts\nmacros:\n  M: x  # keep me\nscenarios:\n  mine:\n    - text: hello # first\n";
    const r = addScenarioToSettings(existing, "rec", multi);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("# my scripts");
      expect(r.text).toContain("# keep me");
      expect(r.text).toContain("# first");
      const p = parseScript(r.text);
      expect(p.ok && Object.keys(p.script.scenarios)).toEqual(["mine", "rec"]);
    }
  });
  it("an empty existing script gets YAML; an existing JSON script stays JSON", () => {
    const fresh = addScenarioToSettings("", "rec", multi);
    expect(fresh.ok && fresh.text.trimStart().startsWith("{")).toBe(false);
    const json = addScenarioToSettings('{"scenarios":{"a":[{"text":"x"}]}}', "rec", multi);
    expect(json.ok && json.text.trimStart().startsWith("{")).toBe(true);
  });
  it("renames on collision inside YAML and rejects invalid existing YAML", () => {
    const r = addScenarioToSettings("scenarios:\n  rec:\n    - text: old\n", "rec", multi);
    const p = r.ok ? parseScript(r.text) : null;
    expect(p && p.ok && Object.keys(p.script.scenarios)).toEqual(["rec", "rec-2"]);
    expect(addScenarioToSettings("scenarios: [unclosed", "rec", multi)).toMatchObject({ ok: false });
  });
  it("merges macros from the recording into YAML too", () => {
    const r = addScenarioToSettings("scenarios:\n  a:\n    - text: x\n", "rec", { macros: { Z: "zz" }, scenarios: { rec: [{ text: "@Z" }] } });
    const p = r.ok ? parseScript(r.text) : null;
    expect(p && p.ok && p.script.macros).toEqual({ Z: "zz" });
  });
});
