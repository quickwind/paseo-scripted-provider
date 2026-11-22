---
status: accepted
---

# Align TypeScript types to Paseo 0.16.2 while maintaining >=0.12.0 daemon compatibility via runtime negotiation

We will upgrade root `@getpaseo/plugin` and `@getpaseo/client` devDependencies to `0.16.2` while keeping `requirements.paseo` at `>=0.12.0` (matching `testkit`). Because `0.12.0` and `0.16.2` share ~98% of the provider protocol and use Zod `.strip()` on outbound event schemas, ~15 lines of runtime compatibility code let a single plugin release work across all `0.12.x–0.16.x+` daemons.

## Considered Options

- **Drop older daemons and bump `requirements.paseo` to `>=0.16.0`**: Rejected because third-party plugin repositories pinned to Paseo `0.12–0.15` would be locked out of newer `paseo-scripted-provider` releases, while the actual runtime delta between `0.12` and `0.16` is tiny.

## Consequences

- `connect(request)` must negotiate capabilities dynamically via `negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES)` so older daemons never receive unknown capabilities such as `"session.can_stop_runtime"`.
- Outbound `session.config` events must dual-write `0.16` fields (`controls`, `providerOptions`) alongside `settings` (at minimum `settings: []`), because `settings` is a required field in `0.12.0`'s `configStateSchema` and would otherwise fail Zod validation.
- Inbound `session.configure` handlers must merge both `changes.providerOptions` and `changes.settings`.
- Optional host server APIs (such as `server.registerUsageSource`) must be guarded with runtime feature checks (`typeof server.registerUsageSource === "function"`).
