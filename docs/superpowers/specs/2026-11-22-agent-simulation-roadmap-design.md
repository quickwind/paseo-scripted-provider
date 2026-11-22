# Agent Simulation & Dual-Mode Harness Roadmap

- **Date**: 2026-11-22
- **Status**: Approved
- **Canonical Vocabulary**: [`GLOSSARY.md`](../../../GLOSSARY.md)
- **Governing ADRs**:
  - [ADR-0001: Keep YAML parsing on the server and keep the client bundle Hermes-compatible](../../adr/0001-server-owned-yaml-and-hermes-client.md)
  - [ADR-0002: Evolve a single Script DSL instead of adding a separate Protocol Trace format](../../adr/0002-single-script-dsl-over-separate-protocol-trace.md)
  - [ADR-0003: Align TypeScript types to Paseo 0.16.2 while maintaining >=0.12.0 daemon compatibility via runtime negotiation](../../adr/0003-runtime-capability-negotiation-and-dual-config-write.md)
  - [ADR-0004: Use a Dual-Mode Harness (Display vs. Execute) protected by a Dual-Lock safety gate](../../adr/0004-dual-mode-harness-with-dual-lock-gate.md)
  - [ADR-0005: Use a provider-level delayScale multiplier instead of a cross-process virtual clock for daemon E2E](../../adr/0005-delay-scale-over-cross-process-virtual-clock.md)

---

## Phased Delivery Plan

### P0 — Protocol Alignment, Core Orchestration & Testkit Unlock

#### P0-1: SDK 0.16.2 Alignment, Dynamic Negotiation & Full `received.jsonl` Observability
- Upgrade root `@getpaseo/plugin` and `@getpaseo/client` devDependencies to `0.16.2`; set `paseo-plugin.json` `requirements.paseo` to `">=0.12.0"` (per [ADR-0003](../../adr/0003-runtime-capability-negotiation-and-dual-config-write.md)).
- Negotiate capabilities in `connect(request)` using `negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES)`.
- Expand `received.jsonl` records:
  - `open`: record full `config` (`cwd`, `env`, `systemPrompt`, `mcpServers`, `toolPolicy`, `mode`, `thinkingOption`, `providerOptions`, `settings`, `title`).
  - `prompt`: record structured `attachments` summaries, `command` (`name`, `arguments`), `outputSchema`, `clearPendingPermissions`.
  - `permission_response`: record full `updatedInput` and `updatedPermissions`.
  - Add `configure` and `close` event records.

#### P0-2: Full Timeline Items (9/9), Turn Error/Usage Signals & Step-Level Streaming
- Extend `StepSchema` / `ReplySchema` (per [ADR-0002](../../adr/0002-single-script-dsl-over-separate-protocol-trace.md)):
  - Add `todo`, `compaction` (`loading` → `delayMs` → `completed`), `notification`, `error`, and `plugin` (`"timeline.plugin"` capability) step kinds, plus `revertToken` and `tool_call.metadata`.
  - Add `usage` (`session.usage`), `notices` (`session.notice`), custom `errorCode` / `diagnostic` (replacing hardcoded `E_SCRIPTED`), and `runtimeFailed: true` (`session.runtime_failed`).
  - Support `chunks` + `chunkDelayMs` on `message` and `reasoning` steps inside `steps[]`.

#### P0-3: Full Timeline Persistence Fix, `{{cwd}}` Re-hydration & Exhaustion Policy
- Upgrade `Persisted` (`version: 2`, backward-compatible with `version: 1`) to persist full `ProviderTimelineItem[]` snapshots by item `id`, fixing lost `tool_call`/`reasoning` items and merged messages on daemon restart (`history === "replay"`).
- Re-hydrate `{{cwd}}` to the active session's `cwd` when emitting timeline items and permission cards (while keeping wildcard matching in `expect`).
- Add namespaced template variables: `{{prompt.text}}`, `{{session.cwd}}`, `{{session.mode}}`, `{{session.model}}`, `{{session.thinkingOption}}`, `{{permission.updatedInput.<key>}}` (leaving redaction placeholders like `{{secret_N}}` untouched).
- Add `onExhausted: "repeat" | "fail" | "cycle"` (default `"repeat"`; `"fail"` emits `E_SCRIPT_EXHAUSTED`).

#### P0-4: `session.configure` (Modes / Thinking / Controls) & `prompt.steer`
- Declare `"session.configure"`, `"prompt.steer"`, `"prompt.command"` (and `"session.can_stop_runtime"` when negotiated).
- Support configurable `modes` (`default`, `plan`, `auto`, `bypassPermissions`), `thinkingOptions`, `controls` + `providerOptions` (dual-written with `settings` per [ADR-0003](../../adr/0003-runtime-capability-negotiation-and-dual-config-write.md)), and `session.commands`.
- Handle `session.configure`, update persisted session state, emit updated `session.config`, and support `setMode` inside permission branches (e.g., `ExitPlanMode` → `auto`).
- Handle mid-turn `delivery: "steer"` by returning `{ type: "steer", turnId }` without canceling the active turn, honoring `clearPendingPermissions: true`, and supporting `onSteer` branches.

#### P0-5: Testkit Unblocking, `delayScale` & Async Waiters
- Add provider `delayScale` setting / `SCRIPTED_PROVIDER_DELAY_SCALE` env var (per [ADR-0005](../../adr/0005-delay-scale-over-cross-process-virtual-clock.md)).
- Allow `Daemon.writeConfig()` in `testkit/daemon.mjs` to merge caller-provided `daemonConfig` overrides (e.g., enabling `mcp.enabled`, `enableTerminalAgentHooks`).
- Expand `env.createAgent()` in `testkit/index.mjs` to forward full `AgentSessionConfig` (`mode`, `thinkingOption`, `providerOptions`, `mcpServers`, `env`, `systemPrompt`, `workspaceId`, `cwd`).
- Add `env.setScript(script)`, `env.waitForRecord(predicate, opts)`, `env.waitForTimeline(agentId, predicate, opts)`, and `env.steer(agentId, prompt)`.

---

### P1 — Dual-Mode Harness Phase 1 (`fs` + `mcp`), UsageSource & High-Fidelity Recording

#### P1-1: Dual-Mode Harness Phase 1 (`fs` & `mcp` Scopes + `onResult`)
- Implement the Dual-Lock safety gate (`allowExecution` / `SCRIPTED_ALLOW_EXECUTION` × `tool.execute: true`) per [ADR-0004](../../adr/0004-dual-mode-harness-with-dual-lock-gate.md).
- Merge permission `allow` `updatedInput` into effective tool parameters before execution.
- Implement `fs` scope (`read`, `write`, `edit` confined to `session.cwd` via `fs.realpathSync`, generating real `unifiedDiff` on `edit`) and `mcp` scope (connecting to `session.config.mcpServers` via stdio/http and backfilling `detail.output`).
- Record `tool_executed` in `received.jsonl`, expose `{{tool.output}}` / `{{tool.exitCode}}` / `{{tool.error}}`, and support `ToolSpec.onResult` branches.

#### P1-2: Programmable `UsageSource` (`registerUsageSource`)
- Register a programmable `UsageSource` (guarded by `typeof server.registerUsageSource === "function"`) with settings/RPC control to simulate `available` windows (`usedPct`, `tone`, `balances`) and `unavailable` states (`no_quota`, `expired`, `rejected`) for Playbooks `recover_manager` and Usage UI tests.

#### P1-3: High-Fidelity Recorder Upgrade
- Listen to `agent.permission_requested` and `agent.permission_resolved` in `index.server.ts` into a bounded ring buffer so `captureRpc` stitches real permission cards back into recorded scripts by `callId`/timestamp.
- Extend `convert.ts` to preserve `todo`, `compaction`, `notification`, `error`, and `plugin` items, and cluster overlapping tool calls into `kind: "parallel"`.

#### P1-4: Enhanced Prompt Matching, Streaming Tool Updates & `output_schema` / `tool_policy`
- Extend `expect` to support `{ regex, contains, command, hasAttachment, mode }`, unordered rule matching, and regex capture groups (`{{match.1}}`).
- Support `updates: [{ delayMs, detail }]` on `ToolSpec` to stream incremental `running` updates for the same `callId`.
- Declare `"prompt.output_schema"` and `"permission.tool_policy"` (auto-skipping permission cards matching `config.toolPolicy.preapproved`).

---

### P2 — Dual-Mode Harness Phase 2 (`shell`), Subsessions, Revert & Multi-Provider Faults

- **P2-1 (`shell` Execution Scope)**: Opt-in real child process execution in `session.cwd` with `session.config.env`, throttled streaming `detail.output`, real `exitCode`, timeout, and `AbortSignal` `tree-kill`.
- **P2-2 (`session.subsession`)**: Spawn linked child sessions (`parentSessionId`, `toolCallId`, `restoration: "parent"`) when a `sub_agent` tool specifies `spawnScenario`.
- **P2-3 (`session.revert.*`, `session.list`, `session.archive`/`unarchive`)**: Deterministic `revertToken` handling for conversation and sandboxed `fs` snapshots, plus session listing and archive lifecycle.
- **P2-4 (Multi-Provider Aliases & `status()` Fault Injection)**: Register multiple named Scripted provider aliases and dynamically toggle `status().available` to test cross-provider Playbooks fallback chains.
