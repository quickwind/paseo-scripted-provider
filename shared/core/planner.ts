import type { NoticeSpec, PermissionSpec, Reply, Step, TodoItem, ToolSpec, UsageSpec } from "./schema";

export type ToolStatus = "running" | "completed" | "failed" | "canceled";
export type Action =
  | { t: "sleep"; ms: number }
  | { t: "reasoning"; key: string; text: string; revertToken?: unknown }
  | { t: "assistant"; key: string; text: string; revertToken?: unknown }
  | { t: "tool"; key: string; spec: ToolSpec; status: ToolStatus }
  | { t: "todo"; key: string; items: TodoItem[]; revertToken?: unknown }
  | { t: "compaction"; key: string; status: "loading" | "completed"; trigger?: "auto" | "manual"; preTokens?: number; revertToken?: unknown }
  | { t: "notification"; key: string; level: "info" | "warning" | "error"; message: string; revertToken?: unknown }
  | { t: "error"; key: string; message: string; revertToken?: unknown }
  | { t: "plugin"; key: string; pluginId: string; kind: string; version: number; data: unknown; revertToken?: unknown }
  | { t: "usage"; usage: UsageSpec }
  | { t: "notice"; notice: NoticeSpec }
  | {
      t: "end";
      outcome: "completed" | "failed" | "canceled" | "hang";
      error?: string;
      errorCode?: string;
      diagnostic?: string;
      runtimeFailed?: boolean;
    }
  /** Raise a card and wait for the answer; `key` is the tool call's key when `tool` is set. */
  | { t: "permission"; key: string; spec: PermissionSpec; tool?: ToolSpec }
  | { t: "parallel"; children: ParallelChild[] };

export interface ParallelChild {
  key: string;
  tool?: ToolSpec;
  permission?: PermissionSpec;
}

const BETWEEN: ToolSpec = { name: "scripted_tool", detail: { type: "plain_text", label: "scripted tool", text: "ok" } };

function planChunks(
  t: "assistant" | "reasoning",
  chunks: readonly string[],
  gap: number,
  key: string,
  revertToken?: unknown,
): Action[] {
  const out: Action[] = [];
  const last = chunks.length - 1;
  let acc = "";
  chunks.forEach((c, i) => {
    acc += c;
    out.push({ t, key, text: acc, ...(revertToken !== undefined ? { revertToken } : {}) });
    if (i < last && gap > 0) out.push({ t: "sleep", ms: gap });
  });
  return out;
}

export function planReply(reply: Reply, newKey: () => string = () => globalThis.crypto.randomUUID()): Action[] {
  const out: Action[] = [];
  const sleep = (ms?: number) => {
    if (ms && ms > 0) out.push({ t: "sleep", ms });
  };
  const endAction = (): Action => ({
    t: "end",
    outcome: reply.outcome ?? "completed",
    error: reply.error,
    ...(reply.errorCode !== undefined ? { errorCode: reply.errorCode } : {}),
    ...(reply.diagnostic !== undefined ? { diagnostic: reply.diagnostic } : {}),
    ...(reply.runtimeFailed ? { runtimeFailed: true } : {}),
  });

  // A recorded reply keeps its original pacing in `steps`: every thinking block, tool call and
  // message waits for its own gap, so a replay takes as long as the recorded turn did.
  if (reply.steps && reply.steps.length) {
    for (const notice of reply.notices ?? []) out.push({ t: "notice", notice });
    out.push(...planSteps(reply.steps, newKey));
    if (reply.usage) out.push({ t: "usage", usage: reply.usage });
    sleep(reply.delayMs);
    out.push(endAction());
    return out;
  }

  sleep(reply.startDelayMs);
  for (const notice of reply.notices ?? []) out.push({ t: "notice", notice });
  if (reply.reasoning !== undefined) out.push({ t: "reasoning", key: newKey(), text: reply.reasoning });

  for (const spec of reply.tools ?? []) out.push(...planTool(spec, newKey()));

  const gap = reply.chunkDelayMs ?? 10;
  if (reply.messages) {
    const last = reply.messages.length - 1;
    reply.messages.forEach((text, i) => {
      out.push({ t: "assistant", key: newKey(), text });
      if (i < last) {
        if (reply.toolBetween) out.push({ t: "tool", key: newKey(), spec: BETWEEN, status: "completed" });
        sleep(gap);
      }
    });
  } else if (reply.chunks) {
    out.push(...planChunks("assistant", reply.chunks, gap, newKey()));
  } else if (reply.text !== undefined) {
    out.push({ t: "assistant", key: newKey(), text: reply.text });
  }

  if (reply.usage) out.push({ t: "usage", usage: reply.usage });
  sleep(reply.delayMs);
  out.push(endAction());
  return out;
}

/** A tool call: with a card, one permission action (the session runs it); else running → final. */
function planTool(spec: ToolSpec, key: string): Action[] {
  if (spec.permission) return [{ t: "permission", key, spec: spec.permission, tool: spec }];
  const out: Action[] = [];
  // A tool that took time runs first and completes after the wait.
  if (spec.runningMs && spec.runningMs > 0) {
    out.push({ t: "tool", key, spec, status: "running" });
    out.push({ t: "sleep", ms: spec.runningMs });
  }
  out.push({ t: "tool", key, spec, status: spec.status ?? "completed" });
  return out;
}

/** The actions of timed steps, without the final `end` (branches are planned with this at run time). */
export function planSteps(steps: readonly Step[], newKey: () => string): Action[] {
  const out: Action[] = [];
  for (const step of steps) {
    if (step.delayMs && step.delayMs > 0) out.push({ t: "sleep", ms: step.delayMs });
    const rev = step.revertToken !== undefined ? { revertToken: step.revertToken } : {};
    switch (step.kind) {
      case "reasoning":
        if (step.chunks && step.chunks.length > 0) {
          out.push(...planChunks("reasoning", step.chunks, step.chunkDelayMs ?? 10, newKey(), step.revertToken));
        } else {
          out.push({ t: "reasoning", key: newKey(), text: step.text ?? "", ...rev });
        }
        break;
      case "message":
        if (step.chunks && step.chunks.length > 0) {
          out.push(...planChunks("assistant", step.chunks, step.chunkDelayMs ?? 10, newKey(), step.revertToken));
        } else {
          out.push({ t: "assistant", key: newKey(), text: step.text ?? "", ...rev });
        }
        break;
      case "permission":
        if (step.permission) out.push({ t: "permission", key: newKey(), spec: step.permission });
        break;
      case "parallel": {
        const children = (step.steps ?? []).map(
          (c): ParallelChild => ({
            key: newKey(),
            ...(c.tool ? { tool: c.tool } : {}),
            ...(c.permission ?? c.tool?.permission ? { permission: c.permission ?? c.tool?.permission } : {}),
          }),
        );
        out.push({ t: "parallel", children });
        break;
      }
      case "todo":
        out.push({ t: "todo", key: newKey(), items: step.items ?? [], ...rev });
        break;
      case "compaction": {
        const key = newKey();
        const extra = {
          ...(step.trigger ? { trigger: step.trigger } : {}),
          ...(step.preTokens !== undefined ? { preTokens: step.preTokens } : {}),
          ...rev,
        };
        if (step.runningMs && step.runningMs > 0) {
          out.push({ t: "compaction", key, status: "loading", ...extra });
          out.push({ t: "sleep", ms: step.runningMs });
          out.push({ t: "compaction", key, status: step.status ?? "completed", ...extra });
        } else {
          out.push({ t: "compaction", key, status: step.status ?? "completed", ...extra });
        }
        break;
      }
      case "notification":
        out.push({ t: "notification", key: newKey(), level: step.level ?? "info", message: step.message ?? step.text ?? "", ...rev });
        break;
      case "error":
        out.push({ t: "error", key: newKey(), message: step.message ?? step.text ?? "scripted error", ...rev });
        break;
      case "plugin":
        if (step.pluginId && step.pluginKind) {
          out.push({
            t: "plugin",
            key: newKey(),
            pluginId: step.pluginId,
            kind: step.pluginKind,
            version: step.version ?? 1,
            data: step.data ?? null,
            ...rev,
          });
        }
        break;
      case "usage":
        if (step.usage) out.push({ t: "usage", usage: step.usage });
        break;
      case "notice":
        if (step.notice) out.push({ t: "notice", notice: step.notice });
        break;
      case "tool":
        if (step.tool) out.push(...planTool(step.tool, newKey()));
        break;
    }
  }
  return out;
}
