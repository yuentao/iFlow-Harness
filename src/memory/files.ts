import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * CLI-side memory contract (probed with test/fixtures/probe-memory.mjs, CLI
 * 0.5.19 vendor bundle):
 *
 * - The hierarchical memory loader reads `AGENTS.md` / `IFLOW.md` from
 *   `os.homedir()/.iflow` and from the session cwd upward. It IGNORES
 *   IFLOW_HOME for this path (the loader imports `homedir` directly); the
 *   extension therefore uses the same hardcoded home so what the UI edits is
 *   exactly what the model receives.
 * - `memory.md` is a legacy file: the current loader does not read it. The
 *   UI may still show it as a legacy file, but it is never injected.
 * - `save_memory` appends under `## iFlow Added Memories`; the exact string
 *   manipulation below mirrors that tool so the panel and the agent produce
 *   byte-identical files.
 */
export const MEMORY_MARKER = "## iFlow Added Memories";
export const DEFAULT_CONTEXT_FILES = ["AGENTS.md", "IFLOW.md"] as const;

export function memoryHome(): string {
  return path.join(os.homedir(), ".iflow");
}

/** `contextFileName` from the CLI's settings.json is either a string or an
 * array; absent means the built-in default pair. Mirrors the bundle's
 * `Jce()` / `Lz()` behavior. */
export function resolveContextFileNames(contextFileName?: string | string[] | null): string[] {
  if (Array.isArray(contextFileName)) {
    const names = contextFileName.map((n) => n.trim()).filter(Boolean);
    return names.length > 0 ? names : [...DEFAULT_CONTEXT_FILES];
  }
  if (typeof contextFileName === "string" && contextFileName.trim()) {
    return [contextFileName.trim()];
  }
  return [...DEFAULT_CONTEXT_FILES];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ParsedMemoryFact {
  /** Stable within one file revision: line number + text hash. */
  id: string;
  text: string;
  /** Zero-based line index in the full file. */
  line: number;
}

/** The CLI's separator rule (Qzn in the bundle). */
function separatorFor(content: string): string {
  if (content.length === 0 || content.endsWith("\n\n") || content.endsWith("\r\n\r\n")) return "";
  if (content.endsWith("\n") || content.endsWith("\r\n")) return "\n";
  return "\n\n";
}

/**
 * Append one fact exactly like the CLI's save_memory tool:
 * - trim, strip leading dashes, prefix "- "
 * - create the marker at EOF when absent
 * - insert at the end of the marker section (before the next `## ` heading)
 */
export function appendFact(content: string, fact: string): string {
  const normalized = fact.trim().replace(/^(-+\s*)+/, "").trim();
  if (!normalized) return content;
  const bullet = `- ${normalized}`;
  const markerIndex = content.indexOf(MEMORY_MARKER);
  if (markerIndex === -1) {
    return `${content}${separatorFor(content)}${MEMORY_MARKER}\n${bullet}\n`;
  }
  const sectionStart = markerIndex + MEMORY_MARKER.length;
  let nextHeading = content.indexOf("\n## ", sectionStart);
  if (nextHeading === -1) nextHeading = content.length;
  const before = content.slice(0, sectionStart).trimEnd();
  const section = content.slice(sectionStart, nextHeading).trimEnd();
  const after = content.slice(nextHeading);
  const nextSection = `${section}\n${bullet}`;
  return `${before}\n${nextSection.trimStart()}\n${after}`.trimEnd() + "\n";
}

/** Facts inside the marker section, in file order. */
export function parseFacts(content: string): ParsedMemoryFact[] {
  const markerIndex = content.indexOf(MEMORY_MARKER);
  if (markerIndex === -1) return [];
  const sectionStart = markerIndex + MEMORY_MARKER.length;
  let sectionEnd = content.indexOf("\n## ", sectionStart);
  if (sectionEnd === -1) sectionEnd = content.length;
  const before = content.slice(0, sectionStart);
  const baseLine = before.split("\n").length - 1;
  const lines = content.slice(sectionStart, sectionEnd).split("\n");
  const facts: ParsedMemoryFact[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*-\s+(.*\S)\s*$/.exec(lines[i] ?? "");
    if (!match) continue;
    const text = match[1]!.trim();
    const line = baseLine + i;
    facts.push({ id: `${line}:${sha256(text).slice(0, 10)}`, text, line });
  }
  return facts;
}

/** Remove the given fact ids, leaving every other line untouched. */
export function deleteFacts(content: string, ids: readonly string[]): string {
  if (ids.length === 0) return content;
  const wanted = new Set(ids);
  const targets = new Set(
    parseFacts(content)
      .filter((f) => wanted.has(f.id))
      .map((f) => f.line),
  );
  if (targets.size === 0) return content;
  const lines = content.split("\n");
  return lines.filter((_, index) => !targets.has(index)).join("\n");
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function statIfExists(file: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? { bytes: info.size, mtimeMs: info.mtimeMs } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Atomic write: temp file in the same directory, then rename. Every writer
 * (the panel and the CLI's save_memory tool) works on the same file, so a
 * concurrent external edit is caught by the caller's expectedHash check; the
 * temp+rename only guarantees readers never see a half-written file.
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.iflow-harness-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, content, "utf8");
    // Node's rename replaces an existing file on Windows (libuv uses
    // MOVEFILE_REPLACE_EXISTING). Never delete the target first: a failed
    // replace must leave the previous content intact.
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** True when target is inside root (case-insensitive on Windows). */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** `~/.iflow/...` for home files, workspace-relative for project files. */
export function displayPathFor(
  file: string,
  workspaceRoots: readonly string[],
  home = memoryHome(),
): string {
  if (isWithin(home, file)) {
    const rel = path.relative(home, file);
    return rel ? `~/.iflow/${rel.replace(/\\/g, "/")}` : "~/.iflow";
  }
  for (const root of workspaceRoots) {
    if (isWithin(root, file)) {
      const rel = path.relative(root, file);
      return rel ? rel.replace(/\\/g, "/") : path.basename(file);
    }
  }
  return file;
}
