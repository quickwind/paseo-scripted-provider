import { describe, expect, it } from "vitest";
import { findYamlMarkers } from "../../scripts/check-client-bundle.mjs";

describe("findYamlMarkers", () => {
  it("finds nothing in a bundle without the YAML parser", () => {
    expect(findYamlMarkers("var x = 1; export default x;")).toEqual([]);
  });
  it("spots the vendored YAML library", () => {
    const markers = findYamlMarkers('Symbol.for("yaml.alias"); Z.defaultYaml={explicit:!1};');
    expect(markers).toContain("defaultYaml");
    expect(markers).toContain("yaml.alias");
  });
});
