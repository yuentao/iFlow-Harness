/**
 * 转录里的 super-agent 协议块卡片。
 *
 * 主 Agent 用 ```super-agent / ```super-agent-actions 围栏派发子会话与执行
 * 管理动作；也有模型把载荷写成**工具调用式**（`<｜DSML｜tool-super-agent>`、
 * 「`super-agent:` + ```json」）。直接按代码块渲染时，用户看到的是一长串 JSON ——
 * 这些块是**给宿主读的指令**，人只需要一眼确认「派了什么 / 做了什么」。所以这里
 * 把协议块换成专属卡片：
 *
 *  - `super-agent`          → 每个任务书一张独立卡片（标题 + 正文 + 附件）；
 *  - `super-agent-actions`  → 子会话操作卡（动作 + 目标子会话）；
 *  - 其它 `super-agent-*`   → 原始协议块卡（语言名 + 长度，不整段回灌）；
 *  - 非法 JSON / 形状不符   → 原始协议块卡（含原因），绝不弹 toast。
 *
 * 切分在 shared/super-agent.ts 的 `splitSuperDirectiveSegments`（纯函数，可单测）；
 * 这里只负责投影。它走的判定链与宿主派发同源（围栏 + 工具调用式载荷），所以「宿主
 * 派发了」与「转录出卡片」永远同时发生 —— 只认围栏的旧实现会让工具调用式载荷既派发
 * 成功又显示成一堵 JSON 墙。载荷未收全时纯函数不会切出 directive 段，整段仍走
 * Markdown（普通代码块）—— 流式中间态因此没有半截卡片，收栏后才切换。
 *
 * 宿主派发不经过本文件：`src/panel/panel.ts` 仍按原逻辑扫描同一段文本。
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, FileWarning, ListChecks, Users } from "lucide-react";
import { t } from "../i18n";
import {
  splitSuperDirectiveSegments,
  type SuperDirectiveAction,
  type SuperDirectiveDisplay,
  type SuperDirectiveRawReason,
  type SuperDirectiveSegment,
  type SuperDirectiveTask,
} from "../../../shared/super-agent";
import { Button, Chip, ICON_INLINE } from "./ui";
import { Markdown } from "./Markdown";
import {
  parseSuperTaskText,
  previewSuperTaskBlocks,
  type SuperTaskBlock,
  type SuperTaskInline,
} from "./super-task-text";

type DirectiveSegment = Extract<SuperDirectiveSegment, { kind: "directive" }>;

/** 卡片表面沿用转录里其它卡的材质：8px 圆角 + 描边 + 卡片底 + 轻投影。 */
const CARD = "stream-in my-2 overflow-hidden rounded-lg border border-border/60 bg-card shadow-card";
const CARD_HEAD = "flex items-center gap-2 border-b border-border/60 px-3 py-2";
const CARD_ICON = "flex size-6 shrink-0 items-center justify-center rounded-md";

/**
 * 任务卡表面：与 CARD 同材质，但**不带 my-2** —— 一批任务卡之间的间距由外层
 * 的 space-y-2 统一给（卡片自己的外边距会让间距忽大忽小）。
 */
const TASK_CARD =
  "stream-in overflow-hidden rounded-lg border border-border/60 bg-card shadow-card";
/** 任务卡头部：标题可换行（任务标题最长 40 字），所以图标与 chip 顶端对齐。 */
const TASK_CARD_HEAD = "flex items-start gap-2 border-b border-border/60 px-3 py-2";

const ACTION_LABELS: Record<string, string> = {
  retry: "重试",
  cancel: "中断",
  cleanup: "清理",
  answer: "回答",
};

const ACTION_TONES: Record<string, "primary" | "danger" | "warning" | "info" | "muted"> = {
  retry: "primary",
  cancel: "danger",
  cleanup: "warning",
  answer: "info",
};

const RAW_REASONS: Record<SuperDirectiveRawReason, string> = {
  invalid_json: "内容不是合法 JSON",
  missing_tasks: "缺少 tasks 数组",
  empty_tasks: "没有可展示的任务",
  missing_actions: "缺少 actions 数组",
  empty_actions: "没有可展示的动作",
  unknown_language: "未知的协议块语言",
};

/**
 * 折叠态的预览预算：字符数 + 块数。
 *
 * 折叠不再用 line-clamp 把整段文字切在半句上（那正是「乱糟糟」的观感来源），
 * 而是**按块**给出前几块 —— 段落、列表项、代码块各自完整；只有当第一块本身就
 * 超预算时，才在句子边界处切一刀并补一个省略号。
 */
const TASK_PREVIEW_CHARS = 200;
const TASK_PREVIEW_BLOCKS = 3;

/**
 * tasks 展示分支的**局部投影**。
 *
 * shared 侧会给「从坏载荷里容错拆出来的任务书」加一个可选的 `salvaged` 标记
 * （字段由另一个子会话提供）。这里用交叉类型读它 —— shared 改动前后都能编译：
 * 字段还不存在时读到 undefined，提示也就不显示；字段存在时如实告知用户。
 */
type TasksDisplay = Extract<SuperDirectiveDisplay, { kind: "tasks" }> & {
  salvaged?: boolean;
};

/**
 * 委派任务书：每个任务书一张**独立卡片**。
 *
 * 一条委派块里常常带 3 个任务书。合成一张卡时正文挤成一坨 JSON 墙，用户读不到
 * 任何一个任务书；拆开后每个任务书都能单独扫读（标题 / 正文 / 附件），序号 chip
 * 表达批次内的次序。委派语义靠 Users 图标表达，不再有「委派子会话 / N 个任务」那种
 * 汇总卡 —— 那正是用户读不下去的那一层。
 */
function TasksCards({ tasks, salvaged }: { tasks: SuperDirectiveTask[]; salvaged: boolean }) {
  return (
    <div className="my-2 space-y-2">
      {salvaged && <SalvagedNotice />}
      {tasks.map((task, index) => (
        <TaskCard key={index} task={task} index={index} total={tasks.length} />
      ))}
    </div>
  );
}

/**
 * 容错提示：载荷没能完整解析时，拆出来的任务书**可能根本没派发**。
 * 卡片照常展示（用户至少能读到模型想干什么），但必须如实说明这一点 —— 沉默地
 * 展示一份「看起来已派发」的任务书比不展示更糟。
 */
function SalvagedNotice() {
  return (
    <div
      data-testid="super-task-salvaged"
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-caption leading-relaxed text-warning"
    >
      <FileWarning className={`${ICON_INLINE} mt-0.5 shrink-0`} />
      <span>{t("载荷未能完整解析，以下任务书仅供阅读，可能尚未派发")}</span>
    </div>
  );
}

/** 单个任务书卡片：头部是标题 + 序号 chip，正文是任务书全文（可展开）。 */
function TaskCard({
  task,
  index,
  total,
}: {
  task: SuperDirectiveTask;
  index: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const blocks = useMemo(() => parseSuperTaskText(task.task), [task.task]);
  const preview = useMemo(
    () => previewSuperTaskBlocks(blocks, TASK_PREVIEW_CHARS, TASK_PREVIEW_BLOCKS),
    [blocks],
  );
  // 折叠态只渲染前几块（每块完整），展开态渲染全部块。
  const shown = open ? blocks : preview.blocks;
  const long = preview.truncated;
  return (
    <div className={TASK_CARD} data-testid="super-task-card">
      <div className={TASK_CARD_HEAD}>
        <span className={`${CARD_ICON} bg-primary/12 text-primary`} aria-hidden="true">
          <Users className={ICON_INLINE} />
        </span>
        <span className="min-w-0 flex-1 break-words text-ui-label font-medium text-foreground/90">
          {task.title}
        </span>
        {/* 只有一张卡时不需要「第 1/1 个任务」这种序号 —— 批次信息是多余的层级。 */}
        {total > 1 && <Chip tone="primary">{t("第 {0}/{1} 个任务", index + 1, total)}</Chip>}
      </div>
      <div className="px-3 py-2">
        <TaskBody blocks={shown} />
        {/* 折叠态还有内容没给出来：单独一行提示，不在末块尾巴上补省略号 ——
            一段完整的文字看起来像半句，比不提示更糟。 */}
        {!open && preview.truncated && !preview.cutText && (
          <div
            data-testid="super-task-more"
            className="text-ui-micro leading-none text-muted-foreground/60"
          >
            …
          </div>
        )}
        {task.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {task.attachments.map((name, attachmentIndex) => (
              <Chip key={`${name}-${attachmentIndex}`} tone="muted" truncate>
                {name}
              </Chip>
            ))}
          </div>
        )}
        {long && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            aria-label={open ? t("收起任务说明") : t("展开任务说明")}
            icon={open ? <ChevronUp className={ICON_INLINE} /> : <ChevronDown className={ICON_INLINE} />}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("收起") : t("展开")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 任务书正文：块列表。
 *
 * 模型写的任务书常是「一整段文字墙」（段落不分明、(1)(2)(3) 挤在同一行、路径与
 * 函数名混在中文里没有区分）。这里按解析出的块逐块排版，块与块之间留白，编号项
 * 带序号徽标并悬挂缩进对齐 —— 用户一眼能扫到「有几步、每步讲什么」。
 */
function TaskBody({ blocks }: { blocks: SuperTaskBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div data-testid="super-task-body" className="space-y-2">
      {blocks.map((block, index) => (
        <TaskBlockView key={index} block={block} />
      ))}
    </div>
  );
}

/** 单个正文块 → 排版后的行。 */
function TaskBlockView({ block }: { block: SuperTaskBlock }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p
          data-testid="super-task-paragraph"
          className="whitespace-pre-wrap break-words text-ui-caption leading-relaxed text-muted-foreground"
        >
          {renderTaskInlines(block.inlines)}
        </p>
      );
    case "bullet":
      return (
        <div data-testid="super-task-bullet" className="flex gap-1.5">
          <span
            aria-hidden="true"
            className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
          />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui-caption leading-relaxed text-muted-foreground">
            {renderTaskInlines(block.inlines)}
          </span>
        </div>
      );
    case "ordered":
      return (
        <div data-testid="super-task-ordered" className="flex gap-1.5">
          {/* 序号徽标：固定宽度 + 悬挂缩进，让多行的条目正文仍然对齐。 */}
          <span
            data-testid="super-task-ordered-marker"
            className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm bg-primary/12 px-1 font-mono text-ui-micro leading-none text-primary"
          >
            {block.label}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui-caption leading-relaxed text-muted-foreground">
            {renderTaskInlines(block.inlines)}
          </span>
        </div>
      );
    case "quote":
      return (
        <blockquote
          data-testid="super-task-quote"
          className="border-l border-border/70 pl-2 text-ui-caption italic leading-relaxed text-muted-foreground/90"
        >
          {renderTaskInlines(block.inlines)}
        </blockquote>
      );
    case "heading":
      return (
        <p data-testid="super-task-heading" className="text-ui-label font-medium text-foreground">
          {renderTaskInlines(block.inlines)}
        </p>
      );
    case "code":
      return (
        <pre
          data-testid="super-task-code"
          className="overflow-x-auto rounded-md border border-border bg-editor px-2 py-1.5 font-mono text-ui-micro leading-relaxed text-foreground"
        >
          <code>{block.text}</code>
        </pre>
      );
  }
}

/** 行内片段 → React 节点：普通文本原样，行内代码套等宽药丸样式。 */
function renderTaskInlines(inlines: SuperTaskInline[]): ReactNode[] {
  return inlines.map((inline, index) =>
    inline.kind === "code" ? (
      <code key={index} className="super-task-code">
        {inline.text}
      </code>
    ) : (
      <Fragment key={index}>{inline.text}</Fragment>
    ),
  );
}

function ActionsCard({ actions }: { actions: SuperDirectiveAction[] }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className={`${CARD_ICON} bg-info/12 text-info`}>
          <ListChecks className={ICON_INLINE} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-label font-medium text-foreground/90">
          {t("子会话操作")}
        </span>
        <Chip tone="info">{t("{0} 个动作", actions.length)}</Chip>
      </div>
      <ul className="divide-y divide-border/60">
        {actions.map((action, index) => (
          <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
            <Chip tone={ACTION_TONES[action.action] ?? "muted"}>
              {t(ACTION_LABELS[action.action] ?? action.action)}
            </Chip>
            <code className="min-w-0 break-all font-mono text-ui-micro text-muted-foreground">
              {action.sessionId || t("未指定子会话")}
            </code>
            {action.keepBranch && (
              <span className="text-ui-micro text-muted-foreground">{t("保留分支")}</span>
            )}
            {action.answerCount !== undefined && (
              <span className="text-ui-micro text-muted-foreground">
                {t("{0} 个回答", action.answerCount)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RawCard({
  language,
  raw,
  reason,
}: {
  language: string;
  raw: string;
  reason: SuperDirectiveRawReason;
}) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className={`${CARD_ICON} bg-warning/12 text-warning`}>
          <FileWarning className={ICON_INLINE} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-label font-medium text-foreground/90">
          {t("原始协议块")}
        </span>
        <Chip tone="warning" truncate>
          {language}
        </Chip>
      </div>
      <div className="px-3 py-2">
        <div className="text-ui-caption text-muted-foreground">{t(RAW_REASONS[reason])}</div>
        <div className="mt-1 text-ui-micro text-muted-foreground/80">
          {t("{0} · {1} 字符", language, raw.length)}
        </div>
      </div>
    </div>
  );
}

/** 单条协议块 → 对应卡片。未知形状一律落到原始协议块卡，不抛错。 */
export function SuperDirectiveCard({ segment }: { segment: DirectiveSegment }) {
  const { display, language, raw } = segment;
  switch (display.kind) {
    case "tasks": {
      // 投影成局部交叉类型：shared 侧给 tasks 变体加的 salvaged 标记（可选）
      // 存在与否都不影响这里的编译与行为。
      const tasks = display as TasksDisplay;
      return <TasksCards tasks={tasks.tasks} salvaged={tasks.salvaged === true} />;
    }
    case "actions":
      return <ActionsCard actions={display.actions} />;
    case "raw":
      return <RawCard language={language} raw={raw} reason={display.reason} />;
  }
}

/**
 * 助手正文的统一入口：没有协议围栏时原样交给 Markdown（与改动前逐字节一致，
 * 零回归面）；有围栏时按片段渲染，文本段仍走完整的 Markdown 链路（段落、列表、
 * 代码块、mermaid 等全都不丢）。
 *
 * 流式 caret 只挂在**最后一段且非空**的文本上：若尾巴是一张卡片，卡片本身就
 * 是输出终点，再挂个光标没有意义（卡片收栏前根本不会出现）。
 */
export function AssistantText({ text, streamCaret = false }: { text: string; streamCaret?: boolean }) {
  const segments = useMemo(() => splitSuperDirectiveSegments(text), [text]);
  const onlyText = segments.length === 1 && segments[0]?.kind === "text";
  if (onlyText) return <Markdown text={text} streamCaret={streamCaret} />;
  const tail = segments[segments.length - 1];
  const caretIndex =
    tail && tail.kind === "text" && tail.text.trim() ? segments.length - 1 : -1;
  return (
    <div className="super-directive-segments">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Markdown key={index} text={segment.text} streamCaret={index === caretIndex} />
        ) : (
          <SuperDirectiveCard key={index} segment={segment} />
        ),
      )}
    </div>
  );
}
