#!/usr/bin/env node
// Turns CI reports into shields.io "endpoint" JSON badges.
//   node scripts/make-badges.mjs --out badges/      write tests.json and coverage.json
//   node scripts/make-badges.mjs --out badges/ --only coverage   write just the named badges
// Snyk status is served by GitHub's native workflow badge, so it needs no file here.
//   node scripts/make-badges.mjs --summary          print a Markdown summary (for $GITHUB_STEP_SUMMARY)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const badge = (label, message, color) => ({ schemaVersion: 1, label, message, color });

export function coverageBadge(summary) {
  const pct = summary?.total?.lines?.pct;
  if (typeof pct !== "number") return badge("coverage", "unknown", "lightgrey");
  const color = pct >= 90 ? "brightgreen" : pct >= 80 ? "green" : pct >= 70 ? "yellow" : "red";
  return badge("coverage", `${pct}%`, color);
}

export function testsBadge(xml) {
  const m = /<testsuites\b[^>]*>/.exec(xml);
  const attr = (name) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(m?.[0] ?? "")?.[1] ?? NaN);
  const total = attr("tests");
  if (!m || Number.isNaN(total)) return badge("tests", "unknown", "lightgrey");
  const failed = (attr("failures") || 0) + (attr("errors") || 0);
  const skipped = [...xml.matchAll(/<testsuite\b[^>]*\bskipped="(\d+)"/g)].reduce((n, x) => n + Number(x[1]), 0);
  const passed = total - failed - skipped;
  return failed ? badge("tests", `${passed} passed, ${failed} failed`, "red") : badge("tests", `${passed} passed`, "brightgreen");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main(argv) {
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
  const cov = coverageBadge(readJson("reports/coverage/coverage-summary.json"));
  const tests = testsBadge(fs.existsSync("reports/junit.xml") ? fs.readFileSync("reports/junit.xml", "utf8") : "");
  if (argv.includes("--summary")) {
    console.log(`### Quality\n\n| | |\n|---|---|\n| Tests | ${tests.message} |\n| Line coverage | ${cov.message} |`);
  }
  if (out) {
    const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : ["tests", "coverage"];
    fs.mkdirSync(out, { recursive: true });
    if (only.includes("tests")) fs.writeFileSync(path.join(out, "tests.json"), JSON.stringify(tests));
    if (only.includes("coverage")) fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(cov));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
