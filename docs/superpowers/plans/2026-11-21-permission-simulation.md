# Simulated Permission Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Scripted reply raise real Paseo permission cards, wait for the answer, and branch on it.

**Architecture:** The script schema gains a `permission` spec (on a tool, or as a standalone / parallel
step) with `on:` branches. Pure logic (request building, branch selection, `{{permission.*}}`
substitution) lives in a new `shared/core/permission.ts`. The planner emits `permission` / `parallel`
actions; branches are planned at run time. `ScriptedSession` keeps a per-turn registry of pending cards
and open tools, answers responses synchronously, and cleans both up whenever a turn ends early.

**Tech Stack:** TypeScript, Zod 4, Vitest, `@getpaseo/plugin` 0.12 provider SDK, node:test e2e via `testkit`.

**Spec:** `docs/superpowers/specs/2026-11-21-permission-simulation-design.md` (rev 2) — read it first; this
plan does not repeat its rules, it says where each one lives.

## Global Constraints

- `shared/core/schema.ts` is imported by the client bundle (Hermes): no classes, no async arrow functions there. `shared/core/permission.ts` must not be imported from `client/` or `index.client.tsx`.
- Unit tests use `ManualClock` (`test/helpers/manual-clock.ts`) and the `connect` harness (`test/helpers/harness.ts`), which validates every emitted event with `ProviderEventSchema`.
- Tools stay display-only; nothing is executed.
- Only `{{permission.<key>}}` is ever substituted; `{{secret_N}}`, `{{user_N}}`, `{{cwd}}` and unknown `{{permission.x}}` stay verbatim.
- Default deny error string: `"denied"`. Default standalone names: question → `AskUserQuestion`, plan → `ExitPlanMode`, mode → `SwitchMode`, other/tool → `permission`.
- Recorder event kinds: `permission_requested`, `permission_response`, `permission_unknown`, `permission_canceled` (reasons `interrupted | superseded | interrupt_deny | branch_outcome`).
- Capability `"permission"` is added; `"prompt.steer"` is NOT.
- Coverage gate: `npm run test:coverage` must stay green.

## Review Focus

1. A response that arrives after its turn already ended (user clicks a stale card after an interrupt) → recorded `permission_unknown`, nothing emitted, no throw. *(Task 4)*
2. A response addressed to another session, or to a session that is closed → ignored, other sessions unaffected. *(Task 4)*
3. A branch with `outcome` that emitted text → that text is in the persisted transcript (visible after a daemon restart / `history: replay`). *(Task 4)*
4. The same scenario run twice in one session with an explicit `permission.id` → the second turn raises and resolves the card normally. *(Task 4)*
5. A branch text holding both `{{secret_1}}` and `{{permission.message}}`, and an `allowEmpty` question answered `""` → only the variable is replaced; `""` counts as an answer (`answer:` with empty value matches). *(Task 2)*

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/core/schema.ts` (modify) | `PermissionSpecSchema`, `BranchSchema`, `tool.permission`, step kinds `permission` / `parallel`, SDK-aligned validation, duplicate-id check |
| `shared/core/permission.ts` (create) | Pure: `buildRequest`, `answersOf`, `selectBranch`, `permissionVars`, `substituteBranch` |
| `shared/core/planner.ts` (modify) | `planSteps()` extracted; actions `permission`, `parallel` |
| `shared/core/script.ts` (modify) | `@MACRO` expansion recursing into branches under `tools[]` and `steps[]` |
| `server/session.ts` (modify) | pending-card + open-tool registry, `respond()`, branch execution, early-end cleanup |
| `server/provider.ts` (modify) | capability, route `session.permission` |
| `README.md`, `e2e/scripted.e2e.test.mjs` (modify) | docs, real-daemon test |

---

### Task 1: Script schema

**Files:**
- Modify: `shared/core/schema.ts`
- Test: `test/unit/permission-schema.test.ts` (create)

**Interfaces:**
- Produces (all exported from `shared/core/schema.ts`):
  - `PermissionActionSchema` = `{ id: string.min(1), label: string, behavior: "allow"|"deny", variant?: "primary"|"secondary"|"danger", intent?: "implement"|"implement_resume"|"dismiss" }`
  - `QuestionSchema` = `z.looseObject({ header: string, question: string, options: z.array(z.looseObject({ label: string })) })`
  - `PermissionSpecSchema` = `{ id?: string.min(1), kind?: "tool"|"plan"|"question"|"mode"|"other", name?: string.min(1), title?, description?, input?: z.record(z.string(), z.json()), detail?: ToolDetailSchema, suggestions?: z.array(z.record(z.string(), z.json())), metadata?: z.record(z.string(), z.json()), plan?: string, questions?: QuestionSchema[] (min 1), actions?: PermissionActionSchema[], on?: z.record(z.string(), BranchSchema) }`
  - `BranchSchema` = `{ text?: string, steps?: Step[], outcome?: "completed"|"failed"|"canceled"|"hang", error?: string }`
  - `ToolSpecSchema` gains `permission?: PermissionSpecSchema`
  - `StepSchema.kind` becomes `"reasoning"|"message"|"tool"|"permission"|"parallel"`, plus `permission?: PermissionSpecSchema`, `steps?: Step[]`
  - Types `PermissionSpec`, `Branch`, `PermissionAction` exported; `Step` / `ToolSpec` declared as explicit TS types so `z.lazy` recursion type-checks.

- [ ] **Step 1: Write failing tests** in `test/unit/permission-schema.test.ts` using `parseScript`:
  - `accepts a tool permission with actions and on-branches` — `tools: [{ name: "Bash", detail: {type:"shell",command:"rm"}, permission: { actions: [{id:"once",label:"Once",behavior:"allow"}], on: { deny: { text: "no", outcome: "canceled" } } } }]` → `ok: true`.
  - `accepts standalone permission and parallel steps` — `steps: [{kind:"permission", permission:{questions:[{header:"F",question:"?",options:[{label:"A"}]}]}}, {kind:"parallel", steps:[{kind:"tool", tool:{...permission:{id:"a"}}}, {kind:"permission", permission:{id:"b"}}]}]` → `ok: true`.
  - `keeps unknown question fields` — `options[0].preview`, `questions[0].dismissLabel` survive parsing.
  - `rejects empty action id` → `ok: false`, error path contains `actions`.
  - `rejects a kind: permission step without permission` → `ok: false`.
  - `rejects duplicate explicit ids in one parallel group` → `ok: false`, error contains `duplicate permission id "a"`.
  - `rejects parallel children other than tool/permission, and nested parallel` → `ok: false` for a `message` child and a `parallel` child.
  - `rejects non-JSON input` — `input: { x: undefined }` passed as an object to `ScriptSchema.safeParse` → `success: false`.

- [ ] **Step 2:** Run `npx vitest run test/unit/permission-schema.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** in `shared/core/schema.ts`. Use `z.lazy` for the Step ↔ Branch ↔ PermissionSpec ↔ ToolSpec cycle. Add the step-level rules with `.superRefine` on `StepSchema`: `permission` kind requires `permission`; `parallel` kind requires non-empty `steps`, every child `kind` ∈ {`tool`,`permission`}, and no two children with the same explicit id (`child.permission?.id ?? child.tool?.permission?.id`). Plain functions only.

- [ ] **Step 4:** Run `npx vitest run test/unit/permission-schema.test.ts test/unit/script.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(schema): permission specs, branches, permission and parallel steps"`

---

### Task 2: Pure permission logic

**Files:**
- Create: `shared/core/permission.ts`
- Test: `test/unit/permission.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`shared/core/permission.ts`):
  - `type PermissionResponse = { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean }` (structurally equal to the SDK's `ProviderPermissionResponse`; shared code does not import the SDK).
  - `buildRequest(spec: PermissionSpec, id: string, tool?: ToolSpec): Record<string, unknown>` — the `ProviderPermissionRequest` object; undefined keys omitted.
  - `answersOf(r: PermissionResponse): Record<string, string> | undefined` — `updatedInput.answers` if it is an object, string values only.
  - `selectBranch(spec: PermissionSpec, r: PermissionResponse): { key: string; branch: Branch } | undefined`
  - `permissionVars(spec: PermissionSpec, r: PermissionResponse): Record<string, string>` — keys `behavior`, `action`, `message`, `answer`, `answers.<header>`.
  - `substituteBranch(branch: Branch, vars: Record<string, string>): Branch`

- [ ] **Step 1: Write failing tests** in `test/unit/permission.test.ts`:
  - `buildRequest` — on a tool `{name:"Bash", detail:{type:"shell",command:"ls"}}` with `{}` → `{ id, name: "Bash", kind: "tool", detail: {type:"shell",command:"ls"} }`; standalone `{questions:[Q]}` → `kind: "question", name: "AskUserQuestion", input: { questions: [Q] }`; `{plan:"1. x"}` → `kind: "plan", name: "ExitPlanMode", input: { plan: "1. x" }`; `{kind:"mode"}` → `name: "SwitchMode"`; `{}` → `kind: "other", name: "permission"`; `input` keys are merged with `plan`/`questions`; result passes `ProviderEventSchema` when wrapped as `{type:"session.permission", sessionId:"s", request}`.
  - `selectBranch` precedence, one test per row of the spec's order: action id beats `answer:`, `answer:<header>=<v>` beats `answer:<v>`, `answer:` beats `allow`, `allow`/`deny` beat `any`, nothing matching → `undefined`. Multi-question: with `on` holding `answer:Lang=TS` and `answer:Framework=React` and questions declared `[Framework, Lang]`, answers `{Framework:"React", Lang:"TS"}` → key `answer:Framework=React`.
  - `selectBranch` first-question rule: no declared questions → first value of `answers`; `""` answer matches `answer:` (key `"answer:"`) — Review Focus 5.
  - `permissionVars` — deny `{message:"Denied by user", selectedActionId:"reject"}` → `{behavior:"deny", action:"reject", message:"Denied by user", answer:""}`; allow with answers `{"部署 方式":"A, B"}` → `answers.部署 方式 = "A, B"`.
  - `substituteBranch` — replaces in `text`, `error`, step `text`, nested tool `detail` strings and `error`, nested permission `title`/`description`/`plan`/`input`/`detail`/`questions`; leaves a nested permission's `on` untouched; `"{{secret_1}} said {{permission.message}} {{permission.nope}}"` → `"{{secret_1}} said hi {{permission.nope}}"` — Review Focus 5.

- [ ] **Step 2:** Run `npx vitest run test/unit/permission.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `shared/core/permission.ts`. Substitution regex: `/\{\{permission\.([^}]+)\}\}/g`, replace only when the captured key is in `vars`. Deep-walk JSON values for `input`/`detail`/`questions`.

- [ ] **Step 4:** Run `npx vitest run test/unit/permission.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: permission request building, branch selection and variables"`

---

### Task 3: Planner actions and macro recursion

**Files:**
- Modify: `shared/core/planner.ts`, `shared/core/script.ts:82-94`
- Test: `test/unit/planner.test.ts`, `test/unit/script.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`shared/core/planner.ts`):
  - `planSteps(steps: Step[], newKey: () => string): Action[]` — the existing `steps` branch of `planReply`, without the trailing `end`.
  - New `Action` members:
    - `{ t: "permission"; key: string; spec: PermissionSpec; tool?: ToolSpec }` — `key` is the tool-call key when `tool` is set.
    - `{ t: "parallel"; children: { key: string; tool?: ToolSpec; permission?: PermissionSpec }[] }`
  - A tool with `permission` (in `tools[]` or a `tool` step) plans as a single `permission` action (no `running`/final `tool` actions, no `runningMs` sleep — the session does those). A standalone `permission` step → `permission` action without `tool`. `delayMs` still becomes a leading `sleep`.

- [ ] **Step 1: Write failing tests:**
  - planner: `a tool with permission plans one permission action carrying the tool` (both `tools[]` and `steps[]` forms; `kinds` = `["permission","end"]`, `a[0].tool.name === "Bash"`); `a standalone permission step plans a permission action without tool`; `a parallel step plans one parallel action with a child per step, in order` (`delayMs` → leading `sleep`); `planSteps returns no end action`.
  - script: `resolveReply expands @MACRO inside branches` — macro in `tools[0].permission.on.deny.text`, in `steps[0].permission.on.allow.steps[0].text`, and in a parallel child's `on` branch text are all expanded.

- [ ] **Step 2:** Run `npx vitest run test/unit/planner.test.ts test/unit/script.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** In `script.ts`, replace the flat `steps` mapping with a recursive `expandStep` / `expandBranch` pair applied to `raw.steps` and to `raw.tools[].permission`; expand only `text` fields (same rule as today: whole-string `@NAME`).

- [ ] **Step 4:** Run `npx vitest run test/unit && npm run typecheck` — Expected: PASS (existing planner tests unchanged).

- [ ] **Step 5: Commit** — `git commit -m "feat(planner): permission and parallel actions; macros inside branches"`

---

### Task 4: Session runtime for single cards + provider wiring

**Files:**
- Modify: `server/session.ts`, `server/provider.ts:44-80,128`, `test/helpers/harness.ts:15` (offer `"permission"`)
- Test: `test/unit/permission-session.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 (`buildRequest`, `selectBranch`, `permissionVars`, `substituteBranch`, `PermissionResponse`), Task 3 (`planSteps`, actions).
- Produces:
  - `ScriptedSession.respond(permissionId: string, response: PermissionResponse): void` — synchronous: unknown/not-pending → record `permission_unknown`, return; else delete from registry, emit `session.permission_resolved`, record `permission_response` (with `branch` = matched key or `null`), wake the waiter.
  - `endTurn(turnId, state, message?, code?, reason?: "interrupted"|"superseded"|"interrupt_deny"|"branch_outcome")` — before the persistence event: for every pending card of the turn emit `session.permission_resolved` + record `permission_canceled {permissionId, reason}`; for every open tool emit it with `status: "canceled"`. `interrupt()` passes `interrupted`, the superseding prompt passes `superseded`.
  - A shared `finish(turnId, outcome, error)` used by the top-level `end` action and by branch outcomes: commits accumulated assistant text to the transcript, then `endTurn` (or, for `hang`, awaits abort).
  - Provider: `"permission"` added to `capabilities` in both `session.opened` and the `connect()` result; `case "session.permission": sessions.get(input.sessionId)?.respond(input.permissionId, input.response); return;` (unknown session → no-op).

- [ ] **Step 1: Write failing tests** in `test/unit/permission-session.test.ts` (harness: `connect`, `open`, `prompt`, `turnStates`; helper `respond = (sid, id, response) => h.send({type:"session.permission", sessionId: sid, permissionId: id, response})`; ids come from `newId` → predictable `id-N`, or use explicit `permission.id`):
  - `advertises the permission capability` — `session.opened.capabilities` contains `"permission"`.
  - `tool card: running tool, then card, turn waits` — events after prompt end with tool `running` then `session.permission` (request `name:"Bash", kind:"tool"`); `turnStates` = `["started"]`.
  - `allow: resolved, tool completed after runningMs, reply continues` — `runningMs: 500`; respond allow → `session.permission_resolved` emitted immediately; after `clock.advance(500)` tool `completed`, then the reply `text`, turn `completed`.
  - `deny without branch: tool failed with the deny message, reply continues` — error `"Denied by user"`; default `"denied"` when no message.
  - `deny with interrupt: tool failed, turn canceled, no branch` — `on.deny.text` NOT emitted; `turnStates` = `["started","canceled"]`.
  - `branch by action id runs its text and steps, then the rest of the reply`.
  - `branch outcome ends the turn and keeps the branch text in the transcript` — `on.deny: {text:"ok, stopping", outcome:"canceled"}`; afterwards `session.persistence.data.transcript` last entry text is `"ok, stopping"`; later steps not emitted — Review Focus 3.
  - `branch outcome hang waits for interrupt`.
  - `branch text substitutes {{permission.message}}`.
  - `standalone question card answered → answer branch` — `updatedInput: {answers: {Framework: "Vue"}}` → `on["answer:Vue"].text` emitted.
  - `nested card inside a branch is raised and answered with its own branches`.
  - `interrupt while waiting: card resolved, tool canceled, then turn canceled` — order of events: `session.permission_resolved`, tool `canceled`, `session.persistence`, `session.turn canceled`; record has `permission_canceled` reason `interrupted`.
  - `new prompt while waiting supersedes: card resolved with reason superseded, next reply runs`.
  - `duplicate response and stale response are ignored` — second respond for same id and a respond after interrupt → record `permission_unknown`, no extra events, no throw — Review Focus 1.
  - `response for another or closed session is ignored` — two sessions s1/s2 with pending cards; respond on s2 only settles s2; respond to a closed session → no events — Review Focus 2.
  - `explicit id can be reused in a later turn` — scenario with two identical replies using `permission.id: "p"`; both turns raise and resolve `p` — Review Focus 4.
  - `recorder gets permission_requested and permission_response` — pass `recorder: () => ({ record: (k, d) => rec.push({k, ...d}) })`.

- [ ] **Step 2:** Run `npx vitest run test/unit/permission-session.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Turn `run()` into a recursive `runActions(turnId, actions, ctx): Promise<"continue" | "ended">` where `ctx` holds `idFor`, the assistant `texts` map and `live()`. `permission` action: emit running tool (if any), register `{ turnId, toolItem?, resolve }` under the card id (generated with `newId()` unless `spec.id`), emit the card, `await Promise.race([response, turn.aborted])`; then follow spec *Single card* steps 5–7, planning the branch with `planSteps(substituteBranch(branch, permissionVars(spec, r)).steps ?? [], newId)` after prepending `branch.text` as a message step. Keep open tools in a per-turn map so `endTurn` can cancel them; remove on final status. Raising an id already in the registry → throw (caught by the existing `run` catch → turn `failed`, `E_SCRIPT_RUNTIME`).

- [ ] **Step 4:** Run `npx vitest run test/unit test/integration && npm run typecheck` — Expected: PASS (all existing session tests unchanged).

- [ ] **Step 5: Commit** — `git commit -m "feat(session): raise permission cards, wait, branch on the answer"`

---

### Task 5: Parallel groups

**Files:**
- Modify: `server/session.ts`
- Test: `test/unit/permission-session.test.ts`

**Interfaces:**
- Consumes: Task 4 registry, `respond`, `finish`, `endTurn(reason)`.
- Produces: handling of the `parallel` action as in spec *Parallel group*.

- [ ] **Step 1: Write failing tests:**
  - `emits every running tool and every card before waiting` — two tool children with permissions + one plain tool child (`runningMs: 300`); after prompt: 3 `running` tools then 2 cards, in declaration order.
  - `each answer settles its own tool on arrival` — answer child 2 first → child 2 tool `completed` while child 1 still `running`.
  - `branches run in declaration order after all cards and tools settle` — answer child 2 then child 1; branch texts appear as `[child1, child2]`, only after `clock.advance(300)` lets the plain tool finish.
  - `first branch with outcome ends the turn; later branches do not run`.
  - `interrupt-deny on one card: its tool failed, the other card resolved (reason interrupt_deny), other tools canceled, turn canceled`.
  - `duplicate id pending at once fails the turn` — the harness's `getScript` returns the object as-is (no schema check), so pass a parallel group whose two children both use `permission.id: "p"` → exactly one `session.permission` for `p`, turn `failed` with code `E_SCRIPT_RUNTIME`.

- [ ] **Step 2:** Run `npx vitest run test/unit/permission-session.test.ts` — Expected: new tests FAIL.

- [ ] **Step 3: Implement** the `parallel` case: one promise per child (card child: await answer → settle its tool incl. `runningMs`; plain child: sleep `runningMs` → final status), `await Promise.race([Promise.all(children), turn.aborted])`, then run matched branches in declaration order, stopping at the first `outcome`. Interrupt-deny: settle that tool `failed`, then `endTurn(…, "canceled", …, "interrupt_deny")`.

- [ ] **Step 4:** Run `npx vitest run && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(session): parallel permission groups"`

---

### Task 6: README, real-daemon e2e, release checks

**Files:**
- Modify: `README.md` (new "Permission cards" section after "Timed steps"; Roadmap line drops "Permission-approval flows"), `e2e/scripted.e2e.test.mjs`

- [ ] **Step 1: Write the e2e test** `raises a permission card and branches on the answer` in `e2e/scripted.e2e.test.mjs`: add scenario
  `perm: [{ tools: [{ name: "Bash", detail: { type: "shell", command: "rm -rf build" }, permission: { title: "Allow rm?", on: { accept: { text: "allowed" }, reject: { text: "denied: {{permission.message}}" } } } }], text: "after" }]`.
  Create two agents. Poll `env.api.agents.ref(id)` (`refresh()` + `pendingPermissions`, ≤ `env.ms(10000)`) until one card is pending; respond `{behavior:"allow", selectedActionId:"accept"}` to the first and `{behavior:"deny", selectedActionId:"reject", message:"Denied by user"}` to the second; `waitForFinish`; assert assistant texts `["allowed","after"]` and `["denied: Denied by user","after"]`; assert `readRecord()` has two `permission_response` entries with `branch` `accept` / `reject`.

- [ ] **Step 2:** Run `npm ci --prefix testkit && npm run e2e` — Expected: all e2e tests PASS.

- [ ] **Step 3: Write the README section**: one example each for a tool approval with custom actions, a plan card (`plan:`), a question card with an `answer:` branch, and a parallel group; the branch-selection order; the variable table; the note that the app's default buttons are `accept`/`reject` and its deny message is `Denied by user`; the recorder event kinds.

- [ ] **Step 4: Run every gate** — `npm run typecheck && npm run test:coverage && npm run check:client-bundle && npm run check:hermes && npm run verify:package` — Expected: all PASS, coverage ≥ the configured threshold.

- [ ] **Step 5: Commit** — `git commit -m "docs+e2e: permission cards"`
