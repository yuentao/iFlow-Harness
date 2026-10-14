/**
 * M1 P0-7 — transcript export (Markdown / JSON). Pure functions so the
 * serializer is unit-testable without a VSCode host or a live CLI.
 *
 * Defensive redaction: a transcript never carries credentials by design, but
 * an exported file leaves the extension's trust boundary, so the Markdown and
 * JSON serializers run one more apiKey-shaped filter over the text before it
 * reaches disk (mirrors the wire-log redaction discipline).
 */

import type { Block, SessionState, SubAgentBlock, ToolBlock } from "./messages.js";

/** Rough API-key shapes: `sk-…`, `sk-ant-…`, long bearer-ish tokens.
 * Deliberately conservative (long runs only) so ordinary code samples —
 * which DO belong in an export — are not mangled. */
const SECRET_RE = /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})\b/g;

/** Replace credential-shaped substrings with a fixed marker. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "«redacted»");
}

function fence(text: string, lang = ""): string {
  // A transcript body may itself contain ``` fences — widen the delimiter so
  // the block stays intact when re-opened in any Markdown viewer.
  const longest = (text.match(/`+/g) ?? []).reduce((m, f) => Math.max(m, f.length), 0);
  const tick = "`".repeat(Math.max(3, longest + 1));
  return `${tick}${lang}\n${text}\n${tick}`;
}

function toolBlockToMd(block: ToolBlock, indent = ""): string {
  const lines: string[] = [];
  const status = block.reverted ? "已回退" : block.status;
  lines.push(`${indent}- **${redactSecrets(block.title || block.toolName)}** · \`${block.toolKind}\` · ${status}`);
  if (block.diff) {
    const path = redactSecrets(block.diff.path);
    if (block.diff.oldText !== null && block.diff.newText !== null) {
      const unified = unifiedFromOldNew(path, block.diff.oldText, block.diff.newText);
      lines.push(`${indent}  ${fence(unified, "diff").split("\n").join(`\n${indent}  `)}`);
    } else {
      lines.push(`${indent}  _${block.diff.newText === null ? "删除" : "新建"} ${path}_`);
    }
  }
  if (block.output.trim()) {
    const out = block.output.trim();
    const clipped = out.length > 4000 ? `${out.slice(0, 4000)}\n…（输出截断，共 ${out.length} 字符）` : out;
    lines.push(`${indent}  ${fence(redactSecrets(clipped)).split("\n").join(`\n${indent}  `)}`);
  }
  return lines.join("\n");
}

/** Minimal whole-file unified diff (no LCS — a coarse prefix/suffix trim is
 * enough for an export artifact and keeps this dependency-free). */
export function unifiedFromOldNew(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld).map((l) => `-${l}`);
  const added = newLines.slice(start, endNew).map((l) => `+${l}`);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1} +${start + 1} @@`, ...removed, ...added].join("\n");
}

function subAgentToMd(block: SubAgentBlock): string {
  const head = `- **子代理 ${redactSecrets(block.title || block.agentType || block.agentId)}** · ${block.status}`;
  const entries = block.entries
    .map((e) => blockToMd(e, "  "))
    .filter(Boolean)
    .join("\n");
  return entries ? `${head}\n${entries}` : head;
}

function blockToMd(block: Block, indent = ""): string | null {
  switch (block.kind) {
    case "user": {
      const body = redactSecrets(block.text);
      const images = block.images && block.images.length > 0 ? `\n${indent}> （含 ${block.images.length} 张附图）` : "";
      return `## 👤 用户\n\n${indent}${body}${images}`;
    }
    case "text":
      if (block.system) return `> _${redactSecrets(block.text)}_`;
      return `## 🤖 助手\n\n${indent}${redactSecrets(block.text)}`;
    case "thought":
      return `> **思考**\n>\n${block.text
        .split("\n")
        .map((l) => `> ${redactSecrets(l)}`)
        .join("\n")}`;
    case "tool":
      return toolBlockToMd(block, indent);
    case "subagent":
      return subAgentToMd(block);
    case "plan":
      return [
        `### 计划`,
        ...block.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${redactSecrets(e.content)}`),
      ].join("\n");
    case "compression":
      return `---\n\n> **上下文压缩**：${redactSecrets(block.notice)}${block.summary ? `\n>\n> ${redactSecrets(block.summary).split("\n").join("\n> ")}` : ""}\n\n---`;
    case "injected": {
      const lines = [`---\n\n> **自动注入内容**：${redactSecrets(block.notice)}`];
      for (const item of block.items) {
        const where = item.path ? `（\`${redactSecrets(item.path)}\`）` : "";
        lines.push(`>\n> **${redactSecrets(item.label)}**${where}\n>`);
        lines.push(...redactSecrets(item.content).split("\n").map((l) => `> ${l}`));
      }
      return lines.join("\n");
    }
    default:
      return null;
  }
}

/** Serialize a transcript to a standalone Markdown document. */
export function transcriptToMarkdown(args: {
  label: string;
  sessionId: string | null;
  modelId: string | null;
  blocks: Block[];
  usage?: SessionState["usage"];
}): string {
  const header: string[] = [
    `# ${redactSecrets(args.label)}`,
    "",
    `- 会话：\`${args.sessionId ?? "未知"}\``,
    `- 模型：${args.modelId ? `\`${redactSecrets(args.modelId)}\`` : "未知"}`,
    `- 导出时间：${new Date().toISOString()}`,
  ];
  if (args.usage) {
    header.push(
      `- Token 估算：↑${args.usage.inputTokens.toLocaleString()} ↓${args.usage.outputTokens.toLocaleString()}（host 估算）`,
    );
  }
  const body = args.blocks.map((b) => blockToMd(b)).filter((s): s is string => s !== null);
  return [header.join("\n"), body.join("\n\n")].join("\n\n");
}

/** Structurally redact every string leaf of a JSON-ish value. */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}

/** Serialize the exportable transcript payload (JSON copy). */
export function transcriptToJson(args: {
  label: string;
  sessionId: string | null;
  blocks: Block[];
}): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      label: redactSecrets(args.label),
      sessionId: args.sessionId,
      blocks: redactDeep(args.blocks),
    },
    null,
    2,
  );
}
