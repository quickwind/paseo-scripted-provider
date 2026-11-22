// Pure logic of simulated permission cards: the request sent to the daemon, which branch an answer
// picks, and the `{{permission.*}}` variables a branch can quote. Server-only: never import from client/.
import type { Branch, PermissionSpec, Question, Step, ToolSpec } from "./schema";

/** Structurally the SDK's ProviderPermissionResponse (shared code does not import the server SDK). */
export type PermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

const DEFAULT_NAME = { question: "AskUserQuestion", plan: "ExitPlanMode", mode: "SwitchMode", other: "permission", tool: "permission" } as const;

function kindOf(spec: PermissionSpec, tool?: ToolSpec): NonNullable<PermissionSpec["kind"]> {
  if (spec.kind) return spec.kind;
  if (tool) return "tool";
  if (spec.questions) return "question";
  if (spec.plan !== undefined) return "plan";
  return "other";
}

/** The ProviderPermissionRequest for a card; keys without a value are left out. */
export function buildRequest(spec: PermissionSpec, id: string, tool?: ToolSpec): Record<string, unknown> {
  const kind = kindOf(spec, tool);
  const input: Record<string, unknown> = { ...spec.input };
  if (spec.plan !== undefined) input.plan = spec.plan;
  if (spec.questions) input.questions = spec.questions;
  const out: Record<string, unknown> = { id, name: spec.name ?? tool?.name ?? DEFAULT_NAME[kind], kind };
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  put("title", spec.title);
  put("description", spec.description);
  put("input", Object.keys(input).length ? input : undefined);
  put("detail", spec.detail ?? tool?.detail);
  put("suggestions", spec.suggestions);
  put("actions", spec.actions);
  put("metadata", spec.metadata);
  return out;
}

/** `updatedInput.answers` of a question card's answer (string values only). */
export function answersOf(r: PermissionResponse): Record<string, string> | undefined {
  if (r.behavior !== "allow") return undefined;
  const a = r.updatedInput?.answers;
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) if (typeof v === "string") out[k] = v;
  return out;
}

function declaredQuestions(spec: PermissionSpec): Question[] | undefined {
  if (spec.questions) return spec.questions;
  const q = spec.input?.questions;
  return Array.isArray(q) ? (q as unknown as Question[]) : undefined;
}

/** Headers in declaration order (or answer order when the card declared none). */
function headers(spec: PermissionSpec, answers: Record<string, string>): string[] {
  const q = declaredQuestions(spec);
  return q ? q.map((x) => x.header) : Object.keys(answers);
}

function firstAnswer(spec: PermissionSpec, answers: Record<string, string> | undefined): string | undefined {
  if (!answers) return undefined;
  const first = headers(spec, answers)[0];
  return first !== undefined && Object.hasOwn(answers, first) ? answers[first] : undefined;
}

/** The branch an answer picks: action id, then question answers, then allow/deny, then any. */
export function selectBranch(spec: PermissionSpec, r: PermissionResponse): { key: string; branch: Branch } | undefined {
  const on = spec.on;
  if (!on) return undefined;
  const hit = (key: string) => (Object.hasOwn(on, key) ? { key, branch: on[key] } : undefined);
  if (r.selectedActionId !== undefined) {
    const m = hit(r.selectedActionId);
    if (m) return m;
  }
  const answers = answersOf(r);
  if (answers) {
    for (const h of headers(spec, answers)) {
      if (!Object.hasOwn(answers, h)) continue;
      const m = hit(`answer:${h}=${answers[h]}`);
      if (m) return m;
    }
    const first = firstAnswer(spec, answers);
    if (first !== undefined) {
      const m = hit(`answer:${first}`);
      if (m) return m;
    }
  }
  return hit(r.behavior) ?? hit("any");
}

/** Values of `{{permission.<key>}}`. */
export function permissionVars(spec: PermissionSpec, r: PermissionResponse): Record<string, string> {
  const answers = answersOf(r);
  const vars: Record<string, string> = {
    behavior: r.behavior,
    action: r.selectedActionId ?? "",
    message: r.behavior === "deny" ? (r.message ?? "") : "",
    answer: firstAnswer(spec, answers) ?? "",
  };
  // A declared question nobody answered is empty, like every other missing value.
  for (const q of declaredQuestions(spec) ?? []) vars[`answers.${q.header}`] = "";
  for (const [h, v] of Object.entries(answers ?? {})) vars[`answers.${h}`] = v;
  if (r.behavior === "allow" && r.updatedInput && typeof r.updatedInput === "object") {
    for (const [k, v] of Object.entries(r.updatedInput)) {
      if (k === "answers") continue;
      vars[`updatedInput.${k}`] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return vars;
}

const VAR = /\{\{permission\.([^}]+)\}\}/g;

function subText(s: string, vars: Record<string, string>): string {
  return s.replace(VAR, (whole, key: string) => (Object.hasOwn(vars, key) ? vars[key] : whole));
}

function subJson<T>(v: T, vars: Record<string, string>): T {
  if (typeof v === "string") return subText(v, vars) as T;
  if (Array.isArray(v)) return v.map((x) => subJson(x, vars)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = subJson(x, vars);
    return out as T;
  }
  return v;
}

const opt = (s: string | undefined, vars: Record<string, string>) => (s === undefined ? undefined : subText(s, vars));

/**
 * A nested card's shown fields are filled from the outer answer. Its id, name, actions, metadata and
 * suggestions are not (a substituted id could become empty and be rejected), nor its own branches
 * (they use the nested card's own answer).
 */
function subPermission(p: PermissionSpec, vars: Record<string, string>): PermissionSpec {
  const out: PermissionSpec = { ...p, title: opt(p.title, vars), description: opt(p.description, vars), plan: opt(p.plan, vars) };
  if (p.input) out.input = subJson(p.input, vars);
  if (p.detail) out.detail = subJson(p.detail, vars);
  if (p.questions) out.questions = subJson(p.questions, vars);
  return out;
}

function subTool(t: ToolSpec, vars: Record<string, string>): ToolSpec {
  return {
    ...t,
    detail: subJson(t.detail, vars),
    error: opt(t.error, vars),
    ...(t.permission ? { permission: subPermission(t.permission, vars) } : {}),
  };
}

function subStep(s: Step, vars: Record<string, string>): Step {
  return {
    ...s,
    text: opt(s.text, vars),
    ...(s.tool ? { tool: subTool(s.tool, vars) } : {}),
    ...(s.permission ? { permission: subPermission(s.permission, vars) } : {}),
    ...(s.steps ? { steps: s.steps.map((c) => subStep(c, vars)) } : {}),
  };
}

/** Replaces known `{{permission.*}}` variables in a branch; every other `{{…}}` stays as written. */
export function substituteBranch(branch: Branch, vars: Record<string, string>): Branch {
  return {
    ...branch,
    text: opt(branch.text, vars),
    error: opt(branch.error, vars),
    ...(branch.steps ? { steps: branch.steps.map((s) => subStep(s, vars)) } : {}),
  };
}
