import path from "node:path";

/** Project knowledge lives beside the project memory, not in the extension
 * storage: it is a project asset users can review/commit. */
export const KNOWLEDGE_DIR = path.join(".iflow", "knowledge");
export const KNOWLEDGE_INDEX = "index.md";
export const MANAGED_START = "<!-- iflow-harness:knowledge:start -->";
export const MANAGED_END = "<!-- iflow-harness:knowledge:end -->";

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export interface WorkspaceFile {
  /** Absolute path (also what readFile receives). */
  path: string;
  /** Workspace-relative path with forward slashes. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/** Fingerprint of one scanned file; the manifest stores the full snapshot so
 * an incremental refresh can name added/modified/deleted files without
 * re-reading every source. */
export interface KnowledgeSource {
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface KnowledgeChange {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface KnowledgeManifestDoc {
  path: string;
  hash: string;
  tokens: number;
}

export interface KnowledgeManifest {
  version: number;
  generatedAt: string;
  model: string | null;
  mode: "full" | "incremental";
  docs: KnowledgeManifestDoc[];
  sources: KnowledgeSource[];
  /** The scan hit its file cap: source diffing is unreliable. */
  truncated?: boolean;
}

export interface WorkspaceScan {
  files: WorkspaceFile[];
  truncated: boolean;
}

export function buildKnowledgeSources(files: readonly WorkspaceFile[]): KnowledgeSource[] {
  const byRel = new Map<string, KnowledgeSource>();
  for (const file of files) {
    const rel = normalizeRel(file.rel);
    if (!rel) continue;
    byRel.set(rel, { rel, size: file.size, mtimeMs: file.mtimeMs });
  }
  return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

export function diffKnowledgeSources(
  previous: readonly KnowledgeSource[],
  current: readonly KnowledgeSource[],
): KnowledgeChange {
  const before = new Map(previous.map((s) => [normalizeRel(s.rel), s]));
  const after = new Map(current.map((s) => [normalizeRel(s.rel), s]));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [rel, source] of after) {
    const old = before.get(rel);
    if (!old) added.push(rel);
    else if (old.size !== source.size || old.mtimeMs !== source.mtimeMs) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel);
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}

export function hasKnowledgeChanges(change: KnowledgeChange): boolean {
  return change.added.length > 0 || change.modified.length > 0 || change.deleted.length > 0;
}

export function summarizeKnowledgeChanges(change: KnowledgeChange, maxPerList = 80): string {
  const list = (values: string[], label: string): string => {
    if (values.length === 0) return `${label}：无`;
    const shown = values.slice(0, maxPerList);
    const more = values.length > shown.length ? `\n… 另有 ${values.length - shown.length} 个` : "";
    return `${label}：\n${shown.map((v) => `- ${v}`).join("\n")}${more}`;
  };
  return [
    list(change.added, "新增文件"),
    "",
    list(change.modified, "修改文件"),
    "",
    list(change.deleted, "删除文件"),
  ].join("\n");
}

export function parseKnowledgeManifest(raw: string | null): KnowledgeManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<KnowledgeManifest> | null;
    if (!value || typeof value !== "object") return null;
    const docs = Array.isArray(value.docs)
      ? value.docs
          .filter((doc): doc is KnowledgeManifestDoc =>
            Boolean(doc) && typeof doc.path === "string" && typeof doc.hash === "string" && typeof doc.tokens === "number",
          )
          .map((doc) => ({ path: doc.path, hash: doc.hash, tokens: doc.tokens }))
      : [];
    const sources = Array.isArray(value.sources)
      ? value.sources
          .filter((source): source is KnowledgeSource =>
            Boolean(source) &&
            typeof source.rel === "string" &&
            typeof source.size === "number" &&
            typeof source.mtimeMs === "number",
          )
          .map((source) => ({
            rel: normalizeRel(source.rel),
            size: source.size,
            mtimeMs: source.mtimeMs,
          }))
      : [];
    return {
      version: typeof value.version === "number" ? value.version : 1,
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
      model: typeof value.model === "string" ? value.model : null,
      mode: value.mode === "incremental" ? "incremental" : "full",
      docs,
      sources,
      ...(value.truncated === true ? { truncated: true } : {}),
    };
  } catch {
    return null;
  }
}

export function readManagedKnowledgeImports(content: string): string[] {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END, start + MANAGED_START.length);
  if (start === -1 || end === -1) return [];
  return [
    ...new Set(
      content
        .slice(start + MANAGED_START.length, end)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("@"))
        .map((line) => line.slice(1).trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Replace/remove the managed block. Only this block is touched: user-written
 * memory above/below it is preserved byte-for-byte (apart from the blank-line
 * normalization needed when the block is appended/removed).
 */
export function setManagedKnowledgeBlock(content: string, imports: readonly string[]): string {
  const unique = [...new Set(imports.map((i) => i.trim()).filter(Boolean))];
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END, start + MANAGED_START.length);
  const hasBlock = start !== -1 && end !== -1;
  if (unique.length === 0) {
    if (!hasBlock) return content;
    const before = content.slice(0, start).trimEnd();
    const after = content.slice(end + MANAGED_END.length).trimStart();
    const joined = [before, after].filter(Boolean).join("\n\n");
    return joined ? `${joined}\n` : "";
  }
  const block = [
    MANAGED_START,
    "## 项目知识库",
    ...unique.map((imp) => `@${imp}`),
    MANAGED_END,
  ].join("\n");
  if (hasBlock) {
    return `${content.slice(0, start)}${block}${content.slice(end + MANAGED_END.length)}`.trimEnd() + "\n";
  }
  const base = content.trimEnd();
  return `${base}${base ? "\n\n" : ""}${block}\n`;
}

const KEY_FILE = /^(README(?:\.[a-z]+)?|readme(?:\.[a-z]+)?|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile|docker-compose\.ya?ml|tsconfig\.json|vite\.config\.[a-z]+|AGENTS\.md|IFLOW\.md|\.editorconfig|eslint\.config\.[a-z]+|biome\.json|pnpm-workspace\.yaml|lerna\.json|turbo\.json)$/;

function isKeyFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return KEY_FILE.test(base);
}

/** Compact deterministic top-level tree shared by full/incremental prompts. */
export function buildWorkspaceTreeSummary(
  files: readonly WorkspaceFile[],
  maxFiles = 2_000,
  truncated = false,
): string {
  const sample = [...files].sort((a, b) => a.rel.localeCompare(b.rel)).slice(0, maxFiles);
  const top = new Map<string, { files: number; bytes: number }>();
  for (const file of sample) {
    const first = file.rel.split("/")[0] ?? file.rel;
    const entry = top.get(first) ?? { files: 0, bytes: 0 };
    entry.files++;
    entry.bytes += file.size;
    top.set(first, entry);
  }
  const tree = [...top.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 120)
    .map(([name, entry]) =>
      entry.bytes > 0
        ? `${name}/  (${entry.files} files, ${Math.round(entry.bytes / 1024)} KB)`
        : `${name}/  (${entry.files} files)`,
    )
    .join("\n");
  return [
    truncated
      ? `采样文件数：${sample.length}+（已达扫描上限）`
      : `采样文件数：${sample.length} / ${files.length}`,
    "",
    "## 顶层结构",
    tree || "（无）",
  ].join("\n");
}

/** Build a compact, deterministic workspace digest for the index prompt. */
export async function buildWorkspaceDigest(
  files: readonly WorkspaceFile[],
  readFile: (file: string) => Promise<string | null>,
  limits: {
    maxFiles?: number;
    maxExcerptChars?: number;
    totalExcerptChars?: number;
    truncated?: boolean;
  } = {},
): Promise<string> {
  const maxExcerpt = limits.maxExcerptChars ?? 8_000;
  const totalExcerpt = limits.totalExcerptChars ?? 24_000;
  const sample = [...files]
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .slice(0, limits.maxFiles ?? 2_000);
  const tree = buildWorkspaceTreeSummary(
    files,
    limits.maxFiles ?? 2_000,
    limits.truncated === true,
  );

  const excerpts: string[] = [];
  let used = 0;
  for (const file of sample) {
    if (used >= totalExcerpt) break;
    if (!isKeyFile(file.rel)) continue;
    const content = await readFile(file.path);
    if (!content) continue;
    const remaining = Math.min(maxExcerpt, totalExcerpt - used);
    if (remaining <= 0) break;
    const clipped = content.length > remaining ? content.slice(0, remaining) : content;
    excerpts.push(`### ${file.rel}\n${clipped.trim()}`);
    used += clipped.length;
  }
  return [
    tree,
    "",
    "## 关键文件摘录",
    excerpts.length > 0 ? excerpts.join("\n\n") : "（未找到关键文件）",
  ].join("\n");
}

export function buildKnowledgePrompt(digest: string): string {
  return [
    "你在为一个代码仓库生成「项目知识索引」，供编码助手在后续会话中快速理解项目。",
    "只基于提供的文件树和摘录，不要编造不存在的模块、命令或依赖。",
    "输出 Markdown，固定结构：",
    "# 项目知识索引",
    "## 概览",
    "## 技术栈与运行方式",
    "## 目录结构与关键模块",
    "## 约定与陷阱",
    "## 常用命令",
    "",
    "要求：",
    "- 控制在约 1500-2500 tokens；信息密度优先。",
    "- 不要用代码围栏包裹整篇文档。",
    "- 不确定的内容写“未从文件中确认”，不要猜测。",
    "",
    "仓库信息：",
    digest,
  ].join("\n");
}

/** Key-file excerpts for changed/added files only. This is the incremental
 * prompt's counterpart to buildWorkspaceDigest's full key-file scan. */
export async function buildChangedKeyExcerpts(
  files: readonly WorkspaceFile[],
  change: KnowledgeChange,
  readFile: (file: string) => Promise<string | null>,
  limits: { maxExcerptChars?: number; totalExcerptChars?: number } = {},
): Promise<string> {
  const wanted = new Set([...change.added, ...change.modified].map(normalizeRel));
  const maxExcerpt = limits.maxExcerptChars ?? 6_000;
  const totalExcerpt = limits.totalExcerptChars ?? 8_000;
  const excerpts: string[] = [];
  let used = 0;
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    if (used >= totalExcerpt) break;
    if (!wanted.has(normalizeRel(file.rel)) || !isKeyFile(file.rel)) continue;
    const content = await readFile(file.path);
    if (!content) continue;
    const remaining = Math.min(maxExcerpt, totalExcerpt - used);
    if (remaining <= 0) break;
    const clipped = content.length > remaining ? content.slice(0, remaining) : content;
    excerpts.push(`### ${file.rel}\n${clipped.trim()}`);
    used += clipped.length;
  }
  return excerpts.length > 0 ? excerpts.join("\n\n") : "（无关键文件内容变化）";
}

export function buildIncrementalKnowledgePrompt(
  previousIndex: string,
  change: KnowledgeChange,
  treeSummary: string,
  changedExcerpts: string,
): string {
  const previous = previousIndex.length > 12_000
    ? `${previousIndex.slice(0, 12_000).trimEnd()}\n\n…（旧索引已截断）`
    : previousIndex;
  return [
    "你在维护一份代码仓库的「项目知识索引」。下面是当前索引，以及上次生成后发生的变化。",
    "请只根据变化更新索引：保留未受影响章节的内容，修正目录结构/模块描述，删除已不存在内容的提及。",
    "不要编造文件树和摘录之外的信息。",
    "输出完整的更新后 Markdown 文档（不是 diff），保持原有章节结构：",
    "# 项目知识索引",
    "## 概览",
    "## 技术栈与运行方式",
    "## 目录结构与关键模块",
    "## 约定与陷阱",
    "## 常用命令",
    "",
    "要求：控制在约 1500-2500 tokens；不要用代码围栏包裹整篇文档。",
    "",
    "## 当前索引",
    previous.trim(),
    "",
    "## 变化摘要",
    summarizeKnowledgeChanges(change, 60),
    "",
    "## 当前目录结构",
    treeSummary,
    "",
    "## 变化的关键文件摘录",
    changedExcerpts,
  ].join("\n");
}

/** Strip an accidental outer markdown fence and enforce the title/trailing
 * newline. Generation failures still yield a usable document, never a crash. */
export function sanitizeGeneratedMarkdown(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  if (!/^#\s+/.test(text)) text = `# 项目知识索引\n\n${text}`;
  if (text.length > 20_000) text = `${text.slice(0, 20_000).trimEnd()}\n\n…（已截断）`;
  return `${text.trimEnd()}\n`;
}
