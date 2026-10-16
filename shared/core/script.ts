import { ScriptSchema, type Reply, type Script } from "./schema";
import { parseYaml } from "./yaml";

export type ParseResult = { ok: true; script: Script } | { ok: false; error: string };

/** Parses a script written as JSON or YAML (JSON is tried first; text that starts like JSON is reported as JSON). */
export function parseScript(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (jsonError) {
    if (/^\s*[{[]/.test(text)) return { ok: false, error: `Invalid JSON: ${(jsonError as Error).message}` };
    try {
      raw = parseYaml(text);
    } catch (e) {
      return { ok: false, error: `Invalid YAML: ${(e as Error).message}` };
    }
  }
  const r = ScriptSchema.safeParse(raw);
  if (r.success) return { ok: true, script: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: `${issue.path.join(".") || "(root)"}: ${issue.message}` };
}

export function mergeScripts(base: Script, over: Script): Script {
  return {
    macros: { ...base.macros, ...over.macros },
    scenarios: { ...base.scenarios, ...over.scenarios },
  };
}

export function scenarioNames(script: Script): string[] {
  return Object.keys(script.scenarios);
}

export function expandMacro(text: string | undefined, macros: Record<string, string>): string | undefined {
  if (text === undefined) return undefined;
  if (text.startsWith("@")) {
    const name = text.slice(1);
    if (Object.hasOwn(macros, name)) return macros[name];
  }
  return text;
}

const normalize = (t: string) => t.trim();

// What redaction leaves behind: {{secret_1}}-style placeholders.
const WILDCARD = /\{\{[a-z_0-9]+\}\}/;

/** `expect` text as a matcher: redaction placeholders match any text. */
function expectMatches(expect: string, text: string): boolean {
  if (normalize(expect) === normalize(text)) return true;
  if (!WILDCARD.test(expect)) return false;
  const body = normalize(expect)
    .split(new RegExp(WILDCARD.source))
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*?");
  return new RegExp(`^${body}$`).test(normalize(text));
}

/**
 * Which step answers `text`? Recorded scripts carry the user's message in each step's `expect`, so the reply is
 * chosen by content: the current step if it matches, else the next matching step after it (wrapping around),
 * else the current step (plain sequential order).
 */
export function matchStep(script: Script, scenario: string, current: number, text: string): number {
  const list = Object.hasOwn(script.scenarios, scenario) ? script.scenarios[scenario] : undefined;
  if (!list || list.length === 0 || !list.some((r) => r.expect !== undefined)) return current;
  const at = (i: number) => list[i]?.expect;
  const hit = (i: number) => at(i) !== undefined && expectMatches(at(i)!, text);
  if (current < list.length && hit(current)) return current;
  for (let i = current + 1; i < list.length; i++) if (hit(i)) return i;
  for (let i = 0; i < Math.min(current, list.length); i++) if (hit(i)) return i;
  return current;
}

const FALLBACK: Reply = { text: "plain default reply" };

export function resolveReply(script: Script, scenario: string, step: number): { reply: Reply; step: number } {
  const own = (name: string) => (Object.hasOwn(script.scenarios, name) ? script.scenarios[name] : undefined);
  const list = own(scenario) ?? own("default") ?? [FALLBACK];
  const raw = list.length === 0 ? FALLBACK : list[Math.min(step, list.length - 1)];
  const m = script.macros ?? {};
  return {
    step,
    reply: {
      ...raw,
      text: expandMacro(raw.text, m),
      reasoning: expandMacro(raw.reasoning, m),
      chunks: raw.chunks?.map((c) => expandMacro(c, m) ?? ""),
      messages: raw.messages?.map((c) => expandMacro(c, m) ?? ""),
    },
  };
}
