import { defineConfig } from "vitest/config";

/**
 * Tests live in <package>/test/ rather than src/, because every package
 * compiles src/ into dist/ with rootDir=src and would otherwise ship them.
 *
 * The relay tests spawn real child processes and worker threads against a
 * stand-in worker script, so the timeouts are wider than vitest's default.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
