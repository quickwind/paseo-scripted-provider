import { ToolDetailSchema, type Reply, type Script, type ToolSpec } from "../schema";

export interface TimelineEntry {
  item: { type: string; [k: string]: unknown };
  timestamp?: string;
}

export interface ConvertOptions {
  name: string;
  lastTurns?: number;
  delay: { mode: "keep" } | { mode: "scale"; factor: number } | { mode: "drop" };
  includeReasoning: boolean;
  includeToolOutput: boolean;
  truncateAt?: number;
}

const OUTPUT_KEYS = ["output", "content", "result", "log"];
const MAX_DELAY = 3_600_000;

interface Turn {
  user: TimelineEntry;
  rest: TimelineEntry[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function splitTurns(entries: readonly TimelineEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    if (!e?.item) continue;
    if (e.item.type === "user_message") turns.push({ user: e, rest: [] });
    else turns.at(-1)?.rest.push(e);
  }
  return turns;
}

function truncator(max?: number) {
  return (s: string): string => (max !== undefined && s.length > max ? `${s.slice(0, max)}…[truncated]` : s);
}

function shapeDetail(detail: unknown, name: string, o: ConvertOptions, cut: (s: string) => string): ToolSpec["detail"] {
  const d: Record<string, unknown> = { ...((detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>) };
  if (!o.includeToolOutput) {
    // Required keys stay (with empty values): the daemon rejects a detail without them.
    if (d.type === "unknown") d.output = null;
    else if (d.type === "sub_agent") d.log = "";
    else if (d.type === "worktree_setup") {
      d.log = "";
      d.commands = Array.isArray(d.commands) ? d.commands.map((c) => ({ ...(c as object), log: "" })) : d.commands;
    } else for (const k of OUTPUT_KEYS) delete d[k];
  } else {
    for (const k of OUTPUT_KEYS) if (typeof d[k] === "string") d[k] = cut(d[k] as string);
  }
  const ok = ToolDetailSchema.safeParse(d);
  if (ok.success) return ok.data;
  // Anything the SDK would reject is kept as readable text instead of stalling the replay.
  return { type: "plain_text", label: name, text: cut(JSON.stringify(detail ?? null)) };
}

function delayMs(user: TimelineEntry, first: TimelineEntry | undefined, o: ConvertOptions): number | undefined {
  if (o.delay.mode === "drop" || !first) return undefined;
  const a = Date.parse(user.timestamp ?? "");
  const b = Date.parse(first.timestamp ?? "");
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  const raw = Math.max(0, b - a) * (o.delay.mode === "scale" ? o.delay.factor : 1);
  const ms = Math.min(MAX_DELAY, Math.round(raw));
  return ms > 0 ? ms : undefined;
}

function toReply(turn: Turn, o: ConvertOptions): Reply {
  const cut = truncator(o.truncateAt);
  const reply: Reply = { expect: str(turn.user.item.text) ?? "" };
  const messages = new Map<string, string>();
  const reasoning = new Map<string, string>();
  const tools = new Map<string, ToolSpec>();
  let anon = 0;
  let failure: string | undefined;

  for (const e of turn.rest) {
    const it = e.item;
    const text = str(it.text);
    switch (it.type) {
      case "assistant_message":
        if (text !== undefined) {
          const key = str(it.messageId) ?? str(it.id) ?? `anon-${anon++}`;
          const prev = messages.get(key);
          // Same id twice: a growing snapshot replaces; unrelated text (e.g. after a tool call) is appended.
          messages.set(key, prev !== undefined && !text.startsWith(prev) ? prev + text : text);
        }
        break;
      case "reasoning":
        if (text !== undefined) reasoning.set(str(it.id) ?? `anon-${anon++}`, text);
        break;
      case "tool_call": {
        const key = str(it.callId) ?? str(it.id) ?? `anon-${anon++}`;
        const status = str(it.status) as ToolSpec["status"];
        const spec: ToolSpec = { name: str(it.name) ?? "tool", detail: shapeDetail(it.detail, str(it.name) ?? "tool", o, cut) };
        if (status && status !== "completed") spec.status = status;
        if (status === "failed") spec.error = typeof it.error === "string" ? it.error : JSON.stringify(it.error ?? "failed");
        tools.set(key, spec);
        break;
      }
      case "error":
        failure = str(it.message) ?? "error";
        break;
      default:
        break;
    }
  }

  const start = delayMs(turn.user, turn.rest.find((e) => ["assistant_message", "reasoning", "tool_call", "error"].includes(e.item.type)), o);
  if (start !== undefined) reply.startDelayMs = start;
  if (o.includeReasoning && reasoning.size) reply.reasoning = cut([...reasoning.values()].join("\n\n"));
  if (tools.size) reply.tools = [...tools.values()];
  const texts = [...messages.values()].map(cut);
  if (texts.length === 1) reply.text = texts[0];
  else if (texts.length > 1) reply.messages = texts;
  if (failure !== undefined) {
    reply.outcome = "failed";
    reply.error = failure;
  }
  return reply;
}

export function convertTimeline(entries: readonly TimelineEntry[], o: ConvertOptions): Script {
  let turns = splitTurns(entries);
  if (o.lastTurns !== undefined && o.lastTurns >= 0) turns = o.lastTurns === 0 ? [] : turns.slice(-o.lastTurns);
  return { scenarios: { [o.name]: turns.map((t) => toReply(t, o)) } };
}
