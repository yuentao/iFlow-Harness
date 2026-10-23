/**
 * Single home for every model-facing prompt. The wording lives in `prompts/*.md`
 * and this module is the only reader; builders elsewhere just ask for a template
 * by name and fill its `{{placeholders}}`.
 *
 * Templates are English (the model-facing language of this product). The OUTPUT
 * language is declared inside each template instead: session titles and next-step
 * chips follow the language of the user's request / conversation, and the knowledge
 * index body stays Chinese because it is injected into project memory.
 *
 * The `.md` files are imported as TEXT and inlined into `dist/extension.cjs` at
 * build time (esbuild `loader: { ".md": "text" }`), so an installed extension
 * ships no readable prompt files — see `.vscodeignore`. Types come from the
 * ambient `*.md` declaration in `md.d.ts`; vitest mirrors the same contract with
 * a text loader plugin in `vitest.config.ts`.
 *
 * The one template that must exist on disk is `system-prompt`: the CLI reads
 * `IFLOW_SYSTEM_MD` as a file path, so `ChatPanel` materialises this text into
 * its own storage dir before spawning the CLI.
 *
 * A missing template or placeholder throws rather than degrading: sending the
 * model an instruction-less (or half-filled) prompt would silently produce junk.
 */

import askSelection from "./ask-selection.md";
import assetGen from "./asset-gen.md";
import assetGenContracts from "./asset-gen-contracts.md";
import assetGenNouns from "./asset-gen-nouns.md";
import enhance from "./enhance.md";
import followup from "./followup.md";
import followupKeys from "./followup-keys.md";
import followupMemory from "./followup-memory.md";
import followupNextSteps from "./followup-next-steps.md";
import followupTitle from "./followup-title.md";
import knowledge from "./knowledge.md";
import knowledgeIncremental from "./knowledge-incremental.md";
import modelMetadata from "./model-metadata.md";
import systemPrompt from "./system-prompt.md";

/** CRLF normalised to LF, trailing blank lines dropped. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

const templates: Record<string, string> = {
  "ask-selection": normalize(askSelection),
  "asset-gen": normalize(assetGen),
  "asset-gen-contracts": normalize(assetGenContracts),
  "asset-gen-nouns": normalize(assetGenNouns),
  enhance: normalize(enhance),
  followup: normalize(followup),
  "followup-keys": normalize(followupKeys),
  "followup-memory": normalize(followupMemory),
  "followup-next-steps": normalize(followupNextSteps),
  "followup-title": normalize(followupTitle),
  knowledge: normalize(knowledge),
  "knowledge-incremental": normalize(knowledgeIncremental),
  "model-metadata": normalize(modelMetadata),
  "system-prompt": normalize(systemPrompt),
};

/** Raw template text; throws when the name is not one of the registered templates. */
export function loadPrompt(name: string): string {
  const template = templates[name];
  if (template === undefined) throw new Error(`prompt template "${name}" is not registered in prompts/index.ts`);
  return template;
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