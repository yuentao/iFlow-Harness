import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface IflowCommand {
  command: string;
  args: string[];
}

/**
 * Locate the installed iFlow CLI bundle entry (a plain .js file we can run
 * with the current Node runtime, avoiding .cmd shim quirks on Windows).
 * Resolution order:
 *  1. IFLOW_CLI_ENTRY env var
 *  2. `where.exe iflow` shims → extract entry.js path from the .cmd script
 *  3. npm global root fallback
 */
export function locateIflowEntry(): string | null {
  const fromEnv = process.env.IFLOW_CLI_ENTRY;
  if (fromEnv && existsSync(fromEnv)) return path.resolve(fromEnv);

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

  try {
    // npm global root (npm.cmd requires shell on Windows)
    const root = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: true })
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

  const candidates = [
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@iflow-ai", "iflow-cli", "bundle", "entry.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
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
