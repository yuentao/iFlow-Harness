import path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Mirrors the esbuild `loader: { ".md": "text" }` contract used by the host bundle. */
const mdAsText = {
  name: "iflow-md-text",
  enforce: "pre" as const,
  load(id: string) {
    const file = id.replace(/\?.*$/, "");
    if (!file.endsWith(".md")) return null;
    return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [mdAsText],
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