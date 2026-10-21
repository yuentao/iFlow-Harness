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

const KEY_SPEC: Record<FollowupTaskKind, string> = {
  title: '"title": 会话标题，字符串',
  nextSteps: '"nextSteps": 下一步候选，字符串数组',
  memory:
    '"facts": 记忆候选，对象数组，每项含 {"text","scope":"global|project","category":"preference|convention|decision|gotcha|other","confidence":0.0}',
};

/**
 * One prompt covering exactly the enabled tasks. The discipline is inherited
 * from the internal-prompt rules (pitfall #26): declare it a pure text task so
 * thinking models do not drift into "should I read a file first" loops, and
 * demand a bare JSON envelope so every part stays parseable.
 */
export function buildFollowupPrompt(input: FollowupInput): string {
  const kinds = (Object.keys(input) as FollowupTaskKind[]).filter((kind) => input[kind] !== undefined);
  const sections: string[] = [];
  const title = input.title;
  if (title) {
    sections.push(
      [
        "【标题】用 6 到 10 个字概括下面这条用户请求的主题，使用与其相同的语言。只输出标题文本本身，不要引号、句读或解释。",
        "",
        "请求：",
        title.request,
      ].join("\n"),
    );
  }
  const nextSteps = input.nextSteps;
  if (nextSteps) {
    const tools = nextSteps.toolTitles.length > 0 ? `\n本轮工具调用：${nextSteps.toolTitles.join("、")}` : "";
    sections.push(
      [
        "【下一步】根据下面的最近对话，推测用户接下来最可能想做的 3 个操作。",
        "要求：每条是一个可直接发送的简短指令（不超过 20 个字），使用与对话相同的语言，必须能从对话内容推断，不要泛泛而谈，也不要建议删除数据或执行危险命令。",
        "",
        "用户请求：",
        nextSteps.user,
        "",
        "助手回复（末尾节选）：",
        nextSteps.assistant || "（无）",
        tools,
      ].join("\n"),
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
      [
        "【长期记忆】为编码助手整理跨会话长期记忆。",
        "只提取稳定、可复用、对以后任务有帮助的信息：",
        "- 用户偏好（语言、风格、工具、沟通方式）",
        "- 项目约定（架构、目录、测试方式、依赖管理）",
        "- 已确认的技术决策",
        "- 反复踩到的陷阱",
        "不要提取：一次性任务细节、代码正文、密钥、临时路径、未确认的猜测。",
        "没有值得记住的信息时让 facts 为空数组。",
        "",
        "已有记忆（不要重复）：",
        existing || "（无）",
        "",
        "最近对话：",
        memory.conversation || "（无）",
      ].join("\n"),
    );
  }
  return [
    "你在一次回复里完成下面几项纯文本分析任务。这是一次分析任务——不要调用任何工具、不要读取文件或执行任何操作、不要续写或回答对话本身。",
    "只输出一个 JSON 对象，不要 markdown 代码围栏、不要编号或解释。对象只包含下列键，不要新增、改名或遗漏：",
    kinds.map((kind) => KEY_SPEC[kind]).join("\n"),
    "",
    sections.join("\n\n"),
  ].join("\n");
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
