# AGENTS.md

Guidance for AI coding agents and contributors working in `paseo-scripted-provider`.

## Project Overview

`paseo-scripted-provider` is a [Paseo](https://paseo.sh) plugin that adds a deterministic, model-free agent backend named **Scripted**. Instead of invoking LLMs, it replies according to user-defined JSON/YAML scripts, and provides a session-to-script recorder with built-in secret redaction.

It also ships a companion npm package, `paseo-scripted-provider-testkit`, located under [`testkit/`](testkit/).

## Repository Layout

- `server/`: Node.js-only daemon plugin lifecycle, provider registration, session orchestration, and event recording.
- `client/`: Plugin UI components (React / React Native Web) for settings, conversation recording popover, and redaction review screen.
- `shared/`: Platform-neutral pure TypeScript logic shared between server and client:
  - `shared/core/schema.ts`: Zod schemas for scripts, replies, and display-only tool calls.
  - `shared/core/script.ts`: Script parsing, macro expansion (`@MACRO`), and scenario merging.
  - `shared/core/capture/`: Session timeline conversion, secret redaction (`redact.ts`), and script export.
  - `shared/vendor/`: Committed esbuild bundle of `yaml`. Generated via `npm run vendor:yaml`. **Do not edit manually.**
- `testkit/`: Standalone helper library for spawning isolated real Paseo daemons on dynamic ports with sandboxed home directories.
- `e2e/`: Real-daemon end-to-end integration tests driven by `testkit`.

## Key Commands

```bash
# Type checking
npm run typecheck

# Unit and integration tests (Vitest)
npm test

# Test coverage (enforces >= 85% line coverage)
npm run test:coverage

# Real-daemon E2E tests (requires testkit dependencies installed)
npm ci --prefix testkit && npm run e2e

# Regenerate vendored YAML bundle
npm run vendor:yaml
```

## Architectural Guidelines

1. **Display-Only Simulated Tools (Layer 1)**:
   - Tool calls inside scripted replies (`tools[]`) are for UI display and status verification only.
   - Never attempt to actually execute tools or shell commands from scripted steps.

2. **Deterministic Timing**:
   - `planner` creates flat execution steps; `session` executes them via an injected `Clock` interface.
   - In unit tests, always use `ManualClock` (from `test/helpers/manual-clock.ts`) rather than real `setTimeout` to ensure fast, deterministic tests.

3. **Safe Redaction Rules**:
   - The `Redactor` maps detected secrets and credentials to consistent deterministic placeholders (`{{secret_N}}`, `{{user_N}}`, `{{cwd}}`).
   - Never bypass confirmation requirements for high-entropy tokens in `state.ts`.

4. **Zero State Pollution in E2E**:
   - E2E tests must always use `testkit` to spawn daemons with isolated `HOME` and `USERPROFILE` directories.
   - Never modify or rely on the host's global `~/.paseo` state.
