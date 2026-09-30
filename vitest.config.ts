import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // compiles src + test to .test-build/ once, for tests that fork real Node child processes
    globalSetup: ["test/setup/build-children.ts"],
  },
});
