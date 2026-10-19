import type { AssetKind } from "./messages.js";

/**
 * Pure helpers behind the asset card's 「AI 生成」 button (F4).
 *
 * A generation is a plain text rewrite, so it runs through the panel's direct
 * gateway completion (`streamChatCompletion`) and never through an agent
 * session — AGENTS.md pitfall #26: the CLI's ~61K-token fixed input (system
 * prompt + every tool schema) pushes thinking models into 180s+ reasoning
 * loops on tasks that need no tools at all.
 *
 * The model is asked for the file content ONLY (frontmatter + body, no prose,
 * no fences). `normalizeGeneratedAsset` is the defensive half: it strips the
 * fences a chatty model adds anyway and guarantees the kind-critical
 * frontmatter the CLI's loader keys off, so a half-compliant answer still
 * loads instead of being silently skipped (probed loader rules: agents need
 * `agent-type`/`name`, skills need `name`, commands fall back to the first
 * `#` heading for their description).
 */

/** Per-kind output contract stated in the prompt (English: model-facing). */
const KIND_CONTRACT: Record<AssetKind, string> = {
  command:
    "Frontmatter keys: `description` (one line, what the command does). The body is the prompt the CLI runs when the user types the slash command; refer to the user's arguments as `{{args}}` where appropriate.",
  agent:
    "Frontmatter keys: `name` (MUST be exactly the given name), `description` (when to delegate to this subagent), `allowed-tools` (comma-separated tool names it may use). The body is the subagent's system instructions.",
  skill:
    "Frontmatter keys: `name` (MUST be exactly the given name), `description` (when this skill applies — the model uses it to judge relevance). The body is the step-by-step procedure the model follows when the skill is invoked.",
};

const KIND_NOUN: Record<AssetKind, string> = {
  command: "custom slash command",
  agent: "subagent definition",
  skill: "skill",
};

/** Minimal loader-valid frontmatter per kind (also the empty-answer fallback). */
function requiredFrontmatter(kind: AssetKind, name: string): string {
  const safeName = name.trim() || "generated";
  switch (kind) {
    case "command":
      return `---\ndescription: ${safeName}\n---\n`;
    case "agent":
      return `---\nname: ${safeName}\ndescription: 何时委派到此子代理\nallowed-tools: Read, Grep, Glob\n---\n`;
    default:
      return `---\nname: ${safeName}\ndescription: 使用场景说明\n---\n`;
  }
}

/**
 * Build the single user-message prompt for one generation.
 *
 * The requirement is the user's own free text and is embedded verbatim: this
 * is a local file the user reviews in the editor before anything reaches disk,
 * and re-sanitizing their own instruction would only mangle it. (`@path`
 * mentions need no stripping here — unlike enhance/AI-title this prompt never
 * enters a CLI session, so there is no file-expansion or thinking-loop risk.)
 */
export function buildAssetGenPrompt(kind: AssetKind, name: string, requirement: string): string {
  const trimmedName = name.trim();
  return [
    `You write iFlow CLI ${KIND_NOUN[kind]} files. Output the COMPLETE file content and NOTHING else — no explanation, no preamble, no markdown code fences.`,
    "",
    "The file is Markdown whose first line is `---`, then a short YAML frontmatter block, then a closing `---`, then the instruction body.",
    KIND_CONTRACT[kind],
    ...(trimmedName ? ["", `Name: ${trimmedName}`] : []),
    "",
    "Requirements from the user:",
    requirement.trim() || "(none given — produce a sensible, focused default for this kind)",
    "",
    "Respond with the file content only, starting with the opening `---`.",
  ].join("\n");
}

/** Drop one wrapping fenced code block (```lang … ```) when present. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (match ? match[1]! : trimmed).trim();
}

/** Frontmatter line range: [first content line, exclusive end] or null. */
function frontmatterRange(lines: string[]): [number, number] | null {
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? "";
    if (t === "---" || t === "...") return [1, i];
  }
  return null;
}

function hasFrontmatter(text: string): boolean {
  return frontmatterRange(text.replace(/\r\n/g, "\n").split("\n")) !== null;
}

/** Does the frontmatter carry a name-ish key (agent/skill loader requirement)? */
function hasNameKey(text: string): boolean {
  const range = frontmatterRange(text.replace(/\r\n/g, "\n").split("\n"));
  if (!range) return false;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = range[0]; i < range[1]; i++) {
    if (/^\s*(name|agent-type|agentType)\s*:\s*\S/.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * Normalize a model answer into a file-ready body. Never throws.
 *
 * - strips a wrapping code fence;
 * - prepends the kind's minimal frontmatter when the answer has none;
 * - injects `name:` for agent/skill when the frontmatter lacks it (the CLI
 *   skips such files outright, so a missing key would silently lose the asset);
 * - falls back to the bare skeleton on an empty answer, so the editor always
 *   shows something editable rather than a blank box;
 * - guarantees a trailing newline (the card's own templates end with one).
 */
export function normalizeGeneratedAsset(raw: string, kind: AssetKind, name: string): string {
  let body = stripCodeFence(raw ?? "");
  if (!body) return requiredFrontmatter(kind, name);
  if (!hasFrontmatter(body)) {
    body = `${requiredFrontmatter(kind, name)}\n${body}`;
  } else if ((kind === "agent" || kind === "skill") && !hasNameKey(body)) {
    const lines = body.replace(/\r\n/g, "\n").split("\n");
    lines.splice(1, 0, `name: ${name.trim() || "generated"}`);
    body = lines.join("\n");
  }
  return body.endsWith("\n") ? body : `${body}\n`;
}
