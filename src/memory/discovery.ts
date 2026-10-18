import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MemoryFileRole, MemoryScope } from "../../shared/messages.js";
import {
  displayPathFor,
  isWithin,
  memoryHome,
  resolveContextFileNames,
} from "./files.js";

export interface MemoryDiscoveryOptions {
  cwd: string | null;
  workspaceRoots: readonly string[];
  /** CLI settings.json `contextFileName` (string or array). */
  contextFileName?: string | string[] | null;
  /** Test hook: override the hardcoded `~/.iflow` memory home. */
  home?: string;
  /** Recursive discovery cap; 0 disables the extra scan (ancestors still). */
  maxRecursiveFiles?: number;
  /** Directory budget for the recursive scan. */
  maxDirectories?: number;
}

export interface DiscoveredMemoryFile {
  path: string;
  displayPath: string;
  scope: MemoryScope;
  role: MemoryFileRole;
  exists: boolean;
  editable: boolean;
  injected: boolean;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

function keyOf(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function existsOrNull(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function projectRootFor(cwd: string | null, workspaceRoots: readonly string[]): string | null {
  if (cwd) {
    const containing = workspaceRoots.find((root) => isWithin(root, cwd));
    if (containing) return containing;
  }
  return workspaceRoots[0] ?? cwd ?? null;
}

/**
 * Discover the files the CLI's hierarchical memory loader reads. Order:
 *   1. global `~/.iflow/<name>` (hardcoded home, IFLOW_HOME intentionally not
 *      honored — see files.ts header)
 *   2. project ancestors from the project root down to cwd
 *   3. recursive matches under the workspace roots (bounded)
 *   4. legacy `~/.iflow/memory.md` (shown, never injected)
 */
export async function discoverMemoryFiles(options: MemoryDiscoveryOptions): Promise<DiscoveredMemoryFile[]> {
  const names = resolveContextFileNames(options.contextFileName);
  const home = options.home ? path.resolve(options.home) : memoryHome();
  const workspaceRoots = [...options.workspaceRoots].map((r) => path.resolve(r));
  const cwd = options.cwd ? path.resolve(options.cwd) : null;
  const root = projectRootFor(cwd, workspaceRoots);
  const out: DiscoveredMemoryFile[] = [];
  const seen = new Set<string>();
  const push = (file: string, entry: Omit<DiscoveredMemoryFile, "path" | "displayPath">) => {
    const resolved = path.resolve(file);
    const key = keyOf(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      path: resolved,
      displayPath: displayPathFor(resolved, workspaceRoots, home),
      ...entry,
    });
  };

  // 1. Global candidates. Primary = first candidate that exists; when none
  // exists the first candidate is still returned (exists:false) so the card
  // can offer "create" at the exact path the loader will read.
  const globalPaths = names.map((name) => path.join(home, name));
  const globalExisting = await Promise.all(globalPaths.map((p) => existsOrNull(p)));
  const existingGlobalPaths = globalPaths.filter((_, index) => globalExisting[index] === true);
  if (existingGlobalPaths.length === 0) {
    // Nothing exists yet: expose the first candidate as the create target.
    push(globalPaths[0]!, {
      scope: "global",
      role: "primary",
      exists: false,
      editable: true,
      injected: false,
    });
  } else {
    existingGlobalPaths.forEach((file, index) => {
      push(file, {
        scope: "global",
        role: index === 0 ? "primary" : "additional",
        exists: true,
        editable: true,
        injected: true,
      });
    });
  }

  // 2. Project ancestor chain (root -> cwd), matching the CLI's unshift order.
  const ancestorFiles: string[] = [];
  if (cwd) {
    const stop = root && isWithin(root, cwd) ? path.resolve(root) : null;
    let dir = cwd;
    for (let depth = 0; depth < 32; depth++) {
      for (const name of names) ancestorFiles.unshift(path.join(dir, name));
      if (stop && path.resolve(dir) === stop) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const ancestorFlags = await Promise.all(ancestorFiles.map((p) => existsOrNull(p)));
  const existingAncestors = ancestorFiles.filter((_, index) => ancestorFlags[index] === true);
  if (cwd && existingAncestors.length === 0) {
    // Nothing exists yet: the cwd's first candidate is the create target.
    const placeholder = path.join(cwd, names[0]!);
    push(placeholder, {
      scope: "project",
      role: "primary",
      exists: false,
      editable: workspaceRoots.some((r) => isWithin(r, placeholder)),
      injected: false,
    });
  } else {
    // Primary: the cwd-most existing file (root -> cwd order).
    const primary = existingAncestors[existingAncestors.length - 1];
    existingAncestors.forEach((file) => {
      push(file, {
        scope: "project",
        role: file === primary ? "primary" : "additional",
        exists: true,
        editable: workspaceRoots.some((r) => isWithin(r, file)),
        injected: true,
      });
    });
  }

  // 3. Recursive matches under the workspace roots (the CLI also discovers
  // nested AGENTS.md / IFLOW.md files). Bounded: a large monorepo must not
  // turn the settings card into a full-tree scan.
  const maxFiles = options.maxRecursiveFiles ?? 200;
  const maxDirs = options.maxDirectories ?? 2_000;
  if (maxFiles > 0) {
    let files = 0;
    let dirs = 0;
    const walk = async (dir: string): Promise<void> => {
      if (files >= maxFiles || dirs >= maxDirs) return;
      dirs++;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files >= maxFiles || dirs >= maxDirs) return;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!names.includes(entry.name)) continue;
        files++;
        push(full, {
          scope: "project",
          role: "hierarchy",
          exists: true,
          editable: workspaceRoots.some((r) => isWithin(r, full)),
          injected: true,
        });
      }
    };
    for (const workspaceRoot of workspaceRoots) await walk(workspaceRoot);
  }

  // 4. Legacy `memory.md`: the current loader ignores it. Keep it visible so
  // users can migrate, but never claim it is injected.
  const legacy = path.join(home, "memory.md");
  if (!names.includes("memory.md") && (await existsOrNull(legacy))) {
    push(legacy, {
      scope: "global",
      role: "legacy",
      exists: true,
      editable: true,
      injected: false,
    });
  }

  return out;
}
