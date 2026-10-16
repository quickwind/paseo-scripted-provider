# paseo-scripted-provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Paseo plugin whose "Scripted" provider replies from a script, plus a session→script recorder with redaction, a cross-platform e2e testkit, CI with quality + Snyk badges.

**Architecture:** Pure, I/O-free core (`src/`: schema, script, planner, session, capture) wrapped by thin Paseo glue (`index.server.ts`, `index.client.tsx`). Time and IDs are injected so the engine is unit-tested deterministically; the provider is integration-tested through an in-memory `ProviderConnection` harness that validates every emitted event with the SDK's `ProviderEventSchema`; the whole thing is e2e-tested on a real isolated daemon.

**Tech Stack:** TypeScript (ESM, strict), vitest 4 + `@vitest/coverage-v8`, zod 4 (provided by the daemon at runtime), `@getpaseo/plugin` 0.11.x (types + `ProviderEventSchema` in tests), React Native types for the client, Node ≥ 22, GitHub Actions, Snyk CLI.

**Spec:** `docs/superpowers/specs/2026-10-16-paseo-scripted-provider-design.md`

## Global Constraints

- License MIT, header line `Copyright (c) 2026 quickwind`; repo `quickwind/paseo-scripted-provider`.
- All work on branch `feat/v0.1`; **do not create `main`, do not push** until the user approves. Final step is a single squash commit on `main`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Git identity is already set in this repo (`quickwind`, GitHub noreply email) — never use the user's personal email.
- `scratch/` is git-ignored and must never be committed.
- Server code under `src/` and `index.server.ts` may import only Node built-ins, `zod`, relative files, and **type-only** imports from `@getpaseo/plugin` (the installed plugin dir has no `node_modules`; the daemon compiles with esbuild and supplies `zod`).
- Plugin id `paseo-scripted-provider`; provider id `scripted`; `requirements.paseo` = `>=0.11.0 <0.12.0` (tested on 0.11.4).
- No shell scripts for tooling; Node only (Windows-safe). Use `process.execPath` to spawn the Paseo CLI JS entry.
- Tools in scripts are display-only: nothing is ever executed.
- Tests must not touch the user's real `~/.paseo` or port 6767. Real-verification uses a free port, temp `--home`, temp `HOME`/`USERPROFILE`.
- Coverage gate: ≥ 85% lines on `src/`.

## Review Focus

1. Empty / invalid / huge-but-valid script (0 scenarios, 10k replies) → provider must fall back to built-ins and surface a notice, never crash the daemon. (Task 2, 6)
2. Prompt arrives while a `hang` turn is active, then interrupt arrives twice → exactly one terminal turn event per turn, no hung promise. (Task 5)
3. Prompt with only an image / attachment, or a `command` input → recorded and answered, no exception. (Task 5)
4. Redaction of overlapping matches (a URL containing an email containing a token) and of a value that is a substring of another → deterministic, no corrupted text, consistent placeholders. (Task 10)
5. Timeline with zero turns, a final turn with no assistant message, unknown item types, or missing timestamps → converter yields a valid (possibly empty) script, not an exception. (Task 9)

---

## File Structure

```
.gitignore  LICENSE  README.md  package.json  tsconfig.json  vitest.config.ts  paseo-plugin.json
index.server.ts                 glue only
index.client.tsx                glue only
shared/rpc.ts                   RPC contracts + settings definition (used by server and client)
src/schema.ts                   zod schemas/types: Script, Reply, ToolSpec
src/script.ts                   parseScript, builtins merge, macro expansion, pickReply
src/planner.ts                  planReply(reply) -> Action[]  (pure)
src/clock.ts                    Clock/Ids interfaces + real impls
src/recorder.ts                 JSONL appender
src/config.ts                   resolve state dir / files from settings + env
src/session.ts                  ScriptedSession (turn state machine)
src/provider.ts                 createScriptedProvider(deps) -> ProviderRegistration
src/capture/convert.ts          timeline entries -> Script
src/capture/redact.ts           rules, findings, apply
src/capture/export.ts           serialize + filename
client/                         RN components: settings.tsx, record-button.tsx, record-modal.tsx, review.tsx, web.ts
scenarios/*.json                built-in scenarios (imported by src/script.ts via builtins.ts)
src/builtins.ts                 built-in scenarios as TS (so no fs read at runtime)
testkit/                        package "paseo-scripted-provider-testkit": daemon.mjs, index.mjs
test/unit/*.test.ts  test/integration/*.test.ts  test/helpers/*.ts
e2e/run.mjs  e2e/*.test.mjs     real-daemon tests (node:test)
scripts/verify-real.mjs         local real opencode/devin verification
.github/workflows/ci.yml  security.yml
```

---

### Task 1: Project scaffold, license, tooling

**Files:**
- Create: `LICENSE`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `paseo-plugin.json`, `README.md` (stub), `test/unit/smoke.test.ts`

**Interfaces:** Produces npm scripts `typecheck`, `test`, `test:unit`, `test:integration`, `test:coverage`, `e2e`.

- [ ] **Step 1: Write LICENSE and manifest**

`LICENSE`: standard MIT text with `Copyright (c) 2026 quickwind`.

`paseo-plugin.json`:
```json
{
  "id": "paseo-scripted-provider",
  "name": "Scripted Provider",
  "description": "A Paseo agent backend that replies from a script instead of a model. Deterministic testing, plus record-a-session-as-a-script.",
  "requirements": { "paseo": ">=0.11.0 <0.12.0" }
}
```

- [ ] **Step 2: package.json**

```json
{
  "name": "paseo-scripted-provider",
  "version": "0.1.0",
  "description": "Paseo plugin: a scripted (model-free) agent provider with session-to-script recording.",
  "license": "MIT",
  "author": "quickwind",
  "repository": { "type": "git", "url": "git+https://github.com/quickwind/paseo-scripted-provider.git" },
  "type": "module",
  "files": ["README.md","LICENSE","paseo-plugin.json","index.server.ts","index.client.tsx","src/","client/","shared/"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:coverage": "vitest run --coverage",
    "e2e": "node --test e2e/",
    "verify:real": "node scripts/verify-real.mjs"
  },
  "devDependencies": {
    "@getpaseo/client": "^0.11.2",
    "@getpaseo/plugin": "^0.11.2",
    "@types/node": "^22.20.4",
    "@types/react": "~19.2.0",
    "@vitest/coverage-v8": "^4.1.11",
    "react": "19.1.0",
    "react-native": "0.81.5",
    "typescript": "^5.9.3",
    "vitest": "^4.1.11",
    "zod": "^4.4.3"
  },
  "keywords": ["paseo","paseo-plugin","testing","mock","scripted","e2e"]
}
```

`tsconfig.json`: copy of the export-session one (ES2020, ESNext, Bundler, lib ES2023, `types:["react","node"]`, jsx react-jsx, strict, skipLibCheck, noEmit) with `include: ["**/*.ts","**/*.tsx"]` and `exclude: ["node_modules","scratch","e2e","testkit","scripts"]`.

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default", "junit", "html"],
    outputFile: { junit: "reports/junit.xml", html: "reports/html/index.html" },
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "reports/coverage",
      thresholds: { lines: 85 },
    },
  },
});
```
(`@vitest/ui` is required for the `html` reporter — add `"@vitest/ui": "^4.1.11"` to devDependencies.)

- [ ] **Step 3: Smoke test**

`test/unit/smoke.test.ts`:
```ts
import { expect, it } from "vitest";
it("toolchain works", () => { expect(1 + 1).toBe(2); });
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm run typecheck && npm test`
Expected: install ok, typecheck passes (no TS inputs besides test), 1 test passes. `package-lock.json` created.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "chore: scaffold project, MIT license, tooling" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema and script parsing

**Files:** Create `src/schema.ts`, `src/script.ts`, `src/builtins.ts`; Test `test/unit/script.test.ts`

**Interfaces:** Produces
```ts
// schema.ts
export const ToolSpecSchema, ReplySchema, ScriptSchema;
export type ToolSpec, Reply, Script;
// script.ts
export function parseScript(text: string): { ok: true; script: Script } | { ok: false; error: string };
export function mergeScripts(base: Script, over: Script): Script;     // over wins per scenario; macros merged
export function resolveReply(script: Script, scenario: string, step: number): { reply: Reply; step: number }; // clamps to last; falls back to "default"
export function expandMacro(text: string|undefined, macros: Record<string,string>): string|undefined; // whole-string "@NAME"
export function scenarioNames(script: Script): string[];
// builtins.ts
export const BUILTIN_SCRIPT: Script;
```
`Reply` fields: `text?, reasoning?, chunks?, chunkDelayMs?, messages?, toolBetween?, tools?: ToolSpec[], startDelayMs?, delayMs?, outcome?: "completed"|"failed"|"canceled"|"hang", error?: string, expect?: string`.
`ToolSpec`: `{ name: string, detail: ProviderToolCallDetail-like object (type discriminated, passthrough), status?: "running"|"completed"|"failed"|"canceled" (default completed), runningMs?: number, error?: string }`.

- [ ] **Step 1: Failing tests** (`test/unit/script.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { parseScript, mergeScripts, resolveReply, expandMacro, scenarioNames } from "../../src/script";
import { BUILTIN_SCRIPT } from "../../src/builtins";

describe("parseScript", () => {
  it("accepts a minimal script", () => {
    const r = parseScript(JSON.stringify({ scenarios: { a: [{ text: "hi" }] } }));
    expect(r.ok).toBe(true);
  });
  it("rejects invalid JSON with a message", () => {
    const r = parseScript("{nope");
    expect(r).toMatchObject({ ok: false });
  });
  it("reports the path of a schema error", () => {
    const r = parseScript(JSON.stringify({ scenarios: { a: [{ outcome: "exploded" }] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("scenarios.a.0.outcome");
  });
  it("rejects negative delays", () => {
    const r = parseScript(JSON.stringify({ scenarios: { a: [{ startDelayMs: -1 }] } }));
    expect(r.ok).toBe(false);
  });
  it("accepts an empty scenarios object", () => {
    expect(parseScript('{"scenarios":{}}').ok).toBe(true);
  });
});

describe("resolveReply", () => {
  const script = { scenarios: { a: [{ text: "1" }, { text: "2" }] } };
  it("steps through and repeats the last reply", () => {
    expect(resolveReply(script, "a", 0).reply.text).toBe("1");
    expect(resolveReply(script, "a", 1).reply.text).toBe("2");
    expect(resolveReply(script, "a", 9).reply.text).toBe("2");
  });
  it("falls back to the default scenario for unknown names", () => {
    const merged = mergeScripts(BUILTIN_SCRIPT, script);
    expect(resolveReply(merged, "nope", 0).reply.text).toBeTruthy();
  });
  it("expands @MACRO in text, chunks and messages", () => {
    const s = { macros: { M: "X" }, scenarios: { a: [{ text: "@M", chunks: ["@M", "y"], messages: ["@M"] }] } };
    const { reply } = resolveReply(s, "a", 0);
    expect(reply).toMatchObject({ text: "X", chunks: ["X", "y"], messages: ["X"] });
  });
});

describe("expandMacro", () => {
  it("leaves unknown macros and non-macro text alone", () => {
    expect(expandMacro("@UNKNOWN", {})).toBe("@UNKNOWN");
    expect(expandMacro("hello @M", { M: "X" })).toBe("hello @M");
    expect(expandMacro(undefined, {})).toBeUndefined();
  });
});

it("builtins include the documented example scenarios", () => {
  expect(scenarioNames(BUILTIN_SCRIPT)).toEqual(
    expect.arrayContaining(["default", "chat", "long-output", "fail", "cancel", "slow-stream", "tools-demo"]),
  );
});
```

- [ ] **Step 2:** Run `npx vitest run test/unit/script.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/schema.ts`:
```ts
import { z } from "zod";

const ms = z.number().int().min(0).max(3_600_000);

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  detail: z.object({ type: z.string() }).passthrough(),
  status: z.enum(["running", "completed", "failed", "canceled"]).optional(),
  runningMs: ms.optional(),
  error: z.string().optional(),
});

export const ReplySchema = z.object({
  text: z.string().optional(),
  reasoning: z.string().optional(),
  chunks: z.array(z.string()).optional(),
  chunkDelayMs: ms.optional(),
  messages: z.array(z.string()).optional(),
  toolBetween: z.boolean().optional(),
  tools: z.array(ToolSpecSchema).optional(),
  startDelayMs: ms.optional(),
  delayMs: ms.optional(),
  outcome: z.enum(["completed", "failed", "canceled", "hang"]).optional(),
  error: z.string().optional(),
  expect: z.string().optional(),
});

export const ScriptSchema = z.object({
  macros: z.record(z.string(), z.string()).optional(),
  scenarios: z.record(z.string(), z.array(ReplySchema)),
});

export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export type Reply = z.infer<typeof ReplySchema>;
export type Script = z.infer<typeof ScriptSchema>;
```

`src/script.ts`:
```ts
import { ScriptSchema, type Reply, type Script } from "./schema";

export type ParseResult = { ok: true; script: Script } | { ok: false; error: string };

export function parseScript(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const r = ScriptSchema.safeParse(raw);
  if (r.success) return { ok: true, script: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: `${issue.path.join(".") || "(root)"}: ${issue.message}` };
}

export function mergeScripts(base: Script, over: Script): Script {
  return {
    macros: { ...base.macros, ...over.macros },
    scenarios: { ...base.scenarios, ...over.scenarios },
  };
}

export function scenarioNames(script: Script): string[] {
  return Object.keys(script.scenarios);
}

export function expandMacro(text: string | undefined, macros: Record<string, string>): string | undefined {
  if (text === undefined) return undefined;
  if (text.startsWith("@")) {
    const hit = macros[text.slice(1)];
    if (hit !== undefined) return hit;
  }
  return text;
}

export function resolveReply(script: Script, scenario: string, step: number): { reply: Reply; step: number } {
  const list = script.scenarios[scenario] ?? script.scenarios["default"] ?? [{ text: "plain default reply" }];
  const raw = list.length === 0 ? { text: "plain default reply" } : list[Math.min(step, list.length - 1)];
  const m = script.macros ?? {};
  return {
    step,
    reply: {
      ...raw,
      text: expandMacro(raw.text, m),
      reasoning: expandMacro(raw.reasoning, m),
      chunks: raw.chunks?.map((c) => expandMacro(c, m) ?? ""),
      messages: raw.messages?.map((c) => expandMacro(c, m) ?? ""),
    },
  };
}
```
(Objects with `undefined` keys are fine for `toMatchObject`.)

`src/builtins.ts` — `BUILTIN_SCRIPT: Script` with scenarios:
- `default`: `[{ text: "plain default reply" }]`
- `chat`: `[{text:"Hello! I'm the Scripted provider."},{text:"This is the second scripted reply."},{text:"That's all I have; I will repeat this."}]`
- `long-output`: one reply whose `text` is `Array.from({length:200},(_,i)=>`Line ${i+1}: lorem ipsum dolor sit amet.`).join("\n")`
- `fail`: `[{ text: "partial…", startDelayMs: 300, outcome: "failed", error: "scripted failure" }]`
- `cancel`: `[{ text: "about to be canceled", outcome: "canceled" }]`
- `slow-stream`: `[{ chunks: ["Streaming ","one ","chunk ","at ","a ","time."], chunkDelayMs: 400 }]`
- `tools-demo`: one reply with `tools`: a shell Bash (`npm test`, output `3 passed`, exitCode 0, runningMs 800), a failed edit (`src/a.ts`, error `conflict`), and `text: "Tests pass; the edit conflicted."`.

- [ ] **Step 4:** Run `npx vitest run test/unit/script.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** `feat: script schema, parsing, macros, built-in scenarios`.

---

### Task 3: Reply planner

**Files:** Create `src/planner.ts`; Test `test/unit/planner.test.ts`

**Interfaces:** Produces
```ts
export type Action =
  | { t: "sleep"; ms: number }
  | { t: "reasoning"; key: string; text: string }
  | { t: "assistant"; key: string; text: string }            // same key => same timeline id (growing snapshot)
  | { t: "tool"; key: string; spec: ToolSpec; status: "running"|"completed"|"failed"|"canceled" }
  | { t: "end"; outcome: "completed"|"failed"|"canceled"|"hang"; error?: string };
export function planReply(reply: Reply, newKey?: () => string): Action[];
```
Order: `startDelayMs` sleep → reasoning → tools (a tool with `runningMs` emits `running`, sleep, then final status with same key) → body (messages | chunks | text) → `delayMs` sleep → end. Default chunk/message delay 10 ms (sleep between, none after the last). `toolBetween` inserts a `{name:"scripted_tool", detail:{type:"plain_text",label:"scripted tool",text:"ok"}}` completed tool between messages. Zero-ms sleeps are omitted.

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { planReply } from "../../src/planner";

let n = 0;
const key = () => `k${++n}`;
const kinds = (a: ReturnType<typeof planReply>) => a.map((x) => x.t);

describe("planReply", () => {
  it("text only: one assistant item then end", () => {
    expect(planReply({ text: "hi" }, key)).toEqual([
      { t: "assistant", key: expect.any(String), text: "hi" },
      { t: "end", outcome: "completed", error: undefined },
    ]);
  });
  it("orders start delay, reasoning, tools, body, end delay", () => {
    const a = planReply({ startDelayMs: 5, reasoning: "r", tools: [{ name: "T", detail: { type: "plain_text" } }], text: "x", delayMs: 7 }, key);
    expect(kinds(a)).toEqual(["sleep", "reasoning", "tool", "assistant", "sleep", "end"]);
  });
  it("chunks are growing snapshots of ONE key", () => {
    const a = planReply({ chunks: ["a", "b", "c"], chunkDelayMs: 3 }, key).filter((x) => x.t === "assistant") as any[];
    expect(a.map((x) => x.text)).toEqual(["a", "ab", "abc"]);
    expect(new Set(a.map((x) => x.key)).size).toBe(1);
  });
  it("messages get distinct keys, with a tool between when asked", () => {
    const a = planReply({ messages: ["m1", "m2"], toolBetween: true }, key);
    expect(kinds(a)).toEqual(["assistant", "tool", "sleep", "assistant", "end"]);
    const keys = a.filter((x) => x.t === "assistant").map((x: any) => x.key);
    expect(new Set(keys).size).toBe(2);
  });
  it("a tool with runningMs emits running then final with the same key", () => {
    const a = planReply({ tools: [{ name: "T", detail: { type: "plain_text" }, runningMs: 50, status: "failed", error: "boom" }] }, key);
    const tools = a.filter((x) => x.t === "tool") as any[];
    expect(tools.map((t) => t.status)).toEqual(["running", "failed"]);
    expect(tools[0].key).toBe(tools[1].key);
    expect(a.some((x) => x.t === "sleep" && x.ms === 50)).toBe(true);
  });
  it("omits zero sleeps and carries outcome/error", () => {
    const a = planReply({ outcome: "failed", error: "nope", startDelayMs: 0 }, key);
    expect(a).toEqual([{ t: "end", outcome: "failed", error: "nope" }]);
  });
  it("empty reply is just an end", () => {
    expect(planReply({}, key)).toEqual([{ t: "end", outcome: "completed", error: undefined }]);
  });
});
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3: Implement** `src/planner.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Reply, ToolSpec } from "./schema";

export type ToolStatus = "running" | "completed" | "failed" | "canceled";
export type Action =
  | { t: "sleep"; ms: number }
  | { t: "reasoning"; key: string; text: string }
  | { t: "assistant"; key: string; text: string }
  | { t: "tool"; key: string; spec: ToolSpec; status: ToolStatus }
  | { t: "end"; outcome: "completed" | "failed" | "canceled" | "hang"; error?: string };

const BETWEEN: ToolSpec = { name: "scripted_tool", detail: { type: "plain_text", label: "scripted tool", text: "ok" } };

export function planReply(reply: Reply, newKey: () => string = randomUUID): Action[] {
  const out: Action[] = [];
  const sleep = (ms?: number) => { if (ms && ms > 0) out.push({ t: "sleep", ms }); };

  sleep(reply.startDelayMs);
  if (reply.reasoning !== undefined) out.push({ t: "reasoning", key: newKey(), text: reply.reasoning });

  for (const spec of reply.tools ?? []) {
    const key = newKey();
    const final = spec.status ?? "completed";
    if (spec.runningMs && spec.runningMs > 0) {
      out.push({ t: "tool", key, spec, status: "running" });
      sleep(spec.runningMs);
    }
    out.push({ t: "tool", key, spec, status: final });
  }

  const gap = reply.chunkDelayMs ?? 10;
  if (reply.messages) {
    reply.messages.forEach((text, i) => {
      out.push({ t: "assistant", key: newKey(), text });
      if (i < reply.messages!.length - 1) {
        if (reply.toolBetween) out.push({ t: "tool", key: newKey(), spec: BETWEEN, status: "completed" });
        sleep(gap);
      }
    });
  } else if (reply.chunks) {
    const key = newKey();
    let acc = "";
    reply.chunks.forEach((c, i) => {
      acc += c;
      out.push({ t: "assistant", key, text: acc });
      if (i < reply.chunks!.length - 1) sleep(gap);
    });
  } else if (reply.text !== undefined) {
    out.push({ t: "assistant", key: newKey(), text: reply.text });
  }

  sleep(reply.delayMs);
  out.push({ t: "end", outcome: reply.outcome ?? "completed", error: reply.error });
  return out;
}
```

- [ ] **Step 4:** tests PASS, typecheck. **Step 5: Commit** `feat: reply planner`.

---

### Task 4: Clock, ids, recorder, config

**Files:** Create `src/clock.ts`, `src/recorder.ts`, `src/config.ts`, `test/helpers/manual-clock.ts`; Test `test/unit/recorder.test.ts`, `test/unit/config.test.ts`

**Interfaces:** Produces
```ts
// clock.ts
export interface Clock { now(): number; sleep(ms: number): Promise<void>; }
export const realClock: Clock;
export type NewId = () => string;
// recorder.ts
export interface Recorder { record(kind: string, data: Record<string, unknown>): void; }
export function createRecorder(file: string | undefined, now?: () => number): Recorder; // no-op when file undefined; never throws
export const nullRecorder: Recorder;
// config.ts
export interface ResolvedConfig { scriptText: string | undefined; scriptFile: string | undefined; recordFile: string | undefined; probeFile: string | undefined; alignment: "warn"|"strict"|"ignore"; }
export function resolveConfig(settings: { scripts?: string; scriptFile?: string; recordFile?: string; alignment?: string } | undefined, env: Record<string,string|undefined>): ResolvedConfig;
export function loadScriptText(c: ResolvedConfig, readFile?: (p: string) => string): string | undefined;
// test/helpers/manual-clock.ts
export class ManualClock implements Clock { advance(ms): Promise<void> /* resolves due sleeps in order, yields microtasks */; pending(): number[] }
```
Env override: `SCRIPTED_PROVIDER_STATE=<dir>` → `scriptFile=<dir>/scenarios.json`, `recordFile=<dir>/received.jsonl`, `probeFile=<dir>/probe.jsonl`; explicit settings win only when env is unset.

- [ ] **Step 1: Tests**

`test/unit/recorder.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRecorder } from "../../src/recorder";

it("appends one JSON line per record with time and kind", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "rec-")), "r.jsonl");
  const r = createRecorder(f, () => 1700000000000);
  r.record("prompt", { text: "hi" });
  r.record("interrupt", {});
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { t: "2023-11-14T22:13:20.000Z", kind: "prompt", text: "hi" },
    { t: "2023-11-14T22:13:20.000Z", kind: "interrupt" },
  ]);
});
it("is a no-op without a file and never throws on unwritable paths", () => {
  expect(() => createRecorder(undefined).record("x", {})).not.toThrow();
  expect(() => createRecorder("/definitely/not/writable/x.jsonl").record("x", {})).not.toThrow();
});
```
`test/unit/config.test.ts`: env dir beats settings; settings used when env empty; defaults `alignment: "warn"`; invalid alignment string → `"warn"`; `loadScriptText` prefers inline `scripts` over file, returns undefined when file unreadable.

- [ ] **Step 2:** FAIL. **Step 3: Implement.**

`src/clock.ts`:
```ts
export interface Clock { now(): number; sleep(ms: number): Promise<void>; }
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export type NewId = () => string;
```
`src/recorder.ts`:
```ts
import { appendFileSync } from "node:fs";
export interface Recorder { record(kind: string, data: Record<string, unknown>): void; }
export const nullRecorder: Recorder = { record() {} };
export function createRecorder(file: string | undefined, now: () => number = Date.now): Recorder {
  if (!file) return nullRecorder;
  return {
    record(kind, data) {
      try {
        appendFileSync(file, JSON.stringify({ t: new Date(now()).toISOString(), kind, ...data }) + "\n");
      } catch (error) {
        console.error("[scripted-provider] record failed", error);
      }
    },
  };
}
```
`src/config.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";

export interface ResolvedConfig {
  scriptText?: string; scriptFile?: string; recordFile?: string; probeFile?: string;
  alignment: "warn" | "strict" | "ignore";
}
const ALIGN = new Set(["warn", "strict", "ignore"]);

export function resolveConfig(
  settings: { scripts?: string; scriptFile?: string; recordFile?: string; alignment?: string } | undefined,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const alignment = (ALIGN.has(settings?.alignment ?? "") ? settings!.alignment : "warn") as ResolvedConfig["alignment"];
  const dir = env.SCRIPTED_PROVIDER_STATE;
  if (dir) {
    return {
      scriptFile: path.join(dir, "scenarios.json"),
      recordFile: path.join(dir, "received.jsonl"),
      probeFile: path.join(dir, "probe.jsonl"),
      alignment,
    };
  }
  return {
    scriptText: settings?.scripts?.trim() || undefined,
    scriptFile: settings?.scriptFile?.trim() || undefined,
    recordFile: settings?.recordFile?.trim() || undefined,
    alignment,
  };
}

export function loadScriptText(c: ResolvedConfig, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  if (c.scriptText) return c.scriptText;
  if (!c.scriptFile) return undefined;
  try { return read(c.scriptFile); } catch { return undefined; }
}
```
`test/helpers/manual-clock.ts`:
```ts
import type { Clock } from "../../src/clock";
export class ManualClock implements Clock {
  private t = 0;
  private waiters: { at: number; resolve: () => void }[] = [];
  now() { return this.t; }
  sleep(ms: number) { return new Promise<void>((resolve) => { this.waiters.push({ at: this.t + ms, resolve }); }); }
  pending() { return this.waiters.map((w) => w.at - this.t).sort((a, b) => a - b); }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.waiters.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.waiters = this.waiters.filter((w) => w !== due);
      this.t = due.at;
      due.resolve();
    }
    this.t = target;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
```

- [ ] **Step 4:** PASS + typecheck. **Step 5: Commit** `feat: clock, recorder, config resolution`.

---

### Task 5: Session state machine and provider

**Files:** Create `src/session.ts`, `src/provider.ts`; Test `test/unit/session.test.ts`, `test/helpers/harness.ts`

**Interfaces:** Consumes Tasks 2–4. Produces
```ts
// session.ts
export interface Persisted { logicalId: string; scenario: string | null; step: number; transcript: {id:string;type:"user_message"|"assistant_message";text:string}[] }
export interface SessionDeps {
  sessionId: string; script: () => Script; clock: Clock; newId: NewId; recorder: Recorder;
  alignment: "warn"|"strict"|"ignore"; emit: (e: ProviderEvent) => void; persisted?: Persisted; initialScenario?: string;
}
export class ScriptedSession {
  constructor(d: SessionDeps);
  prompt(p: ProviderPrompt): void;      // emits prompt_result, turn started, items, turn end
  interrupt(requestId: string): void;   // emits request.completed; ends active turn as canceled
  persistence(): Persisted;
  readonly activeTurn: string | null;
}
export function promptText(p: ProviderPrompt): string;
// provider.ts
export interface ProviderDeps { getScript(): Script; getConfig(): ResolvedConfig; clock?: Clock; newId?: NewId; recorder?(file?:string): Recorder; notify?(msg:string):void }
export function createScriptedProvider(deps: ProviderDeps): ProviderRegistration;
```
Behavior (from spec §3): `ProviderEvent`/`ProviderPrompt`/`ProviderRegistration` are **type-only** imports from `@getpaseo/plugin/server/provider`.
- `prompt`: parse `^SCENARIO:([\w-]+)` on trimmed text → sets scenario, step 0 (that message consumes step 0). Records `{kind:"prompt", sessionId, scenario, step, delivery, clientMessageId, activeTurnAtArrival, text}`. If a turn is active, it is superseded: old turn emitted `canceled` ("superseded by new prompt"), its pending sleep/hang released. Alignment: if reply has `expect` and `trim(text) !== trim(expect)`: `strict` → `prompt_result {type:"failed", error:{code:"E_SCRIPT_MISMATCH"}}` with no turn, record `mismatch`; `warn` → record `mismatch` + proceed; `ignore` → proceed.
- Terminal events: exactly one `session.turn` terminal per turn id. `hang` waits for interrupt/supersede. After each turn emits `session.persistence`.
- Item ids: `newId()` per key (map key→id within turn); `assistant_message` has `messageId = id`; tools: `{type:"tool_call", id, callId:id, name, status, error: status==="failed" ? (spec.error ?? "scripted failure") : null, detail}` (`running`/`completed`/`canceled` ⇒ `error:null`); reasoning `{type:"reasoning", id, text}`.
- `command` input prompts → text `/${name} ${arguments}`; image/other content ignored for text but recorded as `contentTypes`.

- [ ] **Step 1: Test harness** `test/helpers/harness.ts`:

```ts
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createScriptedProvider, type ProviderDeps } from "../../src/provider";
import { ManualClock } from "./manual-clock";

export async function connect(deps: Partial<ProviderDeps> & Pick<ProviderDeps, "getScript">) {
  const clock = new ManualClock();
  let id = 0;
  const reg = createScriptedProvider({
    getConfig: () => ({ alignment: "warn" }),
    clock,
    newId: () => `id-${++id}`,
    ...deps,
  });
  const conn = await reg.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  const events: ProviderEvent[] = [];
  conn.onEvent((e) => {
    expectValid(e);
    events.push(e);
  });
  const send = async (i: ProviderInput) => { await conn.send(i); await clock.advance(0); };
  return { conn, clock, events, send, reg };
}

function expectValid(e: ProviderEvent) {
  const r = ProviderEventSchema.safeParse(e);
  if (!r.success) throw new Error("Invalid ProviderEvent: " + JSON.stringify(r.error.issues) + " " + JSON.stringify(e));
}

export const open = (sessionId = "s1", model?: string): ProviderInput => ({
  type: "session.open", requestId: "r-open", sessionId, history: "skip",
  config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true, model },
});
export const prompt = (sessionId: string, text: string, cmid = "c" + Math.random()): ProviderInput => ({
  type: "session.prompt", sessionId,
  prompt: { clientMessageId: cmid, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
});
export const turnStates = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { type: "session.turn" }> => e.type === "session.turn").map((e) => e.state);
```
(Note: `connect()` in the provider must not await real timers; `send` is async-dispatched via `setTimeout(0)` in the prototype — here dispatch **synchronously inside `send`** (`await handle(input)`), keeping tests deterministic.)

- [ ] **Step 2: Failing tests** `test/unit/session.test.ts` (uses harness; each case listed with its assertion):

```ts
import { describe, expect, it } from "vitest";
import { connect, open, prompt, turnStates } from "../helpers/harness";

const S = (scenarios: any, macros?: any) => () => ({ scenarios, macros });

describe("provider protocol", () => {
  it("open emits opened then ready; catalog lists scenarios", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "x" }] }) });
    await h.send({ type: "catalog", requestId: "c1" });
    const cat = h.events.find((e) => e.type === "catalog") as any;
    expect(cat.catalog.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["a", "default"]));
    await h.send(open());
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["session.opened", "session.ready"]));
  });
  it("plain turn: prompt_result, started, assistant, completed (in order)", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "hello" }] }) });
    await h.send(open("s1", "a"));
    h.events.length = 0;
    await h.send(prompt("s1", "hi"));
    expect(h.events.map((e) => e.type)).toEqual(["session.prompt_result", "session.turn", "timeline.item", "session.persistence", "session.turn"]);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
  it("SCENARIO: prefix switches scenario and consumes step 0", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "A0" }], b: [{ text: "B0" }, { text: "B1" }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "SCENARIO:b go"));
    await h.send(prompt("s1", "next"));
    const texts = h.events.filter((e: any) => e.type === "timeline.item").map((e: any) => e.item.text);
    expect(texts).toEqual(["B0", "B1"]);
  });
  it("model on open selects the starting scenario; unknown model falls back to default", async () => {
    const h = await connect({ getScript: S({ default: [{ text: "D" }] }) });
    await h.send(open("s1", "nope"));
    await h.send(prompt("s1", "x"));
    expect((h.events.find((e: any) => e.type === "timeline.item") as any).item.text).toBe("D");
  });
  it("chunks stream as growing snapshots with one id; delays honour the clock", async () => {
    const h = await connect({ getScript: S({ a: [{ chunks: ["a", "b"], chunkDelayMs: 100 }] }) });
    await h.send(open("s1", "a"));
    await h.send(prompt("s1", "x"));
    expect(h.events.filter((e) => e.type === "timeline.item")).toHaveLength(1);
    await h.clock.advance(100);
    const items = h.events.filter((e: any) => e.type === "timeline.item") as any[];
    expect(items.map((i) => i.item.text)).toEqual(["a", "ab"]);
    expect(items[0].item.id).toBe(items[1].item.id);
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
  it("outcome failed / canceled produce the matching terminal state", async () => {
    const h = await connect({ getScript: S({ f: [{ outcome: "failed", error: "bad" }], c: [{ outcome: "canceled" }] }) });
    await h.send(open("s1", "f")); await h.send(prompt("s1", "x"));
    await h.send(open("s2", "c")); await h.send(prompt("s2", "x"));
    expect(turnStates(h.events)).toEqual(["started", "failed", "started", "canceled"]);
  });
  it("hang ends only on interrupt; double interrupt yields ONE terminal event", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "p", outcome: "hang" }] }) });
    await h.send(open("s1", "a")); await h.send(prompt("s1", "x"));
    expect(turnStates(h.events)).toEqual(["started"]);
    await h.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    await h.send({ type: "session.interrupt", requestId: "i2", sessionId: "s1" });
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
    expect(h.events.filter((e: any) => e.type === "request.completed").length).toBeGreaterThanOrEqual(2);
  });
  it("interrupt during a delay cancels immediately and suppresses later items", async () => {
    const h = await connect({ getScript: S({ a: [{ startDelayMs: 1000, text: "late" }] }) });
    await h.send(open("s1", "a")); await h.send(prompt("s1", "x"));
    await h.send({ type: "session.interrupt", requestId: "i", sessionId: "s1" });
    await h.clock.advance(5000);
    expect(h.events.filter((e) => e.type === "timeline.item")).toHaveLength(0);
    expect(turnStates(h.events)).toEqual(["started", "canceled"]);
  });
  it("a new prompt supersedes an active turn (old one canceled, exactly once)", async () => {
    const h = await connect({ getScript: S({ a: [{ outcome: "hang" }, { text: "second" }] }) });
    await h.send(open("s1", "a")); await h.send(prompt("s1", "one")); await h.send(prompt("s1", "two"));
    expect(turnStates(h.events)).toEqual(["started", "canceled", "started", "completed"]);
  });
  it("strict alignment fails the prompt on mismatch; warn proceeds; both record", async () => {
    const rec: any[] = [];
    const recorder = () => ({ record: (k: string, d: any) => rec.push({ k, ...d }) });
    const script = S({ a: [{ expect: "hello", text: "ok" }] });
    const strict = await connect({ getScript: script, getConfig: () => ({ alignment: "strict" }), recorder });
    await strict.send(open("s1", "a")); await strict.send(prompt("s1", "WRONG"));
    expect(strict.events.find((e: any) => e.type === "session.prompt_result")).toMatchObject({ result: { type: "failed", error: { code: "E_SCRIPT_MISMATCH" } } });
    const warn = await connect({ getScript: script, recorder });
    await warn.send(open("s1", "a")); await warn.send(prompt("s1", "WRONG"));
    expect(turnStates(warn.events)).toEqual(["started", "completed"]);
    expect(rec.filter((r) => r.k === "mismatch")).toHaveLength(2);
  });
  it("command and image-only prompts are answered, not thrown", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "ok" }] }) });
    await h.send(open("s1", "a"));
    await h.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "command", name: "go", arguments: "now" } } });
    await h.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c2", delivery: "auto", input: { type: "message", content: [{ type: "image", data: "AA", mimeType: "image/png" }] } } });
    expect(turnStates(h.events)).toEqual(["started", "completed", "started", "completed"]);
  });
  it("unknown session prompt fails the prompt_result", async () => {
    const h = await connect({ getScript: S({}) });
    await h.send(prompt("ghost", "x"));
    expect(h.events[0]).toMatchObject({ type: "session.prompt_result", result: { type: "failed" } });
  });
  it("persistence restores scenario/step and replays transcript", async () => {
    const h = await connect({ getScript: S({ a: [{ text: "1" }, { text: "2" }] }) });
    await h.send(open("s1", "a")); await h.send(prompt("s1", "x"));
    const p = [...h.events].reverse().find((e: any) => e.type === "session.persistence") as any;
    const h2 = await connect({ getScript: S({ a: [{ text: "1" }, { text: "2" }] }) });
    await h2.send({ ...(open("s9") as any), persistence: p.persistence, history: "replay" });
    const replay = h2.events.filter((e: any) => e.type === "timeline.item") as any[];
    expect(replay.map((r) => r.item.text)).toEqual(["x", "1"]);
    await h2.send(prompt("s9", "y"));
    expect((h2.events.filter((e: any) => e.type === "timeline.item").pop() as any).item.text).toBe("2");
  });
  it("tools: running then completed share an id; failed carries error; shell detail passes through", async () => {
    const h = await connect({ getScript: S({ a: [{ tools: [{ name: "Bash", runningMs: 50, detail: { type: "shell", command: "ls", output: "x", exitCode: 0 } }, { name: "Edit", status: "failed", error: "conflict", detail: { type: "edit", filePath: "a.ts" } }] }] }) });
    await h.send(open("s1", "a")); await h.send(prompt("s1", "x")); await h.clock.advance(50);
    const items = h.events.filter((e: any) => e.type === "timeline.item").map((e: any) => e.item);
    expect(items.map((i: any) => `${i.name}:${i.status}`)).toEqual(["Bash:running", "Bash:completed", "Edit:failed"]);
    expect(items[0].id).toBe(items[1].id);
    expect(items[2].error).toBe("conflict");
  });
  it("empty script object still serves the default scenario", async () => {
    const h = await connect({ getScript: S({}) });
    await h.send(open("s1")); await h.send(prompt("s1", "x"));
    expect(turnStates(h.events)).toEqual(["started", "completed"]);
  });
});
```

- [ ] **Step 3:** Run → FAIL (modules missing).

- [ ] **Step 4: Implement `src/session.ts`.**

```ts
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { Clock, NewId } from "./clock";
import { planReply, type Action } from "./planner";
import type { Recorder } from "./recorder";
import { resolveReply } from "./script";
import type { Script } from "./schema";

export interface Persisted {
  logicalId: string; scenario: string | null; step: number;
  transcript: { id: string; type: "user_message" | "assistant_message"; text: string }[];
}
export interface SessionDeps {
  sessionId: string; script: () => Script; clock: Clock; newId: NewId; recorder: Recorder;
  alignment: "warn" | "strict" | "ignore"; emit: (e: ProviderEvent) => void;
  persisted?: Persisted; initialScenario?: string;
}

export function promptText(p: ProviderPrompt): string {
  if (p.input.type === "command") return `/${p.input.name} ${p.input.arguments}`;
  return p.input.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
}

export class ScriptedSession {
  private scenario: string | null;
  private step: number;
  private logicalId: string;
  private transcript: Persisted["transcript"];
  private turn: { id: string; abort: () => void; aborted: Promise<void> } | null = null;
  constructor(private d: SessionDeps) {
    this.scenario = d.persisted?.scenario ?? d.initialScenario ?? null;
    this.step = d.persisted?.step ?? 0;
    this.logicalId = d.persisted?.logicalId ?? d.sessionId;
    this.transcript = [...(d.persisted?.transcript ?? [])];
  }
  get activeTurn() { return this.turn?.id ?? null; }
  persistence(): Persisted {
    return { logicalId: this.logicalId, scenario: this.scenario, step: this.step, transcript: this.transcript };
  }
  replay() { return this.transcript; }

  prompt(p: ProviderPrompt): void {
    const { emit, recorder } = this.d;
    const sid = this.d.sessionId;
    const text = promptText(p);
    const m = /^SCENARIO:([\w-]+)/.exec(text.trim());
    if (m) { this.scenario = m[1]; this.step = 0; }
    const step = this.step;
    const { reply } = resolveReply(this.d.script(), this.scenario ?? "default", step);
    const arrival = this.activeTurn;
    recorder.record("prompt", {
      sessionId: this.logicalId, providerSessionId: sid, scenario: this.scenario, step,
      delivery: p.delivery, clientMessageId: p.clientMessageId, activeTurnAtArrival: arrival, text,
      contentTypes: p.input.type === "message" ? p.input.content.map((c) => c.type) : ["command"],
    });
    if (reply.expect !== undefined && reply.expect.trim() !== text.trim()) {
      recorder.record("mismatch", { sessionId: this.logicalId, step, expected: reply.expect, actual: text, mode: this.d.alignment });
      if (this.d.alignment === "strict") {
        emit({ type: "session.prompt_result", sessionId: sid, clientMessageId: p.clientMessageId,
          result: { type: "failed", error: { message: `Script mismatch at step ${step}: expected ${JSON.stringify(reply.expect)}`, code: "E_SCRIPT_MISMATCH" } } });
        return;
      }
    }
    this.step++;
    this.transcript.push({ id: p.clientMessageId, type: "user_message", text });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "superseded by new prompt");
    const id = this.d.newId();
    let abort!: () => void;
    const aborted = new Promise<void>((r) => (abort = r));
    this.turn = { id, abort, aborted };
    emit({ type: "session.prompt_result", sessionId: sid, clientMessageId: p.clientMessageId, result: { type: "turn", turnId: id } });
    emit({ type: "session.turn", sessionId: sid, turnId: id, state: "started" });
    void this.run(id, planReply(reply, this.d.newId)).catch((e) => console.error("[scripted-provider] turn failed", e));
  }

  interrupt(requestId: string): void {
    this.d.recorder.record("interrupt", { sessionId: this.logicalId, activeTurn: this.activeTurn });
    if (this.turn) this.endTurn(this.turn.id, "canceled", "interrupted");
    this.d.emit({ type: "request.completed", requestId });
  }

  private endTurn(turnId: string, state: "completed" | "failed" | "canceled", message?: string, code?: string) {
    if (this.turn?.id !== turnId) return; // already ended: exactly one terminal event per turn
    const t = this.turn;
    this.turn = null;
    t.abort();
    this.d.emit({ type: "session.persistence", sessionId: this.d.sessionId, persistence: { version: 1, data: this.persistence() as any } });
    this.d.emit({ type: "session.turn", sessionId: this.d.sessionId, turnId, state, ...(message ? { error: { message, ...(code ? { code } : {}) } } : {}) });
  }

  private async run(turnId: string, actions: Action[]) {
    const keys = new Map<string, string>();
    const idFor = (k: string) => { let v = keys.get(k); if (!v) keys.set(k, (v = this.d.newId())); return v; };
    const live = () => this.turn?.id === turnId;
    let finalText: string | undefined;
    for (const a of actions) {
      if (!live()) return;
      const emitItem = (item: any) => this.d.emit({ type: "timeline.item", sessionId: this.d.sessionId, item, timestamp: new Date(this.d.clock.now()).toISOString() });
      switch (a.t) {
        case "sleep":
          await Promise.race([this.d.clock.sleep(a.ms), this.turn!.aborted]);
          break;
        case "reasoning":
          emitItem({ id: idFor(a.key), type: "reasoning", text: a.text });
          break;
        case "assistant": {
          const id = idFor(a.key);
          emitItem({ id, type: "assistant_message", text: a.text, messageId: id });
          finalText = (finalText ?? "") + (keys.size && a.text.startsWith(finalText ?? "\u0000") ? a.text.slice(finalText?.length ?? 0) : a.text);
          break;
        }
        case "tool": {
          const id = idFor(a.key);
          const base = { id, type: "tool_call", callId: id, name: a.spec.name, detail: a.spec.detail, metadata: undefined };
          emitItem(a.status === "failed"
            ? { ...base, status: "failed", error: a.spec.error ?? "scripted failure" }
            : { ...base, status: a.status, error: null });
          break;
        }
        case "end":
          if (a.outcome === "hang") {
            await this.turn!.aborted;
            return; // endTurn already emitted canceled
          }
          if (finalText !== undefined) this.transcript.push({ id: this.d.newId(), type: "assistant_message", text: finalText });
          this.endTurn(turnId, a.outcome, a.outcome === "failed" ? (a.error ?? "scripted failure") : a.outcome === "canceled" ? (a.error ?? "scripted cancel") : undefined, a.outcome === "failed" ? "E_SCRIPTED" : undefined);
          return;
      }
    }
  }
}
```
**Fix-up required during implementation (the `finalText` line above is too clever):** replace with explicit state: maintain `const lastByKey = new Map<string,string>()` set to `a.text` per assistant key; at `end`, `finalText = [...lastByKey.values()].join("")`. This gives chunk-merge and multi-message concatenation the same semantics as the prototype. Remove the `startsWith` expression. The `metadata: undefined` property must be omitted rather than set (zod strictness) — build `base` without it.

`src/provider.ts`:
```ts
import type { ProviderEvent, ProviderInput, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { realClock, type Clock, type NewId } from "./clock";
import { randomUUID } from "node:crypto";
import { createRecorder, nullRecorder, type Recorder } from "./recorder";
import { scenarioNames } from "./script";
import { ScriptedSession } from "./session";
import type { ResolvedConfig } from "./config";
import type { Script } from "./schema";

export interface ProviderDeps {
  getScript(): Script;
  getConfig(): ResolvedConfig;
  clock?: Clock; newId?: NewId;
  recorder?(file?: string): Recorder;
}

export function createScriptedProvider(deps: ProviderDeps): ProviderRegistration {
  const clock = deps.clock ?? realClock;
  const newId = deps.newId ?? randomUUID;
  const mkRecorder = deps.recorder ?? ((f?: string) => (f ? createRecorder(f) : nullRecorder));
  return {
    id: "scripted",
    label: "Scripted",
    description: "Replies from a script instead of a model (testing and demos).",
    async connect() {
      const listeners = new Set<(e: ProviderEvent) => void>();
      const emit = (e: ProviderEvent) => { for (const l of listeners) l(e); };
      const sessions = new Map<string, ScriptedSession>();

      function handle(input: ProviderInput) {
        const cfg = deps.getConfig();
        const recorder = mkRecorder(cfg.recordFile);
        switch (input.type) {
          case "catalog": {
            const names = scenarioNames(deps.getScript());
            const all = Array.from(new Set(["default", ...names]));
            emit({ type: "catalog", requestId: input.requestId, catalog: {
              models: all.map((id) => ({ id, label: id, isDefault: id === "default" })), modes: [], defaultModel: "default" } });
            return;
          }
          case "sessions":
            emit({ type: "sessions", requestId: input.requestId, sessions: [] });
            return;
          case "session.open": {
            const restored = (input.persistence?.data ?? null) as any;
            const s = new ScriptedSession({
              sessionId: input.sessionId, script: deps.getScript, clock, newId, recorder, alignment: cfg.alignment, emit,
              persisted: restored ?? undefined, initialScenario: input.config.model ?? undefined,
            });
            sessions.set(input.sessionId, s);
            recorder.record("open", { sessionId: restored?.logicalId ?? input.sessionId, providerSessionId: input.sessionId, restored: !!restored, history: input.history, model: input.config.model ?? null });
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
              capabilities: ["prompt.message", "session.persistence"], restoration: "core", cwd: input.config.cwd,
              persistence: { version: 1, data: s.persistence() as any } });
            if (input.history === "replay") {
              for (const t of s.replay()) emit({ type: "timeline.item", sessionId: input.sessionId, item: { id: t.id, type: t.type, text: t.text, messageId: t.id } });
            }
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          case "session.prompt": {
            const s = sessions.get(input.sessionId);
            if (!s) {
              emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message: "unknown session" } } });
              return;
            }
            s.prompt(input.prompt);
            return;
          }
          case "session.interrupt":
            sessions.get(input.sessionId)?.interrupt(input.requestId) ?? emit({ type: "request.completed", requestId: input.requestId });
            return;
          case "session.close":
            sessions.delete(input.sessionId);
            emit({ type: "request.completed", requestId: input.requestId });
            emit({ type: "session.closed", sessionId: input.sessionId });
            return;
          default:
            if ("requestId" in input && input.requestId) emit({ type: "request.completed", requestId: input.requestId });
        }
      }

      return {
        version: 1,
        capabilities: ["prompt.message", "session.persistence"],
        async send(input) {
          try { handle(input); } catch (error) {
            console.error("[scripted-provider] handle failed", error);
            if ("requestId" in input && input.requestId) emit({ type: "request.failed", requestId: input.requestId, error: { message: String(error) } });
          }
        },
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async close() { listeners.clear(); sessions.clear(); },
      };
    },
  };
}
```
Note: the interrupt `?.`/`??` expression is evaluated for side effects — rewrite as an explicit `if` during implementation.

- [ ] **Step 5:** `npx vitest run test/unit/session.test.ts` → iterate until PASS (the harness validates every event against the SDK schema, so schema mismatches surface here). Fix code, not tests, unless a test is demonstrably wrong against the SDK.
- [ ] **Step 6:** `npm run typecheck`; **Step 7: Commit** `feat: scripted session engine and provider`.

---

### Task 6: Server glue, settings, validation fallback

**Files:** Create `shared/rpc.ts`, `index.server.ts`; Test `test/integration/server-glue.test.ts`

**Interfaces:** Produces
```ts
// shared/rpc.ts
export const scriptedSettings: SettingsDefinition<...>  // id "scripted-provider", scope "host", version 1; schema {scripts:string="", scriptFile:string="", recordFile:string="", alignment:"warn"|"strict"|"ignore"="warn"}
export const getStatusRpc    // name "scripted.status": in {} -> out { scenarios: string[], error: string|null, recordFile: string|null }
export const readRecordRpc   // name "scripted.readRecord": in { limit?: number } -> out { lines: string[] }
export const captureRpc      // name "scripted.capture": in { agentId: string } -> out { entries: unknown[], agent: { id, cwd, title, provider, model } | null }
// index.server.ts
export default function contribute(server: PluginServerContext): () => void
export function buildScript(cfg: ResolvedConfig, builtins: Script, read?): { script: Script; error: string | null }
```
`buildScript`: loads `loadScriptText`; parse; on invalid → `{script: BUILTIN_SCRIPT, error}`; on valid → `mergeScripts(BUILTIN_SCRIPT, parsed)`. No text → builtins, error null. Server caches settings via `settings.subscribe`, re-reads the script file on each `connect`/`catalog`/`open` call through `getScript()` (cheap; guarded by try/catch) so editing the file takes effect without restart.

- [ ] **Step 1: Failing tests** `test/integration/server-glue.test.ts`: `buildScript` with (a) nothing → builtins only, no error; (b) valid inline script → user scenario + builtins; (c) invalid JSON → builtins + non-null error; (d) user redefines `chat` → user wins; (e) script of 10k replies parses and resolves step 9999 quickly (< 500 ms). A fake `PluginServerContext` (`registerSettings` returning `{read: async()=>({status:"ready",revision:"1",values:{...}}), subscribe: ()=>()=>{}}`, `registerProvider` capturing, `handle` capturing) asserts `contribute()` registers provider `scripted`, registers settings id `scripted-provider`, registers the three RPC handlers, and returns a cleanup function.
- [ ] **Step 2:** FAIL. **Step 3: Implement** (`shared/rpc.ts` with `defineSettings`/`defineRpc` from `@getpaseo/plugin` — runtime import of the SDK is acceptable here because the daemon resolves it for plugins, as `wukong-export-session/index.server.ts` does; `index.server.ts` composes `createScriptedProvider`, `resolveConfig(values, process.env)`, handlers: status (reports `buildScript(...).error` and scenario names), readRecord (reads last N lines of `recordFile`, `[]` if none), capture (`paseo.agents.ref(agentId).timeline.refetch({direction:"tail", limit:0})` → `{entries, agent subset}`; mirrors `wukong-export-session/server/export.ts`)).
- [ ] **Step 4:** PASS + typecheck. **Step 5: Commit** `feat: server glue, settings, status/record/capture RPCs`.

---

### Task 7: Capture — timeline to script (converter)

**Files:** Create `src/capture/convert.ts`; Test `test/unit/convert.test.ts`

**Interfaces:** Produces
```ts
export interface TimelineEntry { item: { type: string; [k: string]: unknown }; timestamp?: string; }
export interface ConvertOptions {
  name: string;
  lastTurns?: number;                       // undefined = all
  delay: { mode: "keep" } | { mode: "scale"; factor: number } | { mode: "drop" };
  includeReasoning: boolean;
  includeToolOutput: boolean;
  truncateAt?: number;                      // chars, applied to text/output strings; adds "…[truncated]"
}
export function convertTimeline(entries: readonly TimelineEntry[], o: ConvertOptions): Script;
```
Rules: a *turn* = a `user_message` followed by everything until the next `user_message`. Each turn → one `Reply`: `expect` = user text; assistant messages with the same `id`/`messageId` collapse to the last snapshot; one message → `text`, several → `messages`; `reasoning` → joined into `reasoning` only when `includeReasoning`; each `tool_call` → `tools[]` (keep latest status per `callId`; when `!includeToolOutput`, drop `output`/`content`/`result`/`log` fields from `detail`); an `error` item → `outcome:"failed", error:message`; `startDelayMs` = timestamp(first non-user item) − timestamp(user item), shaped by `delay` (≥0, rounded, omitted when 0 or timestamps missing). Entries before the first `user_message` are ignored. Known limitation (documented in README): within a turn, tools are emitted before messages.

- [ ] **Step 1: Tests** (write all): empty entries → `{scenarios:{[name]:[]}}`; two turns → two replies with `expect`; snapshot collapse (same id twice → last text); two distinct messages → `messages`; tool_call running+completed same callId → one tool, completed; `includeToolOutput:false` strips `output`; `includeReasoning` on/off; error item → failed; `lastTurns:1`; delay modes keep/scale(0.1)/drop with timestamps 2s apart (→ 2000/200/absent); missing timestamps → no delay field, no throw; unknown item types ignored; a trailing user message with no reply → reply `{expect}` only; `truncateAt:5` truncates long text with marker.
- [ ] **Step 2:** FAIL. **Step 3: Implement** (single pass grouping into turns, then map; all functions pure, ≤ 120 lines).
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat: timeline-to-script converter`.

---

### Task 8: Capture — redaction

**Files:** Create `src/capture/redact.ts`; Test `test/unit/redact.test.ts`

**Interfaces:** Produces
```ts
export interface Rule { id: string; kind: "secret"|"email"|"path"|"literal"|"regex"; pattern: RegExp; label: string }
export const DEFAULT_RULES: Rule[];   // AWS AKIA, GitHub ghp_/gho_/ghs_/github_pat_, sk-…, Slack xox[baprs]-, JWT, PEM private key block, "Bearer <token>", URL password (://user:pass@), email, /Users/<x> /home/<x> C:\Users\<x>
export interface Finding { id: string; ruleId: string; original: string; placeholder: string; restored: boolean }
export class Redactor {
  constructor(rules?: Rule[], ctx?: { cwd?: string });
  addLiteral(value: string, label?: string): void;   // user "redact selection"
  setRestored(original: string, restored: boolean): void;
  apply(text: string): string;                       // with current restored flags
  segments(text: string): { text: string; finding?: Finding }[];   // for highlighting
  findings(): Finding[];                             // stable order of first appearance
  applyDeep<T>(value: T): T;                         // maps every string in JSON-like structure
  suspicious(text: string): string[];                // high-entropy tokens not matched by rules (≥24 chars, entropy ≥ 3.5); highlight only
}
```
Rules for correctness: scan with all rules, collect matches, resolve overlaps by earliest start then longest; the same original value always maps to the same placeholder (`{{secret_1}}`, `{{email_1}}`, `{{user_1}}`...; cwd → `{{cwd}}`; home-dir paths replace only the username segment: `/Users/{{user_1}}`); a restored value stays in text verbatim; literals are matched longest-first so a literal that is a substring of another does not corrupt the longer one.

Note on scope: the spec defers entropy *auto-replace*; `suspicious()` only highlights (no replace) and is shown in the review stats as "items to confirm". This is the minimum needed for the spec's "suspicious items must be confirmed before export" gate; entropy never alters text.

- [ ] **Step 1: Tests** (write all): each default rule on a representative sample (use obviously fake tokens, e.g. `AKIAIOSFODNN7EXAMPLE`, `ghp_` + 36 `a`, `sk-` + 40 `b`); consistent placeholder for repeated value; different values → different numbers; overlapping (URL with user:pass and email) deterministic and not corrupted; `{{cwd}}` replacement incl. trailing path; restore flag round-trips; `addLiteral` substring-of-longer case; `applyDeep` on nested object/array leaves non-strings untouched; `segments` concatenation equals `apply` output when no restores and equals original text when all restored; PEM multi-line block; no secret from the fixture corpus survives `apply` (loop over fixtures, `expect(out).not.toContain(secret)`); `suspicious` flags a 32-char random token, ignores a UUID and sha1 hex.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS. **Step 5: Commit** `feat: redaction engine with consistent placeholders`.

---

### Task 9: Capture — export and replay helper

**Files:** Create `src/capture/export.ts`; Test `test/unit/export.test.ts`

**Interfaces:** Produces
```ts
export function serializeScript(script: Script): string;               // 2-space JSON + trailing newline
export function scriptFilename(name: string, now?: Date): string;      // "<safe-name>-YYYYMMDD-HHMMSS.scripted.json"
export function addScenarioToSettings(existingText: string, name: string, script: Script): { ok: true; text: string } | { ok: false; error: string };
export function uniqueScenarioName(existing: string[], name: string): string;   // name, name-2, name-3 ...
```
`addScenarioToSettings` merges the recorded scenarios (and macros) into the user's inline script text (parsing it with `parseScript`; empty text allowed; invalid existing text → `ok:false` without overwriting).
- [ ] Steps: tests (round-trip through `parseScript`; filename sanitising `"my chat/../x"` → `my-chat-x-…`; unique naming; invalid existing text rejected; empty existing text ok) → FAIL → implement → PASS → commit `feat: script export helpers`.

---

### Task 10: Client — settings page, slash commands, recording UI

**Files:** Create `index.client.tsx`, `client/settings.tsx`, `client/record-button.tsx`, `client/record-modal.tsx`, `client/review.tsx`, `client/web.ts`, `client/state.ts`; Test `test/unit/client-state.test.ts`

**Interfaces:** Consumes `scriptedSettings`, `getStatusRpc`, `readRecordRpc`, `captureRpc`, `convertTimeline`, `Redactor`, `serializeScript`, `addScenarioToSettings`. Produces the user-facing UI.

Keep logic out of components: `client/state.ts` holds a pure reducer/model so it can be unit-tested without React Native:
```ts
export interface ReviewModel {
  name: string; options: ConvertOptions;
  script: Script;                 // converted, unredacted
  redactor: Redactor;
  confirmedSuspicious: Set<string>;
}
export function buildReview(entries, options, ctx): ReviewModel;
export function stepsView(m: ReviewModel): { index: number; segments: Segment[]; suspicious: string[] }[];
export function stats(m: ReviewModel): { autoReplaced: number; suspicious: number; unconfirmed: number };
export function canExport(m: ReviewModel): boolean;            // unconfirmed === 0
export function exportText(m: ReviewModel): string;            // redactor.applyDeep(script) -> serializeScript
export function editStep(m: ReviewModel, index: number, field: "text"|"expect", value: string): ReviewModel;
```
- [ ] **Step 1: Tests for `client/state.ts`**: stats counts; `canExport` false until each suspicious token confirmed; `exportText` has no seeded secret and passes `parseScript`; toggling restore on a finding changes export; `editStep` replaces step text and survives re-redaction; "always replace this value" (`addLiteral`) applies to every step.
- [ ] **Step 2:** FAIL. **Step 3: Implement state.ts.** **Step 4:** PASS.
- [ ] **Step 5: Components** (thin; typecheck is their gate):
  - `client/web.ts`: copy of export-session's `canDownload`/`downloadFile(filename, text, mime)` pattern (Platform.OS === "web" only).
  - `client/settings.tsx`: `addSettingsScreen` content using `useSettings(scriptedSettings)` and `useRpc`; fields: script editor (`SettingsInput`, multi-line via `TextInput` from `@getpaseo/plugin/client/react-native`), script file path, record file path, alignment select; shows `scripted.status` (scenario list, validation error) and "Received messages" (last 50 lines from `scripted.readRecord`, with Refresh).
  - `client/record-button.tsx`: `addHeaderButton` for each agent (mirror `wukong-export-session/client/pills.ts` observation loop, but via `client.addHeaderButton({id:"scripted-record", workspaceId, button:{title:"Record this session as a script", icon:"Clapperboard", behavior:{kind:"popover", Content: RecordModal-launcher}}})`). Because header-button popover content is `ComponentType<PluginButtonContentProps>`, `Content` renders `<Modal title="Record as script" open onOpenChange={(o)=>!o&&close()}>…</Modal>` with the setup form (name, range last N, delay mode + factor, include reasoning, include tool output, truncate length), a "Preview" action (calls `captureRpc`, `buildReview`), then the review list (`review.tsx`): per step shows redacted segments (highlight style from `theme`), tap highlight → `setRestored`, "Edit" → `TextInput`, "Redact selection" via `onSelectionChange` + "always replace" switch, stats header, disclaimer banner, and Export buttons: web → `downloadFile`; non-web → `copyText`. "Replay": `addScenarioToSettings` + `settings.save`, then `client.paseo.agents.create({ cwd, config:{ provider:`scripted/${name}` }, title:`Replay: ${name}` })` (provider/model format per `PaseoAgentConfig`), with a toast on result; if `create` rejects show the error and keep the saved scenario.
  - `index.client.tsx`: registers settings screen, header buttons, and slash commands (agent context): `/scripted next` → `agent.send("NEXT")` hmm — see below; `/scripted reset [name]` → send `SCENARIO:<name|current model>`.
  Slash-command semantics: both are conveniences over the normal prompt path (`paseo.agents.ref(id).send(text)`); `next` sends the text `(next)`, `reset` sends `SCENARIO:<arg || agent.model || "default">`. README documents this.
- [ ] **Step 6:** `npm run typecheck && npx vitest run` → PASS. **Step 7: Commit** `feat: client settings page, record-as-script UI, slash commands`.

---

### Task 11: Testkit and real-daemon e2e

**Files:** Create `testkit/package.json`, `testkit/index.mjs`, `testkit/daemon.mjs`, `e2e/scripted.e2e.test.mjs`, `e2e/package.json` (devDependencies: `@getpaseo/cli@0.11.4`, `tree-kill`), `README` section later.

**Interfaces:** Produces (ESM, no shell, node-only)
```js
// testkit/daemon.mjs  — adapted from wukong-ui-render/e2e/lib/daemon.mjs (read it first), generalised:
export class Workspace { constructor({keep}); root; paseoHome; fakeHome; state; logs; work; plugins; env(); stagePlugin(srcDir, name, {exclude}); collect(outDir); cleanup(); }
export class Daemon { constructor(ws, {port, enableProviders?: string[]}); writeConfig(); start(label); stop(); restart(label); cli(args, opts); }
export async function freePort();
// testkit/index.mjs
export async function startScriptedEnv({ script, pluginsUnderTest? , enableProviders? }) -> { ws, daemon, cli, readRecord(): object[], waitForTurn(agentId): Promise<...>, stop() }
export function readJsonl(file);
```
Differences from the wukong version: state dir passed via `SCRIPTED_PROVIDER_STATE`; stages this repo's plugin by copying `paseo-plugin.json`, `index.*`, `src/`, `client/`, `shared/` (no node_modules); `config.json` sets `pluginsEnabled: true`, disables built-in providers unless named in `enableProviders`; drops `HOME/USERPROFILE/XDG_*/PASEO_*` env and sets fake ones; `process.execPath <cli> ...`; canonical `realpathSync.native` tmp root.

- [ ] **Step 1:** Write `e2e/scripted.e2e.test.mjs` with `node:test` (generous timeouts, `timeScale` env for CI): start env with script `{scenarios:{greet:[{text:"hello from script"},{text:"second"}], boom:[{outcome:"failed", error:"scripted failure"}], tools:[…tools-demo-like…]}}`; install plugin via `paseo plugin install <dir>` (verify exact CLI syntax with `paseo plugin install --help` first and adjust); create agent `paseo run --provider scripted --model greet ...` (verify syntax with `paseo run --help`); assert reply text via `paseo logs`/`inspect` or JSON output, assert `received.jsonl` contains the prompts in order with `step` 0 and 1; assert failed scenario ends in error status; `SCENARIO:` switch; daemon restart + persisted session continues at step 1. Tests that depend on timing assert outcomes only.
- [ ] **Step 2:** `npm --prefix e2e ci && npm run e2e` → expect first run to expose CLI-syntax assumptions; fix the **tests/testkit** (not the engine) unless a real engine bug appears; if the engine misbehaves in the real daemon, add a failing unit/integration test reproducing it first, then fix (superpowers:systematic-debugging).
- [ ] **Step 3:** run twice more to check flakiness (no fixed sleeps; poll with deadlines).
- [ ] **Step 4: Commit** `test: cross-platform testkit and real-daemon e2e`.

---

### Task 12: CI, security scan, badges, README

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/security.yml`, `scripts/make-badges.mjs`, `README.md` (full); Modify `package.json` scripts (`badges`).

- [ ] **Step 1: ci.yml** — triggers `push` (main), `pull_request`, `workflow_dispatch`; `permissions: contents: read` at top; jobs:
  - `unit`: ubuntu, Node 22, `npm ci`, `npm run typecheck`, `npm run test:coverage` (produces `reports/`), upload artifact `reports` (junit, html, coverage), `$GITHUB_STEP_SUMMARY` gets coverage + test totals via `node scripts/make-badges.mjs --summary`.
  - `e2e`: matrix ubuntu/macos/windows, Node 22, `npm ci`, `npm --prefix e2e ci`, `node --test e2e/`, upload e2e logs on failure.
  - `badges` (needs `unit`,`e2e`, only on `push` to `main`): `permissions: contents: write`; downloads `reports`, runs `node scripts/make-badges.mjs --out badges/` to write shields endpoint JSON (`{schemaVersion:1,label,message,color}`) `tests.json`, `coverage.json`, then force-pushes `badges/` contents to orphan branch `badges` using `GITHUB_TOKEN`.
- [ ] **Step 2: security.yml** — triggers push main, PR, weekly cron; `snyk/actions/setup@master`; `snyk test --severity-threshold=high --json-file-output=snyk.json || true` followed by a gate step that fails on high/critical; `snyk code test` (SAST) non-blocking with SARIF upload; on main also `snyk monitor`; job step writes `badges/snyk.json` (vulnerability count → color) and pushes to the `badges` branch as above. Guard every Snyk step with `if: env.SNYK_TOKEN != ''` so forks and the pre-secret period don't fail; use `env: SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}`.
- [ ] **Step 3: `scripts/make-badges.mjs`** (plain Node, tested by `test/unit/badges.test.ts`): reads `reports/coverage/coverage-summary.json` and `reports/junit.xml`, emits endpoint JSON; unit test feeds fixture summaries and checks message/color thresholds (≥90 brightgreen, ≥80 green, ≥70 yellow, else red).
- [ ] **Step 4: README** — top banner (before the title text) with badges:
```md
[![CI](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/quickwind/paseo-scripted-provider/badges/tests.json)](…/actions)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/quickwind/paseo-scripted-provider/badges/coverage.json)](…/actions)
[![Snyk](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/quickwind/paseo-scripted-provider/badges/snyk.json)](https://snyk.io/test/github/quickwind/paseo-scripted-provider)
[![license](https://img.shields.io/github/license/quickwind/paseo-scripted-provider)](LICENSE)
[![paseo](https://img.shields.io/badge/paseo-%3E%3D0.11.0%20%3C0.12-blue)](#compatibility)
```
  Sections: what/why, install (`paseo plugin install`, note `pluginsEnabled: true` requirement), quick start, script reference (every field with example), built-in scenarios, recording a session (steps, redaction guarantees and limits, known limitation: tools precede messages), received-messages log, testkit usage, compatibility table and protocol-stability caveat, roadmap, contributing/dev (`npm test`, `npm run e2e`, `npm run verify:real`), license.
- [ ] **Step 5:** `npm run typecheck && npm test` PASS; validate workflow YAML parses (`node -e` with a YAML check via `npx --yes yaml-lint .github/workflows/*.yml` or `actionlint` if installed). **Step 6: Commit** `ci: workflows, badges, security scan, README`.

---

### Task 13: Real verification with opencode and devin

**Files:** Create `scripts/verify-real.mjs`; output `reports/real-verify.md` (git-ignored; summary pasted into the PR/hand-off, not committed)

Uses the testkit with `enableProviders: ["opencode","devin"]`. Before anything else, **pre-flight** (writes findings to the report; stop and tell the user if a precondition fails):
1. Isolated daemon on a free port (assert it is not 6767), temp `--home`, fake HOME. Note: real opencode/devin need their auth; the fake HOME hides it. Carry over only the minimal auth by symlinking/copying provider credential dirs read-only **only if** required (`~/.local/share/opencode/auth.json`, devin's config dir — discover with `devin --help`/docs); never copy into the repo; delete the temp copy at cleanup. If the user's credentials can't be made available safely, ask the user before proceeding.
2. `paseo provider ls` / `list_models` shows `opencode/deepseek-v4.1-flash-free` and devin `swe-1-6-slow`; if a model id differs, pick the closest free model and record the substitution.

Checks (each prints PASS/FAIL + evidence into the report):
- A. **Recording from a real opencode session**: create agent (opencode / `deepseek-v4.1-flash-free`) in a temp git dir; prompt: create `notes.txt` containing the seeded fake secret `ghp_` + 36 `a`, an email `qa@example.com`, and mention the temp dir path; wait for finish. Fetch timeline via the same code path as the UI (`captureRpc` handler through the Paseo client), `convertTimeline` → `Redactor` → `exportText`.
- B. Same for devin (`swe-1-6-slow`).
- C. For A and B: exported script `parseScript` OK; **no seeded secret/email/home path/cwd remains**; placeholders consistent; add the script via `addScenarioToSettings`; replay on a Scripted agent with `alignment: strict` by re-sending the original user messages → every turn completes, `received.jsonl` shows steps in order and zero `mismatch`.
- D. (bonus) real agent talks to a Scripted agent via `paseo` CLI and reports the scripted reply verbatim.
- E. **UI check**: if the isolated daemon exposes its web UI over HTTP (check `daemon.log` / `paseo daemon status`), open it with the Paseo browser tools (`mcp__paseo__browser_*`), open an agent, click the "Record this session as a script" header button, step through the modal, screenshot to `reports/`. If the UI is not reachable, mark E "NOT VERIFIED (no web UI)" and say so in the hand-off — do not claim it works.
- Cleanup always runs (stop daemon, remove temp dirs, kill process tree).

- [ ] Steps: write script → run `npm run verify:real` → diagnose failures with superpowers:systematic-debugging, fixing engine/converter via tests-first → re-run to green or document honest blockers → save report.
- [ ] Commit script only: `test: local real-provider verification script`.

---

### Task 14: Final verification and hand-off for acceptance

- [ ] **Step 1:** Fresh clone-style check: `git status` clean; `rm -rf node_modules reports && npm ci && npm run typecheck && npm run test:coverage && npm run e2e` all pass; coverage ≥ 85%; `git ls-files | grep -c scratch` = 0.
- [ ] **Step 2:** `snyk test` locally (already authenticated) and `snyk code test` — record results; fix or report high/critical findings.
- [ ] **Step 3:** Request a whole-branch review (superpowers:requesting-code-review) and fix findings.
- [ ] **Step 4:** superpowers:verification-before-completion: re-run everything and quote real output in the hand-off.
- [ ] **Step 5:** Report to the user: what passed, what was not verified (UI if applicable), substituted model ids, deviations from spec, and the exact post-approval procedure:
  1. (ask user, then) `gh repo create quickwind/paseo-scripted-provider --public --source=. --remote=origin` (no push yet);
  2. `git checkout --orphan main && git commit` from the branch tree as ONE commit (message `feat: paseo-scripted-provider v0.1.0` + trailer), or equivalent squash;
  3. `git push -u origin main`; delete `feat/v0.1` locally;
  4. (ask user first) `gh secret set SNYK_TOKEN` from the local authenticated Snyk token, trigger workflows, confirm badges render, report URLs.
  **Do none of 1–4 before the user says approved.**

---

## Self-Review (done)

- **Spec coverage:** script engine/fields/macros/outcomes → T2,3,5; layer‑1 tools → T3,5; SCENARIO + model selection → T5; JSONL recorder + mismatch/alignment → T4,5; persistence/replay → T5; settings + env override → T4,6; client settings/slash → T10; built-ins → T2; testkit → T11; recording button/modal/convert/redact/review/export/replay → T7–10; CI matrix/reports/coverage → T12; Snyk + badges + README banner → T12; real opencode/devin verification → T13; branch/squash/push/delete procedure → T14. YAML intentionally absent (spec open item 1: JSON only in v0.1).
- **Placeholders:** Tasks 6–12 give interfaces, rules and test lists rather than full code for glue/UI/CI; their exact code is bounded by the typed interfaces above and verified by the listed tests/typecheck. Tasks 2–5 contain full code. Known inline fix-ups are called out explicitly in Task 5.
- **Type consistency:** `Reply`/`ToolSpec`/`Script` (T2) are consumed unchanged in T3, T5, T7, T9; `Action` (T3) is consumed by T5; `ResolvedConfig` (T4) by T5/T6; `Redactor`/`ConvertOptions` (T7/T8) by T10/T13.
