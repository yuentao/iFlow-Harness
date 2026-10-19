/**
 * Plan artifact formatting (pure, no vscode dependency).
 *
 * An approved Plan-mode plan is persisted under `.iflow/specs/` so the
 * decision is reviewable after the session ends. The file is plain markdown
 * with a tiny frontmatter block; the plan body is preserved verbatim (the
 * file must show exactly what the agent was approved to execute).
 */

import type { PlanEntryUi } from "./messages.js";

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

/**
 * Approved plan → checklist entries for the TaskList progress card.
 * The card otherwise only appears once the agent itself calls the todo
 * tool; seeding at plan approval gives the round a task-level progress
 * view from the start (and lets the user tick items manually). Top-level
 * markdown list items (bullet or numbered, checkbox form tolerated) win;
 * a plan without any but with `## `/`### ` sections falls back to those
 * headings. Null when fewer than two usable items — a one-item card is
 * noise, and the todo tool may still drive the card later. Capped at 20
 * items so a plan dump cannot balloon the card.
 */
export function planChecklistEntries(plan: string): PlanEntryUi[] | null {
  const items: PlanEntryUi[] = [];
  const headings: PlanEntryUi[] = [];
  for (const raw of plan.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const item = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const text = item[1]!.replace(/^\[[ xX]\]\s*/, "").replace(/[*_`]/g, "").trim();
      if (text) items.push({ content: text, status: "pending" });
      continue;
    }
    const heading = /^#{2,3}\s+(\S.*)$/.exec(line);
    if (heading) headings.push({ content: heading[1]!.replace(/[*_`]/g, "").trim(), status: "pending" });
  }
  const chosen = items.length >= 2 ? items : headings.length >= 2 ? headings : null;
  return chosen ? chosen.slice(0, 20) : null;
}
