/**
 * 转录里的 super-agent 协议块卡片。
 *
 * 主 Agent 用 ```super-agent / ```super-agent-actions 围栏派发子会话与执行
 * 管理动作。直接按代码块渲染时，用户看到的是一长串 JSON —— 这些块是**给宿主
 * 读的指令**，人只需要一眼确认「派了什么 / 做了什么」。所以这里把围栏换成
 * 专属卡片：
 *
 *  - `super-agent`          → 委派子会话卡（任务标题 + 任务正文 + 附件）；
 *  - `super-agent-actions`  → 子会话操作卡（动作 + 目标子会话）；
 *  - 其它 `super-agent-*`   → 原始协议块卡（语言名 + 长度，不整段回灌）；
 *  - 非法 JSON / 形状不符   → 原始协议块卡（含原因），绝不弹 toast。
 *
 * 切分在 shared/super-agent.ts 的 `splitSuperDirectiveSegments`（纯函数，可
 * 单测）；这里只负责投影。围栏未闭合时纯函数不会切出 directive 段，整段仍走
 * Markdown（普通代码块）—— 流式中间态因此没有半截卡片，收栏后才切换。
 *
 * 宿主派发不经过本文件：`src/panel/panel.ts` 仍按原逻辑扫描同一段文本。
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FileWarning, ListChecks, Users } from "lucide-react";
import { t } from "../i18n";
import {
  splitSuperDirectiveSegments,
  type SuperDirectiveAction,
  type SuperDirectiveRawReason,
  type SuperDirectiveSegment,
  type SuperDirectiveTask,
} from "../../../shared/super-agent";
import { Button, Chip, ICON_INLINE } from "./ui";
import { Markdown } from "./Markdown";

type DirectiveSegment = Extract<SuperDirectiveSegment, { kind: "directive" }>;

/** 卡片表面沿用转录里其它卡的材质：8px 圆角 + 描边 + 卡片底 + 轻投影。 */
const CARD = "stream-in my-2 overflow-hidden rounded-lg border border-border/60 bg-card shadow-card";
const CARD_HEAD = "flex items-center gap-2 border-b border-border/60 px-3 py-2";
const CARD_ICON = "flex size-6 shrink-0 items-center justify-center rounded-md";

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

/** 正文超过这个长度或行数才提供展开：短任务书一次读完，不占额外操作。 */
const TASK_COLLAPSE_CHARS = 220;
const TASK_COLLAPSE_LINES = 3;

function TasksCard({ tasks }: { tasks: SuperDirectiveTask[] }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <span className={`${CARD_ICON} bg-primary/12 text-primary`}>
          <Users className={ICON_INLINE} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-label font-medium text-foreground/90">
          {t("委派子会话")}
        </span>
        <Chip tone="primary">{t("{0} 个任务", tasks.length)}</Chip>
      </div>
      <ul className="divide-y divide-border/60">
        {tasks.map((task, index) => (
          <TaskRow key={index} task={task} index={index} />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({ task, index }: { task: SuperDirectiveTask; index: number }) {
  const [open, setOpen] = useState(false);
  const long =
    task.task.length > TASK_COLLAPSE_CHARS || task.task.split("\n").length > TASK_COLLAPSE_LINES;
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-ui-micro tabular-nums text-muted-foreground/70">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-ui-label font-medium text-foreground/90">{task.title}</div>
          <div
            className={`mt-0.5 whitespace-pre-wrap break-words text-ui-caption leading-relaxed text-muted-foreground ${
              open ? "" : "line-clamp-3"
            }`}
          >
            {task.task}
          </div>
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
    </li>
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
    case "tasks":
      return <TasksCard tasks={display.tasks} />;
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
