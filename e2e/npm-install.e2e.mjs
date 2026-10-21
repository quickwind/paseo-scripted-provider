// Verifies the *published* plugin: installs it from the npm registry into a real Paseo daemon and
// runs a scenario. This is the only check that proves the tarball a user installs actually works.
//
// Not part of "npm run e2e": it needs the registry, and the published version always lags the
// working copy. Run it explicitly:
//   npm run e2e:npm
//   E2E_NPM_VERSION=0.1.1 npm run e2e:npm
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { startScriptedEnv, NPM_PACKAGE } from "../testkit/index.mjs";

const SCRIPT = { scenarios: { greet: [{ text: "hello from npm" }] } };
// A release tag ("v0.1.1") and an npm version ("0.1.1") are the same thing here.
const VERSION = (process.env.E2E_NPM_VERSION ?? "").replace(/^v/, "");

function publishedVersion(spec) {
  try {
    return execFileSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** The registry needs a moment to serve a freshly published version. */
async function waitForPublishedVersion(spec, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = publishedVersion(spec);
    if (version) return version;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${spec} is not available on the registry after ${timeoutMs}ms`);
}

let env;
before(async () => {
  const spec = VERSION ? `${NPM_PACKAGE}@${VERSION}` : NPM_PACKAGE;
  const resolved = await waitForPublishedVersion(spec);
  console.log(`[npm-e2e] installing ${spec} (registry reports ${resolved})`);
  env = await startScriptedEnv({ script: SCRIPT, pluginSource: "npm", pluginVersion: VERSION });
});
after(async () => {
  await env?.stop({ outDir: process.env.E2E_OUT });
});

describe("plugin installed from the npm registry", () => {
  it("is running and answers a scripted scenario", async () => {
    const listed = JSON.parse(env.daemon.cli(["plugin", "ls", "--json"]).stdout);
    const me = listed.find((p) => p.id === "paseo-scripted-provider");
    assert.equal(me?.status, "running", JSON.stringify(listed));
    assert.equal(me?.installation?.identity?.kind, "npm", JSON.stringify(me?.installation));

    const agent = await env.createAgent({ scenario: "greet", prompt: "hi" });
    await env.waitForFinish(agent.id);
    const texts = (await env.timeline(agent.id)).filter((e) => e.item?.type === "assistant_message").map((e) => e.item.text);
    assert.deepEqual(texts, ["hello from npm"]);
  });
});
