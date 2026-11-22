import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error testkit is plain ESM without a .d.mts file
import { Daemon, Workspace, cliEntry, spawnSpecForCli } from "../../testkit/daemon.mjs";
import {
  NPM_PACKAGE,
  assertPluginsHealthy,
  createAgentHelpers,
  extractPermissionRequestId,
  mergeExtraCollect,
  normalizeExtraPlugins,
  resolveClientVersion,
  resolvePluginSource,
  // @ts-expect-error testkit is plain ESM without a .d.mts file
} from "../../testkit/index.mjs";

const tempDirs: string[] = [];

function mkTempDir(prefix = "testkit-unit-") {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("testkit Workspace & Daemon", () => {
  it("strips host PASEO_* env vars but preserves extraEnv (including PASEO_*)", () => {
    const prev = process.env.PASEO_SHOULD_BE_STRIPPED;
    process.env.PASEO_SHOULD_BE_STRIPPED = "leak";
    const ws = new Workspace({
      extraEnv: {
        PASEO_GUARDIAN_DATA_DIR: "/tmp/guardian-audit",
        CUSTOM_FLAG: "1",
      },
    });
    try {
      const env = ws.env();
      expect(env.PASEO_SHOULD_BE_STRIPPED).toBeUndefined();
      expect(env.PASEO_HOME).toBe(ws.paseoHome);
      expect(env.PASEO_GUARDIAN_DATA_DIR).toBe("/tmp/guardian-audit");
      expect(env.CUSTOM_FLAG).toBe("1");

      const daemon = new Daemon(ws, {
        port: 12345,
        extraEnv: { PASEO_GUARDIAN_MODE: "act", CUSTOM_FLAG: "2" },
      });
      const daemonEnv = daemon.env();
      expect(daemonEnv.PASEO_GUARDIAN_DATA_DIR).toBe("/tmp/guardian-audit");
      expect(daemonEnv.PASEO_GUARDIAN_MODE).toBe("act");
      expect(daemonEnv.CUSTOM_FLAG).toBe("2");
    } finally {
      ws.cleanup();
      if (prev === undefined) delete process.env.PASEO_SHOULD_BE_STRIPPED;
      else process.env.PASEO_SHOULD_BE_STRIPPED = prev;
    }
  });

  it("supports custom cliEntry and selects node vs direct binary execution", () => {
    const dir = mkTempDir();
    const jsEntry = path.join(dir, "cli.js");
    const binEntry = path.join(dir, "paseo");
    fs.writeFileSync(jsEntry, "");
    fs.writeFileSync(binEntry, "");

    expect(cliEntry(jsEntry)).toBe(jsEntry);
    expect(cliEntry(binEntry)).toBe(binEntry);
    expect(() => cliEntry(path.join(dir, "missing.js"))).toThrow(/Custom Paseo CLI entry not found/);

    expect(spawnSpecForCli(jsEntry, ["daemon", "run"])).toEqual({
      command: process.execPath,
      args: [jsEntry, "daemon", "run"],
    });
    expect(spawnSpecForCli(binEntry, ["daemon", "run"])).toEqual({
      command: binEntry,
      args: ["daemon", "run"],
    });
  });

  it("collects extraCollect object and array paths into outDir", () => {
    const ws = new Workspace();
    const auditDir = mkTempDir("audit-");
    const extraFile = path.join(mkTempDir("extra-"), "notes.txt");
    const outObj = mkTempDir("out-obj-");
    const outArr = mkTempDir("out-arr-");
    try {
      fs.writeFileSync(path.join(auditDir, "audit.jsonl"), '{"ok":true}\n');
      fs.writeFileSync(extraFile, "hello");

      ws.collect(outObj, { "guardian-audit": auditDir, "missing-ignored": path.join(auditDir, "nope") });
      expect(fs.readFileSync(path.join(outObj, "guardian-audit", "audit.jsonl"), "utf8")).toBe('{"ok":true}\n');
      expect(fs.existsSync(path.join(outObj, "missing-ignored"))).toBe(false);

      ws.collect(outArr, [auditDir, extraFile]);
      expect(fs.readFileSync(path.join(outArr, "extra", path.basename(auditDir), "audit.jsonl"), "utf8")).toBe('{"ok":true}\n');
      expect(fs.readFileSync(path.join(outArr, "extra", "notes.txt"), "utf8")).toBe("hello");
    } finally {
      ws.cleanup();
    }
  });
});

describe("testkit plugin resolution and validation", () => {
  it("resolves client version from installed @getpaseo/client", () => {
    const ver = resolveClientVersion();
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolves local, npm, npm:spec, and custom directory pluginSource", () => {
    const dir = mkTempDir("plugin-src-");
    const ws = { stagePlugin: () => "/staged/paseo-scripted-provider" };

    expect(resolvePluginSource("local", { ws })).toBe("/staged/paseo-scripted-provider");
    expect(resolvePluginSource("npm")).toBe(`npm:${NPM_PACKAGE}`);
    expect(resolvePluginSource("npm", { pluginVersion: "0.3.0" })).toBe(`npm:${NPM_PACKAGE}@0.3.0`);
    expect(resolvePluginSource("npm:custom-pkg@1.0.0")).toBe("npm:custom-pkg@1.0.0");
    expect(resolvePluginSource(dir)).toBe(dir);
    expect(() => resolvePluginSource(path.join(dir, "does-not-exist"))).toThrow(/does not exist/);
  });

  it("normalizes extraPlugins entries (strings and objects)", () => {
    const dir = mkTempDir("third-party-");
    expect(normalizeExtraPlugins([dir, { source: "npm:my-plugin@1.0.0", id: "my-plugin" }])).toEqual([
      { source: dir, id: undefined },
      { source: "npm:my-plugin@1.0.0", id: "my-plugin" },
    ]);
    expect(() => normalizeExtraPlugins([{ source: path.join(dir, "missing") }])).toThrow(/does not exist/);
    expect(() => normalizeExtraPlugins([123 as unknown as string])).toThrow(/Invalid extraPlugins entry/);
  });

  it("asserts required plugin ids are running and no plugin is in error state", () => {
    const healthy = [
      { id: NPM_PACKAGE, status: "running" },
      { id: "paseo-permission-guardian", status: "running" },
    ];
    expect(() => assertPluginsHealthy(healthy, [NPM_PACKAGE, "paseo-permission-guardian"])).not.toThrow();
    expect(() => assertPluginsHealthy(healthy, [NPM_PACKAGE, "missing-plugin"])).toThrow(/missing-plugin.*not running/);
    expect(() =>
      assertPluginsHealthy(
        [
          { id: NPM_PACKAGE, status: "running" },
          { id: "broken-plugin", status: "error", error: "boom" },
        ],
        [NPM_PACKAGE],
      ),
    ).toThrow(/error state/);
  });

  it("merges extraCollect configs cleanly", () => {
    expect(mergeExtraCollect({ a: "/a" }, { b: "/b" })).toEqual({ a: "/a", b: "/b" });
    expect(mergeExtraCollect(["/a"], ["/b"])).toEqual(["/a", "/b"]);
    expect(mergeExtraCollect(undefined, { b: "/b" })).toEqual({ b: "/b" });
    expect(mergeExtraCollect({ a: "/a" }, undefined)).toEqual({ a: "/a" });
  });
});

describe("testkit permission & assistant text helpers", () => {
  it("extracts requestId from string or card shapes", () => {
    expect(extractPermissionRequestId("req-1")).toBe("req-1");
    expect(extractPermissionRequestId({ requestId: "req-2" })).toBe("req-2");
    expect(extractPermissionRequestId({ request: { id: "req-3" } })).toBe("req-3");
    expect(extractPermissionRequestId({ id: "req-4" })).toBe("req-4");
    expect(() => extractPermissionRequestId({})).toThrow(/Could not determine permission requestId/);
  });

  it("polls waitForPermission and responds via card or requestId", async () => {
    let calls = 0;
    const respondToPermissionMock = vi.fn(async () => ({ ok: true }));
    const ref: {
      pendingPermissions: Array<{ request: { id: string }; title: string }>;
      refresh: () => Promise<void>;
      respondToPermission: typeof respondToPermissionMock;
    } = {
      pendingPermissions: [],
      refresh: async () => {
        calls++;
        if (calls >= 2) {
          ref.pendingPermissions = [{ request: { id: "perm-42" }, title: "Allow Bash?" }];
        }
      },
      respondToPermission: respondToPermissionMock,
    };

    const helpers = createAgentHelpers({
      getApi: () => ({ agents: { ref: () => ref } }),
      ms: (v: number) => v,
      timeline: async () => [],
    });

    const card = await helpers.waitForPermission("agent-1", { timeoutMs: 1000, pollMs: 5 });
    expect(card.requestId).toBe("perm-42");
    expect(card.title).toBe("Allow Bash?");

    await helpers.respondToPermission("agent-1", card, { behavior: "allow", selectedActionId: "accept" });
    expect(respondToPermissionMock).toHaveBeenCalledWith({
      requestId: "perm-42",
      response: { behavior: "allow", selectedActionId: "accept" },
    });
  });

  it("polls waitForAssistantTexts for exact array or predicate match", async () => {
    let step = 0;
    const timeline = async () => {
      step++;
      if (step === 1) return [{ item: { type: "assistant_message", text: "first" } }];
      return [
        { item: { type: "assistant_message", text: "first" } },
        { item: { type: "tool_call", name: "Bash" } },
        { item: { type: "assistant_message", text: "second" } },
      ];
    };
    const helpers = createAgentHelpers({
      getApi: () => ({ agents: { ref: () => ({}) } }),
      ms: (v: number) => v,
      timeline,
    });

    const matched = await helpers.waitForAssistantTexts("agent-1", ["first", "second"], { timeoutMs: 1000, pollMs: 5 });
    expect(matched).toEqual(["first", "second"]);

    const predMatched = await helpers.waitForAssistantTexts("agent-1", (texts: string[]) => texts.length >= 2, {
      timeoutMs: 1000,
      pollMs: 5,
    });
    expect(predMatched).toEqual(["first", "second"]);
  });

  it("rejects with a clear timeout message when waitForAssistantTexts does not match", async () => {
    const helpers = createAgentHelpers({
      getApi: () => ({ agents: { ref: () => ({}) } }),
      ms: (v: number) => v,
      timeline: async () => [{ item: { type: "assistant_message", text: "only-one" } }],
    });

    await expect(
      helpers.waitForAssistantTexts("agent-1", ["only-one", "never-arrives"], { timeoutMs: 30, pollMs: 5 }),
    ).rejects.toThrow(/Timed out.*last seen.*only-one/);
  });
});
