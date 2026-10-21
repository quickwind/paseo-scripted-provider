import { describe, expect, it } from "vitest";
import { buildReview, canExport, confirmSuspicious, editStep, exportText, pendingConfirms, redactSelection, resolveAll, restoreFinding, reviewItems, stats, stepsView } from "../../client/state";
import type { ConvertOptions, TimelineEntry } from "../../shared/core/capture/convert";
import { parseScript } from "../../shared/core/script";

const GH = "ghp_" + "a".repeat(36);
const RAND = "k3J9xQ2mZp7LwR4vB8nT1yH6cD0sFgUa";
const opts: ConvertOptions = { name: "rec", delay: { mode: "drop" }, includeReasoning: true, includeToolOutput: true };
const entries: TimelineEntry[] = [
  { item: { type: "user_message", text: `my token is ${GH}` } },
  { item: { type: "assistant_message", id: "m1", text: `saved in /Users/alice/proj; also ${RAND}` } },
  { item: { type: "user_message", text: "thanks" } },
  { item: { type: "assistant_message", id: "m2", text: `again ${GH}` } },
];
const model = () => buildReview(entries, opts, { cwd: "/Users/alice/proj" });

describe("review model", () => {
  it("counts auto-replaced values and unconfirmed suspicious tokens", () => {
    expect(stats(model())).toMatchObject({ suspicious: 1, unconfirmed: 1 });
    expect(stats(model()).autoReplaced).toBeGreaterThanOrEqual(2);
  });
  it("blocks export until every suspicious token is confirmed", () => {
    let m = model();
    expect(canExport(m)).toBe(false);
    m = confirmSuspicious(m, RAND);
    expect(canExport(m)).toBe(true);
  });
  it("export contains no seeded secret, uses consistent placeholders and validates", () => {
    const text = exportText(confirmSuspicious(model(), RAND));
    expect(text).not.toContain(GH);
    expect(text).not.toContain("alice");
    expect(text.match(/\{\{secret_1\}\}/g)!.length).toBe(2);
    expect(text).toContain("{{cwd}}");
    expect(parseScript(text).ok).toBe(true);
  });
  it("restoring a finding puts the original back in the export", () => {
    const m = confirmSuspicious(model(), RAND);
    restoreFinding(m, GH, true);
    expect(exportText(m)).toContain(GH);
  });
  it("redactSelection redacts a user value in every step", () => {
    const m = confirmSuspicious(model(), RAND);
    redactSelection(m, "thanks");
    expect(exportText(m)).not.toContain("thanks");
  });
  it("editing a step survives re-redaction and does not mutate the original model", () => {
    const m = confirmSuspicious(model(), RAND);
    const m2 = editStep(m, 1, "text", `new ${GH}`);
    expect(exportText(m2)).toContain("new {{secret_1}}");
    expect(JSON.stringify(m.script)).toContain("again");
  });
  it("stepsView highlights findings per step", () => {
    const v = stepsView(model());
    expect(v).toHaveLength(2);
    expect(v[0].parts.some((p) => p.segments.some((s) => s.finding))).toBe(true);
  });
});

describe("review gate covers every exported string (I3)", () => {
  it("a secret-looking token in an error or a tool error blocks export until confirmed", () => {
    const tok = "Zq8XrT2mKp7LwR4vB8nT1yH6cD0sFgUa";
    const e: TimelineEntry[] = [
      { item: { type: "user_message", text: "go" } },
      { item: { type: "tool_call", callId: "c", name: "Bash", status: "failed", error: `token=${tok}`, detail: { type: "plain_text" } } },
      { item: { type: "error", message: `Invalid key ${tok}x1` } },
    ];
    let m = buildReview(e, opts, {});
    expect(canExport(m)).toBe(false);
    for (const t of stepsView(m).flatMap((s) => s.suspicious)) m = confirmSuspicious(m, t);
    expect(canExport(m)).toBe(true);
  });
});

describe("reviewItems (navigation list)", () => {
  it("lists to-confirm and replaced items once per value, with where they are", () => {
    const m = model();
    const items = reviewItems(m);
    const confirm = items.filter((i) => i.kind === "confirm");
    const replaced = items.filter((i) => i.kind === "replaced");
    expect(confirm.map((i) => i.value)).toEqual([RAND]);
    expect(replaced.map((i) => i.value)).toEqual(expect.arrayContaining([GH, "/Users/alice/proj"])); // the cwd covers the user name
    expect(replaced.filter((i) => i.value === GH)).toHaveLength(1); // appears in two steps, listed once
    const gh = replaced.find((i) => i.value === GH)!;
    expect(gh.step).toBe(0);
    expect(typeof gh.part).toBe("number");
    expect(confirm[0].step).toBe(0);
  });
  it("marks confirm items done once confirmed and replaced items restored when restored", () => {
    let m = model();
    m = confirmSuspicious(m, RAND);
    restoreFinding(m, GH, true);
    const items = reviewItems(m);
    expect(items.find((i) => i.kind === "confirm")!.done).toBe(true);
    expect(items.find((i) => i.value === GH)!.restored).toBe(true);
  });
  it("redacting a suspicious value turns it into a replaced item", () => {
    const m = model();
    redactSelection(m, RAND);
    const items = reviewItems(m);
    expect(items.some((i) => i.kind === "confirm")).toBe(false);
    expect(items.some((i) => i.kind === "replaced" && i.value === RAND)).toBe(true);
  });
  it("pendingConfirms counts only unconfirmed suspicious values", () => {
    expect(pendingConfirms(model())).toBe(1);
    expect(pendingConfirms(confirmSuspicious(model(), RAND))).toBe(0);
  });
});

describe("resolveAll (bulk decision)", () => {
  const TOK2 = "Zq8XrT2mKp7LwR4vB8nT1yH6cD0sFgUa";
  const entries2: TimelineEntry[] = [
    { item: { type: "user_message", text: `first ${RAND} and ${TOK2}` } },
    { item: { type: "assistant_message", id: "m", text: `again ${RAND}` } },
  ];
  const m2 = () => buildReview(entries2, opts, {});
  it("redact: every undecided suspicious value is replaced and export is unblocked", () => {
    const m = resolveAll(m2(), "redact");
    expect(pendingConfirms(m)).toBe(0);
    expect(canExport(m)).toBe(true);
    const text = exportText(m);
    expect(text).not.toContain(RAND);
    expect(text).not.toContain(TOK2);
  });
  it("keep: every undecided suspicious value stays as it is and export is unblocked", () => {
    const m = resolveAll(m2(), "keep");
    expect(pendingConfirms(m)).toBe(0);
    expect(canExport(m)).toBe(true);
    const text = exportText(m);
    expect(text).toContain(RAND);
    expect(text).toContain(TOK2);
  });
  it("leaves values you already decided alone", () => {
    let m = m2();
    m = confirmSuspicious(m, RAND); // kept
    m = resolveAll(m, "redact");
    const text = exportText(m);
    expect(text).toContain(RAND); // the earlier 'keep' is not overridden
    expect(text).not.toContain(TOK2);
  });
  it("does nothing when nothing is pending", () => {
    const m = confirmSuspicious(resolveAll(m2(), "keep"), "x");
    expect(() => resolveAll(m, "redact")).not.toThrow();
    expect(exportText(resolveAll(m, "redact"))).toContain(RAND);
  });
});

describe("exportText format", () => {
  it("can export YAML, still redacted and parseable", () => {
    const m = confirmSuspicious(model(), RAND);
    const text = exportText(m, "yaml");
    expect(text).not.toContain(GH);
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(parseScript(text).ok).toBe(true);
  });
});
