import { readFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../shared/core/config-types";

export type { ResolvedConfig };
const ALIGN = new Set(["warn", "strict", "ignore"]);

function parseDelayScale(envVal: string | undefined, settingVal: number | undefined): number | undefined {
  if (envVal !== undefined && envVal.trim() !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (typeof settingVal === "number" && Number.isFinite(settingVal) && settingVal >= 0) return settingVal;
  return undefined;
}

export function resolveConfig(
  settings: { scripts?: string; scriptFile?: string; recordFile?: string; alignment?: string; delayScale?: number } | undefined,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const alignment = (ALIGN.has(settings?.alignment ?? "") ? settings!.alignment : "warn") as ResolvedConfig["alignment"];
  const delayScale = parseDelayScale(env.SCRIPTED_PROVIDER_DELAY_SCALE, settings?.delayScale);
  const dir = env.SCRIPTED_PROVIDER_STATE;
  if (dir) {
    return {
      scriptFile: path.join(dir, "scenarios.json"),
      recordFile: path.join(dir, "received.jsonl"),
      probeFile: path.join(dir, "probe.jsonl"),
      // Inline scripts from settings still apply (file first, inline wins).
      scriptText: settings?.scripts?.trim() || undefined,
      alignment,
      ...(delayScale !== undefined ? { delayScale } : {}),
    };
  }
  return {
    scriptText: settings?.scripts?.trim() || undefined,
    scriptFile: settings?.scriptFile?.trim() || undefined,
    recordFile: settings?.recordFile?.trim() || undefined,
    alignment,
    ...(delayScale !== undefined ? { delayScale } : {}),
  };
}

/** Script sources in merge order: the file first, then the inline text (inline wins). */
export function loadScriptTexts(
  c: ResolvedConfig,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string[] {
  const out: string[] = [];
  if (c.scriptFile) {
    try {
      const t = read(c.scriptFile);
      if (t.trim()) out.push(t);
    } catch {
      // unreadable file: ignored, the inline script and built-ins still work
    }
  }
  if (c.scriptText) out.push(c.scriptText);
  return out;
}
