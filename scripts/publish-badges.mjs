#!/usr/bin/env node
// Publishes the *.json files of a directory to the orphan `badges` branch (used by CI on main).
//   node scripts/publish-badges.mjs badges/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** actions/checkout scopes its credentials to its own checkout, so a fresh repo needs the token in the url. */
export function pushUrl(origin, env) {
  if (env.GITHUB_TOKEN && origin.startsWith("https://github.com/")) {
    return origin.replace("https://", `https://x-access-token:${env.GITHUB_TOKEN}@`);
  }
  return origin;
}

function publish(dir) {
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: publish-badges.mjs <dir with *.json>");
  process.exit(2);
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const origin = pushUrl(git(process.cwd(), "remote", "get-url", "origin").trim(), process.env);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

for (let attempt = 1; attempt <= 3; attempt++) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "badges-"));
  git(work, "init", "-q");
  git(work, "remote", "add", "origin", origin);
  let exists = true;
  try {
    git(work, "fetch", "-q", "--depth=1", "origin", "badges");
    git(work, "checkout", "-q", "-B", "badges", "FETCH_HEAD");
  } catch {
    exists = false;
    git(work, "checkout", "-q", "--orphan", "badges");
  }
  for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(work, f));
  git(work, "add", ...files);
  if (!git(work, "status", "--porcelain").trim()) process.exit(0);
  git(work, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", "chore: update badges");
  try {
    git(work, "push", "-q", "origin", "badges");
    console.log(`badges published (${exists ? "updated" : "created"})`);
    process.exit(0);
  } catch (error) {
    console.warn(`push attempt ${attempt} failed, retrying`);
  }
}
process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) publish(process.argv[2]);
