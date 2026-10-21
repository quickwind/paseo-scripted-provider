import { ToolDetailSchema, type Reply, type Script, type Step, type ToolSpec } from "../schema";

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

/**
 * The timed steps of a turn, in the order the agent produced them.
 *
 * Every step carries the real gap to the previous event, so thinking time, each tool call and
 * each message keep their own duration and the replay of a recorded turn takes as long as the
 * original did. `scale` divides the gaps, `drop` removes them.
 */
function stepsOf(turn: Turn, o: ConvertOptions, cut: (s: string) => string): Step[] {
  const steps: Step[] = [];
  const scale = o.delay.mode === "scale" ? o.delay.factor : 1;
  let previous = Date.parse(turn.user.timestamp ?? "");
  const messageIndex = new Map<string, number>(); // messageId -> index in steps
  const toolIndex = new Map<string, number>(); // callId -> index in steps
  let anon = 0;

  for (const e of turn.rest) {
    const it = e.item;
    const at = Date.parse(e.timestamp ?? "");
    const raw = Number.isNaN(previous) || Number.isNaN(at) ? 0 : Math.max(0, at - previous);
    if (!Number.isNaN(at)) previous = at;
    const delayMs = o.delay.mode === "drop" ? undefined : Math.min(MAX_DELAY, Math.round(raw * scale)) || undefined;

    switch (it.type) {
      case "assistant_message": {
        const text = str(it.text);
        if (text === undefined) break;
        const key = str(it.messageId) ?? str(it.id) ?? `anon-${anon++}`;
        const seen = messageIndex.get(key);
        if (seen !== undefined) {
          // A growing snapshot replaces the text; unrelated text (e.g. after a tool call) is appended.
          const step = steps[seen];
          step.text = step.text !== undefined && !text.startsWith(step.text) ? `${step.text}${text}` : text;
          break;
        }
        messageIndex.set(key, steps.length);
        steps.push({ kind: "message", text: cut(text), delayMs });
        break;
      }
      case "reasoning": {
        const text = str(it.text);
        if (text === undefined) break;
        steps.push({ kind: "reasoning", text: cut(text), delayMs });
        break;
      }
      case "tool_call": {
        const key = str(it.callId) ?? str(it.id) ?? `anon-${anon++}`;
        const status = str(it.status) as ToolSpec["status"];
        const spec: ToolSpec = { name: str(it.name) ?? "tool", detail: shapeDetail(it.detail, str(it.name) ?? "tool", o, cut) };
        if (status && status !== "completed") spec.status = status;
        if (status === "failed") spec.error = typeof it.error === "string" ? it.error : JSON.stringify(it.error ?? "failed");
        const seen = toolIndex.get(key);
        if (seen !== undefined) {
          // The same call reported again (running -> completed): one tool, the latest status.
          steps[seen].tool = spec;
          break;
        }
        toolIndex.set(key, steps.length);
        steps.push({ kind: "tool", tool: spec, delayMs });
        break;
      }
      default:
        break;
    }
  }
  return steps;
}

function toReply(turn: Turn, o: ConvertOptions): Reply {
  const cut = truncator(o.truncateAt);
  const reply: Reply = { expect: str(turn.user.item.text) ?? "" };
  let failure: string | undefined;

  for (const e of turn.rest) {
    if (e.item.type === "error") failure = str(e.item.message) ?? "error";
  }

  const steps = stepsOf(turn, o, cut);
  if (steps.length) {
    // The steps carry the timing; the aggregated fields would only duplicate them.
    reply.steps = steps;
    if (o.includeReasoning === false) reply.steps = steps.filter((s) => s.kind !== "reasoning");
  }
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
