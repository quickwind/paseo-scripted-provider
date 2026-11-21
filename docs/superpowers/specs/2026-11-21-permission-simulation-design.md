# Simulated permission cards — design

Date: 2026-11-21 · Status: draft for approval (rev 2, after reviews)

## Intent

The Scripted provider is used as a deterministic stand-in agent when testing **other Paseo plugins and
Paseo itself**. Real agents stop mid-turn and ask for approval (tool permission, plan approval,
AskUserQuestion, mode switch); today Scripted cannot, so anything that reacts to permission cards
(auto-approve plugins, the app's permission UI, notification flows) cannot be tested against it.

This change lets a script raise **real** Paseo permission cards through the provider SDK, wait for the
response, and continue differently depending on what was answered.

## Goals

- A script can raise every kind of card the SDK supports: `tool`, `plan`, `question`, `mode`, `other`,
  with title, description, `input`, `detail`, `suggestions`, custom `actions`, `metadata`.
- The turn genuinely pauses until a response arrives; the response is observable (recorder events) and
  deterministic in its effect.
- The script can branch on the response: per button id, per question answer, allow / deny.
- Several cards can be pending at once (parallel tool calls).
- Branch steps can quote the response through a small set of `{{permission.*}}` variables.
- Interrupts, superseding prompts and session close never leave a card or a turn hanging.

## Non-goals

- Recording permission cards from real sessions into scripts (capture works from timeline items;
  permission events are a separate stream). Later work.
- A general template system (prompt text, cwd, previous turns…). Only the `permission.` namespace now.
- Timeouts / auto-responses for pending cards. A card waits until answered, interrupted or superseded.
- Persisting a pending card across a daemon restart (a running turn is not persisted today either).
- `prompt.steer` support, and with it `clearPendingPermissions` (see Constraints).
- Any client (UI) change. The Paseo app already renders permission cards.

## Anti-goals

- Breaking existing scripts or recorded scripts. In particular the redaction placeholders
  `{{secret_N}}`, `{{user_N}}`, `{{cwd}}` must never be touched by variable substitution.
- Actually executing the tool that was "approved" (AGENTS.md: tools are display-only).
- A turn that never ends because a response was lost, duplicated, or arrived for the wrong card.

## Constraints (verified in `@getpaseo/plugin` 0.12 and the Paseo source)

- The provider must offer the `"permission"` capability, both in the `connect()` result and in
  `session.opened.capabilities`; otherwise the daemon refuses to forward responses
  (`requireProviderCapabilities`, `plugin-provider.ts`).
- Request: emit `{ type: "session.permission", sessionId, request: ProviderPermissionRequest }`. The daemon
  validates every event with `ProviderEventSchema` (`plugin-provider.ts:805`): `id`, `name`, `actions[].id`
  non-empty; `input` / `metadata` / `suggestions[]` must be JSON records. An invalid event throws and fails
  the turn, so the script schema enforces the same rules at parse time.
- Response arrives as input `{ type: "session.permission", sessionId, permissionId, response }` where
  `response` is `{ behavior: "allow", selectedActionId?, updatedInput?, updatedPermissions? }` or
  `{ behavior: "deny", selectedActionId?, message?, interrupt? }`.
- The provider must then emit `{ type: "session.permission_resolved", sessionId, permissionId }`; the
  daemon only clears the card on that event, and its `inFlightPermissionResponses` buffering
  (`agent-manager.ts:3098-3127`) expects it to arrive promptly after the response.
  If the provider resolves a card without a response, the daemon records it as
  `deny / "Resolved by provider"`.
- The daemon tracks only *pending* cards, keyed by `request.id` (a map entry deleted on
  `permission_resolved`). A script-given `id` is passed through unchanged and may be reused once
  resolved; two cards pending at once with the same id would overwrite each other — forbidden.
- Action `intent` (`implement`, `implement_resume`, `dismiss`) is interpreted by each provider; the app
  only sends back `selectedActionId`. Allowing a `plan` or `mode` card triggers no follow-up prompt,
  `session.configure` or mode switch — the branch is the whole effect.
- What the app sends (`agent-stream/view.tsx`):
  - Cards without custom `actions` get default buttons `reject` (deny) and `accept` (allow; labelled
    "Implement" on plan cards). A deny from the app always carries `message: "Denied by user"`.
  - A `plan` card renders the plan only from `metadata.planText` or `input.plan` (string).
  - Question cards read `input.questions[]` (`{ header, question, options: [{label, description?, preview?}],
    multiSelect?, allowOther?, allowEmpty?, placeholder?, dismissLabel? }`) and answer with
    `allow` + `updatedInput.answers: Record<header, string>`. Multi-select joins labels with `", "` in
    **click order**; an `allowEmpty` question with no options may be answered `""`.
- `clearPendingPermissions` is only sent with a `delivery: "steer"` prompt, and only to providers that
  offer `prompt.steer` (`plugin-provider.ts:1174-1193`). Scripted does not, so a new message always
  arrives as a normal prompt, which supersedes the active turn (existing behaviour) — and that
  cleans up its cards (see *Ending early*).
- Unit tests use `ManualClock`; nothing reachable from `index.client.tsx` changes, so Hermes / client
  bundle checks are unaffected. The e2e can answer cards with `@getpaseo/client`'s
  `respondToPermission`; no testkit change needed.

## Approaches considered

1. **`permission` field on a tool only.** Natural for the common case (tool approval), works in
   `tools[]` and `steps[]`; cannot express plan / question / mode cards, which have no tool.
2. **A new `permission` step only.** Expresses everything, but only inside `steps[]`; the hand-written
   `tools[]` shorthand could not ask for approval.
3. **Both, on one runtime (chosen).** Tool approvals via `tool.permission`; other kinds via a standalone
   `kind: permission` step. Both compile to the same planner action and the same wait logic.

Branching options considered: no branching (deny = tool fails, continue), deny ends the turn, and
**per-response branches with that default (chosen)** — tests can assert "clicking X produces Y", which
is what testing auto-approval plugins needs.

## Script format

### Permission spec

```yaml
permission:
  id: perm-rm            # optional; default: generated. See "ids" below.
  kind: tool             # tool | plan | question | mode | other. Default: tool on a tool;
                         #   standalone: question if `questions` is given, else other.
  name: Bash             # default: the tool's name; standalone: by kind — question → AskUserQuestion,
                         #   plan → ExitPlanMode, mode → SwitchMode, other → permission.
  title: Allow running rm?
  description: Deletes the build directory.
  input: { command: "rm -rf build" }   # JSON object
  detail: { type: shell, command: "rm -rf build" }  # default: the tool's detail
  suggestions: [...]     # JSON objects, passed through
  metadata: {...}        # JSON object, passed through
  plan: "1. ...\n2. ..." # sugar for kind: plan → input.plan (what the app renders)
  questions:             # sugar for kind: question → input.questions (loose objects: app fields pass through)
    - header: Framework
      question: Which framework?
      options: [{ label: React }, { label: Vue }]
  actions:               # optional custom buttons; passed through as ProviderPermissionAction
    - { id: once,   label: Allow once,   behavior: allow, variant: primary }
    - { id: always, label: Always allow, behavior: allow }
    - { id: no,     label: Deny,         behavior: deny,  variant: danger }
  on:                    # optional branches, see below
    always: { text: "Remembered: {{permission.action}}" }
    "answer:Vue": { steps: [...] }
    deny: { text: "OK, not deleting.", outcome: canceled, error: "user said no" }
```

The schema mirrors the SDK's validation (non-empty `id`/`name`/`actions[].id`, JSON-only `input`,
`metadata`, `suggestions`) so a bad script fails when it is loaded, not mid-turn.

### Where it goes

- On a tool, in `tools[]` or a `kind: tool` step: `tool.permission`.
- Standalone: a step `{ kind: permission, delayMs?, permission: {...} }`.
- Several cards at once: a step `{ kind: parallel, delayMs?, steps: [...] }` whose children may only be
  `tool` steps (with or without `permission`) and `permission` steps. No nested `parallel`, no
  message/reasoning children. Only available in `steps[]`.

### Branch

`{ text?: string, steps?: Step[], outcome?: completed|failed|canceled|hang, error?: string }`.
`text` is shorthand for a leading message step (emitted before `steps`). Branch steps use the normal
step grammar, so they may contain permission steps and parallel groups.

### Ids

Ids must be unique among cards that can be pending at once. The schema rejects duplicate explicit ids
inside one `parallel` group. At run time, raising a card whose id is already pending fails the turn
(`E_SCRIPT_RUNTIME`) instead of overwriting it.

## Runtime behaviour

### Single card

1. If attached to a tool: emit the tool call with status `running`.
2. Emit `session.permission`; record `permission_requested` (`permissionId`, `kind`, `name`, `step`).
3. Wait for the matching response, an interrupt, a superseding prompt, or session close.
4. On response, **synchronously inside the input handler**: check the id is pending for this session,
   remove it, emit `session.permission_resolved`, record `permission_response` (`permissionId`,
   `behavior`, `selectedActionId`, `message`, `interrupt`, `answers`, matched branch key), then wake the
   waiting turn. A second response for the same id therefore finds nothing pending.
5. **Deny with `interrupt: true`:** tool (if any) → `failed` with the deny message (or `"denied"`); end the
   turn `canceled`. No branch runs.
6. Otherwise, the tool (if any) settles first: allow → wait `runningMs` (if set), then the tool's own
   `status` (default `completed`); deny → `failed` with error = deny message or `"denied"`.
7. Pick the branch (below). Run its `text` and `steps`. If it has `outcome`, finish the turn exactly as a
   top-level `end` would: commit the assistant text emitted so far to the transcript, then end the
   turn with that outcome — or, for `hang`, stop and wait for an interrupt / new prompt. Without
   `outcome`, continue with the rest of the reply.

### Branch selection (first match wins)

1. `selectedActionId` exactly (e.g. `always`, or the app's default `accept` / `reject`).
2. Question answers, in `questions` declaration order: for each question, `answer:<header>=<value>`;
   then `answer:<value>` against the first question's answer. Values are compared exactly against the
   string received (multi-select: labels in click order, joined with `", "`).
3. `allow` / `deny` by behavior.
4. `any`.
5. No match → only the default behaviour of step 6.

"First question's answer" is `answers[questions[0].header]` when the card declared `questions`, else the
first value of `answers`. An empty string is a real answer (presence is checked, not truthiness).

### Parallel group

- Emit, in declaration order, every child's `running` tool call and every card, without waiting.
  Children without a permission are just emitted (running, then their final status after `runningMs`,
  concurrently with the wait).
- Each response settles its own tool as it arrives (step 6 above, incl. its `runningMs` after allow).
- When **every card has been answered and every child tool has reached its final status**, run the
  matched branches **in declaration order** (deterministic, independent of answer order). The first
  branch with an `outcome` finishes the turn after its own steps (step 7); later branches don't run.
- Deny with `interrupt: true` on any card: that card's tool → `failed` (deny message); then the turn
  ends `canceled` through *Ending early*, which resolves the other pending cards and cancels the other
  running tools.

### Ending early

When a turn ends while cards or tools are still open — interrupt, a new prompt superseding the turn,
deny with `interrupt: true`, or a branch `outcome` — then, before the terminal `session.turn` event:

- every card still pending for that turn is resolved (`session.permission_resolved`) and recorded as
  `permission_canceled` (`permissionId`, `reason: interrupted | superseded | interrupt_deny | branch_outcome`);
- every tool of that turn still `running` — waiting on its card, or inside its `runningMs` — is emitted
  as `canceled`.

On `session.close` nothing is emitted (as today); pending waits are released.

A response for an unknown or already-resolved `permissionId` is ignored and recorded as
`permission_unknown`; it never throws.

### Variables (`permission.` namespace only)

Inside a branch — its `text`, `error`, and every step in it: message/reasoning `text`, tool `detail`
strings and `error`, and a nested permission's `title`, `description`, `plan`, `input`, `detail` and
`questions` strings — these are replaced, using the card the branch belongs to:

| Variable | Value |
|---|---|
| `{{permission.behavior}}` | `allow` / `deny` |
| `{{permission.action}}` | `selectedActionId`, or empty |
| `{{permission.message}}` | the deny message, or empty (from the app this is always `Denied by user`) |
| `{{permission.answer}}` | the first question's answer, or empty |
| `{{permission.answers.<header>}}` | that question's answer, or empty; `<header>` is anything up to `}}` (spaces, CJK allowed) |

Substitution stops at a nested permission's `on:` — a nested card's own branches are filled from the
nested card's response, never from the outer one.

Any other `{{…}}` text — including `{{secret_1}}`, `{{cwd}}`, and unknown `{{permission.xyz}}` — is
left exactly as written. Steps outside a branch are never touched.

`@MACRO` expansion applies to all branch texts too, recursively, under both `reply.tools[]` and
`reply.steps[]`.

## Code touched

- `shared/core/schema.ts` — `PermissionSpecSchema`, `BranchSchema`, `tool.permission`, step kinds
  `permission` and `parallel` (recursive via `z.lazy`), SDK-aligned validation, duplicate-id check.
- `shared/core/planner.ts` — `planSteps()` extracted so branches can be planned at run time; new
  actions `permission` and `parallel`.
- `shared/core/script.ts` — macro expansion recurses into branches under `tools[]` and `steps[]`.
- `server/session.ts` — pending-card registry per turn, synchronous respond/resolve, branch selection,
  variable substitution, early-end cleanup, transcript commit on branch outcome; `respond(permissionId, response)`.
- `server/provider.ts` — `"permission"` capability (both places); route `session.permission` input.
- Tests: unit (planner, schema, session with `ManualClock`), integration (provider glue), one real-daemon
  e2e (raise a card, answer it through the client, assert the branch output).
- `README.md` — a "Permission cards" section with a tool approval, a plan, a question and a parallel
  example; remove "Permission-approval flows" from the roadmap.

## Left to the builder

- Internal names, module split, and how the wait is implemented, as long as unit tests stay on
  `ManualClock`.
- Exact wording of default error strings beyond `"denied"`.
- Version bump / changelog wording at release time.
