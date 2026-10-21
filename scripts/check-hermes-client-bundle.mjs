#!/usr/bin/env node
// Compiles the plugin's client bundle with Hermes, the engine the Paseo mobile app runs.
//
// The client bundle is evaluated by Hermes on iOS. Hermes has no class expressions, and esbuild
// emits `var X = class {}` for every class it bundles - which made the iOS app fail to even compile
// the plugin ("Invalid expression encountered"). Node, Chrome and the web client all accept it, so
// only Hermes tells the truth.
//
//   node scripts/check-hermes-client-bundle.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientBundle } from "./check-client-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The Hermes compiler that ships with react-native, for the current platform. */
export function hermescPath(platform = process.platform, arch = process.arch) {
  const dirs = {
    darwin: "osx-bin",
    linux: "linux64-bin",
    win32: "win64-bin",
  };
  const dir = dirs[platform];
  if (!dir) return undefined;
  const binary = path.join(root, "node_modules", "react-native", "sdks", "hermesc", dir, platform === "win32" ? "hermesc.exe" : "hermesc");
  return fs.existsSync(binary) ? binary : undefined;
}

/** Compiles the bundle with Hermes; returns the compiler output (empty when it compiled cleanly). */
export function compileWithHermes(code, hermesc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-check-"));
  try {
    const file = path.join(dir, "client.js");
    fs.writeFileSync(file, code);
    try {
      execFileSync(hermesc, [file, "-emit-binary", "-out", path.join(dir, "client.hbc")], { stdio: ["ignore", "pipe", "pipe"] });
      return "";
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      const stdout = String(error.stdout ?? "");
      return (stderr + stdout).trim();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const hermesc = hermescPath();
  if (!hermesc) {
    console.log("no Hermes compiler for this platform - skipping");
    return;
  }
  const code = await buildClientBundle();
  const output = compileWithHermes(code, hermesc);
  if (output) {
    console.error("Hermes cannot compile the plugin's client bundle (the Paseo iOS app would fail to load it):");
    console.error(output);
    process.exit(1);
  }
  console.log(`Hermes compiles the client bundle (${Math.round(code.length / 1024)} kB)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
