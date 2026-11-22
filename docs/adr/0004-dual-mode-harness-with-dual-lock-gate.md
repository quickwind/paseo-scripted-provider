---
status: accepted
---

# Use a Dual-Mode Harness (Display vs. Execute) protected by a Dual-Lock safety gate

We model the provider as a deterministic **Scripted Brain** driving a **Dual-Mode Harness** that uses the exact same `ToolSpec` schema for both `Display Mode` (default, UI-only) and `Execute Mode` (opt-in real execution for `fs`, `mcp`, and `shell` scopes). To ensure recorded real-world sessions containing destructive commands (such as `rm -rf`) can never execute accidentally, `Execute Mode` requires a **Dual-Lock**: the host must authorize the tool's `Execution Scope` (`allowExecution` / `SCRIPTED_ALLOW_EXECUTION`, defaulting to `[]`) AND the script must explicitly set `execute: true` (which the recorder never emits).

## Considered Options

- **In-memory Virtual Filesystem (VFS) + static Mock MCP table**: Rejected because Paseo's Git Diff stream, worktree status checks, and file-watching plugins read the real OS filesystem at `session.cwd`, making an in-plugin VFS invisible to the daemon; similarly, a static mock table cannot test a real MCP server injected by a plugin under test.
- **Separate side-effect primitives (`workspaceOps` + standalone `mcp_tool`)**: Rejected because bypassing `ToolSpec` splits the DSL and prevents testing the full real-agent lifecycle: `Permission Card` → `deny` blocks execution or `allow` with `updatedInput` rewrites parameters → real execution → timeline backfill → `onResult` branching.

## Consequences

- `Display Mode` remains the unconditional default; `convert.ts` must never emit `execute: true`.
- `fs` execution is strictly confined to `session.cwd` via `fs.realpathSync` checks to prevent path traversal and symlink escapes.
- `mcp` execution connects only to servers registered in the active session's `config.mcpServers`.
- `shell` execution (Phase 2) is isolated behind its own scope, inherits `session.config.env`, and binds to turn `AbortSignal` and timeout (`tree-kill`).
- Every real execution emits a `tool_executed` entry to `received.jsonl` and exposes `{{tool.output}}`, `{{tool.exitCode}}`, and `{{tool.error}}` for subsequent steps and `onResult` branches.
