export function packFileListFrom(parsed: unknown): string[];

export function checkFileList(input: {
  files: string[];
  required: string[];
  manifest: { name?: string; version?: string; repository?: { url?: string }; dependencies?: Record<string, string> };
  name: string;
  expectedVersion?: string;
  forbidRuntimeDependencies?: boolean;
}): string[];

export function checkPackage(input: {
  pkgDir: string;
  required: string[];
  name: string;
  expectedVersion?: string;
  forbidRuntimeDependencies?: boolean;
}): { files: string[]; problems: string[]; version?: string };
