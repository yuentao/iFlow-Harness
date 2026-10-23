import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single home for every model-facing prompt. The wording lives in `prompts/*.md`
 * and this module is the only reader; builders elsewhere just ask for a template
 * by name and fill its `{{placeholders}}`.
 *
 * Templates are English (the model-facing language of this product). The OUTPUT
 * language is declared inside each template instead: session titles and next-step
 * chips follow the language of the user's request / conversation, and the
 * knowledge index body stays Chinese because it is injected into project memory.
 *
 * Search order (no VSCode dependency, so `shared/` builders and vitest can use
 * it directly):
 *   1. the directory the host set via `setPromptDir` — the installed extension's
 *      `prompts/`, the same place the `system-prompt.md` override ships
 *   2. next to / above this module — vitest source layout and tsc-emitted output
 *   3. `process.cwd()/prompts` — scripts and harness run from the repo root
 *
 * The esbuild host bundle strips `import.meta.url` (checked in `dist/extension.cjs`:
 * it becomes `var import_meta = {}`), so candidate 2 never resolves there — the
 * host MUST call `setPromptDir`, which `ChatPanel`'s constructor does. Leaving it
 * unset in the bundle would fall through to cwd (the workspace folder) and throw.
 *
 * A missing template or placeholder throws rather than degrading: sending the
 * model an instruction-less (or half-filled) prompt would silently produce junk.
 */

let promptDirOverride: string | null = null;
const cache = new Map<string, string>();

/** Point the loader at the extension's own `prompts/` (VSIX install dir). */
export function setPromptDir(dir: string): void {
  promptDirOverride = dir;
  cache.clear();
}

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (promptDirOverride) dirs.push(promptDirOverride);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.join(here, "prompts"), path.join(path.dirname(here), "prompts"));
  } catch {
    // Bundled output without a usable import.meta.url — fall back to cwd.
  }
  dirs.push(path.join(process.cwd(), "prompts"));
  return dirs;
}

/** Absolute path of `prompts/<name>.md`, or a throw listing what was searched. */
export function promptFile(name: string): string {
  const fileName = `${name}.md`;
  const dirs = candidateDirs();
  for (const dir of dirs) {
    const file = path.join(dir, fileName);
    if (existsSync(file)) return file;
  }
  throw new Error(`prompt template "${fileName}" not found (searched: ${dirs.join(", ")})`);
}

/** Raw template text: CRLF normalised to LF, trailing blank lines dropped. */
export function loadPrompt(name: string): string {
  const file = promptFile(name);
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  cache.set(file, text);
  return text;
}

/**
 * Fill `{{placeholder}}` tokens in ONE pass, so a value that itself contains
 * `{{…}}` (the slash-command contract's `{{args}}`) is inserted verbatim and is
 * never re-expanded. A line that was only an optional placeholder collapses
 * instead of leaving a blank row — an absent Name line or tool-call line simply
 * disappears from the prompt.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const template = loadPrompt(name);
  const lines: string[] = [];
  for (const line of template.split("\n")) {
    const optional = /\{\{\w+\}\}/.test(line);
    const filled = line.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = vars[key];
      if (value === undefined) throw new Error(`prompt "${name}" is missing variable "{{${key}}}"`);
      return value;
    });
    if (optional && filled === "") continue;
    lines.push(filled);
  }
  return lines.join("\n");
}

/**
 * Read a `key: value` template file into a map. The FIRST colon splits key from
 * value, so values may themselves contain colons (e.g. the frontmatter
 * contracts). Comment lines (`#`) and blank lines are skipped.
 */
export function loadPromptKeys(name: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of loadPrompt(name).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    entries[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return entries;
}

/** One entry of a keyed template; throws when the key is not in the file. */
export function promptKey(name: string, key: string): string {
  const value = loadPromptKeys(name)[key];
  if (!value) throw new Error(`prompt "${name}" has no entry "${key}"`);
  return value;
}
