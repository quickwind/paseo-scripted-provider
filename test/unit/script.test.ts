import { describe, expect, it } from "vitest";
import { parseScript, mergeScripts, resolveReply, expandMacro, scenarioNames, matchStep } from "../../shared/core/script";
import { BUILTIN_SCRIPT } from "../../shared/core/builtins";

describe("parseScript", () => {
  it("accepts a minimal script", () => {
    const r = parseScript(JSON.stringify({ scenarios: { a: [{ text: "hi" }] } }));
    expect(r.ok).toBe(true);
  });
  it("rejects invalid JSON with a message", () => {
    expect(parseScript("{nope")).toMatchObject({ ok: false });
  });
  it("reports the path of a schema error", () => {
    const r = parseScript(JSON.stringify({ scenarios: { a: [{ outcome: "exploded" }] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scenarios.a.0.outcome");
  });
  it("rejects negative delays", () => {
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ startDelayMs: -1 }] } })).ok).toBe(false);
  });
  it("accepts an empty scenarios object", () => {
    expect(parseScript('{"scenarios":{}}').ok).toBe(true);
  });
});

describe("resolveReply", () => {
  const script = { scenarios: { a: [{ text: "1" }, { text: "2" }] } };
  it("steps through and repeats the last reply", () => {
    expect(resolveReply(script, "a", 0).reply.text).toBe("1");
    expect(resolveReply(script, "a", 1).reply.text).toBe("2");
    expect(resolveReply(script, "a", 9).reply.text).toBe("2");
  });
  it("falls back to the default scenario for unknown names", () => {
    const merged = mergeScripts(BUILTIN_SCRIPT, script);
    expect(resolveReply(merged, "nope", 0).reply.text).toBeTruthy();
  });
  it("expands @MACRO in text, chunks and messages", () => {
    const s = { macros: { M: "X" }, scenarios: { a: [{ text: "@M", chunks: ["@M", "y"], messages: ["@M"] }] } };
    expect(resolveReply(s, "a", 0).reply).toMatchObject({ text: "X", chunks: ["X", "y"], messages: ["X"] });
  });
  it("survives a 10k-reply scenario", () => {
    const s = { scenarios: { big: Array.from({ length: 10000 }, (_, i) => ({ text: String(i) })) } };
    const t = Date.now();
    expect(resolveReply(s, "big", 9999).reply.text).toBe("9999");
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("mergeScripts", () => {
  it("lets the override win per scenario and merges macros", () => {
    const m = mergeScripts({ macros: { A: "1" }, scenarios: { x: [{ text: "base" }] } }, { macros: { B: "2" }, scenarios: { x: [{ text: "over" }] } });
    expect(m.scenarios.x[0].text).toBe("over");
    expect(m.macros).toEqual({ A: "1", B: "2" });
  });
});

describe("expandMacro", () => {
  it("leaves unknown macros and non-macro text alone", () => {
    expect(expandMacro("@UNKNOWN", {})).toBe("@UNKNOWN");
    expect(expandMacro("hello @M", { M: "X" })).toBe("hello @M");
    expect(expandMacro(undefined, {})).toBeUndefined();
  });
});

it("builtins include the documented example scenarios", () => {
  expect(scenarioNames(BUILTIN_SCRIPT)).toEqual(
    expect.arrayContaining(["default", "chat", "long-output", "fail", "cancel", "slow-stream", "tools-demo"]),
  );
});

describe("hardening (final review)", () => {
  it("rejects tool details the Paseo SDK would reject (C1)", () => {
    for (const detail of [{ type: "shell" }, { type: "foo" }, { type: "unknown" }, { type: "sub_agent" }]) {
      expect(parseScript(JSON.stringify({ scenarios: { a: [{ tools: [{ name: "T", detail }] }] } })).ok).toBe(false);
    }
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ tools: [{ name: "T", detail: { type: "shell", command: "ls" } }, { name: "U", detail: { type: "plain_text" } }, { name: "V", detail: { type: "unknown", input: null, output: null } }] }] } })).ok).toBe(true);
  });
  it("never resolves prototype keys as scenarios or macros (I1)", () => {
    const s = { macros: { M: "x" }, scenarios: { default: [{ text: "D" }] } };
    for (const k of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      expect(resolveReply(s, k, 0).reply.text).toBe("D");
    }
    expect(expandMacro("@constructor", { M: "x" })).toBe("@constructor");
    expect(expandMacro("@__proto__", {})).toBe("@__proto__");
  });
});

describe("matchStep (replay by content)", () => {
  const list = [{ expect: "alpha", text: "A" }, { expect: "beta", text: "B" }, { expect: "gamma", text: "C" }, { text: "no expect" }];
  const s = { scenarios: { r: list } };
  it("stays on the current step when it matches", () => {
    expect(matchStep(s, "r", 1, "beta")).toBe(1);
  });
  it("jumps to the step whose expect matches the message, forward first then wrapping", () => {
    expect(matchStep(s, "r", 0, "gamma")).toBe(2);
    expect(matchStep(s, "r", 2, "alpha")).toBe(0);
    expect(matchStep(s, "r", 0, "  beta \n")).toBe(1);
  });
  it("prefers the next matching step after the current one for repeated messages", () => {
    const rep = { scenarios: { r: [{ expect: "go", text: "1" }, { expect: "stop", text: "2" }, { expect: "go", text: "3" }] } };
    expect(matchStep(rep, "r", 1, "go")).toBe(2);
    expect(matchStep(rep, "r", 2, "go")).toBe(2);
    expect(matchStep(rep, "r", 3, "go")).toBe(0);
  });
  it("treats {{placeholders}} in expect as wildcards", () => {
    const p = { scenarios: { r: [{ expect: "token is {{secret_1}} ok", text: "A" }, { expect: "other", text: "B" }] } };
    expect(matchStep(p, "r", 1, "token is ghp_abc123 ok")).toBe(0);
  });
  it("treats an {{email_N}} placeholder like any other wildcard so a replay with the real address matches", () => {
    const p = { scenarios: { r: [{ expect: "mail me at {{email_1}} please", text: "A" }, { expect: "other", text: "B" }] } };
    expect(matchStep(p, "r", 1, "mail me at jane@example.org please")).toBe(0);
  });
  it("falls back to the current step when nothing matches or no step has an expect", () => {
    expect(matchStep(s, "r", 1, "unrelated")).toBe(1);
    expect(matchStep({ scenarios: { r: [{ text: "x" }, { text: "y" }] } }, "r", 1, "anything")).toBe(1);
    expect(matchStep(s, "missing", 5, "x")).toBe(5);
    expect(matchStep(s, "constructor", 0, "x")).toBe(0);
  });
});

describe("YAML scripts", () => {
  const yamlText = `# my demo script
macros:
  FORM: |
    \`\`\`form
    {"type": "broken"}
    \`\`\`
scenarios:
  demo:
    - text: "@FORM"   # a macro
    - text: |
        Fixed.
        Second line.
      startDelayMs: 100
`;
  it("accepts YAML with comments, block text and macros", () => {
    const r = parseScript(yamlText);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.script.scenarios.demo[1]).toEqual({ text: "Fixed.\nSecond line.\n", startDelayMs: 100 });
      expect(resolveReply(r.script, "demo", 0).reply.text).toContain('{"type": "broken"}');
    }
  });
  it("JSON still works and keeps its own error message", () => {
    expect(parseScript('{"scenarios":{"a":[{"text":"x"}]}}').ok).toBe(true);
    expect(parseScript("{nope")).toMatchObject({ ok: false, error: expect.stringContaining("Invalid JSON") });
  });
  it("reports YAML syntax errors as YAML", () => {
    const r = parseScript("scenarios:\n  a:\n    - text: [unclosed\n");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Invalid YAML") });
  });
  it("reports schema errors with a path for YAML too", () => {
    const r = parseScript("scenarios:\n  a:\n    - outcome: exploded\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scenarios.a.0.outcome");
  });
  it("a bare word or a list is a schema error, not a crash", () => {
    expect(parseScript("hello").ok).toBe(false);
    expect(parseScript("- a\n- b\n").ok).toBe(false);
  });
});
