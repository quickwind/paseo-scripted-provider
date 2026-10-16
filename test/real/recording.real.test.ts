// Local-only verification with REAL providers (opencode + devin) on an isolated Paseo daemon.
// Not part of CI: it needs the CLIs installed and logged in. Run: npm run verify:real
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper without types
import { startScriptedEnv } from "../../testkit/index.mjs";
import { type TimelineEntry } from "../../shared/core/capture/convert";
import { addScenarioToSettings } from "../../shared/core/capture/export";
import { Redactor } from "../../shared/core/capture/redact";
import { buildReview, canExport, confirmSuspicious, exportText, stats } from "../../client/state";
import { parseScript } from "../../shared/core/script";

const SECRET = "ghp_" + "a".repeat(36);
const EMAIL = "qa-test@example.com";
const TARGETS = [
  { name: "opencode", provider: "opencode/opencode/deepseek-v4.1-flash-free" },
  { name: "devin", provider: "devin/swe-1-6-slow" },
];
const REPORT = path.resolve("reports/real-verify.md");
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
};

let env: any;
const PLUGIN = "paseo-scripted-provider";

async function rpc(method: string, input: unknown): Promise<any> {
  return env.conn.client.invokePluginRpc(PLUGIN, method, input);
}

async function waitDone(agentId: string, timeoutMs: number) {
  const ref = env.api.agents.ref(agentId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ref.waitForFinish(20_000).catch(() => null);
    await ref.refresh().catch(() => null);
    for (const p of (ref.pendingPermissions as any[] | null) ?? []) {
      const requestId = p?.request?.id ?? p?.id;
      await ref.respondToPermission({ requestId, response: { behavior: "allow" } }).catch(() => undefined);
    }
    if (ref.status === "idle" || ref.status === "error") return { status: ref.status, res };
  }
  throw new Error(`agent ${agentId} did not finish in ${timeoutMs} ms`);
}

beforeAll(async () => {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  env = await startScriptedEnv({ script: { scenarios: {} }, enableProviders: ["opencode"],
    // Devin is a custom ACP provider (same definition as in a normal Paseo config).
    providerConfigs: { devin: { extends: "acp", label: "Devin CLI", description: "Devin via ACP", command: ["devin", "acp"], env: {} } },
    realHome: true,
  });
  expect(env.daemon.port).not.toBe(6767);
  log(`# Real-provider verification\n\n- date: ${new Date().toISOString()}\n- daemon: 127.0.0.1:${env.daemon.port} (isolated PASEO_HOME ${env.ws.paseoHome})\n- node ${process.version} on ${process.platform}`);
});
afterAll(async () => {
  fs.writeFileSync(REPORT, lines.join("\n") + "\n");
  await env?.stop({ outDir: path.resolve("reports/real-verify-logs") });
});

describe.each(TARGETS)("recording from a real $name session", ({ name, provider }) => {
  it("records, redacts and replays", async () => {
    const cwd = path.join(env.ws.work, name);
    fs.mkdirSync(cwd, { recursive: true });
    const prompt =
      `Create a file named notes.txt in the current directory containing exactly these three lines: ` +
      `token=${SECRET} ; contact=${EMAIL} ; dir=<the absolute path of the current directory>. ` +
      `Then reply with the single word DONE.`;

    // 1. A real agent does real work.
    const agent = await env.api.agents.create({ config: { provider }, cwd, title: `real ${name}`, prompt });
    const done = await waitDone(agent.id, 12 * 60_000);
    log(`\n## ${name} (${provider})\n\n- agent finished: **${done.status}**`);
    expect(done.status).toBe("idle");

    // 2. Same code path as the UI button: capture RPC -> convert -> redact.
    const cap = await rpc("scripted.capture", { agentId: agent.id });
    const entries = cap.entries as TimelineEntry[];
    log(`- captured ${entries.length} timeline entries; types: ${[...new Set(entries.map((e) => e.item.type))].join(", ")}`);
    expect(entries.some((e) => e.item.type === "user_message")).toBe(true);
    const options = { name: `real-${name}`, delay: { mode: "drop" as const }, includeReasoning: true, includeToolOutput: true };
    let model = buildReview(entries, options, { cwd: cap.agent?.cwd ?? cwd });
    const s0 = stats(model);
    log(`- redaction: ${s0.autoReplaced} auto-replaced, ${s0.suspicious} suspicious`);
    // Suspicious high-entropy tokens (e.g. file hashes) are confirmed as 'keep'; seeded data is matched by rules.
    const confirmAll = () => {
      for (let guard = 0; guard < 50 && !canExport(model); guard++) {
        const text = JSON.stringify(model.script);
        const pending = new Redactor().suspicious(text).filter((t) => !model.confirmed.has(t));
        if (!pending.length) break;
        for (const t of pending) model = confirmSuspicious(model, t);
      }
    };
    confirmAll();
    expect(canExport(model)).toBe(true);
    const text = exportText(model);

    // 3. Redaction guarantees on real data.
    const username = os.userInfo().username;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(cwd);
    expect(text).not.toContain(`/Users/${username}`);
    expect(text).toContain("{{secret_1}}");
    log(`- exported script contains none of: seeded token, seeded email, working directory, \`/Users/${username}\`; has \`{{secret_1}}\``);
    const parsed = parseScript(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The same recording exported as YAML must describe the identical script.
    expect(parseScript(exportText(model, "yaml"))).toEqual(parsed);
    const steps = parsed.script.scenarios[options.name];
    log(`- exported scenario \`${options.name}\`: ${steps.length} step(s)`);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].expect).toContain("{{secret_1}}");

    // 4. Replay on a Scripted agent with strict alignment.
    const added = addScenarioToSettings("", options.name, parsed.script);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    fs.writeFileSync(env.ws.scriptFile, added.text);
    const cur = await rpc("settings.scripted-provider.read", {});
    const w = await rpc("settings.scripted-provider.write", { revision: cur.revision, values: { ...cur.values, alignment: "strict" } });
    expect(w.status).toBe("saved");

    const replay = await env.api.agents.create({ config: { provider: `scripted/${options.name}` }, cwd: env.ws.work, title: `replay ${name}` });
    const recordedBefore = env.readRecord().length; // earlier targets leave deliberate mismatches in the shared log
    for (const step of steps) {
      const r = await env.api.agents.ref(replay.id).run(step.expect ?? "");
      expect(r.status).not.toBe("error");
    }
    const tl = await env.timeline(replay.id);
    const assistant = tl.filter((e: any) => e.item?.type === "assistant_message").map((e: any) => e.item.text as string);
    const expected = steps.flatMap((s) => (s.messages ? [s.messages.join("")] : s.text !== undefined ? [s.text] : []));
    expect(assistant.join("\n")).toBe(expected.join("\n"));
    const rec = env.readRecord().slice(recordedBefore);
    expect(rec.filter((r: any) => r.kind === "mismatch")).toHaveLength(0);
    log(`- strict replay: ${steps.length} step(s) answered, assistant text identical to recording, 0 mismatches`);

    // 5. Strict alignment really rejects a wrong message.
    const wrong = await env.api.agents.create({ config: { provider: `scripted/${options.name}` }, cwd: env.ws.work, title: `wrong ${name}` });
    let rejected = false;
    try {
      const r = await env.api.agents.ref(wrong.id).run("this is not what was recorded");
      rejected = r.status === "error";
    } catch {
      rejected = true;
    }
    expect(rejected || env.readRecord().some((r: any) => r.kind === "mismatch")).toBe(true);
    log(`- strict alignment rejects a non-matching message: yes`);
  });
});
