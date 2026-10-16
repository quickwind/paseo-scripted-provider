import { describe, expect, it } from "vitest";
import { coverageBadge, snykBadge, testsBadge } from "../../scripts/make-badges.mjs";
import { pushUrl } from "../../scripts/publish-badges.mjs";

describe("coverageBadge", () => {
  it.each([
    [95, "brightgreen"],
    [90, "brightgreen"],
    [85, "green"],
    [75, "yellow"],
    [40, "red"],
  ])("%d%% is %s", (pct, color) => {
    expect(coverageBadge({ total: { lines: { pct } } })).toEqual({ schemaVersion: 1, label: "coverage", message: `${pct}%`, color });
  });
  it("shows unknown when no summary", () => {
    expect(coverageBadge(null)).toMatchObject({ message: "unknown", color: "lightgrey" });
  });
});

describe("testsBadge", () => {
  it("counts passes from junit totals", () => {
    const xml = '<?xml version="1.0"?><testsuites name="vitest tests" tests="103" failures="0" errors="0" time="1.2"><testsuite name="a" tests="103" failures="0" errors="0" skipped="3"></testsuite></testsuites>';
    expect(testsBadge(xml)).toEqual({ schemaVersion: 1, label: "tests", message: "100 passed", color: "brightgreen" });
  });
  it("reports failures in red", () => {
    const xml = '<testsuites tests="10" failures="2" errors="1"><testsuite tests="10" failures="2" errors="1" skipped="0"/></testsuites>';
    expect(testsBadge(xml)).toMatchObject({ message: "7 passed, 3 failed", color: "red" });
  });
  it("shows unknown on garbage", () => {
    expect(testsBadge("nope")).toMatchObject({ message: "unknown", color: "lightgrey" });
  });
});

describe("snykBadge", () => {
  it("zero vulnerabilities is green", () => {
    expect(snykBadge({ vulnerabilities: [] })).toEqual({ schemaVersion: 1, label: "snyk", message: "0 vulnerabilities", color: "brightgreen" });
  });
  it("counts across an array of results and colors by worst severity", () => {
    const r = [{ vulnerabilities: [{ severity: "low" }] }, { vulnerabilities: [{ severity: "high" }, { severity: "medium" }] }];
    expect(snykBadge(r)).toMatchObject({ message: "3 vulnerabilities", color: "red" });
    expect(snykBadge({ vulnerabilities: [{ severity: "medium" }] })).toMatchObject({ message: "1 vulnerability", color: "yellow" });
  });
  it("an error result is never reported as clean", () => {
    expect(snykBadge({ ok: false, error: "Authentication failed" })).toMatchObject({ message: "scan error", color: "lightgrey" });
    expect(snykBadge([{ ok: true, vulnerabilities: [] }, { ok: false, error: "x" }])).toMatchObject({ message: "scan error" });
  });
  it("shows unknown when the scan did not run", () => {
    expect(snykBadge(null)).toMatchObject({ message: "not scanned", color: "lightgrey" });
  });
});

describe("pushUrl", () => {
  it("embeds the token for github.com remotes so the push is authenticated (I7)", () => {
    expect(pushUrl("https://github.com/quickwind/x.git", { GITHUB_TOKEN: "tok" })).toBe("https://x-access-token:tok@github.com/quickwind/x.git");
  });
  it("leaves the url alone without a token or for other hosts", () => {
    expect(pushUrl("https://github.com/q/x.git", {})).toBe("https://github.com/q/x.git");
    expect(pushUrl("git@github.com:q/x.git", { GITHUB_TOKEN: "t" })).toBe("git@github.com:q/x.git");
  });
});
