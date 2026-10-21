import type { Script } from "./schema";

export const BUILTIN_SCRIPT: Script = {
  scenarios: {
    default: [{ text: "plain default reply" }],
    chat: [
      { text: "Hello! I'm the Scripted provider." },
      { text: "This is the second scripted reply." },
      { text: "That's all I have; I will repeat this." },
    ],
    "long-output": [
      { text: Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: lorem ipsum dolor sit amet.`).join("\n") },
    ],
    fail: [{ text: "partial…", startDelayMs: 300, outcome: "failed", error: "scripted failure" }],
    cancel: [{ text: "about to be canceled", outcome: "canceled" }],
    "slow-stream": [{ chunks: ["Streaming ", "one ", "chunk ", "at ", "a ", "time."], chunkDelayMs: 400 }],
    "tools-demo": [
      {
        tools: [
          {
            name: "Bash",
            detail: { type: "shell", command: "npm test", output: "3 passed", exitCode: 0 },
            runningMs: 800,
            status: "completed",
          },
          {
            name: "Edit",
            detail: { type: "edit", filePath: "src/a.ts" },
            status: "failed",
            error: "conflict",
          },
        ],
        text: "Tests pass; the edit conflicted.",
      },
    ],
  },
};
