import { describe, expect, it } from "vitest";
import { ScriptSchema } from "../../shared/core/schema";
import { parseScript } from "../../shared/core/script";

const script = (reply: object) => JSON.stringify({ scenarios: { a: [reply] } });
const parse = (reply: object) => parseScript(script(reply));
const Q = { header: "F", question: "?", options: [{ label: "A" }] };
const bash = { name: "Bash", detail: { type: "shell", command: "rm" } };

describe("permission schema", () => {
  it("accepts a tool permission with actions and on-branches", () => {
    const r = parse({
      tools: [
        {
          ...bash,
          permission: {
            actions: [{ id: "once", label: "Once", behavior: "allow" }],
            on: { deny: { text: "no", outcome: "canceled" } },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts standalone permission and parallel steps", () => {
    const r = parse({
      steps: [
        { kind: "permission", permission: { questions: [Q] } },
        {
          kind: "parallel",
          steps: [
            { kind: "tool", tool: { ...bash, permission: { id: "a" } } },
            { kind: "permission", permission: { id: "b" } },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("keeps unknown question fields", () => {
    const q = { header: "F", question: "?", dismissLabel: "Skip", options: [{ label: "A", preview: "p" }] };
    const r = parse({ steps: [{ kind: "permission", permission: { questions: [q] } }] });
    if (!r.ok) throw new Error(r.error);
    const got = (r.script.scenarios.a[0].steps![0] as any).permission.questions[0];
    expect(got.dismissLabel).toBe("Skip");
    expect(got.options[0].preview).toBe("p");
  });

  it("rejects empty action id", () => {
    const r = parse({ tools: [{ ...bash, permission: { actions: [{ id: "", label: "x", behavior: "allow" }] } }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("actions");
  });

  it("rejects a kind: permission step without permission", () => {
    expect(parse({ steps: [{ kind: "permission" }] }).ok).toBe(false);
  });

  it("rejects duplicate explicit ids in one parallel group", () => {
    const r = parse({
      steps: [
        {
          kind: "parallel",
          steps: [
            { kind: "permission", permission: { id: "a" } },
            { kind: "tool", tool: { ...bash, permission: { id: "a" } } },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate permission id "a"');
  });

  it("rejects parallel children other than tool/permission, and nested parallel", () => {
    const msg = parse({ steps: [{ kind: "parallel", steps: [{ kind: "message", text: "x" }] }] });
    const nested = parse({
      steps: [{ kind: "parallel", steps: [{ kind: "parallel", steps: [{ kind: "permission", permission: {} }] }] }],
    });
    expect(msg.ok).toBe(false);
    expect(nested.ok).toBe(false);
  });

  it("rejects non-JSON input", () => {
    const r = ScriptSchema.safeParse({
      scenarios: { a: [{ steps: [{ kind: "permission", permission: { input: { x: undefined } } }] }] },
    });
    expect(r.success).toBe(false);
  });
});
