import { describe, expect, it } from "vitest";
import { connect, open, prompt, turnStates } from "../helpers/harness";

const S = (scenarios: any) => () => ({ scenarios });
const bash = (permission: object, extra: object = {}) => ({ name: "Bash", detail: { type: "shell", command: "rm -rf build" }, permission, ...extra });
const items = (h: { events: any[] }) => h.events.filter((e) => e.type === "timeline.item").map((e) => e.item);
const texts = (h: { events: any[] }) => items(h).filter((i) => i.type === "assistant_message").map((i) => i.text);
const tools = (h: { events: any[] }) => items(h).filter((i) => i.type === "tool_call").map((i) => i.status);
const cards = (h: { events: any[] }) => h.events.filter((e) => e.type === "session.permission").map((e) => e.request);
const resolved = (h: { events: any[] }) => h.events.filter((e) => e.type === "session.permission_resolved").map((e) => e.permissionId);

async function setup(scenarios: any, sid = "s1") {
  const rec: any[] = [];
  const h = await connect({ getScript: S(scenarios), recorder: () => ({ record: (kind, d) => rec.push({ kind, ...d }) }) });
  await h.send(open(sid, "a"));
  const respond = (permissionId: string, response: any, sessionId = sid) =>
    h.send({ type: "session.permission", sessionId, permissionId, response } as any);
  return { ...h, rec, respond };
}

describe("permission cards: single card", () => {
  it("advertises the permission capability", async () => {
    const h = await setup({ a: [{ text: "x" }] });
    const opened = h.events.find((e) => e.type === "session.opened") as any;
    expect(opened.capabilities).toContain("permission");
  });

  it("tool card: running tool, then card, turn waits", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" })], text: "after" }] });
    await h.send(prompt("s1", "go"));
    const types = h.events.map((e) => (e.type === "timeline.item" ? `item:${(e as any).item.status}` : e.type));
    expect(types.slice(-2)).toEqual(["item:running", "session.permission"]);
    expect(cards(h)[0]).toMatchObject({ id: "p", name: "Bash", kind: "tool" });
    expect(turnStates(h.events)).toEqual(["started"]);
  });

  it("allow: resolved, tool completed after runningMs, reply continues", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" }, { runningMs: 500 })], text: "after" }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "allow" });
    expect(resolved(h)).toEqual(["p"]);
    expect(tools(h)).toEqual(["running"]);
    await h.clock.advance(500);
    expect(tools(h)).toEqual(["running", "completed"]);
    expect(texts(h)).toEqual(["after"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });

  it("deny without branch: tool failed with the deny message, reply continues", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" }), bash({ id: "q" })], text: "after" }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "deny", message: "Denied by user" });
    await h.respond("q", { behavior: "deny" });
    const failed = items(h).filter((i) => i.status === "failed");
    expect(failed.map((i) => i.error)).toEqual(["Denied by user", "denied"]);
    expect(texts(h)).toEqual(["after"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });

  it("deny with interrupt: tool failed, turn canceled, no branch", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p", on: { deny: { text: "branch" } } })], text: "after" }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "deny", interrupt: true });
    expect(tools(h)).toEqual(["running", "failed"]);
    expect(texts(h)).toEqual([]);
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
  });

  it("branch by action id runs its text and steps, then the rest of the reply", async () => {
    const on = { once: { text: "once!", steps: [{ kind: "message", text: "step" }] }, allow: { text: "plain allow" } };
    const h = await setup({ a: [{ steps: [{ kind: "tool", tool: bash({ id: "p", on }) }, { kind: "message", text: "rest" }] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "allow", selectedActionId: "once" });
    expect(texts(h)).toEqual(["once!", "step", "rest"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });

  it("branch outcome ends the turn and keeps the branch text in the transcript", async () => {
    const on = { deny: { text: "ok, stopping", outcome: "canceled" } };
    const h = await setup({ a: [{ steps: [{ kind: "tool", tool: bash({ id: "p", on }) }, { kind: "message", text: "rest" }] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "deny" });
    expect(texts(h)).toEqual(["ok, stopping"]);
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
    const persist = h.events.filter((e) => e.type === "session.persistence").at(-1) as any;
    expect(persist.persistence.data.transcript.at(-1)).toMatchObject({ type: "assistant_message", text: "ok, stopping" });
  });

  it("branch outcome hang waits for interrupt", async () => {
    const h = await setup({ a: [{ steps: [{ kind: "permission", permission: { id: "p", on: { allow: { text: "waiting", outcome: "hang" } } } }, { kind: "message", text: "rest" }] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "allow" });
    expect(texts(h)).toEqual(["waiting"]);
    expect(turnStates(h.events)).toEqual(["started"]);
    await h.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
    expect(texts(h)).toEqual(["waiting"]);
  });

  it("branch text substitutes {{permission.message}}", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p", on: { deny: { text: "you said: {{permission.message}}" } } })] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "deny", message: "not today" });
    expect(texts(h)).toEqual(["you said: not today"]);
  });

  it("standalone question card answered → answer branch", async () => {
    const q = { header: "Framework", question: "Which?", options: [{ label: "React" }, { label: "Vue" }] };
    const h = await setup({ a: [{ steps: [{ kind: "permission", permission: { id: "p", questions: [q], on: { "answer:Vue": { text: "Vue it is" } } } }] }] });
    await h.send(prompt("s1", "go"));
    expect(cards(h)[0]).toMatchObject({ kind: "question", name: "AskUserQuestion", input: { questions: [q] } });
    expect(tools(h)).toEqual([]);
    await h.respond("p", { behavior: "allow", updatedInput: { questions: [q], answers: { Framework: "Vue" } } });
    expect(texts(h)).toEqual(["Vue it is"]);
  });

  it("nested card inside a branch is raised and answered with its own branches", async () => {
    const inner = { id: "q", title: "outer said {{permission.action}}", on: { deny: { text: "inner {{permission.behavior}}" } } };
    const h = await setup({ a: [{ steps: [{ kind: "permission", permission: { id: "p", on: { allow: { steps: [{ kind: "permission", permission: inner }] } } } }] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "allow", selectedActionId: "accept" });
    expect(cards(h).map((c) => c.id)).toEqual(["p", "q"]);
    expect(cards(h)[1].title).toBe("outer said accept");
    await h.respond("q", { behavior: "deny" });
    expect(texts(h)).toEqual(["inner deny"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });

  it("interrupt while waiting: card resolved, tool canceled, then turn canceled", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" })] }] });
    await h.send(prompt("s1", "go"));
    const from = h.events.length;
    await h.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    const tail = h.events.slice(from).map((e: any) => (e.type === "timeline.item" ? `item:${e.item.status}` : e.type === "session.turn" ? `turn:${e.state}` : e.type));
    expect(tail).toEqual(["session.permission_resolved", "item:canceled", "session.persistence", "turn:canceled", "request.completed"]);
    expect(h.rec.find((r) => r.kind === "permission_canceled")).toMatchObject({ permissionId: "p", reason: "interrupted" });
  });

  it("new prompt while waiting supersedes: card resolved with reason superseded, next reply runs", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" })] }, { text: "second" }] });
    await h.send(prompt("s1", "go"));
    await h.send(prompt("s1", "again"));
    expect(resolved(h)).toEqual(["p"]);
    expect(h.rec.find((r) => r.kind === "permission_canceled")).toMatchObject({ permissionId: "p", reason: "superseded" });
    expect(texts(h)).toEqual(["second"]);
    expect(turnStates(h.events)).toEqual(["started", "canceled", "started", "completed"]);
  });

  it("duplicate response and stale response are ignored", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" })], text: "after" }, { tools: [bash({ id: "r" })] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "allow" });
    const n = h.events.length;
    await h.respond("p", { behavior: "allow" });
    await h.send(prompt("s1", "two"));
    await h.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    const m = h.events.length;
    await h.respond("r", { behavior: "allow" });
    expect(h.events.length).toBe(m);
    expect(h.events.slice(n, n + 1).map((e) => e.type)).not.toContain("session.permission_resolved");
    expect(h.rec.filter((r) => r.kind === "permission_unknown").map((r) => r.permissionId)).toEqual(["p", "r"]);
  });

  it("response for another or closed session is ignored", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p" })], text: "after" }] });
    await h.send(open("s2", "a"));
    await h.send(prompt("s1", "go"));
    await h.send(prompt("s2", "go"));
    await h.respond("p", { behavior: "allow" }, "s2");
    expect(h.events.filter((e: any) => e.type === "session.turn" && e.state === "completed").map((e: any) => e.sessionId)).toEqual(["s2"]);
    await h.send({ type: "session.close", requestId: "c", sessionId: "s1" });
    const n = h.events.length;
    await h.respond("p", { behavior: "allow" }, "s1");
    expect(h.events.length).toBe(n);
  });

  it("explicit id can be reused in a later turn", async () => {
    const reply = { tools: [bash({ id: "p" })], text: "done" };
    const h = await setup({ a: [reply, reply] });
    await h.send(prompt("s1", "one"));
    await h.respond("p", { behavior: "allow" });
    await h.send(prompt("s1", "two"));
    await h.respond("p", { behavior: "allow" });
    expect(cards(h).map((c) => c.id)).toEqual(["p", "p"]);
    expect(texts(h)).toEqual(["done", "done"]);
    expect(turnStates(h.events)).toEqual(["started", "completed", "started", "completed"]);
  });

  it("recorder gets permission_requested and permission_response", async () => {
    const h = await setup({ a: [{ tools: [bash({ id: "p", on: { reject: { text: "no" } } })] }] });
    await h.send(prompt("s1", "go"));
    await h.respond("p", { behavior: "deny", selectedActionId: "reject", message: "Denied by user" });
    expect(h.rec.find((r) => r.kind === "permission_requested")).toMatchObject({ sessionId: "s1", permissionId: "p", cardKind: "tool", name: "Bash" });
    expect(h.rec.find((r) => r.kind === "permission_response")).toMatchObject({
      sessionId: "s1",
      permissionId: "p",
      behavior: "deny",
      selectedActionId: "reject",
      message: "Denied by user",
      branch: "reject",
    });
  });
});
