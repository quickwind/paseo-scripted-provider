---
status: accepted
---

# Evolve a single Script DSL instead of adding a separate Protocol Trace format

We will cover all Paseo `ProviderTimelineItem` types, session events, and step-level streaming by extending the existing `ScriptSchema` (`Reply` shorthands + ordered `steps[]`), rather than introducing a second low-level "Protocol Trace" script format. `steps[]` is already a timed, ordered event stream compiled to `Action[]` by `planner.ts`, so extending `Step.kind` achieves lossless protocol replay without duplicating schemas, macro expansion, redaction review UI, or test coverage.

## Considered Options

- **Split into two formats (editable Script DSL + lossless Protocol Trace DSL)**: Rejected because maintaining two parsers, two Zod schemas, two session executors, and a lossy compiler between them would double maintenance cost and bloat client review state.

## Consequences

- `steps[]` becomes a strict superset of top-level `Reply` fields (including `chunks` on `message` and `reasoning` steps, plus `todo`, `compaction`, `notification`, `error`, and `plugin` steps).
- Protocol fuzzing or intentionally malformed wire payloads belong in isolated in-memory unit tests, not in the user-facing `ScriptSchema`.
