import { describe, expect, it } from "vitest";
import { english, interpolate, resources } from "../../client/i18n";

function flatten(tree: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value as Record<string, unknown>, path)) out.set(k, v);
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(",");

describe("client translations", () => {
  const en = flatten(resources.en);

  it.each(Object.keys(resources).filter((l) => l !== "en"))("%s has exactly the English keys and placeholders", (locale) => {
    const other = flatten((resources as Record<string, Record<string, unknown>>)[locale]);
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of other) expect(placeholders(text), `${locale}:${key}`).toBe(placeholders(en.get(key)!));
  });

  it("uses canonical locale tags and keys without dots", () => {
    for (const locale of Object.keys(resources)) expect(Intl.getCanonicalLocales(locale)[0]).toBe(locale);
    for (const tree of Object.values(resources)) for (const key of flatten(tree as Record<string, unknown>).keys()) for (const part of key.split(".")) expect(part).not.toBe("");
  });

  it("falls back to English with interpolation on hosts without translations", () => {
    expect(english("record.redactedItems", { count: 3 })).toBe("Redacted 3 item(s)");
    expect(english("no.such.key")).toBe("no.such.key");
    expect(interpolate("a {{x}} {{y}}", { x: 1 })).toBe("a 1 {{y}}");
  });
});
