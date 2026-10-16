import { describe, expect, it } from "vitest";
import { connect, open, prompt, turnStates } from "../helpers/harness";

const S = (scenarios: any, macros?: any) => () => ({ scenarios, macros });
const items = (h: { events: any[] }) => h.events.filter((e) => e.type === "timeline.item").map((e) => e.item);

describe("provider protocol", () => {
  it("open emits opened then ready; catalog lists scenarios", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "x" }] }) });
    await h.send({ type: "catalog", requestId: "c1" });
    const cat = h.events.find((e) => e.type === "catalog") as any;
    expect(cat.catalog.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["a", "default"]));
    await h.send(open());
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["session.opened", "session.ready"]));
  });
  it("plain turn: prompt_result, started, assistant, persistence, completed (in order)", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "hello" }] }) });
    await h.send(open("s1", "a"));
    h.events.length = 0;
    await h.send(prompt("s1", "hi"));
    expect(h.events.map((e) => e.type)).toEqual(["session.prompt_result", "session.turn", "timeline.item", "session.persistence", "session.turn"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
  it("SCENARIO: prefix switches scenario and consumes step 0", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "A0" }], b: [{ text: "B0" }, { text: "B1" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "SCENARIO:b go"));
    await h.send(prompt("s1", "next"));
    expect(items(h).map((i) => i.text)).toEqual(["B0", "B1"]);
  });
  it("unknown model falls back to the default scenario", async () => {
    const h = await connect({ getScript: S({ default: [{ text: "D" }] }) });
    await h.send(open("s1", "nope"));
    await h.send(prompt("s1", "x"));
    expect(items(h)[0].text).toBe("D");
  });
  it("chunks stream as growing snapshots with one id; delays honour the clock", async () => {
    const h = await connect({ getScript: S({ a: [{ chunks: ["a", "b"], chunkDelayMs: 100 }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    expect(items(h)).toHaveLength(1);
    await h.clock.advance(100);
    const it = items(h);
    expect(it.map((i) => i.text)).toEqual(["a", "ab"]);
    expect(it[0].id).toBe(it[1].id);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
  it("outcome failed / canceled produce the matching terminal state", async () => {
    const h = await connect({ getScript: S({ f: [{ outcome: "failed", error: "bad" }], c: [{ outcome: "canceled" }] }) });
    await h.send(open("s1", "f"));
    await h.send(prompt("s1", "x"));
    await h.send(open("s2", "c"));
    await h.send(prompt("s2", "x"));
    expect(turnStates(h.events)).toEqual(["started", "failed", "started", "canceled"]);
  });
  it("hang ends only on interrupt; double interrupt yields ONE terminal event", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "p", outcome: "hang" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    expect(turnStates(h.events)).toEqual(["started"]);
    await h.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    await h.send({ type: "session.interrupt", requestId: "i2", sessionId: "s1" });
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
    expect(h.events.filter((e) => e.type === "request.completed").length).toBeGreaterThanOrEqual(2);
  });
  it("interrupt during a delay cancels immediately and suppresses later items", async () => {
    const h = await connect({ getScript: S({ a: [{ startDelayMs: 1000, text: "late" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    await h.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    await h.clock.advance(5000);
    expect(items(h)).toHaveLength(0);
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
  });
  it("a new prompt supersedes an active turn (old one canceled, exactly once)", async () => {
    const h = await connect({ getScript: S({ a: [{ outcome: "hang" }, { text: "second" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "one"));
    await h.send(prompt("s1", "two"));
    expect(turnStates(h.events)).toEqual(["started", "canceled", "started", "completed"]);
  });
  it("strict alignment fails the prompt on mismatch; warn proceeds; both record", async () => {
    const rec: any[] = [];
    const recorder = () => ({ record: (k: string, d: any) => rec.push({ k, ...d }) });
    const script = S({ a: [{ expect: "hello", text: "ok" }] });
    const strict = await connect({ getScript: script, getConfig: () => ({ alignment: "strict" }), recorder });
    await strict.send(open("s1", "a"));
    await strict.send(prompt("s1", "WRONG"));
    expect(strict.events.find((e) => e.type === "session.prompt_result")).toMatchObject({ result: { type: "failed", error: { code: "E_SCRIPT_MISMATCH" } } });
    const warn = await connect({ getScript: script, recorder });
    await warn.send(open("s1", "a"));
    await warn.send(prompt("s1", "WRONG"));
    expect(turnStates(warn.events)).toEqual(["started", "completed"]);
    expect(rec.filter((r) => r.k === "mismatch")).toHaveLength(2);
  });
  it("command and image-only prompts are answered, not thrown", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "ok" }] }) });
    await h.send(open("s1", "a"));
    await h.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "command", name: "go", arguments: "now" } } });
    await h.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c2", delivery: "auto", input: { type: "message", content: [{ type: "image", data: "AA", mimeType: "image/png" }] } } });
    expect(turnStates(h.events)).toEqual(["started", "completed", "started", "completed"]);
  });
  it("unknown session prompt fails the prompt_result", async () => {
    const h = await connect({ getScript: S({}) });
    await h.send(prompt("ghost", "x"));
    expect(h.events[0]).toMatchObject({ type: "session.prompt_result", result: { type: "failed" } });
  });
  it("persistence restores scenario/step and replays transcript", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "1" }, { text: "2" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    const p = [...h.events].reverse().find((e) => e.type === "session.persistence") as any;
    const h2 = await connect({ getScript: S({ a: [{ text: "1" }, { text: "2" }] }) });
    await h2.send({ ...(open("s9") as any), persistence: p.persistence, history: "replay" });
    expect(items(h2).map((i) => i.text)).toEqual(["x", "1"]);
    await h2.send(prompt("s9", "y"));
    expect(items(h2).pop().text).toBe("2");
  });
  it("tools: running then completed share an id; failed carries error; detail passes through", async () => {
    const h = await connect({ getScript: S({ a: [{ tools: [{ name: "Bash", runningMs: 50, detail: { type: "shell", command: "ls", output: "x", exitCode: 0 } }, { name: "Edit", status: "failed", error: "conflict", detail: { type: "edit", filePath: "a.ts" } }] }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    await h.clock.advance(50);
    const it = items(h);
    expect(it.map((i) => `${i.name}:${i.status}`)).toEqual(["Bash:running", "Bash:completed", "Edit:failed"]);
    expect(it[0].id).toBe(it[1].id);
    expect(it[2].error).toBe("conflict");
  });
  it("empty script object still serves the default scenario", async () => {
    const h = await connect({ getScript: S({}) });
    await h.send(open("s1"));
    await h.send(prompt("s1", "x"));
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
  it("multi-chunk reply is persisted as one merged assistant message", async () => {
    const h = await connect({ getScript: S({ a: [{ chunks: ["a", "b"], chunkDelayMs: 1 }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    await h.clock.advance(5);
    const p = [...h.events].reverse().find((e) => e.type === "session.persistence") as any;
    expect(p.persistence.data.transcript.map((t: any) => t.text)).toEqual(["x", "ab"]);
  });
});

describe("robustness (final review)", () => {
  it("a throwing listener mid-turn ends the turn as failed instead of hanging (C1 safety net)", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "x" }] }) });
    await h.send(open("s1", "a"));
    let armed = true;
    h.conn.onEvent((e: any) => {
      if (armed && e.type === "timeline.item") { armed = false; throw new Error("sdk rejected item"); }
    });
    await h.send(prompt("s1", "go"));
    expect(turnStates(h.events)).toEqual(["started", "failed"]);
  });
  it("a prompt that cannot be processed still gets a failed prompt_result (I1)", async () => {
    let boom = false;
    const h = await connect({ getScript: () => { if (boom) throw new Error("kaput"); return { scenarios: { a: [{ text: "x" }] } }; } });
    await h.send(open("s1", "a"));
    boom = true;
    await h.send(prompt("s1", "go"));
    expect(h.events.find((e) => e.type === "session.prompt_result")).toMatchObject({ result: { type: "failed" } });
  });
  it("session.close releases a hanging turn and stays silent afterwards (I10)", async () => {
    const h = await connect({ getScript: S({ a: [{ startDelayMs: 500, text: "late", outcome: "hang" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "go"));
    h.events.length = 0;
    await h.send({ type: "session.close", requestId: "c", sessionId: "s1" });
    await h.clock.advance(1000);
    expect(h.events.map((e) => e.type)).toEqual(["request.completed", "session.closed"]);
  });
  it("text attachments do not glue onto the prompt text (minor, shares the fix)", async () => {
    const rec: any[] = [];
    const h = await connect({ getScript: S({ a: [{ text: "ok" }], b: [{ text: "B" }] }), recorder: () => ({ record: (k: string, d: any) => rec.push({ k, ...d }) }) });
    await h.send(open("s1", "a"));
    await h.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "SCENARIO:b" }, { type: "text", mimeType: "text/plain", text: "file body" } as any] } } });
    expect(rec.find((r) => r.k === "prompt").scenario).toBe("b");
  });
});

describe("replay by content (user report: the 2nd prompt answered with the 1st reply)", () => {
  const script = () => ({ scenarios: { r: [{ expect: "alpha", text: "A" }, { expect: "beta", text: "B" }, { expect: "gamma", text: "C" }] } });
  const replies = (h: { events: any[] }) => h.events.filter((e) => e.type === "timeline.item").map((e) => e.item.text);
  it("answers the prompt that was sent, even when the first message is a later step", async () => {
    const h = await connect({ getScript: script });
    await h.send(open("s1", "r"));
    await h.send(prompt("s1", "beta"));
    await h.send(prompt("s1", "gamma"));
    await h.send(prompt("s1", "alpha"));
    expect(replies(h)).toEqual(["B", "C", "A"]);
  });
  it("continues in order after a content jump and falls back to order for unknown messages", async () => {
    const h = await connect({ getScript: script });
    await h.send(open("s1", "r"));
    await h.send(prompt("s1", "beta"));
    await h.send(prompt("s1", "something else"));
    expect(replies(h)).toEqual(["B", "C"]);
  });
  it("ignore mode stays strictly sequential", async () => {
    const h = await connect({ getScript: script, getConfig: () => ({ alignment: "ignore" }) });
    await h.send(open("s1", "r"));
    await h.send(prompt("s1", "beta"));
    expect(replies(h)).toEqual(["A"]);
  });
  it("strict mode still rejects a message that is not the current step", async () => {
    const h = await connect({ getScript: script, getConfig: () => ({ alignment: "strict" }) });
    await h.send(open("s1", "r"));
    await h.send(prompt("s1", "beta"));
    expect(h.events.find((e) => e.type === "session.prompt_result")).toMatchObject({ result: { type: "failed" } });
  });
});
