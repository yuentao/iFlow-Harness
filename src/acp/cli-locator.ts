import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

export interface IflowCommand {
  command: string;
  args: string[];
}

/**
 * Located entry cache. The probe shells out (where.exe / `npm root -g` —
 * up to seconds on Windows, `npm` especially) and used to re-run on EVERY
 * reconnect: every profile switch paid the full probe again. Successful
 * results are cached (re-validated with existsSync, so an uninstalled CLI
 * re-probes); failures are NOT cached, so a CLI installed mid-session is
 * found on the next connect without a host restart.
 */
let cachedEntry: string | null = null;
let probeInFlight: Promise<string | null> | null = null;

/**
 * Locate the installed iFlow CLI bundle entry (a plain .js file we can run
 * with the current Node runtime, avoiding .cmd shim quirks on Windows and
 * shebang wrappers on Unix).
 *
 * Async on purpose: the probes were execFileSync, which blocked the
 * extension host's event loop for the full duration of where.exe /
 * `npm root -g` while every other extension froze.
 *
 * Resolution order:
 *  1. IFLOW_CLI_ENTRY env var (checked on every call — costs nothing and
 *     keeps test/harness overrides working with the cache)
 *  2. PATH lookup: `where.exe iflow` shims on Windows / `which iflow` on Unix
 *  3. npm global root fallback
 *  4. Platform-specific well-known install paths
 */
export async function locateIflowEntry(): Promise<string | null> {
  const fromEnv = process.env.IFLOW_CLI_ENTRY;
  if (fromEnv && existsSync(fromEnv)) return path.resolve(fromEnv);

  if (probeInFlight) return probeInFlight;
  probeInFlight = locateUncached()
    .then((found) => {
      if (found) cachedEntry = found;
      return found ?? cachedEntry;
    })
    .finally(() => {
      probeInFlight = null;
    });
  return probeInFlight;
}

async function locateUncached(): Promise<string | null> {
  // Cached hit still re-validates: a removed CLI must not pin a dead path.
  if (cachedEntry && existsSync(cachedEntry)) return cachedEntry;

  const fromPath =
    process.platform === "win32" ? await locateFromWindowsPath() : await locateFromUnixPath();
  if (fromPath) return fromPath;

  const fromNpm = await locateFromNpmGlobalRoot();
  if (fromNpm) return fromNpm;

  for (const candidate of wellKnownCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function locateFromWindowsPath(): Promise<string | null> {
  try {
    const whereOut = (await execFileP("where.exe", ["iflow"], { windowsHide: true })).stdout;
    for (const line of whereOut.split(/\r?\n/).map((l: string) => l.trim())) {
      if (!line || !/\.(cmd|bat)$/i.test(line) || !existsSync(line)) continue;
      const fromShim = extractEntryFromShim(line);
      if (fromShim) return fromShim;
    }
  } catch {
    // where.exe unavailable or no match
  }
  return null;
}

async function locateFromUnixPath(): Promise<string | null> {
  try {
    const whichOut = (await execFileP("which", ["-a", "iflow"])).stdout;
    // The first hit may be a native dispatcher (nvmd) rather than a real shim;
    // try every PATH match before falling through to other strategies.
    for (const found of whichOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (!existsSync(found)) continue;
      const entry = entryFromUnixShim(found);
      if (entry) return entry;
    }
  } catch {
    // which unavailable or no match
  }
  return null;
}

/**
 * Resolve a Unix `iflow` on PATH to the bundle entry. nvmd/nvm/pnpm style
 * shims are symlinks straight to entry.js — but multi-version managers like
 * nvmd may point at a NATIVE dispatcher binary instead. Reading that as text
 * and regex-scanning it blocked the extension host for seconds (profiled,
 * 100% CPU), so only small text scripts are ever scanned.
 */
function entryFromUnixShim(found: string): string | null {
  try {
    const real = realpathSync(found);
    if (path.basename(real) === "entry.js") return real;

    // Guard: never scan binaries / large files (native dispatchers, etc.).
    const MAX_SCRIPT_BYTES = 256 * 1024;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
    // NUL byte in the first KB → binary (nvmd-style native dispatcher).
    const head = Buffer.alloc(1024);
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, 1024, 0);
    } finally {
      closeSync(fd);
    }
    if (head.includes(0)) return null;

    // Wrapper script: look for an entry.js path inside it.
    const text = readFileSync(real, "utf8");
    const match = text.match(/([^\s"'`]*entry\.js)/);
    if (match?.[1]) {
      const candidate = path.resolve(path.dirname(real), match[1].replace(/^\$dirname\/?/, ""));
      if (existsSync(candidate)) return candidate;
    }
    // Sibling layout: shim next to lib/node_modules (version-manager layout).
    const sibling = path.join(path.dirname(real), "lib", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js");
    if (existsSync(sibling)) return sibling;
    return null;
  } catch {
    // unreadable shim
  }
  return null;
}

async function locateFromNpmGlobalRoot(): Promise<string | null> {
  try {
    const out =
      process.platform === "win32"
        ? (await execFileP("npm.cmd", ["root", "-g"], { windowsHide: true, shell: true })).stdout
        : (await execFileP("npm", ["root", "-g"])).stdout;
    const root = out
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(Boolean)
      .at(-1);
    if (root) {
      const candidate = path.join(root, "@iflow-ai", "iflow-cli", "bundle", "entry.js");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // npm not resolvable
  }
  return null;
}

function wellKnownCandidates(): string[] {
  if (process.platform === "win32") {
    return [
      path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js"),
    ];
  }
  const home = process.env.HOME ?? "";
  const prefixRoots = [
    "/usr/local",
    "/opt/homebrew",
    path.join(home, ".npm-global"),
    path.join(home, ".nvmd", "current"),
  ];
  return prefixRoots.map((p) => path.join(p, "lib", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js"));
}

/**
 * Extract the bundle entry from an npm .cmd shim. Shims reference the entry
 * via %dp0% / %~dp0 variables (relative to the shim directory), so expand
 * those before matching an absolute path.
 */
function extractEntryFromShim(shimPath: string): string | null {
  try {
    const content = readFileSync(shimPath, "utf8");
    const dir = path.dirname(shimPath);
    const expanded = content
      .replace(/%~dp0/gi, dir + path.sep)
      .replace(/%dp0%/gi, dir + path.sep)
      .replace(/\\\\+/g, "\\");
    const match = expanded.match(/([A-Za-z]:\\[^\s"%|&*<>]*?entry\.js)/);
    if (match?.[1] && existsSync(match[1])) return path.resolve(match[1]);

    // Sibling layout fallback: shim lives next to node_modules/
    const sibling = path.join(dir, "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js");
    if (existsSync(sibling)) return sibling;
  } catch {
    // unreadable shim
  }
  return null;
}

export function buildAcpCommand(entryJs: string): IflowCommand {
  // --stream (probed, CLI 0.5.19 bundle): without it `config.stream` is false
  // and the ACP prompt handler awaits `sendMessageLatency` — the FULL model
  // response arrives as one dump after each turn, so the panel shows replies
  // in segments instead of streaming. With it the turn loop iterates the
  // SSE stream and emits `agent_message_chunk` per delta.
  return { command: process.execPath, args: [path.resolve(entryJs), "--experimental-acp", "--stream"] };
}