import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    reporters: ["default", "junit", "html"],
    outputFile: { junit: "reports/junit.xml", html: "reports/html/index.html" },
    coverage: {
      provider: "v8",
      include: ["shared/core/**", "server/**"],
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "reports/coverage",
      thresholds: { lines: 85 },
    },
  },
});
