import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  GitBranch,
  GitMerge,
  Loader2,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Block } from "../../../shared/messages";
import type {
  SuperIntegrationState,
  SuperSessionUi,
} from "../../../shared/super-agent";
import {
  canRetrySuperSession,
  groupSuperSessionsForBoard,
  sumSuperUsage,
  summarizeSuperSessions,
  superIntegrationLabel,
} from "../../../shared/super-agent";
import { useChat } from "../store";
import { t } from "../i18n";
import { BlockView } from "./MessageList";
import {
  Button,
  Chip,
  ConfirmDialog,
  HelpTip,
  ICON_INLINE,
  IconButton,
  ModalShell,
} from "./ui";

/** One child session's status → chip tone + label. */
function statusChip(session: SuperSessionUi): { tone: "muted" | "success" | "warning" | "danger" | "primary" | "info"; label: string } {
  // A queued delegation waits for a free concurrency slot — say so instead of
  // pretending it started.
  if (session.queued && session.status === "preparing") {
    return { tone: "info", label: t("排队中") };
  }
  switch (session.status) {
    case "preparing":
      return { tone: "warning", label: t("准备中") };
    case "running":
      return { tone: "primary", label: t("运行中") };
    case "awaiting_input":
      return { tone: "warning", label: t("等待你处理") };
    case "completed":
      return { tone: "success", label: t("已完成") };
    case "failed":
      return { tone: "danger", label: t("失败") };
    case "cancelled":
      return { tone: "muted", label: t("已中断") };
  }
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
    // transcript scroll). Deliberately NOT acrylic and NOT shadow-float: this
    // is a toolbar over the transcript, not a content card — a raised surface
    // here competed with the message/tool cards underneath. ConfirmDialog
    // portals to body, so it escapes this shelf.
    <div className="stream-in pointer-events-auto mx-3 mt-2 mb-2 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-canvas/95">
      {/* Header row: the board's collapsed form is a single line so it never
          steals space from the transcript. Counts are icon + number chips
          (the wording lives in the tooltip) — the old "{n} 个进行中" text chips
          wrapped into a ragged second row at ~360px and pushed the action
          cluster around. `flex-wrap` is kept only as a last-resort guard so a
          pathological width wraps whole groups instead of clipping them. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t("展开子会话看板")}
          title={t("展开子会话看板")}
          className="press flex h-6 shrink-0 items-center gap-1 rounded-sm px-1 text-ui-label font-medium text-foreground hover:bg-accent/60"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
          <span className="shrink-0">{t("子会话")}</span>
          <span className="rounded-full bg-canvas px-1.5 py-px text-ui-micro font-medium tabular-nums text-muted-foreground">
            {list.length}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {counts.running > 0 && (
            <Chip tone="primary" title={t("{0} 个进行中", counts.running)}>
              <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
              <span className="tabular-nums">{counts.running}</span>
            </Chip>
          )}
          {counts.awaiting > 0 && (
            <Chip tone="warning" title={t("{0} 个待处理", counts.awaiting)}>
              <CircleHelp className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.awaiting}</span>
            </Chip>
          )}
          {counts.done > 0 && (
            <Chip tone="success" title={t("{0} 个已完成", counts.done)} className="@max-[380px]:hidden">
              <Check className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.done}</span>
            </Chip>
          )}
          {counts.failed > 0 && (
            <Chip tone="danger" title={t("{0} 个未成功", counts.failed)}>
              <X className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.failed}</span>
            </Chip>
          )}
          {counts.cancelled > 0 && (
            <Chip
              tone="muted"
              title={t("{0} 个已中断", counts.cancelled)}
              className="@max-[380px]:hidden"
            >
              <Square className="size-2.5" aria-hidden="true" />
              <span className="tabular-nums">{counts.cancelled}</span>
            </Chip>
          )}
        </div>
        {/* No-confirmation is a property of every child, not of one row —
            stated once here instead of a chip repeated on each card. */}
        <HelpTip label={t("免确认说明")}>
          {t("子会话始终免确认：工具调用不会被审批，也不需要你批准")}
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
              <button
                type="button"
                aria-expanded={showFolded}
                aria-label={showFolded ? t("收起已完成的子会话") : t("展开已完成的子会话")}
                title={showFolded ? t("收起已完成的子会话") : t("展开已完成的子会话")}
                className="press flex w-full items-center gap-1.5 px-2 py-1.5 text-ui-label font-medium text-foreground hover:bg-accent/30"
                onClick={() => setShowFolded((v) => !v)}
              >
                {showFolded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
                <span className="shrink-0">{t("已完成的 {0} 个子会话", folded.length)}</span>
                <Chip tone="success">{t("已自动合并")}</Chip>
              </button>
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
          confirmLabel={t("让智能体合并")}
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

/** Status → dot colour (same 6px dot language as the MCP card). */
const STATUS_DOT: Record<"muted" | "success" | "warning" | "danger" | "primary" | "info", string> = {
  muted: "bg-muted-foreground/60",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  primary: "bg-primary",
  info: "bg-info",
};

/**
 * One child session row.
 *
 * Collapsed it is a single 32px line — status dot, title, “needs you” flag,
 * elapsed — and nothing else. Everything diagnostic (branch, summary, tokens,
 * merge result) and every action live in the detail below, opened by clicking
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
  const chip = statusChip(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? Date.now();
  const preview = session.progress ?? session.summary;
  // A restored child ran in a PREVIOUS extension lifetime: its CLI process
  // is gone, so there is no live transcript to show and nothing to retry.
  // What survives is the record — the branch and its worktree — so the merge
  // and cleanup actions stay available.
  const historical = session.restored === true;
  // Diagnostics — full branch ref, worktree path, retry count, restored
  // marker — ride the title tooltip instead of occupying their own lines.
  const titleHint = [
    session.title,
    session.isolation.branch ? t("分支 {0}", session.isolation.branch) : null,
    t("目录 {0}", session.isolation.path),
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
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[chip.tone]}`} aria-hidden="true" />
          <span className="sr-only">{chip.label}</span>
          <span className="min-w-0 flex-1 truncate text-ui-label font-medium" title={titleHint}>
            {session.title}
          </span>
          {session.pending && (
            <span className="shrink-0 text-ui-micro font-medium text-warning">{t("待回答")}</span>
          )}
          <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground">
            {formatElapsed(ended - started)}
          </span>
          <ChevronDown
            className={`${ICON_INLINE} shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
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
            <span className="min-w-0 flex-1 truncate font-mono" title={`${session.isolation.branch ?? ""}\n${session.isolation.path}`}>
              {session.isolation.branch ?? session.isolation.path}
            </span>
            {session.isolation.kind === "directory" && (
              <Chip tone="warning" title={session.isolation.note}>
                {t("仅目录隔离")}
              </Chip>
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
              disabled={
                !session.isolation.branch ||
                session.integration?.state === "merged" ||
                isActive(session)
              }
              title={
                session.integration?.state === "merged"
                  ? t("该子会话的改动已经合并")
                  : !session.isolation.branch
                    ? t("该子会话没有可合并的分支")
                    : isActive(session)
                      ? t("子会话还没结束，完成后再让智能体合并")
                      : t("让智能体把该子会话的分支合并到当前分支（冲突由它自行解决）")
              }
              onClick={onMerge}
            >
              {t("让智能体合并")}
            </Button>
            <Button
              variant="canvas"
              size="sm"
              icon={<Trash2 className={ICON_INLINE} />}
              onClick={onCleanup}
            >
              {t("清理")}
            </Button>
          </div>
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
  const chip = statusChip(session);
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
          <Chip tone={chip.tone}>{chip.label}</Chip>
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
          {transcript.length === 0 ? (
            <div className="text-ui-caption text-muted-foreground">
              {session.status === "preparing" || session.queued
                ? t("准备中…")
                : t("暂无输出")}
            </div>
          ) : (
            <div className="space-y-2">
              {transcript.map((block, index) => {
                const prev = index > 0 ? transcript[index - 1] : undefined;
                const showAvatar =
                  prev === undefined ||
                  prev.kind !== "text" ||
                  (prev.kind === "text" && prev.system === true);
                return (
                  <div key={block.id ?? `idx-${index}`} className="cv-block">
                    <BlockView
                      block={block}
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
 */
function SuperPendingArea({ session }: { session: SuperSessionUi }) {
  const send = useChat((s) => s.send);
  const pending = session.pending;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  if (!pending) return null;

  return (
    <div className="mx-2 mt-1.5 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1.5">
      <div className="text-ui-caption font-medium text-warning">{t("子会话需要你回答")}</div>
      <div className="mt-1 flex flex-col gap-2">
        {pending.questions.map((question) => (
          <div key={question.header} className="flex flex-col gap-1">
            <div className="text-ui-caption text-foreground">{question.question}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {question.options.map((option) => {
                const selected = answers[question.header];
                const isOn = Array.isArray(selected)
                  ? selected.includes(option.label)
                  : selected === option.label;
                return (
                  <Button
                    key={option.label}
                    variant={isOn ? "outline-primary" : "canvas"}
                    size="sm"
                    onClick={() => {
                      setAnswers((prev) => {
                        const current = prev[question.header];
                        if (question.multiSelect) {
                          const list = Array.isArray(current) ? current : current ? [current] : [];
                          return {
                            ...prev,
                            [question.header]: list.includes(option.label)
                              ? list.filter((v) => v !== option.label)
                              : [...list, option.label],
                          };
                        }
                        return { ...prev, [question.header]: option.label };
                      });
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1">
        <Button
          variant="primary"
          size="sm"
          onClick={() => send({ type: "superAgent", action: "respond", sessionId: session.id, answers })}
        >
          {t("提交回答")}
        </Button>
      </div>
    </div>
  );
}
