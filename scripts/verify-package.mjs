#!/usr/bin/env node
// Verifies what would actually ship to npm: the file list of `npm pack`, without publishing.
//   node scripts/verify-package.mjs            check the plugin package
//   node scripts/verify-package.mjs testkit    check the testkit package
//
// A published plugin that cannot load is invisible until someone installs it, so the file list
// is treated as a contract: everything the daemon compiles at install time must be in the tarball.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files the Paseo daemon needs to compile and run the plugin. */
const REQUIRED_PLUGIN_FILES = [
  "package.json",
  "paseo-plugin.json",
  "index.server.ts",
  "index.client.tsx",
  "README.md",
  "LICENSE",
  "client/settings.tsx",
  "server/provider.ts",
  "server/session.ts",
  "shared/core/schema.ts",
  "shared/core/script.ts",
  "shared/core/capture/redact.ts",
  "shared/vendor/yaml.js",
];

const REQUIRED_TESTKIT_FILES = ["package.json", "README.md", "index.mjs", "daemon.mjs"];

/** Directories that must never end up in a published tarball. */
const FORBIDDEN_PREFIXES = ["test/", "e2e/", "scripts/", "reports/", "node_modules/", ".github/", "scenarios/", "scratch/"];

/**
 * The file list of a `npm pack --dry-run --json` result.
 * npm 11 returns an array of results, npm 12 an object keyed by package name.
 */
export function packFileListFrom(parsed) {
  const entry = Array.isArray(parsed) ? parsed[0] : parsed?.files ? parsed : Object.values(parsed ?? {})[0];
  return (entry?.files ?? []).map((f) => f.path);
}

export function packFileList(pkgDir) {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return packFileListFrom(JSON.parse(raw));
}

export function checkFileList({ files, required, manifest, name, expectedVersion, forbidRuntimeDependencies = false }) {
  const problems = [];
  for (const file of required) {
    if (!files.includes(file)) problems.push(`missing from the tarball: ${file}`);
  }
  for (const file of files) {
    const forbidden = FORBIDDEN_PREFIXES.find((prefix) => file.startsWith(prefix));
    if (forbidden) problems.push(`must not be published: ${file}`);
  }
  if (manifest.name !== name) problems.push(`package name is ${manifest.name}, expected ${name}`);
  if (expectedVersion && manifest.version !== expectedVersion) {
    problems.push(`package version is ${manifest.version}, expected ${expectedVersion}`);
  }
  if (!manifest.repository?.url) problems.push("package.json has no repository.url (npm trusted publishing requires it)");
  if (forbidRuntimeDependencies && manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    // The Paseo host provides zod, react, react-native and the plugin SDK at runtime, so the
    // plugin package must not declare runtime dependencies of its own.
    problems.push(`unexpected runtime dependencies: ${Object.keys(manifest.dependencies).join(", ")}`);
  }
  return problems;
}

export function checkPackage({ pkgDir, required, name, expectedVersion, forbidRuntimeDependencies = false }) {
  const files = packFileList(pkgDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const problems = checkFileList({ files, required, manifest, name, expectedVersion, forbidRuntimeDependencies });
  return { files, problems, version: manifest.version };
}

function main(argv) {
  const which = argv[0] === "testkit" ? "testkit" : "plugin";
  const rootVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const spec = which === "testkit"
    ? { pkgDir: path.join(repoRoot, "testkit"), required: REQUIRED_TESTKIT_FILES, name: "paseo-scripted-provider-testkit", expectedVersion: rootVersion }
    : { pkgDir: repoRoot, required: REQUIRED_PLUGIN_FILES, name: "paseo-scripted-provider", expectedVersion: rootVersion, forbidRuntimeDependencies: true };
  const { files, problems } = checkPackage(spec);
  if (problems.length) {
    console.error(`package check failed for ${spec.name}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`package check passed for ${spec.name} ${rootVersion} (${files.length} files in the tarball)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
