import { appendFileSync } from "node:fs";
import { nullRecorder, type Recorder } from "../shared/core/recorder";

export function createRecorder(file: string | undefined, now: () => number = Date.now): Recorder {
  if (!file) return nullRecorder;
  return {
    record(kind, data) {
      try {
        appendFileSync(file, JSON.stringify({ t: new Date(now()).toISOString(), kind, ...data }) + "\n");
      } catch (error) {
        console.error("[scripted-provider] record failed", error);
      }
    },
  };
}
