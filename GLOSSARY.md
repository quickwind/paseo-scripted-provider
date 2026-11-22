# paseo-scripted-provider

A deterministic, model-free Paseo agent provider and testkit that replaces LLM decision-making with YAML/JSON scripts while simulating realistic agent behavior, permission flows, and optional controlled tool execution.

## Language

### Scripting & Playback

**Script**:
A YAML or JSON document containing optional `macros` and named `scenarios` that define how the Scripted provider responds.
_Avoid_: Fixture file, config script, mock file

**Scenario**:
A named sequence of `Reply` entries exposed as a selectable model under the `scripted` provider (e.g., `scripted/tools-demo`).
_Avoid_: Preset, profile, test case

**Reply**:
One agent turn's scripted output in a scenario, authored either with shorthand fields (`text`, `chunks`, `tools`) or an ordered `steps` array.
_Avoid_: Turn response, message spec

**Step**:
A single timed unit inside a `Reply`'s `steps` array (such as `reasoning`, `message`, `tool`, `permission`, `parallel`, `todo`, `compaction`, `notification`, `error`, or `plugin`).
_Avoid_: Action, event, timeline item (reserve *Action* for the internal planner output and *Timeline Item* for the Paseo protocol payload)

**Alignment**:
The policy (`warn`, `strict`, or `ignore`) governing how an incoming prompt is matched against a `Reply`'s `expect` pattern.
_Avoid_: Matching mode, strictness

**Exhaustion Policy**:
The rule (`repeat`, `fail`, or `cycle`) controlling what happens when a session receives more prompts than the number of replies in a scenario.
_Avoid_: Overflow behavior, end-of-script mode

### Brain & Execution Harness

**Scripted Brain**:
The deterministic script planner and session state machine that replaces an LLM's decision-making (what to say, which tools or permission cards to raise, and which branch to take next).
_Avoid_: Mock LLM, fake model

**Harness**:
The tool and MCP execution layer driven by the `Scripted Brain` after permission approval.
_Avoid_: Runner, executor

**Display Mode**:
The default `Harness` mode where tool and MCP steps emit UI timeline items only, without touching the filesystem, spawning processes, or calling external servers.
_Avoid_: Fake mode, dry run, Layer 1 only

**Execute Mode**:
The opt-in `Harness` mode where approved tool or MCP steps run real operations within authorized `Execution Scopes`, backfill real outputs into the timeline, and expose results to subsequent steps.
_Avoid_: Live mode, real mode, side-effect mode

**Execution Scope**:
An orthogonal capability category (`fs`, `mcp`, `shell`) that the host may individually authorize for `Execute Mode`.
_Avoid_: Permission level, execution tier

**Dual-Lock**:
The mandatory two-gate safety requirement for `Execute Mode`: a tool executes only when both the host authorizes its `Execution Scope` (`allowExecution`) and the script explicitly opts in (`execute: true`).
_Avoid_: Double gate, two-factor execution

### Permissions & Branching

**Permission Card**:
A real Paseo `session.permission` request raised by a tool or step (`tool`, `plan`, `question`, `mode`, or `other`) that pauses the turn until answered.
_Avoid_: Approval dialog, prompt card

**Branch**:
A conditional continuation (`on` for permission answers, `onResult` for tool execution outcomes, `onSteer` for mid-turn steering) that emits extra steps or terminates the turn early.
_Avoid_: Handler, callback, transition

### Capture, Redaction & Observability

**Recording**:
The process of capturing a live Paseo agent conversation into a replayable `Script` with original pacing preserved in `steps`.
_Avoid_: Snapshot, dump

**Redaction**:
Automatic and human-confirmed replacement of secrets, emails, usernames, and workspace paths in a `Recording` with deterministic placeholders (`{{secret_N}}`, `{{email_N}}`, `{{user_N}}`, `{{cwd}}`).
_Avoid_: Sanitization, masking

**Re-hydration**:
Replacing `{{cwd}}` placeholders with the active session's real working directory when emitting timeline items or permission cards during replay.
_Avoid_: Interpolation, un-redacting

**Received Log**:
The append-only JSONL audit trail (`received.jsonl`) recording inbound provider events (`open`, `prompt`, `configure`, `permission_response`, `interrupt`, `close`) and `tool_executed` outcomes for test assertions.
_Avoid_: Event log, trace file
