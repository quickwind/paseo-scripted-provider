import { describe, expect, it } from "vitest";
import { coverageBadge, testsBadge } from "../../scripts/make-badges.mjs";
import { authArgs } from "../../scripts/publish-badges.mjs";

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

describe("authArgs", () => {
  it("passes the token as an Authorization header, never inside the remote url", () => {
    const args = authArgs({ GITHUB_TOKEN: "tok" });
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-c");
    expect(args[1]).toContain("http.extraheader=AUTHORIZATION: basic ");
    expect(args[1]).not.toContain("tok");
    expect(Buffer.from(args[1].split("basic ")[1], "base64").toString()).toBe("x-access-token:tok");
  });
  it("adds no arguments without a token", () => {
    expect(authArgs({})).toEqual([]);
    expect(authArgs(undefined)).toEqual([]);
  });
});
