// Script naming and format helpers that need no YAML parser.
// Kept separate from capture/export.ts so the client can import them without pulling the
// YAML library into the mobile bundle.
export type ScriptFormat = "json" | "yaml";

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
