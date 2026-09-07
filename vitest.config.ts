import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: path.resolve(__dirname, "test/vscode-stub.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});