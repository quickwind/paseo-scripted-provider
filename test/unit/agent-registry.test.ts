import { describe, expect, it } from "vitest";
import { createAgentRegistry } from "../../client/agent-registry";

function setup() {
  const added: string[] = [];
  const removed: string[] = [];
  const reg = createAgentRegistry((a) => {
    added.push(a.id);
    return { remove: () => removed.push(a.id) };
  });
  return { reg, added, removed };
}

describe("createAgentRegistry", () => {
  it("registers one button per agent", () => {
    const { reg, added } = setup();
    reg.track({ id: "a", workspaceId: "w1" });
    reg.track({ id: "b", workspaceId: "w1" });
    expect(added).toEqual(["a", "b"]);
  });
  it("does not re-register a known agent on later updates (an open review must stay mounted)", () => {
    const { reg, added, removed } = setup();
    reg.track({ id: "a", workspaceId: "w1" });
    reg.track({ id: "a", workspaceId: "w1" });
    reg.track({ id: "a", workspaceId: "w1" });
    expect(added).toEqual(["a"]);
    expect(removed).toEqual([]);
  });
  it("re-registers when an agent moves to another workspace", () => {
    const { reg, added, removed } = setup();
    reg.track({ id: "a", workspaceId: "w1" });
    reg.track({ id: "a", workspaceId: "w2" });
    expect(added).toEqual(["a", "a"]);
    expect(removed).toEqual(["a"]);
  });
  it("ignores agents without a workspace and removes forgotten ones", () => {
    const { reg, added, removed } = setup();
    reg.track({ id: "x", workspaceId: null });
    reg.track({ id: "a", workspaceId: "w1" });
    reg.forget("a");
    reg.forget("a");
    reg.forget("nope");
    expect(added).toEqual(["a"]);
    expect(removed).toEqual(["a"]);
  });
  it("reset removes everything", () => {
    const { reg, removed } = setup();
    reg.track({ id: "a", workspaceId: "w1" });
    reg.track({ id: "b", workspaceId: "w1" });
    reg.reset();
    expect(removed.sort()).toEqual(["a", "b"]);
    expect(reg.size()).toBe(0);
  });
});
