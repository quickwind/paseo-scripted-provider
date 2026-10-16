import type { Script } from "../schema";
import { parseScript } from "../script";
import { parseYamlDocument, stringifyYaml } from "../yaml";

export type ScriptFormat = "json" | "yaml";

export function serializeScript(script: Script, format: ScriptFormat = "json"): string {
  return format === "yaml" ? stringifyYaml(script) : JSON.stringify(script, null, 2) + "\n";
}

/** The format of existing script text; an empty script defaults to YAML. */
export function detectFormat(text: string): ScriptFormat {
  const t = text.trim();
  return t === "" || !/^[{[]/.test(t) ? "yaml" : "json";
}

export function scriptFilename(name: string, now: Date = new Date(), format: ScriptFormat = "json"): string {
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/\.{2,}/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "script";
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `${safe}-${stamp}.scripted.${format}`;
}

/** Only characters that `SCENARIO:<name>` and the `scripted/<name>` model id can express. */
export function safeScenarioName(name: string): string {
  return name.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "recorded";
}

export function uniqueScenarioName(existing: readonly string[], name: string): string {
  if (!existing.includes(name)) return name;
  for (let i = 2; ; i++) if (!existing.includes(`${name}-${i}`)) return `${name}-${i}`;
}

/**
 * Adds recorded scenarios (and macros) to the user's script text. The result keeps the user's format; an empty
 * script becomes YAML. Existing YAML is edited in place, so its comments and layout survive.
 */
export function addScenarioToSettings(
  existingText: string,
  name: string,
  script: Script,
  format?: ScriptFormat,
): { ok: true; text: string; name: string } | { ok: false; error: string } {
  const empty: Script = { scenarios: {} };
  const parsed = existingText.trim() ? parseScript(existingText) : ({ ok: true, script: empty } as const);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const target = format ?? detectFormat(existingText);
  const names = Object.keys(parsed.script.scenarios);
  const added: [string, Script["scenarios"][string]][] = [];
  let finalName = name;
  for (const [n, replies] of Object.entries(script.scenarios)) {
    finalName = uniqueScenarioName(names, n);
    names.push(finalName);
    added.push([finalName, replies]);
  }

  if (target === "yaml" && detectFormat(existingText) === "yaml") {
    const doc = parseYamlDocument(existingText);
    if (doc.errors.length) return { ok: false, error: `Invalid YAML: ${doc.errors[0].message}` };
    for (const [n, replies] of added) doc.setIn(["scenarios", n], replies);
    for (const [k, v] of Object.entries(script.macros ?? {})) doc.setIn(["macros", k], v);
    return { ok: true, text: doc.toString({ lineWidth: 0 }), name: finalName };
  }

  const merged: Script = { ...(parsed.script.macros ? { macros: parsed.script.macros } : {}), scenarios: { ...parsed.script.scenarios } };
  for (const [n, replies] of added) merged.scenarios[n] = replies;
  if (script.macros) merged.macros = { ...merged.macros, ...script.macros };
  return { ok: true, text: serializeScript(merged, target), name: finalName };
}
