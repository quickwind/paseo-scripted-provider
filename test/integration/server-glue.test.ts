import { describe, expect, it, vi } from "vitest";
import { buildScript } from "../../server/build-script";
import { BUILTIN_SCRIPT } from "../../shared/core/builtins";
import { resolveReply } from "../../shared/core/script";
import contribute from "../../index.server";

const cfg = (o: object = {}) => ({ alignment: "warn" as const, ...o });

describe("buildScript", () => {
  it("returns builtins and no error when nothing is configured", () => {
    const r = buildScript(cfg());
    expect(r.error).toBeNull();
    expect(r.script).toEqual(BUILTIN_SCRIPT);
  });
  it("merges a valid inline script over builtins", () => {
    const r = buildScript(cfg({ scriptText: JSON.stringify({ scenarios: { mine: [{ text: "m" }] } }) }));
    expect(r.error).toBeNull();
    expect(Object.keys(r.script.scenarios)).toEqual(expect.arrayContaining(["mine", "chat"]));
  });
  it("falls back to builtins with an error for invalid JSON", () => {
    const r = buildScript(cfg({ scriptText: "{nope" }));
    expect(r.error).toContain("Invalid JSON");
    expect(r.script).toEqual(BUILTIN_SCRIPT);
  });
  it("lets a user scenario override a builtin", () => {
    const r = buildScript(cfg({ scriptText: JSON.stringify({ scenarios: { chat: [{ text: "mine" }] } }) }));
    expect(resolveReply(r.script, "chat", 0).reply.text).toBe("mine");
  });
  it("merges the script file and the inline script, inline wins (I4)", () => {
    const file = JSON.stringify({ scenarios: { fromfile: [{ text: "f" }], both: [{ text: "file" }] } });
    const inline = JSON.stringify({ scenarios: { both: [{ text: "inline" }], fromreplay: [{ text: "r" }] } });
    const r = buildScript(cfg({ scriptFile: "/x", scriptText: inline }), () => file);
    expect(Object.keys(r.script.scenarios)).toEqual(expect.arrayContaining(["fromfile", "fromreplay", "both"]));
    expect(resolveReply(r.script, "both", 0).reply.text).toBe("inline");
  });
  it("reports an invalid inline script while still serving the valid file (I4)", () => {
    const r = buildScript(cfg({ scriptFile: "/x", scriptText: "{bad" }), () => JSON.stringify({ scenarios: { fromfile: [{ text: "f" }] } }));
    expect(r.error).toContain("Invalid JSON");
    expect(Object.keys(r.script.scenarios)).toContain("fromfile");
  });
  it("reads the script file via the injected reader and reports unreadable files as no script", () => {
    const r = buildScript(cfg({ scriptFile: "/x" }), () => JSON.stringify({ scenarios: { f: [{ text: "f" }] } }));
    expect(Object.keys(r.script.scenarios)).toContain("f");
    expect(buildScript(cfg({ scriptFile: "/x" }), () => { throw new Error("no"); }).error).toBeNull();
  });
  it("handles a 10k-reply script quickly", () => {
    const big = { scenarios: { big: Array.from({ length: 10000 }, (_, i) => ({ text: String(i) })) } };
    const t = Date.now();
    const r = buildScript(cfg({ scriptText: JSON.stringify(big) }));
    expect(resolveReply(r.script, "big", 9999).reply.text).toBe("9999");
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("contribute", () => {
  const harness = () => {
    const registerProvider = vi.fn();
    const handle = vi.fn();
    const registerSettings = vi.fn(() => ({
      read: async () => ({ status: "ready", revision: "1", values: { scripts: "", scriptFile: "", recordFile: "", alignment: "warn" } }),
      subscribe: () => () => {},
    }));
    const cleanup = contribute({ registerProvider, handle, registerSettings } as never);
    const handler = (name: string) => {
      const call = handle.mock.calls.find((c) => c[0].name === name);
      if (!call) throw new Error(`no handler for ${name}`);
      return call[1] as (input: unknown, ctx?: unknown) => unknown;
    };
    return { registerProvider, handle, registerSettings, cleanup, handler };
  };

  it("registers provider, settings and RPC handlers, and returns a cleanup", () => {
    const { registerProvider, handle, registerSettings, cleanup } = harness();
    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "scripted" }));
    expect(registerSettings).toHaveBeenCalledWith(expect.objectContaining({ id: "scripted-provider" }));
    expect(handle.mock.calls.map((c) => c[0].name).sort()).toEqual([
      "scripted.capture",
      "scripted.export",
      "scripted.merge-scenario",
      "scripted.read-record",
      "scripted.status",
    ]);
    expect(typeof cleanup).toBe("function");
  });

  it("serializes a script to YAML on the daemon, where the YAML parser lives", () => {
    const { handler } = harness();
    const out = handler("scripted.export")({ script: { scenarios: { a: [{ text: "hi" }] } }, format: "yaml" }) as { text: string };
    expect(out.text).toContain("scenarios:");
    expect(out.text).toContain("hi");
  });

  it("merges a recorded scenario into existing YAML, keeping comments", () => {
    const { handler } = harness();
    const existing = "# my notes\nscenarios:\n  keep:\n    - text: 'old'\n";
    const out = handler("scripted.merge-scenario")({
      script: { scenarios: { recorded: [{ text: "new" }] } },
      name: "recorded",
      existingText: existing,
    }) as { ok: boolean; text?: string; name?: string; error?: string };
    expect(out.ok).toBe(true);
    expect(out.name).toBe("recorded");
    expect(out.text).toContain("# my notes");
    expect(out.text).toContain("keep:");
    expect(out.text).toContain("recorded:");
  });

  it("reports an invalid existing script instead of writing it", () => {
    const { handler } = harness();
    const out = handler("scripted.merge-scenario")({
      script: { scenarios: { recorded: [{ text: "new" }] } },
      name: "recorded",
      existingText: "{nope",
    }) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
