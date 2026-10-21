import { describe, expect, it } from "vitest";
import { highlight, LEGEND } from "../../client/palette";

describe("review highlight palette", () => {
  it("gives every state its own colors, and the active item is orange", () => {
    const states = ["active", "pending", "replaced", "kept", "restored"] as const;
    const bgs = states.map((s) => highlight(s).bg);
    expect(new Set(bgs).size).toBe(states.length);
    expect(highlight("active").bg).toBe("#FB923C");
    expect(highlight("pending").bg).toBe("#FEF08A");
  });
  it("the legend explains every state", () => {
    expect(LEGEND.map((l) => l.state).sort()).toEqual(["active", "kept", "pending", "replaced", "restored"]);
    for (const l of LEGEND) expect(l.text.length).toBeGreaterThan(5);
  });
});
