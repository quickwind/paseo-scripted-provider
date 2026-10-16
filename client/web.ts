import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const document: {
  createElement(tag: "a"): { href: string; download: string; click(): void };
};
declare const URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
declare const Blob: new (parts: string[], options: { type: string }) => unknown;

export const canDownload = Platform.OS === "web";

export function downloadFile(filename: string, text: string, mime = "application/json;charset=utf-8"): void {
  if (!canDownload) return;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
