/**
 * Multi-root workspace helpers — ONE source of truth for "which directories is
 * this workspace made of", plus the pure logic behind the session-level root
 * subset (方案一: 会话级目标根子集 + 根前缀可视化).
 *
 * Why this module exists: the same inline expression
 * `(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)` had been
 * copied into the process spawn, the memory/assets services, the file search
 * and the session restore. Every copy was a place where a new rule (realpath
 * normalization, dedupe, stable order) would have to be re-implemented — and
 * the two sets that MUST agree (the host's fs-callback boundary and the CLI's
 * `--include-directories`) are exactly the ones that would silently drift.
 *
 * Everything here is pure except `defaultRealpath`; tests inject their own
 * `realpath` so no disk is touched.
 *
 * Ordering contract (important): the FIRST workspace folder keeps index 0,
 * because the panel derives the CLI process cwd from `roots[0]` and the CLI's
 * session file path depends on that cwd (see session-persistence.ts). Only the
 * remaining roots are sorted, so the list is deterministic without ever
 * moving the cwd.
 */

import path from "node:path";
import { realpathSync } from "node:fs";
import type { WorkspaceRootUi } from "../../shared/messages.js";

/** Case-insensitive on Windows, exact elsewhere (same rule as `isWithin`). */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Realpath with a lexical fallback: a missing/unreadable folder must not
 * drop the root from the list (VSCode can hand us a folder that was just
 * removed from disk). */
function defaultRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Short, `@`-mention-safe alias for a root: its basename with every
 * non-alphanumeric run collapsed to `-` (spaces and CJK would break the
 * mention token). Empty/odd names fall back to `root`. */
export function aliasForRootPath(rootPath: string): string {
  const base = path.basename(rootPath.replace(/[\\/]+$/, ""));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "root" : cleaned;
}

/** Assign unique aliases in list order (`web`, `web-2`, `web-3`, …). */
function assignAliases(paths: readonly string[]): WorkspaceRootUi[] {
  const used = new Set<string>();
  const out: WorkspaceRootUi[] = [];
  for (const rootPath of paths) {
    const base = aliasForRootPath(rootPath);
    let alias = base;
    let n = 2;
    while (used.has(alias.toLowerCase())) {
      alias = `${base}-${n}`;
      n += 1;
    }
    used.add(alias.toLowerCase());
    out.push({ path: rootPath, name: alias });
  }
  return out;
}

/**
 * Build the workspace root list: realpath-normalized, deduped (a symlinked
 * folder and its target are ONE root), first folder pinned to index 0, the
 * rest sorted by path.
 */
export function collectWorkspaceRoots(
  folders: readonly string[],
  realpath: (p: string) => string = defaultRealpath,
): WorkspaceRootUi[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of folders) {
    if (!raw) continue;
    const resolved = realpath(path.resolve(raw));
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(resolved);
  }
  if (ordered.length > 1) {
    const [first, ...rest] = ordered;
    rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return assignAliases([first!, ...rest]);
  }
  return assignAliases(ordered);
}

/** Read the live roots from a `vscode.workspace`-shaped object (structural
 * typing keeps this module vscode-free and unit-testable). */
export function workspaceRootsFrom(
  workspace: { workspaceFolders?: readonly { uri: { fsPath: string } }[] | undefined },
  realpath: (p: string) => string = defaultRealpath,
): WorkspaceRootUi[] {
  return collectWorkspaceRoots((workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), realpath);
}

/** Keep only paths that still exist in `roots`, in ROOT order (deterministic
 * regardless of the order the caller stored them in). Unknown paths are
 * dropped — a folder removed from the workspace must not linger as a
 * phantom CLI include directory. */
export function normalizeSelection(
  selected: readonly string[] | null | undefined,
  roots: readonly WorkspaceRootUi[],
): string[] {
  if (!selected) return roots.map((r) => r.path);
  const wanted = new Set(selected.map((p) => pathKey(path.resolve(p))));
  return roots.filter((r) => wanted.has(pathKey(r.path))).map((r) => r.path);
}

/**
 * `settings.add_dirs` for one session, or `null` when the request must be
 * omitted.
 *
 * `null` is the DEFAULT and it must stay byte-identical to the pre-MVP
 * behaviour — verified against the vendored bundle
 * (`vendor/iflow-fork/bundle/iflow.js`):
 *
 *   • session config: `includeDirectories:o?.add_dirs` (the ACP adapter maps
 *     `settings.add_dirs` straight onto the config's includeDirectories);
 *   • Config ctor: `new Yct(this.targetDir, e.includeDirectories ?? [])` —
 *     omitted → only the session cwd;
 *   • config factory: `includeDirectories:A.includeDirectories||r.includeDirectories`
 *     where `r` is argv — so an OMITTED `add_dirs` falls back to the spawn's
 *     `--include-directories` (the full root union = today's behaviour), while
 *     a PRESENT array (even `[]`) wins and tightens the WorkspaceContext.
 *
 * So "no selection" must omit the field, and "selected a strict subset" must
 * send `selected − cwd` (absolute paths). Selecting every root is the same as
 * today, so it also omits the field instead of sending a redundant full list.
 */
export function buildAddDirs(
  selected: readonly string[] | null | undefined,
  roots: readonly WorkspaceRootUi[],
  cwd: string | null | undefined,
): string[] | null {
  if (!selected || roots.length === 0) return null;
  const normalized = normalizeSelection(selected, roots);
  if (normalized.length === 0) return null; // nothing selected → keep today's full union
  if (normalized.length === roots.length) return null; // full selection → identical to today
  const cwdKey = cwd ? pathKey(path.resolve(cwd)) : null;
  return normalized.filter((p) => pathKey(p) !== cwdKey);
}

/** Is `candidate` inside `root` (lexical, after resolve)? */
function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `@<alias>/<rel>` mentions to absolute paths for the agent-facing
 * prompt.
 *
 * Only NON-cwd roots need this: a mention that resolves inside the session
 * cwd is already correct as a relative path (the CLI/model resolves it against
 * the cwd — pitfall #8), so it is left byte-identical to today. A mention into
 * a sibling root would otherwise be read relative to the cwd and point at
 * nothing.
 *
 * Guards: the alias must be a known root, the relative part must be non-empty,
 * and the joined path must stay INSIDE that root (a `../` escape is left
 * untouched rather than rewritten to a path outside the workspace).
 */
export function rewriteRootMentions(
  text: string,
  roots: readonly WorkspaceRootUi[],
  cwd: string | null | undefined,
): string {
  if (text === "" || roots.length <= 1) return text;
  const cwdKey = cwd ? pathKey(path.resolve(cwd)) : null;
  const byAlias = new Map<string, string>();
  for (const root of roots) {
    if (cwdKey !== null && pathKey(root.path) === cwdKey) continue;
    byAlias.set(root.name.toLowerCase(), root.path);
  }
  if (byAlias.size === 0) return text;
  return text.replace(/@([A-Za-z0-9._-]+)\/([^\s]*)/g, (whole, alias: string, rel: string) => {
    const rootPath = byAlias.get(alias.toLowerCase());
    if (!rootPath || rel === "") return whole;
    const abs = path.resolve(rootPath, rel);
    if (!isWithinRoot(abs, rootPath)) return whole;
    return `@${abs}`;
  });
}

/** UI projection for the current roots + selection + what the live session
 * actually uses. `pendingChange` drives the "对新会话生效" hint. */
export function buildWorkspaceRootsUi(
  roots: readonly WorkspaceRootUi[],
  selected: readonly string[] | null | undefined,
  applied: readonly string[] | null | undefined,
): { roots: WorkspaceRootUi[]; selected: string[]; applied: string[]; pendingChange: boolean } {
  const normalizedSelected = normalizeSelection(selected, roots);
  const appliedList = normalizeSelection(applied, roots);
  const same =
    appliedList.length === normalizedSelected.length &&
    appliedList.every((p, i) => pathKey(p) === pathKey(normalizedSelected[i]!));
  return {
    roots: roots.map((r) => ({ path: r.path, name: r.name })),
    selected: normalizedSelected,
    applied: appliedList,
    pendingChange: !same,
  };
}
