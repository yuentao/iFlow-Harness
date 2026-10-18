/**
 * Plan artifact formatting (pure, no vscode dependency).
 *
 * An approved Plan-mode plan is persisted under `.iflow/specs/` so the
 * decision is reviewable after the session ends. The file is plain markdown
 * with a tiny frontmatter block; the plan body is preserved verbatim (the
 * file must show exactly what the agent was approved to execute).
 */

export interface PlanSpecMeta {
  /** ACP session id (omitted for ad-hoc sessions). */
  sessionId?: string | null;
  createdAt: Date;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** First non-empty line, with markdown heading/bullet markers stripped. */
function firstMeaningfulLine(plan: string): string {
  for (const raw of plan.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (line) return line;
  }
  return "";
}

/** Filesystem-safe, human-readable slug (keeps CJK + letters/numbers). */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[`*_~>#]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "plan";
}

/**
 * `20261018-153000-fix-login-flow.md` — timestamp first so lexical sort is
 * chronological and Windows-reserved names (CON, PRN…) are never bare.
 */
export function planSpecFileName(plan: string, createdAt: Date): string {
  const stamp =
    `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}` +
    `-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}${pad(createdAt.getSeconds())}`;
  const title = firstMeaningfulLine(plan) || "plan";
  return `${stamp}-${slugify(title)}.md`;
}

/** Markdown body written to `.iflow/specs/…`. */
export function planSpecContent(plan: string, meta: PlanSpecMeta): string {
  const body = plan.trim();
  const title = firstMeaningfulLine(plan) || "Plan";
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `created: ${meta.createdAt.toISOString()}`,
  ];
  if (meta.sessionId?.trim()) lines.push(`session: ${meta.sessionId.trim()}`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}
