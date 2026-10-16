import { parse, parseDocument, stringify, type YamlDocument } from "../vendor/yaml.js";

export type { YamlDocument };

export const parseYaml = (text: string): unknown => parse(text);
export const parseYamlDocument = (text: string): YamlDocument => parseDocument(text);
/** Long lines are not folded; multi-line strings become `|` blocks. */
export const stringifyYaml = (value: unknown): string => stringify(value, { lineWidth: 0 });
