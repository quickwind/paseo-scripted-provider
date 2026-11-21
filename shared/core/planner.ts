import type { PermissionSpec, Reply, Step, ToolSpec } from "./schema";

export type ToolStatus = "running" | "completed" | "failed" | "canceled";
export type Action =
  | { t: "sleep"; ms: number }
  | { t: "reasoning"; key: string; text: string }
  | { t: "assistant"; key: string; text: string }
  | { t: "tool"; key: string; spec: ToolSpec; status: ToolStatus }
  | { t: "end"; outcome: "completed" | "failed" | "canceled" | "hang"; error?: string }
  /** Raise a card and wait for the answer; `key` is the tool call's key when `tool` is set. */
  | { t: "permission"; key: string; spec: PermissionSpec; tool?: ToolSpec }
  | { t: "parallel"; children: ParallelChild[] };

export interface ParallelChild {
  key: string;
  tool?: ToolSpec;
  permission?: PermissionSpec;
}

const BETWEEN: ToolSpec = { name: "scripted_tool", detail: { type: "plain_text", label: "scripted tool", text: "ok" } };

export function planReply(reply: Reply, newKey: () => string = () => globalThis.crypto.randomUUID()): Action[] {
  const out: Action[] = [];
  const sleep = (ms?: number) => {
    if (ms && ms > 0) out.push({ t: "sleep", ms });
  };

  // A recorded reply keeps its original pacing in `steps`: every thinking block, tool call and
  // message waits for its own gap, so a replay takes as long as the recorded turn did.
  if (reply.steps && reply.steps.length) {
    out.push(...planSteps(reply.steps, newKey));
    sleep(reply.delayMs);
    out.push({ t: "end", outcome: reply.outcome ?? "completed", error: reply.error });
    return out;
  }

  sleep(reply.startDelayMs);
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
    const key = newKey();
    const last = reply.chunks.length - 1;
    let acc = "";
    reply.chunks.forEach((c, i) => {
      acc += c;
      out.push({ t: "assistant", key, text: acc });
      if (i < last) sleep(gap);
    });
  } else if (reply.text !== undefined) {
    out.push({ t: "assistant", key: newKey(), text: reply.text });
  }

  sleep(reply.delayMs);
  out.push({ t: "end", outcome: reply.outcome ?? "completed", error: reply.error });
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
    if (step.kind === "reasoning") out.push({ t: "reasoning", key: newKey(), text: step.text ?? "" });
    else if (step.kind === "message") out.push({ t: "assistant", key: newKey(), text: step.text ?? "" });
    else if (step.kind === "permission" && step.permission) out.push({ t: "permission", key: newKey(), spec: step.permission });
    else if (step.kind === "parallel") {
      const children = (step.steps ?? []).map(
        (c): ParallelChild => ({ key: newKey(), ...(c.tool ? { tool: c.tool } : {}), ...((c.permission ?? c.tool?.permission) ? { permission: c.permission ?? c.tool?.permission } : {}) }),
      );
      out.push({ t: "parallel", children });
    } else if (step.tool) out.push(...planTool(step.tool, newKey()));
  }
  return out;
}
