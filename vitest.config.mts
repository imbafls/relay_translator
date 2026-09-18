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
    // For the files that opt into happy-dom. Left alone, vitest puts the page
    // on http://localhost:3000 and happy-dom fetches every stylesheet and
    // iframe a page links to - from whatever is listening there, which on the
    // machine this is developed on is another project's dev server. No test
    // wants a page to load anything (those that need CSS read it from disk),
    // so loading is off and the page sits on the discard port, where nothing
    // answers. packages/shared/test/testDom.test.ts holds both, by outcome:
    // happy-dom 20 already refuses script files by default, so that setting
    // is said out loud here rather than relied on, and no mutation of it alone
    // turns the test red.
    environmentOptions: {
      happyDOM: {
        url: "http://127.0.0.1:9/",
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          disableIframePageLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
