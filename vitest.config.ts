import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "bench/fixtures/test/**/*.test.ts",
      "bench/runner/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
    ],
  },
});
