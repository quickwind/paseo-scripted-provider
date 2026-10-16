import { describe, expect, it } from "vitest";
import { planReply } from "../../shared/core/planner";

let n = 0;
const key = () => `k${++n}`;
const kinds = (a: ReturnType<typeof planReply>) => a.map((x) => x.t);

describe("planReply", () => {
  it("text only: one assistant item then end", () => {
    expect(planReply({ text: "hi" }, key)).toEqual([
      { t: "assistant", key: expect.any(String), text: "hi" },
      { t: "end", outcome: "completed", error: undefined },
    ]);
  });
  it("orders start delay, reasoning, tools, body, end delay", () => {
    const a = planReply({ startDelayMs: 5, reasoning: "r", tools: [{ name: "T", detail: { type: "plain_text" } }], text: "x", delayMs: 7 }, key);
    expect(kinds(a)).toEqual(["sleep", "reasoning", "tool", "assistant", "sleep", "end"]);
  });
  it("chunks are growing snapshots of ONE key", () => {
    const a = planReply({ chunks: ["a", "b", "c"], chunkDelayMs: 3 }, key).filter((x) => x.t === "assistant") as any[];
    expect(a.map((x) => x.text)).toEqual(["a", "ab", "abc"]);
    expect(new Set(a.map((x) => x.key)).size).toBe(1);
  });
  it("messages get distinct keys, with a tool between when asked", () => {
    const a = planReply({ messages: ["m1", "m2"], toolBetween: true }, key);
    expect(kinds(a)).toEqual(["assistant", "tool", "sleep", "assistant", "end"]);
    const keys = a.filter((x) => x.t === "assistant").map((x: any) => x.key);
    expect(new Set(keys).size).toBe(2);
  });
  it("a tool with runningMs emits running then final with the same key", () => {
    const a = planReply({ tools: [{ name: "T", detail: { type: "plain_text" }, runningMs: 50, status: "failed", error: "boom" }] }, key);
    const tools = a.filter((x) => x.t === "tool") as any[];
    expect(tools.map((t) => t.status)).toEqual(["running", "failed"]);
    expect(tools[0].key).toBe(tools[1].key);
    expect(a.some((x) => x.t === "sleep" && x.ms === 50)).toBe(true);
  });
  it("omits zero sleeps and carries outcome/error", () => {
    expect(planReply({ outcome: "failed", error: "nope", startDelayMs: 0 }, key)).toEqual([{ t: "end", outcome: "failed", error: "nope" }]);
  });
  it("empty reply is just an end", () => {
    expect(planReply({}, key)).toEqual([{ t: "end", outcome: "completed", error: undefined }]);
  });
});
