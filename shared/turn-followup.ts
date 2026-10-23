import { promptKey, renderPrompt } from "../prompts/index.js";
import { sanitizeSuggestions } from "./session-state.js";

/**
 * Turn-end conveniences (AI title / next-step prediction / memory extraction)
 * used to be three separate internal prompts — one gateway call each, so a
 * single turn could burn three model calls regardless of how many features
 * were enabled. They are now ONE request: the enabled tasks are assembled
 * into a single prompt and the reply is one JSON envelope.
 */
export type FollowupTaskKind = "title" | "nextSteps" | "memory";

export interface FollowupTitleInput {
  /** The first user request, already `@`-neutralised and length-capped. */
  request: string;
}

export interface FollowupNextStepsInput {
  user: string;
  assistant: string;
  toolTitles: readonly string[];
}

export interface FollowupMemoryInput {
  /** Transcript excerpt as `用户：… / 助手：…` lines. */
  conversation: string;
  existingFacts: readonly string[];
}

export interface FollowupInput {
  title?: FollowupTitleInput;
  nextSteps?: FollowupNextStepsInput;
  memory?: FollowupMemoryInput;
}

export interface FollowupResult {
  title: string | null;
  nextSteps: string[];
  /** Whole reply forwarded to `parseCandidates` when the memory task ran. */
  memoryRaw: string | null;
}

/**
 * One prompt covering exactly the enabled tasks. The wording lives in
 * `prompts/followup.md` (shell), the per-task templates and the key specs in
 * `prompts/followup-keys.md`; only the enabled-task list and the data are
 * assembled here. The discipline is inherited from the internal-prompt rules
 * (pitfall #26): declare it a pure text task so thinking models do not drift
 * into "should I read a file first" loops, and demand a bare JSON envelope so
 * every part stays parseable.
 */
export function buildFollowupPrompt(input: FollowupInput): string {
  const kinds = (Object.keys(input) as FollowupTaskKind[]).filter((kind) => input[kind] !== undefined);
  const sections: string[] = [];
  const title = input.title;
  if (title) {
    sections.push(renderPrompt("followup-title", { request: title.request }));
  }
  const nextSteps = input.nextSteps;
  if (nextSteps) {
    const tools = nextSteps.toolTitles.length > 0 ? `Tool calls this turn: ${nextSteps.toolTitles.join(", ")}` : "";
    sections.push(
      renderPrompt("followup-next-steps", {
        user: nextSteps.user,
        assistant: nextSteps.assistant || "(none)",
        tools,
      }),
    );
  }
  const memory = input.memory;
  if (memory) {
    const existing = memory.existingFacts
      .map((fact) => `- ${fact.trim()}`)
      .filter((fact) => fact.length > 2)
      .slice(0, 60)
      .join("\n");
    sections.push(
      renderPrompt("followup-memory", {
        existing: existing || "(none)",
        conversation: memory.conversation || "(none)",
      }),
    );
  }
  return renderPrompt("followup", {
    keys: kinds.map((kind) => promptKey("followup-keys", kind)).join("\n"),
    sections: sections.join("\n\n"),
  });
}

/** Dig the outermost JSON object out of a reply; null when it is not parseable. */
function digObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Formatting drift — fall back to the per-key digs below.
  }
  return null;
}

/** Balanced-bracket dig for one array key (used when the envelope parse failed). */
function digArray(raw: string, key: string): readonly unknown[] | null {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return null;
  const open = raw.indexOf("[", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(open, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Scan one string value out of a malformed envelope: locate `"key"`, then the
 * quoted value, honouring backslash escapes. Null when it is not a string. */
function digString(raw: string, key: string): string | null {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return null;
  const colon = raw.indexOf(":", at + key.length + 2);
  if (colon < 0) return null;
  const open = raw.indexOf('"', colon + 1);
  if (open < 0) return null;
  let end = open + 1;
  while (end < raw.length) {
    const ch = raw[end];
    if (ch === "\\") {
      end += 2;
      continue;
    }
    if (ch === '"') break;
    end += 1;
  }
  if (end >= raw.length || raw[end] !== '"') return null;
  try {
    return JSON.parse(raw.slice(open, end + 1)) as string;
  } catch {
    return null;
  }
}

function firstLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.split("\n")[0]?.trim() ?? "";
  return line || null;
}

/**
 * Split one envelope back into the requested parts. Every miss degrades to
 * `null`/`[]` — the host never fabricates a title, a chip or a memory fact.
 * `memoryRaw` keeps the whole reply so `parseCandidates` can apply its own
 * strict JSON + dedupe + confidence rules unchanged.
 */
export function parseFollowupResponse(
  raw: string,
  requested: readonly FollowupTaskKind[],
  maxSuggestions = 3,
): FollowupResult {
  const text = raw.trim();
  const envelope = digObject(text);
  const wants = (kind: FollowupTaskKind): boolean => requested.includes(kind);
  const fromEnvelope = envelope?.nextSteps;
  const values: readonly unknown[] = Array.isArray(fromEnvelope)
    ? (fromEnvelope as readonly unknown[])
    : digArray(text, "nextSteps") ?? [];
  return {
    title: wants("title") ? firstLine(envelope?.title ?? digString(text, "title")) : null,
    nextSteps: wants("nextSteps") ? sanitizeSuggestions(values, maxSuggestions) : [],
    memoryRaw: wants("memory") ? text : null,
  };
}
