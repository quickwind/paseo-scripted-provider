[![CI](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fquickwind%2Fpaseo-scripted-provider%2Fbadges%2Ftests.json)](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fquickwind%2Fpaseo-scripted-provider%2Fbadges%2Fcoverage.json)](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/ci.yml)
[![Snyk](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fquickwind%2Fpaseo-scripted-provider%2Fbadges%2Fsnyk.json)](https://github.com/quickwind/paseo-scripted-provider/actions/workflows/security.yml)
[![license: MIT](https://img.shields.io/github/license/quickwind/paseo-scripted-provider)](LICENSE)
[![Paseo](https://img.shields.io/badge/paseo-%3E%3D0.11.0%20%3C0.12-blue)](#compatibility)

# paseo-scripted-provider

A [Paseo](https://paseo.sh) plugin that adds an agent backend called **Scripted**. It calls no model: it answers from a script you write, or from a script **recorded from a real session** (with secrets redacted).

Use it to

- **test your own Paseo plugin by hand**: see exactly how your UI reacts to a long reply, a streamed reply, a failed or canceled turn, tool calls, a reply split into several messages;
- **run deterministic, free, repeatable end-to-end tests in CI** against a real Paseo daemon (a cross-platform [testkit](#testkit) is included);
- **reproduce a bug report**: record the session, redact it, replay it anywhere with no API key.

## Install

Requires Paseo `>=0.11.0 <0.12.0` and plugins enabled in the daemon config (`"pluginsEnabled": true` at the top level of `config.json`; without it `paseo plugin install` leaves the plugin disabled).

```bash
git clone https://github.com/quickwind/paseo-scripted-provider
paseo plugin install ./paseo-scripted-provider
```

The daemon compiles the plugin itself; there is nothing to build.

## Quick start

1. Create an agent, choose provider **Scripted**, and pick a scenario as the model (`chat`, `long-output`, `fail`, `cancel`, `slow-stream`, `tools-demo`, `default`, or your own).
2. Chat. Every message you send advances the scenario by one reply; the last reply repeats.
3. Send `SCENARIO:<name>` as a message to switch scenario mid-chat (that message already gets the new scenario's first reply).

Open **Settings → Scripted provider** to paste your own script, point at a script file, set a log file for received messages, and see why a script was rejected (invalid scripts never break the provider; the built-ins stay available).

Slash commands (conveniences over normal messages): `/scripted-next` sends `(next)` to advance one step; `/scripted-reset [scenario]` sends `SCENARIO:<scenario or current model>`.

## Script format

YAML or JSON (the format is detected from the text). Scenarios are lists of replies; the agent answers each incoming message with the next reply. YAML is nicer for hand-written scripts: comments, and multi-line replies as `|` blocks instead of `\n` escapes.

```yaml
# the same script in YAML
macros:
  BAD_FORM: |
    ```form
    {...}
    ```
scenarios:
  bad-then-good:
    - text: "@BAD_FORM"
    - text: Fixed.
```

The same in JSON:

```jsonc
{
  "macros": { "BAD_FORM": "```form\n{...}\n```" },
  "scenarios": {
    "bad-then-good": [{ "text": "@BAD_FORM" }, { "text": "Fixed." }],
    "slow-fail": [{ "text": "partial...", "startDelayMs": 1500, "outcome": "failed", "error": "boom" }],
    "tools": [{
      "tools": [
        { "name": "Bash", "detail": { "type": "shell", "command": "npm test", "output": "3 passed", "exitCode": 0 }, "runningMs": 800 },
        { "name": "Edit", "detail": { "type": "edit", "filePath": "src/a.ts" }, "status": "failed", "error": "conflict" }
      ],
      "text": "Tests pass; the edit conflicted."
    }]
  }
}
```

| Reply field | Meaning |
|---|---|
| `text` | one complete assistant message |
| `chunks` + `chunkDelayMs` | one message streamed in pieces (same message id, growing text) |
| `messages` + `toolBetween` | several separate messages, optionally with a tool call between them |
| `reasoning` | a reasoning item before the answer |
| `tools[]` | display-only tool calls: `name`, `detail` (Paseo tool-detail object: `shell`, `read`, `edit`, `write`, `search`, `fetch`, `plain_text`, …), `status` (`running`/`completed`/`failed`/`canceled`), `runningMs`, `error`. **Nothing is ever executed.** |
| `startDelayMs` / `delayMs` | wait before the reply starts / before the turn ends (makes races reproducible) |
| `outcome` | `completed` (default), `failed`, `canceled`, or `hang` (stay running until interrupted) |
| `error` | message for a `failed`/`canceled` outcome |
| `expect` | the user message this step expects (set by recordings); see *alignment* |
| `@NAME` | a whole-string `text`/`chunks`/`messages` value equal to `@NAME` expands the macro `NAME` |

Invalid scripts, unknown scenario names and malformed tool details never stall a turn: the provider falls back to the built-ins (the settings page shows the problem) and a turn that cannot continue ends as `failed`. Tool `detail` objects are validated against Paseo's own tool-detail shapes when the script loads.

Behaviour worth knowing: an interrupt ends the active turn as `canceled`; a new message while a turn is running supersedes it (the old turn is canceled exactly once); unknown scenario names fall back to `default`; scripts restore their step after a daemon restart.

**Alignment** (setting): when a step has `expect` and the incoming message differs — `warn` (default) records a `mismatch` and continues, `strict` fails that prompt with code `E_SCRIPT_MISMATCH`, `ignore` doesn't check.

## Received-messages log

Set a log file in settings (or run with `SCRIPTED_PROVIDER_STATE=<dir>`, which uses `<dir>/scenarios.json` and `<dir>/received.jsonl`). One JSON line per event: `open`, `prompt` (text, `delivery`, `step`, `scenario`, `activeTurnAtArrival`, `clientMessageId`), `interrupt`, `mismatch`. Assert on it in tests; view the tail in the settings page.

## Record a session as a script

Every conversation gets a **Record as script** button (clapperboard icon) next to the message box; it records that conversation.

1. Choose a name, how many recent turns, what to do with timing (keep / scale ×k / remove), whether to include reasoning and tool output, and a truncation length.
2. **Preview & redact.** Each step is shown with automatic replacements highlighted:
   - formatted secrets are replaced: AWS keys, GitHub tokens, `sk-…` keys, Slack tokens, JWTs, PEM private keys, `Bearer` tokens, URL passwords, email addresses, the user name in `/Users/x`, `/home/x`, `C:\Users\x`, and the session's working directory (`{{cwd}}`);
   - what a value is replaced with: secrets `{{secret_N}}`, the user name in a home path `{{user_N}}`, the working directory `{{cwd}}`, values you redact by hand `{{redacted_N}}`, and email addresses `{{email_N}}`; the same value always gets the same replacement, so references stay consistent;
   - colors in the review: orange = the selected item, yellow = looks like a secret and needs your decision, green = replaced automatically, gray = you kept it, red = original restored (it will be exported);
   - tap a highlight to restore the original; **Edit** a step; select text while editing and **Redact selection** to replace that value everywhere;
   - high-entropy strings no rule recognized are *listed, never changed*: you must confirm each (**Redact** or **Keep**) before export is enabled.
3. Choose **YAML** (default) or **JSON**, then **Download** (web/desktop) or **Copy to clipboard** (mobile), or **Replay now** to save the scenario into your settings and open a Scripted agent running it.

> **Redaction is best effort.** It cannot find names, customer data or business secrets. Read every step before you share or commit the file. The plugin uploads nothing.

The file and the inline script in settings are merged (inline wins), so *Replay now* never hides your script file.

Known limitation: inside a recorded turn, tool calls are replayed before the messages (their relative order is not preserved).

## Testkit

`testkit/` is a small Node-only (no shell, Windows-safe) helper to start an isolated daemon, install this plugin and drive agents. See [`e2e/scripted.e2e.test.mjs`](e2e/scripted.e2e.test.mjs) for a complete example.

The testkit is used from a clone of this repository (it is not published to npm yet): `npm ci --prefix testkit`, then import it by relative path.

```js
import { startScriptedEnv } from "./testkit/index.mjs";
const env = await startScriptedEnv({ script: { scenarios: { hi: [{ text: "hello" }] } } });
const agent = await env.createAgent({ scenario: "hi", prompt: "x" });
await env.waitForFinish(agent.id);
console.log(env.readRecord());      // parsed received.jsonl
await env.stop();
```

It picks a free port, uses a temp `--home` plus fake `HOME`/`USERPROFILE`, disables the built-in providers (enable some with `enableProviders: ["opencode"]`), sets `pluginsEnabled`, and never touches your real `~/.paseo`.

## Compatibility

| Paseo | Status |
|---|---|
| 0.11.x (tested on 0.11.4) | supported |
| other | not tested |

The provider protocol is an internal Paseo interface and may change between versions. CI runs the real-daemon e2e on Ubuntu, macOS and Windows against the pinned Paseo version.

Plugin layout follows the daemon's rules: `server/` (Node-only code), `shared/` (platform-neutral, also bundled for the client), `client/`.

## Development

```bash
npm ci
npm run typecheck
npm test                 # unit + integration (vitest)
npm run test:coverage    # + coverage gate (85% lines) → reports/
npm ci --prefix testkit && npm run e2e     # real Paseo daemon
npm run verify:real      # local only: real opencode / devin sessions → recording round-trip
```

## Roadmap

Permission-approval flows, real MCP calls from scripts, template variables, prompt-matching rules, persisted custom redaction rules, a published testkit package.

## Third-party code

`shared/vendor/yaml.js` is the [`yaml`](https://github.com/eemeli/yaml) package (ISC, `shared/vendor/yaml.LICENSE`) bundled into one file. The Paseo daemon compiles plugins itself and only provides its plugin SDK and `zod`, so a dependency has to ship inside the plugin; a committed bundle means installing needs no npm and no network. Regenerate with `npm run vendor:yaml` (a test checks the bundle matches the `yaml` version in `package.json`).

## License

[MIT](LICENSE) © 2026 quickwind
