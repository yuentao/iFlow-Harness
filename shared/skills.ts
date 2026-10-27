/**
 * Skill invocation syntax shared by the host and the WebView.
 *
 * Wire behavior (probed against the iFlow CLI 0.5.19 bundle):
 *   - `session/new` reports `_meta.availableSkills` — `[{name, description,
 *     scope}]` from the CLI's SkillScanner (global `~/.iflow/skills` scanned
 *     first, project `<cwd>/.iflow/skills` second, GLOBAL WINS on a name
 *     clash — the project copy is not loaded).
 *   - The `Skill` tool itself is MODEL-invoked: the CLI asks for a
 *     confirmation before launching it (`shouldConfirmExecute`), which in ACP
 *     mode arrives as `session/request_permission` and is DENIED by the
 *     default approval policy. Asking the model to "call the Skill tool"
 *     therefore cannot be relied upon to actually run a skill.
 *
 * So the panel resolves a skill itself and injects the very payload the CLI's
 * Skill tool would have produced (`buildUserMessageContent`: the skill's base
 * directory + its body), plus the user's own instruction. That makes
 * `/skill <name>` a DETERMINISTIC trigger instead of a request the model may
 * ignore.
 */

/** The slash command that triggers a skill: `/skill <name> [instruction]`. */
export const SKILL_COMMAND = "skill";

export interface SkillInvocation {
  /** Skill name as reported by the CLI (the SKILL.md frontmatter `name`). */
  name: string;
  /** Everything after the skill name — the user's instruction (may be empty). */
  args: string;
}

/**
 * Parse `/skill <name> [args]`.
 *
 * Returns null when the text is not a skill invocation at all. A
 * `/skill` without a name is NOT an invocation (there is nothing to run) —
 * the caller may treat it as plain text.
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const s = text.trim();
  if (!s.startsWith("/")) return null;
  const rest = s.slice(1);
  const space = rest.indexOf(" ");
  const head = space === -1 ? rest : rest.slice(0, space);
  if (head.toLowerCase() !== SKILL_COMMAND) return null;
  const tail = space === -1 ? "" : rest.slice(space + 1).trim();
  if (!tail) return null;
  const tailSpace = tail.indexOf(" ");
  const name = tailSpace === -1 ? tail : tail.slice(0, tailSpace);
  const args = tailSpace === -1 ? "" : tail.slice(tailSpace + 1).trim();
  if (!name) return null;
  return { name, args };
}

/**
 * The text the agent receives for a skill invocation.
 *
 * Mirrors the CLI's Skill tool payload (`buildUserMessageContent`): the base
 * directory first (so the agent can read the skill's scripts/references
 * relative to it), then the skill body, then the user's instruction. The
 * skill body is passed through verbatim — the host transports it, it never
 * rewrites or summarises it.
 */
export function buildSkillPrompt(input: {
  baseDirectory: string;
  content: string;
  args: string;
}): string {
  const parts = [
    `Base directory for this skill:\n${input.baseDirectory}`,
    input.content.trim(),
    input.args,
  ].filter((part) => part.trim() !== "");
  return parts.join("\n\n");
}