import { convertTimeline, type ConvertOptions, type TimelineEntry } from "../shared/core/capture/convert";
import { serializeScript, type ScriptFormat } from "../shared/core/capture/export";
import { Redactor, type Segment } from "../shared/core/capture/redact";
import type { Reply, Script } from "../shared/core/schema";

export interface ReviewModel {
  name: string;
  options: ConvertOptions;
  script: Script;
  redactor: Redactor;
  confirmed: Set<string>;
}

export interface StepPart {
  label: string;
  /** Editable field in the reply; absent for read-only parts (tools). */
  field?: EditField;
  raw: string;
  segments: Segment[];
}
export interface StepView {
  index: number;
  parts: StepPart[];
  suspicious: string[];
}

export type EditField = "text" | "expect" | "reasoning" | `messages.${number}`;

export function buildReview(entries: readonly TimelineEntry[], options: ConvertOptions, ctx: { cwd?: string | null }): ReviewModel {
  return {
    name: options.name,
    options,
    script: convertTimeline(entries, options),
    redactor: new Redactor(undefined, { cwd: ctx.cwd ?? undefined }),
    confirmed: new Set(),
  };
}

const replies = (m: ReviewModel): Reply[] => m.script.scenarios[m.name] ?? [];

interface Str {
  label: string;
  field?: EditField;
  text: string;
}

function stringsOf(r: Reply): Str[] {
  const out: Str[] = [];
  if (r.expect !== undefined) out.push({ label: "You said", field: "expect", text: r.expect });
  if (r.reasoning !== undefined) out.push({ label: "Reasoning", field: "reasoning", text: r.reasoning });
  // The whole tool spec (name, status, error, detail) is shown so the review and the confirm gate see
  // every string that export writes.
  for (const t of r.tools ?? []) out.push({ label: `Tool: ${t.name}`, text: JSON.stringify(t) });
  if (r.text !== undefined) out.push({ label: "Agent said", field: "text", text: r.text });
  (r.messages ?? []).forEach((t, i) => out.push({ label: `Agent message ${i + 1}`, field: `messages.${i}`, text: t }));
  if (r.error !== undefined) out.push({ label: "Error", text: r.error });
  return out;
}

export function stepsView(m: ReviewModel): StepView[] {
  return replies(m).map((r, index) => {
    const parts = stringsOf(r).map((s) => ({ label: s.label, field: s.field, raw: s.text, segments: m.redactor.segments(s.text) }));
    const suspicious = [...new Set(stringsOf(r).flatMap((s) => m.redactor.suspicious(s.text)))];
    return { index, parts, suspicious };
  });
}

export function stats(m: ReviewModel): { autoReplaced: number; suspicious: number; unconfirmed: number } {
  stepsView(m); // populates the finding registry
  const all = new Set(replies(m).flatMap((r) => stringsOf(r).flatMap((s) => m.redactor.suspicious(s.text))));
  const unconfirmed = [...all].filter((t) => !m.confirmed.has(t)).length;
  return { autoReplaced: m.redactor.findings().filter((f) => !f.restored).length, suspicious: all.size, unconfirmed };
}

export function canExport(m: ReviewModel): boolean {
  return stats(m).unconfirmed === 0;
}

export function confirmSuspicious(m: ReviewModel, token: string): ReviewModel {
  const confirmed = new Set(m.confirmed);
  confirmed.add(token);
  return { ...m, confirmed };
}

export function restoreFinding(m: ReviewModel, original: string, restored: boolean): void {
  m.redactor.setRestored(original, restored);
}

export function redactSelection(m: ReviewModel, value: string): void {
  m.redactor.addLiteral(value);
}

export function editStep(m: ReviewModel, index: number, field: EditField, value: string): ReviewModel {
  const list = replies(m).map((r, i) => {
    if (i !== index) return r;
    const next: Reply = { ...r };
    if (field.startsWith("messages.")) {
      const k = Number(field.slice("messages.".length));
      next.messages = (r.messages ?? []).map((t, j) => (j === k ? value : t));
    } else {
      (next as Record<string, unknown>)[field] = value;
    }
    return next;
  });
  return { ...m, script: { ...m.script, scenarios: { ...m.script.scenarios, [m.name]: list } } };
}

export function exportText(m: ReviewModel, format: ScriptFormat = "json"): string {
  return serializeScript(m.redactor.applyDeep(m.script), format);
}

export interface ReviewItem {
  key: string;
  kind: "confirm" | "replaced";
  /** The original text (a suspicious token, or the value that was replaced). */
  value: string;
  /** What to show in the list: a masked token, or the placeholder. */
  display: string;
  step: number;
  /** Index of the part inside the step (see StepView.parts). */
  part: number;
  /** confirm: confirmed (kept or redacted). replaced: always true. */
  done: boolean;
  restored?: boolean;
}

const mask = (t: string) => (t.length <= 12 ? t : `${t.slice(0, 5)}…${t.slice(-4)}`);

/** Everything a reviewer has to look at, once per value, in reading order. */
export function reviewItems(m: ReviewModel): ReviewItem[] {
  const out: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const step of stepsView(m)) {
    step.parts.forEach((part, pi) => {
      for (const tok of m.redactor.suspicious(part.raw)) {
        const key = `confirm\0${tok}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, kind: "confirm", value: tok, display: mask(tok), step: step.index, part: pi, done: m.confirmed.has(tok) });
      }
      for (const seg of part.segments) {
        const f = seg.finding;
        if (!f) continue;
        const key = `replaced\0${f.original}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, kind: "replaced", value: f.original, display: f.placeholder, step: step.index, part: pi, done: true, restored: f.restored });
      }
    });
  }
  return out;
}

export function pendingConfirms(m: ReviewModel): number {
  return reviewItems(m).filter((i) => i.kind === "confirm" && !i.done).length;
}

/** Decide every item that still needs a decision at once. Items you already confirmed are left alone. */
export function resolveAll(m: ReviewModel, how: "redact" | "keep"): ReviewModel {
  const todo = reviewItems(m).filter((i) => i.kind === "confirm" && !i.done);
  const confirmed = new Set(m.confirmed);
  for (const item of todo) {
    if (how === "redact") redactSelection(m, item.value);
    confirmed.add(item.value);
  }
  return { ...m, confirmed };
}
