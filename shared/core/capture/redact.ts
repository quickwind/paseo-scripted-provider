export type RuleKind = "secret" | "email" | "path" | "user" | "literal" | "regex";

export interface Rule {
  id: string;
  kind: RuleKind;
  pattern: RegExp;
  /** Capture group whose text is replaced (0 = whole match). */
  group?: number;
  /** Fixed placeholder (e.g. {{cwd}}); otherwise numbered by kind. */
  fixed?: string;
  label: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  original: string;
  placeholder: string;
  restored: boolean;
}

export interface Segment {
  text: string;
  finding?: Finding;
}

export const DEFAULT_RULES: Rule[] = [
  { id: "pem", kind: "secret", label: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
  { id: "github", kind: "secret", label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { id: "openai", kind: "secret", label: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "aws", kind: "secret", label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "slack", kind: "secret", label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "jwt", kind: "secret", label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: "bearer", kind: "secret", label: "Bearer token", pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/, group: 1 },
  { id: "urlpw", kind: "secret", label: "URL password", pattern: /:\/\/[^\s:/@]+:([^\s@/]+)@/, group: 1 },
  { id: "email", kind: "email", label: "Email address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: "home", kind: "user", label: "Home directory user", pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^/\\\s"'`]+)/, group: 1 },
];

const PREFIX: Record<RuleKind, string> = { secret: "secret", email: "email", user: "user", path: "path", literal: "redacted", regex: "redacted" };

interface Candidate {
  start: number;
  end: number;
  value: string;
  rule: Rule;
  priority: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
}

export interface Redactor {
  addLiteral(value: string, label?: string): void;
  setRestored(original: string, restored: boolean): void;
  segments(text: string): Segment[];
  apply(text: string): string;
  findings(): Finding[];
  applyDeep<T>(value: T): T;
  suspicious(text: string): string[];
}

/**
 * A factory, not a class.
 *
 * The plugin's client bundle runs on Hermes, whose parser has no class expressions, and esbuild
 * emits `var X = class {}` for every class it bundles. A class here made the mobile app fail to
 * compile the plugin ("Invalid expression encountered"). Keep this a plain function.
 */
export function createRedactor(rules: Rule[] = DEFAULT_RULES, ctx: { cwd?: string } = {}): Redactor {
  const leading: Rule[] = []; // cwd + user literals: highest priority
  const registry = new Map<string, Finding>();
  const counters = new Map<string, number>();
  const restoredValues = new Set<string>();

  if (ctx.cwd && ctx.cwd.length > 1) {
    leading.push({ id: "cwd", kind: "path", label: "Session working directory", pattern: new RegExp(`${escapeRe(ctx.cwd)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`), fixed: "{{cwd}}" });
  }

  function addLiteral(value: string, label = "Custom value"): void {
    if (!value) return;
    if (leading.some((r) => r.id === `lit:${value}`)) return;
    leading.push({ id: `lit:${value}`, kind: "literal", label, pattern: new RegExp(escapeRe(value)) });
  }

  function setRestored(original: string, restored: boolean): void {
    if (restored) restoredValues.add(original);
    else restoredValues.delete(original);
    for (const f of registry.values()) if (f.original === original) f.restored = restored;
  }

  function candidates(text: string): Candidate[] {
    const out: Candidate[] = [];
    const all = [...leading.map((r) => ({ r, p: r.id === "cwd" ? 0 : 1 })), ...rules.map((r, i) => ({ r, p: 2 + i }))];
    for (const { r, p } of all) {
      const re = new RegExp(r.pattern.source, `g${r.pattern.flags.replace(/[gd]/g, "")}d`);
      for (const m of text.matchAll(re)) {
        const g = r.group ?? 0;
        const span = (m as unknown as { indices: ([number, number] | undefined)[] }).indices[g];
        if (!span || span[1] <= span[0]) continue;
        out.push({ start: span[0], end: span[1], value: text.slice(span[0], span[1]), rule: r, priority: p });
      }
    }
    return out;
  }

  function pick(text: string): Candidate[] {
    const sorted = candidates(text).sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
    const chosen: Candidate[] = [];
    let cursor = 0;
    for (const c of sorted) {
      if (c.start < cursor) {
        // A secret that runs past a shorter secret match must not leave its tail behind: merge the spans.
        const last = chosen.at(-1);
        if (last && c.end > cursor && c.rule.kind === "secret" && last.rule.kind === "secret") {
          last.end = c.end;
          last.value = text.slice(last.start, c.end);
          cursor = c.end;
        }
        continue;
      }
      chosen.push(c);
      cursor = c.end;
    }
    return chosen;
  }

  function findingFor(c: Candidate): Finding {
    const key = `${c.rule.id}\0${c.value}`;
    let f = registry.get(key);
    if (!f) {
      let placeholder = c.rule.fixed;
      if (!placeholder) {
        const prefix = PREFIX[c.rule.kind];
        const n = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, n);
        placeholder = `{{${prefix}_${n}}}`;
      }
      f = { id: key, ruleId: c.rule.id, original: c.value, placeholder, restored: restoredValues.has(c.value) };
      registry.set(key, f);
    }
    return f;
  }

  function segments(text: string): Segment[] {
    const out: Segment[] = [];
    let at = 0;
    for (const c of pick(text)) {
      if (c.start > at) out.push({ text: text.slice(at, c.start) });
      const f = findingFor(c);
      out.push({ text: f.restored ? f.original : f.placeholder, finding: f });
      at = c.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }

  function apply(text: string): string {
    return segments(text).map((s) => s.text).join("");
  }

  function findings(): Finding[] {
    return [...registry.values()];
  }

  function applyDeep<T>(value: T): T {
    if (typeof value === "string") return apply(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => applyDeep(v)) as unknown as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyDeep(v)])) as T;
    }
    return value;
  }

  /** High-entropy tokens no rule matched. Highlight-only: never altered automatically. */
  function suspicious(text: string): string[] {
    const spans = candidates(text);
    const found = new Set<string>();
    for (const m of text.matchAll(/[A-Za-z0-9_+-]{24,}={0,2}/g)) {
      const tok = m[0];
      const start = m.index ?? 0;
      const end = start + tok.length;
      if (spans.some((s) => s.start < end && s.end > start)) continue;
      if (/^[0-9a-f-]+$/i.test(tok)) continue; // hashes, UUIDs
      if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(tok)) continue; // dates and dated file names
      if (/^(?:toolu|msg|call|req|run|chatcmpl)[_-]/.test(tok)) continue; // API object ids, not credentials
      const parts = tok.split(/[-_]/);
      const wordish = parts.filter((p) => /^[a-z]{3,}$/.test(p) || /^\d+$/.test(p) || /^v\d+$/.test(p)).length;
      if (parts.length >= 2 && wordish / parts.length >= 0.5) continue; // slugs, file names, identifiers
      if (entropy(tok) >= 3.5) found.add(tok);
    }
    return [...found];
  }

  return { addLiteral, setRestored, segments, apply, findings, applyDeep, suspicious };
}
