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
  // The host bundle is the largest artifact that ships in the VSIX (it
  // inlines every dependency plus the prompt templates). esbuild does not
  // minify by default, which left dist/extension.cjs at ~4.2 MB.
  minify: true,
  // Minification renames identifiers; keep function/class names intact so
  // stack traces and the panel's error banners still name the real class
  // (the custom error classes rely on `this.name` anyway, but a minified
  // anonymous helper in a stack trace is much harder to act on).
  keepNames: true,
  sourcemap: true,
  // Prompt templates ship as text inside the bundle instead of as readable
  // `prompts/*.md` files in the VSIX (see .vscodeignore). The CLI's
  // IFLOW_SYSTEM_MD override is the one template that needs a real file, and
  // ChatPanel writes it into its own storage dir at runtime.
  loader: { ".md": "text" },
  logLevel: "info",
});

// QQ bridge sidecar (Wave2-D): a standalone Node process spawned by the panel
// that speaks OneBot v11 over loopback HTTP. Same output contract as the host
// bundle (CJS + node20) but nothing VSCode-specific — only node built-ins and
// repo code are bundled, so no `external` list is needed (`platform: "node"`
// already externalizes built-ins). Keep this a separate entry: the bridge must
// be spawnable on its own and must never pull `vscode` into its graph.
await esbuild.build({
  entryPoints: ["src/qq/bridge/main.ts"],
  bundle: true,
  outfile: "dist/qq-bridge.cjs",
  format: "cjs",
  platform: "node",
  target: "node20",
  minify: true,
  keepNames: true,
  sourcemap: true,
  // `import.meta` only exists in ESM. Without this define, esbuild compiles
  // `import.meta.url` to `({}).url` → `undefined`, `fileURLToPath(undefined)`
  // throws, and main.ts's entry self-detection swallows the error into `false`
  // — the panel-spawned bridge then exits 0 with empty stderr and the panel
  // enters a restart loop (P0). Defining it here keeps the CJS artifact
  // self-identifying as its own entry.
  //
  // esbuild 0.28 rejects call expressions as define values ("Invalid define
  // value (must be an entity name or JS literal)"), so the define points at a
  // global identifier that the banner assigns the real URL to. Banner text is
  // emitted verbatim (not minified), and `globalThis.*` is immune to the
  // minifier renaming bundle-local bindings.
  define: {
    "import.meta.url": "globalThis.__iflowBridgeEntryUrl",
  },
  banner: {
    js: 'globalThis.__iflowBridgeEntryUrl = require("url").pathToFileURL(__filename).href;',
  },
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
