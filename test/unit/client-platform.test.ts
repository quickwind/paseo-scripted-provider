import { describe, expect, it } from "vitest";
import { supportsRecordFlow } from "../../client/platform";

describe("supportsRecordFlow", () => {
  it("is off on iOS: the review screen is a desktop-sized UI", () => {
    expect(supportsRecordFlow("ios")).toBe(false);
  });
  it("is on everywhere else", () => {
    for (const platform of ["macos", "windows", "web", "android"]) {
      expect(supportsRecordFlow(platform)).toBe(true);
    }
  });
});
