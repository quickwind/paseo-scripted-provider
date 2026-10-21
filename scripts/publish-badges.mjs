#!/usr/bin/env node
// Publishes the *.json files of a directory to the orphan `badges` branch (used by CI on main).
//   node scripts/publish-badges.mjs badges/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Authenticates git calls with an Authorization header instead of a token in the remote URL.
 * A token in the URL ends up in .git/config of the working copy; a header keeps it out of the
 * filesystem and out of `git remote -v` output.
 */
export function authArgs(env) {
  const token = env?.GITHUB_TOKEN;
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

function publish(dir) {
  if (!dir || !fs.existsSync(dir)) {
    console.error("usage: publish-badges.mjs <dir with *.json>");
    process.exit(2);
  }
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  /** Same as git(), but swallows stderr: a missing remote branch is expected on the first publish. */
  const gitQuiet = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  const origin = git(process.cwd(), "remote", "get-url", "origin").trim();
  const auth = authArgs(process.env);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

  for (let attempt = 1; attempt <= 3; attempt++) {
    // A fresh work tree per attempt: a failed push must not leave a half-updated checkout behind.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "badges-"));
    try {
      git(work, "init", "-q");
      git(work, "remote", "add", "origin", origin);
      let exists = true;
      try {
        // Full history (no --depth): the badges branch keeps one commit per publish instead of
        // being truncated to a single shallow commit on every run.
        gitQuiet(work, ...auth, "fetch", "-q", "origin", "badges");
        git(work, "checkout", "-q", "-B", "badges", "FETCH_HEAD");
      } catch {
        exists = false;
        git(work, "checkout", "-q", "--orphan", "badges");
      }
      for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(work, f));
      git(work, "add", ...files);
      if (!git(work, "status", "--porcelain").trim()) {
        console.log("badges already up to date");
        return 0;
      }
      git(work, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", "chore: update badges");
      try {
        git(work, ...auth, "push", "-q", "origin", "badges");
        console.log(`badges published (${exists ? "updated" : "created"})`);
        return 0;
      } catch {
        console.warn(`push attempt ${attempt} failed, retrying`);
      }
    } finally {
      // The work tree may hold the Authorization header in its config; do not leave it on disk.
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(publish(process.argv[2]));
