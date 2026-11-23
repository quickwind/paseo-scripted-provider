**Language:** English | [简体中文](OVERVIEW.zh-CN.md)

# Scripted Provider

**Scripted Provider** adds a deterministic, model-free agent backend (`Scripted`) to [Paseo](https://paseo.sh). Write replies, streaming chunks, display-only tool calls, and interactive permission/question cards in YAML or JSON — or click **Record as script** on any real conversation to export a replayable script with automatic secret redaction (`{{secret_N}}`, `{{cwd}}`, `{{email_N}}`).

## Key Features

- **Zero LLM calls, zero API keys** — Replies come from built-in scenarios (`chat`, `long-output`, `slow-stream`, `tools-demo`, `fail`, `cancel`, `default`) or your own YAML/JSON scripts.
- **Interactive permission & question cards** — Test approval flows, custom action buttons, `AskUserQuestion` cards, plan approvals, and parallel card groups deterministically. Nothing is ever executed on disk.
- **Record & redact real sessions** — Capture any live Claude, Codex, or OpenCode conversation on desktop/web, review auto-redacted secrets and high-entropy tokens, and export YAML/JSON or click **Replay now**.
- **Isolated CI testkit** — Ships with `paseo-scripted-provider-testkit` to spin up isolated Paseo daemons on dynamic ports across Linux, macOS, and Windows.

## Quick Start

1. Create an agent with provider **Scripted** and choose a scenario as the model.
2. Send messages to advance step by step, or send `SCENARIO:<name>` to switch mid-chat.
3. Open **Settings → Scripted provider** to edit scripts, set an optional `received.jsonl` log file, and configure prompt alignment (`warn` / `strict` / `ignore`).

## Optional Event Log vs. Redacted Export

- **Optional Event Log (`received.jsonl`)**: Disabled by default unless configured in settings or `SCRIPTED_PROVIDER_STATE`. When enabled, it appends raw JSONL records of inbound session lifecycle events (`open`, `configure`, `close`, `prompt` text and attachment metadata, `mismatch`, `exhausted`) for test assertions and debugging. Credential-bearing session fields (`env` and `mcpServers`) are omitted (only key/server names are recorded), and unlike the script exporter, this log does **not** run the interactive `Redactor` over prompt text.
- **Redacted Script Export (`Record as script`)**: Captures a conversation timeline and runs the `Redactor` to detect and replace secrets, high-entropy tokens, working directories (`{{cwd}}`), and emails (`{{email_N}}`) with deterministic placeholders before exporting shareable YAML/JSON scripts.
