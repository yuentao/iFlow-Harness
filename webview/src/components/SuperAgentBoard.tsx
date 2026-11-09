import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  GitBranch,
  GitMerge,
  Info,
  Loader2,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Block } from "../../../shared/messages";
import type {
  SuperIntegrationState,
  SuperReportState,
  SuperSessionUi,
} from "../../../shared/super-agent";
import {
  canRetrySuperSession,
  sumSuperUsage,
  summarizeSuperSessions,
  superIntegrationLabel,
  superReportLabel,
} from "../../../shared/super-agent";
import { useChat } from "../store";
import { t } from "../i18n";
import { BlockView } from "./MessageList";
import {
  Button,
  Chip,
  ConfirmDialog,
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

/** Integration result → chip tone. */
const INTEGRATION_TONE: Record<
  SuperIntegrationState,
  "muted" | "success" | "primary" | "danger"
> = {
  merged: "success",
  pr_created: "primary",
  conflict: "danger",
  failed: "danger",
  skipped: "muted",
};

/** Report state → timeline chip tone. */
function reportTone(state: SuperReportState): "muted" | "success" | "warning" | "danger" | "info" {
  switch (state) {
    case "progress":
      return "info";
    case "ready":
      return "success";
    case "blocked":
      return "warning";
    case "failed":
      return "danger";
    case "dropped":
      return "muted";
  }
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

/** Last non-empty line of a multi-line progress/summary body. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? text.trim();
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
  // Ticking clock for the elapsed labels of live children.
  const [, setTick] = useState(0);

  const list = sessions ?? [];
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

  // Nothing to manage → the board stays out of the way.
  if (list.length === 0) return null;

  return (
    // `pointer-events-auto` re-enables hits inside App's pointer-events-none
    // top overlay shell (the gutters around the bar stay transparent to
    // transcript scroll). The surface is acrylic like the pending cards it
    // mirrors; ConfirmDialog portals to body, so it escapes this shelf.
    <div className="acrylic stream-in pointer-events-auto mx-3 mt-3 mb-2 shrink-0 overflow-hidden rounded-xl border border-border shadow-float">
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
            <Chip tone="success" title={t("{0} 个已完成", counts.done)}>
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
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {active.length > 0 && (
            <Button
              variant="canvas"
              size="sm"
              icon={<Square className={ICON_INLINE} />}
              aria-label={t("全部中断")}
              title={t("全部中断")}
              onClick={() => send({ type: "superAgent", action: "cancelAll" })}
            >
              <span className="@max-[380px]:hidden">{t("全部中断")}</span>
            </Button>
          )}
        </div>
      </div>

      {expanded && list.length > 0 && (
        <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto border-t border-border px-2 py-2">
          {list.map((session) => (
            <SuperSessionRow
              key={session.id}
              session={session}
              onMerge={() => setConfirmMerge(session)}
              onCleanup={() => setConfirmCleanup(session)}
            />
          ))}
          {(totals.input > 0 || totals.output > 0) && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-canvas/40 px-2 py-1.5 text-ui-micro text-muted-foreground">
              <span className="font-medium text-foreground">{t("子会话合计开销")}</span>
              <span className="tabular-nums">
                {t("输入 {0} · 输出 {1}", formatTokens(totals.input), formatTokens(totals.output))}
              </span>
              {totals.estimatedCost !== null && (
                <span className="tabular-nums">{formatCostPrecise(totals.estimatedCost)}</span>
              )}
              <span className="ml-auto">{t("按公开单价估算，仅供参考")}</span>
            </div>
          )}
        </div>
      )}

      {confirmMerge && (
        <ConfirmDialog
          title={t("合并子会话分支")}
          message={t(
            "把分支 {0} 合并到当前分支？这会改动你当前的工作分支，若有冲突会自动撤销并报错。",
            confirmMerge.isolation.branch ?? "",
          )}
          confirmLabel={t("合并")}
          onConfirm={() => {
            send({ type: "superAgent", action: "merge", sessionId: confirmMerge.id });
            setConfirmMerge(null);
          }}
          onCancel={() => setConfirmMerge(null)}
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

/** One child session row. */
function SuperSessionRow({
  session,
  onMerge,
  onCleanup,
}: {
  session: SuperSessionUi;
  onMerge: () => void;
  onCleanup: () => void;
}) {
  const send = useChat((s) => s.send);
  const [showDetail, setShowDetail] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const chip = statusChip(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? Date.now();
  const preview = session.progress ?? session.summary;

  return (
    <div className="shrink-0 rounded-md border border-border/80 bg-canvas/60 transition-colors hover:border-border">
      {/* Header line: status first so a long title ellipsizes instead of
          shoving the chip and duration off the row. */}
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="min-w-0 flex-1 truncate text-ui-label font-medium" title={session.title}>
          {session.title}
        </span>
        <span className="shrink-0 text-ui-micro tabular-nums text-muted-foreground">
          {formatElapsed(ended - started)}
        </span>
        {(session.attempts ?? 1) > 1 && (
          <Chip tone="muted">{t("第 {0} 次尝试", session.attempts ?? 1)}</Chip>
        )}
        <IconButton
          icon={<Info className={ICON_INLINE} />}
          label={t("查看进度详情")}
          size="sm"
          onClick={() => setShowDetail(true)}
        />
        {isActive(session) && (
          <IconButton
            icon={<Square className={ICON_INLINE} />}
            label={t("中断该子会话")}
            size="sm"
            tone="danger"
            onClick={() => send({ type: "superAgent", action: "cancel", sessionId: session.id })}
          />
        )}
      </div>

      {/* Isolation line: the worktree branch (path on hover), mono and
          selectable. Only the branch truncates — the 免确认 chip states up
          front that child tool calls are never approved by hand and must stay
          visible at any width. */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5 px-2 text-ui-caption text-muted-foreground">
        <GitBranch className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={session.isolation.path}>
          {session.isolation.branch ?? session.isolation.path}
        </span>
        {session.isolation.kind === "directory" && (
          <Chip tone="warning" title={session.isolation.note}>
            {t("仅目录隔离")}
          </Chip>
        )}
        <Chip tone="info" title={t("子会话始终免确认：工具调用不会被审批，也不需要你批准")}>
          {t("免确认")}
        </Chip>
      </div>

      {/* A pending question is the only thing that needs the user, so it sits
          directly under the isolation line instead of being buried below the
          summary. */}
      {session.pending && <SuperPendingArea session={session} />}

      {/* Live tail while running / final summary afterwards — clicking opens
          the detail modal instead of expanding a separate inline panel. */}
      {preview && (
        <button
          type="button"
          className="press mt-1 block w-full truncate px-2 text-left text-ui-caption text-muted-foreground hover:text-foreground"
          title={preview}
          onClick={() => setShowDetail(true)}
        >
          {lastLine(preview)}
        </button>
      )}

      {session.error && (
        <div className="mx-2 mt-1.5 break-words rounded-sm border border-destructive/30 bg-destructive/10 px-2 py-1 text-ui-caption text-destructive">
          {session.error}
        </div>
      )}

      {/* Live transcript entry: the child's own session/update stream opens
          in a dialog (see SuperSessionLive) instead of expanding inline — an
          inline pane pushed the neighbouring cards around and capped the
          stream at max-h-64, so the newest tool call was always the one
          squeezed out. The blocks ride a dedicated host channel; the child's
          transcript never enters the main transcript. */}
      <div className="mt-1 flex items-center px-2">
        <button
          type="button"
          className="press self-start text-left text-ui-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setShowLive(true)}
        >
          {t("查看实时操作")}
        </button>
      </div>

      {/* Footer strip: where the branch ended up, what the child cost, and the
          row's actions. Folding the old standalone token / integration rows in
          here shortens the card by two lines; `flex-wrap` lets the action
          cluster drop to its own row as a block on narrow panels. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-2 py-1.5">
        {session.integration && (
          <div className="flex min-w-0 items-center gap-1.5 text-ui-caption text-muted-foreground">
            <Chip tone={INTEGRATION_TONE[session.integration.state]}>
              {t(superIntegrationLabel(session.integration))}
            </Chip>
            {session.integration.url ? (
              <span className="min-w-0 truncate font-mono" title={session.integration.url}>
                {session.integration.url}
              </span>
            ) : (
              session.integration.detail && (
                <span className="min-w-0 truncate" title={session.integration.detail}>
                  {session.integration.detail}
                </span>
              )
            )}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {session.tokens && (
            <span
              className="flex items-center gap-1.5 font-mono text-ui-micro tabular-nums text-muted-foreground"
              title={t("输入为内核上报的末次请求上下文；输出按子会话文本估算")}
            >
              <span>
                ↑{formatTokens(session.tokens.input)} ↓{formatTokens(session.tokens.output)}
              </span>
              {session.tokens.estimatedCost !== null && session.tokens.estimatedCost !== undefined && (
                <span title={t("预估成本（token 估算 × 公开单价，仅供参考）")}>
                  {formatCost(session.tokens.estimatedCost)}
                </span>
              )}
            </span>
          )}
          <div className="flex items-center gap-1">
            {canRetrySuperSession(session) && (
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
              disabled={!session.isolation.branch || session.integration?.state === "merged"}
              title={
                session.integration?.state === "merged"
                  ? t("该子会话的改动已经合并")
                  : session.isolation.branch
                    ? t("把该子会话的分支合并到当前分支")
                    : t("该子会话没有可合并的分支")
              }
              onClick={onMerge}
            >
              {t("合并")}
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
      </div>

      {showLive && (
        <SuperSessionLive session={session} onClose={() => setShowLive(false)} />
      )}
      {showDetail && (
        <SuperSessionDetail session={session} onClose={() => setShowDetail(false)} />
      )}
    </div>
  );
}

/** One labelled block inside the detail modal. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="text-ui-caption font-medium text-muted-foreground">{title}</div>
      <div className="rounded-sm border border-border bg-canvas/60 px-2 py-1.5 text-ui-caption text-foreground">
        {children}
      </div>
    </section>
  );
}

/**
 * Full progress detail for one child session.
 *
 * The child's transcript lives in its own CLI process and is deliberately
 * never copied into the main store (it would pollute `blocks` and break the
 * blockPatch anchor). This modal therefore shows everything the host actually
 * observed: the task it was given, the live assistant tail, the report
 * timeline, the isolation boundary, the settled token usage and the
 * integration outcome.
 */
function SuperSessionDetail({
  session,
  onClose,
}: {
  session: SuperSessionUi;
  onClose: () => void;
}) {
  const chip = statusChip(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? Date.now();
  const usage = session.tokens;

  return (
    <ModalShell
      title={session.title}
      icon={<GitBranch className={ICON_INLINE} />}
      ariaLabel={t("子会话进度详情")}
      onClose={onClose}
      initialFocus="first"
      wide
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={chip.tone}>{chip.label}</Chip>
          <span className="text-ui-caption tabular-nums text-muted-foreground">
            {t("已运行 {0}", formatElapsed(ended - started))}
          </span>
          {session.model && <Chip tone="muted">{session.model}</Chip>}
        </div>

        <DetailSection title={t("任务")}>
          <p className="whitespace-pre-wrap break-words">{session.task}</p>
        </DetailSection>

        {session.progress && (
          <DetailSection title={t("实时进度")}>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-ui-micro">
              {session.progress}
            </pre>
          </DetailSection>
        )}

        {session.summary && (
          <DetailSection title={t("结果摘要")}>
            <p className="whitespace-pre-wrap break-words">{session.summary}</p>
          </DetailSection>
        )}

        <DetailSection title={t("进度记录")}>
          {session.reports.length === 0 ? (
            <p className="text-muted-foreground">{t("暂无进度记录")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {session.reports.map((report, index) => (
                <div key={`${report.at}-${index}`} className="flex min-w-0 items-start gap-2">
                  <span className="shrink-0 font-mono text-ui-micro text-muted-foreground">
                    {new Date(report.at).toLocaleTimeString()}
                  </span>
                  <Chip tone={reportTone(report.state)}>{t(superReportLabel(report.state))}</Chip>
                  <span className="min-w-0 flex-1 break-words">{report.summary}</span>
                </div>
              ))}
            </div>
          )}
        </DetailSection>

        <DetailSection title={t("隔离")}>
          <div className="flex flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <GitBranch className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 break-all font-mono">
                {session.isolation.branch ?? session.isolation.path}
              </span>
              {session.isolation.kind === "directory" && (
                <Chip tone="warning">{t("仅目录隔离")}</Chip>
              )}
            </div>
            {session.isolation.branch && (
              <div className="break-all font-mono text-ui-micro text-muted-foreground">
                {session.isolation.path}
              </div>
            )}
            {session.isolation.note && (
              <div className="text-ui-micro text-muted-foreground">{session.isolation.note}</div>
            )}
          </div>
        </DetailSection>

        <DetailSection title={t("Token 开销")}>
          {usage ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 tabular-nums">
                <span>{t("输入 {0} tokens", usage.input.toLocaleString())}</span>
                <span>{t("输出 {0} tokens", usage.output.toLocaleString())}</span>
                {usage.cachedRead !== undefined && usage.cachedRead > 0 && (
                  <span>{t("缓存读取 {0} tokens", usage.cachedRead.toLocaleString())}</span>
                )}
              </div>
              <div>
                {typeof usage.estimatedCost === "number"
                  ? t("预估成本 {0}（按公开单价估算）", formatCostPrecise(usage.estimatedCost))
                  : t("该模型无单价记录，不显示成本")}
              </div>
              <div className="text-ui-micro text-muted-foreground">
                {usage.authoritative
                  ? t("输入为内核上报的末次请求上下文；输出按子会话文本估算")
                  : t("输入按任务提示估算（内核未上报用量）；输出按子会话文本估算")}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">{t("子会话结束后统计 Token 开销")}</p>
          )}
        </DetailSection>

        {session.integration && (
          <DetailSection title={t("改动去向")}>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip tone={INTEGRATION_TONE[session.integration.state]}>
                {t(superIntegrationLabel(session.integration))}
              </Chip>
              {session.integration.url ? (
                <span className="break-all font-mono">{session.integration.url}</span>
              ) : session.integration.detail ? (
                <span className="break-words">{session.integration.detail}</span>
              ) : null}
            </div>
          </DetailSection>
        )}

        {session.error && (
          <DetailSection title={t("错误")}>
            <p className="break-words text-destructive">{session.error}</p>
          </DetailSection>
        )}
      </div>
    </ModalShell>
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

  return (
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
    </ModalShell>
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
