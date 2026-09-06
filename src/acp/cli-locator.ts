import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface IflowCommand {
  command: string;
  args: string[];
}

/**
 * Locate the installed iFlow CLI bundle entry (a plain .js file we can run
 * with the current Node runtime, avoiding .cmd shim quirks on Windows and
 * shebang wrappers on Unix).
 * Resolution order:
 *  1. IFLOW_CLI_ENTRY env var
 *  2. PATH lookup: `where.exe iflow` shims on Windows / `which iflow` on Unix
 *  3. npm global root fallback
 *  4. Platform-specific well-known install paths
 */
export function locateIflowEntry(): string | null {
  const fromEnv = process.env.IFLOW_CLI_ENTRY;
  if (fromEnv && existsSync(fromEnv)) return path.resolve(fromEnv);

  const fromPath = process.platform === "win32" ? locateFromWindowsPath() : locateFromUnixPath();
  if (fromPath) return fromPath;

  const fromNpm = locateFromNpmGlobalRoot();
  if (fromNpm) return fromNpm;

  for (const candidate of wellKnownCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function locateFromWindowsPath(): string | null {
  try {
    const whereOut = execFileSync("where.exe", ["iflow"], { encoding: "utf8", windowsHide: true });
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

function locateFromUnixPath(): string | null {
  try {
    const whichOut = execFileSync("which", ["iflow"], { encoding: "utf8" });
    const found = whichOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (!found || !existsSync(found)) return null;
    return entryFromUnixShim(found);
  } catch {
    // which unavailable or no match
  }
  return null;
}

/**
 * Resolve a Unix `iflow` on PATH to the bundle entry. nvmd/nvm/pnpm style
 * shims are symlinks straight to entry.js; a wrapper script (if any) is
 * scanned for an entry.js reference as a fallback.
 */
function entryFromUnixShim(found: string): string | null {
  try {
    const real = realpathSync(found);
    if (path.basename(real) === "entry.js") return real;
    // Wrapper script: look for an entry.js path inside it.
    const content = readFileSync(real, "utf8");
    const match = content.match(/([^\s"'`]*entry\.js)/);
    if (match?.[1]) {
      const candidate = path.resolve(path.dirname(real), match[1].replace(/^\$dirname\/?/, ""));
      if (existsSync(candidate)) return candidate;
    }
    // Sibling layout: shim next to node_modules/
    const sibling = path.join(path.dirname(real), "lib", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js");
    if (existsSync(sibling)) return sibling;
  } catch {
    // unreadable shim
  }
  return null;
}

function locateFromNpmGlobalRoot(): string | null {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: true })
        : execFileSync("npm", ["root", "-g"], { encoding: "utf8" });
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
  return { command: process.execPath, args: [path.resolve(entryJs), "--experimental-acp"] };
}
