/**
 * Minimal, dependency-free reader for the two structured fields the CLI's
 * command `.toml` format actually surfaces in the asset card: a single-line
 * `description = "…"` and a triple-quoted `prompt = """…"""` block.
 *
 * This is deliberately NOT a general TOML parser — the CLI's zod validation
 * stays authoritative and the raw body remains the editing truth. The two
 * keys are anchored at line start so a same-named string inside the prompt
 * body is never mistaken for the real field; the prompt block is blanked out
 * before the description scan for the same reason.
 *
 * Pure logic (zero VSCode / Node dependency) so it can be unit-tested on its
 * own and shared by the host's scan + read paths. Bad input never throws:
 * a missing/malformed field simply yields `null`.
 */
import type { AssetContentFields } from "./messages.js";

/** TOML basic-string escapes we may see in a one-line description. */
function unescapeBasic(value: string): string {
  return value.replace(/\\(["\\bfnrt])/g, (_all, ch: string) => {
    switch (ch) {
      case '"': return '"';
      case "\\": return "\\";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return ch;
    }
  });
}

/**
 * Blank every `"""…"""` region in `src`, preserving newlines so line anchors
 * stay valid. That way a `description = "…"` written inside the prompt body
 * cannot be picked up as the command's description.
 */
function blankTripleQuoted(src: string): string {
  const triple = /"""([\s\S]*?)"""/g;
  let masked = src;
  let match: RegExpExecArray | null;
  while ((match = triple.exec(src)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    masked = masked.slice(0, start) + match[0].replace(/[^\n]/g, " ") + masked.slice(end);
  }
  return masked;
}

export function parseCommandToml(text: string): AssetContentFields {
  const empty: AssetContentFields = { description: null, prompt: null };
  if (typeof text !== "string") return empty;
  try {
    const src = text.replace(/\r\n/g, "\n");

    // prompt: triple-quoted block, key anchored at line start. The body is
    // taken verbatim up to the first closing delimiter, then trimmed so no
    // triple quotes / surrounding whitespace leak into the card.
    let prompt: string | null = null;
    const promptMatch = /^[ \t]*prompt[ \t]*=[ \t]*"""([\s\S]*?)"""/m.exec(src);
    if (promptMatch) {
      const body = (promptMatch[1] ?? "").trim();
      prompt = body === "" ? null : body;
    }

    // description: single-line basic string, key anchored at line start;
    // an optional trailing `# comment` is tolerated. The scan runs against
    // the masked text so the prompt body can't contribute a false hit.
    let description: string | null = null;
    const descMatch = /^[ \t]*description[ \t]*=[ \t]*"((?:\\.|[^"\\])*)"[ \t]*(?:#.*)?$/m.exec(
      blankTripleQuoted(src),
    );
    if (descMatch) {
      const value = unescapeBasic(descMatch[1] ?? "").trim();
      description = value === "" ? null : value;
    }

    return { description, prompt };
  } catch {
    return empty;
  }
}