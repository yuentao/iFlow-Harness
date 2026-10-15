import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";

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

// M1 P0-5: ship the notification binaries (macOS terminal-notifier.app +
// Windows SnoreToast exes) that src/acp/os-notify.ts spawns directly. They
// are copied from the node-notifier npm package's vendor/ dir (the dependency
// exists ONLY to source them — it is never imported or bundled above) into
// vendor/os-notify/, which .vscodeignore keeps (not under node_modules/**)
// and which the runtime resolves via extensionPath. Zip extraction may drop
// the exec bit on macOS; os-notify chmods before spawn, same as cli-locator
// does for the CLI's ripgrep binaries.
const notifySrc = "node_modules/node-notifier/vendor";
const notifyDst = "vendor/os-notify";
if (!existsSync(notifySrc)) {
  throw new Error(`missing ${notifySrc} — run \`npm ci\` before \`npm run build\` (node-notifier vendors the toast binaries).`);
}
mkdirSync(notifyDst, { recursive: true });
for (const entry of ["mac.noindex", "snoreToast", "terminal-notifier-LICENSE"]) {
  cpSync(`${notifySrc}/${entry}`, `${notifyDst}/${entry}`, { recursive: true });
}
cpSync("node_modules/node-notifier/LICENSE", `${notifyDst}/node-notifier-LICENSE`);
