import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: path.resolve(__dirname, "test/vscode-stub.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});