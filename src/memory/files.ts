import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameWithRetry } from "../acp/models-query.js";

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
 * Monotonic counter for temp-file names. Two writes inside the same
 * millisecond must not pick the same temp path, or they would clobber each
 * other's payload (and one writer would rename the other's content into
 * place).
 *
 * Same shape as `settingsTmpSeq` in src/acp/models-query.ts — the two
 * writers (the settings writer and this memory writer) target DIFFERENT
 * files, but they share the process, so each needs its own counter.
 */
let memoryTmpSeq = 0;

/**
 * A temp path that no concurrent writer can collide with: the pid (unique
 * among live processes) + a millisecond timestamp (unique across restarts) +
 * an in-process counter (unique within a millisecond).
 */
function uniqueTmpPath(file: string): string {
  memoryTmpSeq += 1;
  return `${file}.iflow-harness-tmp-${process.pid}-${Date.now()}-${memoryTmpSeq}`;
}

/**
 * Atomic write: temp file in the same directory, then rename. Every writer
 * (the panel and the CLI's save_memory tool) works on the same file, so a
 * concurrent external edit is caught by the caller's expectedHash check; the
 * temp+rename only guarantees readers never see a half-written file.
 *
 * The rename is retried on the transient Windows "target is busy" failure —
 * see `renameWithRetry` in src/acp/models-query.ts for the probed details
 * (replacing a file means deleting the old one, and Windows refuses to
 * delete an open file → EPERM while any reader/editor holds a handle). The
 * async flavour is used here on purpose: the backoff sleeps on the event
 * loop, so a stuck handle never blocks the extension host.
 */
export async function writeAtomic(
  file: string,
  content: string,
  options?: {
    /**
     * Test seam: replaces the `rename` used for the atomic replace.
     *
     * Production callers leave it unset — the default is the real rename
     * inside `renameWithRetry`. Tests inject a failing rename so the
     * transient-retry contract can be asserted on EVERY platform: on POSIX
     * a `rename` over an open file SUCCEEDS, so the Windows file-in-use
     * refusal cannot be reproduced there.
     */
    rename?: (from: string, to: string) => Promise<void>;
  },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = uniqueTmpPath(file);
  try {
    await writeFile(tmp, content, "utf8");
    // Node's rename replaces an existing file on Windows (libuv uses
    // MOVEFILE_REPLACE_EXISTING). Never delete the target first: a failed
    // replace must leave the previous content intact.
    await renameWithRetry(tmp, file, options?.rename ? { rename: options.rename } : undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * True when target is inside root (case-insensitive on Windows).
 *
 * 两道判断：词法（`path.relative`）与真实路径（解析符号链接 / Windows
 * junction）。词法那道挡不住「工作区里的一个链接指向工作区外」—— 附件通道只
 * 放行工作区内路径、会话暂存目录与用户本轮亲自附上的文件，链接会让工作区外
 * 的文件被当成工作区内的文件复制进子会话上下文。
 *
 * 真实路径解析不出来时（权限 / 环路 / 路径不存在）退回词法判断：**不能因为
 * 解析不了就把「在范围内」误判成越界**，那会误伤正常路径。
 */
export function isWithin(root: string, target: string): boolean {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  // 词法判断先做：不在范围内的路径不必碰磁盘。
  if (!isLexicallyWithin(rootAbs, targetAbs)) return false;
  return isLexicallyWithin(realPathOrSelf(rootAbs), realPathOrSelf(targetAbs));
}

/** 词法包含判断（不解符号链接）。 */
function isLexicallyWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/**
 * 真实路径解析结果的缓存。
 *
 * TTL 很短：链接可能被改指向，缓存不能长期有效（边界判断要看到当下的指向）。
 */
const REAL_PATH_CACHE_TTL_MS = 5_000;
const REAL_PATH_CACHE_MAX = 1024;
const realPathCache = new Map<string, { at: number; value: string }>();

/** 解析真实路径；解析不了就原样返回（词法形式）。 */
function realPathOrSelf(target: string): string {
  const now = Date.now();
  const cached = realPathCache.get(target);
  if (cached && now - cached.at < REAL_PATH_CACHE_TTL_MS) return cached.value;
  const value = resolveRealPath(target);
  if (realPathCache.size >= REAL_PATH_CACHE_MAX) {
    const oldest = realPathCache.keys().next().value;
    if (oldest !== undefined) realPathCache.delete(oldest);
  }
  realPathCache.set(target, { at: now, value });
  return value;
}

/**
 * 解析真实路径（符号链接 / junction 会被解掉）。
 *
 * 路径不存在时（待创建的文件）解析它最近的存在的祖先，再把剩下的段拼回去 ——
 * 这样「工作区里指向工作区外的链接」这种逃逸在新建文件时同样被挡住。
 */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 只有「不存在」才往上找祖先；其它错误（权限 / 环路）直接退回词法形式。
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolute;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
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
