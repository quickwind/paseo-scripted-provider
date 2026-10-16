// Public testkit API. Usage:
//   const env = await startScriptedEnv({ script: { scenarios: { hi: [{ text: "hello" }] } } });
//   const agent = await env.createAgent({ scenario: "hi", prompt: "x" });
//   await env.waitForFinish(agent.id);
//   env.readRecord()  // -> parsed received.jsonl
//   await env.stop();
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { WebSocket } from "ws";
import { Daemon, Workspace, freePort, sleep } from "./daemon.mjs";

export { Daemon, Workspace, freePort, sleep };

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // a line being appended right now
      }
    });
}

export async function connectClient(daemon) {
  const client = new DaemonClient({
    url: `ws://${daemon.host}/ws`,
    clientId: `testkit-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.11.4",
    localCredential: () => readLocalCredentialForTarget(daemon.ws.paseoHome, daemon.host) ?? undefined,
    connectTimeoutMs: 30000,
    webSocketFactory: (url, config) => new WebSocket(url, config?.protocols, { headers: config?.headers }),
    reconnect: { enabled: false },
  });
  await client.connect();
  return { client, api: createPaseoApi(client) };
}

export async function startScriptedEnv({ script, enableProviders = [], timeScale = Number(process.env.E2E_TIME_SCALE ?? 1), keep = false, realHome = false, providerConfigs = {} } = {}) {
  const ws = new Workspace({ keep, realHome });
  const daemon = new Daemon(ws, { port: await freePort(), timeScale, enableProviders, providerConfigs });
  process.once("exit", () => daemon.killNow());
  if (script) fs.writeFileSync(ws.scriptFile, JSON.stringify(script, null, 2));

  let conn;
  try {
    const pluginDir = ws.stagePlugin();
    await daemon.start("daemon");
    daemon.cli(["plugin", "install", pluginDir, "--json"], { timeoutMs: 120000 * timeScale });
    const listed = JSON.parse(daemon.cli(["plugin", "ls", "--json"]).stdout);
    const me = listed.find((p) => p.id === "paseo-scripted-provider");
    if (me?.status !== "running") throw new Error(`plugin not running: ${JSON.stringify(me ?? listed)}`);
    conn = await connectClient(daemon);
  } catch (error) {
    // Never leave a daemon behind when setup fails; keep logs for diagnosis.
    await daemon.stop().catch(() => undefined);
    if (process.env.E2E_OUT) ws.collect(process.env.E2E_OUT);
    else console.error(`[testkit] setup failed; logs kept at ${ws.logs} and ${ws.paseoHome}`);
    if (process.env.E2E_OUT || !keep) ws.cleanup();
    throw error;
  }

  const env = {
    ws,
    daemon,
    conn,
    get api() {
      return env.conn.api;
    },
    ms: (v) => Math.round(v * timeScale),
    readRecord: () => readJsonl(ws.recordFile),
    async createAgent({ scenario = "default", prompt, title } = {}) {
      return env.api.agents.create({
        config: { provider: `scripted/${scenario}` },
        cwd: ws.work,
        title: title ?? `scripted ${scenario}`,
        ...(prompt ? { prompt, clientMessageId: randomUUID() } : {}),
      });
    },
    async waitForFinish(agentId, timeoutMs = 60000) {
      return env.api.agents.ref(agentId).waitForFinish(env.ms(timeoutMs));
    },
    async timeline(agentId) {
      const page = await env.api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300, projection: "projected" });
      return page.entries ?? [];
    },
    async restart(label = "restart") {
      await env.conn.client.close().catch(() => undefined);
      await daemon.restart(label);
      for (let i = 0; i < 60; i++) {
        try {
          env.conn = await connectClient(daemon);
          return;
        } catch {
          await sleep(500);
        }
      }
      throw new Error("could not reconnect after restart");
    },
    async stop({ outDir } = {}) {
      await env.conn.client.close().catch(() => undefined);
      await daemon.stop().catch((e) => console.warn(`[testkit] stop failed: ${e}`));
      if (outDir) ws.collect(outDir);
      ws.cleanup();
    },
  };
  return env;
}
