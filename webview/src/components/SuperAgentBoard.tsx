import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  ExternalLink,
  GitBranch,
  GitMerge,
  Hourglass,
  Info,
  Loader2,
  RotateCcw,
  ShieldOff,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { Block } from "../../../shared/messages";
import { findQqTaskForSuperSession } from "../../../shared/qq-task";
import { maskQqOpenId } from "../../../shared/qq-access";
import type {
  SuperIntegrationState,
  SuperIsolation,
  SuperSessionUi,
  SuperStatus,
} from "../../../shared/super-agent";
import {
  canRetrySuperSession,
  groupSuperSessionsForBoard,
  hasActiveSuperSession,
  isTerminalSuperStatus,
  sumSuperUsage,
  summarizeSuperSessions,
  superIntegrationLabel,
  superIsolationLabel,
} from "../../../shared/super-agent";
import {
  describeSuperTimelineFacts,
  deriveSuperTimeline,
  SUPER_TODO_DETAIL_SEP,
  type SuperTimelineNode,
  type SuperTimelineTone,
} from "../../../shared/super-timeline";
import {
  buildSuperBoardAggregate,
  collectSuperBoardDiagnosticTimeline,
  collectSuperSessionDiagnostics,
  summarizeSuperBoardDiagnostics,
  superBoardFailureKind,
  type SuperBoardFailureKind,
  type SuperBoardSession,
} from "../../../shared/super-board";
import { useChat } from "../store";
import { t } from "../i18n";
import { SuperDelegationFly } from "./SuperDelegationFly";
import { SuperBatchGroups } from "./SuperBatchGroups";
import { SuperDiagnosticTimeline } from "./SuperDiagnosticTimeline";
import { BlockView } from "./MessageList";
import {
  Button,
  Chip,
  ConfirmDialog,
  CountdownBar,
  DisclosureButton,
  HelpTip,
  ICON_INLINE,
  IconButton,
  ModalShell,
  TabButton,
  rovingTabKeyDown,
} from "./ui";
import { QuestionBody, type QuestionAnswerMap } from "./QuestionBody";

/** 状态色调（看板状态编码的第三重：颜色只是冗余，形状与文案才是主编码）。 */
type StatusTone = "muted" | "success" | "warning" | "danger" | "primary" | "info";

/** 看板视图：平铺 / 按波次分组 / 跨子会话诊断时间线。 */
type BoardView = "sessions" | "waves" | "diagnostics";

/**
 * 视图切换的固定选项（中文源文案，渲染时过 `t()`）。
 *
 * 用页面级 tab（role=tablist + roving tabindex）而不是 Segmented：提问卡的单选
 * 组本身就是 radiogroup，看板里再插一个 radiogroup 会让「第一个单选组」的定位
 * （屏幕阅读器导航与既有回归测试）错误地指向视图切换。
 */
const BOARD_VIEW_OPTIONS: ReadonlyArray<{ value: BoardView; label: string }> = [
  { value: "sessions", label: "子会话" },
  { value: "waves", label: "按波次" },
  { value: "diagnostics", label: "诊断" },
];

/**
 * 状态文案。
 *
 * 文案是状态的第一重编码 —— 与颜色、图标并列，而不是补充：折叠态一行只有
 * 几十像素，色点在截图里、在色觉障碍下都读不出六种状态的差别。
 */
function statusLabel(session: SuperSessionUi): string {
  // A queued delegation waits for a free concurrency slot — say so instead of
  // pretending it started.
  if (session.queued && session.status === "preparing") {
    return t("排队中");
  }
  switch (session.status) {
    case "preparing":
      return t("准备中");
    case "running":
      return t("运行中");
    case "awaiting_input":
      return t("等你回答");
    case "completed":
      return t("已完成");
    case "failed":
      return t("失败");
    case "cancelled":
      return t("已中断");
  }
}

/**
 * 状态 → 颜色 + 图标（形状）。
 *
 * 图标是第二重编码，形状互不相同：排队=时钟、准备=沙漏、运行=转圈、等你=问号、
 * 完成=对勾、失败=叉、中断=方块。颜色只是第三重冗余。
 *
 * 「准备中」与「等待你处理」曾经共用同一个 warning 色 —— 现在是
 * 沙漏/蓝 与 问号/琥珀，一眼可分：前者用户只能等，后者用户必须动手。
 *
 * 「已中断」刻意用静音色（muted），不是失败的同款 danger 红：shared 层把
 * cancelled 单独计数、明确不计入 failed（见 summarizeSuperSessions / #2919），
 * 染成红色会让人以为子会话出了故障。方块图标 +「已中断」文案仍是主编码，
 * 颜色只是冗余，所以换成静音色不会丢信息，反而少一层误导。failed 继续 danger + X。
 */
const STATUS_VISUAL: Record<SuperStatus, { tone: StatusTone; icon: ReactNode }> = {
  preparing: { tone: "info", icon: <Hourglass className="size-3 shrink-0" aria-hidden="true" /> },
  running: { tone: "primary", icon: <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" /> },
  awaiting_input: { tone: "warning", icon: <CircleHelp className="size-3 shrink-0" aria-hidden="true" /> },
  completed: { tone: "success", icon: <Check className="size-3 shrink-0" aria-hidden="true" /> },
  failed: { tone: "danger", icon: <X className="size-3 shrink-0" aria-hidden="true" /> },
  cancelled: { tone: "muted", icon: <Square className="size-3 shrink-0" aria-hidden="true" /> },
};

/** 排队中：等一个并发名额，还没开始 —— 灰色时钟，与「准备中」的沙漏区分。 */
const QUEUED_VISUAL: { tone: StatusTone; icon: ReactNode } = {
  tone: "muted",
  icon: <Clock className="size-3 shrink-0" aria-hidden="true" />,
};

/** 状态色调 → 文字色（图标与文案共用同一色调）。 */
const STATUS_TEXT: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  primary: "text-primary",
  info: "text-info",
};

/** 一个子会话的完整状态编码：颜色 + 文案 + 图标。 */
function statusVisual(session: SuperSessionUi): {
  tone: StatusTone;
  label: string;
  icon: ReactNode;
} {
  const visual =
    session.queued && session.status === "preparing" ? QUEUED_VISUAL : STATUS_VISUAL[session.status];
  return { tone: visual.tone, label: statusLabel(session), icon: visual.icon };
}

/**
 * 「已中断」标题旁的来源小字：精确区分用户 / 智能体 / 系统三类中断。
 * 仅当状态确为已中断且宿主带上了来源时显示 —— 历史归档无来源时宿主按
 * system 兜底，所以老记录也会如实标注为「由系统中断」，不会留白。
 */
function interruptedByLabel(session: SuperSessionUi): string | null {
  if (session.status !== "cancelled" || !session.interruptedBy) return null;
  switch (session.interruptedBy) {
    case "user":
      return t("由用户中断");
    case "agent":
      return t("由智能体中断");
    case "system":
      return t("由系统中断");
  }
}

/**
 * 失败分类 → 中文源文案。
 *
 * 分类本身是 shared 层给出的稳定英文枚举（retryable / terminal / blocked /
 * interrupted），由 UI 翻成中文 —— 绝不能把枚举原样印到界面上。
 */
function failureKindLabel(kind: SuperBoardFailureKind): string {
  switch (kind) {
    case "retryable":
      return t("可重试的失败");
    case "terminal":
      return t("不可重试的失败");
    case "blocked":
      return t("阻塞");
    case "interrupted":
      return t("中断退出");
  }
}

/** 失败分类的 chip 色调。颜色只是第三重冗余（图标与文案已能独立区分）。 */
const FAILURE_TONE: Record<SuperBoardFailureKind, StatusTone> = {
  retryable: "warning",
  terminal: "danger",
  blocked: "warning",
  interrupted: "muted",
};

/**
 * QQ 远程任务的元信息 tag，挂在对应子会话 title 后面。
 *
 * 数据来自 store 的 `qqTasks` 投影，靠 `findQqTaskForSuperSession` 关联到当前
 * 子会话。只有「远程发起的子会话」才渲染：关联不到（普通本地子会话、或投影
 * 还没到）就返回 null，绝不留空壳。渠道 = 私聊 / 群聊，发起人 = 脱敏 openid。
 */
function QqTaskTags({ session }: { session: SuperSessionUi }) {
  const tasks = useChat((s) => s.state?.qqTasks);
  const qqTask = tasks ? findQqTaskForSuperSession(tasks, session) : undefined;
  if (!qqTask) return null;
  return (
    <>
      {/* Every other chip in the row/header yields at ≤380px; these two were
          the only shrink-0 chip pair left, squeezing the title and status on
          narrow screens. The full channel/sender still lives in the QQ task
          panel, so hiding them here loses nothing.

          用视口媒体查询 `max-[380px]:hidden`，不是容器查询 `@max-[380px]:hidden`：
          这对 chip 只出现在看板的两个 portal 浮层（折叠待答条 + 展开面板）里。
          portal 挂到 document.body 后，App 根的 @container 不再是祖先、body 也
          不是容器，容器查询会恒不匹配（注释声称的窄屏隐藏从未生效）。两个浮层
          都是 fixed 贴视口、宽度=视口减固定 gutter，视口媒体查询才精确对应
          「视口 ≤380px」的意图，也与顶栏控件在同一视口宽度一起收敛。 */}
      <Chip tone="muted" className="shrink-0 max-[380px]:hidden">
        {t("渠道：{0}", qqTask.chatType === "private" ? t("私聊") : t("群聊"))}
      </Chip>
      <Chip tone="muted" className="shrink-0 max-[380px]:hidden">
        {t("发起人：{0}", maskQqOpenId(qqTask.senderId))}
      </Chip>
    </>
  );
}

/** Integration result → text tone. Rendered as inline text rather than a
 * chip: the row already carries a status chip, and a second coloured block
 * per row was pure visual weight. */
const INTEGRATION_TEXT: Record<SuperIntegrationState, string> = {
  merged: "text-success",
  pr_created: "text-primary",
  conflict: "text-destructive",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  not_needed: "text-muted-foreground",
};

/**
 * 折叠行上的集成问题小 chip。
 *
 * 一个「已完成」的子会话并不等于改动落地了：conflict / failed / skipped 以及
 * needsAction 的行，改动还留在分支上等人处理。折叠行只有几十像素，先前只报
 * 「已完成」会把这种问题藏起来，必须展开才知道 —— 这里给一个一眼可见的小
 * chip，完整说明（分支 / detail / PR 地址）仍在展开详情里，不重复。
 *
 * 优先级：needsAction 最需要人动手，先说「需人工合并」；否则 conflict 说
 * 「冲突」；failed / skipped 统一说「未自动合并」（都表示改动没自动进主分支）。
 * 只认终态：还在跑 / 等你回答的行，集成结果还没落定，不该提前打问题标签。
 */
function collapsedIntegrationIssue(
  session: SuperSessionUi,
): { label: string; tone: "danger" | "warning" | "muted" } | null {
  if (!isTerminalSuperStatus(session.status)) return null;
  const state = session.integration?.state;
  const needsAction = session.integration?.needsAction === true;
  if (state !== "conflict" && state !== "failed" && state !== "skipped" && !needsAction) {
    return null;
  }
  if (needsAction) return { label: t("需人工合并"), tone: "warning" };
  if (state === "conflict") return { label: t("冲突"), tone: "danger" };
  return { label: t("未自动合并"), tone: "muted" };
}

/**
 * Short display name for a worktree branch.
 *
 * Branch names are `iflow/super/<task-slug>-<ts36>-<seq36>`; the slug is
 * derived from the title printed on the same row, so repeating it is
 * duplicate noise. Keep the unique suffix (what tells siblings apart) and
 * leave the full ref to the tooltip / live pane. Both suffix parts are
 * base36 — a decimal-only match silently stops shortening from the 6th
 * child in a host process (seq 10 → "a").
 */
const SUPER_BRANCH_PREFIX = "iflow/super/";

export function shortBranch(branch: string): string {
  if (!branch.startsWith(SUPER_BRANCH_PREFIX)) return branch;
  const tail = branch.slice(SUPER_BRANCH_PREFIX.length);
  const match = /-([a-z0-9]+-[a-z0-9]+)$/i.exec(tail);
  return match ? `super/…${match[1]}` : branch;
}

/** Id shared by the header toggle (`aria-controls`) and the expanded panel. */
const SUPER_BOARD_PANEL_ID = "super-board-panel";

/** 视图 tab 所控制的 tabpanel id（与 SettingsModal 的 tab/tabpanel 关系同构）。 */
const SUPER_BOARD_VIEW_PANEL_ID = "super-board-view-panel";

/**
 * 视图层的「已点击、等 host 回包」乐观集合 —— merge / retry 共用。
 *
 * host 的这两条动作都是异步的（合并要派一个独立 CLI 子会话跑几十秒到几分
 * 钟；重试要重置 worktree 再起进程），从点击到 store 变化之间存在空窗；
 * 只靠 host toast 会让来源行「看起来没反应」。点击即把 id 放进集合，等
 * `resolve` 判定 host 结果落定（或 id 从 superSessions 消失）就清掉，并有
 * 兜底超时，绝不永久转圈。卸载时清掉全部定时器，避免对已卸载树 setState。
 *
 * 与 cleanup 的 `cleanupPending` 是同一套纪律（那套是更早落地的独立实现，
 * 这里刻意不重构它，避免动到刚合入的代码）。
 */
function useSuperActionPending(
  sessions: readonly SuperSessionUi[] | undefined,
  timeoutMs: number,
  resolve: (session: SuperSessionUi | undefined) => boolean,
  onDrop?: (id: string) => void,
  hold?: { ms: number; while: (session: SuperSessionUi | undefined) => boolean },
): { pending: ReadonlySet<string>; begin: (id: string) => void } {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef<Map<string, number>>(new Map());
  // 定时器回调与 resolve effect 都要读**最新**快照：闭包里的 sessions 是
  // 点击那一刻的，用它判断「合并子会话还在不在跑」会一直看到旧值。
  const latest = useRef({ sessions, hold });
  latest.current = { sessions, hold };
  const drop = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
      onDrop?.(id);
      setPending((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [onDrop],
  );
  const arm = useCallback(
    (id: string, ms: number) => {
      const existing = timers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          const { sessions: list, hold: current } = latest.current;
          const session = list?.find((s) => s.id === id);
          // 已受理的合并会跑几十秒到几分钟：只要代表它的合并子会话还在跑就
          // 续期，不能在半途把按钮解锁、让人以为没在合并。被 host 拒掉的
          // 请求不会产生合并子会话，到点就收尾（host 的 toast 已说明原因）。
          if (current && current.while(session)) {
            arm(id, current.ms);
            return;
          }
          drop(id);
        }, ms),
      );
    },
    [drop],
  );
  const begin = useCallback(
    (id: string) => {
      setPending((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      arm(id, timeoutMs);
    },
    [arm, timeoutMs],
  );
  // Host 结果落定（integration 改写 / 状态变化）或行消失时收尾，清除定时器。
  useEffect(() => {
    if (pending.size === 0) return;
    const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
    const settled = [...pending].filter((id) => resolve(byId.get(id)));
    if (settled.length === 0) return;
    setPending((prev) => {
      const next = new Set(prev);
      for (const id of settled) next.delete(id);
      return next;
    });
    for (const id of settled) {
      const timer = timers.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
      onDrop?.(id);
    }
  }, [sessions, pending, resolve, onDrop]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );
  return { pending, begin };
}

/**
 * Geometry of the portaled board surfaces.
 *
 * The panel used to be `absolute inset-x-3 top-full` inside the header, so
 * the 12px gutter and the gap under the header came from CSS. A portal has
 * no CSS anchor, so both are computed from the header's rect instead:
 *  - `BOARD_GUTTER` = the header's own px-3 padding (left/right inset),
 *  - `BOARD_PANEL_GAP` / `BOARD_STRIP_GAP` = the old mt-2 / mt-1.
 */
const BOARD_GUTTER = 12;
const BOARD_PANEL_GAP = 8;
const BOARD_STRIP_GAP = 4;

/** Viewport anchor for the portaled surfaces (null until measured). */
interface BoardAnchor {
  /** Left edge of the surface, in viewport pixels. */
  left: number;
  /** Distance from the viewport's right edge to the surface's right edge. */
  right: number;
  /** Bottom edge of the header, in viewport pixels. */
  bottom: number;
}

/**
 * 阶段轨节点标签。
 *
 * - `rawLabel`：子会话自己写的 todolist 原文（动态文本），**绝不过字典** ——
 *   `t()` 会把用户文本当 key 查，查不到虽回落原文，但一旦与某个字典 key 撞上
 *   就会被悄悄改写，且这些文本本就不该进翻译表。
 * - `attempt` 节点带数字（「第 2 次」），走带参模板；
 * - 其余是固定中文短语，直接过字典（缺翻译时 `t()` 回落原文）。
 */
function timelineNodeLabel(node: SuperTimelineNode): string {
  if (node.rawLabel) return node.label;
  if (node.kind === "attempt" && node.attempt !== undefined) return t("第 {0} 次", node.attempt);
  return t(node.label);
}

/** 节点时间（HH:MM:SS）。只进 title / aria-label，不铺在行内。 */
function formatClock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 圆点色调：已发生=实心、当前=高亮、失败/中断=错误色、跳过=静音。 */
function timelineDot(node: SuperTimelineNode): string {
  switch (node.tone) {
    case "current":
      // 「等你回答」是唯一必须由人推动的状态，用警告色；排队等名额是信息色，
      // 真正在跑的用主色 —— 三者在折叠行上仍然只靠圆点区分，所以每一档都配
      // 一圈 ring 把「当前」这一层单独画出来。
      return node.kind === "awaiting_input"
        ? "bg-warning ring-2 ring-warning/30"
        : node.kind === "queued"
          ? "bg-info ring-2 ring-info/30"
          : "bg-primary ring-2 ring-primary/30";
    case "failed":
      return "bg-destructive";
    case "idle":
      return "bg-muted-foreground/40";
    case "done":
    default:
      return "bg-muted-foreground/60";
  }
}

/** 标签文字色（与圆点同一套色调，文案是主编码）。 */
const TIMELINE_TEXT: Record<SuperTimelineTone, string> = {
  done: "text-muted-foreground",
  current: "text-primary",
  failed: "text-destructive",
  idle: "text-muted-foreground/70",
};

function timelineText(node: SuperTimelineNode): string {
  if (node.tone !== "current") return TIMELINE_TEXT[node.tone];
  if (node.kind === "awaiting_input") return "text-warning";
  if (node.kind === "queued") return "text-info";
  return TIMELINE_TEXT.current;
}

/**
 * 子会话时间轨：节点的横向序列（6px 圆点 + 1px 连接线）。
 *
 * 数据全部来自 `deriveSuperTimeline` —— 有 todolist 时只画子会话自己建的步骤
 * （原文），否则降级回真实发生过的阶段事实，绝不渲染固定模板。阶段事实（派发
 * / 启动 / 集成等）在 todolist 模式下不再占节点，改由 `describeSuperTimelineFacts`
 * 收进 `title` / `aria-label`。纯展示：不新增点击通道。
 *
 * 只在展开区出现（折叠行只报状态）。轨用 `flex-wrap` + 标签 `min-w-0 break-words`：
 * 节点放不下就换行，最后一条 todo 文本在任何窄屏都完整可见，绝不靠裁切 /
 * 省略号藏字（超长单条由 shared 层 200 字符上限兜底）。圆点与连接线 `shrink-0`。
 */
function SuperTimeline({
  session,
  labeled = false,
  className = "",
}: {
  session: SuperSessionUi;
  labeled?: boolean;
  className?: string;
}) {
  const nodes = useMemo(() => deriveSuperTimeline(session), [session]);
  const hasTodos = nodes.some((node) => node.kind === "todo");
  // todolist 模式：节点只画步骤原文，派发 / 启动 / 集成等事实挪到 title 前缀，
  // 每条 todo 附上状态（+ 优先级）说明，仍可在 title / aria-label 里查到。
  // 状态 / 优先级是静态中文词，逐段过字典；todo 原文绝不过字典。
  const described = hasTodos
    ? [
        describeSuperTimelineFacts(session),
        ...nodes.map((node) => {
          const label = timelineNodeLabel(node);
          const detail = node.detail
            ? `（${node.detail
                .split(SUPER_TODO_DETAIL_SEP)
                .map((part) => t(part))
                .join(SUPER_TODO_DETAIL_SEP)}）`
            : "";
          return `${label}${detail}`;
        }),
      ]
        .filter(Boolean)
        .join("\n")
    : nodes
        .map((node) => {
          const label = timelineNodeLabel(node);
          return node.at === undefined ? label : `${label} ${formatClock(node.at)}`;
        })
        .join(" → ");

  return (
    <span
      role="img"
      aria-label={t("阶段轨：{0}", described)}
      title={described}
      className={`flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 ${className}`}
    >
      {nodes.map((node, index) => (
        <span key={`${node.kind}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 && <span className="h-px w-2 shrink-0 bg-border" aria-hidden="true" />}
          <span
            className={`size-1.5 shrink-0 rounded-full ${timelineDot(node)}`}
            aria-hidden="true"
          />
          {labeled && (
            <span
              className={`min-w-0 break-words text-ui-micro font-medium ${timelineText(node)}`}
            >
              {timelineNodeLabel(node)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function isActive(session: SuperSessionUi): boolean {
  return session.status === "preparing" || session.status === "running" || session.status === "awaiting_input";
}

/**
 * 该子会话是否仍占用一个磁盘工作目录。
 *
 * `repo` 档的 path 是主仓根 —— 它不是隔离产物，清理时也不能删，所以从不计入
 * 「工作目录占用」。已释放（合并成功清理 / 终态回收）的目录在磁盘上已不存在。
 */
function holdsWorktree(isolation: SuperIsolation): boolean {
  return isolation.kind !== "repo" && !isolation.released;
}

/**
 * 一条「残留分支」记录：已中断 / 放弃的子会话，分支还在磁盘 / git 里，
 * 但改动没有成功并入当前分支 —— 需要人决定「合并」还是「丢弃」。
 *
 * 判定只用真实存在的 SuperSessionUi 字段，不依赖任何尚不存在的 residue
 * 消息或字段：终态、git worktree 档、分支名存在、且未成功合并（merged /
 * pr_created 视为已落地；not_needed 表示本就没提交，无需处置）。
 */
function isResidualSuperBranch(session: SuperSessionUi): boolean {
  if (!isTerminalSuperStatus(session.status)) return false;
  if (session.isolation.kind !== "git_worktree") return false;
  if (!session.isolation.branch) return false;
  const state = session.integration?.state;
  if (state === "merged" || state === "pr_created" || state === "not_needed") return false;
  return true;
}

/**
 * 已释放状态的文案（三态）。
 *
 * - `recycled`：目录被回收，**本地分支仍保留**（分支上有未合并提交，刻意留下待审）。
 * - 其余 `released`：目录与分支都已清理（合并成功，或根本没产生提交）。
 */
function releasedIsolationLabel(isolation: SuperIsolation): string {
  return isolation.recycled ? t("工作目录已删除，分支保留") : t("工作目录和分支都已删除");
}

/**
 * 单个「清理」确认文案 —— 按隔离类型如实说明宿主的实际行为。
 *
 * 真相来源是 `src/panel/super-agent.ts` 的 `cleanup()`，四种情况各不相同：
 *  - `git_worktree`：工作目录里有未提交改动 → **拒绝清理**（目录不会删）；
 *    分支上还有未合并提交 → 只删目录、保留分支；已合并或没有提交 → 目录与
 *    分支一起删。旧文案写「未提交的改动会被一起删掉」，与「拒绝清理」相反。
 *  - `directory`：非 git 仓库的降级隔离，直接删掉那个独立目录，没有分支。
 *  - `repo`：合并子会话跑在主仓工作区，path 就是主仓根 —— 清理**只移除看板
 *    记录**，绝不删主仓里的任何文件（旧文案会让人以为要删主仓）。
 *  - 已释放（合并成功清理过 / 终态回收）：磁盘上早就没有目录与分支了，同样
 *    只移除记录；重复清理是幂等的。
 */
function cleanupConfirmMessage(session: SuperSessionUi): string {
  const isolation = session.isolation;
  if (isolation.released) {
    return t(
      "移除超流体「{0}」的看板记录？它的工作目录与分支之前已经清理过，这次只删除记录。",
      session.title,
    );
  }
  switch (isolation.kind) {
    case "repo":
      return t(
        "移除超流体「{0}」的看板记录？它直接跑在主工作区（没有独立工作目录与分支），清理不会删除主仓里的任何文件。",
        session.title,
      );
    case "directory":
      return t(
        "删除超流体「{0}」的独立目录？它只有目录隔离、没有分支，目录里的全部内容会被删掉，无法恢复。",
        session.title,
      );
    case "git_worktree":
    default:
      return t(
        "删除超流体「{0}」的工作目录？工作目录里有未提交的改动时会被拒绝清理（请先提交或丢弃）；分支上还有未合并的提交时只删工作目录、保留分支，已合并或没有提交时分支一并删除。",
        session.title,
      );
  }
}

/**
 * 批量「清理已结束」确认文案 —— 与 {@link cleanupConfirmMessage} 同一口径。
 *
 * 批量入口只收仍占着磁盘目录的终态子会话（`holdsWorktree`），所以只会出现
 * `git_worktree` 与 `directory` 两档；两者的真实行为不同，必须分开说清：
 * 有未提交改动会被拒绝、分支是否保留由未合并提交决定、目录档没有分支。
 */
function bulkCleanupConfirmMessage(sessions: readonly SuperSessionUi[]): string {
  const worktrees = sessions.filter((s) => s.isolation.kind === "git_worktree").length;
  const directories = sessions.length - worktrees;
  const clauses: string[] = [];
  if (worktrees > 0) {
    clauses.push(
      t(
        "删除 {0} 个 git 工作目录：有未提交的改动时会被拒绝清理；分支上还有未合并的提交时只删目录、保留分支，已合并或没有提交时分支一并删除",
        worktrees,
      ),
    );
  }
  if (directories > 0) {
    clauses.push(
      t("删除 {0} 个只有目录隔离的独立目录：它们没有分支，目录内容会全部删除", directories),
    );
  }
  return t("将清理 {0} 个超流体：{1}。", sessions.length, clauses.join("；"));
}

/** Stable empty transcript: returning a fresh `[]` from a zustand selector
 * would change identity on every render. */
const EMPTY_TRANSCRIPT: Block[] = [];

/** Elapsed time, humanized. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * 子会话的耗时文字，折叠行与实时弹窗共用这一处口径。
 *
 * startedAt 不存在（排队中 / 准备中还没启动）时，唯一可用的时刻是派发时刻
 * createdAt。旧实现把它当成「已运行」的起点，于是等并发名额的时间被算进了
 * 运行耗时。现在这段等待明确标成「排队 Ns」，和真正启动后的耗时区分开。
 */
function elapsedText(session: SuperSessionUi, now: number): string {
  const at = session.endedAt ?? now;
  if (session.startedAt !== undefined) return formatElapsed(at - session.startedAt);
  return t("排队 {0}", formatElapsed(at - session.createdAt));
}

/**
 * 子会话「最近一次活动」的时刻（epoch ms）。
 *
 * 活动时刻的优先级（高 → 低）：
 *   ① `diagnostics[].activityDetail.at` —— 结构化活动细节里的原始活动时刻，
 *      它可与事件写入时刻 `at` 不同（诊断落盘略晚于活动发生），最贴近「模型 /
 *      工具最近一次真正推进」的时间；
 *   ② `diagnostics[].at` —— 没有结构化细节时的逐条诊断事件时间戳；
 *   ③ `updatedAt` —— 每次状态推进刷新，诊断缺省时的兜底。
 *
 * 这里刻意**不**筛 kind：shared 的 SuperDiagnosticKind 是稳定枚举（spawn /
 * session / report / merge / retry / error / timeout / restore / blocked），
 * 任何一条都是一次「活动」。慢任务每隔几十秒有 report / session 心跳，看板
 * 显示「最近活动 Ns 前」就能让人在卡住时提前手动中断，不必干等看门狗。
 */
function lastActivityAt(session: SuperBoardSession): number {
  let at = session.updatedAt ?? 0;
  for (const raw of session.diagnostics ?? []) {
    if (!raw) continue;
    // activityDetail 定义在 shared 的 SuperDiagnosticEvent 上；看板视图模型
    // SuperBoardDiagnosticEvent 为前向兼容只声明公共字段，这里按可选结构读，
    // 缺字段时退回事件 at —— 旧数据行为逐字不变。
    const event = raw as typeof raw & { activityDetail?: { at?: number } };
    const detailAt = event.activityDetail?.at;
    const candidate =
      typeof detailAt === "number" && Number.isFinite(detailAt) ? detailAt : raw.at;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > at) {
      at = candidate;
    }
  }
  return Number.isFinite(at) ? at : 0;
}

/**
 * 最近活动的一句短摘要（可选）：取最新一条带结构化细节的诊断，优先
 * activityDetail.excerpt，其次 toolCallDetail 的「工具名 + 摘要」。两者都
 * 没有时返回空串 —— title 退回通用说明，不给旧数据添噪音。
 */
function recentActivityExcerpt(session: SuperBoardSession): string {
  const diagnostics = session.diagnostics ?? [];
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const raw = diagnostics[i];
    if (!raw) continue;
    const event = raw as typeof raw & {
      activityDetail?: { excerpt?: string };
      toolCallDetail?: { name?: string; excerpt?: string };
    };
    const text =
      event.activityDetail?.excerpt ??
      (event.toolCallDetail?.excerpt
        ? `${event.toolCallDetail.name ?? ""}：${event.toolCallDetail.excerpt}`
        : "");
    if (text) return text;
  }
  return "";
}

/**
 * 「最近活动 Ns 前」的展示文案。silent=true 表示静默超过阈值（慢任务疑似
 * 卡住），调用方据此上警示色；文案只用相对时间，避免每行都钉一个绝对时钟。
 */
const SUPER_SILENCE_WARN_MS = 60_000;

function recentActivityText(
  session: SuperBoardSession,
  now: number,
): { text: string; elapsed: string; silent: boolean } {
  const at = lastActivityAt(session);
  if (at <= 0) return { text: t("活动未知"), elapsed: "", silent: false };
  const elapsed = formatElapsed(Math.max(0, now - at));
  return {
    text: t("最近活动 {0} 前", elapsed),
    elapsed,
    silent: Math.max(0, now - at) >= SUPER_SILENCE_WARN_MS,
  };
}

/** Compact token count: 1234 → 1.2K, 1234567 → 1.2M. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Compact USD estimate for the row chip: sub-cent figures keep 4 decimals. */
function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Detail/total precision: a child turn is usually a fraction of a cent, so
 * keep four decimals until the figure reaches a dollar. */
function formatCostPrecise(usd: number): string {
  if (usd > 0 && usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Super Agent board — the management surface for the main session's child
 * sessions.
 *
 * Every child runs in its own git worktree (its own branch, its own
 * directory), so several of them can edit the same project at the same time
 * without colliding. The board is where the user sees them, answers their
 * pending questions, interrupts them, merges their branch back, or cleans
 * them up.
 *
 * Children are opened by the AGENT, not by the user: the main session
 * delegates by emitting a `super-agent` block and the host dispatches it.
 * The board therefore has no create form — it only manages what the agent
 * opened.
 *
 * The board is NOT the transcript: a child's transcript stays in its own
 * process; here we only show its status, its summary, its live progress tail,
 * its token usage and its pending request.
 *
 * Presentation: the board is part of the header (App.tsx renders it after the
 * status chip). Collapsed it is ONE inline control — icon + label + counts +
 * chevron — at the header's control height, so it never takes a transcript
 * row and a child appearing cannot squeeze the message list. Expanded it
 * opens a popup panel anchored under the header and closes on Esc / outside
 * click.
 *
 * Material: the panel is PORTALED to document.body (the same move
 * ConfirmDialog makes), so it sits OUTSIDE the acrylic header — and outside
 * every backdrop root. As a child of the header it was part of that
 * backdrop root: per Filter Effects L2 its own backdrop-filter could only
 * sample the header's subtree, so the transcript text behind it ghosted
 * through sharp (the trap documented on .acrylic-pop in styles.css), and the
 * panel had to fall back to a near-opaque tint. Out here the panel carries
 * .acrylic-frosted — a translucent tint plus a real backdrop blur — so the
 * transcript behind it is frosted into a matte backdrop instead of reading
 * through. It is the only true frosted surface in the app.
 *
 * Positioning: a portal has no CSS anchor (the old `absolute top-full
 * inset-x-3` needed the header to be the positioned ancestor), so the panel
 * is placed in viewport coordinates from the header's rect and re-measured
 * whenever the header moves or resizes.
 */
export function SuperAgentBoard({
  panelRef,
  frozen = false,
}: {
  panelRef?: (el: HTMLDivElement | null) => void;
  /**
   * 远程接管（QQ takeover）期间冻结看板的**可交互表面**。
   *
   * 折叠控件本身由 App 的 inert 子树包住，但展开的浮层与折叠时的待答条都
   * `createPortal` 到 `document.body` —— 它们不在那棵子树里，App 的 inert
   * 管不到。于是接管态下：顶栏里的控件看着是禁用的，portal 出来的浮层却仍
   * 能点「中断 / 合并 / 清理」，甚至能回答子会话的提问，把远端正在推进的
   * 流程打断。这里给两个 portal 表面加 inert（鼠标与键盘一起拦），并以
   * opacity 标出冻结态；不额外加 `pointer-events-none` —— 那会让点击穿透到
   * 浮层下面的转录区，误触到别的按钮。宿主侧还有第二层门（接管期间
   * `handleSuperAgentAction` 直接拒绝），不靠 UI 单层保证。
   */
  frozen?: boolean;
}) {
  const sessions = useChat((s) => s.state?.superSessions);
  const activeSessionId = useChat((s) => s.state?.activeSessionId ?? null);
  const send = useChat((s) => s.send);
  const [expanded, setExpanded] = useState(false);
  // 飞入体抵达后看板控件短暂高亮。定时器受组件卸载清理，避免泄漏。
  const [received, setReceived] = useState(false);
  const receivedTimer = useRef<number | null>(null);
  const onDelegationArrive = useCallback(() => {
    setReceived(true);
    if (receivedTimer.current !== null) window.clearTimeout(receivedTimer.current);
    receivedTimer.current = window.setTimeout(() => {
      receivedTimer.current = null;
      setReceived(false);
    }, 480);
  }, []);
  useEffect(
    () => () => {
      if (receivedTimer.current !== null) window.clearTimeout(receivedTimer.current);
    },
    [],
  );
  const [confirmMerge, setConfirmMerge] = useState<SuperSessionUi | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<SuperSessionUi | null>(null);
  // Bulk cleanup snapshots the reclaimable SESSIONS at open time — the confirm
  // text has to name what is actually going to happen per isolation kind
  // (git worktree vs. plain directory), and recomputing while the dialog is
  // open could silently drop a child that just turned terminal (or claim one
  // that is still running) between the click and the confirm.
  const [confirmCleanupAll, setConfirmCleanupAll] = useState<SuperSessionUi[] | null>(null);
  // Cleanup is asynchronous on the host side (dispose client → delete the
  // worktree → git probes → emit). The confirm dialog closes immediately and
  // the row stays put until the host removes it, so without an optimistic flag
  // the click looks lost. This set is view-only: a confirmed id goes in at
  // click time and comes out either when the session disappears from
  // superSessions (host finished) or via a timeout fallback (cleanup failed
  // but the session is still on the board — never spin forever).
  const CLEANUP_PENDING_TIMEOUT_MS = 30_000;
  const [cleanupPending, setCleanupPending] = useState<ReadonlySet<string>>(() => new Set());
  const cleanupTimers = useRef<Map<string, number>>(new Map());
  const beginCleanup = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setCleanupPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      const existing = cleanupTimers.current.get(id);
      if (existing !== undefined) window.clearTimeout(existing);
      cleanupTimers.current.set(
        id,
        window.setTimeout(() => {
          cleanupTimers.current.delete(id);
          setCleanupPending((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, CLEANUP_PENDING_TIMEOUT_MS),
      );
    }
  }, []);
  // The host's cleanup emit removes the session from superSessions. Prune the
  // matching optimistic flag (and its timer) so the row's in-progress state
  // ends naturally with the row itself — no flash of a finished row still
  // saying 「清理中」.
  useEffect(() => {
    if (cleanupPending.size === 0) return;
    const present = new Set((sessions ?? []).map((s) => s.id));
    const stale = [...cleanupPending].filter((id) => !present.has(id));
    if (stale.length === 0) return;
    setCleanupPending((prev) => {
      const next = new Set(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
    for (const id of stale) {
      const timer = cleanupTimers.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        cleanupTimers.current.delete(id);
      }
    }
  }, [sessions, cleanupPending]);
  // The board can unmount mid-cleanup (session switch / panel close): cancel
  // the fallback timers so no setState fires on an unmounted tree.
  useEffect(
    () => () => {
      for (const timer of cleanupTimers.current.values()) window.clearTimeout(timer);
      cleanupTimers.current.clear();
    },
    [],
  );
  // 「让智能体合并」在 host 侧是异步的：它派一个跑在主仓工作区的合并子
  // 会话（几十秒到几分钟），结果由合并子会话跑完时写回**来源**子会话的
  // integration。所以「已请求、未合入」必须和「已合入」分开显示 —— 来源行
  // 立刻转圈说「合并中」，等 integration 真的落定（state=merged，或任何
  // 新的结果 at）才收尾。
  //
  // 两条收尾路径，缺一不可：
  //   ① integration 落定 —— 合并子会话结束时 onMergeResult 回写 at/state；
  //   ② 请求根本没被受理（已有合并在跑 / 主会话正忙 / 行状态已变），
  //      integration 永不变，等一个短宽限期仍看不到合并子会话就收尾 ——
  //      host 的 warning toast 已经说明了原因，不能把按钮锁死几分钟。
  // 一旦确认「这次请求已被受理」（主仓工作区的合并子会话 + 标题带该分支
  // 名），超时只**续期**同一个宽限期，绝不谎报已合并；合并子会话一结束、
  // integration 又没回来（宿主异常），也会在一个宽限期内解锁而不是永久转圈。
  const MERGE_ACCEPT_GRACE_MS = 6_000;
  const mergeStarts = useRef<Map<string, number | undefined>>(new Map());
  const dropMergeStart = useCallback((id: string) => {
    mergeStarts.current.delete(id);
  }, []);
  const mergeSettled = useCallback((session: SuperSessionUi | undefined) => {
    if (!session) return true; // 来源行已被清理：不必再转圈
    const startAt = mergeStarts.current.get(session.id);
    return session.integration?.state === "merged" || session.integration?.at !== startAt;
  }, []);
  const mergeInFlight = useCallback(
    (session: SuperSessionUi | undefined) => {
      const branch = session?.isolation.branch;
      if (!branch) return false;
      // 合并子会话落在主仓工作区（repo 档、没有自己的分支），标题由 host
      // 写成「合并分支 <branch>」。分支名唯一，用它把「这次请求已被受理」
      // 与「被拒」区分开：只有真正在跑才值得继续转圈。
      return (sessions ?? []).some(
        (s) =>
          s.isolation.kind === "repo" &&
          !isTerminalSuperStatus(s.status) &&
          s.title.includes(branch),
      );
    },
    [sessions],
  );
  const mergeHold = useMemo(
    () => ({ ms: MERGE_ACCEPT_GRACE_MS, while: mergeInFlight }),
    [mergeInFlight],
  );
  const mergeAction = useSuperActionPending(
    sessions,
    MERGE_ACCEPT_GRACE_MS,
    mergeSettled,
    dropMergeStart,
    mergeHold,
  );
  const beginMerge = useCallback(
    (id: string, integrationAt: number | undefined) => {
      mergeStarts.current.set(id, integrationAt);
      mergeAction.begin(id);
    },
    [mergeAction],
  );
  // 「重试」的 host 回包通常亚秒级，但点击到回包之间仍有空窗：本地记下
  // 点击瞬间的 status/attempts，任一变化就说明 host 已受理并收尾；回包丢失
  // 时用较短的兜底超时解锁，避免一次丢包把按钮永久锁死。
  const RETRY_PENDING_TIMEOUT_MS = 15_000;
  const retryStarts = useRef<Map<string, { status: SuperStatus; attempts: number }>>(new Map());
  const dropRetryStart = useCallback((id: string) => {
    retryStarts.current.delete(id);
  }, []);
  const retrySettled = useCallback((session: SuperSessionUi | undefined) => {
    if (!session) return true;
    const start = retryStarts.current.get(session.id);
    if (!start) return true;
    return session.status !== start.status || (session.attempts ?? 1) !== start.attempts;
  }, []);
  const retryAction = useSuperActionPending(
    sessions,
    RETRY_PENDING_TIMEOUT_MS,
    retrySettled,
    dropRetryStart,
  );
  const beginRetry = useCallback(
    (session: SuperSessionUi) => {
      retryStarts.current.set(session.id, {
        status: session.status,
        attempts: session.attempts ?? 1,
      });
      retryAction.begin(session.id);
      send({ type: "superAgent", action: "retry", sessionId: session.id });
    },
    [retryAction, send],
  );
  // 中断的 host 回包是异步的（杀进程 → dispose → 落终态），从点确认到状态
  // 翻转之间有空窗；和 retry 同款纪律：点击即把 id 标成「中断中」，状态一变
  // 就收尾，回包丢失用短超时解锁 —— 避免用户以为没生效又点一次（那正是
  // 「中断没生效」BUG 的现场之一）。
  const CANCEL_PENDING_TIMEOUT_MS = 15_000;
  const cancelStarts = useRef<Map<string, SuperStatus>>(new Map());
  const dropCancelStart = useCallback((id: string) => {
    cancelStarts.current.delete(id);
  }, []);
  const cancelSettled = useCallback((session: SuperSessionUi | undefined) => {
    if (!session) return true; // 行已被清理
    const start = cancelStarts.current.get(session.id);
    if (!start) return true;
    // 中断会把状态从活跃翻成 cancelled（终态）；状态一变即视为 host 已受理。
    return session.status !== start;
  }, []);
  const cancelAction = useSuperActionPending(
    sessions,
    CANCEL_PENDING_TIMEOUT_MS,
    cancelSettled,
    dropCancelStart,
  );
  const markCancelPending = useCallback(
    (items: readonly SuperSessionUi[]) => {
      for (const session of items) {
        cancelStarts.current.set(session.id, session.status);
        cancelAction.begin(session.id);
      }
    },
    [cancelAction],
  );
  // Interrupts kill a live process, so both the per-row and the board-wide
  // action go through a confirm dialog like merge / cleanup do. The board-wide
  // variant snapshots the active count at open time — recomputing it while the
  // dialog is open could show “0 个” if the children finish on their own.
  const [confirmCancel, setConfirmCancel] = useState<SuperSessionUi | null>(null);
  // 「判定卡死」与中断同样杀进程，但与「我已经判定它卡住」语义不同：宿主会先
  // 记一条用户判定的 timeout 诊断，再按 user 来源中断。单独一个确认目标，避免
  // 与「中断」确认框串台。
  const [confirmStuck, setConfirmStuck] = useState<SuperSessionUi | null>(null);
  const [confirmCancelAll, setConfirmCancelAll] = useState<number | null>(null);
  // Finished children whose changes are already merged live in one collapsed
  // history row (collapsed by default — nothing in them is actionable).
  const [showFolded, setShowFolded] = useState(false);
  // At most one row's detail is open: the board must never read as a stack of
  // expanded cards. Pending questions are exempt (they render outside this).
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Ticking clock for the elapsed labels of live children. The value is the
  // wall-clock instant the labels are rendered against (the rows read `now`
  // instead of calling Date.now() during render), so the state only has to
  // change when that instant actually moved on.
  const [now, setNow] = useState(() => Date.now());
  // The inline header control and the popup panel are siblings (the panel is
  // absolutely positioned under the header), so the outside-click test has to
  // check BOTH boxes.
  const controlRef = useRef<HTMLButtonElement>(null);
  const panelNodeRef = useRef<HTMLDivElement>(null);
  const setPanelNode = useCallback(
    (node: HTMLDivElement | null) => {
      panelNodeRef.current = node;
      panelRef?.(node);
    },
    [panelRef],
  );

  const list = sessions ?? [];
  // Board order + folding: children that still need attention come first,
  // done-and-merged ones are folded away (pure logic, shared/super-agent.ts).
  const { visible, folded } = useMemo(() => groupSuperSessionsForBoard(list), [list]);
  // Folded children hold TWO different integration outcomes: `merged` (their
  // changes really landed) and `not_needed` (they produced no commit at all —
  // see `isSuperSessionSettled`). The collapsed row used to lump both under
  // 「已完成并合并」, which reads as “your changes landed” for a child that never
  // made any. Split the counts so the header only claims a merge when one
  // actually happened.
  // `needsAction` (shared/super-agent.ts) is written in a dozen host paths but
  // used to be read NOWHERE in the webview: a skipped child that must be merged
  // by hand looked identical to one that was interrupted and needs nothing.
  // Count it separately so the folded header cannot mislabel it as "no merge
  // needed" if the folding rule is ever widened to include such children.
  const foldedOutcomes = useMemo(() => {
    let merged = 0;
    let nothingToMerge = 0;
    let needsAttention = 0;
    for (const session of folded) {
      if (session.integration?.state === "merged") merged += 1;
      else if (session.integration?.state === "not_needed") nothingToMerge += 1;
      if (session.integration?.needsAction === true) needsAttention += 1;
    }
    return { merged, nothingToMerge, needsAttention };
  }, [folded]);
  // Non-terminal children (the interrupt-all gate + the elapsed timer). The
  // per-state COUNTS come from the shared summarizer — computing them here
  // with a status filter is how “2 个进行中” ended up double-counting the
  // awaiting child (it has its own chip).
  const active = useMemo(
    () => list.filter((s) => s.status === "preparing" || s.status === "running" || s.status === "awaiting_input"),
    [list],
  );
  // Children blocked on a human. A pending question is the ONLY thing that
  // truly needs the user, so it must stay on screen even when the popup is
  // collapsed — see the collapsed strip below. (`active` cannot be reused:
  // it also carries preparing/running children, which have no question.)
  const awaiting = useMemo(
    () => list.filter((s) => s.status === "awaiting_input" && s.pending !== undefined),
    [list],
  );
  // Edge glow on the collapsed control: ANY non-terminal child counts.
  // `isTerminalSuperStatus` is the single source of truth in shared/super-agent.ts,
  // so a board of only completed/failed/cancelled children renders NO decorative
  // layer at all — a completely static control with no extra DOM, no animation.
  // Memoized on the list: the board re-renders every second while a child is
  // running (the elapsed clock), and the flag only changes with the list.
  const hasActiveChild = useMemo(() => hasActiveSuperSession(list), [list]);
  const counts = useMemo(() => summarizeSuperSessions(list), [list]);
  const totals = useMemo(() => sumSuperUsage(list), [list]);
  // 看板视图三态：「子会话」= 既有平铺（默认，行为完全不变）、「按波次」=
  // 运行组 / 波次分组、「诊断」= 跨子会话诊断时间线。默认仍是平铺 —— 旧数据
  // （没有 runId / wave / diagnostics）不该被强行换到一个新视图里。
  const [boardView, setBoardView] = useState<BoardView>("sessions");
  // 视图 tab 的 roving tabindex：只有当前视图在 Tab 序列里，方向键 / Home / End
  // 在三个视图间移动（复用 kit 的 rovingTabKeyDown）。
  const boardViewRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onBoardViewKeyDown = rovingTabKeyDown<BoardView>(
    BOARD_VIEW_OPTIONS.map((option) => option.value),
    boardView,
    setBoardView,
    (id) => boardViewRefs.current[id]?.focus(),
  );
  // 聚合是纯函数：分组 / 波次 / 全量统计 / 诊断汇总一次算出。空列表也返回
  // 合法空聚合（不抛错、不出现 undefined / NaN）。
  const aggregate = useMemo(() => buildSuperBoardAggregate(list), [list]);
  const diagnosticTimeline = useMemo(() => collectSuperBoardDiagnosticTimeline(list), [list]);
  // 行渲染只写一次：平铺视图与波次视图共用同一个 SuperSessionRow（含全部
  // pending 状态与 openRow 单选），分组视图绝不另造一套行组件 —— 那会让
  // 「一次只展开一行」的纪律在两个视图里分叉。
  const renderRow = (session: SuperBoardSession) => (
    <SuperSessionRow
      key={session.id}
      session={session}
      now={now}
      open={openRow === session.id}
      cleanupPending={cleanupPending.has(session.id)}
      mergePending={mergeAction.pending.has(session.id)}
      retryPending={retryAction.pending.has(session.id)}
      cancelPending={cancelAction.pending.has(session.id)}
      onToggle={() => setOpenRow((v) => (v === session.id ? null : session.id))}
      onMerge={() => setConfirmMerge(session)}
      onRetry={() => beginRetry(session)}
      onCleanup={() => setConfirmCleanup(session)}
      onCancel={() => setConfirmCancel(session)}
      onStuck={() => setConfirmStuck(session)}
    />
  );

  // --- anchoring for the portaled surfaces --------------------------------
  // The panel and the collapsed pending strip are portaled to document.body
  // (see the component comment: only a surface outside every backdrop root
  // can blur the real backdrop). A portal has no CSS anchor, so their
  // position is computed from the header's rect instead — the panel keeps
  // the header's own 12px gutter and hangs right under the header's bottom
  // edge, exactly like the old `absolute inset-x-3 top-full` did.
  const [anchor, setAnchor] = useState<BoardAnchor | null>(null);
  const measureAnchor = useCallback(() => {
    const control = controlRef.current;
    if (!control) return;
    // Anchor to the header (the surfaces span its full width minus the
    // gutter); fall back to the control itself when the board is rendered
    // outside a header.
    const host = control.closest("header") as HTMLElement | null;
    const rect = (host ?? control).getBoundingClientRect();
    const viewport = window.innerWidth;
    const left = Math.max(BOARD_GUTTER, Math.round(rect.left + BOARD_GUTTER));
    let right = Math.round(viewport - rect.right + BOARD_GUTTER);
    // The header spans the viewport, so `right` lands on the gutter. A host
    // that does not (or a layout that has not happened yet) must not push
    // the surface off-screen — clamp it back to the gutter.
    if (!Number.isFinite(right) || right < BOARD_GUTTER || right > viewport - BOARD_GUTTER) {
      right = BOARD_GUTTER;
    }
    const bottom = Math.round(rect.bottom);
    setAnchor((prev) =>
      prev && prev.left === left && prev.right === right && prev.bottom === bottom
        ? prev
        : { left, right, bottom },
    );
  }, []);
  // Re-measure while a surface is on screen, and whenever the header moves
  // or resizes: the surfaces are fixed to the viewport now, so a stale
  // anchor would detach them from the header.
  useLayoutEffect(() => {
    if (!expanded && awaiting.length === 0) return;
    measureAnchor();
    const host = controlRef.current?.closest("header") as HTMLElement | null;
    window.addEventListener("resize", measureAnchor);
    let observer: ResizeObserver | undefined;
    if (host && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measureAnchor);
      observer.observe(host);
    }
    return () => {
      window.removeEventListener("resize", measureAnchor);
      observer?.disconnect();
    };
  }, [expanded, awaiting.length, measureAnchor]);
  // Inline style for a portaled surface. Until the first measurement the
  // surface is hidden (the layout effect above measures before the first
  // paint, so it never flashes at the wrong spot).
  const surfaceStyle = useCallback(
    (gap: number): CSSProperties | undefined =>
      anchor
        ? {
            left: `${anchor.left}px`,
            right: `${anchor.right}px`,
            top: `${anchor.bottom + gap}px`,
          }
        : undefined,
    [anchor],
  );
  // Worktree usage: how many children still hold a directory on disk, and how
  // many of those are finished (their directory can be reclaimed without
  // touching the branch). `repo` children never count — they share the main
  // workspace, which is not an isolation artifact.
  const worktreeSessions = useMemo(
    () => list.filter((s) => holdsWorktree(s.isolation)),
    [list],
  );
  const reclaimable = useMemo(
    () => worktreeSessions.filter((s) => isTerminalSuperStatus(s.status)),
    [worktreeSessions],
  );
  // 残留分支清单：已中断 / 放弃、分支还在但改动未落地的子会话。清单在
  // 「诊断」视图顶部给出一键「合并 / 丢弃」，让人不必逐行翻找。数据完全从
  // 现有 superSessions 派生，无需宿主新增推送消息。
  const residueSessions = useMemo(() => list.filter(isResidualSuperBranch), [list]);
  const [confirmResidueMerge, setConfirmResidueMerge] = useState<SuperSessionUi | null>(null);
  const [confirmResidueDiscard, setConfirmResidueDiscard] = useState<SuperSessionUi | null>(null);
  // Live-region text: announce CHANGES, not the whole board. On mount there
  // is nothing to announce (the rows are right there to be read), and a
  // change-only feed keeps the board's own text free of a second copy of
  // every title.
  const previousStatuses = useRef<Map<string, string>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const next = new Map<string, string>();
    const changed: string[] = [];
    for (const session of list) {
      const label = statusLabel(session);
      next.set(session.id, label);
      const before = previousStatuses.current.get(session.id);
      if (before !== undefined && before !== label) {
        changed.push(t("超流体 {0}：{1}", session.title, label));
      }
    }
    previousStatuses.current = next;
    if (changed.length > 0) setAnnouncement(changed.join("；"));
  }, [list]);

  useEffect(() => {
    if (active.length === 0) return;
    // Value comparison (same shape as `CountdownSeconds` in ui.tsx): the
    // board must only be woken when the rendered second actually moved.
    // The old code bumped a counter unconditionally, so every tick re-rendered
    // the whole board — every row, the live pane and the portaled panel —
    // even when the elapsed label it exists for had not changed.
    let last = Math.floor(Date.now() / 1000);
    const tick = () => {
      const second = Math.floor(Date.now() / 1000);
      if (second === last) return;
      last = second;
      setNow(second * 1000);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);

  // A child that needs an answer is the only state allowed to pull the board
  // open on its own. Keyed on the COUNT, not on `expanded` — collapsing it by
  // hand while that same question is still pending must stick.
  useEffect(() => {
    if (counts.awaiting === 0) return;
    setExpanded(true);
    setOpenRow(null);
  }, [counts.awaiting]);

  // Every child settled (merged, or nothing to merge) → nothing left to
  // manage (failed, cancelled and unmerged rows keep the board open). Fold
  // back to one line.
  const allSettled = visible.length === 0 && folded.length > 0;
  useEffect(() => {
    if (!allSettled) return;
    setExpanded(false);
    setOpenRow(null);
  }, [allSettled]);

  // Popup dismissal (the panel is a dropdown, not a persistent panel): Esc and
  // any click outside the control + panel fold it back to the header control.
  // Same document-level pattern as Dropdown. A modal that is already open
  // (confirm dialogs and the live-activity dialog portal to document.body)
  // owns the interaction — a click inside it must not collapse the board, and
  // its own Esc handler closes it first.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as Node;
      if (controlRef.current?.contains(target)) return;
      if (panelNodeRef.current?.contains(target)) return;
      setExpanded(false);
      setOpenRow(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      // Swallow it: the window-level shortcut would otherwise stop generation.
      e.stopPropagation();
      setExpanded(false);
      setOpenRow(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  // Detector stays mounted even when the board has nothing to show: the
  // 0→1 transition IS the real delegation signal, so it must observe the
  // empty roster first. Same element object in both branches → React keeps
  // the same child at index 0 and its "previous ids" ref survives.
  const delegationFly = (
    <SuperDelegationFly
      sessions={sessions}
      activeSessionId={activeSessionId}
      targetRef={controlRef}
      onArrive={onDelegationArrive}
    />
  );

  // Nothing to manage → the board stays out of the way, but the detector lives on.
  if (list.length === 0) return <>{delegationFly}</>;

  return (
    <>
      {delegationFly}
      {/* Collapsed form = ONE header control, at the header's own control
          height (28px) so it sits in the row without changing its rhythm.
          Counts are icon + number chips (the wording lives in the tooltip);
          at ≤380px the label collapses to the icon and the badge keeps only
          its shield, so the row can never wrap or push the header actions.
          Hover: the button paints the single hover surface (hover:bg-accent/40)
          — no nested DisclosureButton tint stacked on top of it. */}
      {/* Accessible name is STATIC ("超流体看板"): it names the control, while
          the open/closed state is already carried by aria-expanded. Baking the
          action into the name made a screen reader read 「展开子会话看板，已展开」
          — the name contradicted the state. The hover tooltip still spells out
          the action (title), and aria-controls points at the panel while it
          exists. */}
      <button
        type="button"
        ref={controlRef}
        aria-expanded={expanded}
        aria-controls={expanded ? SUPER_BOARD_PANEL_ID : undefined}
        aria-label={t("超流体看板")}
        title={expanded ? t("收起超流体看板") : t("展开超流体看板")}
        onClick={() => setExpanded((v) => !v)}
        className={`press relative isolate flex h-7 shrink-0 items-center gap-2.5 rounded-md border border-border/70 bg-surface/60 px-3 text-ui-label font-medium text-foreground transition-colors duration-200 hover:bg-accent/40${received ? " super-board-received" : ""}`}
      >
        {/* Running-child edge glow (Apple-Intelligence-like): a masked conic
            gradient flows around the control's border. Rendered ONLY while at
            least one child is non-terminal, so a settled board has no extra
            DOM layer and no animation at all. Pure decoration: aria-hidden and
            pointer-events-none in CSS, no text — the accessible name, hit area,
            focus ring and layout are untouched. */}
        {hasActiveChild && <span className="super-entry-glow" aria-hidden="true" />}
        {/* Two gap tiers, both from the kit's optical spacing set: 6px inside
            a cluster (icon ↔ label ↔ total read as one unit, and the
            per-state chips are one species) and 10px between clusters
            (control gap-2.5). The old single 6px gap made the label, the
            total and three chips read as one crowded block. */}
        <span className="flex shrink-0 items-center gap-1.5">
          <Users className={`${ICON_INLINE} shrink-0 text-muted-foreground`} aria-hidden="true" />
          <span className="shrink-0 @max-[380px]:hidden">{t("超流体")}</span>
          {/* Total count: the one count that survives at ≤380px, where the
              header also has to fit the status chip and the action cluster. The
              per-state chips collapse there (see below) and the panel — which
              auto-opens for a pending question — carries the detail. */}
          <span className="shrink-0 rounded-full bg-surface px-1.5 py-px text-ui-micro font-medium tabular-nums text-muted-foreground">
            {list.length}
          </span>
        </span>
        {(counts.running > 0 || counts.awaiting > 0 || counts.failed > 0) && (
          <span className="flex shrink-0 items-center gap-1.5">
            {/* At ≤380px the header row also holds the status chip and the
                action cluster: the running count is the only non-actionable
                one, so it yields there (the panel still lists every child). */}
            {counts.running > 0 && (
              <Chip
                tone="primary"
                title={t("{0} 个进行中", counts.running)}
                ariaLabel={t("{0} 个进行中", counts.running)}
                className="@max-[380px]:hidden"
              >
                <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
                <span className="tabular-nums">{counts.running}</span>
              </Chip>
            )}
            {/* The awaiting count NEVER hides, not even at ≤380px: it is the
                only on-screen evidence that a child is blocked on the user. The
                other per-state chips yield to the header's width budget; this
                one is a call to action, so it keeps its amber chip (icon +
                number) — a tooltip alone would hide the one thing the user must
                notice. */}
            {counts.awaiting > 0 && (
              <Chip
                tone="warning"
                title={t("{0} 个等你回答", counts.awaiting)}
                ariaLabel={t("{0} 个等你回答", counts.awaiting)}
              >
                <CircleHelp className="size-2.5" aria-hidden="true" />
                <span className="tabular-nums">{counts.awaiting}</span>
              </Chip>
            )}
            {counts.failed > 0 && (
              <Chip
                tone="danger"
                title={t("{0} 个失败", counts.failed)}
                ariaLabel={t("{0} 个失败", counts.failed)}
                className="@max-[380px]:hidden"
              >
                <X className="size-2.5" aria-hidden="true" />
                <span className="tabular-nums">{counts.failed}</span>
              </Chip>
            )}
          </span>
        )}
        {/* No-confirmation is a property of every child, not of one row —
            stated once here instead of a chip repeated on each card. It is
            NOT hover-only: a child's shell commands running without approval
            is the single most consequential fact about child sessions, so it
            stays on screen; at ≤380px the text collapses but the shield icon
            and its accessible name remain. */}
        <span
          role="img"
          aria-label={t("不弹审批")}
          title={t("超流体里的工具调用（包括运行命令）会直接执行，不会先征求你的同意")}
          className="flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-ui-micro font-medium text-warning"
        >
          <ShieldOff className="size-3 shrink-0" aria-hidden="true" />
          <span className="@max-[380px]:hidden">{t("不弹审批")}</span>
        </span>
        {expanded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
      </button>

      {/* Collapsed, a pending question STILL hangs under the header. Folding
          the panel must never hide the one thing that needs the user — the
          old floating board said so explicitly («唯一需要用户处理的东西，永远
          不被折叠掉»), and moving the board into the header must not silently
          drop that rule. Rendered ONLY while collapsed: the expanded panel
          already carries the same SuperPendingArea inside each row, and
          stacking both would show one question twice. */}
      {!expanded &&
        awaiting.length > 0 &&
        createPortal(
          <div
            // Same ref as the expanded panel: its height is mirrored into
            // --super-bar-h on the transcript wrapper, otherwise the transcript
            // top and the main-session pending card (both offset by that
            // variable) would paint over this strip — at 360px the question card
            // covered 76% of it and its 「提交回答」 button was unclickable.
            // The strip and the panel are mutually exclusive, so they never
            // overwrite each other's measurement.
            ref={setPanelNode}
            role="region"
            aria-label={t("超流体待答问题")}
            // 接管冻结：这条待答条 portal 在 body 末尾，不在 App 的 inert
            // 子树里 —— 不在这里加 inert，远端接管时本机仍能替子会话作答。
            inert={frozen || undefined}
            style={surfaceStyle(BOARD_STRIP_GAP)}
            className={`stream-in fixed z-35 max-h-[40vh] overflow-y-auto rounded-lg border border-border/70 acrylic-frosted px-1 py-1${anchor ? "" : " invisible"}${frozen ? " opacity-40" : ""}`}
          >
            {awaiting.map((session) => (
              <div key={session.id} className="shrink-0">
                {/* The panel row names the child; this strip has no row above
                    it, so it states which child is asking. */}
                <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1">
                  <CircleHelp className="size-3 shrink-0 text-warning" aria-hidden="true" />
                  <span
                    className="min-w-0 truncate text-ui-micro font-medium text-foreground"
                    title={session.title}
                  >
                    {session.title}
                  </span>
                  <QqTaskTags session={session} />
                </div>
                <SuperPendingArea session={session} />
              </div>
            ))}
          </div>,
          document.body,
        )}

      {/* Expanded form = a popup panel under the header. It is PORTALED to
          document.body (the same move ConfirmDialog makes) so it sits
          outside the acrylic header — and outside every backdrop root, which
          is what lets its own backdrop-filter frost the transcript behind it
          instead of letting the text read through sharp. Position: viewport
          coordinates measured from the header's rect (see the anchoring block
          above); the 12px gutter and the gap under the header are preserved.
          Material: .acrylic-frosted — the app's only true frosted surface. */}
      {expanded &&
        createPortal(
          <div
            id={SUPER_BOARD_PANEL_ID}
            ref={setPanelNode}
            role="region"
            aria-label={t("超流体")}
            // 接管冻结（同待答条）：浮层 portal 在 body 末尾，App 的 inert
            // 子树管不到它，必须在这里自己拦。
            inert={frozen || undefined}
            style={surfaceStyle(BOARD_PANEL_GAP)}
            className={`stream-in fixed z-35 overflow-hidden rounded-lg border border-border/70 acrylic-frosted${anchor ? "" : " invisible"}${frozen ? " opacity-40" : ""}`}
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <span className="flex min-w-0 items-center gap-1.5 text-ui-label font-medium text-foreground">
                <Users className={`${ICON_INLINE} shrink-0 text-muted-foreground`} aria-hidden="true" />
                <span className="truncate">{t("超流体")}</span>
              </span>
              {/* The board's ONE help bubble: every rule that used to be
                  spelled out under each row lives here now (what a child may
                  do, when merge / cleanup become available). The row's status
                  chip already says a child is still running — repeating the
                  reason in every expanded row was noise, and it made the
                  board unreadable at a glance. */}
              <HelpTip label={t("看板说明")}>
                <div className="flex flex-col gap-1">
                  <span>{t("超流体里的工具调用（包括运行命令）会直接执行，不会先征求你的同意")}</span>
                  <span>{t("超流体结束之后才能合并；已经合并过、或者没有改动可合并的超流体，不需要再合并")}</span>
                  <span>{t("超流体还在运行时不能清理，请先中断它")}</span>
                </div>
              </HelpTip>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {active.length > 0 && (
                  <Button
                    /* Batch interrupt kills every live child process. A neutral
                       canvas button understated that — it must wear danger,
                       same as the per-row interrupt icon and the red confirm. */
                    variant="danger"
                    size="sm"
                    icon={<Square className={ICON_INLINE} />}
                    aria-label={t("全部中断")}
                    title={t("全部中断")}
                    onClick={() => setConfirmCancelAll(active.length)}
                  >
                    {/* 这段文案在 portal 到 document.body 的面板里 —— 用视口
                        媒体查询而不是容器查询：portal 后没有 @container 祖先，
                        `@max-[380px]:hidden` 会恒不匹配，窄屏下文字永远不会收起、
                        继续挤压标题。图标（aria-label「全部中断」）始终保留。 */}
                    <span className="max-[380px]:hidden">{t("全部中断")}</span>
                  </Button>
                )}
              </div>
            </div>
            {/* 视图切换：页面级 tab（role=tablist + roving tabindex）。默认
                「子会话」= 旧平铺视图，旧数据行为完全不变。 */}
            <div
              role="tablist"
              aria-label={t("看板视图")}
              className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1"
            >
              {BOARD_VIEW_OPTIONS.map((option) => (
                <TabButton
                  key={option.value}
                  id={`super-board-view-${option.value}`}
                  active={boardView === option.value}
                  controls={SUPER_BOARD_VIEW_PANEL_ID}
                  onActivate={() => setBoardView(option.value)}
                  refCallback={(el) => {
                    boardViewRefs.current[option.value] = el;
                  }}
                  onKeyDown={onBoardViewKeyDown}
                >
                  {t(option.label)}
                </TabButton>
              ))}
            </div>
            {/* Body: same rows as before, just inside the popup. px-3 py-2 keeps
                the panel's breathing room (the row components add their own
                px-2/py-1.5 on top). */}
            <div
              id={SUPER_BOARD_VIEW_PANEL_ID}
              role="tabpanel"
              aria-label={t(
                BOARD_VIEW_OPTIONS.find((option) => option.value === boardView)?.label ??
                  "子会话",
              )}
              className="max-h-[40vh] divide-y divide-border/50 overflow-y-auto px-3 py-2"
            >
              {boardView === "waves" && (
                <div className="py-1">
                  <SuperBatchGroups groups={aggregate.groups} renderRow={renderRow} />
                </div>
              )}
              {boardView === "diagnostics" && (
                <div className="py-1">
                  <SuperResidueList
                    sessions={residueSessions}
                    now={now}
                    onMerge={setConfirmResidueMerge}
                    onDiscard={setConfirmResidueDiscard}
                  />
                  <SuperDiagnosticTimeline
                    entries={diagnosticTimeline}
                    summary={aggregate.diagnostics}
                  />
                </div>
              )}
              {boardView === "sessions" && (
                <>
                  {visible.map(renderRow)}
              {/* Settled children (already merged, or nothing to merge) collapse
                  into ONE history row: nothing left to act on — they only get
                  in the way of the live ones. The header splits the outcomes so
                  「无需合并」 is never shown as 「已合并」, and surfaces a
                  needsAction warning if the folding rule ever admits such a
                  child (today isSuperSessionSettled keeps it visible). */}
              {folded.length > 0 && (
                <div className="shrink-0">
                  <DisclosureButton
                    expanded={showFolded}
                    aria-label={showFolded ? t("收起已完成的超流体") : t("展开已完成的超流体")}
                    title={showFolded ? t("收起已完成的超流体") : t("展开已完成的超流体")}
                    className="w-full rounded-sm px-2 py-1.5"
                    onClick={() => setShowFolded((v) => !v)}
                  >
                    {showFolded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
                    <span className="shrink-0">
                      {foldedOutcomes.needsAttention > 0
                        ? t("已完成、需人工合并的 {0} 个超流体", folded.length)
                        : foldedOutcomes.nothingToMerge === 0
                          ? t("已完成并合并的 {0} 个超流体", folded.length)
                          : foldedOutcomes.merged === 0
                            ? t("已完成、无需合并的 {0} 个超流体", folded.length)
                            : t("已完成的 {0} 个超流体", folded.length)}
                    </span>
                    {foldedOutcomes.needsAttention > 0 && (
                      <Chip tone="warning">{t("{0} 个需人工合并", foldedOutcomes.needsAttention)}</Chip>
                    )}
                    {foldedOutcomes.merged > 0 && <Chip tone="success">{t("已自动合并")}</Chip>}
                    {foldedOutcomes.nothingToMerge > 0 && <Chip tone="muted">{t("无需合并")}</Chip>}
                  </DisclosureButton>
                  {showFolded && (
                    <div className="divide-y divide-border/40 border-t border-border/40">
                      {folded.map(renderRow)}
                    </div>
                  )}
                </div>
              )}
              {(totals.input > 0 || totals.output > 0) && (
                <div
                  className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-ui-micro text-muted-foreground"
                  title={t("按公开单价估算，仅供参考")}
                >
                  <span className="font-medium text-foreground">{t("超流体合计开销")}</span>
                  <span className="tabular-nums">
                    {t("输入 {0} · 输出 {1}", formatTokens(totals.input), formatTokens(totals.output))}
                  </span>
                  {totals.estimatedCost !== null && (
                    <span className="tabular-nums">{formatCostPrecise(totals.estimatedCost)}</span>
                  )}
                </div>
              )}
              {/* Worktree footprint: the board is the only place that shows how
                  much disk the children are holding. The bulk action is offered
                  only for FINISHED children — a live child's directory must not
                  be deleted under a running process (the row action says the same). */}
              {worktreeSessions.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-ui-micro text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t("工作目录 {0} 个", worktreeSessions.length)}
                  </span>
                  <span className="tabular-nums">
                    {t("已结束 {0} 个可清理", reclaimable.length)}
                  </span>
                  {reclaimable.length > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Trash2 className={ICON_INLINE} />}
                      onClick={() => setConfirmCleanupAll(reclaimable)}
                    >
                      {t("清理已结束")}
                    </Button>
                  )}
                </div>
              )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Status changes are announced, not just re-drawn: a child that turns
          「等待你处理」 must reach a screen reader without the user hunting
          for the board. Only CHANGES are announced (see above) — opening the
          panel does not read the whole column out loud. The region stays
          mounted while collapsed, so a change is announced without expanding. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {confirmMerge && (
        <ConfirmDialog
          title={t("合并超流体分支")}
          message={t(
            "让智能体把分支 {0} 合并到当前分支？它会自己完成合并并处理冲突，你当前的工作分支会被改动。",
            confirmMerge.isolation.branch ?? "",
          )}
          /* Merging is a forward-progress action, not a destructive delete.
             ConfirmDialog's default single confirm button is destructive red —
             the same as interrupt / cleanup — which reads as “this will destroy
             something”. Use the primary variant instead so the three actions
             carry three different meanings. */
          actions={[
            {
              label: t("让智能体合并分支"),
              variant: "primary",
              onClick: () => {
                beginMerge(confirmMerge.id, confirmMerge.integration?.at);
                send({ type: "superAgent", action: "merge", sessionId: confirmMerge.id });
                setConfirmMerge(null);
              },
            },
          ]}
          onCancel={() => setConfirmMerge(null)}
        />
      )}
      {confirmCancel && (
        <ConfirmDialog
          title={t("中断超流体")}
          message={t(
            "中断超流体「{0}」？它会立即停止，这次的改动不会被提交或合并；工作目录里已有的内容会保留，之后可以重试。",
            confirmCancel.title,
          )}
          confirmLabel={t("中断")}
          onConfirm={() => {
            // 乐观反馈：点确认即标记该行「中断中」，不等 host 异步回包。
            markCancelPending([confirmCancel]);
            send({ type: "superAgent", action: "cancel", sessionId: confirmCancel.id });
            setConfirmCancel(null);
          }}
          onCancel={() => setConfirmCancel(null)}
        />
      )}
      {confirmStuck && (
        <ConfirmDialog
          title={t("判定卡死")}
          message={t(
            "判定「{0}」卡死？这会先记一条「用户判定超时」诊断，再像中断一样停止它；本次改动不会提交或合并，工作目录里已有的内容会保留，之后可以重试。",
            confirmStuck.title,
          )}
          confirmLabel={t("判定卡死并中断")}
          onConfirm={() => {
            markCancelPending([confirmStuck]);
            send({ type: "superAgent", action: "stuck", sessionId: confirmStuck.id });
            setConfirmStuck(null);
          }}
          onCancel={() => setConfirmStuck(null)}
        />
      )}
      {confirmCancelAll !== null && (
        <ConfirmDialog
          title={t("全部中断")}
          message={t(
            "中断全部 {0} 个进行中的超流体？它们会立即停止，这次的改动不会被提交或合并；工作目录里已有的内容会保留，之后可以重试。",
            confirmCancelAll,
          )}
          confirmLabel={t("全部中断")}
          onConfirm={() => {
            // 同样乐观标记全部活跃行，避免批量中断时整屏仍停在「运行中」。
            markCancelPending(active);
            send({ type: "superAgent", action: "cancelAll" });
            setConfirmCancelAll(null);
          }}
          onCancel={() => setConfirmCancelAll(null)}
        />
      )}
      {confirmCleanup && (
        <ConfirmDialog
          title={t("清理超流体")}
          message={cleanupConfirmMessage(confirmCleanup)}
          confirmLabel={t("清理")}
          onConfirm={() => {
            send({ type: "superAgent", action: "cleanup", sessionId: confirmCleanup.id });
            // Optimistic feedback: the host cleanup is async, so mark the row
            // busy at click time instead of leaving it looking unresponsive.
            beginCleanup([confirmCleanup.id]);
            setConfirmCleanup(null);
          }}
          onCancel={() => setConfirmCleanup(null)}
        />
      )}
      {confirmCleanupAll !== null && (
        <ConfirmDialog
          title={t("清理已结束的超流体")}
          message={bulkCleanupConfirmMessage(confirmCleanupAll)}
          confirmLabel={t("清理已结束")}
          onConfirm={() => {
            // One batched request: the host cleans the whole set serially and
            // reports a single aggregate receipt. Sending one `cleanup` per
            // child made the transcript collect N identical toasts and left
            // the user unable to tell where the batch as a whole stood.
            const ids = confirmCleanupAll.map((session) => session.id);
            send({
              type: "superAgent",
              action: "cleanupBatch",
              sessionIds: ids,
            });
            // Mark every child busy at click time so each row shows its own
            // in-progress state while the host cleans them up asynchronously.
            beginCleanup(ids);
            setConfirmCleanupAll(null);
          }}
          onCancel={() => setConfirmCleanupAll(null)}
        />
      )}
      {/* 残留分支的一键处置：合并 / 丢弃都先二次确认。合并是推进（primary），
          丢弃是破坏性清理（danger）。二者复用宿主既有的 superAgent 通道。 */}
      {confirmResidueMerge && (
        <ConfirmDialog
          title={t("合并残留分支")}
          message={t(
            "让智能体把残留分支 {0} 合并到当前分支？它会自己完成合并并处理冲突，你当前的工作分支会被改动。",
            confirmResidueMerge.isolation.branch ?? confirmResidueMerge.title,
          )}
          actions={[
            {
              label: t("让智能体合并分支"),
              variant: "primary",
              onClick: () => {
                beginMerge(confirmResidueMerge.id, confirmResidueMerge.integration?.at);
                send({ type: "superAgent", action: "merge", sessionId: confirmResidueMerge.id });
                setConfirmResidueMerge(null);
              },
            },
          ]}
          onCancel={() => setConfirmResidueMerge(null)}
        />
      )}
      {confirmResidueDiscard && (
        <ConfirmDialog
          title={t("丢弃残留分支")}
          message={t(
            "丢弃「{0}」的残留分支 {1}？工作目录会被删除；若分支上还有未合并的提交，git 分支会被保留以便事后审查。此操作不可撤销。",
            confirmResidueDiscard.title,
            confirmResidueDiscard.isolation.branch ?? "",
          )}
          confirmLabel={t("丢弃")}
          onConfirm={() => {
            // 单分支丢弃没有独立的「确认令牌」消息：ConfirmDialog 本身就是
            // 二次确认，回包走既有的 superAgent/cleanup（keepBranch 缺省，
            // 由宿主按「有未合并提交则保留分支」的规则处理）。
            send({ type: "superAgent", action: "cleanup", sessionId: confirmResidueDiscard.id });
            beginCleanup([confirmResidueDiscard.id]);
            setConfirmResidueDiscard(null);
          }}
          onCancel={() => setConfirmResidueDiscard(null)}
        />
      )}
    </>
  );
}

/** 卡片短描述的单行上限（含省略号）。看板行只有几十像素高，绝不铺开长文本。 */
const CARD_DESCRIPTION_MAX = 96;

/**
 * 子会话卡片上的短任务描述。
 *
 * 用户要的是「委派时那种一句话短描述」，而不是实时 agent 输出的长文本。
 * 委派记录里 `task` 是完整任务书（可能是文字墙），`title` 是它的一句话概括；
 * 任务书的首句有效正文正是委派时写下的短描述。取它、单行截断，避免在卡片上
 * 铺开 `progress`（助手输出尾快照）那种几十行日志。完整实时进度仍可从行内
 * 「查看实时进度」按钮打开独立弹窗查看。
 */
export function shortSuperSessionDescription(session: SuperSessionUi): string {
  const lines = (session.task ?? "").replace(/\r\n?/g, "\n").split("\n");
  const first = lines
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^(#{1,6}\s|【[^】]+】$)/.test(line));
  const text = first || session.title || "";
  return text.length > CARD_DESCRIPTION_MAX ? `${text.slice(0, CARD_DESCRIPTION_MAX - 1)}…` : text;
}

/**
 * 折叠行上的「最近活动」小标签。
 *
 * 用图标 + 文案双重编码（形状 + 文字），颜色只是冗余；静默超时转警示色。
 * `now` 从看板每秒节流传入，组件本身不含定时器。
 */
function RecentActivity({ session, now }: { session: SuperBoardSession; now: number }) {
  const { text, elapsed, silent } = recentActivityText(session, now);
  const excerpt = recentActivityExcerpt(session);
  const title = silent
    ? excerpt
      ? t("已静默 {0}，可能卡住，可随时中断（最近：{1}）", elapsed, excerpt)
      : t("已静默 {0}，可能卡住，可随时中断", elapsed)
    : excerpt
      ? t("距最近一次诊断或进度更新的时间（最近：{0}）", excerpt)
      : t("距最近一次诊断或进度更新的时间");
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-ui-micro tabular-nums max-[380px]:hidden ${silent ? "text-warning" : "text-muted-foreground"}`}
      title={title}
      data-super-recent-activity={session.id}
    >
      <Activity className={ICON_INLINE} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

/**
 * 诊断视图顶部的「残留分支」清单。
 *
 * 列出已中断 / 放弃、分支还在但改动未落地的子会话，每条给「合并 / 丢弃」
 * 两个动作。合并走宿主既有的 superAgent/merge（派合并子会话），丢弃走
 * superAgent/cleanup（删工作目录、保留有未合并提交的分支）——二者都在下面
 * 经 ConfirmDialog 二次确认后才发送。空列表不渲染，不给看板添噪音。
 *
 * 注明：新协议 superResidueList / requestSuperResidueList / superResidueHandle
 * 三层齐备但当前 webview 不消费，是为批量令牌化场景保留的；这里仍走 superAgent
 * 的 cleanup / merge 旧协议，两套并存、功能等价，勿因「没用到」就删除其一。
 */
function SuperResidueList({
  sessions,
  now,
  onMerge,
  onDiscard,
}: {
  sessions: readonly SuperBoardSession[];
  now: number;
  onMerge: (session: SuperBoardSession) => void;
  onDiscard: (session: SuperBoardSession) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="mb-2 rounded-sm border border-warning/30 bg-warning/5" aria-label={t("残留分支清单")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/20 px-2 py-1.5">
        <GitBranch className={`${ICON_INLINE} text-warning`} aria-hidden="true" />
        <span className="text-ui-label font-medium text-foreground">
          {t("残留分支清单")}
        </span>
        <Chip tone="warning" title={t("{0} 个待处置分支", sessions.length)}>
          {t("{0} 个待处置", sessions.length)}
        </Chip>
        <span className="text-ui-micro text-muted-foreground">
          {t("这些分支来自已中断或放弃的超流体，改动尚未并入当前分支")}
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {sessions.map((session) => {
          const activity = recentActivityText(session, now);
          const issue = collapsedIntegrationIssue(session);
          return (
            <li key={session.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-label font-medium text-foreground" title={session.title}>
                  {session.title}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-micro text-muted-foreground">
                  {session.isolation.branch && (
                    <span className="inline-flex items-center gap-1 font-mono" title={session.isolation.branch}>
                      <GitBranch className={ICON_INLINE} aria-hidden="true" />
                      {shortBranch(session.isolation.branch)}
                    </span>
                  )}
                  <span data-super-residue-activity={session.id}>{activity.text}</span>
                  {issue && <span className={issue.tone === "danger" ? "text-destructive" : "text-warning"}>{issue.label}</span>}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                icon={<GitMerge className={ICON_INLINE} />}
                aria-label={t("合并残留分支 {0}", session.title)}
                onClick={() => onMerge(session)}
              >
                {t("合并")}
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                icon={<Trash2 className={ICON_INLINE} />}
                aria-label={t("丢弃残留分支 {0}", session.title)}
                onClick={() => onDiscard(session)}
              >
                {t("丢弃")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One child session row.
 *
 * Collapsed it is a single 32px line — status (icon + label + colour), title,
 * elapsed — and nothing else. The stage rail appears only after expanding,
 * exactly once; the expanded detail does not repeat the status chip the line
 * already shows. Everything diagnostic (branch, summary, tokens, merge
 * result) and every action live in the detail below, opened by clicking
 * the row. Only one row is open at a time, so the board cannot turn into a
 * stack of cards again.
 *
 * A pending question is the exception: it stays rendered under the line even
 * when collapsed, because it is the only state that truly needs a human.
 */
function SuperSessionRow({
  session,
  now,
  open,
  cleanupPending,
  mergePending,
  retryPending,
  cancelPending,
  onToggle,
  onMerge,
  onRetry,
  onCleanup,
  onCancel,
  onStuck,
}: {
  /**
   * 看板行视图模型：`SuperSessionUi` 加上全部**可选**的波次 / 尝试 / 诊断
   * 扩展字段（见 shared/super-board.ts）。旧数据缺这些字段时照常渲染。
   */
  session: SuperBoardSession;
  /** Wall-clock instant the elapsed label is rendered against — the board's
   * ticking state (it only advances when the rendered second changes). */
  now: number;
  open: boolean;
  /** True while the host asynchronously cleans up this child's worktree. */
  cleanupPending: boolean;
  /** True from the merge confirm click until the host records the result. */
  mergePending: boolean;
  /** True from the retry click until the host accepts it (status/attempt). */
  retryPending: boolean;
  /** True from the cancel confirm click until the host flips the row terminal. */
  cancelPending: boolean;
  onToggle: () => void;
  onMerge: () => void;
  onRetry: () => void;
  onCleanup: () => void;
  onCancel: () => void;
  onStuck: () => void;
}) {
  const [showLive, setShowLive] = useState(false);
  // 单行诊断：点开只看这个子会话自己的诊断事件（跨子会话时间线在「诊断」视图）。
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const sessionDiagnostics = useMemo(
    () => collectSuperSessionDiagnostics(session),
    [session],
  );
  const sessionDiagnosticSummary = useMemo(
    () => summarizeSuperBoardDiagnostics([session]),
    [session],
  );
  // 波次标记只在真的带 wave 时显示：0 或缺省 = 旧数据，不印「第 0 波」。
  const wave =
    typeof session.wave === "number" && session.wave > 0 ? Math.trunc(session.wave) : null;
  // 尝试次数只在真的重试过、或声明了上限时显示 —— 否则每行都挂「尝试 1/1」是噪音。
  const attempts = session.attempts ?? 1;
  const maxAttempts = session.maxAttempts;
  const attemptChip =
    attempts > 1 || (maxAttempts !== undefined && maxAttempts > 1)
      ? { attempts, maxAttempts }
      : null;
  // 失败分类：与状态文案重复的分类不再挂 chip（cancelled 已写「已中断」、
  // awaiting_input 已写「等你回答」），避免同一事实在一条 32px 行里说两遍。
  const failureKind = superBoardFailureKind(session);
  const failureChip =
    failureKind === null ||
    (failureKind === "interrupted" && session.status === "cancelled") ||
    (failureKind === "blocked" && session.status === "awaiting_input")
      ? null
      : failureKind;
  // pr_created 行的「打开 PR」按钮走宿主 openExternal（只放行 http(s)）。
  const send = useChat((s) => s.send);
  // Busy states take the chip over: each one is a request the user just made
  // and is waiting on, so it must outrank the stale status it is replacing
  // (a merge target is `completed` — without this it would still read
  // 「已完成」 while the merge child runs). Merge outranks retry only because
  // the two cannot coexist on one row in practice.
  // The TONE follows the action's meaning, not a single blue for all: interrupt
  // and cleanup destroy work (danger — same as the row's interrupt IconButton
  // and the red confirm dialog), while merge and retry push forward (primary).
  // A blue 「中断中」 reads as “doing useful work” right as a process is killed.
  const busy = cancelPending
    ? { tone: "danger" as StatusTone, label: t("中断中") }
    : cleanupPending
      ? { tone: "danger" as StatusTone, label: t("清理中") }
      : mergePending
        ? { tone: "primary" as StatusTone, label: t("合并中") }
        : retryPending
          ? { tone: "primary" as StatusTone, label: t("重试中") }
          : null;
  const chip = busy
    ? {
        tone: busy.tone,
        label: busy.label,
        icon: <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />,
      }
    : statusVisual(session);
  const interruptSourceLabel = interruptedByLabel(session);
  const description = shortSuperSessionDescription(session);
  // A restored child ran in a PREVIOUS extension lifetime: its CLI process
  // is gone, so there is no live transcript to show and nothing to retry.
  // What survives is the record — the branch and its worktree — so the merge
  // and cleanup actions stay available.
  const historical = session.restored === true;
  // F1 落盘 + 恢复时会把历史子会话的转录按 from:0 推进 superTranscripts（以
  // session.id 为 key）。历史会话没有活进程可拉全量，但只要有这份已保存的
  // 快照就能打开详情查看；无快照时仍不给一个点了没内容的按钮。
  const hasTranscript = (useChat((s) => s.superTranscripts?.[session.id])?.length ?? 0) > 0;
  // 折叠行只报状态时也要能看出「改动没落地」：终态且集成有问题的行给一个小
  // chip（需人工合并 / 冲突 / 未自动合并），完整说明仍只在展开详情里。
  const integrationIssue = collapsedIntegrationIssue(session);
  // Why the merge action is unavailable right now. The RULE is stated once,
  // in the board header's help bubble; this string only feeds the button's
  // title / aria-label, so a greyed-out button still says why it is greyed
  // out for a screen reader and on hover.
  const integrationState = session.integration?.state;
  const mergeBlocked =
    !session.isolation.branch ||
    integrationState === "merged" ||
    integrationState === "not_needed" ||
    integrationState === "pr_created" ||
    isActive(session);
  const mergeReason =
    integrationState === "merged"
      ? t("这个超流体的改动已经合并")
      : integrationState === "not_needed"
        ? t("这个超流体没有产生改动，不需要合并")
        : integrationState === "pr_created"
          ? t("改动已经提到 PR，请打开 PR 处理合并")
          : !session.isolation.branch
            ? t("这个超流体没有可合并的分支")
            : isActive(session)
              ? t("超流体还没结束，等它完成再合并")
              : t("让一个超流体把这条分支合并到当前分支，冲突由它自己解决");
  // Cleanup deletes the worktree, so it must not race a live child: the
  // process would keep writing into a directory that no longer exists.
  // Same discipline as the merge action — the rule lives in the board
  // header's help bubble, and the button keeps it in title / aria-label.
  const cleanupBlocked = isActive(session);
  const cleanupReason = t("超流体还在运行，请先中断再清理");
  // Diagnostics — full branch ref, worktree path, retry count, restored
  // marker — ride the title tooltip instead of occupying their own lines.
  const titleHint = [
    session.title,
    // 已释放要区分两档：合并成功=目录与分支都没了；终态回收=目录删了但分支还在
    // （未合并的提交留在分支上待审）。说成「都已清理」会让人以为提交也没了。
    session.isolation.released
      ? releasedIsolationLabel(session.isolation)
      : session.isolation.branch
        ? t("分支 {0}", session.isolation.branch)
        : null,
    // Placeholder isolation (queued / preparing) has an empty `path`: joining
    // it would produce a dangling 「目录 」 that reads as lost information.
    // Say what the host actually said instead — same wording as the detail row.
    session.isolation.released
      ? null
      : session.isolation.path
        ? t("目录 {0}", session.isolation.path)
        : (session.isolation.note ?? null),
    (session.attempts ?? 1) > 1 ? t("第 {0} 次尝试", session.attempts ?? 1) : null,
    historical ? t("这次超流体在上一次运行里就已经结束（扩展重启后恢复的历史记录）") : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="shrink-0">
      {/* The row itself: one line, status first so a long title ellipsizes
          instead of shoving the duration and chevron off the row. */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-accent/30">
        {/* The row trigger carries the status triple encoding (icon shape +
            label + colour) so a collapsed row is readable without hovering
            and without relying on hue alone. */}
        <DisclosureButton
          expanded={open}
          onClick={onToggle}
          hoverSurface="row"
          className="min-w-0 flex-1 gap-2"
        >
          <span className={`flex shrink-0 items-center gap-1 ${STATUS_TEXT[chip.tone]}`}>
            {chip.icon}
            <span className="text-ui-micro font-medium">{chip.label}</span>
          </span>
          {/* 历史恢复记录（进程已随上次扩展退出）：原先「上次运行」只在展开
              详情里，折叠时看不出这条是旧记录。状态后补一个静音 chip，窄屏可
              收缩隐藏，不挤压标题。详见下方工具提示。 */}
          {historical && (
            <Chip tone="muted" className="shrink-0 max-[380px]:hidden">
              {t("上次运行")}
            </Chip>
          )}
          <span className="min-w-0 flex-1 truncate text-ui-label font-medium" title={titleHint}>
            {session.title}
          </span>
          {/* 波次标记：只在真实带 wave 时出现，旧数据不占位。 */}
          {wave !== null && (
            <Chip tone="info" className="shrink-0 max-[380px]:hidden" title={t("第 {0} 波", wave)}>
              {t("第 {0} 波", wave)}
            </Chip>
          )}
          {/* 尝试次数：重试过才显示，上限存在时一并给出「尝试 2/3」。 */}
          {attemptChip && (
            <Chip
              tone="muted"
              className="shrink-0 max-[380px]:hidden"
              title={
                attemptChip.maxAttempts !== undefined
                  ? t("已尝试 {0} 次，最多 {1} 次", attemptChip.attempts, attemptChip.maxAttempts)
                  : t("已尝试 {0} 次", attemptChip.attempts)
              }
            >
              {attemptChip.maxAttempts !== undefined
                ? t("尝试 {0}/{1}", attemptChip.attempts, attemptChip.maxAttempts)
                : t("尝试 {0}", attemptChip.attempts)}
            </Chip>
          )}
          {/* 失败分类：retryable / terminal / blocked / interrupted → 中文文案。 */}
          {failureChip && (
            <Chip
              tone={FAILURE_TONE[failureChip]}
              className="shrink-0 max-[380px]:hidden"
              title={t("失败分类：{0}", failureKindLabel(failureChip))}
            >
              {failureKindLabel(failureChip)}
            </Chip>
          )}
          {/* 终态但改动没落地的行，折叠态就给出提示 —— 完整说明仍在展开详情。 */}
          {integrationIssue && (
            <Chip tone={integrationIssue.tone} className="shrink-0 max-[380px]:hidden">
              {integrationIssue.label}
            </Chip>
          )}
          {interruptSourceLabel && (
            <span className="shrink-0 text-ui-micro text-muted-foreground">
              {interruptSourceLabel}
            </span>
          )}
          <QqTaskTags session={session} />
          {/* 最近活动：活跃会话显示距上一次状态推进的相对时间。静默超过
              阈值转警示色 —— 慢任务卡住时能提前手动中断，不必干等看门狗。 */}
          {!isTerminalSuperStatus(session.status) && (
            <RecentActivity session={session} now={now} />
          )}
          <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground" title={t("已运行时长")}>
            {elapsedText(session, now)}
          </span>
          <ChevronDown
            className={`${ICON_INLINE} shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </DisclosureButton>
        {/* Stopping a live child is the one action that must not hide behind
            the detail: the process keeps writing files meanwhile. */}
        {isActive(session) && (
          <>
            <IconButton
              icon={
                cancelPending ? (
                  <Loader2 className={`${ICON_INLINE} animate-spin`} aria-hidden="true" />
                ) : (
                  <Square className={ICON_INLINE} />
                )
              }
              label={cancelPending ? t("中断中") : t("中断这个超流体")}
              size="sm"
              tone="danger"
              hoverSurface="row"
              disabled={cancelPending}
              onClick={onCancel}
            />
            {/* 判定卡死：与「中断」不同，它先如实记一条用户判定的 timeout
                诊断再按 user 来源中断，方便事后区分「看门狗判死」与「人判死」。
                同样先二次确认，避免误触杀掉正在跑的子会话。 */}
            <IconButton
              icon={<Activity className={ICON_INLINE} />}
              label={t("判定卡死")}
              size="sm"
              hoverSurface="row"
              disabled={cancelPending}
              onClick={onStuck}
            />
          </>
        )}
      </div>

      {/* The only thing that needs the user, so it is never folded away. */}
      {session.pending && <SuperPendingArea session={session} />}

      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2 pt-0.5">
          {/* 阶段轨只在展开后出现一次：折叠行只报状态，展开区不再重复状态 chip。 */}
          <SuperTimeline session={session} labeled />

          <SuperTaskDescription task={session.task} short={description} />

          {session.error && (
            <div className="break-words rounded-sm border border-destructive/30 bg-destructive/10 px-2 py-1 text-ui-caption text-destructive">
              {session.error}
            </div>
          )}

          {/* statusDetail：宿主给的一句话状态说明（缺省不渲染）。 */}
          {session.statusDetail && (
            <div className="flex items-start gap-1.5 text-ui-micro text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{session.statusDetail}</span>
            </div>
          )}

          {/* lastError：分类 chip + 原文消息。消息是子会话/宿主产出的原文，
              绝不过 t() 字典；分类 chip 复用上面的失败分类映射。 */}
          {session.lastError && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-micro">
              {failureKind && (
                <Chip tone={FAILURE_TONE[failureKind]} className="shrink-0">
                  {failureKindLabel(failureKind)}
                </Chip>
              )}
              <span
                className="min-w-0 flex-1 break-words text-muted-foreground"
                title={session.lastError.message}
              >
                {session.lastError.message}
              </span>
            </div>
          )}

          {/* Isolation: full ref + worktree path, mono and selectable. */}
          <div className="flex min-w-0 items-center gap-1.5 text-ui-micro text-muted-foreground">
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            {session.isolation.released ? (
              <span className="min-w-0 flex-1 truncate">
                {releasedIsolationLabel(session.isolation)}
              </span>
            ) : session.isolation.branch || session.isolation.path ? (
              <span className="min-w-0 flex-1 truncate font-mono" title={`${session.isolation.branch ?? ""}\n${session.isolation.path}`}>
                {session.isolation.branch ?? session.isolation.path}
              </span>
            ) : (
              // Placeholder isolation: the host has not created the worktree
              // yet (queued / preparing), so `path` is "" and only `note`
              // says anything. Rendering the empty string made the row look
              // like the isolation info was lost.
              <span className="min-w-0 flex-1 truncate" title={session.isolation.note}>
                {session.isolation.note}
              </span>
            )}
            {/* A `directory` isolation with an EMPTY path is the placeholder,
                not a degradation: the row's status chip already says
                「排队中」/「准备中」, and a warning chip here reads as
                "worktree creation failed" (a real misreading happened). Only
                an actual fallback directory earns the chip. */}
            {session.isolation.kind === "directory" && session.isolation.path !== "" && (
              <Chip tone="warning" title={session.isolation.note}>
                {t("只隔离了目录")}
              </Chip>
            )}
            {/* A merge child runs in the MAIN workspace: no worktree, no
                branch of its own — say so instead of showing a branch that
                does not exist. */}
            {session.isolation.kind === "repo" && (
              <Chip tone="info">{superIsolationLabel(session.isolation)}</Chip>
            )}
          </div>

          {session.integration && (
            <div className="flex min-w-0 items-center gap-1.5 text-ui-caption">
              <span className={`shrink-0 font-medium ${INTEGRATION_TEXT[session.integration.state]}`}>
                {t(superIntegrationLabel(session.integration))}
              </span>
              {/* needsAction is the single most consequential fact on this row:
                  a skipped child with needsAction=true must be merged by hand,
                  while one with false (e.g. interrupted) needs nothing. The
                  shared `superIntegrationLabel` says 「未自动合并」 for both, so
                  a separate warning chip is the only way to tell them apart. */}
              {session.integration.needsAction === true && (
                <Chip tone="warning" className="shrink-0">{t("需人工合并")}</Chip>
              )}
              {session.integration.url ? (
                <span className="min-w-0 truncate font-mono text-muted-foreground" title={session.integration.url}>
                  · {session.integration.url}
                </span>
              ) : (
                session.integration.detail && (
                  <span className="min-w-0 truncate text-muted-foreground" title={session.integration.detail}>
                    · {session.integration.detail}
                  </span>
                )
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-micro text-muted-foreground">
            {session.tokens && (
              <span
                className="font-mono tabular-nums"
                title={t("输入是上一次请求实际携带的上下文；输出按超流体的文字估算")}
              >
                ↑{formatTokens(session.tokens.input)} ↓{formatTokens(session.tokens.output)}
                {session.tokens.estimatedCost !== null && session.tokens.estimatedCost !== undefined && (
                  <span title={t("预估费用：token 估算 × 公开单价，仅供参考")}>
                    {" "}{formatCost(session.tokens.estimatedCost)}
                  </span>
                )}
              </span>
            )}
            {/* 「上次运行」已上移到折叠行状态后的静音 chip（展开态也会渲染那一行），
                这里不再重复，避免展开后读两遍。完整历史说明仍在 titleHint。 */}
            {(session.attempts ?? 1) > 1 && <span>{t("第 {0} 次尝试", session.attempts ?? 1)}</span>}
          </div>

          {/* No visible reason line under the buttons any more: the board
              header's help bubble states the merge / cleanup rules once, and
              the row's status chip already says the child is still running.
              The greyed-out buttons keep their full reason in title /
              aria-label. */}
          <div className="flex flex-wrap items-center gap-1">
            {/* 单行诊断入口：只有真的有诊断事件才出现，点开就地展开该子会话
                的时间线（不另开 portal，自然跟随看板的 openRow 单选与 inert）。 */}
            {sessionDiagnostics.length > 0 && (
              <Button
                variant="canvas"
                size="sm"
                icon={<Bug className={ICON_INLINE} />}
                aria-label={
                  showDiagnostics
                    ? t("收起诊断")
                    : t("查看诊断（{0} 条）", sessionDiagnostics.length)
                }
                title={
                  showDiagnostics
                    ? t("收起诊断")
                    : t("查看诊断（{0} 条）", sessionDiagnostics.length)
                }
                onClick={() => setShowDiagnostics((v) => !v)}
              >
                {showDiagnostics
                  ? t("收起诊断")
                  : t("查看诊断（{0} 条）", sessionDiagnostics.length)}
              </Button>
            )}
            {/* A restored child's CLI process is gone, so there is no LIVE
                transcript and no retry — but F1 persists its transcript on
                completion and the host re-pushes it on restore, so a saved
                snapshot can still be opened (labelled as history, not
                realtime). With no snapshot there is nothing to show and no
                process to fetch from, so the entry stays hidden. A live child
                always offers the entry and asks the host on first open. */}
            {(!historical || hasTranscript) && (
              <Button
                variant="canvas"
                size="sm"
                icon={<Activity className={ICON_INLINE} />}
                onClick={() => setShowLive(true)}
              >
                {historical ? t("查看已保存的转录") : t("查看实时进度")}
              </Button>
            )}
            {!historical && canRetrySuperSession(session) && (
              <Button
                variant="canvas"
                size="sm"
                icon={
                  retryPending ? (
                    <Loader2 className={`${ICON_INLINE} animate-spin`} />
                  ) : (
                    <RotateCcw className={ICON_INLINE} />
                  )
                }
                /* Click → host round-trip is usually sub-second but not
                   instant; the busy state blocks a double click and tells the
                   user the request went out. Same `aria-disabled` discipline
                   as merge / cleanup (keeps title + aria-label readable). */
                aria-disabled={retryPending || undefined}
                aria-label={retryPending ? t("重试中") : t("重试这个超流体：沿用原来的工作目录、不产生新提交，但会清空上一次的集成结果并重跑整个任务（再次消耗 token）")}
                title={retryPending ? t("重试中") : t("重试这个超流体：沿用原来的工作目录、不产生新提交，但会清空上一次的集成结果并重跑整个任务（再次消耗 token）")}
                className={retryPending ? "cursor-not-allowed opacity-40" : undefined}
                onClick={() => {
                  if (retryPending) return;
                  onRetry();
                }}
              >
                {retryPending ? t("重试中") : t("重试")}
              </Button>
            )}
            <Button
              variant="canvas"
              size="sm"
              icon={
                mergePending ? (
                  <Loader2 className={`${ICON_INLINE} animate-spin`} />
                ) : (
                  <GitMerge className={ICON_INLINE} />
                )
              }
              /* `aria-disabled` instead of `disabled`: the kit's disabled
                 style kills pointer events, so the `title` (where the
                 reason now lives) could never be read. aria-disabled keeps
                 the button focusable and its title/aria-label readable; the
                 rule itself is stated once in the board header's help
                 bubble. While merging, the button reports the in-flight
                 state instead of a reason — a second click must not look
                 available (the host would only answer with a warning). */
              aria-disabled={mergeBlocked || mergePending || undefined}
              aria-label={mergePending ? t("合并中") : mergeBlocked ? mergeReason : t("让智能体合并")}
              title={mergePending ? t("合并中") : mergeReason}
              className={
                mergeBlocked || mergePending ? "cursor-not-allowed opacity-40" : undefined
              }
              onClick={() => {
                if (mergeBlocked || mergePending) return;
                onMerge();
              }}
            >
              {mergePending ? t("合并中") : t("让智能体合并")}
            </Button>
            {/* pr_created 的合并按钮已禁用（见 mergeBlocked），改动在 PR 里，
                真正的下一步是打开 PR 处理 —— 给一个直达链接，而不是让用户面对
                一个灰按钮无从下手。URL 只在宿主写入时才有，缺失就不渲染。 */}
            {integrationState === "pr_created" && session.integration?.url && (
              <Button
                variant="canvas"
                size="sm"
                icon={<ExternalLink className={ICON_INLINE} />}
                title={session.integration.url}
                onClick={() => {
                  const url = session.integration?.url;
                  if (url) send({ type: "openExternal", uri: url });
                }}
              >
                {t("打开 PR")}
              </Button>
            )}
            {!session.isolation.released && (
              <Button
                variant="canvas"
                size="sm"
                icon={
                  cleanupPending ? (
                    <Loader2 className={`${ICON_INLINE} animate-spin`} />
                  ) : (
                    <Trash2 className={ICON_INLINE} />
                  )
                }
                /* Same reasoning as the merge button: `disabled` would kill
                   pointer events and hide the reason, so the block is
                   expressed with `aria-disabled` plus an early return. While
                   cleaning, the busy state blocks a second click too. */
                aria-disabled={cleanupBlocked || cleanupPending || undefined}
                aria-label={
                  cleanupPending ? t("清理中") : cleanupBlocked ? cleanupReason : t("清理")
                }
                title={cleanupPending ? t("清理中") : cleanupBlocked ? cleanupReason : undefined}
                className={
                  cleanupBlocked || cleanupPending ? "cursor-not-allowed opacity-40" : undefined
                }
                onClick={() => {
                  if (cleanupBlocked || cleanupPending) return;
                  onCleanup();
                }}
              >
                {cleanupPending ? t("清理中") : t("清理")}
              </Button>
            )}
          </div>

          {showDiagnostics && sessionDiagnostics.length > 0 && (
            <div className="rounded-sm border border-border/60 bg-surface/40">
              <SuperDiagnosticTimeline
                entries={sessionDiagnostics}
                summary={sessionDiagnosticSummary}
              />
            </div>
          )}
        </div>
      )}

      {showLive && (
        <SuperSessionLive session={session} now={now} onClose={() => setShowLive(false)} />
      )}
    </div>
  );
}

/**
 * Live activity for one child session, in a dialog.
 *
 * The child's own `session/update` stream is rendered with the SAME block
 * components as the main transcript (tool cards, thoughts, plans, nested
 * sub-agents). It rides the dedicated `superTranscripts` host channel — the
 * child's blocks never enter the main transcript.
 *
 * A dialog (rather than an inline expanding pane) keeps the board layout
 * stable: an inline pane reflowed every neighbouring card and its `max-h-64`
 * cap cut the newest tool call out of view exactly when it mattered.
 */
function SuperSessionLive({
  session,
  now,
  onClose,
}: {
  session: SuperSessionUi;
  /** Wall-clock instant the 「已运行」 label is rendered against. */
  now: number;
  onClose: () => void;
}) {
  const send = useChat((s) => s.send);
  const historical = session.restored === true;
  const transcript = useChat((s) => s.superTranscripts?.[session.id]) ?? EMPTY_TRANSCRIPT;
  const liveRef = useRef<HTMLDivElement>(null);
  // Follow the tail unless the user scrolled up — same rule as the main
  // transcript, so live activity keeps the newest tool call in view.
  const liveStick = useRef(true);
  const chip = statusVisual(session);
  const interruptSourceLabel = interruptedByLabel(session);

  useEffect(() => {
    const el = liveRef.current;
    if (!el || !liveStick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // First open after a webview reboot: the host re-sends transcripts on
  // `ready`, but if this child was spun up before the pane existed the store
  // may still be empty — pull the full transcript once.
  useEffect(() => {
    if (transcript.length > 0) return;
    send({ type: "superAgent", action: "transcript", sessionId: session.id });
  }, [transcript.length, send, session.id]);

  return createPortal(
    <ModalShell
      wide
      title={session.title}
      icon={<Activity className={`${ICON_INLINE} shrink-0 text-primary`} />}
      ariaLabel={historical ? t("超流体历史转录") : t("超流体实时进度")}
      onClose={onClose}
      initialFocus="first"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={chip.tone}>
            {chip.icon}
            {chip.label}
          </Chip>
          {interruptSourceLabel && (
            <span className="text-ui-micro text-muted-foreground">{interruptSourceLabel}</span>
          )}
          <span className="text-ui-caption tabular-nums text-muted-foreground">
            {session.startedAt === undefined
              ? elapsedText(session, now)
              : t("已运行 {0}", elapsedText(session, now))}
          </span>
          {session.model && <Chip tone="muted">{session.model}</Chip>}
          <span className="ml-auto text-ui-micro text-muted-foreground">
            {historical ? t("已保存的转录") : t("实时输出")}
          </span>
        </div>
        <div
          ref={liveRef}
          onScroll={() => {
            const el = liveRef.current;
            if (el) liveStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto rounded-sm bg-editor/60 px-2 py-2"
        >
          {/* ONE compact rhythm for the whole log: a flex column with a
              single 8px gap. .cv-block (14px/20px padding + equal negative
              margins) is the MAIN transcript's spacing — stacking it with
              divide-y and py-1 here made rows drift apart unevenly. */}
          {transcript.length === 0 ? (
            <div className="text-ui-caption text-muted-foreground">
              {session.status === "preparing" || session.queued
                ? t("准备中…")
                : t("暂无输出")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {transcript.map((block, index) => {
                const prev = index > 0 ? transcript[index - 1] : undefined;
                const showAvatar =
                  prev === undefined ||
                  prev.kind !== "text" ||
                  (prev.kind === "text" && prev.system === true);
                return (
                  <div key={block.id ?? `idx-${index}`}>
                    <BlockView
                      block={block}
                      chrome="flat"
                      isLatest={index === transcript.length - 1}
                      turnActive={isActive(session)}
                      canCopy
                      canRegenerate={false}
                      canDelete={false}
                      showAvatar={showAvatar}
                      onRegenerate={() => {}}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}

/**
 * The child session's pending question.
 *
 * Approvals never reach this component: child sessions always run in
 * no-confirmation mode, and the host answers their `request_permission`
 * requests itself (a stale plan-exit is auto-approved too). `ask_user_question`
 * is the only thing that truly needs a human.
 *
 * The questions themselves are rendered by `QuestionBody` — the SAME
 * component the main session's question card uses. The board used to carry
 * a parallel, poorer implementation: the option descriptions were dropped on
 * the floor, the options were plain buttons with no radiogroup/checkboxgroup
 * semantics, there was no free-text answer and no hint about the timeout.
 * Two copies of one `ask_user_question` payload behaving differently is a
 * trap for the user, so there is now only one implementation.
 */
function SuperPendingArea({ session }: { session: SuperSessionUi }) {
  const send = useChat((s) => s.send);
  const pending = session.pending;
  const [answers, setAnswers] = useState<QuestionAnswerMap>({});
  const [sent, setSent] = useState(false);
  if (!pending) return null;

  const respond = (payload: QuestionAnswerMap) => {
    if (sent) return;
    setSent(true);
    send({ type: "superAgent", action: "respond", sessionId: session.id, answers: payload });
  };

  return (
    <div className="mx-2 mt-1.5 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1.5">
      {/* Immediately after respond() the two buttons just grey out — with no
          acknowledgement the card looks broken until the host round-trips.
          Flip the header to an optimistic "submitted" state (and announce it)
          so the click always has a visible, accessible receipt. */}
      <div
        className={`text-ui-caption font-medium ${sent ? "text-info" : "text-warning"}`}
        role="status"
        aria-live="polite"
      >
        {sent ? t("已提交，等待超流体继续") : t("超流体需要你回答")}
      </div>
      <div className="mt-1 text-ui-micro text-muted-foreground">
        {t("超流体在等你的回答；不回答会在倒计时结束后按「未回答」继续。")}
      </div>
      <div className="mt-1.5">
        <QuestionBody
          questions={pending.questions}
          disabled={sent}
          onAnswersChange={setAnswers}
          onSubmit={() => respond(answers)}
        />
      </div>
      {/* The real host deadline (SUPER_PENDING_TIMEOUT_MS) — the board must
          not invent a second, drifting window. */}
      <CountdownBar
        deadline={pending.deadline}
        timeoutMs={pending.timeoutMs}
        quietLabel={t("按未回答继续")}
        className="px-0 pb-0 pt-1.5"
      />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          disabled={sent}
          aria-label={t("提交回答")}
          onClick={() => respond(answers)}
        >
          {t("提交回答")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={sent}
          aria-label={t("不回答并继续")}
          onClick={() => respond({})}
        >
          {t("不回答并继续")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 子会话卡片上的完整任务描述（就地展开 / 收起）。
 *
 * 看板行的短描述由 `shortSuperSessionDescription` 单行截断（95 字），但完整
 * 任务书在 `session.task` 里一字未丢。这里让用户在卡片普通流内就地展开全文——
 * 不弹 modal、不开 portal，展开只把卡片撑高；折叠态仍是一行短描述，保持看板紧凑。
 * 只有「完整正文比短描述更长」时才给出展开入口，短任务不显示多余的按钮。
 */
function SuperTaskDescription({ task, short }: { task: string; short: string }) {
  const [open, setOpen] = useState(false);
  const full = (task ?? "").trim();
  // 既无短描述也无正文时不占位（对应旧的 `description && ...` 守卫）。
  if (!short && !full) return null;
  const expandable = full.length > short.length;
  return (
    <div className="min-w-0 text-ui-caption text-muted-foreground">
      <span
        className={`block break-words ${open ? "max-h-64 overflow-y-auto whitespace-pre-wrap" : "truncate"}`}
        title={open ? undefined : short}
      >
        {open ? full : short}
      </span>
      {expandable && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-0.5 px-0"
          aria-expanded={open}
          aria-label={open ? t("收起任务说明") : t("展开任务说明")}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("收起全文") : t("展开全文")}
        </Button>
      )}
    </div>
  );
}
