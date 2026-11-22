---
status: accepted
---

# Use a provider-level delayScale multiplier instead of a cross-process virtual clock for daemon E2E

Unit and integration tests continue to use injected `ManualClock` for deterministic zero-wait execution, while real-daemon E2E tests speed up timed or recorded scripts via a provider-level `delayScale` setting (`SCRIPTED_PROVIDER_DELAY_SCALE`, e.g., `0` or `0.01`) paired with event/condition waiters in `testkit` (`waitForRecord`, `waitForTimeline`). We do not introduce a cross-process controllable virtual clock (`advanceTime()`) across the daemon boundary.

## Considered Options

- **Cross-process virtual clock (`advanceTime()` RPC) in daemon E2E**: Rejected because the Paseo daemon runs in a separate OS process with its own WebSocket heartbeats, reconnect backoff timers, and request timeouts; stepping a virtual clock across processes adds fragile synchronization coupling for minimal gain over `delayScale`.

## Consequences

- Recorded scripts with multi-second real pacing can run in milliseconds in CI while preserving exact step ordering and real daemon networking behavior.
- `testkit` assertions should rely on `waitForRecord` / `waitForTimeline` / `waitForPermission` rather than fixed `sleep()` calls.
