#!/usr/bin/env node
// Guards the client bundle: the YAML parser must stay on the daemon.
//
// The plugin client bundle is evaluated by Hermes on iOS. Shipping the 98 kB YAML library there
// made the mobile app evaluate a minified parser at plugin load; that is where the iOS client
// failed with "Cannot set property 'defaultYaml' of undefined". The daemon owns the parser and
// the client asks for the result over RPC, so the client bundle must not contain YAML at all.
//   node scripts/check-client-bundle.mjs
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The same modules the Paseo daemon leaves external when it compiles a plugin.
const EXTERNAL = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
  "@tanstack/react-query",
];

// Markers of the vendored yaml library (shared/vendor/yaml.js).
const YAML_MARKERS = ["defaultYaml", "defaultTags", "yaml.alias", "yaml.document"];

/** The client bundle of the plugin, compiled the way the daemon compiles it. */
export async function buildClientBundle() {
  const result = await build({
    entryPoints: [path.join(root, "index.client.tsx")],
    bundle: true,
    format: "cjs",
    platform: "browser",
    mainFields: ["module", "main"],
    external: EXTERNAL,
    target: "es2020",
    write: false,
  });
  return result.outputFiles[0].text;
}

export function findYamlMarkers(code) {
  return YAML_MARKERS.filter((marker) => code.includes(marker));
}

async function main() {
  const code = await buildClientBundle();
  const markers = findYamlMarkers(code);
  if (markers.length) {
    console.error("the client bundle must not contain the YAML parser (the daemon owns it)");
    for (const marker of markers) console.error(`  - found ${marker}`);
    process.exit(1);
  }
  console.log(`client bundle is YAML-free (${Math.round(code.length / 1024)} kB)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
