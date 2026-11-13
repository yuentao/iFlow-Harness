import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  X,
} from "lucide-react";
import type { Block } from "../../../shared/messages";
import type {
  SuperIntegrationState,
  SuperSessionUi,
  SuperStatus,
} from "../../../shared/super-agent";
import {
  canRetrySuperSession,
  groupSuperSessionsForBoard,
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
      return t("等待你处理");
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
 * Presentation: the bar FLOATS at the top of the transcript, same overlay
 * contract as the approval/question cards at the bottom (App.tsx anchors it
 * absolutely over the scroller). It never takes a flex row, so a child
 * appearing or expanding cannot squeeze the message list.
 */
export function SuperAgentBoard() {
  const sessions = useChat((s) => s.state?.superSessions);
  const send = useChat((s) => s.send);
  const [expanded, setExpanded] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState<SuperSessionUi | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<SuperSessionUi | null>(null);
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
  // Ticking clock for the elapsed labels of live children.
  const [, setTick] = useState(0);

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
  const counts = useMemo(() => summarizeSuperSessions(list), [list]);
  const totals = useMemo(() => sumSuperUsage(list), [list]);
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
    const timer = window.setInterval(() => setTick((v) => v + 1), 1000);
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

  // Nothing to manage → the board stays out of the way.
  if (list.length === 0) return null;

  return (
    // `pointer-events-auto` re-enables hits inside App's pointer-events-none
    // top overlay shell (the gutters around the bar stay transparent to
    // transcript scroll).
    //
    // Material: acrylic + shadow (user request 2026-11-12). `.super-board-
    // surface` (styles.css) carries the acrylic tint, the backdrop blur and
    // the acrylic inset rim; the shadow tier rides the existing .shadow-*
    // classes and follows the surface size — the collapsed shelf is a ~38px
    // strip where --shadow-panel's -24px spread collapses the projection to
    // nothing, so it takes the float drop, while the expanded board is a
    // real panel and takes the panel drop.
    //
    // Why the blur really works here: the board is NOT nested inside a
    // backdrop-filter ancestor. The acrylic header and the acrylic composer
    // are SIBLINGS of the transcript column, not ancestors of it, so no
    // backdrop root stands between the board and the transcript — its own
    // backdrop-filter samples the scrolling message text for real (unlike
    // .acrylic-pop, which omits the blur because popups always nest inside
    // an acrylic ancestor and could only sample that subtree's flat tint).
    // The surface density is chosen in styles.css so the text behind is
    // blurred into an illegible wash, never readable through the shelf.
    //
    // The board keeps `overflow-hidden` for its own rounded corners, and
    // both dialogs (ConfirmDialog, the live-activity modal) portal to
    // document.body, so neither the clip nor the backdrop-filter's
    // containing block can trap them.
    <div
      className={`stream-in pointer-events-auto mx-3 mt-2 mb-2 shrink-0 overflow-hidden rounded-lg border border-border/70 super-board-surface ${
        expanded ? "shadow-panel" : "shadow-float"
      }`}
    >
      {/* Header row: the board's collapsed form is a single line so it never
          steals space from the transcript. Counts are icon + number chips
          (the wording lives in the tooltip) — the old "{n} 个进行中" text chips
          wrapped into a ragged second row at ~360px and pushed the action
          cluster around. `flex-wrap` is kept only as a last-resort guard so a
          pathological width wraps whole groups instead of clipping them. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
        <DisclosureButton
          expanded={expanded}
          aria-label={t("展开子会话看板")}
          title={t("展开子会话看板")}
          className="h-6 shrink-0 gap-1 rounded-sm px-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
          <span className="shrink-0">{t("子会话")}</span>
          <span className="rounded-full bg-surface px-1.5 py-px text-ui-micro font-medium tabular-nums text-muted-foreground">
            {list.length}
          </span>
        </DisclosureButton>
        <div className="flex shrink-0 items-center gap-1">
          {counts.running > 0 && (
            <Chip
              tone="primary"
              title={t("{0} 个进行中", counts.running)}
              ariaLabel={t("{0} 个进行中", counts.running)}
            >
              <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
              <span className="tabular-nums">{counts.running}</span>
            </Chip>
          )}
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
          {counts.done > 0 && (
            <Chip
              tone="success"
              title={t("{0} 个已完成", counts.done)}
              ariaLabel={t("{0} 个已完成", counts.done)}
              className="@max-[380px]:hidden"
            >
              <Check className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.done}</span>
            </Chip>
          )}
          {counts.failed > 0 && (
            <Chip
              tone="danger"
              title={t("{0} 个未成功", counts.failed)}
              ariaLabel={t("{0} 个未成功", counts.failed)}
            >
              <X className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.failed}</span>
            </Chip>
          )}
          {counts.cancelled > 0 && (
            <Chip
              tone="muted"
              title={t("{0} 个已中断", counts.cancelled)}
              ariaLabel={t("{0} 个已中断", counts.cancelled)}
              className="@max-[380px]:hidden"
            >
              <Square className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.cancelled}</span>
            </Chip>
          )}
        </div>
        {/* No-confirmation is a property of every child, not of one row —
            stated once here instead of a chip repeated on each card.
            It is NOT hover-only: the fact that a child's shell commands run
            without approval is the single most consequential thing about
            child sessions, so it stays on screen (the tooltip only adds the
            detail). */}
        <span
          className="flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-ui-micro font-medium text-warning"
          title={t("子会话始终免确认：包括 shell 在内的工具调用都直接执行，不会弹审批")}
        >
          <ShieldOff className="size-3 shrink-0" aria-hidden="true" />
          {t("免确认")}
        </span>
        <HelpTip label={t("免确认说明")}>
          {t("子会话始终免确认：包括 shell 在内的工具调用都直接执行，不会弹审批")}
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
      {/* Status changes are announced, not just re-drawn: a child that turns
          「等待你处理」 must reach a screen reader without the user hunting
          for the board. Only CHANGES are announced (see above) — opening the
          panel does not read the whole column out loud. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {expanded && list.length > 0 && (
        <div className="max-h-[40vh] divide-y divide-border/50 overflow-y-auto border-t border-border px-2 py-1">
          {visible.map((session) => (
            <SuperSessionRow
              key={session.id}
              session={session}
              open={openRow === session.id}
              onToggle={() => setOpenRow((v) => (v === session.id ? null : session.id))}
              onMerge={() => setConfirmMerge(session)}
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
                <span className="shrink-0">{t("已完成的 {0} 个子会话", folded.length)}</span>
                <Chip tone="success">{t("已自动合并")}</Chip>
              </DisclosureButton>
              {showFolded && (
                <div className="divide-y divide-border/40 border-t border-border/40">
                  {folded.map((session) => (
                    <SuperSessionRow
                      key={session.id}
                      session={session}
                      open={openRow === session.id}
                      onToggle={() => setOpenRow((v) => (v === session.id ? null : session.id))}
                      onMerge={() => setConfirmMerge(session)}
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
        </div>
      )}

      {confirmMerge && (
        <ConfirmDialog
          title={t("合并子会话分支")}
          message={t(
            "让智能体把分支 {0} 合并到当前分支？它会自己执行合并并解决冲突，这会改动你当前的工作分支。",
            confirmMerge.isolation.branch ?? "",
          )}
          confirmLabel={t("让智能体合并分支")}
          onConfirm={() => {
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
            "中断子会话「{0}」？子会话进程会立即终止，本次任务不会自动提交或合并；工作目录里已有的改动会保留，之后可以重试。",
            confirmCancel.title,
          )}
          confirmLabel={t("中断")}
          onConfirm={() => {
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
            "中断全部 {0} 个进行中的子会话？它们各自的进程会立即终止，本次任务不会自动提交或合并；工作目录里已有的改动会保留，之后可以重试。",
            confirmCancelAll,
          )}
          confirmLabel={t("全部中断")}
          onConfirm={() => {
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
            "删除子会话「{0}」的工作目录？分支上未合并的提交会被保留；工作目录里未提交的改动会被一并删除，无法恢复。",
            confirmCleanup.title,
          )}
          confirmLabel={t("清理")}
          onConfirm={() => {
            send({ type: "superAgent", action: "cleanup", sessionId: confirmCleanup.id });
            setConfirmCleanup(null);
          }}
          onCancel={() => setConfirmCleanup(null)}
        />
      )}
    </div>
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
  open,
  onToggle,
  onMerge,
  onCleanup,
  onCancel,
}: {
  session: SuperSessionUi;
  open: boolean;
  onToggle: () => void;
  onMerge: () => void;
  onCleanup: () => void;
  onCancel: () => void;
}) {
  const send = useChat((s) => s.send);
  const [showLive, setShowLive] = useState(false);
  const chip = statusVisual(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? Date.now();
  const preview = session.progress ?? session.summary;
  // A restored child ran in a PREVIOUS extension lifetime: its CLI process
  // is gone, so there is no live transcript to show and nothing to retry.
  // What survives is the record — the branch and its worktree — so the merge
  // and cleanup actions stay available.
  const historical = session.restored === true;
  // Why the merge action is unavailable right now. Spelled out in words so
  // it can be shown under the buttons, read by a screen reader and hovered
  // as a tooltip — a greyed-out button without a reason reads as broken.
  const mergeBlocked =
    !session.isolation.branch ||
    session.integration?.state === "merged" ||
    isActive(session);
  const mergeReason =
    session.integration?.state === "merged"
      ? t("该子会话的改动已经合并")
      : !session.isolation.branch
        ? t("该子会话没有可合并的分支")
        : isActive(session)
          ? t("子会话还没结束，完成后再让智能体合并")
          : t("派出合并子会话，把该子会话的分支合并到当前分支（冲突由它自行解决）");
  // Diagnostics — full branch ref, worktree path, retry count, restored
  // marker — ride the title tooltip instead of occupying their own lines.
  const titleHint = [
    session.title,
    // 合并成功时磁盘对象已清理：工具提示不该再给出一条已经不存在的路径。
    session.isolation.released
      ? t("工作目录与分支已清理")
      : session.isolation.branch
        ? t("分支 {0}", session.isolation.branch)
        : null,
    session.isolation.released ? null : t("目录 {0}", session.isolation.path),
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
            icon={<Square className={ICON_INLINE} />}
            label={t("中断该子会话")}
            size="sm"
            tone="danger"
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
              <span className="min-w-0 flex-1 truncate">{t("工作目录与分支已清理")}</span>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono" title={`${session.isolation.branch ?? ""}\n${session.isolation.path}`}>
                {session.isolation.branch ?? session.isolation.path}
              </span>
            )}
            {session.isolation.kind === "directory" && (
              <Chip tone="warning" title={session.isolation.note}>
                {t("仅目录隔离")}
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
                title={t("输入为内核上报的末次请求上下文；输出按子会话文本估算")}
              >
                ↑{formatTokens(session.tokens.input)} ↓{formatTokens(session.tokens.output)}
                {session.tokens.estimatedCost !== null && session.tokens.estimatedCost !== undefined && (
                  <span title={t("预估成本（token 估算 × 公开单价，仅供参考）")}>
                    {" "}{formatCost(session.tokens.estimatedCost)}
                  </span>
                )}
              </span>
            )}
            {historical && <span>{t("上次运行")}</span>}
            {(session.attempts ?? 1) > 1 && <span>{t("第 {0} 次尝试", session.attempts ?? 1)}</span>}
          </div>

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
                {t("查看实时操作")}
              </Button>
            )}
            {!historical && canRetrySuperSession(session) && (
              <Button
                variant="canvas"
                size="sm"
                icon={<RotateCcw className={ICON_INLINE} />}
                title={t("重试该子会话（沿用原工作目录，保留已有改动）")}
                onClick={() => send({ type: "superAgent", action: "retry", sessionId: session.id })}
              >
                {t("重试")}
              </Button>
            )}
            <Button
              variant="canvas"
              size="sm"
              icon={<GitMerge className={ICON_INLINE} />}
              /* `aria-disabled` instead of `disabled`: the kit's disabled
                 style kills pointer events, so the `title` (the only place
                 the reason was written) could never be read. aria-disabled
                 keeps the button focusable and its title/aria-label
                 readable, and the reason is spelled out under the row. */
              aria-disabled={mergeBlocked || undefined}
              aria-label={mergeBlocked ? mergeReason : t("让智能体合并")}
              title={mergeReason}
              className={mergeBlocked ? "cursor-not-allowed opacity-40" : undefined}
              onClick={() => {
                if (mergeBlocked) return;
                onMerge();
              }}
            >
              {t("让智能体合并")}
            </Button>
            {!session.isolation.released && (
              <Button
                variant="canvas"
                size="sm"
                icon={<Trash2 className={ICON_INLINE} />}
                onClick={onCleanup}
              >
                {t("清理")}
              </Button>
            )}
          </div>
          {mergeBlocked && (
            /* The reason is visible without hover — a greyed-out button with
               no explanation reads as a broken control. */
            <p className="text-ui-micro text-muted-foreground">{mergeReason}</p>
          )}
        </div>
      )}

      {showLive && (
        <SuperSessionLive session={session} onClose={() => setShowLive(false)} />
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
  onClose,
}: {
  session: SuperSessionUi;
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
  const ended = session.endedAt ?? Date.now();

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
      ariaLabel={t("子会话实时操作")}
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
 * no-confirmation mode, and the host answers their `request_permission` /
 * plan-exit requests itself. `ask_user_question` is the only thing that truly
 * needs a human.
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
