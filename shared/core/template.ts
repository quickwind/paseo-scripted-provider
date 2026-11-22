// Pure template variable hydration for session replay: replaces `{{cwd}}` and explicit
// `{{prompt.*}}` / `{{session.*}}` placeholders while leaving redaction placeholders
// (`{{secret_N}}`, `{{email_N}}`, `{{user_N}}`, `{{redacted_N}}`) untouched.

const TEMPLATE_VAR = /\{\{(cwd|(?:prompt|session|steer)\.[a-zA-Z0-9_.-]+)\}\}/g;

export interface SessionTemplateContext {
  cwd?: string;
  model?: string | null;
  mode?: string | null;
  thinkingOption?: string | null;
  promptText?: string;
  steerText?: string;
}

export function buildSessionVars(ctx: SessionTemplateContext): Record<string, string> {
  const vars: Record<string, string> = {};
  if (ctx.cwd !== undefined) {
    vars.cwd = ctx.cwd;
    vars["session.cwd"] = ctx.cwd;
  }
  if (ctx.model !== undefined && ctx.model !== null) vars["session.model"] = ctx.model;
  if (ctx.mode !== undefined && ctx.mode !== null) vars["session.mode"] = ctx.mode;
  if (ctx.thinkingOption !== undefined && ctx.thinkingOption !== null) vars["session.thinkingOption"] = ctx.thinkingOption;
  if (ctx.promptText !== undefined) vars["prompt.text"] = ctx.promptText;
  if (ctx.steerText !== undefined) vars["steer.text"] = ctx.steerText;
  return vars;
}

export function hydrateText(text: string, vars: Record<string, string>): string {
  if (!text.includes("{{")) return text;
  return text.replace(TEMPLATE_VAR, function (whole, key: string) {
    return Object.hasOwn(vars, key) ? vars[key] : whole;
  });
}

export function hydrateValue<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return hydrateText(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => hydrateValue(item, vars)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = hydrateValue(v, vars);
    return out as T;
  }
  return value;
}
