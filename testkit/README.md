# paseo-scripted-provider-testkit

Cross-platform test helpers for [Paseo](https://paseo.sh) plugin end-to-end testing with deterministic, model-free scripted agent providers.

Part of [paseo-scripted-provider](https://github.com/quickwind/paseo-scripted-provider).

## Features

- **Isolated Daemon**: Spawns a real Paseo daemon on a free port in a temporary sandbox.
- **Zero Pollution**: Never touches your real `~/.paseo` or global environment.
- **Version-Decoupled**: Declares `@getpaseo/cli`, `@getpaseo/client`, and `@getpaseo/server` as `peerDependencies` (`>=0.12.0`), so your plugin repo controls the exact Paseo version (e.g., `0.16.2`).
- **Third-Party Plugin Ready**: Install your own plugin alongside `paseo-scripted-provider` (`extraPlugins`), pass custom daemon environment variables (`extraEnv`), and collect custom artifact directories on teardown (`extraCollect`).
- **Cross-Platform**: Node.js only (macOS, Linux, Windows), with no platform-specific shell scripts.
- **Deterministic E2E**: Test agent outputs, tool calls, permission cards, streaming chunks, and failure states deterministically without calling real LLMs.

## Installation

Install `paseo-scripted-provider-testkit` together with the Paseo packages your plugin targets (and optionally `paseo-scripted-provider` itself if you want zero network calls in CI):

```bash
npm install -D paseo-scripted-provider-testkit paseo-scripted-provider \
  @getpaseo/cli @getpaseo/client @getpaseo/server
```

Requires Node.js `>= 22` and Paseo `>= 0.12.0`.

## Quick Example

```javascript
import assert from "node:assert/strict";
import { startScriptedEnv } from "paseo-scripted-provider-testkit";

const env = await startScriptedEnv({
  // Use "./node_modules/paseo-scripted-provider" for offline CI, or "npm" to install from the registry.
  pluginSource: "./node_modules/paseo-scripted-provider",
  script: {
    scenarios: {
      greet: [
        { text: "hello from script" },
        { text: "second reply" }
      ]
    }
  }
});

// Create agent and wait for completion
const agent = await env.createAgent({ scenario: "greet", prompt: "first" });
await env.waitForFinish(agent.id);

// Assert received messages recorded by the provider
const prompts = env.readRecord().filter((r) => r.kind === "prompt");
assert.equal(prompts[0].text, "first");

// Clean up
await env.stop();
```

## Testing a Third-Party Paseo Plugin

Use `extraPlugins`, `extraEnv`, and `extraCollect` to run your own Paseo plugin alongside `paseo-scripted-provider` inside the isolated daemon:

```javascript
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { startScriptedEnv } from "paseo-scripted-provider-testkit";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-e2e-"));

const env = await startScriptedEnv({
  // Local path to paseo-scripted-provider (avoids npm registry access in CI)
  pluginSource: path.resolve("node_modules/paseo-scripted-provider"),
  // Install the plugin under test; specifying `id` asserts it reaches status === "running"
  extraPlugins: [
    { source: path.resolve("."), id: "paseo-permission-guardian" },
  ],
  // Merged *after* PASEO_* env stripping so custom PASEO_* variables reach the daemon
  extraEnv: {
    PASEO_GUARDIAN_DATA_DIR: dataDir,
  },
  // Copied into outDir when setup fails (with E2E_OUT) or on env.stop({ outDir })
  extraCollect: {
    "guardian-data": dataDir,
  },
  script: {
    scenarios: {
      approval: [
        {
          tools: [
            {
              name: "Bash",
              detail: { type: "shell", command: "rm -rf build" },
              permission: {
                on: {
                  accept: { text: "allowed" },
                  reject: { text: "denied: {{permission.message}}" },
                },
              },
            },
          ],
          text: "after",
        },
      ],
    },
  },
});

const agent = await env.createAgent({ scenario: "approval", prompt: "clean up" });

// 1. Wait for the permission card
const card = await env.waitForPermission(agent.id);

// 2. Respond to it (accepts either the card object or card.requestId)
await env.respondToPermission(agent.id, card, {
  behavior: "deny",
  selectedActionId: "reject",
  message: "Denied by user",
});

// 3. Poll for the assistant replies (avoids Windows async flush races after waitForFinish)
await env.waitForAssistantTexts(agent.id, ["denied: Denied by user", "after"]);

// 4. Inspect recorded permission events
const answer = env.readRecord().find((r) => r.kind === "permission_response");
assert.equal(answer.branch, "reject");

await env.stop({ outDir: process.env.E2E_OUT });
```

## API Reference

### `startScriptedEnv(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `script` | `object` | `undefined` | Script definition written to `scenarios.json`. |
| `pluginSource` | `"local" \| "npm" \| string` | `"local"` | `"local"` stages from this monorepo; `"npm"` installs from the registry; any other path (or `npm:...` spec) installs directly from that source. |
| `pluginVersion` | `string` | `""` | Version suffix when `pluginSource: "npm"`. |
| `extraPlugins` | `Array<string \| { source: string; id?: string }>` | `[]` | Additional plugins installed after `paseo-scripted-provider`. When `id` is provided, verifies `status === "running"`. Also fails if any installed plugin is in `"error"` state. |
| `extraEnv` | `Record<string, string>` | `{}` | Extra environment variables passed to the daemon and CLI, merged **after** `PASEO_*` isolation filtering. |
| `extraCollect` | `Record<string, string> \| string[]` | `undefined` | Extra files/directories copied into `outDir` on setup failure (`E2E_OUT`) or `env.stop({ outDir })`. |
| `cliEntry` | `string` | auto-resolved | Custom path to `@getpaseo/cli/dist/index.js` (or a `paseo` executable). |
| `appVersion` | `string` | `@getpaseo/client` version | Override the `appVersion` sent by `DaemonClient`. |
| `enableProviders` | `string[]` | `[]` | Built-in Paseo providers to leave enabled. |
| `providerConfigs` | `Record<string, object>` | `{}` | Extra `agents.providers` entries merged into `config.json`. |
| `timeScale` | `number` | `E2E_TIME_SCALE ?? 1` | Multiplier for CI timeouts. |
| `keep` | `boolean` | `false` | Keep the temporary workspace directory after `stop()`. |
| `realHome` | `boolean` | `false` | Preserve the host `HOME`/`XDG_*` variables for real provider CLIs. |

### `env` Methods

- `env.createAgent({ scenario, prompt, title })` — Creates an agent on `scripted/<scenario>`.
- `env.waitForFinish(agentId, timeoutMs?)` — Waits for the agent's active turn to finish.
- `env.timeline(agentId)` — Fetches projected timeline entries.
- `env.assistantTexts(agentId)` — Returns all `assistant_message` texts from the timeline.
- `env.waitForPermission(agentId, { timeoutMs?, pollMs?, predicate? })` — Polls until a pending permission card appears and returns `{ ...card, requestId }`.
- `env.respondToPermission(agentId, requestIdOrCard, response)` — Sends a permission response.
- `env.waitForAssistantTexts(agentId, expected, { timeoutMs?, pollMs? })` — Polls `assistantTexts` until it equals `expected` (array) or satisfies `expected(texts)` (predicate).
- `env.readRecord()` — Parses `received.jsonl` (`prompt`, `permission_requested`, `permission_response`, `permission_canceled`, `permission_unknown`, etc.).
- `env.restart(label?)` — Restarts the daemon and reconnects the client.
- `env.stop({ outDir?, extraCollect? })` — Closes client, stops daemon, optionally collects logs + `extraCollect`, and cleans up the sandbox.

## License

[MIT](https://github.com/quickwind/paseo-scripted-provider/blob/main/LICENSE)
