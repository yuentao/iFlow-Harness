import * as esbuild from "esbuild";

// Bundle the extension host (CJS — required by the VSCode extension host;
// note package.json has "type": "module", hence the .cjs output extension).
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
});
