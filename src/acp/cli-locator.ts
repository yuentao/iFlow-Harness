import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { chmod as chmodP, copyFile as copyFileP, mkdir as mkdirP, rename as renameP, rm as rmP, stat as statP } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export interface IflowCommand {
  command: string;
  args: string[];
}

/**
 * Cross-window persistence for the node-probe result (the probe shells out —
 * `where.exe node` / `node --version` — hundreds of ms per window). Window 2+
 * hydrates the cache and skips the probe entirely. Hydrated values keep the
 * same existsSync re-validation as in-memory ones, so a removed node re-probes
 * exactly as before. Only successful resolutions are saved — failures are
 * never cached. The CLI entry itself needs no cache: resolveVendoredEntry is a
 * synchronous existsSync of a path inside the extension package, which changes
 * only on extension update (a new process).
 */
export interface LocatorPaths {
  node?: string | null;
}
export interface LocatorPersistence {
  load(): LocatorPaths | undefined;
  save(paths: LocatorPaths): void;
}
let persistence: LocatorPersistence | null = null;
let persistenceHydrated = false;

export function configureLocatorPersistence(p: LocatorPersistence | null): void {
  persistence = p;
  persistenceHydrated = false;
}

/** Seed the in-memory caches from storage once per host session. */
function hydrateCache(): void {
  if (persistenceHydrated || !persistence) return;
  persistenceHydrated = true;
  try {
    const saved = persistence.load();
    if (saved?.node) cachedNode ??= saved.node;
  } catch {
    // storage unavailable — probes run as before
  }
}

/** Best-effort write-back of the currently resolved paths. */
function persistResolved(): void {
  if (!persistence) return;
  try {
    persistence.save({ node: cachedNode });
  } catch {
    // best effort; the in-memory caches still cover this window
  }
}

/**
 * Resolve the CLI entry INSIDE the extension package (scripts/vendor-cli.mjs
 * ships the cut-down customized fork @yuentao/iflow-cli into vendor/iflow-cli).
 *
 * The vendored fork is the ONLY execution body — there is deliberately no
 * fallback to a locally installed CLI (PATH / npm global / well-known paths)
 * and no env-variable override. The custom loader patches (thinking-mode,
 * multimodal, output-token-limit, kimi-request-override, mcp-background,
 * mcp-session-share, api-config-isolation) live ONLY in this bundle: running
 * the official @iflow-ai package would silently drop them and change agent
 * behavior, so a missing vendor copy is a broken extension package, not a
 * situation to paper over — throw and let the panel surface it.
 * iflow.nodePath (the runtime, not the CLI) is unaffected by this.
 */
export function resolveVendoredEntry(extensionPath: string): string {
  const entry = path.join(extensionPath, "vendor", "iflow-cli", "bundle", "entry.js");
  if (!existsSync(entry)) {
    throw new Error(
      `bundled iFlow CLI missing (expected ${entry}). ` +
        "Extension package incomplete — reinstall from the VSIX or run `npm run vendor:cli` in a dev checkout.",
    );
  }
  return entry;
}

export function buildAcpCommand(entryJs: string, includeDirectories: string[] = []): IflowCommand {
  // --stream (probed, CLI 0.5.19 bundle): without it `config.stream` is false
  // and the ACP prompt handler awaits `sendMessageLatency` — the FULL model
  // response arrives as one dump after each turn, so the panel shows replies
  // in segments instead of streaming. With it the turn loop iterates the
  // SSE stream and emits `agent_message_chunk` per delta.
  //
  // --include-directories (probed, CLI 0.5.19 bundle): the CLI's workspace
  // context is `new WorkspaceContext(targetDir, includeDirectories ?? [])`,
  // and every file tool (read_file / write_file / replace / ls / grep / glob
  // / image_read) validates its path against it BEFORE delegating to the
  // client's fs callbacks (`capabilities.readTextFile ? client.readTextFile :
  // fallback`). The extension's own boundary (AcpClient.resolveAgentPath)
  // uses the same root set, so passing the extra workspace roots here keeps
  // the CLI's context and our boundary in sync — without it, a multi-root
  // workspace would have the CLI accept a path our boundary then rejects.
  // The CLI also accepts `/directory add` at runtime, which we cannot mirror;
  // that path is covered by the lexical fallback in resolveAgentPath.
  const args = [path.resolve(entryJs), "--experimental-acp", "--stream"];
  for (const dir of includeDirectories) {
    if (dir) args.push("--include-directories", path.resolve(dir));
  }
  return { command: process.execPath, args };
}

/**
 * Seed user-level iFlow rule configs that the vendored CLI's custom loaders
 * read from ~/.iflow/ (kimi-request-overrides / multimodal-models /
 * output-token-limits / thinking-models). These are USER-state files, not
 * package assets — the CLI never ships them — so the vendored copy carries
 * defaults (scripts/iflow-defaults → vendor/iflow-defaults) and this seeds
 * them once per machine.
 *
 * Rules (probed 2026-09-11 against the loader sources):
 *  - IFLOW_HOME wins over ~/.iflow, matching the loaders' own resolution.
 *  - Only MISSING files are copied; an existing file is user state and is
 *    NEVER overwritten.
 *  - Best effort: any IO failure returns what was created so far instead of
 *    blocking the connect path. A missing/unreadable config is safe — the
 *    loaders are zero-side-effect when their config is absent.
 */
export function ensureIflowDefaultConfigs(defaultsDir: string): string[] {
  if (!existsSync(defaultsDir)) return [];
  const home = process.env.IFLOW_HOME || path.join(os.homedir(), ".iflow");
  const created: string[] = [];
  try {
    mkdirSync(home, { recursive: true });
    for (const name of readdirSync(defaultsDir)) {
      if (!name.endsWith(".json")) continue;
      const target = path.join(home, name);
      if (existsSync(target)) continue;
      copyFileSync(path.join(defaultsDir, name), target);
      created.push(name);
    }
  } catch {
    return created;
  }
  return created;
}

/**
 * Restore the executable bit on binaries shipped inside the vendored CLI.
 *
 * Why: the VSIX packaging chain (npm tarball → vsce zip → VSCode's unzip on
 * install) does not reliably preserve unix mode bits, and the vendoring step
 * runs `npm install --ignore-scripts`, which skips the CLI's own postinstall
 * (the hook that would have downloaded ripgrep and chmod'd it). Result on
 * macOS/Linux installs: `vendor/iflow-cli/vendors/ripgrep/<plat>/rg` lands as
 * 0644 and every CLI search tool fails with
 * "spawn .../vendors/ripgrep/x64-darwin/rg EACCES" (reported on 1.2.3).
 *
 * Fix at connect time, next to ensureIflowDefaultConfigs: chmod every
 * non-windows `rg` we ship to 0755 when the exec bits are missing. Cheap
 * (a handful of stat calls), idempotent, and best-effort — a read-only
 * install must not block the connect flow. Windows is skipped (ntfs has no
 * exec bit and rg.exe runs regardless).
 */
export function ensureVendorBinariesExecutable(vendorDir: string): void {
  if (process.platform === "win32") return;
  const ripgrepDir = path.join(vendorDir, "vendors", "ripgrep");
  if (!existsSync(ripgrepDir)) return;
  try {
    for (const platform of readdirSync(ripgrepDir)) {
      if (platform.endsWith("win32")) continue;
      const bin = path.join(ripgrepDir, platform, "rg");
      let stat;
      try {
        stat = statSync(bin);
      } catch {
        continue; // COPYING etc. — not a platform dir
      }
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) continue;
      try {
        chmodSync(bin, 0o755);
      } catch {
        // best effort — the CLI surfaces a clear EACCES error if this fails
      }
    }
  } catch {
    // unreadable vendor dir — nothing we can do, never block the connect
  }
}

let cachedNode: string | null = null;
let nodeProbeInFlight: Promise<string | null> | null = null;

const MIN_NODE_MAJOR = 20;

/**
 * Locate a real Node executable for spawning the CLI.
 *
 * `process.execPath` inside the extension host is the Electron binary
 * (Code.exe) — it can run the CLI, but boots the whole Chromium runtime
 * first (probed on CLI 0.5.19: initialize ~13s under Code.exe vs ~6s under
 * plain node on the same machine). PATH `node` wins when it exists and
 * passes a one-time version check (>= 20, matching the repo's node20
 * target); null means "no usable standalone node" and the caller falls
 * back to process.execPath. Cached + de-duplicated + persisted across
 * windows (see LocatorPaths above).
 *
 * 2026-09-11 probe: a GUI-launched VSCode can hold a STALE PATH snapshot —
 * nvmd rewrote the user PATH, but the running host never inherited it, so
 * `where.exe node` finds nothing and every CLI spawn paid the Code.exe boot
 * (initialize 11796ms). The well-known candidates below are checked with
 * absolute paths precisely for that case — PATH is irrelevant to them.
 */
export async function locateNodeExecutable(): Promise<string | null> {
  if (nodeProbeInFlight) return nodeProbeInFlight;
  nodeProbeInFlight = (async () => {
    hydrateCache();
    if (cachedNode && existsSync(cachedNode)) return cachedNode;
    const candidates: string[] = [];
    try {
      const out =
        process.platform === "win32"
          ? (await execFileP("where.exe", ["node"], { windowsHide: true })).stdout
          : (await execFileP("which", ["node"])).stdout;
      for (const line of out.split(/\r?\n/).map((l: string) => l.trim())) {
        if (line && existsSync(line)) candidates.push(line);
      }
    } catch {
      // where/which unavailable or node not on the (possibly stale) host PATH
      // — the well-known candidates below still apply.
    }
    candidates.push(...wellKnownNodeCandidates());
    for (const line of candidates) {
      if (!existsSync(line)) continue;
      if (await nodeMajorAtLeast(line, MIN_NODE_MAJOR)) {
        cachedNode = line;
        persistResolved();
        return cachedNode;
      }
    }
    return null;
  })().finally(() => {
    nodeProbeInFlight = null;
  });
  return nodeProbeInFlight;
}

/**
 * Absolute-path node candidates, independent of the host process PATH.
 * nvmd: enumerate ~/.nvmd/versions/<semver>/node(.exe) and pick the highest
 * version — the real node binary, not the .nvmd/bin forwarding shim.
 */
function wellKnownNodeCandidates(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (process.platform === "win32") {
    return [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe"),
      home ? newestNvmdNode(home) : "",
      home ? path.join(home, "scoop", "apps", "nodejs", "current", "node.exe") : "",
      home ? path.join(home, "scoop", "apps", "nodejs-lts", "current", "node.exe") : "",
    ].filter((p): p is string => Boolean(p));
  }
  return [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    home ? path.join(home, ".local", "bin", "node") : "",
    home ? path.join(home, ".volta", "bin", "node") : "",
  ].filter((p): p is string => Boolean(p));
}

/** Highest x.y.z under ~/.nvmd/versions whose node binary exists, else "". */
function newestNvmdNode(home: string): string {
  try {
    const versionsDir = path.join(home, ".nvmd", "versions");
    const best = readdirSync(versionsDir)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          const d = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (d !== 0) return d;
        }
        return 0;
      })[0];
    if (!best) return "";
    const node = path.join(versionsDir, best, process.platform === "win32" ? "node.exe" : "node");
    return existsSync(node) ? node : "";
  } catch {
    return ""; // no nvmd layout
  }
}

/** `node --version` → major >= min? A one-time ~100ms probe per candidate. */
async function nodeMajorAtLeast(nodePath: string, min: number): Promise<boolean> {
  try {
    const version = (await execFileP(nodePath, ["--version"], { windowsHide: true, timeout: 5_000 })).stdout.trim();
    const major = Number.parseInt(/^v(\d+)\./.exec(version)?.[1] ?? "", 10);
    return Number.isFinite(major) && major >= min;
  } catch {
    return false;
  }
}

/**
 * Run the CLI under a renamed copy of the node binary.
 *
 * Why: dev cleanup scripts (`pkill node`, `killall node`) match on the process
 * name and kill the CLI mid-session. A copy named `iflow-rt` is invisible to
 * name-based kills (command-line-based `pkill -f entry.js` still matches —
 * this is a probability reduction, not a guarantee; session self-healing is
 * the real defense).
 *
 * Mechanics: copy → chmod → smoke-test (`--version`) → atomic rename into
 * `<storageDir>/runtime/`. The copy is re-made whenever the SOURCE binary's
 * size/mtime change (node upgrade). All fs calls are async: a ~90MB sync copy
 * would freeze the extension host (same lesson as trap #18). macOS code
 * signatures survive a plain content copy; the smoke test catches the rest
 * (Gatekeeper quarantine on a corrupted copy, disk-full mid-write, etc.).
 *
 * Every failure path returns the ORIGINAL node path — concealment is strictly
 * best-effort and must never break the connect flow. The Electron host binary
 * (process.execPath fallback) is never copied: Electron needs its app bundle
 * layout and is already invisible to `pkill node`.
 */
const CONCEALED_RUNTIME_NAME = process.platform === "win32" ? "iflow-rt.exe" : "iflow-rt";

let cachedConcealed: { source: string; path: string; size: number; mtimeMs: number } | null = null;
let concealInFlight: Promise<string> | null = null;

export function concealNodeExecutable(nodePath: string, storageDir: string): Promise<string> {
  if (concealInFlight) return concealInFlight;
  concealInFlight = concealNode(nodePath, storageDir).finally(() => {
    concealInFlight = null;
  });
  return concealInFlight;
}

async function concealNode(nodePath: string, storageDir: string): Promise<string> {
  try {
    if (path.resolve(nodePath) === path.resolve(process.execPath)) return nodePath;
    const source = await statP(nodePath);
    if (cachedConcealed && cachedConcealed.source === nodePath && cachedConcealed.size === source.size && cachedConcealed.mtimeMs === source.mtimeMs) {
      if (existsSync(cachedConcealed.path)) return cachedConcealed.path;
      cachedConcealed = null;
    }
    const dir = path.join(storageDir, "runtime");
    await mkdirP(dir, { recursive: true });
    const target = path.join(dir, CONCEALED_RUNTIME_NAME);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await copyFileP(nodePath, temp);
      await chmodP(temp, 0o755);
      // Smoke test BEFORE adopting the copy: a binary that cannot run
      // (quarantine, partial write, platform mismatch) must not become the
      // spawn target.
      await execFileP(temp, ["--version"], { windowsHide: true, timeout: 10_000 });
      await renameP(temp, target);
    } finally {
      await rmP(temp, { force: true }).catch(() => {});
    }
    cachedConcealed = { source: nodePath, path: target, size: source.size, mtimeMs: source.mtimeMs };
    return target;
  } catch {
    return nodePath;
  }
}