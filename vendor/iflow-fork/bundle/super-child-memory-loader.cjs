/**
 * super-child-memory-loader.cjs — decision layer for the super-child-memory MOD.
 *
 * Background (verified byte-for-byte in the CLI 0.5.19 bundle, `P0e()`):
 *   `Config.getUserMemory()` returns the FULL hierarchical memory text — global
 *   memory from os.homedir()/.iflow plus every project AGENTS.md / IFLOW.md from
 *   CWD up to the repo root, with @import already expanded. `P0e()` appends it
 *   verbatim to the final systemInstruction via the `E` wrapper. For a Super
 *   Agent child (own CLI process, own worktree) that means every child swallows
 *   the whole project AGENTS.md (~28k tokens measured on this repo) on top of
 *   the already compact child system prompt.
 *
 * The patched call site lets this loader rewrite `E` just before it is spliced
 * into the model input. The loader replaces the project AGENTS.md / IFLOW.md
 * segment(s) with a compact, curated rule sheet shipped next to this file
 * (`super-child-memory-rules.md`), while preserving global memory and any
 * non-memory-file segments. Nothing on disk is modified.
 *
 * Gating (all must hold, else return the input byte-for-byte):
 *   - process.argv contains --experimental-acp  (TUI / -p never affected)
 *   - IFLOW_SUPER_CHILD = 1|true                (host sets it ONLY on child spawns)
 *   - IFLOW_SUPER_MEMORY not in 0|false|off     (explicit upstream fallback)
 *   - compact rule sheet readable and non-empty
 *
 * Optional: IFLOW_SUPER_MEMORY_RULES overrides the rule sheet path (host may
 * hand in a per-project file). An unreadable override falls back to the bundled
 * sheet; if neither is readable the input is returned unchanged — silent
 * upstream behaviour, never a thrown error.
 *
 * NOTE: this module MUST NOT write to stdout — in ACP mode stdout is the NDJSON
 * protocol stream and a stray line corrupts the wire. No console at all.
 */

const path = require("path");
const fs = require("fs");

/** Return true only when this is a gated Super Agent child ACP process. */
function enabled(env) {
  let inAcp = false;
  try {
    inAcp = Array.isArray(process.argv) && process.argv.indexOf("--experimental-acp") >= 0;
  } catch {
    inAcp = false;
  }
  if (!inAcp) return false;
  const e = env || {};
  const on = String(e.IFLOW_SUPER_CHILD || "").trim().toLowerCase();
  if (on !== "1" && on !== "true") return false;
  const off = String(e.IFLOW_SUPER_MEMORY || "").trim().toLowerCase();
  if (off === "0" || off === "false" || off === "off") return false;
  return true;
}

/** Read the compact rule sheet; override path first, bundled sheet second. */
function readRules(env) {
  const e = env || {};
  const override = String(e.IFLOW_SUPER_MEMORY_RULES || "").trim();
  const candidates = [];
  if (override) candidates.push(path.isAbsolute(override) ? override : path.resolve(override));
  candidates.push(path.join(__dirname, "super-child-memory-rules.md"));
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * True when a `--- Context from: <path> ---` path denotes a PROJECT memory file
 * (AGENTS.md / IFLOW.md under the child's cwd), not a global-memory file.
 *
 * `Gva()` in the CLI renders global paths as absolute (cross-drive on Windows)
 * or as parent-relative paths when homedir is reachable from cwd; project paths
 * are cwd-relative with no `..` segment. Those two signals are enough without
 * needing to know cwd here.
 */
function isProjectMemory(p) {
  const name = path.basename(String(p).replace(/\\/g, "/")).toLowerCase();
  if (name !== "agents.md" && name !== "iflow.md") return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false; // absolute Windows path => global
  if (p.startsWith("/")) return false; // absolute POSIX path => global
  if (p.split(/[\\/]/).indexOf("..") >= 0) return false; // parent-relative => global
  return true;
}

const WRAP = "\r\n\r\n---\r\n\r\n";
// Backreference \1 keeps the leading and trailing path labels consistent,
// avoiding a greedy match across two adjacent segments.
const SEG = /--- Context from: ([^\r\n]+?) ---\r?\n[\s\S]*?\r?\n--- End of Context from: \1 ---/g;

/**
 * Rewrite the `E` memory wrapper. Returns the input unchanged whenever a gate
 * fails or any step is uncertain — this is a pure decision layer, never a
 * source of new failure modes for the CLI.
 */
function transform(memory, env) {
  if (!enabled(env)) return memory;
  if (typeof memory !== "string" || !memory) return memory;
  const rules = readRules(env);
  if (!rules) return memory;

  const prefix = memory.slice(0, WRAP.length) === WRAP ? WRAP : "";
  const body = prefix ? memory.slice(WRAP.length) : memory;
  let changed = false;
  const out = body.replace(SEG, (full, p) => {
    if (!isProjectMemory(p)) return full;
    changed = true;
    return `--- Context from: ${p} ---\n${rules}\n--- End of Context from: ${p} ---`;
  });
  if (!changed) return memory;
  return prefix + out;
}

module.exports = { enabled, transform };
