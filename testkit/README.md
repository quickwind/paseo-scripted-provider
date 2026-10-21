# paseo-scripted-provider-testkit

Cross-platform test helpers for [Paseo](https://paseo.sh) plugin end-to-end testing with deterministic, model-free scripted agent providers.

Part of [paseo-scripted-provider](https://github.com/quickwind/paseo-scripted-provider).

## Features

- **Isolated Daemon**: Spawns a real Paseo daemon on a free port in a temporary sandbox.
- **Zero Pollution**: Never touches your real `~/.paseo` or global environment.
- **Cross-Platform**: Node.js only (macOS, Linux, Windows), with no platform-specific shell scripts.
- **Deterministic E2E**: Test agent outputs, tool calls, streaming chunks, and failure states deterministically without calling real LLMs.

## Installation

```bash
npm install -D paseo-scripted-provider-testkit
```

Requires Node.js `>= 22` and Paseo `>= 0.11.0 < 0.13.0`.

## Quick Example

```javascript
import assert from "node:assert/strict";
import { startScriptedEnv } from "paseo-scripted-provider-testkit";

const env = await startScriptedEnv({
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

## License

[MIT](https://github.com/quickwind/paseo-scripted-provider/blob/main/LICENSE)
