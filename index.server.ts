import { readFileSync } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildScript, type BuiltScript } from "./server/build-script";
import { resolveConfig, type ResolvedConfig } from "./server/config";
import { createRecorder } from "./server/recorder";
import { createScriptedProvider } from "./server/provider";
import { scenarioNames } from "./shared/core/script";
import { addScenarioToSettings, serializeScript } from "./shared/core/capture/export";
import type { Script } from "./shared/core/schema";
import { captureRpc, exportScriptRpc, getStatusRpc, mergeScenarioRpc, readRecordRpc, scriptedSettings } from "./shared/rpc";

type SettingsValues = { scripts?: string; scriptFile?: string; recordFile?: string; alignment?: string };

export default function contribute(server: PluginServerContext) {
  let values: SettingsValues | undefined;
  const getConfig = (): ResolvedConfig => resolveConfig(values, process.env);

  // Re-read on demand so editing the script file takes effect without a restart; memoize by raw text.
  let memo: { key: string; built: BuiltScript } | undefined;
  const getBuilt = (): BuiltScript => {
    const cfg = getConfig();
    const key = JSON.stringify([cfg.scriptText, cfg.scriptFile, cfg.scriptFile ? safeRead(cfg.scriptFile) : null]);
    if (memo?.key !== key) memo = { key, built: buildScript(cfg) };
    return memo.built;
  };

  const settings = server.registerSettings(scriptedSettings);
  void settings.read().then((s) => {
    if (s.status === "ready") values = s.values;
  });
  const unsubscribe = settings.subscribe((s) => {
    if (s.status === "ready") values = s.values;
  });

  server.registerProvider(createScriptedProvider({ getScript: () => getBuilt().script, getConfig, recorder: (file) => createRecorder(file) }));

  server.handle(getStatusRpc, () => {
    const built = getBuilt();
    return { scenarios: scenarioNames(built.script), error: built.error, recordFile: getConfig().recordFile ?? null };
  });

  server.handle(readRecordRpc, ({ limit }) => {
    const file = getConfig().recordFile;
    if (!file) return { lines: [] };
    const text = safeRead(file);
    if (!text) return { lines: [] };
    return { lines: text.split("\n").filter(Boolean).slice(-(limit ?? 50)) };
  });

  server.handle(captureRpc, async ({ agentId }, { paseo }) => {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 0 });
    const a = page.agent as Record<string, unknown> | null | undefined;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      entries: [...page.entries] as unknown[],
      agent: a ? { id: agentId, cwd: str(a.cwd), title: str(a.title), provider: str(a.provider), model: str(a.model) } : null,
    };
  });

  // The YAML parser lives on this side: the client bundle never ships it.
  server.handle(exportScriptRpc, ({ script, format }) => ({ text: serializeScript(script as Script, format) }));

  server.handle(mergeScenarioRpc, ({ script, name, existingText, format }) => {
    const merged = addScenarioToSettings(existingText, name, script as Script, format);
    return merged.ok ? { ok: true, text: merged.text, name: merged.name } : { ok: false, error: merged.error };
  });

  return () => {
    unsubscribe();
  };
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
