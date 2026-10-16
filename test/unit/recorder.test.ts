import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRecorder } from "../../server/recorder";

it("appends one JSON line per record with time and kind", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "rec-")), "r.jsonl");
  const r = createRecorder(f, () => 1700000000000);
  r.record("prompt", { text: "hi" });
  r.record("interrupt", {});
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { t: "2023-11-14T22:13:20.000Z", kind: "prompt", text: "hi" },
    { t: "2023-11-14T22:13:20.000Z", kind: "interrupt" },
  ]);
});
it("is a no-op without a file and never throws on unwritable paths", () => {
  expect(() => createRecorder(undefined).record("x", {})).not.toThrow();
  expect(() => createRecorder("/definitely/not/writable/x.jsonl").record("x", {})).not.toThrow();
});
