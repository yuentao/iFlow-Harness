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
// Usage: node scripts/vendor-cli.mjs [--force]
//        node scripts/vendor-cli.mjs (--version <v> | --from <tgz> | --from-dir <dir>) [--force]
//   (no source flags)  DEFAULT since 2026-10-17: vendor from the LOCAL fork
//                      checkout sitting next to this repo — ../iflow-fork
//                      relative to this repo (J:\git\iflow-fork for
//                      J:\git\iflow-harness), overridable via IFLOW_VENDOR_FORK_DIR.
//                      The npm registry is NO LONGER consulted by default: the
//                      local fork carries the injected *.loader.cjs Mod bundles
//                      and leads anything published to the @yuentao npm scope.
//   --version   opt back into the npm registry path and pin a version
//   --from      use a local .tgz instead of `npm pack` (offline/air-gapped)
//   --from-dir  vendor from an INSTALLED CLI directory (same path the default
//               takes; pass it to point at a different fork checkout).
//               The dir already has node_modules, so npm install is skipped.
//   --force     re-copy even if vendor/iflow-cli already matches the version

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync, rmSync as rmDir } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "iflow-cli");
// Default rule configs the custom loaders read from ~/.iflow/. All top-level
// *.json files are synced EXCEPT the denylist below: settings.json /
// iflow_accounts.json / oauth_creds* carry credentials and must never be
// synced or shipped; model-preferences.json is CLI user state. New rule
// configs dropped into ~/.iflow/ are picked up with zero changes here —
// the loaders treat a missing config as optional anyway.
const DEFAULTS_SRC = path.join(REPO_ROOT, "scripts", "iflow-defaults");
const DEFAULTS_OUT = path.join(REPO_ROOT, "vendor", "iflow-defaults");
const SYNC_DEFAULT_DENYLIST = [
  "settings.json",
  "iflow_accounts.json",
  "model-preferences.json",
];
const isSyncDenied = (name) =>
  SYNC_DEFAULT_DENYLIST.some((d) => name === d) || name.startsWith("oauth_creds");

/**
 * Default source (2026-10-17): the LOCAL fork checkout next to this repo —
 * ../iflow-fork relative to REPO_ROOT (J:\git\iflow-fork for J:\git\iflow-harness;
 * remote product/iflow-fork.git). It carries every injected *.loader.cjs Mod
 * bundle and leads the published @yuentao npm scope, which lags behind
 * (custom.12 is not on npm), so packaging no longer consults the registry by
 * default. The npm path stays reachable via an explicit --version (registry
 * acceptance checks / future publishes); --from / --from-dir still override
 * the source entirely.
 */
const DEFAULT_LOCAL_FORK_DIR = path.resolve(REPO_ROOT, "..", "iflow-fork");
const NPM_PACKAGE = "@yuentao/iflow-cli";

// Directories/files pruned from the package, relative to the package root.
// `reverse/` exists only in a fork-checkout source (--from-dir path): it is
// the deobfuscation workspace (reverse/*.readable.js ~230k lines + ANALYSIS.md),
// never required at CLI runtime and must never ship in the VSIX.
const PRUNE_DIRS = ["scripts", "reverse"];
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
let version = argValue("--version", null);
let fromTgz = argValue("--from", null);
let fromDir = argValue("--from-dir", null);
const force = hasFlag("--force");

if (fromTgz && fromDir) throw new Error("--from and --from-dir are mutually exclusive");

function adoptFromDir(dir) {
  dir = path.resolve(dir);
  if (!existsSync(path.join(dir, "package.json"))) {
    throw new Error(`--from-dir is not an iflow-cli package (no package.json): ${dir}`);
  }
  if (!existsSync(path.join(dir, "bundle", "entry.js"))) {
    throw new Error(`--from-dir has no bundle/entry.js: ${dir}`);
  }
  return dir;
}

if (fromDir) {
  fromDir = adoptFromDir(fromDir);
  version = JSON.parse(readFileSync(path.join(fromDir, "package.json"), "utf8")).version;
} else if (!version && !fromTgz) {
  // Default source: the local fork checkout, NOT the npm registry. The fork
  // is the single source of truth for the injected Mod loader bundles;
  // silently falling back to npm would vendor a fork that lags the local
  // Mod injections — fail instead and make the operator fix the checkout.
  const forkDir = process.env.IFLOW_VENDOR_FORK_DIR || DEFAULT_LOCAL_FORK_DIR;
  if (!existsSync(path.join(forkDir, "package.json"))) {
    throw new Error(
      `no local CLI fork checkout at ${forkDir} — packaging vendors from ../iflow-fork, not npm. ` +
      `Clone it next to this repo (git clone https://git.pandorastudio.cn/product/iflow-fork.git iflow-fork), ` +
      `or point IFLOW_VENDOR_FORK_DIR / --from-dir at an installed fork, ` +
      `or pass --version to opt back into the npm registry path.`,
    );
  }
  fromDir = adoptFromDir(forkDir);
  version = JSON.parse(readFileSync(path.join(fromDir, "package.json"), "utf8")).version;
  console.log(`[vendor-cli] default source: local fork ${fromDir} (${version})`);
}

// (npm dist-tag resolution removed 2026-10-17: the default source is the
// local fork checkout above, whose version is read off its package.json;
// the registry is consulted only with an explicit --version.)


// --sync-defaults: refresh the repo's default rule configs from this
// machine's ~/.iflow/ (run this after editing your local rules and before
// re-vendoring/publishing). All top-level *.json are synced except the
// denylist — settings.json and anything credential-bearing are never touched.
if (hasFlag("--sync-defaults")) {
  const home = process.env.IFLOW_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".iflow");
  mkdirSync(DEFAULTS_SRC, { recursive: true });
  let synced = 0;
  const skipped = [];
  for (const name of readdirSync(home)) {
    if (!name.endsWith(".json")) continue;
    if (isSyncDenied(name)) {
      skipped.push(name);
      continue;
    }
    const src = path.join(home, name);
    if (!statSync(src).isFile()) continue;
    cpSync(src, path.join(DEFAULTS_SRC, name), { force: true });
    synced++;
  }
  console.log(`[vendor-cli] synced ${synced} rule config(s) → scripts/iflow-defaults/`);
  if (skipped.length > 0) {
    console.log(`[vendor-cli] skipped (denylist): ${skipped.join(", ")}`);
  }
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
// are never overwritten). The source dir is populated by --sync-defaults,
// whose denylist already excludes credentials — but re-check here so a
// hand-placed credential file in scripts/iflow-defaults/ can never reach
// the VSIX. Runs on EVERY invocation — independent of the CLI vendoring
// idempotency check — so defaults stay fresh even when the CLI copy is up
// to date.
if (existsSync(DEFAULTS_SRC)) {
  mkdirSync(DEFAULTS_OUT, { recursive: true });
  let shipped = 0;
  for (const name of readdirSync(DEFAULTS_SRC)) {
    if (!name.endsWith(".json")) continue;
    if (isSyncDenied(name)) {
      throw new Error(
        `[vendor-cli] credential/user-state file in ${DEFAULTS_SRC}: ${name} — remove it before packaging`,
      );
    }
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
    // A source checkout's .git must never ship: .vscodeignore excludes
    // .gitignore/.github but NOT .git/, so a 19MB repo would land in the
    // VSIX (the npm-tarball path never has one).
    rmSync(path.join(pkgDir, ".git"), { recursive: true, force: true });
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
    // --from tarball without --version: the real version lives in the
    // extracted package.json (logging + idempotency marker).
    version = version ?? JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;

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

  // 3b. Restore the exec bit on the CLI's prebuilt ripgrep binaries. The
  // npm tarball / vsce zip chain drops unix mode bits, and --ignore-scripts
  // skips the CLI's postinstall that would have chmod'd them — on installed
  // machines `rg` then lands 0644 and every CLI search tool fails with
  // "spawn .../vendors/ripgrep/x64-darwin/rg EACCES" (1.2.3, macOS). The
  // extension also chmods at connect time (cli-locator.ensureVendorBinariesExecutable)
  // as a belt-and-braces for already-shipped VSIXes.
  const rgRoot = path.join(pkgDir, "vendors", "ripgrep");
  if (existsSync(rgRoot)) {
    let chmodded = 0;
    for (const platform of readdirSync(rgRoot)) {
      if (platform.endsWith("win32")) continue; // ntfs has no exec bit
      const bin = path.join(rgRoot, platform, "rg");
      if (!existsSync(bin)) continue;
      chmodSync(bin, 0o755);
      chmodded++;
    }
    console.log(`[vendor-cli] chmod +x ${chmodded} ripgrep binary(ies)`);
  }

  // 4. Swap into vendor/ (cpSync, not rename: tmp may be on another drive).
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
  cpSync(pkgDir, VENDOR_DIR, { recursive: true });

  const mb = (sizeOf(VENDOR_DIR) / 1024 / 1024).toFixed(1);
  console.log(`[vendor-cli] vendored ${NPM_PACKAGE}@${version} → vendor/iflow-cli (${mb} MB)`);
} finally {
  rmDir(work, { recursive: true, force: true });
}
