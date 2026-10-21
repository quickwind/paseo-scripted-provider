import { describe, expect, it } from "vitest";
import { convertTimeline, type ConvertOptions, type TimelineEntry } from "../../shared/core/capture/convert";
import { parseScript } from "../../shared/core/script";

const base: ConvertOptions = { name: "rec", delay: { mode: "keep" }, includeReasoning: true, includeToolOutput: true };
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const user = (text: string, s?: number): TimelineEntry => ({ item: { type: "user_message", text }, timestamp: s === undefined ? undefined : at(s) });
const asst = (text: string, id: string | undefined, s?: number): TimelineEntry => ({ item: { type: "assistant_message", text, ...(id ? { id, messageId: id } : {}) }, timestamp: s === undefined ? undefined : at(s) });
const tool = (callId: string, status: string, detail: any = { type: "shell", command: "ls", output: "SECRET-OUT", exitCode: 0 }, extra: any = {}, s?: number): TimelineEntry => ({ item: { type: "tool_call", callId, name: "Bash", status, error: null, detail, ...extra }, timestamp: s === undefined ? undefined : at(s) });
const steps = (entries: TimelineEntry[], o: Partial<ConvertOptions> = {}) => convertTimeline(entries, { ...base, ...o }).scenarios.rec;
/** The text of the reply, whatever shape it has. */
const said = (reply: { steps?: { text?: string }[]; text?: string }): string | undefined =>
  reply.steps ? reply.steps.filter((s) => s.text !== undefined).map((s) => s.text).join("") : reply.text;

describe("convertTimeline", () => {
  it("empty entries give an empty scenario", () => {
    expect(convertTimeline([], base)).toEqual({ scenarios: { rec: [] } });
  });
  it("two turns become two replies with expect", () => {
    const s = steps([user("q1"), asst("a1", "m1"), user("q2"), asst("a2", "m2")]);
    expect(s).toMatchObject([{ expect: "q1" }, { expect: "q2" }]);
    expect(said(s[0])).toBe("a1");
    expect(said(s[1])).toBe("a2");
  });
  it("collapses snapshots with the same id to the last text", () => {
    expect(said(steps([user("q"), asst("he", "m1"), asst("hello", "m1")])[0])).toBe("hello");
  });
  it("distinct messages become two message steps", () => {
    const s = steps([user("q"), asst("one", "m1"), asst("two", "m2")])[0].steps!;
    expect(s.filter((x) => x.kind === "message")).toMatchObject([{ text: "one" }, { text: "two" }]);
  });
  it("tool_call running then completed (same callId) yields one completed tool", () => {
    const t = steps([user("q"), tool("c1", "running"), tool("c1", "completed")])[0].steps!;
    expect(t).toHaveLength(1);
    expect(t[0].tool).toMatchObject({ name: "Bash", detail: { type: "shell", command: "ls" } });
    expect(t[0].tool?.status ?? "completed").toBe("completed");
  });
  it("failed tool keeps its error string", () => {
    const e = tool("c1", "failed", { type: "plain_text" }, { error: "boom" });
    expect(steps([user("q"), e])[0].steps![0].tool).toMatchObject({ status: "failed", error: "boom" });
  });
  it("includeToolOutput=false strips output fields", () => {
    const t = steps([user("q"), tool("c1", "completed")], { includeToolOutput: false })[0].steps![0].tool!;
    expect(JSON.stringify(t)).not.toContain("SECRET-OUT");
    expect(t.detail).toMatchObject({ command: "ls" });
  });
  it("includeReasoning toggles reasoning", () => {
    const e = [user("q"), { item: { type: "reasoning", text: "thinking" } }, asst("a", "m")] as TimelineEntry[];
    expect(steps(e)[0].steps![0]).toMatchObject({ kind: "reasoning", text: "thinking" });
    expect(steps(e, { includeReasoning: false })[0].steps!.some((s) => s.kind === "reasoning")).toBe(false);
  });
  it("an error item makes the turn failed", () => {
    expect(steps([user("q"), { item: { type: "error", message: "kaboom" } }])[0]).toMatchObject({ outcome: "failed", error: "kaboom" });
  });
  it("lastTurns keeps only the final N turns", () => {
    const s = steps([user("q1"), asst("a1", "1"), user("q2"), asst("a2", "2")], { lastTurns: 1 });
    expect(s).toHaveLength(1);
    expect(s[0].expect).toBe("q2");
  });

  describe("timing", () => {
    it("every step keeps its real gap to the previous event", () => {
      const s = steps([user("q", 0), { item: { type: "reasoning", text: "thinking" }, timestamp: at(2) }, tool("c", "completed", undefined, {}, 3), asst("a", "m", 5)])[0].steps!;
      // reasoning: 2s after the user message, tool: 1s later, message: 2s later
      expect(s[0]).toMatchObject({ kind: "reasoning", delayMs: 2000 });
      expect(s[1]).toMatchObject({ kind: "tool", delayMs: 1000 });
      expect(s[2]).toMatchObject({ kind: "message", delayMs: 2000 });
    });
    it("the steps add up to the real duration of the turn", () => {
      const s = steps([user("q", 0), { item: { type: "reasoning", text: "t" }, timestamp: at(2) }, asst("a", "m", 5)])[0].steps!;
      expect(s.reduce((sum, x) => sum + (x.delayMs ?? 0), 0)).toBe(5000);
    });
    it("delay modes keep / scale / drop", () => {
      const e = [user("q", 0), asst("a", "m", 2)];
      expect(steps(e)[0].steps![0].delayMs).toBe(2000);
      expect(steps(e, { delay: { mode: "scale", factor: 0.1 } })[0].steps![0].delayMs).toBe(200);
      expect(steps(e, { delay: { mode: "drop" } })[0].steps![0].delayMs).toBeUndefined();
    });
    it("missing timestamps give no delay and no throw", () => {
      expect(steps([user("q"), asst("a", "m")])[0].steps![0].delayMs).toBeUndefined();
    });
  });

  it("ignores unknown item types and entries before the first user message", () => {
    const s = steps([asst("orphan", "o"), user("q"), { item: { type: "weird" } } as TimelineEntry, asst("a", "m")]);
    expect(s).toHaveLength(1);
    expect(s[0].expect).toBe("q");
    expect(said(s[0])).toBe("a");
  });
  it("a trailing user message without a reply keeps only expect", () => {
    expect(steps([user("q")])).toEqual([{ expect: "q" }]);
  });
  it("a final turn with no assistant message is still valid", () => {
    expect(steps([user("q1"), asst("a", "m"), user("q2"), tool("c", "completed")])[1].steps).toHaveLength(1);
  });
  it("truncateAt truncates long text with a marker", () => {
    expect(steps([user("q"), asst("0123456789", "m")], { truncateAt: 5 })[0].steps![0].text).toBe("01234…[truncated]");
  });
  it("output always validates as a script", () => {
    const script = convertTimeline([user("q", 0), tool("c", "failed", { type: "plain_text" }, { error: "x" }), asst("a", "m", 1)], base);
    expect(parseScript(JSON.stringify(script)).ok).toBe(true);
  });
});

describe("hardening (final review)", () => {
  it("a missing or unusable tool detail becomes a valid plain_text detail (C1)", () => {
    const e: TimelineEntry = { item: { type: "tool_call", callId: "c", name: "X", status: "completed", error: null } };
    const out = convertTimeline([user("q"), e], base);
    expect(parseScript(JSON.stringify(out)).ok).toBe(true);
  });
  it("skipping tool output keeps the required keys of unknown / sub_agent details (C1)", () => {
    const unk = tool("a", "completed", { type: "unknown", input: { a: 1 }, output: { SECRET: 1 } });
    const sub = tool("b", "completed", { type: "sub_agent", log: "SECRETLOG", description: "d" });
    const out = convertTimeline([user("q"), unk, sub], { ...base, includeToolOutput: false });
    expect(parseScript(JSON.stringify(out)).ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
  it("one messageId reused across a tool call keeps both parts, snapshots still collapse (I9)", () => {
    const parts = steps([user("q"), asst("first part. ", "m1"), tool("c", "completed"), asst("second part.", "m1")]);
    expect(said(parts[0])).toBe("first part. second part.");
    expect(said(steps([user("q"), asst("he", "m1"), asst("hello", "m1")])[0])).toBe("hello");
  });
  it("an entry without an item is ignored instead of throwing", () => {
    expect(() => convertTimeline([user("q"), {} as TimelineEntry], base)).not.toThrow();
  });
});
