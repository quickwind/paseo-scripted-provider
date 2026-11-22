import { describe, expect, it } from "vitest";
import { connect, open, prompt } from "../helpers/harness";

describe("P0-3: full timeline persistence v2, template hydration, and exhaustion policy", () => {
  it("persists and replays full timeline items (reasoning, tool_call, todo, separate messages) without merging", async () => {
    const script = {
      scenarios: {
        replay: [
          {
            steps: [
              { kind: "reasoning" as const, text: "thinking" },
              {
                kind: "tool" as const,
                tool: { name: "Read", detail: { type: "read" as const, filePath: "{{cwd}}/a.ts", content: "ok" }, runningMs: 20 },
              },
              { kind: "message" as const, text: "first part" },
              { kind: "message" as const, text: "second part" },
            ],
          },
        ],
      },
    };

    const h = await connect({ getScript: () => script });
    await h.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      history: "skip",
      config: { cwd: "/work/my-app", env: {}, mcpServers: {}, settings: {}, persist: true, model: "replay" },
    });
    await h.send(prompt("s1", "hello"));
    await h.clock.advance(20);

    const persistEv = [...h.events].reverse().find((e) => e.type === "session.persistence");
    expect(persistEv?.type).toBe("session.persistence");
    if (persistEv?.type !== "session.persistence") return;
    expect(persistEv.persistence.version).toBe(2);

    // Re-open with history: "replay"
    const h2 = await connect({ getScript: () => script });
    await h2.send({
      type: "session.open",
      requestId: "r2",
      sessionId: "s2",
      history: "replay",
      persistence: persistEv.persistence,
      config: { cwd: "/work/my-app", env: {}, mcpServers: {}, settings: {}, persist: true, model: "replay" },
    });

    const replayed = h2.events
      .filter((e) => e.type === "timeline.item")
      .map((e) => e.item as unknown as Record<string, unknown>);
    expect(replayed.map((i) => i.type)).toEqual(["user_message", "reasoning", "tool_call", "assistant_message", "assistant_message"]);
    expect((replayed[2].detail as { filePath: string }).filePath).toBe("/work/my-app/a.ts");
    expect(replayed[2].status).toBe("completed");
    expect(replayed[3].text).toBe("first part");
    expect(replayed[4].text).toBe("second part");

    await h.conn.close();
    await h2.conn.close();
  });

  it("re-hydrates {{cwd}}, {{prompt.text}}, {{session.*}}, and {{permission.updatedInput.*}} while preserving {{secret_1}}", async () => {
    const h = await connect({
      getScript: () => ({
        scenarios: {
          tpl: [
            {
              tools: [
                {
                  name: "Bash",
                  detail: { type: "shell", command: "cat {{cwd}}/secret.txt" },
                  permission: {
                    id: "p1",
                    title: "Run in {{session.cwd}} ({{session.mode}})?",
                    on: {
                      allow: {
                        text: "Ran {{permission.updatedInput.command}} for '{{prompt.text}}' on {{session.model}} (secret={{secret_1}})",
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
    });

    await h.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      history: "skip",
      config: { cwd: "/sandbox/proj", env: {}, mcpServers: {}, settings: {}, persist: true, model: "tpl", mode: "plan" },
    });
    await h.send(prompt("s1", "inspect files"));

    const perm = h.events.find((e) => e.type === "session.permission");
    expect(perm?.type === "session.permission" && perm.request.title).toBe("Run in /sandbox/proj (plan)?");

    await h.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "p1",
      response: { behavior: "allow", updatedInput: { command: "cat safe.txt" } },
    });

    const msg = h.events
      .filter((e) => e.type === "timeline.item")
      .map((e) => e.item)
      .find((i) => i.type === "assistant_message");
    expect(msg?.type === "assistant_message" && msg.text).toBe(
      "Ran cat safe.txt for 'inspect files' on tpl (secret={{secret_1}})",
    );

    await h.conn.close();
  });

  it("supports onExhausted: fail (E_SCRIPT_EXHAUSTED) and cycle", async () => {
    const failH = await connect({
      getScript: () => ({
        onExhausted: "fail",
        scenarios: { one: [{ text: "only once" }] },
      }),
    });
    await failH.send(open("s1", "one"));
    await failH.send(prompt("s1", "first", "m1"));
    await failH.send(prompt("s1", "second", "m2"));

    const secondResult = failH.events.find(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m2",
    );
    expect(secondResult?.type === "session.prompt_result" && secondResult.result).toEqual({
      type: "failed",
      error: { message: 'Scenario "one" exhausted at step 1', code: "E_SCRIPT_EXHAUSTED" },
    });
    await failH.conn.close();

    const cycleH = await connect({
      getScript: () => ({
        onExhausted: "cycle",
        scenarios: { two: [{ text: "A" }, { text: "B" }] },
      }),
    });
    await cycleH.send(open("s1", "two"));
    await cycleH.send(prompt("s1", "1", "c1"));
    await cycleH.send(prompt("s1", "2", "c2"));
    await cycleH.send(prompt("s1", "3", "c3"));

    const texts = cycleH.events
      .filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message")
      .map((e) => (e.type === "timeline.item" && e.item.type === "assistant_message" ? e.item.text : ""));
    expect(texts).toEqual(["A", "B", "A"]);
    await cycleH.conn.close();
  });
});
