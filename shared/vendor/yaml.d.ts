// Types for the vendored yaml bundle: only what this plugin uses.
export function parse(text: string, options?: { maxAliasCount?: number }): unknown;
export function stringify(value: unknown, options?: { lineWidth?: number }): string;
export interface YamlDocument {
  errors: { message: string }[];
  toJS(): unknown;
  setIn(path: (string | number)[], value: unknown): void;
  hasIn(path: (string | number)[]): boolean;
  toString(options?: { lineWidth?: number }): string;
}
export function parseDocument(text: string): YamlDocument;
