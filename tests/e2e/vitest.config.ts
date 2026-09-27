import { defineConfig } from "vitest/config";

// Browser checks against the built site. Run with `npm run test:e2e`, which builds dist/ first.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
