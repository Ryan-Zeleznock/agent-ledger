import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Leave capacity for real-process children and a concurrent checkout (pin 9).
    maxWorkers: 2,
    include: ["test/**/*.test.ts"],
    // compiles src + test to .test-build/ once, for tests that fork real Node child processes
    globalSetup: ["test/setup/build-children.ts"],
  },
});
