import { describe, expect, it } from "vitest";
import { parseScript } from "../../shared/core/script";
import { connect, open, prompt } from "../helpers/harness";

describe("P0-2: full timeline items, usage/notice/errorCode, and step-level chunks", () => {
  it("emits todo, compaction (loading -> completed), notification, error, plugin, usage, notice, and step chunks", async () => {
    const parsed = parseScript(
      JSON.stringify({
        scenarios: {
          rich: [
            {
              notices: [{ id: "n-1", severity: "warning", title: "Approaching quota", description: "90% used" }],
              steps: [
                { kind: "reasoning", chunks: ["Think ", "deeply."], chunkDelayMs: 50, revertToken: "rev-r1" },
                {
                  kind: "todo",
                  items: [
                    { id: "t1", text: "Read code", completed: true, status: "completed" },
                    { id: "t2", text: "Write tests", completed: false, status: "in_progress", activeForm: "Writing tests" },
                  ],
                  revertToken: "rev-todo",
                },
                { kind: "compaction", runningMs: 100, trigger: "auto", preTokens: 120000 },
                { kind: "notification", level: "info", message: "Context compacted" },
                { kind: "error", message: "Non-fatal warning item" },
                { kind: "plugin", pluginId: "my-plugin", pluginKind: "summary_card", version: 2, data: { score: 99 } },
                {
                  kind: "tool",
                  tool: {
                    name: "Read",
                    detail: { type: "read", filePath: "a.ts", content: "ok" },
                    metadata: { source: "test" },
                    revertToken: "rev-tool",
                  },
                },
                { kind: "message", chunks: ["All ", "done!"], chunkDelayMs: 25, revertToken: "rev-msg" },
              ],
              usage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 350,
                totalCostUsd: 0.012,
                contextWindowUsedTokens: 1350,
                contextWindowMaxTokens: 200000,
              },
            },
          ],
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const h = await connect({ getScript: () => parsed.script });
    await h.send(open("s1", "rich"));
    await h.send(prompt("s1", "go"));
    await h.clock.advance(50);
    await h.clock.advance(100);
    await h.clock.advance(25);

    const items = h.events
      .filter((e) => e.type === "timeline.item")
      .map((e) => e.item as unknown as Record<string, unknown>);
    expect(items.filter((i) => i.type === "reasoning").map((i) => i.text)).toEqual(["Think ", "Think deeply."]);
    expect(items.find((i) => i.type === "reasoning")?.revertToken).toBe("rev-r1");
    expect(items.find((i) => i.type === "todo")).toMatchObject({
      type: "todo",
      revertToken: "rev-todo",
      items: [
        { id: "t1", text: "Read code", completed: true, status: "completed" },
        { id: "t2", text: "Write tests", completed: false, status: "in_progress", activeForm: "Writing tests" },
      ],
    });
    expect(items.filter((i) => i.type === "compaction").map((i) => i.status)).toEqual(["loading", "completed"]);
    expect(items.find((i) => i.type === "notification")).toMatchObject({ level: "info", message: "Context compacted" });
    expect(items.find((i) => i.type === "error")).toMatchObject({ message: "Non-fatal warning item" });
    expect(items.find((i) => i.type === "plugin")).toMatchObject({
      pluginId: "my-plugin",
      kind: "summary_card",
      version: 2,
      data: { score: 99 },
    });
    expect(items.find((i) => i.type === "tool_call")).toMatchObject({
      metadata: { source: "test" },
      revertToken: "rev-tool",
    });
    const msgs = items.filter((i) => i.type === "assistant_message");
    expect(msgs.map((i) => i.text)).toEqual(["All ", "All done!"]);
    expect(msgs[0].id).toBe(msgs[1].id);

    const notice = h.events.find((e) => e.type === "session.notice");
    expect(notice?.type === "session.notice" && notice.notice).toMatchObject({ id: "n-1", severity: "warning", title: "Approaching quota" });

    const usage = h.events.find((e) => e.type === "session.usage");
    expect(usage?.type === "session.usage" && usage.usage).toMatchObject({ inputTokens: 1000, outputTokens: 350, totalCostUsd: 0.012 });

    await h.conn.close();
  });

  it("emits custom errorCode, diagnostic, and session.runtime_failed on quota failure", async () => {
    const h = await connect({
      getScript: () => ({
        scenarios: {
          quota: [
            {
              outcome: "failed",
              error: "You have exceeded your 5-hour usage limit",
              errorCode: "quota_exceeded",
              diagnostic: "reset_at=2026-11-23T01:00:00Z",
              runtimeFailed: true,
            },
          ],
        },
      }),
    });

    await h.send(open("s1", "quota"));
    await h.send(prompt("s1", "run"));
    const rf = h.events.find((e) => e.type === "session.runtime_failed");
    expect(rf?.type === "session.runtime_failed" && rf.error).toEqual({
      message: "You have exceeded your 5-hour usage limit",
      code: "quota_exceeded",
      diagnostic: "reset_at=2026-11-23T01:00:00Z",
    });

    const turnEnd = h.events.find((e) => e.type === "session.turn" && e.state === "failed");
    expect(turnEnd?.type === "session.turn" && turnEnd.error).toEqual({
      message: "You have exceeded your 5-hour usage limit",
      code: "quota_exceeded",
      diagnostic: "reset_at=2026-11-23T01:00:00Z",
    });

    await h.conn.close();
  });

  it("validates required fields on todo, plugin, usage, and notice steps", () => {
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ steps: [{ kind: "todo" }] }] } })).ok).toBe(false);
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ steps: [{ kind: "plugin", pluginId: "x" }] }] } })).ok).toBe(false);
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ steps: [{ kind: "usage" }] }] } })).ok).toBe(false);
    expect(parseScript(JSON.stringify({ scenarios: { a: [{ steps: [{ kind: "notice" }] }] } })).ok).toBe(false);
  });
});
