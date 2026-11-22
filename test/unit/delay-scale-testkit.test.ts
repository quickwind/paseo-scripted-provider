import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../server/config";
import { connect, open, prompt, turnStates } from "../helpers/harness";
// @ts-expect-error testkit is plain ESM without a .d.mts file
import { Daemon, Workspace } from "../../testkit/daemon.mjs";
// @ts-expect-error testkit is plain ESM without a .d.mts file
import { createAgentHelpers } from "../../testkit/index.mjs";

describe("P0-5: delayScale, daemonConfig overrides, and testkit async waiters", () => {
  it("parses delayScale from env (wins) and settings", () => {
    expect(resolveConfig({ delayScale: 0.5 }, {}).delayScale).toBe(0.5);
    expect(resolveConfig({ delayScale: 0.5 }, { SCRIPTED_PROVIDER_DELAY_SCALE: "0" }).delayScale).toBe(0);
    expect(resolveConfig({}, { SCRIPTED_PROVIDER_DELAY_SCALE: "-1" }).delayScale).toBeUndefined();
  });

  it("completes a multi-second scripted reply immediately when delayScale is 0", async () => {
    const h = await connect({
      getConfig: () => ({ alignment: "warn", delayScale: 0 }),
      getScript: () => ({
        scenarios: {
          slow: [
            {
              startDelayMs: 5000,
              steps: [
                { kind: "message", text: "fast!", delayMs: 10000 },
              ],
              delayMs: 3000,
            },
          ],
        },
      }),
    });

    await h.send(open("s1", "slow"));
    await h.send(prompt("s1", "go"));
    // Without advancing the manual clock, delayScale: 0 resolves all waits immediately
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
    await h.conn.close();
  });

  it("merges daemonConfig overrides in Daemon.writeConfig while preserving listen host", () => {
    const ws = new Workspace();
    try {
      const daemon = new Daemon(ws, {
        port: 45678,
        daemonConfig: {
          mcp: { enabled: true },
          enableTerminalAgentHooks: true,
          listen: "should-be-overridden",
        },
      });
      daemon.writeConfig();
      const written = JSON.parse(fs.readFileSync(path.join(ws.paseoHome, "config.json"), "utf8"));
      expect(written.daemon.mcp).toEqual({ enabled: true });
      expect(written.daemon.enableTerminalAgentHooks).toBe(true);
      expect(written.daemon.listen).toBe("127.0.0.1:45678");
    } finally {
      ws.cleanup();
    }
  });

  it("supports waitForRecord, waitForTimeline, and steer in createAgentHelpers", async () => {
    let calls = 0;
    const send = vi.fn(async () => undefined);
    const helpers = createAgentHelpers({
      getApi: () => ({ agents: { ref: () => ({ send }) } }),
      timeline: async () => (++calls >= 2 ? [{ item: { type: "todo", items: [] } }] : []),
      readRecord: () => (calls >= 1 ? [{ kind: "open", cwd: "/repo" }] : []),
    });

    const tl = await helpers.waitForTimeline("a1", (e: { item?: { type?: string } }) => e.item?.type === "todo", {
      timeoutMs: 1000,
      pollMs: 5,
    });
    expect(tl.item.type).toBe("todo");

    const rec = await helpers.waitForRecord((r: { kind?: string }) => r.kind === "open", {
      timeoutMs: 1000,
      pollMs: 5,
    });
    expect(rec).toEqual({ kind: "open", cwd: "/repo" });

    await helpers.steer("a1", "change course");
    expect(send).toHaveBeenCalledWith("change course", {
      activeTurnBehavior: "steer",
    });
  });
});
