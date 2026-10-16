// Local-only: real opencode / devin sessions. Run with `npm run verify:real`.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/real/**/*.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
