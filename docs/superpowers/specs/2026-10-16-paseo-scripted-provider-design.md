# paseo-scripted-provider — v0.1 Design

Status: draft for review · Date: 2026-10-16 · Source: `scratch/paseo-scripted-provider-proposal.md`

## 1. Purpose

A Paseo plugin that registers an agent backend ("provider") named **Scripted**. It calls no model; it replies from a script. Uses:

1. **Manual testing** — plugin authors see their UI react to exact agent output (errors, long turns, chunked streams, failures, cancels).
2. **Deterministic CI e2e** — a real isolated Paseo daemon + this plugin + the plugin under test; assert on a JSONL record of what the agent received.

Prototype reference (read-only): `wukong-ui-render/e2e/plugins/irix-e2e-fake/index.server.ts` (~360 lines). v0.1 is a clean rewrite: typed, modular, unit-testable, no hardcoded paths.

## 2. Scope

**In v0.1**
- Script engine: JSON scripts, `macros` (`@NAME`), per-reply fields `text`, `chunks`+`chunkDelayMs`, `messages`+`toolBetween`, `startDelayMs`, `delayMs`, `outcome` (`completed|failed|canceled|hang`).
- Layer‑1 tools: a reply may carry `tools[]` (shell/read/edit/write/search/fetch/plain_text `detail`, status `running|completed|failed|canceled`, `runningMs`, `error`). Display-only; nothing executes.
- Scenario selection: model id = scenario name; `SCENARIO:<name>` as message prefix switches mid-chat. Last reply repeats when the script runs out.
- JSONL recorder: prompts (text, delivery, active-turn-at-arrival, step), interrupts, opens, optional turn probe events.
- Persistence/restore (`session.persistence`, `history: replay`).
- Settings (host scope, zod-validated): inline scripts / script file path, record file path. Env override `SCRIPTED_PROVIDER_STATE` for headless/CI use.
- Client: settings page (edit/paste script, validate, view received-messages log), `/scripted next` and `/scripted reset`.
- Built-in example scenarios: `chat`, `long-output`, `fail`, `cancel`, `slow-stream`, `tools-demo`.
- `testkit/` (separate workspace package `paseo-scripted-provider-testkit`): cross-platform isolated daemon helper (free port, temp home, `pluginsEnabled`, node-only spawning), install plugin, wait for turn end, read/assert records.

- **Record session as script** (proposal "v0.2" recorder, pulled in because real opencode/devin sessions are the primary way to test it):
  - Header button (`addHeaderButton`) opening a `Modal`: script name, range (whole session / last N turns), delay handling (keep / scale ×k / drop), content options (include reasoning, include tool output, truncate long output at N chars).
  - Converter (pure): timeline items → script steps. Turn → step; chunk merge; inter-message gaps → `startDelayMs`; tool calls → layer‑1 `tools`; user message → `expect`; failed/canceled → `outcome`. Replay alignment modes `warn` (default) / `strict` / `ignore`.
  - Regex redaction (gitleaks-style subset: AWS, GitHub, `sk-`, Slack, JWT, PEM, Bearer, URL passwords, emails, home-dir paths, session cwd) with **consistent placeholders** (`{{secret_1}}`, `{{cwd}}`), user-added regex/literal rules.
  - Per-step review: redacted text with highlights, tap highlight to toggle keep/restore, edit step text, select text → "redact selection" (+ "always replace this value"). Header stats ("12 auto-replaced, 3 to confirm"); suspicious items must be confirmed before export. Prominent best-effort disclaimer; nothing is uploaded.
  - Export: web/desktop → `Blob` + `<a download>` (`.json`); mobile → `copyText`. One-click "new Scripted session with this script".

**Out of scope (roadmap)**: permission flows (layer 2), real MCP calls (layer 3), template variables, matching rules, high-entropy detection, "REC mode" capturing permission events, persisted custom-rule library, steer capability. YAML is conditional — see Open Items.

## 3. Architecture

Pure, I/O-free core separated from Paseo glue so most logic is unit-testable:

```
paseo-plugin.json         manifest (id: paseo-scripted-provider, requirements.paseo pinned range)
index.server.ts           glue: registerProvider, settings, hooks wiring only
index.client.tsx          glue: settings page, /scripted commands, record button + modal
client/                   React Native components (review list, modal, highlights)
src/
  schema.ts               zod schemas + types for Script/Reply/Tool (single source of truth)
  script.ts               parse, validate, macro expansion, scenario lookup, step picking
  planner.ts              Reply -> ordered list of Actions (delay | emit item | end turn), pure
  session.ts              per-session state machine (active turn, interrupt, supersede, step, transcript)
  provider.ts             ProviderConnection impl: handles ProviderInput, emits ProviderEvent
  recorder.ts             JSONL appender (injectable fs)
  capture/convert.ts      timeline -> script (pure)
  capture/redact.ts       rules, consistent placeholders, findings list (pure)
  capture/export.ts       serialize + platform export strategy
  config.ts               resolve settings/env -> paths
scenarios/*.json          built-ins
testkit/                  isolated-daemon helpers (node-only, cross-platform)
test/ (unit, integration) e2e/ (real daemon)
```

Key boundaries:
- `planner` turns a reply into a flat action list with no timers; `session` executes it using an injected clock/sleep. Tests run with a fake clock → fast and deterministic.
- `provider` depends on `session` + `recorder` + `config` via interfaces; the integration tests drive it with an in-memory `ProviderConnection` harness (send `ProviderInput`, collect `ProviderEvent`s) and validate every emitted event against the SDK's `ProviderEventSchema`.

### Protocol behavior (from provider.d.ts and prototype findings)
- `session.open` → `session.opened` (capabilities `prompt.message`, `session.persistence`) → optional replay of transcript → `session.ready`.
- `session.prompt` → `prompt_result{turn}` → `turn started` → `timeline.item`* → `turn completed|failed|canceled`.
- `session.interrupt` must end the active turn (`canceled`), including a `hang` turn. A new prompt during an active turn supersedes it (old turn emitted `canceled`).
- `catalog` returns one model per scenario (+ a default). Unknown scenario → built-in `default` reply, never a crash.

## 4. Script format (v0.1, JSON)

```jsonc
{
  "macros": { "BAD_FORM": "```x\n{}\n```" },
  "scenarios": {
    "bad-then-good": [ { "text": "@BAD_FORM" }, { "text": "Fixed" } ],
    "tools": [ { "tools": [{ "name": "Bash", "detail": { "type": "shell", "command": "npm test", "output": "3 passed", "exitCode": 0 }, "runningMs": 800, "status": "completed" }], "text": "Tests pass." } ]
  }
}
```
Invalid scripts fail validation with path-qualified errors (shown in settings page; provider falls back to built-ins and surfaces a `session.notice`).

## 5. Testing & quality

| Layer | Tooling | Runs in |
|---|---|---|
| Unit (schema, script, planner, recorder, session w/ fake clock) | vitest, v8 coverage | CI + local |
| Integration (provider ↔ in-memory harness, SDK event schema validation) | vitest | CI + local |
| E2E (real isolated daemon, installs plugin, drives via CLI/client) | testkit, ubuntu/macos/windows matrix | CI + local |
| Real-provider verification | local script `scripts/verify-real.mjs` | **local only** (needs opencode/devin) |

Reports: JUnit XML + HTML (vitest) + lcov/json-summary coverage. Coverage gate: ≥85% lines for `src/`.

Converter and redaction are pure → heavy unit coverage incl. property-style tests (placeholder consistency, no secret survives in output for a corpus of fixtures).

**Local real verification** (clean Paseo, free port, temp `--home`, fake HOME): enable `opencode` and `devin` providers alongside Scripted. **Primary check — recording**: run real sessions on opencode (`opencode/deepseek-v4.1-flash-free`) and devin (`swe-1-6-slow`) that include tool use and a seeded fake secret/path; export via the converter (and the UI button, driven through the Paseo browser tools against the isolated daemon's web UI where reachable); assert the exported script validates, redacts the seeded secrets, and **replays** on a Scripted agent with `strict` alignment. Also: (a) plugin loads and Scripted coexists with real providers in `list_providers`; (b) opencode agent with `opencode/deepseek-v4.1-flash-free` and devin agent with `swe-1-6-slow` complete a trivial real prompt in the same daemon; (c) each real agent is instructed to talk to a Scripted agent via the `paseo` CLI and report the scripted reply (proves the Scripted provider behaves correctly as a counterpart under real, non-deterministic callers). Results written to `reports/real-verify.md`. Model ids are checked via `list_models` first.

## 6. Repository, CI, banner

- MIT license, `Copyright (c) 2026 quickwind`. `.gitignore` excludes `scratch/`.
- Workflows: `ci.yml` (typecheck, unit+integration with coverage, e2e matrix on 3 OSes, artifacts: reports), `security.yml` (Snyk: `snyk test` deps + `snyk code test`; needs `SNYK_TOKEN` secret), `badges` publish step on `main` pushes writes shields endpoint JSON (tests passing/total, coverage %, snyk vulns) to a `badges` branch.
- README top banner: CI status · tests (n passed) · coverage % · Snyk (vulnerabilities count, plus native Snyk badge when the repo is imported) · license · Paseo version range. Below: install, quick start, script reference, testkit usage, compatibility table, roadmap.
- Branching: all work on `feat/v0.1` (no `main` yet). After your approval: create `main` as **one** squash commit of the branch tree, push to `github.com/quickwind/paseo-scripted-provider` (created public), delete `feat/v0.1`. CI first runs on that push; badges populate after that run.

## 7. Open items / assumptions (please confirm or correct)

1. **YAML**: the daemon compiles `index.server.ts` with its own esbuild; a runtime `yaml` dependency may be unavailable in the installed plugin dir. v0.1 ships JSON; YAML is added only if a bundled (esbuild-built, committed `dist/`) approach is verified in e2e. Otherwise documented as roadmap.
2. **Real testing** (§5): confirmed by you — opencode/devin mainly exercise recording; counterpart-chat checks are a bonus.
3. **Server settings access**: exact SDK API for reading host settings from `index.server.ts` and building the client page will be confirmed against the SDK in implementation; env override `SCRIPTED_PROVIDER_STATE` guarantees headless operation regardless.
4. **Paseo compatibility**: `requirements.paseo` set to `>=0.11.0 <0.12.0` (tested: 0.11.4); CI pins that version.
5. **Badges** rely on CI having run once on `main`; Snyk requires the `SNYK_TOKEN` secret (I will ask before setting it).

## 8. Implementation notes (added after the first real-daemon run)

Paseo 0.11.4 only accepts plugin modules under `client/`, `server/` and `shared/`, and bundles `shared/` for the client too (no `node:*` imports, no `@getpaseo/plugin/server/*` imports there). The layout in §3 was adjusted accordingly:

- `shared/core/` — platform-neutral engine pieces (schema, script, planner, clock, recorder interface, capture/convert, capture/redact, capture/export, builtins)
- `server/` — Node-only code (config, recorder file writer, build-script, session, provider)
- `shared/rpc.ts` — settings definition and RPC contracts; `client/` — UI; `testkit/` — Node helper, not part of the installed plugin.

## 9. Decisions after acceptance testing

- **YAML scripts: done** (reversed after discussion). The daemon does not provide `yaml` to plugins (only the plugin SDK and `zod` are external; everything else is bundled from inside the plugin directory), so `yaml` is vendored as a single committed file `shared/vendor/yaml.js` (regenerated by `npm run vendor:yaml`; license kept alongside). Scripts are detected as JSON or YAML; recordings export as YAML (default) or JSON; merging a recording into an existing YAML script edits it in place, keeping comments. (Replaces open item 1 in §7.)
- **Real-agent-talks-to-Scripted-agent check: dropped.** The real-daemon e2e and the real opencode/devin recording round-trip cover that logic.
- Added during acceptance: replay answers by message content (`expect`, `{{placeholders}}` as wildcards) in `warn` mode; full-screen review with side-by-side content, review list, previous/next, Redact all / Keep all; fixed review color legend; the record button is a per-conversation composer pill.
