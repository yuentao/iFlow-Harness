/**
 * system-prompt-loader.cjs — decision layer for the system-prompt-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, byte-for-byte):
 *   P0e() assembles the system prompt. When IFLOW_SYSTEM_MD names a file it
 *   takes `n?y=N0e.readFileSync(o,"utf8")`, i.e. the file REPLACES THE WHOLE
 *   BODY and every dynamic section the built-in template (Oui/Nui) renders live
 *   is silently swallowed: "# Environment Information" (working directory,
 *   git remote URL + HEAD SHA, platform, OS version, today's date, the model
 *   name and knowledge cutoff), the conditional "# Git Repository" block, the
 *   conditional sandbox block (# Sandbox / # macOS Seatbelt / # Outside of
 *   Sandbox) and the `gitStatus:` snapshot paragraph.
 *
 * The patched call site renders the built-in template first (unchanged
 * expressions) and then calls render(fileText, builtIn). Tokens in the
 * override file are substituted with the matching section sliced out of that
 * freshly rendered text, so the host's own customisation keeps its prose and
 * re-embeds only the live data it wants:
 *
 *   {{iflow:Environment Information}}   env block incl. model name + cutoff
 *   {{iflow:Git Repository}}            conditional git-repo instructions
 *   {{iflow:Sandbox}}                   # Sandbox | # macOS Seatbelt | # Outside of Sandbox
 *   {{iflow:gitStatus}}                 the `gitStatus: ...` snapshot paragraph
 *   {{iflow:<any other top-level # heading in the built-in render>}}
 *
 * Names are matched case-insensitively for the four aliases above; anything
 * else must match the built-in heading text exactly. Unknown token -> left
 * verbatim (visible in the prompt, self-diagnosing). No token at all -> the
 * result is byte-identical to upstream IFLOW_SYSTEM_MD behaviour.
 *
 * IFLOW_SYSTEM_MD_TEMPLATE=0|false restores upstream replacement (tokens stay
 * literal). Loader missing / throwing -> the patched call site falls back to
 * the raw file, i.e. upstream behaviour (same discipline as the other
 * refactor MODs).
 *
 * Scope: the patched statement only exists in P0e(), which every startChat
 * (session/new AND session/load) runs, so restored sessions keep the
 * override — unlike the ACP wire's settings.system_prompt, which only
 * session/new applies. TUI and -p use their own prompt paths and are
 * unaffected.
 *
 * NOTE: this module MUST NOT write to stdout — in ACP mode stdout carries the
 * NDJSON protocol stream and a stray line corrupts the wire.
 */

const DISABLED = (() => {
  const v = process.env.IFLOW_SYSTEM_MD_TEMPLATE;
  return typeof v === "string" && ["0", "false"].includes(v.trim().toLowerCase());
})();

const SANDBOX_HEADINGS = ["Sandbox", "macOS Seatbelt", "Outside of Sandbox"];
const TOKEN = /\{\{iflow:([^{}]*)\}\}/gi;

function escapeRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Slice a top-level "# Heading" section out of the rendered built-in text:
 * from the heading line up to (not including) the next top-level heading or
 * EOF. "## " sub-headings never terminate a section because `^# ` demands a
 * space right after the hash.
 */
function headingSection(text, name) {
  const re = new RegExp("^# " + escapeRegExp(name) + "[ \\t]*\\r?\\n", "m");
  const m = re.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const nx = after.search(/^# /m);
  const end = nx < 0 ? text.length : m.index + m[0].length + nx;
  return text.slice(m.index, end);
}

/**
 * The `gitStatus:` snapshot is injected by the template as a bare paragraph
 * (no heading), between the Code References examples and "# Final Reminder".
 * Slice from its first line up to the next top-level heading or EOF.
 */
function gitStatusSection(text) {
  const m = /(^|\r?\n)gitStatus: /.exec(text);
  if (!m) return null;
  const start = m.index + (m[1] ? m[1].length : 0);
  const nx = /\r?\n# /.exec(text.slice(start));
  const end = nx ? start + nx.index : text.length;
  return text.slice(start, end);
}

function resolve(name, builtIn) {
  const key = name.trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  if (lower === "gitstatus") return gitStatusSection(builtIn);
  if (lower === "sandbox") {
    for (const h of SANDBOX_HEADINGS) {
      const found = headingSection(builtIn, h);
      if (found) return found;
    }
    return null;
  }
  return headingSection(builtIn, key);
}

/**
 * Substitute every {{iflow:Name}} token in `fileText` with the matching
 * section of `builtIn` (the built-in template rendered moments earlier in the
 * same startChat). Returns null only for unusable input, which the call site
 * turns into the raw-file fallback.
 */
function render(fileText, builtIn) {
  if (typeof fileText !== "string") return null;
  if (DISABLED || typeof builtIn !== "string" || fileText.indexOf("{{iflow:") < 0) return fileText;
  return fileText.replace(TOKEN, (match, name) => {
    const section = resolve(name, builtIn);
    if (!section) return match;
    return section.replace(/\r\n/g, "\n").trim();
  });
}

module.exports = { render };
