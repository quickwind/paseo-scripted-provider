import { describe, expect, it } from "vitest";
import { parseScript } from "../../shared/core/script";
import { connect, open, prompt, turnStates } from "../helpers/harness";

describe("P0-4: session.configure (dual-write), modes/thinking/controls, commands, can_stop_runtime, and prompt.steer", () => {
  it("exposes catalog modes/thinking, dual-writes session.config, updates via session.configure, and switches mode on plan approval", async () => {
    const parsed = parseScript(
      JSON.stringify({
        modes: [
          { id: "plan", label: "Plan" },
          { id: "auto", label: "Auto", isUnattended: true },
        ],
        defaultMode: "plan",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        defaultThinkingOption: "high",
        controls: [
          { type: "toggle", key: "fast_mode", label: "Fast mode", defaultValue: false },
          {
            type: "select",
            key: "style",
            label: "Style",
            defaultValue: "concise",
            choices: [
              { value: "concise", label: "Concise" },
              { value: "verbose", label: "Verbose" },
            ],
          },
        ],
        commands: [{ name: "compact", description: "Compact context" }],
        scenarios: {
          planflow: [
            {
              steps: [
                {
                  kind: "permission",
                  permission: {
                    id: "plan-1",
                    plan: "1. Edit file\n2. Run tests",
                    on: {
                      allow: { setMode: "auto", text: "Switched to {{session.mode}}!" },
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const h = await connect({ getScript: () => parsed.script });
    await h.send({ type: "catalog", requestId: "r-cat" });
    const cat = h.events.find((e) => e.type === "catalog");
    expect(cat?.type === "catalog" && cat.catalog.modes.map((m) => m.id)).toEqual(["plan", "auto"]);
    expect(cat?.type === "catalog" && cat.catalog.defaultMode).toBe("plan");
    expect(cat?.type === "catalog" && cat.catalog.defaultThinkingOption).toBe("high");

    await h.send(open("s1", "planflow"));

    // Initial session.config dual-writes controls + settings
    const initCfg = h.events.find((e) => e.type === "session.config");
    expect(initCfg?.type === "session.config" && initCfg.config.mode).toBe("plan");
    expect(initCfg?.type === "session.config" && initCfg.config.controls?.length).toBe(2);
    expect(initCfg?.type === "session.config" && initCfg.config.settings).toEqual([
      { type: "toggle", id: "fast_mode", label: "Fast mode", value: false },
      {
        type: "select",
        id: "style",
        label: "Style",
        value: "concise",
        options: [
          { label: "Concise", value: "concise" },
          { label: "Verbose", value: "verbose" },
        ],
      },
    ]);

    const cmds = h.events.find((e) => e.type === "session.commands");
    expect(cmds?.type === "session.commands" && cmds.commands).toEqual([{ name: "compact", description: "Compact context" }]);

    // session.configure updates thinkingOption and providerOptions
    await h.send({
      type: "session.configure",
      requestId: "r-cfg",
      sessionId: "s1",
      changes: { thinkingOption: "low", providerOptions: { fast_mode: true, style: "verbose" } },
    });
    const updatedCfg = [...h.events].reverse().find((e) => e.type === "session.config");
    expect(updatedCfg?.type === "session.config" && updatedCfg.config.thinkingOption).toBe("low");
    expect(updatedCfg?.type === "session.config" && updatedCfg.config.providerOptions).toEqual({
      fast_mode: true,
      style: "verbose",
    });

    // can_stop_runtime is true when idle
    await h.send({ type: "session.can_stop_runtime", requestId: "r-stop-1", sessionId: "s1" });
    const canStop1 = h.events.find((e) => e.type === "session.can_stop_runtime" && e.requestId === "r-stop-1");
    expect(canStop1?.type === "session.can_stop_runtime" && canStop1.canStop).toBe(true);

    // Plan card approval triggers setMode -> auto
    await h.send(prompt("s1", "make a plan"));
    await h.send({ type: "session.can_stop_runtime", requestId: "r-stop-2", sessionId: "s1" });
    const canStop2 = h.events.find((e) => e.type === "session.can_stop_runtime" && e.requestId === "r-stop-2");
    expect(canStop2?.type === "session.can_stop_runtime" && canStop2.canStop).toBe(false);

    await h.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "plan-1",
      response: { behavior: "allow", selectedActionId: "accept" },
    });

    const latestCfg = [...h.events].reverse().find((e) => e.type === "session.config");
    expect(latestCfg?.type === "session.config" && latestCfg.config.mode).toBe("auto");
    const msg = h.events
      .filter((e) => e.type === "timeline.item")
      .map((e) => e.item)
      .find((i) => i.type === "assistant_message");
    expect(msg?.type === "assistant_message" && msg.text).toBe("Switched to auto!");

    await h.conn.close();
  });

  it("absorbs mid-turn steer without canceling the active turn, clears pending permissions, and runs onSteer branch", async () => {
    const h = await connect({
      getScript: () => ({
        scenarios: {
          steerable: [
            {
              steps: [
                {
                  kind: "permission",
                  permission: { id: "p-wait", title: "Confirm?" },
                },
              ],
              onSteer: {
                text: "Steered with: {{steer.text}}",
                outcome: "completed",
              },
            },
          ],
        },
      }),
    });

    await h.send(open("s1", "steerable"));
    await h.send(prompt("s1", "start", "m1"));
    expect(turnStates(h.events)).toEqual(["started"]);

    // Send a mid-turn steer with clearPendingPermissions: true
    await h.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m-steer",
        delivery: "steer",
        clearPendingPermissions: true,
        input: { type: "message", content: [{ type: "text", text: "skip the card and finish" }] },
      },
    });

    const steerResult = h.events.find(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m-steer",
    );
    expect(steerResult?.type === "session.prompt_result" && steerResult.result.type).toBe("steer");

    // Pending permission card was cleared
    expect(h.events.some((e) => e.type === "session.permission_resolved" && e.permissionId === "p-wait")).toBe(true);

    // Turn ended cleanly as completed (NOT canceled) with the onSteer message
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
    const msg = h.events
      .filter((e) => e.type === "timeline.item")
      .map((e) => e.item)
      .find((i) => i.type === "assistant_message");
    expect(msg?.type === "assistant_message" && msg.text).toBe("Steered with: skip the card and finish");

    await h.conn.close();
  });
});
