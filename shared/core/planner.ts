import type { Reply, ToolSpec } from "./schema";

export type ToolStatus = "running" | "completed" | "failed" | "canceled";
export type Action =
  | { t: "sleep"; ms: number }
  | { t: "reasoning"; key: string; text: string }
  | { t: "assistant"; key: string; text: string }
  | { t: "tool"; key: string; spec: ToolSpec; status: ToolStatus }
  | { t: "end"; outcome: "completed" | "failed" | "canceled" | "hang"; error?: string };

const BETWEEN: ToolSpec = { name: "scripted_tool", detail: { type: "plain_text", label: "scripted tool", text: "ok" } };

export function planReply(reply: Reply, newKey: () => string = () => globalThis.crypto.randomUUID()): Action[] {
  const out: Action[] = [];
  const sleep = (ms?: number) => {
    if (ms && ms > 0) out.push({ t: "sleep", ms });
  };

  sleep(reply.startDelayMs);
  if (reply.reasoning !== undefined) out.push({ t: "reasoning", key: newKey(), text: reply.reasoning });

  for (const spec of reply.tools ?? []) {
    const key = newKey();
    if (spec.runningMs && spec.runningMs > 0) {
      out.push({ t: "tool", key, spec, status: "running" });
      sleep(spec.runningMs);
    }
    out.push({ t: "tool", key, spec, status: spec.status ?? "completed" });
  }

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
