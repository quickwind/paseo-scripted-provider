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

Requires Node.js `>= 22` and Paseo `>= 0.11.0`.

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

## Testing permission cards

A scripted reply can raise a real permission card and branch on the answer (see [Permission cards](https://github.com/quickwind/paseo-scripted-provider#permission-cards) for the script format). To drive one from a test, wait for the card to appear, answer it through the API, then check the replies and the recorded answer:

```js
import assert from "node:assert/strict";
import { startScriptedEnv } from "paseo-scripted-provider-testkit";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = await startScriptedEnv({
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
const replies = async () =>
  (await env.timeline(agent.id)).filter((e) => e.item?.type === "assistant_message").map((e) => e.item.text);

// 1. Wait for the card to be raised.
let card;
for (let i = 0; i < 100 && !card; i++) {
  const ref = env.api.agents.ref(agent.id);
  await ref.refresh();
  card = ref.pendingPermissions?.[0];
  if (!card) await sleep(100);
}
assert.ok(card, "the permission card never appeared");

// 2. Answer it. `behavior` is "allow" or "deny"; `selectedActionId` picks a branch by button id.
await env.api.agents.ref(agent.id).respondToPermission({
  requestId: card.request?.id ?? card.id,
  response: { behavior: "deny", selectedActionId: "reject", message: "Denied by user" },
});

// 3. Wait for the replies: waitForFinish can return before the answered turn has written them.
for (let i = 0; i < 100 && (await replies()).length < 2; i++) await sleep(100);
assert.deepEqual(await replies(), ["denied: Denied by user", "after"]);

// 4. The recorder keeps every card and answer, including the branch that was taken.
const answer = env.readRecord().find((r) => r.kind === "permission_response");
assert.equal(answer.branch, "reject");

await env.stop();
```

The recorder writes `permission_requested`, `permission_response`, `permission_canceled` and `permission_unknown` events. Branch selection, variables and early-end cleanup are described in the main README.

## License

[MIT](https://github.com/quickwind/paseo-scripted-provider/blob/main/LICENSE)
