// Public testkit API. Usage:
//   const env = await startScriptedEnv({ script: { scenarios: { hi: [{ text: "hello" }] } } });
//   const agent = await env.createAgent({ scenario: "hi", prompt: "x" });
//   await env.waitForFinish(agent.id);
//   env.readRecord()  // -> parsed received.jsonl
//   await env.stop();
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { WebSocket } from "ws";
import { Daemon, Workspace, cliEntry, freePort, sleep, spawnSpecForCli } from "./daemon.mjs";

export { Daemon, Workspace, cliEntry, freePort, sleep, spawnSpecForCli };

/** The published plugin package; `pluginSource: "npm"` installs this from the registry. */
export const NPM_PACKAGE = "paseo-scripted-provider";

const requireFromTestkit = createRequire(import.meta.url);

export function resolveClientVersion() {
  for (const loader of [requireFromTestkit, createRequire(path.join(process.cwd(), "package.json"))]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(loader.resolve("@getpaseo/client/package.json"), "utf8"));
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // try next resolver
    }
  }
  return "0.16.0";
}

export function resolvePluginSource(pluginSource, { ws, pluginVersion = "" } = {}) {
  if (!pluginSource || pluginSource === "local") {
    if (!ws) throw new Error('pluginSource "local" requires a Workspace instance');
    return ws.stagePlugin();
  }
  if (pluginSource === "npm") {
    return `npm:${NPM_PACKAGE}${pluginVersion ? `@${pluginVersion}` : ""}`;
  }
  if (typeof pluginSource !== "string") {
    throw new Error(`Invalid pluginSource: ${JSON.stringify(pluginSource)}`);
  }
  if (pluginSource.startsWith("npm:")) return pluginSource;
  const resolved = path.resolve(pluginSource);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Plugin source path does not exist: ${resolved}`);
  }
  return resolved;
}

export function normalizeExtraPlugins(extraPlugins = []) {
  if (!Array.isArray(extraPlugins)) {
    throw new Error(`extraPlugins must be an array, got ${typeof extraPlugins}`);
  }
  return extraPlugins.map((entry) => {
    const raw = typeof entry === "string" ? { source: entry, id: undefined } : entry;
    if (!raw || typeof raw !== "object" || typeof raw.source !== "string" || !raw.source) {
      throw new Error(`Invalid extraPlugins entry: ${JSON.stringify(entry)}`);
    }
    const source = raw.source.startsWith("npm:") ? raw.source : path.resolve(raw.source);
    if (!source.startsWith("npm:") && !fs.existsSync(source)) {
      throw new Error(`Extra plugin source path does not exist: ${source}`);
    }
    return { source, id: raw.id };
  });
}

export function assertPluginsHealthy(listed, requiredIds = [NPM_PACKAGE]) {
  const plugins = Array.isArray(listed) ? listed : [];
  for (const id of requiredIds) {
    const match = plugins.find((p) => p.id === id);
    if (match?.status !== "running") {
      throw new Error(`plugin "${id}" not running: ${JSON.stringify(match ?? plugins)}`);
    }
  }
  const errored = plugins.filter((p) => p.status === "error");
  if (errored.length > 0) {
    throw new Error(`one or more plugins are in error state: ${JSON.stringify(errored)}`);
  }
}

export function extractPermissionRequestId(cardOrId) {
  if (typeof cardOrId === "string" && cardOrId) return cardOrId;
  const id = cardOrId?.requestId ?? cardOrId?.request?.id ?? cardOrId?.id;
  if (typeof id === "string" && id) return id;
  throw new Error(`Could not determine permission requestId from: ${JSON.stringify(cardOrId)}`);
}

export function mergeExtraCollect(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  if (Array.isArray(base) && Array.isArray(extra)) return [...base, ...extra];
  if (!Array.isArray(base) && !Array.isArray(extra) && typeof base === "object" && typeof extra === "object") {
    return { ...base, ...extra };
  }
  return extra;
}

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

export async function connectClient(daemon, { appVersion } = {}) {
  const client = new DaemonClient({
    url: `ws://${daemon.host}/ws`,
    clientId: `testkit-${randomUUID()}`,
    clientType: "cli",
    appVersion: appVersion ?? resolveClientVersion(),
    localCredential: () => readLocalCredentialForTarget(daemon.ws.paseoHome, daemon.host) ?? undefined,
    connectTimeoutMs: 30000,
    webSocketFactory: (url, config) => new WebSocket(url, config?.protocols, { headers: config?.headers }),
    reconnect: { enabled: false },
  });
  await client.connect();
  return { client, api: createPaseoApi(client) };
}

export function createAgentHelpers({ getApi, ms = (v) => v, timeline, readRecord }) {
  async function assistantTexts(agentId) {
    return (await timeline(agentId))
      .filter((e) => e.item?.type === "assistant_message")
      .map((e) => e.item.text);
  }

  async function waitForPermission(agentId, { timeoutMs = 10000, pollMs = 100, predicate } = {}) {
    const ref = getApi().agents.ref(agentId);
    const limitMs = ms(timeoutMs);
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      await ref.refresh().catch(() => null);
      const pending = ref.pendingPermissions ?? [];
      const match = predicate ? pending.find(predicate) : pending[0];
      if (match) {
        return { ...match, requestId: extractPermissionRequestId(match) };
      }
      await sleep(pollMs);
    }
    throw new Error(`No permission card appeared on agent ${agentId} within ${limitMs}ms`);
  }

  async function respondToPermission(agentId, requestIdOrCard, response) {
    const requestId = extractPermissionRequestId(requestIdOrCard);
    return getApi().agents.ref(agentId).respondToPermission({ requestId, response });
  }

  async function waitForAssistantTexts(agentId, expected, { timeoutMs = 15000, pollMs = 100 } = {}) {
    const limitMs = ms(timeoutMs);
    const deadline = Date.now() + limitMs;
    let last = [];
    const matches = typeof expected === "function"
      ? expected
      : (got) => JSON.stringify(got) === JSON.stringify(expected);
    while (Date.now() < deadline) {
      last = await assistantTexts(agentId);
      if (matches(last)) return last;
      await sleep(pollMs);
    }
    const desc = typeof expected === "function" ? "predicate to match" : JSON.stringify(expected);
    throw new Error(`Timed out after ${limitMs}ms waiting for assistant texts (${desc}); last seen: ${JSON.stringify(last)}`);
  }

  async function waitForRecord(predicate, { timeoutMs = 10000, pollMs = 50 } = {}) {
    if (typeof readRecord !== "function") throw new Error("waitForRecord requires readRecord");
    const limitMs = ms(timeoutMs);
    const deadline = Date.now() + limitMs;
    let last = [];
    while (Date.now() < deadline) {
      last = readRecord();
      const match = last.find(predicate);
      if (match !== undefined) return match;
      await sleep(pollMs);
    }
    throw new Error(`Timed out after ${limitMs}ms waiting for matching record; saw ${last.length} entries`);
  }

  async function waitForTimeline(agentId, predicate, { timeoutMs = 15000, pollMs = 50 } = {}) {
    const limitMs = ms(timeoutMs);
    const deadline = Date.now() + limitMs;
    let last = [];
    while (Date.now() < deadline) {
      last = await timeline(agentId);
      const match = last.find(predicate);
      if (match !== undefined) return match;
      await sleep(pollMs);
    }
    throw new Error(`Timed out after ${limitMs}ms waiting for matching timeline entry on ${agentId}; saw ${last.length} entries`);
  }

  async function steer(agentId, prompt, options = {}) {
    const ref = getApi().agents.ref(agentId);
    return ref.send(prompt, { activeTurnBehavior: "steer", ...options });
  }

  return { assistantTexts, waitForPermission, respondToPermission, waitForAssistantTexts, waitForRecord, waitForTimeline, steer };
}

export async function startScriptedEnv({
  script,
  enableProviders = [],
  timeScale = Number(process.env.E2E_TIME_SCALE ?? 1),
  delayScale,
  keep = false,
  realHome = false,
  providerConfigs = {},
  daemonConfig = {},
  pluginSource = "local",
  pluginVersion = "",
  extraPlugins = [],
  extraEnv = {},
  extraCollect,
  cliEntry: customCliEntry,
  appVersion,
} = {}) {
  const mergedExtraEnv = {
    ...extraEnv,
    ...(delayScale !== undefined ? { SCRIPTED_PROVIDER_DELAY_SCALE: String(delayScale) } : {}),
  };
  const ws = new Workspace({ keep, realHome, extraEnv: mergedExtraEnv });
  const daemon = new Daemon(ws, {
    port: await freePort(),
    timeScale,
    enableProviders,
    providerConfigs,
    daemonConfig,
    cliEntry: customCliEntry,
  });
  const onExit = () => daemon.killNow();
  process.once("exit", onExit);
  if (script) fs.writeFileSync(ws.scriptFile, JSON.stringify(script, null, 2));

  let conn;
  try {
    // "local" installs the plugin from this working copy; "npm" installs the published package
    // from the registry; any other path installs directly from that local directory.
    const source = resolvePluginSource(pluginSource, { ws, pluginVersion });
    const extras = normalizeExtraPlugins(extraPlugins);
    await daemon.start("daemon");
    daemon.cli(["plugin", "install", source, "--json"], { timeoutMs: 180000 * timeScale });
    for (const extra of extras) {
      daemon.cli(["plugin", "install", extra.source, "--json"], { timeoutMs: 180000 * timeScale });
    }
    const listed = JSON.parse(daemon.cli(["plugin", "ls", "--json"]).stdout);
    assertPluginsHealthy(listed, [NPM_PACKAGE, ...extras.map((p) => p.id).filter(Boolean)]);
    conn = await connectClient(daemon, { appVersion });
  } catch (error) {
    // Never leave a daemon behind when setup fails; keep logs for diagnosis.
    await daemon.stop().catch(() => undefined);
    if (process.env.E2E_OUT) ws.collect(process.env.E2E_OUT, extraCollect);
    else console.error(`[testkit] setup failed; logs kept at ${ws.logs} and ${ws.paseoHome}`);
    if (process.env.E2E_OUT || !keep) ws.cleanup();
    throw error;
  }

  const ms = (v) => Math.round(v * timeScale);
  const timeline = async (agentId) => {
    const page = await env.api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 300, projection: "projected" });
    return page.entries ?? [];
  };
  const readRecord = () => readJsonl(ws.recordFile);
  const helpers = createAgentHelpers({ getApi: () => env.api, ms, timeline, readRecord });

  const env = {
    ws,
    daemon,
    conn,
    get api() {
      return env.conn.api;
    },
    ms,
    readRecord,
    setScript(nextScript) {
      const content = typeof nextScript === "string" ? nextScript : JSON.stringify(nextScript, null, 2);
      fs.writeFileSync(ws.scriptFile, content);
    },
    async createAgent({
      scenario = "default",
      prompt,
      title,
      cwd,
      workspaceId,
      mode,
      modeId,
      thinkingOption,
      thinkingOptionId,
      providerOptions,
      options,
      mcpServers,
      toolPolicy,
      env: agentEnv,
      systemPrompt,
      config: extraConfig,
    } = {}) {
      const resolvedModeId = modeId ?? mode;
      const resolvedThinkingOptionId = thinkingOptionId ?? thinkingOption;
      const resolvedOptions = options ?? providerOptions;
      return env.api.agents.create({
        config: {
          provider: `scripted/${scenario}`,
          ...(resolvedModeId !== undefined ? { modeId: resolvedModeId } : {}),
          ...(resolvedThinkingOptionId !== undefined ? { thinkingOptionId: resolvedThinkingOptionId } : {}),
          ...(resolvedOptions !== undefined ? { options: resolvedOptions } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(toolPolicy !== undefined ? { toolPolicy } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...extraConfig,
        },
        cwd: cwd ?? ws.work,
        ...(agentEnv !== undefined ? { env: agentEnv } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        title: title ?? `scripted ${scenario}`,
        ...(prompt ? { prompt, clientMessageId: randomUUID() } : {}),
      });
    },
    async waitForFinish(agentId, timeoutMs = 60000) {
      return env.api.agents.ref(agentId).waitForFinish(env.ms(timeoutMs));
    },
    timeline,
    assistantTexts: helpers.assistantTexts,
    waitForPermission: helpers.waitForPermission,
    respondToPermission: helpers.respondToPermission,
    waitForAssistantTexts: helpers.waitForAssistantTexts,
    waitForRecord: helpers.waitForRecord,
    waitForTimeline: helpers.waitForTimeline,
    steer: helpers.steer,
    async restart(label = "restart") {
      await env.conn.client.close().catch(() => undefined);
      await daemon.restart(label);
      for (let i = 0; i < 60; i++) {
        try {
          env.conn = await connectClient(daemon, { appVersion });
          return;
        } catch {
          await sleep(500);
        }
      }
      throw new Error("could not reconnect after restart");
    },
    async stop({ outDir, extraCollect: stopExtraCollect } = {}) {
      process.off("exit", onExit);
      await env.conn.client.close().catch(() => undefined);
      await daemon.stop().catch((e) => console.warn(`[testkit] stop failed: ${e}`));
      if (outDir) ws.collect(outDir, mergeExtraCollect(extraCollect, stopExtraCollect));
      ws.cleanup();
    },
  };
  return env;
}
