#!/usr/bin/env node
// Starts an isolated Paseo daemon with this plugin installed and a demo agent, then keeps running.
// For trying the UI by hand: connect any Paseo client to the printed host. Ctrl+C stops and cleans up.
import { startScriptedEnv } from "../testkit/index.mjs";

const env = await startScriptedEnv({ script: { scenarios: { demo: [{ text: "Hello from the script" }, { text: "Second reply, with a secret ghp_" + "a".repeat(36) }] } }, keep: false });
const agent = await env.createAgent({ scenario: "demo", prompt: "hi", title: "demo (scripted)" });
await env.waitForFinish(agent.id);
await env.api.agents.ref(agent.id).run("and again, my email is qa-test@example.com");
console.log(`daemon: 127.0.0.1:${env.daemon.port}\nhome:   ${env.ws.paseoHome}\nagent:  ${agent.id}\nCtrl+C to stop`);
const stop = async () => { await env.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
