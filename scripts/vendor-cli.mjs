#!/usr/bin/env node
// Vendor the iFlow CLI into the repo at vendor/iflow-cli so the packaged
// VSIX works out-of-the-box on machines WITHOUT a globally installed CLI.
//
// Resolution priority stays unchanged (see src/acp/cli-locator.ts): an
// explicitly installed CLI wins; the vendored copy is only the fallback.
//
// Pruning is NOT guesswork — every pruned item below was verified against
// CLI 0.5.19 on 2026-09-11 by running the full ACP flow (initialize →
// newSession → set_mode/set_model/set_think probe → streamed prompt) with
// `npm run harness` against the pruned copy. Everything pruned serves the
// interactive TUI only (pseudo-terminal, devtools, terminal image rendering);
// the ACP headless path never touches it. 182.7MB → 39.3MB.
//
// Usage: node scripts/vendor-cli.mjs [--version 0.5.19] [--from <tgz>] [--from-dir <dir>] [--force]
//   --version   CLI version to pin (default: PINNED below, npm registry source)
//   --from      use a local .tgz instead of `npm pack` (offline/air-gapped)
//   --from-dir  vendor from an INSTALLED CLI directory instead of npm. Use
//               this to carry local customizations the official tarball does
//               not ship (e.g. injected *.loader.cjs bundles in bundle/).
//               The dir already has node_modules, so npm install is skipped.
//   --force     re-fetch even if vendor/iflow-cli already matches the version

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync, rmSync as rmDir } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "iflow-cli");
// Default rule configs the custom loaders read from ~/.iflow/. FIXED list on
// purpose: settings.json / iflow_accounts.json carry credentials and must
// never be synced or shipped — the loaders treat them as optional anyway.
const DEFAULTS_SRC = path.join(REPO_ROOT, "scripts", "iflow-defaults");
const DEFAULTS_OUT = path.join(REPO_ROOT, "vendor", "iflow-defaults");
const SYNC_DEFAULT_FILES = [
  "kimi-request-overrides.json",
  "multimodal-models.json",
  "output-token-limits.json",
  "thinking-models.json",
];

/**
 * Default npm source: the customized CLI fork (@yuentao scope) which carries
 * the locally injected *.loader.cjs bundles the official @iflow-ai tarball
 * does not ship. Published with tag `custom` — pull by exact version.
 * --from / --from-dir still override the npm source entirely.
 */
const NPM_PACKAGE = "@yuentao/iflow-cli";
const PINNED_VERSION = "0.5.19-custom.1";

// Directories/files pruned from the package, relative to the package root.
const PRUNE_DIRS = ["vendors", "scripts"];
const PRUNE_GLOBS = (bundleDir) =>
  readdirSync(bundleDir)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => path.join(bundleDir, name));

// node_modules packages pruned, with the probed rationale for each.
const PRUNE_PKGS = [
  "node-pty", // 62.6MB pseudo-terminal: interactive TUI only
  "react-devtools-core", // 16.2MB React devtools bridge
  "asciify-image", // terminal image rendering (jimp chain below)
  "gifuct-js",
  "@jimp",
  "gifwrap",
  "jimp",
  "pixelmatch",
  "js-binary-schema-parser",
  "@lydell", // wasm image decoders for the jimp chain
  "@types", // 1.6MB type declarations: never required at runtime
];

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const hasFlag = (flag) => argv.includes(flag);

/**
 * Run npm with a proper argv array on every platform.
 *
 * The previous impl passed a single command string with
 * `shell: process.platform === "win32"`: on Windows the string goes to the
 * shell and works, but on POSIX `shell:false` makes Node treat the whole
 * string as a binary name → spawnSync ENOENT (hit on the ubuntu runner).
 *
 * Preferred path: drive npm's own npm-cli.js with the current Node binary —
 * no .cmd shims (Windows EINVAL, Node ≥20.12 / CVE-2024-27980), no shell
 * quoting, no DEP0190 (shell:true + args array). Falls back to the `npm`
 * binary on PATH: shell:true single string on Windows (.cmd shim needs a
 * shell), plain argv array on POSIX.
 */
function runNpm(args, opts = {}) {
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const base = { windowsHide: true, ...opts };
  if (existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], base);
  }
  if (process.platform === "win32") {
    return execFileSync(`npm ${args.join(" ")}`, base);
  }
  return execFileSync("npm", args, base);
}

// --from-dir: the version comes from the source dir's package.json (any
// --version value is ignored) and bundle/entry.js must exist.
let version = argValue("--version", PINNED_VERSION);
let fromTgz = argValue("--from", null);
let fromDir = argValue("--from-dir", null);
const force = hasFlag("--force");

if (fromTgz && fromDir) throw new Error("--from and --from-dir are mutually exclusive");
if (fromDir) {
  fromDir = path.resolve(fromDir);
  if (!existsSync(path.join(fromDir, "package.json"))) {
    throw new Error(`--from-dir is not an iflow-cli package (no package.json): ${fromDir}`);
  }
  if (!existsSync(path.join(fromDir, "bundle", "entry.js"))) {
    throw new Error(`--from-dir has no bundle/entry.js: ${fromDir}`);
  }
  version = JSON.parse(readFileSync(path.join(fromDir, "package.json"), "utf8")).version;
}

// --sync-defaults: refresh the repo's default rule configs from this
// machine's ~/.iflow/ (run this after editing your local rules and before
// re-vendoring/publishing). Fixed file list only — never touches
// settings.json or anything credential-bearing.
if (hasFlag("--sync-defaults")) {
  const home = process.env.IFLOW_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".iflow");
  mkdirSync(DEFAULTS_SRC, { recursive: true });
  let synced = 0;
  for (const name of SYNC_DEFAULT_FILES) {
    const src = path.join(home, name);
    if (!existsSync(src)) continue;
    cpSync(src, path.join(DEFAULTS_SRC, name), { force: true });
    synced++;
  }
  console.log(`[vendor-cli] synced ${synced}/${SYNC_DEFAULT_FILES.length} rule configs → scripts/iflow-defaults/`);
  process.exit(0);
}

function sizeOf(dir) {
  let total = 0;
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = path.join(p, name);
      // lstat, not stat: npm .bin holds symlinks on Linux; after pruning
      // packages the links become dangling and statSync (follows) throws
      // ENOENT. lstatSync measures the link itself — safe and correct.
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

/**
 * Recursively remove every .bin directory under `root`. npm creates bin
 * shims (symlinks on Linux, .cmd files on Windows) at every nesting level
 * of node_modules; the CLI loads bundle/entry.js directly and never uses
 * them. Leaving symlinks in the tree causes vsce to crash during VSIX
 * packaging on Linux CI ("currentLevel is undefined").
 */
function removeBinDirs(root) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (name === ".bin") {
        rmSync(full, { recursive: true, force: true });
      } else {
        walk(full);
      }
    }
  };
  walk(root);
}

// Ship the loader rule configs alongside the CLI. The extension copies any
// MISSING ~/.iflow/*.json from here before connecting (existing user files
// are never overwritten). Runs on EVERY invocation — independent of the CLI
// vendoring idempotency check — so defaults stay fresh even when the CLI
// copy is up to date.
if (existsSync(DEFAULTS_SRC)) {
  mkdirSync(DEFAULTS_OUT, { recursive: true });
  let shipped = 0;
  for (const name of readdirSync(DEFAULTS_SRC)) {
    if (!name.endsWith(".json")) continue;
    cpSync(path.join(DEFAULTS_SRC, name), path.join(DEFAULTS_OUT, name), { force: true });
    shipped++;
  }
  console.log(`[vendor-cli] shipped ${shipped} default rule configs → vendor/iflow-defaults/`);
}

// Already vendored at the target version? Skip unless --force.
const pkgJsonPath = path.join(VENDOR_DIR, "package.json");
if (!force && existsSync(pkgJsonPath)) {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkg.version === version) {
      const note = fromDir
        ? " (same version ≠ same content: local loader customizations are NOT in the npm source — pass --force to re-vendor from --from-dir)"
        : " (use --force to redo)";
      console.log(`[vendor-cli] vendor/iflow-cli already at ${version}, skipping${note}`);
      process.exit(0);
    }
  } catch {
    // corrupt marker → fall through and re-vendor
  }
}

const work = mkdtempSync(path.join(tmpdir(), "iflow-vendor-"));
try {
  let pkgDir;
  if (fromDir) {
    // Local source: carries its own node_modules (and any local loader
    // customizations the npm tarball does not ship) — copy as-is.
    console.log(`[vendor-cli] copying local CLI from ${fromDir} ...`);
    pkgDir = path.join(work, "package");
    cpSync(fromDir, pkgDir, { recursive: true });
  } else {
    // 1. Obtain the package tgz (npm pack, or a local --from tarball).
    let tgz;
    if (fromTgz) {
      tgz = path.resolve(fromTgz);
      if (!existsSync(tgz)) throw new Error(`--from tarball not found: ${tgz}`);
    } else {
      console.log(`[vendor-cli] npm pack ${NPM_PACKAGE}@${version} ...`);
      const out = runNpm(["pack", `${NPM_PACKAGE}@${version}`, "--pack-destination", work], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      tgz = path.join(work, out.trim().split(/\r?\n/).filter(Boolean).at(-1));
    }

    // 2. Extract. tar is preinstalled on Windows 10+ (bsdtar) and Unix alike.
    console.log(`[vendor-cli] extracting ${path.basename(tgz)} ...`);
    execFileSync("tar", ["-xzf", tgz, "-C", work], { stdio: "inherit", windowsHide: true });
    pkgDir = path.join(work, "package");

    // 2b. The npm tarball does NOT ship node_modules — install the CLI's
    // runtime deps in place first. --ignore-scripts skips the package's own
    // postinstall hooks (they download editor plugins / ripgrep; pruned below,
    // never executed). Version resolution goes through the CLI's package.json
    // ranges, so the dependency tree follows whatever npm resolves today.
    console.log("[vendor-cli] npm install (production deps) ...");
    const installOut = runNpm(
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: pkgDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    console.log(
      "[vendor-cli] npm install:",
      installOut.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("added")).join(" | ") || "(done)",
    );
  }

  if (!existsSync(path.join(pkgDir, "bundle", "entry.js"))) {
    throw new Error("unexpected layout: bundle/entry.js missing in source package");
  }

  // 3. Prune everything the ACP headless path never requires.
  for (const dir of PRUNE_DIRS) rmSync(path.join(pkgDir, dir), { recursive: true, force: true });
  rmSync(path.join(pkgDir, "README.md"), { force: true });
  rmSync(path.join(pkgDir, "package-lock.json"), { force: true }); // install-time resolution record
  const bundleDir = path.join(pkgDir, "bundle");
  if (existsSync(bundleDir)) {
    for (const file of PRUNE_GLOBS(bundleDir)) rmSync(file, { force: true });
  }
  const nmDir = path.join(pkgDir, "node_modules");
  if (existsSync(nmDir)) {
    for (const name of PRUNE_PKGS) rmSync(path.join(nmDir, name), { recursive: true, force: true });
  }

  // Remove all .bin dirs at every nesting level — npm creates symlinks
  // (Linux) or .cmd shims (Windows) that the CLI never uses and vsce can't
  // package symlinks ("currentLevel is undefined" on Linux CI).
  removeBinDirs(pkgDir);

  // 4. Swap into vendor/ (cpSync, not rename: tmp may be on another drive).
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
  cpSync(pkgDir, VENDOR_DIR, { recursive: true });

  const mb = (sizeOf(VENDOR_DIR) / 1024 / 1024).toFixed(1);
  console.log(`[vendor-cli] vendored ${NPM_PACKAGE}@${version} → vendor/iflow-cli (${mb} MB)`);
} finally {
  rmDir(work, { recursive: true, force: true });
}
