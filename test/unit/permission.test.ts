import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import { buildRequest, permissionVars, selectBranch, substituteBranch, type PermissionResponse } from "../../shared/core/permission";
import type { PermissionSpec } from "../../shared/core/schema";

const Q = (header: string) => ({ header, question: `${header}?`, options: [{ label: "A" }, { label: "B" }] });
const allow = (o: Partial<Extract<PermissionResponse, { behavior: "allow" }>> = {}): PermissionResponse => ({ behavior: "allow", ...o });
const deny = (o: Partial<Extract<PermissionResponse, { behavior: "deny" }>> = {}): PermissionResponse => ({ behavior: "deny", ...o });
const answers = (a: Record<string, string>) => allow({ updatedInput: { answers: a } });
const b = (text: string) => ({ text });

describe("buildRequest", () => {
  it("uses the tool's name and detail for a tool card", () => {
    const r = buildRequest({}, "p1", { name: "Bash", detail: { type: "shell", command: "ls" } });
    expect(r).toEqual({ id: "p1", name: "Bash", kind: "tool", detail: { type: "shell", command: "ls" } });
  });
  it("infers question, plan, mode and other cards with default names", () => {
    expect(buildRequest({ questions: [Q("F")] }, "p")).toMatchObject({ kind: "question", name: "AskUserQuestion", input: { questions: [Q("F")] } });
    expect(buildRequest({ plan: "1. x" }, "p")).toMatchObject({ kind: "plan", name: "ExitPlanMode", input: { plan: "1. x" } });
    expect(buildRequest({ kind: "mode" }, "p")).toMatchObject({ kind: "mode", name: "SwitchMode" });
    expect(buildRequest({}, "p")).toEqual({ id: "p", kind: "other", name: "permission" });
  });
  it("merges input with plan and questions, and passes the rest through", () => {
    const spec: PermissionSpec = {
      name: "Custom",
      title: "T",
      description: "D",
      input: { a: 1 },
      plan: "P",
      metadata: { m: true },
      suggestions: [{ s: 1 }],
      actions: [{ id: "x", label: "X", behavior: "allow" }],
    };
    expect(buildRequest(spec, "p")).toEqual({
      id: "p",
      name: "Custom",
      kind: "plan",
      title: "T",
      description: "D",
      input: { a: 1, plan: "P" },
      metadata: { m: true },
      suggestions: [{ s: 1 }],
      actions: [{ id: "x", label: "X", behavior: "allow" }],
    });
  });
  it("produces a valid session.permission event", () => {
    const request = buildRequest({ questions: [Q("F")], actions: [{ id: "a", label: "A", behavior: "deny" }] }, "p", {
      name: "T",
      detail: { type: "plain_text" },
    });
    expect(ProviderEventSchema.safeParse({ type: "session.permission", sessionId: "s", request }).success).toBe(true);
  });
});

describe("selectBranch", () => {
  const spec = (on: PermissionSpec["on"], extra: PermissionSpec = {}): PermissionSpec => ({ ...extra, on });
  it("action id beats answer", () => {
    expect(selectBranch(spec({ once: b("1"), "answer:A": b("2") }, { questions: [Q("F")] }), allow({ selectedActionId: "once", updatedInput: { answers: { F: "A" } } }))?.key).toBe("once");
  });
  it("answer:<header>=<v> beats answer:<v>", () => {
    expect(selectBranch(spec({ "answer:A": b("1"), "answer:F=A": b("2") }, { questions: [Q("F")] }), answers({ F: "A" }))?.key).toBe("answer:F=A");
  });
  it("answer beats allow", () => {
    expect(selectBranch(spec({ allow: b("1"), "answer:A": b("2") }, { questions: [Q("F")] }), answers({ F: "A" }))?.key).toBe("answer:A");
  });
  it("allow/deny beat any", () => {
    expect(selectBranch(spec({ any: b("1"), deny: b("2") }), deny())?.key).toBe("deny");
    expect(selectBranch(spec({ any: b("1"), deny: b("2") }), allow())?.key).toBe("any");
  });
  it("nothing matching gives undefined", () => {
    expect(selectBranch(spec({ deny: b("1") }), allow())).toBeUndefined();
    expect(selectBranch({}, allow())).toBeUndefined();
  });
  it("multi-question header matches follow questions declaration order", () => {
    const s = spec({ "answer:Lang=TS": b("lang"), "answer:Framework=React": b("fw") }, { questions: [Q("Framework"), Q("Lang")] });
    expect(selectBranch(s, answers({ Framework: "React", Lang: "TS" }))?.key).toBe("answer:Framework=React");
  });
  it("without declared questions the first answer is the first value", () => {
    expect(selectBranch(spec({ "answer:X": b("1") }), answers({ Q: "X" }))?.key).toBe("answer:X");
  });
  it("an empty answer is a real answer", () => {
    expect(selectBranch(spec({ "answer:": b("empty"), allow: b("a") }, { questions: [Q("F")] }), answers({ F: "" }))?.key).toBe("answer:");
  });
  it("questions given in input count as declared", () => {
    const s = spec({ "answer:B": b("1") }, { input: { questions: [Q("Z"), Q("Y")] } });
    expect(selectBranch(s, answers({ Y: "A", Z: "B" }))?.key).toBe("answer:B");
  });
});

describe("permissionVars", () => {
  it("fills a deny", () => {
    expect(permissionVars({}, deny({ message: "Denied by user", selectedActionId: "reject" }))).toEqual({
      behavior: "deny",
      action: "reject",
      message: "Denied by user",
      answer: "",
    });
  });
  it("fills answers with any header", () => {
    const v = permissionVars({ questions: [Q("部署 方式")] }, answers({ "部署 方式": "A, B" }));
    expect(v["answers.部署 方式"]).toBe("A, B");
    expect(v.answer).toBe("A, B");
  });
});

describe("substituteBranch", () => {
  const vars = { message: "hi", action: "x" };
  it("replaces only known permission variables", () => {
    const out = substituteBranch({ text: "{{secret_1}} said {{permission.message}} {{permission.nope}} {{cwd}}" }, vars);
    expect(out.text).toBe("{{secret_1}} said hi {{permission.nope}} {{cwd}}");
  });
  it("replaces in error, step texts, tool details and nested card fields, but not nested on", () => {
    const out = substituteBranch(
      {
        error: "e {{permission.action}}",
        steps: [
          { kind: "message", text: "m {{permission.message}}" },
          { kind: "tool", tool: { name: "T", detail: { type: "shell", command: "echo {{permission.message}}" }, error: "{{permission.action}}" } },
          {
            kind: "permission",
            permission: {
              title: "t {{permission.message}}",
              description: "d {{permission.message}}",
              plan: "p {{permission.message}}",
              input: { deep: ["{{permission.message}}"] },
              questions: [{ header: "H", question: "q {{permission.message}}", options: [{ label: "{{permission.action}}" }] }],
              on: { allow: { text: "keep {{permission.message}}" } },
            },
          },
        ],
      },
      vars,
    );
    expect(out.error).toBe("e x");
    expect(out.steps![0].text).toBe("m hi");
    expect(out.steps![1].tool).toMatchObject({ detail: { command: "echo hi" }, error: "x" });
    const p = out.steps![2].permission!;
    expect([p.title, p.description, p.plan]).toEqual(["t hi", "d hi", "p hi"]);
    expect(p.input).toEqual({ deep: ["hi"] });
    expect(p.questions![0]).toMatchObject({ question: "q hi", options: [{ label: "x" }] });
    expect(p.on!.allow.text).toBe("keep {{permission.message}}");
  });
});
