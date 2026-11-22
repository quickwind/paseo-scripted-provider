// Real-daemon e2e: an isolated Paseo daemon + this plugin; assertions on outcomes (never on timing).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startScriptedEnv } from "../testkit/index.mjs";

const SCRIPT = {
  modes: [
    { id: "auto", label: "Auto", isUnattended: true },
    { id: "plan", label: "Plan" },
  ],
  defaultMode: "auto",
  scenarios: {
    greet: [{ text: "hello from script" }, { text: "second reply" }],
    boom: [{ outcome: "failed", error: "scripted failure" }],
    stream: [{ chunks: ["a", "b", "c"], chunkDelayMs: 50 }],
    replay: [{ expect: "alpha", text: "A" }, { expect: "beta", text: "B" }, { expect: "gamma", text: "C" }],
    perm: [
      {
        tools: [
          {
            name: "Bash",
            detail: { type: "shell", command: "rm -rf build" },
            permission: { title: "Allow rm?", on: { accept: { text: "allowed" }, reject: { text: "denied: {{permission.message}}" } } },
          },
        ],
        text: "after",
      },
    ],
    tools: [{ tools: [{ name: "Bash", detail: { type: "shell", command: "ls", output: "x", exitCode: 0 } }], text: "done" }],
    // A recorded reply: every step waits for its own gap.
    timed: [
      {
        expect: "go",
        steps: [
          { kind: "reasoning", text: "thinking about it", delayMs: 700 },
          { kind: "tool", delayMs: 200, tool: { name: "Bash", detail: { type: "shell", command: "ls", output: "x", exitCode: 0 } } },
          { kind: "message", text: "timed reply", delayMs: 400 },
        ],
      },
    ],
  },
};

let env;

before(async () => {
  env = await startScriptedEnv({ script: SCRIPT });
});
after(async () => {
  await env?.stop({ outDir: process.env.E2E_OUT });
});

describe("scripted provider on a real daemon", () => {
  it("is listed as a provider and exposes scenarios as models", async () => {
    const providers = JSON.parse(env.daemon.cli(["provider", "ls", "--json"]).stdout);
    assert.ok(providers.some((p) => p.provider === "scripted" || p.id === "scripted"), JSON.stringify(providers));
  });

  it("replies step by step and records prompts in order", async () => {
    const agent = await env.createAgent({ scenario: "greet", prompt: "first" });
    await env.waitForFinish(agent.id);
    await env.api.agents.ref(agent.id).run("second");
    assert.deepEqual(await env.assistantTexts(agent.id), ["hello from script", "second reply"]);
    const prompts = env.readRecord().filter((r) => r.kind === "prompt");
    assert.deepEqual(prompts.map((p) => [p.text, p.step]), [["first", 0], ["second", 1]]);
  });

  it("ends a failing scenario in an error state", async () => {
    const agent = await env.createAgent({ scenario: "boom", prompt: "go" });
    const res = await env.waitForFinish(agent.id);
    assert.equal(res.status, "error");
  });

  it("streams chunks into one merged assistant message", async () => {
    const agent = await env.createAgent({ scenario: "stream", prompt: "go" });
    await env.waitForFinish(agent.id);
    assert.deepEqual(await env.assistantTexts(agent.id), ["abc"]);
  });

  it("shows a tool call", async () => {
    const agent = await env.createAgent({ scenario: "tools", prompt: "go" });
    await env.waitForFinish(agent.id);
    const tl = await env.timeline(agent.id);
    assert.ok(tl.some((e) => e.item?.type === "tool_call" && e.item.name === "Bash"));
  });

  it("SCENARIO: switches script mid-chat", async () => {
    const agent = await env.createAgent({ scenario: "greet", prompt: "first" });
    await env.waitForFinish(agent.id);
    await env.api.agents.ref(agent.id).run("SCENARIO:stream now");
    assert.equal((await env.assistantTexts(agent.id)).pop(), "abc");
  });

  it("continues at the right step after a daemon restart", async () => {
    const agent = await env.createAgent({ scenario: "greet", prompt: "first" });
    await env.waitForFinish(agent.id);
    await env.restart();
    await env.api.agents.ref(agent.id).run("again");
    assert.equal((await env.assistantTexts(agent.id)).pop(), "second reply");
  });

  it("answers a recorded script by message content, not only by order", async () => {
    const agent = await env.createAgent({ scenario: "replay" });
    const ref = env.api.agents.ref(agent.id);
    await ref.run("beta");
    await ref.run("gamma");
    await ref.run("alpha");
    assert.deepEqual(await env.assistantTexts(agent.id), ["B", "C", "A"]);
  });

  it("compiles and runs a YAML script (vendored yaml inside the daemon-compiled plugin)", async () => {    const yaml = [
      "# comments are allowed",
      "macros:",
      "  HELLO: |",
      "    first line",
      "    second line",
      "scenarios:",
      "  fromyaml:",
      "    - text: '@HELLO'",
      "    - text: |",
      "        a multi-line",
      "        reply",
      "",
    ].join("\n");
    const cur = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.read", {});
    const saved = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.write", {
      revision: cur.revision,
      values: { ...cur.values, scripts: yaml },
    });
    assert.equal(saved.status, "saved");
    const status = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "scripted.status", {});
    assert.equal(status.error, null);
    assert.ok(status.scenarios.includes("fromyaml"), JSON.stringify(status));
    const agent = await env.createAgent({ scenario: "fromyaml" });
    const ref = env.api.agents.ref(agent.id);
    await ref.run("one");
    await ref.run("two");
    assert.deepEqual(await env.assistantTexts(agent.id), ["first line\nsecond line\n", "a multi-line\nreply\n"]);
  });

  it("replays a recorded reply with its original delays", async () => {
    const started = Date.now();
    const agent = await env.createAgent({ scenario: "timed", prompt: "go" });
    await env.waitForFinish(agent.id);
    const elapsed = Date.now() - started;
    // The steps wait 700 + 200 + 400 ms; the agent start adds a little.
    assert.ok(elapsed >= 1250, `replay took ${elapsed}ms, expected at least 1250ms`);
    assert.deepEqual(await env.assistantTexts(agent.id), ["timed reply"]);
  });

  it("serializes and merges scripts on the daemon (the client bundle ships no YAML parser)", async () => {    const exported = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "scripted.export", {
      script: { scenarios: { a: [{ text: "hi" }] } },
      format: "yaml",
    });
    assert.match(exported.text, /scenarios:/);
    assert.match(exported.text, /hi/);

    const merged = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "scripted.merge-scenario", {
      script: { scenarios: { recorded: [{ text: "new" }] } },
      name: "recorded",
      existingText: "# keep my notes\nscenarios:\n  keep:\n    - text: 'old'\n",
    });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(merged.name, "recorded");
    assert.match(merged.text, /# keep my notes/);
    assert.match(merged.text, /keep:/);
    assert.match(merged.text, /recorded:/);
  });

  it("raises a permission card and branches on the answer", async () => {
    const yes = await env.createAgent({ scenario: "perm", prompt: "go" });
    const no = await env.createAgent({ scenario: "perm", prompt: "go" });
    const yesCard = await env.waitForPermission(yes.id);
    const noCard = await env.waitForPermission(no.id);
    await env.respondToPermission(yes.id, yesCard, { behavior: "allow", selectedActionId: "accept" });
    await env.respondToPermission(no.id, noCard.requestId, { behavior: "deny", selectedActionId: "reject", message: "Denied by user" });
    // Poll for the replies rather than trusting one read after waitForFinish: that wait can return
    // before the answered turn has written its messages (seen on the Windows runner).
    await env.waitForAssistantTexts(yes.id, ["allowed", "after"]);
    await env.waitForAssistantTexts(no.id, ["denied: Denied by user", "after"]);
    const answers = env.readRecord().filter((r) => r.kind === "permission_response");
    assert.deepEqual(answers.map((r) => r.branch).sort(), ["accept", "reject"]);
  });

  it("P0-1/P0-2: emits rich timeline items (todo, compaction, notification, plugin, step chunks) and records full open config", async () => {
    env.setScript({
      ...SCRIPT,
      scenarios: {
        ...SCRIPT.scenarios,
        rich: [
          {
            notices: [{ id: "n-e2e", severity: "info", title: "Quota check" }],
            steps: [
              { kind: "todo", items: [{ id: "t1", text: "Verify E2E", completed: false, status: "in_progress" }] },
              { kind: "compaction", trigger: "auto", preTokens: 42000 },
              { kind: "notification", level: "info", message: "Compacted" },
              { kind: "plugin", pluginId: "paseo-scripted-provider", pluginKind: "demo_card", version: 1, data: { ok: true } },
              { kind: "message", chunks: ["Hello ", "{{prompt.text}} at {{cwd}}"], chunkDelayMs: 10 },
            ],
            usage: { inputTokens: 120, outputTokens: 30, totalCostUsd: 0.001 },
          },
        ],
      },
    });

    const agent = await env.createAgent({
      scenario: "rich",
      prompt: "world",
      systemPrompt: "Custom E2E prompt",
      env: { E2E_INJECTED: "yes" },
    });
    await env.waitForFinish(agent.id);

    const todoEntry = await env.waitForTimeline(agent.id, (e) => e.item?.type === "todo");
    assert.equal(todoEntry.item.items[0].text, "Verify E2E");
    const tl = await env.timeline(agent.id);
    assert.ok(tl.some((e) => e.item?.type === "compaction" && e.item.status === "completed"));
    assert.ok(tl.some((e) => e.item?.type === "notification" && e.item.message === "Compacted"));
    assert.ok(tl.some((e) => e.item?.type === "plugin" && e.item.kind === "demo_card"));
    assert.deepEqual(await env.assistantTexts(agent.id), [`Hello world at ${env.ws.work}`]);

    const openRec = await env.waitForRecord((r) => r.kind === "open" && r.model === "rich");
    assert.equal(openRec.cwd, env.ws.work);
    assert.equal(openRec.systemPrompt, "Custom E2E prompt");
    assert.equal(openRec.env?.E2E_INJECTED, "yes");
  });

  it("P0-4: switches mode on plan approval and absorbs mid-turn steer without canceling", async () => {
    env.setScript({
      ...SCRIPT,
      modes: [
        { id: "plan", label: "Plan" },
        { id: "auto", label: "Auto", isUnattended: true },
      ],
      defaultMode: "plan",
      scenarios: {
        ...SCRIPT.scenarios,
        planAndSteer: [
          {
            steps: [
              {
                kind: "permission",
                permission: {
                  id: "plan-e2e",
                  plan: "1. Build\n2. Test",
                  on: { allow: { setMode: "auto", text: "Now in {{session.mode}}" } },
                },
              },
            ],
          },
          {
            steps: [
              {
                kind: "permission",
                permission: { id: "wait-for-steer", title: "Waiting..." },
              },
            ],
            onSteer: { text: "Steered: {{steer.text}}", outcome: "completed" },
          },
        ],
      },
    });

    const agent = await env.createAgent({ scenario: "planAndSteer", prompt: "plan it", mode: "plan" });
    const planCard = await env.waitForPermission(agent.id);
    await env.respondToPermission(agent.id, planCard, { behavior: "allow", selectedActionId: "accept" });
    await env.waitForAssistantTexts(agent.id, ["Now in auto"]);

    // Turn 2: raise permission card, then steer mid-turn
    const ref = env.api.agents.ref(agent.id);
    await ref.send("start turn 2");
    await env.waitForPermission(agent.id);
    await env.steer(agent.id, "finish immediately");
    await env.waitForAssistantTexts(agent.id, ["Now in auto", "Steered: finish immediately"]);

    const steerRec = await env.waitForRecord((r) => r.kind === "prompt" && r.delivery === "steer");
    assert.equal(steerRec.text, "finish immediately");
  });

  it("P0-5: accelerates timed replies when delayScale is set to 0", async () => {
    const cur = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.read", {});
    const saved = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.write", {
      revision: cur.revision,
      values: { ...cur.values, delayScale: 0 },
    });
    assert.equal(saved.status, "saved");
    try {
      const started = Date.now();
      const agent = await env.createAgent({ scenario: "timed", prompt: "go" });
      await env.waitForFinish(agent.id);
      const elapsed = Date.now() - started;
      // Original timed script waits 700 + 200 + 400 = 1300ms; with delayScale: 0 it finishes far faster.
      assert.ok(elapsed < 1000, `expected delayScale=0 replay under 1000ms, took ${elapsed}ms`);
      assert.deepEqual(await env.assistantTexts(agent.id), ["timed reply"]);
    } finally {
      const latest = await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.read", {});
      await env.conn.client.invokePluginRpc("paseo-scripted-provider", "settings.scripted-provider.write", {
        revision: latest.revision,
        values: { ...latest.values, delayScale: 1 },
      });
    }
  });
});
