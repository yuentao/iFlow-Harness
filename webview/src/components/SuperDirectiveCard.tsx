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
 *  - 围栏未收栏（流式）      → 「正在编写任务书…」占位卡（不展示载荷、不宣称已派发）；
 *  - 其它 `super-agent-*`   → 原始协议块卡（语言名 + 长度，不整段回灌）；
 *  - 非法 JSON / 形状不符   → 原始协议块卡（含原因），绝不弹 toast。
 *
 * 切分在 shared/super-agent.ts 的 `splitSuperDirectiveSegments`（纯函数，可单测）；
 * 这里只负责投影。它走的判定链与宿主派发同源（围栏 + 工具调用式载荷），所以「宿主
 * 派发了」与「转录出卡片」永远同时发生 —— 只认围栏的旧实现会让工具调用式载荷既派发
 * 成功又显示成一堵 JSON 墙。载荷未收全时纯函数切出 `pending` 段，这里渲染成占位卡：
 * 既不把半截围栏交回 Markdown（那正是用户盯着的 JSON 墙），也不伪装成已派发 ——
 * 收栏后占位卡才跃变为任务卡。
 *
 * 视觉上这些卡片是**委派家族**，刻意与 MessageList 的「工具操作卡」分开：
 * 淡主色底 / 主色描边 / 顶部强调条 / 两行头部 / 独立图标徽章。内置
 * `super-agent` 工具上线后两种卡常并排出现，别再把它改回通用卡材质。
 *
 * 宿主派发不经过本文件：`src/panel/panel.ts` 仍按原逻辑扫描同一段文本。
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileWarning,
  ListChecks,
  Loader2,
  Users,
  X,
} from "lucide-react";
import { t } from "../i18n";
import {
  splitSuperDirectiveSegments,
  type SuperDirectiveAction,
  type SuperDirectiveDisplay,
  type SuperDirectiveRawReason,
  type SuperDirectiveSegment,
  type SuperDirectiveTask,
} from "../../../shared/super-agent";
import type { ToolBlock } from "../../../shared/messages";
import { parseSuperDelegationTasks, parseSuperToolCall } from "../../../shared/super-tool-call";
import { DELEGATION_ORIGIN_ATTR } from "./SuperDelegationFly";
import { Button, Chip, ICON_INLINE } from "./ui";
import { Markdown } from "./Markdown";
import {
  parseSuperTaskText,
  previewSuperTaskBlocks,
  type SuperTaskBlock,
  type SuperTaskInline,
} from "./super-task-text";

type DirectiveSegment = Extract<SuperDirectiveSegment, { kind: "directive" }>;

/**
 * 委派卡独立表面（2026-11-15 恢复）。
 *
 * 「工具操作卡」ToolCard 是 `bg-card + border-border + shadow-card` 的单行头部卡
 * （见 MessageList.tsx 的 ToolCard）。内置 `super-agent` 工具上线后，派发既能走
 * 工具帧也能走围栏文本，两种卡并排时委派卡沿用同一材质就完全读不出区别；git
 * 历史里本组件从首版（8c965f4）起就注明「沿用转录里其它卡的材质」，从来没有
 * 过独立外观。这里按「与工具操作卡明显区分」补一套专属表面：淡主色底 + 主色
 * 描边 + 顶部主色强调条 + 浅浮层投影，头部是「eyebrow + 标题」两行 + 独立图标
 * 徽章；圆角仍走转录卡的 8px（card 档），颜色全部走主题 token，深浅主题同构。
 * 刻意不带 `bg-card` / `shadow-card` / `tool-card`（工具卡材质），不碰
 * backdrop-filter（陷阱 #22），也不靠 ring 画边（shadow-card 会覆盖 ring）。
 */
const DIRECTIVE_CARD =
  "stream-in super-directive-card overflow-hidden rounded-lg border border-primary/35 bg-primary/10 shadow-float";
/** 顶部主色强调条：一眼认出「这是派发单，不是工具卡」。 */
const DIRECTIVE_ACCENT = "h-0.5 bg-primary/60";
/** 头部两行结构（eyebrow + 标题），与工具卡的单行 label/detail 区分。 */
const DIRECTIVE_HEAD = "flex items-start gap-2 border-b border-primary/20 px-3 py-2";
/** 图标徽章：主色底 + 主色描边；工具卡是裸 `.tool-icon` 渐变砖。 */
const DIRECTIVE_ICON =
  "flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/15 text-primary";
/** 家族 eyebrow：所有委派卡共用一枚小标签，工具卡没有这一层。 */
const DIRECTIVE_EYEBROW = "text-ui-micro font-medium tracking-wide text-primary";
/** 进行中占位卡的图标徽章保持中性 —— 不宣称已派发。 */
const DIRECTIVE_ICON_MUTED =
  "flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-surface/60 text-muted-foreground";
const DIRECTIVE_EYEBROW_MUTED =
  "text-ui-micro font-medium tracking-wide text-muted-foreground";

/** 委派卡外壳：统一挂独立表面 + 顶部强调条；`my-2` 由调用点按需给。 */
function DirectiveSurface({
  children,
  className = "",
  testId,
  role,
  origin = false,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  role?: "status";
  /** true = 这是「委派成功」的起点卡，飞入动效从这里起飞。 */
  origin?: boolean;
}) {
  return (
    <div
      className={`${DIRECTIVE_CARD} ${className}`}
      data-testid={testId}
      {...(origin ? { [DELEGATION_ORIGIN_ATTR]: "" } : {})}
      role={role}
    >
      <div className={DIRECTIVE_ACCENT} aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * 委派卡头部：图标徽章 + eyebrow + 标题两行 + 右侧 chip。
 * 标题容器 `min-w-0 flex-1`，chip 外套 `shrink-0` —— 窄屏先收缩标题，
 * 序号 / 状态 chip 始终完整可见（项目子代理卡同款约定）。
 */
function DirectiveHeader({
  icon,
  children,
  aside,
  iconClassName = DIRECTIVE_ICON,
  eyebrowClassName = DIRECTIVE_EYEBROW,
}: {
  icon: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  iconClassName?: string;
  eyebrowClassName?: string;
}) {
  return (
    <div className={DIRECTIVE_HEAD}>
      <span className={iconClassName} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className={eyebrowClassName}>{t("委派指令")}</div>
        <div className="mt-0.5 min-w-0">{children}</div>
      </div>
      {aside && <span className="shrink-0">{aside}</span>}
    </div>
  );
}

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
    <DirectiveSurface testId="super-task-card" origin>
      {/* 只有一张卡时不需要「第 1/1 个任务」这种序号 —— 批次信息是多余的层级。 */}
      <DirectiveHeader
        icon={<Users className={ICON_INLINE} />}
        aside={
          total > 1 ? (
            <Chip tone="primary">{t("第 {0}/{1} 个任务", index + 1, total)}</Chip>
          ) : undefined
        }
      >
        {/* 标题层级比工具卡 label 高一档（16px vs 13px），长标题换行而不是挤出 chip。 */}
        <span className="block break-words text-ui-title font-semibold leading-snug text-foreground">
          {task.title}
        </span>
      </DirectiveHeader>
      <div className="px-3 py-2">
        <TaskBody blocks={shown} />
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
            {open
              ? t("收起")
              : preview.hiddenChars > 0
                ? t("展开全文（还有 {0} 字）", preview.hiddenChars)
                : t("展开全文")}
          </Button>
        )}
      </div>
    </DirectiveSurface>
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
          className="whitespace-pre-wrap break-words rounded-md border border-border bg-editor px-2 py-1.5 font-mono text-ui-micro leading-relaxed text-foreground"
        >
          <code>{block.text}</code>
        </pre>
      );
  }
}

/**
 * 行内片段 → React 节点：普通文本原样，行内代码套等宽药丸样式，
 * 加粗用「更亮的前景色 + medium 字重」强调（正文是 muted，层级因此分明）。
 */
function renderTaskInlines(inlines: SuperTaskInline[]): ReactNode[] {
  return inlines.map((inline, index) => {
    switch (inline.kind) {
      case "code":
        return (
          <code key={index} className="super-task-code">
            {inline.text}
          </code>
        );
      case "strong":
        return (
          <strong
            key={index}
            data-testid="super-task-strong"
            className="font-medium text-foreground"
          >
            {renderTaskInlines(inline.inlines)}
          </strong>
        );
      default:
        return <Fragment key={index}>{inline.text}</Fragment>;
    }
  });
}

/** 动作行列表：围栏动作卡与工具调用动作卡共用，逐项文案与 chip 完全一致。 */
function ActionRows({ actions }: { actions: SuperDirectiveAction[] }) {
  return (
    <ul className="divide-y divide-primary/20">
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
  );
}

function ActionsCard({ actions }: { actions: SuperDirectiveAction[] }) {
  return (
    <DirectiveSurface className="my-2">
      <DirectiveHeader
        icon={<ListChecks className={ICON_INLINE} />}
        aside={<Chip tone="info">{t("{0} 个动作", actions.length)}</Chip>}
      >
        <span className="block truncate text-ui-label font-medium text-foreground/90">
          {t("子会话操作")}
        </span>
      </DirectiveHeader>
      <ActionRows actions={actions} />
    </DirectiveSurface>
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
    <DirectiveSurface className="my-2">
      <DirectiveHeader
        icon={<FileWarning className={ICON_INLINE} />}
        iconClassName="flex size-6 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/15 text-warning"
        eyebrowClassName={DIRECTIVE_EYEBROW_MUTED}
        aside={
          <Chip tone="warning" truncate>
            {language}
          </Chip>
        }
      >
        <span className="block truncate text-ui-label font-medium text-foreground/90">
          {t("原始协议块")}
        </span>
      </DirectiveHeader>
      <div className="px-3 py-2">
        <div className="text-ui-caption text-muted-foreground">{t(RAW_REASONS[reason])}</div>
        <div className="mt-1 text-ui-micro text-muted-foreground/80">
          {t("{0} · {1} 字符", language, raw.length)}
        </div>
      </div>
    </DirectiveSurface>
  );
}

/**
 * 内置 `super-agent` 工具调用的独立委派卡。
 *
 * wire 实证（vendor/iflow-fork/bundle/super-agent-loader.cjs）：
 * `TOOL_NAME = "super-agent"`，`args` 是 `{tasks:[{title,task,attachments?}]}`，
 * 工具只回 `Delegation request accepted.`。这条调用照常进 store 成为
 * `ToolBlock`，但转录层不能再走通用 ToolCard —— 用户看到的「工具操作 /
 * 执行参数 / 原始 JSON」正是上一轮没修到的那层。这里复用围栏委派卡的
 * 独立表面，**不碰宿主派发逻辑**：任务列表优先取宿主解析出的
 * `block.superTasks`（`input` 是有损展示串，回解不可靠），历史转录才回退到
 * 共享解析入口（`parseSuperDelegationTasks`，与派发器同一份实现）。
 */
interface SuperToolTaskView {
  title: string;
  task: string;
  attachments: number;
}

type SuperToolCallParse =
  | { ok: true; tasks: SuperToolTaskView[] }
  | { ok: false; reason: "pending" | "invalid" };

/** 折叠态任务书预览预算：与围栏任务卡同源，按块截断而不是切半句。 */
const SUPER_TOOL_PREVIEW_CHARS = 200;
const SUPER_TOOL_PREVIEW_BLOCKS = 2;

/**
 * 从 ToolBlock 解析任务书。
 *
 * 单一真源 = **宿主解析出的结构**（`block.superTasks`）。两个原因让卡片不能
 * 只回解 `block.input`：
 *  - `input` 是宿主故意做成**有损**的展示串（`formatToolInput`：单个字符串
 *    值截断 300 字符、整串上限 4096 字符）——长任务书会被从中间切断，JSON
 *    直接不合法；
 *  - 模型调内置 `super-agent` 工具时**有时漏掉 `title`**（wire 实证：args 是
 *    `{"tasks":[{"task":"…"}]}`）。宿主派发器容忍这种情况（回退到 task 首行，
 *    那一轮真的派出了 4 个子会话），而旧卡片要求每条任务都有非空 title → 把
 *    一次成功的委派谎报成「工具参数未能完整解析」。
 *
 * 没有 `superTasks` 时（历史转录 / 恢复会话）才回退去解析 `input`，且回解
 * 复用与派发器**同一份**实现（`parseSuperDelegationTasks`）—— 两边口径不会
 * 漂移。两者都失败才走诚实降级：绝不把坏载荷拆成看起来已派发的任务。
 */
function parseSuperToolCallPayload(block: ToolBlock): SuperToolCallParse {
  const host = block.superTasks;
  if (host && host.length > 0) {
    return {
      ok: true,
      tasks: host.map((task) => ({
        title: task.title,
        task: task.task,
        attachments: task.attachmentCount,
      })),
    };
  }
  const fallback = parseSuperDelegationTasks(block.input);
  if (fallback && fallback.length > 0) {
    return {
      ok: true,
      tasks: fallback.map((task) => ({
        title: task.title,
        task: task.task,
        attachments: (task.attachments ?? []).length,
      })),
    };
  }
  // 参数还没到达 → pending 占位；到了却读不出来 → 诚实降级。
  if (!block.input || !block.input.trim()) return { ok: false, reason: "pending" };
  return { ok: false, reason: "invalid" };
}

/** 状态 chip 留在独立卡内，沿用 ToolCard 的四态文案但穿委派家族表面。 */
function SuperToolStatusChip({ status }: { status: ToolBlock["status"] }) {
  if (status === "completed") {
    return (
      <Chip tone="success" className="chip-in">
        <Check className={ICON_INLINE} aria-hidden="true" /> {t("已完成")}
      </Chip>
    );
  }
  if (status === "failed") {
    return (
      <Chip tone="danger" className="chip-in">
        <X className={ICON_INLINE} aria-hidden="true" /> {t("失败")}
      </Chip>
    );
  }
  if (status === "pending") {
    return (
      <Chip tone="muted" className="chip-in">
        <CircleDot className={ICON_INLINE} aria-hidden="true" /> {t("等待执行")}
      </Chip>
    );
  }
  return (
    <Chip tone="primary" className="chip-in">
      <Loader2 className={`${ICON_INLINE} animate-spin`} aria-hidden="true" /> {t("执行中")}
    </Chip>
  );
}

/** 单条任务书：标题 + 序号 + 附件数 + 可展开的正文摘要。 */
function SuperToolTaskRow({
  task,
  index,
  total,
}: {
  task: SuperToolTaskView;
  index: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const blocks = useMemo(() => parseSuperTaskText(task.task), [task.task]);
  const preview = useMemo(
    () => previewSuperTaskBlocks(blocks, SUPER_TOOL_PREVIEW_CHARS, SUPER_TOOL_PREVIEW_BLOCKS),
    [blocks],
  );
  const shown = open ? blocks : preview.blocks;
  return (
    <li data-testid="super-tool-call-task" className="min-w-0 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {total > 1 && (
          <Chip tone="primary">{t("第 {0}/{1} 个任务", index + 1, total)}</Chip>
        )}
        <span className="min-w-0 flex-1 break-words text-ui-label font-semibold leading-snug text-foreground">
          {task.title}
        </span>
        {task.attachments > 0 && (
          <Chip tone="muted">{t("附件 {0}", task.attachments)}</Chip>
        )}
      </div>
      <div className="mt-1 min-w-0">
        <TaskBody blocks={shown} />
      </div>
      {preview.truncated && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          aria-label={open ? t("收起任务说明") : t("展开任务说明")}
          icon={
            open ? (
              <ChevronUp className={ICON_INLINE} aria-hidden="true" />
            ) : (
              <ChevronDown className={ICON_INLINE} aria-hidden="true" />
            )
          }
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? t("收起")
            : preview.hiddenChars > 0
              ? t("展开全文（还有 {0} 字）", preview.hiddenChars)
              : t("展开全文")}
        </Button>
      )}
    </li>
  );
}

/**
 * tool_call 帧里的内置 super-agent 调用 → 与围栏委派卡同材质的独立卡。
 *
 * 卡片只回答「派了什么」：标题 + 任务列表 + 状态 chip。底部**不再**有
 * 「(查看原始参数)」折叠项与工具回执/结果区块（issue #166）——原始 JSON
 * 参数与 `Delegation request accepted.` 这类回执对用户零信息量，反而把
 * 卡片底部撑成一堵噪音。解析失败时原始参数仍按原样摊开（那一态它就是
 * 唯一有价值的正文，见下方 invalid 分支）。
 */
export function SuperToolCallCard({ block }: { block: ToolBlock }) {
  const parsed = useMemo(
    () => parseSuperToolCallPayload(block),
    [block.superTasks, block.input],
  );
  const tasks = parsed.ok ? parsed.tasks : [];
  return (
    <DirectiveSurface
      className="my-2"
      testId="super-tool-call-card"
      role={parsed.ok ? undefined : "status"}
      origin
    >
      <DirectiveHeader
        icon={<Users className={ICON_INLINE} />}
        aside={<SuperToolStatusChip status={block.status} />}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ui-title font-semibold leading-snug text-foreground">
            {t("子会话委派")}
          </span>
          {parsed.ok && <Chip tone="primary">{t("{0} 个任务", tasks.length)}</Chip>}
        </div>
      </DirectiveHeader>
      {parsed.ok ? (
        <ul data-testid="super-tool-call-tasks" className="divide-y divide-primary/20">
          {tasks.map((task, index) => (
            <SuperToolTaskRow key={index} task={task} index={index} total={tasks.length} />
          ))}
        </ul>
      ) : parsed.reason === "pending" ? (
        <div className="flex items-center gap-2 px-3 py-2 text-ui-caption text-muted-foreground">
          <Loader2 className={`${ICON_INLINE} animate-spin`} aria-hidden="true" />
          <span>{t("正在编写任务书…")}</span>
        </div>
      ) : (
        // 载荷解析不出来时**不假装有任务书**：如实说明这里只保留了原始参数，
        // 且参数本身直接摊开（折叠起来等于让用户点两次才看到唯一的内容）。
        <div className="space-y-2 px-3 py-2">
          <div
            data-testid="super-tool-call-invalid"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-caption leading-relaxed text-warning"
          >
            <FileWarning className={`${ICON_INLINE} mt-0.5 shrink-0`} aria-hidden="true" />
            <span>{t("工具参数未能完整解析，任务列表暂不可用，以下保留原始参数")}</span>
          </div>
          {block.input && (
            <pre
              data-testid="super-tool-call-raw"
              className="max-h-64 max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-editor px-3 py-2 font-mono text-ui-caption leading-relaxed text-muted-foreground"
            >
              {block.input}
            </pre>
          )}
        </div>
      )}
    </DirectiveSurface>
  );
}

/**
 * 内置 `super-agent` 工具承载**管理动作**时的独立操作卡。
 *
 * 新版工具 schema 同时收 `tasks` 与 `actions`：模型做 retry/cancel/answer/cleanup
 * 时仍调这个工具，只是载荷变成 `{"actions":[…]}`。宿主按载荷纠偏执行；转录层
 * 也必须把这类工具帧从通用 ToolCard 里捞出来，否则用户看到的是「工具操作 /
 * 执行参数」，而不是围栏动作卡那张一眼能读的「子会话操作」卡。
 *
 * 数据来源：`ToolBlock` 目前没有 `superActions` 结构字段（宿主只给 dispatch
 * 存了 `superTasks`），所以这里回解 `block.input`。它虽是**有损展示串**（单值
 * 300 字符、整串 4096 字符截断），但动作载荷只有动作名 + 短 sessionId +
 * 少量回答条目，正常形态远低于上限；解析直接复用宿主同一份
 * {@link parseSuperToolCall}（内部走 `extractSuperActions`），不复制校验逻辑。
 * 真被截断到 parse 不出来时走诚实降级，绝不编造动作。
 *
 * 刻意**不挂** `data-super-delegation-origin`：那是「委派产生子会话」的语义，
 * 管理动作不该触发飞入看板动效。
 */
type SuperActionsToolParse =
  | { ok: true; actions: SuperDirectiveAction[] }
  | { ok: false; reason: "pending" | "invalid" };

function parseSuperActionsToolCall(block: ToolBlock): SuperActionsToolParse {
  const parsed = parseSuperToolCall("actions", block.input);
  if (parsed.ok && parsed.actions.length > 0) {
    return {
      ok: true,
      actions: parsed.actions.map((action) => {
        if (action.action === "answer") {
          return {
            action: action.action,
            sessionId: action.sessionId,
            answerCount: Object.keys(action.answers ?? {}).length,
          };
        }
        if (action.action === "cleanup" && action.keepBranch) {
          return { action: action.action, sessionId: action.sessionId, keepBranch: true };
        }
        return { action: action.action, sessionId: action.sessionId };
      }),
    };
  }
  if (!block.input || !block.input.trim()) return { ok: false, reason: "pending" };
  return { ok: false, reason: "invalid" };
}

export function SuperActionsToolCallCard({ block }: { block: ToolBlock }) {
  const parsed = useMemo(() => parseSuperActionsToolCall(block), [block.input]);
  return (
    <DirectiveSurface
      className="my-2"
      testId="super-actions-tool-call-card"
      role={parsed.ok ? undefined : "status"}
    >
      <DirectiveHeader
        icon={<ListChecks className={ICON_INLINE} />}
        aside={<SuperToolStatusChip status={block.status} />}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ui-label font-medium text-foreground/90">
            {t("子会话操作")}
          </span>
          {parsed.ok && <Chip tone="info">{t("{0} 个动作", parsed.actions.length)}</Chip>}
        </div>
      </DirectiveHeader>
      {parsed.ok ? (
        <ActionRows actions={parsed.actions} />
      ) : parsed.reason === "pending" ? (
        <div className="flex items-center gap-2 px-3 py-2 text-ui-caption text-muted-foreground">
          <Loader2 className={`${ICON_INLINE} animate-spin`} aria-hidden="true" />
          <span>{t("正在编写子会话操作…")}</span>
        </div>
      ) : (
        <div className="space-y-2 px-3 py-2">
          <div
            data-testid="super-actions-tool-call-invalid"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-caption leading-relaxed text-warning"
          >
            <FileWarning className={`${ICON_INLINE} mt-0.5 shrink-0`} aria-hidden="true" />
            <span>{t("工具参数未能完整解析，动作列表暂不可用，以下保留原始参数")}</span>
          </div>
          {block.input && (
            <pre
              data-testid="super-actions-tool-call-raw"
              className="max-h-64 max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-editor px-3 py-2 font-mono text-ui-caption leading-relaxed text-muted-foreground"
            >
              {block.input}
            </pre>
          )}
        </div>
      )}
    </DirectiveSurface>
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
 * 围栏已开栏、载荷还没收全：转录里给一张**进行中**占位卡。
 *
 * 旧实现把未闭合围栏整段交给 Markdown，于是主 Agent 写任务书的整个过程里，用户
 * 盯着的是一堵原始 JSON（任务书越长盯得越久）。这里只说明「还在写」：
 *  - 不展示任何载荷原文（半截 JSON 对用户没有信息量）；
 *  - 不出现成功勾 / primary 按钮 / 任何「已派发」语义 —— 宿主此刻确实还没派发；
 *  - 不挂流式 caret：占位卡本身就是输出终点。
 */
function PendingDirectiveCard({ language }: { language: string }) {
  return (
    <DirectiveSurface className="my-2" testId="super-directive-pending" role="status">
      <DirectiveHeader
        icon={<Loader2 className={`${ICON_INLINE} animate-spin`} />}
        iconClassName={DIRECTIVE_ICON_MUTED}
        eyebrowClassName={DIRECTIVE_EYEBROW_MUTED}
      >
        <span className="block truncate text-ui-label font-medium text-foreground/90">
          {language === "super-agent-actions"
            ? t("正在编写子会话操作…")
            : t("正在编写任务书…")}
        </span>
      </DirectiveHeader>
    </DirectiveSurface>
  );
}

/**
 * 助手正文的统一入口：没有协议围栏时原样交给 Markdown（与改动前逐字节一致，
 * 零回归面）；有围栏时按片段渲染，文本段仍走完整的 Markdown 链路（段落、列表、
 * 代码块、mermaid 等全都不丢）。未收栏的围栏渲染成「正在编写任务书…」占位卡
 * （见 {@link PendingDirectiveCard}），绝不把半截载荷交回 Markdown。
 *
 * 流式 caret 只挂在**最后一段且非空**的文本上：尾巴若是卡片（任务卡或 pending
 * 占位卡），卡片本身就是输出终点，再挂个光标没有意义。
 */
export function AssistantText({ text, streamCaret = false }: { text: string; streamCaret?: boolean }) {
  const segments = useMemo(() => splitSuperDirectiveSegments(text), [text]);
  const onlyText = segments.length === 1 && segments[0]?.kind === "text";
  if (onlyText) return <Markdown text={text} streamCaret={streamCaret} />;
  // pending 段永远在末尾（它是「正文到此为止」）：尾巴不是非空文本段就不挂 caret。
  const tail = segments[segments.length - 1];
  const caretIndex =
    tail && tail.kind === "text" && tail.text.trim() ? segments.length - 1 : -1;
  return (
    <div className="super-directive-segments">
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return <Markdown key={index} text={segment.text} streamCaret={index === caretIndex} />;
        }
        if (segment.kind === "pending") {
          return <PendingDirectiveCard key={index} language={segment.language} />;
        }
        return <SuperDirectiveCard key={index} segment={segment} />;
      })}
    </div>
  );
}

/**
 * 思考卡正文的入口：**纯 Markdown**，不做协议块切分。
 *
 * 思考通道是模型的内部独白，不是给宿主的指令面 —— 派发只扫助手正文，写进思考
 * 里的 `super-agent` 围栏不会被派发。旧实现复用 `AssistantText`，于是思考卡里
 * 会冒出看起来已经派发的任务卡，与事实相反。这里只交给 Markdown：围栏按普通
 * 代码块渲染（带语言标签），正文按段落渲染，不出现任何卡片。
 *
 * 思考正文不挂流式光标 —— 思考卡不是输出终点。
 */
export function ThoughtText({ text }: { text: string }) {
  return <Markdown text={text} />;
}
