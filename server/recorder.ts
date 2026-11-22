import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nullRecorder, type Recorder } from "../shared/core/recorder";

export function createRecorder(file: string | undefined, now: () => number = Date.now): Recorder {
  if (!file) return nullRecorder;
  let dirReady = false;
  return {
    record(kind, data) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(file), { recursive: true });
          dirReady = true;
        }
        appendFileSync(file, JSON.stringify({ t: new Date(now()).toISOString(), kind, ...data }) + "\n");
      } catch (error) {
        console.error("[scripted-provider] record failed", error);
      }
    },
  };
}
