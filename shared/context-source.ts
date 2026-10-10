/**
 * M2 P0-4 — @mention context sources (pure, unit-testable).
 *
 * The Extension Host reads the actual sources (workspace files, diagnostics,
 * git, HTTP) and funnels every result through the helpers here: truncation,
 * formatting and the final prompt assembly. Zero VSCode dependency so the
 * assembly discipline (order, truncation, normalizeUserPromptText
 * compatibility — roadmap P0-4 test requirement) is pinned by unit tests.
 *
 * Assembly discipline (same as the old single code-context card): every card
 * becomes a titled fenced section; the composed prefix NEVER starts with "/"
 * (it starts with the section title), so the CLI's slash-command gate cannot
 * misfire on it. Sections ride RAW (no "/"-escape — that belongs to the typed
 * text only, see toAgentPromptText's docstring).
 */

import type { ContextRefUi } from "./messages.js";

/** Per-kind content caps (characters) — roadmap P0-4 limits. */
export const CONTEXT_CHAR_LIMITS = {
  /** Right-click selection: bounded by the editor, keep generous. */
  code: 64_000,
  /** Folder listing: path lines only (no file bodies). */
  folder: 16_000,
  /** Diagnostics report. */
  problems: 16_000,
  /** git status + diff. */
  git: 32_000,
  /** Fetched URL text. */
  url: 64_000,
} as const;

/** Hard-cap a string, appending a truncation marker the model can see. */
export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

/** Fence chosen so a body containing ``` still cannot break out. */
function fenceFor(body: string): string {
  let ticks = 3;
  const runs = body.match(/`+/g) ?? [];
  for (const run of runs) ticks = Math.max(ticks, run.length + 1);
  return "`".repeat(Math.min(ticks, 8));
}

/** One context card → titled fenced section (host l10n supplies the title). */
export function formatContextSection(ctx: ContextRefUi, title: string): string {
  const body = truncateChars(ctx.content, CONTEXT_CHAR_LIMITS[ctx.kind] ?? 32_000);
  const fence = fenceFor(body);
  return [title, "", `${fence}text`, body, fence].join("\n");
}

/**
 * Assemble all context cards into the prompt prefix, in card order (composer
 * left → right). Empty list → empty string. Joined by blank lines; the typed
 * text is appended by the caller.
 */
export function assembleContextSections(
  contexts: readonly ContextRefUi[],
  titleFor: (ctx: ContextRefUi) => string,
): string {
  return contexts
    .filter((c) => c.content.trim() !== "")
    .map((c) => formatContextSection(c, titleFor(c)))
    .join("\n\n");
}

// --- @folder ---------------------------------------------------------------

/** Roadmap P0-4: the folder listing caps at this many direct children. */
export const FOLDER_LISTING_MAX = 200;

/** Normalize a workspace-relative folder path: forward slashes, no leading
 * "./", no trailing slash. Root is "". */
export function normalizeFolderRel(query: string): string {
  return query
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Direct children of `folderRel` from a workspace-relative file list (the
 * @-mention cache). Folders are reported with a trailing "/" (files without).
 * Hidden dot-entries and the usual heavy dirs are dropped; the listing caps
 * at FOLDER_LISTING_MAX with a truncation notice. Returns null-path results
 * as a plain text body ready for ContextRefUi.content.
 */
export function buildFolderListing(rels: readonly string[], folderRel: string): string {
  const folder = normalizeFolderRel(folderRel);
  const prefix = folder === "" ? "" : `${folder}/`;
  const children = new Map<string, boolean>(); // name → isDir
  for (const rel of rels) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      children.set(rest, false);
    } else {
      const dir = rest.slice(0, slash);
      if (dir.startsWith(".")) continue;
      children.set(`${dir}/`, true);
    }
  }
  const names = [...children.keys()]
    .filter((n) => !n.startsWith("."))
    .sort((a, b) => {
      // directories first, then case-insensitive alphabetical
      const da = a.endsWith("/") ? 0 : 1;
      const db = b.endsWith("/") ? 0 : 1;
      return da - db || a.localeCompare(b);
    });
  const capped = names.slice(0, FOLDER_LISTING_MAX);
  const lines = capped.map((n) => `- ${n}`);
  if (names.length > capped.length) {
    lines.push(`…（共 ${names.length} 项，仅列出前 ${FOLDER_LISTING_MAX} 项）`);
  }
  return lines.join("\n");
}

// --- @problems -------------------------------------------------------------

export interface DiagnosticLineUi {
  path: string;
  line: number;
  severityLabel: string;
  message: string;
}

/** Format grouped diagnostics into the card body. Callers pass entries
 * pre-sorted (severity, then path); this only renders and caps. */
export function formatDiagnosticsReport(entries: readonly DiagnosticLineUi[]): string {
  const lines: string[] = [];
  let lastPath: string | null = null;
  for (const e of entries) {
    if (e.path !== lastPath) {
      lines.push(`${e.path}:`);
      lastPath = e.path;
    }
    lines.push(`  [${e.severityLabel}] L${e.line}: ${e.message}`);
  }
  return lines.join("\n");
}

// --- @git ------------------------------------------------------------------

/**
 * `git status --porcelain` → human lines. Keeps the XY status codes (the
 * model reads them well) and groups nothing — order is git's.
 */
export function formatGitStatus(porcelain: string): string {
  const lines = porcelain
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return "（工作区干净，无未提交变更）";
  return lines.map((l) => `  ${l}`).join("\n");
}

/** Compose the @git card body from status + diff outputs (either may be ""). */
export function buildGitReport(statusPorcelain: string, diff: string, truncated: boolean): string {
  const parts: string[] = ["状态（git status --porcelain）：", formatGitStatus(statusPorcelain)];
  if (diff.trim() !== "") {
    parts.push("", "变更内容（git diff，未含未跟踪文件的正文）：", diff.trimEnd());
  }
  if (truncated) parts.push("", "…（diff 超过上限已截断）");
  return parts.join("\n");
}

// --- @url ------------------------------------------------------------------

/**
 * Crude HTML → text: drop script/style/head blocks, strip tags, decode the
 * handful of entities that actually show up, collapse blank lines. Not a
 * parser — a context-injection extractor (roadmap P0-4 "HTML 粗提取").
 */
export function extractHtmlText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}

/** Only http/https may be fetched (same discipline as openExternal). */
export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
