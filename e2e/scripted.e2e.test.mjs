// Real-daemon e2e: an isolated Paseo daemon + this plugin; assertions on outcomes (never on timing).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startScriptedEnv } from "../testkit/index.mjs";

const SCRIPT = {
  scenarios: {
    greet: [{ text: "hello from script" }, { text: "second reply" }],
    boom: [{ outcome: "failed", error: "scripted failure" }],
    stream: [{ chunks: ["a", "b", "c"], chunkDelayMs: 50 }],
    replay: [{ expect: "alpha", text: "A" }, { expect: "beta", text: "B" }, { expect: "gamma", text: "C" }],
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
const assistantTexts = async (id) => (await env.timeline(id)).filter((e) => e.item?.type === "assistant_message").map((e) => e.item.text);

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
    assert.deepEqual(await assistantTexts(agent.id), ["hello from script", "second reply"]);
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
    assert.deepEqual(await assistantTexts(agent.id), ["abc"]);
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
    assert.equal((await assistantTexts(agent.id)).pop(), "abc");
  });

  it("continues at the right step after a daemon restart", async () => {
    const agent = await env.createAgent({ scenario: "greet", prompt: "first" });
    await env.waitForFinish(agent.id);
    await env.restart();
    await env.api.agents.ref(agent.id).run("again");
    assert.equal((await assistantTexts(agent.id)).pop(), "second reply");
  });

  it("answers a recorded script by message content, not only by order", async () => {
    const agent = await env.createAgent({ scenario: "replay" });
    const ref = env.api.agents.ref(agent.id);
    await ref.run("beta");
    await ref.run("gamma");
    await ref.run("alpha");
    assert.deepEqual(await assistantTexts(agent.id), ["B", "C", "A"]);
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
    assert.deepEqual(await assistantTexts(agent.id), ["first line\nsecond line\n", "a multi-line\nreply\n"]);
  });

  it("replays a recorded reply with its original delays", async () => {
    const started = Date.now();
    const agent = await env.createAgent({ scenario: "timed", prompt: "go" });
    await env.waitForFinish(agent.id);
    const elapsed = Date.now() - started;
    // The steps wait 700 + 200 + 400 ms; the agent start adds a little.
    assert.ok(elapsed >= 1250, `replay took ${elapsed}ms, expected at least 1250ms`);
    assert.deepEqual(await assistantTexts(agent.id), ["timed reply"]);
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
});
