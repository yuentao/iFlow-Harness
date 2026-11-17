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
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  GitBranch,
  GitMerge,
  Hourglass,
  Loader2,
  RotateCcw,
  ShieldOff,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { Block } from "../../../shared/messages";
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
import { useChat } from "../store";
import { t } from "../i18n";
import { SuperDelegationFly } from "./SuperDelegationFly";
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
} from "./ui";
import { QuestionBody, type QuestionAnswerMap } from "./QuestionBody";

/** 状态色调（看板状态编码的第三重：颜色只是冗余，形状与文案才是主编码）。 */
type StatusTone = "muted" | "success" | "warning" | "danger" | "primary" | "info";

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
 * 已释放状态的文案（三态）。
 *
 * - `recycled`：目录被回收，**本地分支仍保留**（分支上有未合并提交，刻意留下待审）。
 * - 其余 `released`：目录与分支都已清理（合并成功，或根本没产生提交）。
 */
function releasedIsolationLabel(isolation: SuperIsolation): string {
  return isolation.recycled ? t("工作目录已删除，分支保留") : t("工作目录和分支都已删除");
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
export function SuperAgentBoard({ panelRef }: { panelRef?: (el: HTMLDivElement | null) => void }) {
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
  // Bulk cleanup snapshots the reclaimable ids at open time — recomputing while
  // the dialog is open could silently drop a child that just turned terminal
  // (or claim one that is still running) between the click and the confirm.
  const [confirmCleanupAll, setConfirmCleanupAll] = useState<{ count: number; ids: string[] } | null>(
    null,
  );
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
        changed.push(t("子会话 {0}：{1}", session.title, label));
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

  // Every child finished AND merged → nothing left to manage (failed,
  // cancelled and unmerged rows keep the board open). Fold back to one line.
  const allMerged = visible.length === 0 && folded.length > 0;
  useEffect(() => {
    if (!allMerged) return;
    setExpanded(false);
    setOpenRow(null);
  }, [allMerged]);

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
      {/* Accessible name is STATIC ("子会话看板"): it names the control, while
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
        aria-label={t("子会话看板")}
        title={expanded ? t("收起子会话看板") : t("展开子会话看板")}
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
          <span className="shrink-0 @max-[380px]:hidden">{t("子会话")}</span>
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
                title={t("{0} 个待处理", counts.awaiting)}
                ariaLabel={t("{0} 个待处理", counts.awaiting)}
              >
                <CircleHelp className="size-2.5" aria-hidden="true" />
                <span className="tabular-nums">{counts.awaiting}</span>
              </Chip>
            )}
            {counts.failed > 0 && (
              <Chip
                tone="danger"
                title={t("{0} 个未成功", counts.failed)}
                ariaLabel={t("{0} 个未成功", counts.failed)}
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
          title={t("子会话里的工具调用（包括运行命令）会直接执行，不会先征求你的同意")}
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
            aria-label={t("子会话待答问题")}
            style={surfaceStyle(BOARD_STRIP_GAP)}
            className={`stream-in fixed z-35 max-h-[40vh] overflow-y-auto rounded-lg border border-border/70 acrylic-frosted px-1 py-1${anchor ? "" : " invisible"}`}
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
            aria-label={t("子会话")}
            style={surfaceStyle(BOARD_PANEL_GAP)}
            className={`stream-in fixed z-35 overflow-hidden rounded-lg border border-border/70 acrylic-frosted${anchor ? "" : " invisible"}`}
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <span className="flex min-w-0 items-center gap-1.5 text-ui-label font-medium text-foreground">
                <Users className={`${ICON_INLINE} shrink-0 text-muted-foreground`} aria-hidden="true" />
                <span className="truncate">{t("子会话")}</span>
              </span>
              {/* The board's ONE help bubble: every rule that used to be
                  spelled out under each row lives here now (what a child may
                  do, when merge / cleanup become available). The row's status
                  chip already says a child is still running — repeating the
                  reason in every expanded row was noise, and it made the
                  board unreadable at a glance. */}
              <HelpTip label={t("看板说明")}>
                <div className="flex flex-col gap-1">
                  <span>{t("子会话里的工具调用（包括运行命令）会直接执行，不会先征求你的同意")}</span>
                  <span>{t("子会话结束之后才能合并；已经合并过、或者没有改动可合并的子会话，不需要再合并")}</span>
                  <span>{t("子会话还在运行时不能清理，请先中断它")}</span>
                </div>
              </HelpTip>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {active.length > 0 && (
                  <Button
                    variant="canvas"
                    size="sm"
                    icon={<Square className={ICON_INLINE} />}
                    aria-label={t("全部中断")}
                    title={t("全部中断")}
                    onClick={() => setConfirmCancelAll(active.length)}
                  >
                    <span className="@max-[380px]:hidden">{t("全部中断")}</span>
                  </Button>
                )}
              </div>
            </div>
            {/* Body: same rows as before, just inside the popup. px-3 py-2 keeps
                the panel's breathing room (the row components add their own
                px-2/py-1.5 on top). */}
            <div className="max-h-[40vh] divide-y divide-border/50 overflow-y-auto px-3 py-2">
              {visible.map((session) => (
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
                />
              ))}
              {/* Finished + already merged children collapse into ONE history row:
                  their changes are in the working tree, so there is nothing left
                  to act on — they only get in the way of the live ones. */}
              {folded.length > 0 && (
                <div className="shrink-0">
                  <DisclosureButton
                    expanded={showFolded}
                    aria-label={showFolded ? t("收起已完成的子会话") : t("展开已完成的子会话")}
                    title={showFolded ? t("收起已完成的子会话") : t("展开已完成的子会话")}
                    className="w-full rounded-sm px-2 py-1.5"
                    onClick={() => setShowFolded((v) => !v)}
                  >
                    {showFolded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
                    <span className="shrink-0">{t("已完成并合并的 {0} 个子会话", folded.length)}</span>
                    <Chip tone="success">{t("已自动合并")}</Chip>
                  </DisclosureButton>
                  {showFolded && (
                    <div className="divide-y divide-border/40 border-t border-border/40">
                      {folded.map((session) => (
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
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {(totals.input > 0 || totals.output > 0) && (
                <div
                  className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-ui-micro text-muted-foreground"
                  title={t("按公开单价估算，仅供参考")}
                >
                  <span className="font-medium text-foreground">{t("子会话合计开销")}</span>
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
                      onClick={() =>
                        setConfirmCleanupAll({
                          count: reclaimable.length,
                          ids: reclaimable.map((s) => s.id),
                        })
                      }
                    >
                      {t("清理已结束")}
                    </Button>
                  )}
                </div>
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
          title={t("合并子会话分支")}
          message={t(
            "让智能体把分支 {0} 合并到当前分支？它会自己完成合并并处理冲突，你当前的工作分支会被改动。",
            confirmMerge.isolation.branch ?? "",
          )}
          confirmLabel={t("让智能体合并分支")}
          onConfirm={() => {
            beginMerge(confirmMerge.id, confirmMerge.integration?.at);
            send({ type: "superAgent", action: "merge", sessionId: confirmMerge.id });
            setConfirmMerge(null);
          }}
          onCancel={() => setConfirmMerge(null)}
        />
      )}
      {confirmCancel && (
        <ConfirmDialog
          title={t("中断子会话")}
          message={t(
            "中断子会话「{0}」？它会立即停止，这次的改动不会被提交或合并；工作目录里已有的内容会保留，之后可以重试。",
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
      {confirmCancelAll !== null && (
        <ConfirmDialog
          title={t("全部中断")}
          message={t(
            "中断全部 {0} 个进行中的子会话？它们会立即停止，这次的改动不会被提交或合并；工作目录里已有的内容会保留，之后可以重试。",
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
          title={t("清理子会话")}
          message={t(
            "删除子会话「{0}」的工作目录？分支上未合并的提交会保留；工作目录里尚未提交的改动会被一起删掉，无法恢复。",
            confirmCleanup.title,
          )}
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
          title={t("清理已结束的子会话")}
          message={t(
            "将删除 {0} 个子会话的工作目录；它们的分支都会保留（未合并的提交不会丢），但工作目录里尚未提交的改动会被一起删掉，无法恢复。",
            confirmCleanupAll.count,
          )}
          confirmLabel={t("清理已结束")}
          onConfirm={() => {
            // One batched request: the host cleans the whole set serially and
            // reports a single aggregate receipt. Sending one `cleanup` per
            // child made the transcript collect N identical toasts and left
            // the user unable to tell where the batch as a whole stood.
            send({
              type: "superAgent",
              action: "cleanupBatch",
              sessionIds: confirmCleanupAll.ids,
            });
            // Mark every child busy at click time so each row shows its own
            // in-progress state while the host cleans them up asynchronously.
            beginCleanup(confirmCleanupAll.ids);
            setConfirmCleanupAll(null);
          }}
          onCancel={() => setConfirmCleanupAll(null)}
        />
      )}
    </>
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
}: {
  session: SuperSessionUi;
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
}) {
  const [showLive, setShowLive] = useState(false);
  // Busy states take the chip over: each one is a request the user just made
  // and is waiting on, so it must outrank the stale status it is replacing
  // (a merge target is `completed` — without this it would still read
  // 「已完成」 while the merge child runs). Merge outranks retry only because
  // the two cannot coexist on one row in practice.
  const busyChip = cancelPending
    ? t("中断中")
    : cleanupPending
      ? t("清理中")
      : mergePending
        ? t("合并中")
        : retryPending
          ? t("重试中")
          : null;
  const chip = busyChip
    ? {
        tone: "primary" as StatusTone,
        label: busyChip,
        icon: <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />,
      }
    : statusVisual(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? now;
  const preview = session.progress ?? session.summary;
  // A restored child ran in a PREVIOUS extension lifetime: its CLI process
  // is gone, so there is no live transcript to show and nothing to retry.
  // What survives is the record — the branch and its worktree — so the merge
  // and cleanup actions stay available.
  const historical = session.restored === true;
  // Why the merge action is unavailable right now. The RULE is stated once,
  // in the board header's help bubble; this string only feeds the button's
  // title / aria-label, so a greyed-out button still says why it is greyed
  // out for a screen reader and on hover.
  const mergeBlocked =
    !session.isolation.branch ||
    session.integration?.state === "merged" ||
    isActive(session);
  const mergeReason =
    session.integration?.state === "merged"
      ? t("这个子会话的改动已经合并")
      : !session.isolation.branch
        ? t("这个子会话没有可合并的分支")
        : isActive(session)
          ? t("子会话还没结束，等它完成再合并")
          : t("让一个子会话把这条分支合并到当前分支，冲突由它自己解决");
  // Cleanup deletes the worktree, so it must not race a live child: the
  // process would keep writing into a directory that no longer exists.
  // Same discipline as the merge action — the rule lives in the board
  // header's help bubble, and the button keeps it in title / aria-label.
  const cleanupBlocked = isActive(session);
  const cleanupReason = t("子会话还在运行，请先中断再清理");
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
    historical ? t("这次子会话在上一次运行里就已经结束（扩展重启后恢复的历史记录）") : null,
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
          <span className="min-w-0 flex-1 truncate text-ui-label font-medium" title={titleHint}>
            {session.title}
          </span>
          <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground">
            {formatElapsed(ended - started)}
          </span>
          <ChevronDown
            className={`${ICON_INLINE} shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </DisclosureButton>
        {/* Stopping a live child is the one action that must not hide behind
            the detail: the process keeps writing files meanwhile. */}
        {isActive(session) && (
          <IconButton
            icon={
              cancelPending ? (
                <Loader2 className={`${ICON_INLINE} animate-spin`} aria-hidden="true" />
              ) : (
                <Square className={ICON_INLINE} />
              )
            }
            label={cancelPending ? t("中断中") : t("中断这个子会话")}
            size="sm"
            tone="danger"
            hoverSurface="row"
            disabled={cancelPending}
            onClick={onCancel}
          />
        )}
      </div>

      {/* The only thing that needs the user, so it is never folded away. */}
      {session.pending && <SuperPendingArea session={session} />}

      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2 pt-0.5">
          {/* 阶段轨只在展开后出现一次：折叠行只报状态，展开区不再重复状态 chip。 */}
          <SuperTimeline session={session} labeled />

          {preview && (
            <div className="whitespace-pre-wrap break-words text-ui-caption text-muted-foreground">
              {preview}
            </div>
          )}

          {session.error && (
            <div className="break-words rounded-sm border border-destructive/30 bg-destructive/10 px-2 py-1 text-ui-caption text-destructive">
              {session.error}
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
                title={t("输入是上一次请求实际携带的上下文；输出按子会话的文字估算")}
              >
                ↑{formatTokens(session.tokens.input)} ↓{formatTokens(session.tokens.output)}
                {session.tokens.estimatedCost !== null && session.tokens.estimatedCost !== undefined && (
                  <span title={t("预估费用：token 估算 × 公开单价，仅供参考")}>
                    {" "}{formatCost(session.tokens.estimatedCost)}
                  </span>
                )}
              </span>
            )}
            {historical && <span>{t("上次运行")}</span>}
            {(session.attempts ?? 1) > 1 && <span>{t("第 {0} 次尝试", session.attempts ?? 1)}</span>}
          </div>

          {/* No visible reason line under the buttons any more: the board
              header's help bubble states the merge / cleanup rules once, and
              the row's status chip already says the child is still running.
              The greyed-out buttons keep their full reason in title /
              aria-label. */}
          <div className="flex flex-wrap items-center gap-1">
            {/* A restored child has no live transcript (its process died with
                the previous extension lifetime) and cannot be retried —
                retrying would re-run the whole task from scratch. The branch
                and its worktree are still there, so merge / cleanup stay. */}
            {!historical && (
              <Button
                variant="canvas"
                size="sm"
                icon={<Activity className={ICON_INLINE} />}
                onClick={() => setShowLive(true)}
              >
                {t("查看实时进度")}
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
                aria-label={retryPending ? t("重试中") : t("重试这个子会话：沿用原来的工作目录，已有的改动会保留")}
                title={retryPending ? t("重试中") : t("重试这个子会话：沿用原来的工作目录，已有的改动会保留")}
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
  const transcript = useChat((s) => s.superTranscripts[session.id]) ?? EMPTY_TRANSCRIPT;
  const liveRef = useRef<HTMLDivElement>(null);
  // Follow the tail unless the user scrolled up — same rule as the main
  // transcript, so live activity keeps the newest tool call in view.
  const liveStick = useRef(true);
  const chip = statusVisual(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? now;

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
      ariaLabel={t("子会话实时进度")}
      onClose={onClose}
      initialFocus="first"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={chip.tone}>
            {chip.icon}
            {chip.label}
          </Chip>
          <span className="text-ui-caption tabular-nums text-muted-foreground">
            {t("已运行 {0}", formatElapsed(ended - started))}
          </span>
          {session.model && <Chip tone="muted">{session.model}</Chip>}
          <span className="ml-auto text-ui-micro text-muted-foreground">{t("实时输出")}</span>
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
      <div className="text-ui-caption font-medium text-warning">{t("子会话需要你回答")}</div>
      <div className="mt-1 text-ui-micro text-muted-foreground">
        {t("子会话在等你的回答；不回答会在倒计时结束后按「未回答」继续。")}
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
