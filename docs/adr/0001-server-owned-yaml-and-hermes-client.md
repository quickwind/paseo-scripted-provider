---
status: accepted
---

# Keep YAML parsing on the server and keep the client bundle Hermes-compatible

The Paseo iOS app evaluates plugin client bundles with Hermes, which broke on the minified `yaml` parser and does not support ES classes or async arrow functions emitted by esbuild. Therefore, all YAML parsing and serialization live exclusively on the daemon server side (exposed to the client via `scripted.export` and `scripted.merge-scenario` RPCs), and all code reachable from `index.client.tsx` must use plain functions and `async function` expressions.

## Considered Options

- **Bundle `yaml` in the client**: Rejected because the ~98 kB minified parser crashed the Paseo iOS Hermes engine at load time.
- **Transpile client code with Babel/Metro**: Rejected because Paseo daemon compiles plugin TypeScript directly with its own esbuild pipeline.

## Consequences

- `npm run check:client-bundle` and `npm run check:hermes` are mandatory CI gates.
- New server-side features (template hydration, harness execution, protocol state machines, usage sources) must live under `server/` or server-only `shared/core/` modules and never be imported from `index.client.tsx`.
