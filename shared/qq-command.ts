/**
 * QQ 远程任务命令解析（Wave2-C，纯逻辑）。
 *
 * 边界：
 *  - 只解析，不执行：本模块不 import vscode、不读文件、不访问网络，也不认识
 *    QQ 适配器；调用方拿到 `QqCommandIntent` 后自行分发。
 *  - 命令命名空间固定为 `/qq <子命令>`——与 shared/qq-task.ts 的
 *    `formatQqTaskSummary` 在摘要末尾给出的 `/qq status <id>` / `/qq log <id>`
 *    提示共用同一套命名（`log` 是 `status` 的别名，见 `SUBCOMMAND_ALIASES`）。
 *  - 解析失败用返回码表达（`{ ok: false, code, message }`），不抛错：命令来自
 *    聊天消息，格式错误是常态，抛错会迫使适配器在每个调用点写 try/catch。
 */

// ---------------------------------------------------------------------------
// 意图类型
// ---------------------------------------------------------------------------

/** 解析出的命令意图；判别字段 `kind`。 */
export type QqCommandIntent =
  /** `/qq task <任务描述>`：派发一个新任务，`prompt` 是原文（仅去首尾空白）。 */
  | { kind: "task"; prompt: string }
  /** `/qq status [任务编号]`：查看状态，省略编号表示查看最近任务。 */
  | { kind: "status"; taskId?: string }
  /** `/qq result <任务编号>`：查看结果摘要。 */
  | { kind: "result"; taskId: string }
  /** `/qq diff <任务编号>`：查看任务改动。 */
  | { kind: "diff"; taskId: string }
  /** `/qq stop <任务编号>`：停止任务。 */
  | { kind: "stop"; taskId: string }
  /** `/qq approve <任务编号> [验证码]`：批准等待审批的任务。 */
  | { kind: "approve"; taskId: string; code?: string }
  /** `/qq deny <任务编号>`：拒绝等待审批的任务。 */
  | { kind: "deny"; taskId: string }
  /** `/qq answer <任务编号> <回答>`：回答 agent 的提问。 */
  | { kind: "answer"; taskId: string; text: string }
  /** `/qq merge <任务编号>`：把任务分支合并回当前分支。 */
  | { kind: "merge"; taskId: string }
  /** `/qq discard <任务编号>`：丢弃任务分支。 */
  | { kind: "discard"; taskId: string }
  /** `/qq unbind`：解除绑定。 */
  | { kind: "unbind" }
  /** `/qq help`（以及裸 `/qq`）：显示帮助。 */
  | { kind: "help" };

/** 解析失败的 code 全集。 */
export type QqCommandErrorCode =
  /** 文本不是 `/qq` 开头的命令。 */
  | "not_a_command"
  /** `/qq` 之后是未知子命令。 */
  | "unknown_subcommand"
  /** 缺少必需参数（任务描述 / 任务编号 / 回答内容）。 */
  | "missing_arg"
  /** 参数多余（非 `task` 子命令不接受额外参数；`answer` 的额外参数是回答正文）。 */
  | "too_many_args";

export type QqCommandParseResult =
  | { ok: true; intent: QqCommandIntent }
  | { ok: false; code: QqCommandErrorCode; message: string };

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 纯文本形式的 at 提及（`@机器人` 或 `@123456`）。 */
const AT_PREFIX = /^@[^\s]+/u;

/**
 * 剥掉行首**一个** `@token` 提及标记，并去掉其后的空白。
 *
 * 官方 QQBot 适配器已经在 `cleanQqBotContent` 里剥掉 mention 标签与 `@token`，
 * 这里是对直接调用 `handleInboundMessage` 的其它来源（手写测试、将来的适配器）
 * 的防御。只剥一个是有意为之：`@bot @user /qq ...` 这种双标记残留说明上游没有
 * 清理干净，与其猜「到底剥到哪」，不如让它按非命令处理，由适配器暴露问题。
 * `@qq` 这类后面不跟空白的形态不算提及（避免把邮箱 / 用户名误伤）。
 */
function stripLeadingMention(text: string): string {
  const at = AT_PREFIX.exec(text);
  if (at) {
    const rest = text.slice(at[0].length);
    if (rest === "" || /^[^\S\r\n]/u.test(rest)) {
      return rest.replace(/^[^\S\r\n]+/u, "");
    }
  }
  return text;
}

/** 统一换行、剥一个提及标记、去首尾空白——不做行内空白合并。 */
function stripMentionAndTrim(text: string): string {
  const unified = text.replace(/\r\n?/gu, "\n").trim();
  return stripLeadingMention(unified).trim();
}

/**
 * 命令行归一化：去首尾空白、去行首一个 `@token` 提及标记、合并行内连续空白。
 *
 * 换行一律保留（CRLF 统一成 LF）：`/qq task` 的提示词可能带多段结构，折叠成
 * 一行会改变语义。行内空白（空格 / 制表符 / 全角空格）合并成单个半角空格。
 */
export function normalizeCommandText(text: string): string {
  return stripMentionAndTrim(text)
    .replace(/[^\S\r\n]+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// 子命令与别名
// ---------------------------------------------------------------------------

type QqSubcommand =
  | "task"
  | "status"
  | "result"
  | "diff"
  | "stop"
  | "approve"
  | "deny"
  | "answer"
  | "merge"
  | "discard"
  | "unbind"
  | "help";

/**
 * 子命令别名表（键必须小写；中文别名按原样匹配）。
 *
 * 别名来源：`log` 来自 shared/qq-task.ts 摘要里的 `/qq log` 提示；`state` 与
 * 中文别名是聊天场景的口语化输入；`cancel` / `resend` 是英文习惯写法。
 */
const SUBCOMMAND_ALIASES: Readonly<Record<string, QqSubcommand>> = {
  task: "task",
  status: "status",
  state: "status",
  log: "status",
  状态: "status",
  result: "result",
  resend: "result",
  结果: "result",
  diff: "diff",
  stop: "stop",
  cancel: "stop",
  停止: "stop",
  approve: "approve",
  deny: "deny",
  answer: "answer",
  merge: "merge",
  discard: "discard",
  unbind: "unbind",
  help: "help",
  帮助: "help",
};

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const NOT_COMMAND_MESSAGE = "不是 /qq 命令（用 /qq help 查看全部命令）";
const HELP_HINT = "（用 /qq help 查看全部命令）";

function fail(code: QqCommandErrorCode, message: string): QqCommandParseResult {
  return { ok: false, code, message };
}

function ok(intent: QqCommandIntent): QqCommandParseResult {
  return { ok: true, intent };
}

function missing(sub: QqSubcommand, what: string): QqCommandParseResult {
  return fail("missing_arg", `/qq ${sub} 缺少${what}${HELP_HINT}`);
}

function tooMany(sub: QqSubcommand): QqCommandParseResult {
  return fail("too_many_args", `/qq ${sub} 的参数过多${HELP_HINT}`);
}

/**
 * 从**未合并行内空白**的文本里抽 `/qq task` 的提示词。
 *
 * 解析本身跑在 `normalizeCommandText` 的结果上（便于分词），但提示词必须保留
 * 原文：连续空格、缩进与空行都是用户内容。这里只去掉首尾空白。
 */
function extractTaskPrompt(preserved: string): string | undefined {
  const match = /^\/qq\s+(\S+)/iu.exec(preserved);
  if (!match || (match[1] ?? "").toLowerCase() !== "task") return undefined;
  return preserved.slice(match[0].length).trim();
}

/**
 * 解析一条聊天消息里的 `/qq` 命令。
 *
 * 规则：
 *  - 必须以 `/qq` 开头（大小写不敏感，`/qq` 后必须是空白或结尾，`/qqq` 不算）；
 *  - 子命令大小写不敏感，支持中英文别名（见 `SUBCOMMAND_ALIASES`）；
 *  - 裸 `/qq`、`/qq help` 都返回 `help` 意图；
 *  - `task` 之后的整段原文是提示词（仅去首尾空白，内部换行与空格保留），
 *    空提示词 → `missing_arg`；
 *  - `status` 允许无任务编号；其余按任务编号的子命令缺参 → `missing_arg`；
 *  - 除 `task` / `answer` 外，多余参数一律 `too_many_args`（不静默忽略，
 *    避免打错命令时收到一个「看起来成功」的确认）。
 */
export function parseQqCommand(raw: string): QqCommandParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail("not_a_command", NOT_COMMAND_MESSAGE);
  }

  const preserved = stripMentionAndTrim(raw);
  const normalized = normalizeCommandText(raw);
  const prefix = /^\/qq(?=\s|$)/iu.exec(normalized);
  if (!prefix) return fail("not_a_command", NOT_COMMAND_MESSAGE);

  const afterPrefix = normalized.slice(prefix[0].length);
  const head = /^\s*(\S+)/u.exec(afterPrefix);
  if (!head) return ok({ kind: "help" }); // 裸 /qq

  const word = head[1]!.toLowerCase();
  const sub = SUBCOMMAND_ALIASES[word];
  if (!sub) {
    return fail("unknown_subcommand", `未知子命令「${word}」${HELP_HINT}`);
  }

  const rest = afterPrefix.slice(head[0].length).trim();

  switch (sub) {
    case "task": {
      const prompt = extractTaskPrompt(preserved) ?? rest;
      if (!prompt) return missing(sub, "任务描述");
      return ok({ kind: "task", prompt });
    }
    case "status": {
      if (!rest) return ok({ kind: "status" });
      const tokens = rest.split(/\s+/u);
      if (tokens.length > 1) return tooMany(sub);
      return ok({ kind: "status", taskId: tokens[0]! });
    }
    case "unbind":
    case "help": {
      if (rest) return tooMany(sub);
      return ok({ kind: sub });
    }
    case "result":
    case "diff":
    case "stop":
    case "approve":
    case "deny":
    case "answer":
    case "merge":
    case "discard": {
      if (!rest) return missing(sub, "任务编号");
      const first = /^(\S+)/u.exec(rest)!;
      const taskId = first[1]!;
      const tail = rest.slice(first[0].length).trim();
      // approve 的尾段是可选验证码、answer 的尾段是回答正文；其余子命令不容忍多余参数。
      if (tail && sub !== "approve" && sub !== "answer") return tooMany(sub);
      switch (sub) {
        case "approve": {
          if (!tail) return ok({ kind: "approve", taskId });
          const parts = tail.split(/\s+/u);
          if (parts.length > 1) return tooMany(sub);
          return ok({ kind: "approve", taskId, code: parts[0]! });
        }
        case "answer": {
          if (!tail) return missing(sub, "回答内容");
          return ok({ kind: "answer", taskId, text: tail });
        }
        case "result":
          return ok({ kind: "result", taskId });
        case "diff":
          return ok({ kind: "diff", taskId });
        case "stop":
          return ok({ kind: "stop", taskId });
        case "deny":
          return ok({ kind: "deny", taskId });
        case "merge":
          return ok({ kind: "merge", taskId });
        case "discard":
          return ok({ kind: "discard", taskId });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 帮助文本
// ---------------------------------------------------------------------------

interface QqHelpEntry {
  usage: string;
  description: string;
}

/** 帮助条目：解析器与帮助文本共用同一份清单，避免两处措辞 / 覆盖漂移。 */
const HELP_ENTRIES: readonly QqHelpEntry[] = [
  { usage: "task <任务描述>", description: "把描述作为任务派发给 agent" },
  { usage: "status [任务编号]", description: "查看任务状态，省略编号时查看最近任务" },
  { usage: "result <任务编号>", description: "查看任务结果摘要" },
  { usage: "diff <任务编号>", description: "查看任务的改动" },
  { usage: "stop <任务编号>", description: "停止正在跑的任务" },
  { usage: "approve <任务编号> [验证码]", description: "批准等待审批的任务" },
  { usage: "deny <任务编号>", description: "拒绝等待审批的任务" },
  { usage: "answer <任务编号> <回答>", description: "回答 agent 的提问" },
  { usage: "merge <任务编号>", description: "把任务分支合并回当前分支" },
  { usage: "discard <任务编号>", description: "丢弃任务分支" },
  { usage: "unbind", description: "解除当前会话的绑定" },
  { usage: "help", description: "显示本帮助" },
];

/**
 * 生成发给 QQ 的纯文本命令帮助。
 *
 * 纯文本多行，无 Markdown 标题 / 表格 / 粗体 / 代码围栏——QQ 客户端不渲染
 * Markdown，标记只会原样显示成一堆符号。中文是项目源语言，说明用中文。
 */
export function buildQqHelpText(): string {
  const lines: string[] = ["QQ 远程任务命令", "用法：/qq <子命令> [参数]", ""];
  for (const entry of HELP_ENTRIES) {
    lines.push(`  ${entry.usage}  ${entry.description}`);
  }
  lines.push("");
  lines.push(
    "别名：log / state 同 status，resend 同 result，cancel 同 stop；中文「状态」「结果」「停止」「帮助」也可用。",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 确认文案
// ---------------------------------------------------------------------------

/**
 * 给命令一条简短的确认文案（回复到聊天里）。
 *
 * 只用「已收到 / 正在…」这类**不宣称完成**的措辞，也**不拼任务编号**：编号要么
 * 由执行体在真正建任务后回填，要么干脆不出现——在确认阶段编一个 id 会让用户
 * 拿一个不存在的编号去查询。
 */
export function formatAck(intent: QqCommandIntent): string {
  switch (intent.kind) {
    case "task":
      return "已收到任务，排队中。";
    case "status":
      return "正在查询任务状态。";
    case "result":
      return "正在获取任务结果。";
    case "diff":
      return "正在获取任务改动。";
    case "stop":
      return "正在停止任务。";
    case "approve":
      return "正在批准任务。";
    case "deny":
      return "正在拒绝任务。";
    case "answer":
      return "正在提交回答。";
    case "merge":
      return "正在合并任务分支。";
    case "discard":
      return "正在丢弃任务分支。";
    case "unbind":
      return "正在解除绑定。";
    case "help":
      return "正在显示命令帮助。";
  }
}
