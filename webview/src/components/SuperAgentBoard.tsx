import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  Loader2,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import type { SuperIntegrationState, SuperSessionUi } from "../../../shared/super-agent";
import { summarizeSuperSessions, superIntegrationLabel } from "../../../shared/super-agent";
import { useChat } from "../store";
import { t } from "../i18n";
import {
  Button,
  Chip,
  ConfirmDialog,
  Field,
  ICON_INLINE,
  IconButton,
  TextArea,
  TextInput,
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

function isActive(session: SuperSessionUi): boolean {
  return session.status === "preparing" || session.status === "running" || session.status === "awaiting_input";
}

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
 * Super Agent board — the management surface for the main session's child
 * sessions.
 *
 * Every child runs in its own git worktree (its own branch, its own
 * directory), so several of them can edit the same project at the same time
 * without colliding. The board is where the user sees them, answers their
 * pending questions, interrupts them, merges their branch back, or cleans
 * them up.
 *
 * The board is NOT the transcript: a child's transcript stays in its own
 * process; here we only show its status, its summary and its pending
 * request.
 */
export function SuperAgentBoard() {
  const sessions = useChat((s) => s.state?.superSessions);
  const send = useChat((s) => s.send);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
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

  useEffect(() => {
    if (active.length === 0) return;
    const timer = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);

  // Nothing to manage and nothing to compose → the board stays out of the way.
  if (list.length === 0 && !composing) return null;

  const submit = () => {
    const trimmedTask = task.trim();
    if (!trimmedTask) return;
    send({ type: "superAgent", action: "spawn", title: title.trim(), task: trimmedTask });
    setTitle("");
    setTask("");
    setComposing(false);
    setExpanded(true);
  };

  return (
    <div className="mx-3 mb-2 shrink-0 rounded-lg border border-border bg-surface/70 shadow-card">
      {/* Header row: the board's collapsed form is a single line so it never
          steals space from the transcript. `flex-wrap` keeps the action
          cluster usable on narrow panels — the chips are shrink-0, so without
          wrapping a ~320px panel would scroll horizontally. */}
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t("展开子会话看板")}
          title={t("展开子会话看板")}
          className="press flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 text-ui-label font-medium text-foreground hover:bg-accent/60"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className={ICON_INLINE} /> : <ChevronRight className={ICON_INLINE} />}
          <span className="shrink-0">{t("子会话")}</span>
          <span className="text-ui-caption text-muted-foreground">({list.length})</span>
        </button>
        {counts.running > 0 && (
          <Chip tone="primary">
            <Loader2 className="size-2.5 animate-spin" /> {t("{0} 个进行中", counts.running)}
          </Chip>
        )}
        {counts.awaiting > 0 && <Chip tone="warning">{t("{0} 个待处理", counts.awaiting)}</Chip>}
        {counts.done > 0 && <Chip tone="success">{t("{0} 个已完成", counts.done)}</Chip>}
        {counts.failed > 0 && <Chip tone="danger">{t("{0} 个未成功", counts.failed)}</Chip>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {active.length > 0 && (
            <Button
              variant="canvas"
              size="sm"
              icon={<Square className={ICON_INLINE} />}
              onClick={() => send({ type: "superAgent", action: "cancelAll" })}
            >
              {t("全部中断")}
            </Button>
          )}
          <Button
            variant="canvas"
            size="sm"
            icon={<Plus className={ICON_INLINE} />}
            onClick={() => setComposing((v) => !v)}
          >
            {t("新建子会话")}
          </Button>
        </div>
      </div>

      {composing && (
        <div className="border-t border-border px-2 py-2">
          <div className="flex flex-col gap-2">
            <Field label={t("任务标题")}>
              <TextInput
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("例如：修复登录跳转")}
                aria-label={t("任务标题")}
              />
            </Field>
            <Field label={t("任务说明（子会话看不到当前对话，请写完整）")}>
              <TextArea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={4}
                placeholder={t("例如：修复 src/auth.ts 的登录跳转逻辑，并补一个单测")}
                aria-label={t("任务说明")}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" disabled={!task.trim()} onClick={submit}>
                {t("派发")}
              </Button>
              <Button
                variant="canvas"
                size="sm"
                onClick={() => {
                  setComposing(false);
                  setTitle("");
                  setTask("");
                }}
              >
                {t("取消")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {expanded && list.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border px-2 py-2">
          {list.map((session) => (
            <SuperSessionRow
              key={session.id}
              session={session}
              onMerge={() => setConfirmMerge(session)}
              onCleanup={() => setConfirmCleanup(session)}
            />
          ))}
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
            "删除子会话「{0}」的工作目录？分支上未合并的提交会被保留。",
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
  const chip = statusChip(session);
  const started = session.startedAt ?? session.createdAt;
  const ended = session.endedAt ?? Date.now();

  return (
    <div className="rounded-md border border-border bg-canvas/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui-label font-medium" title={session.title}>
          {session.title}
        </span>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="shrink-0 text-ui-caption tabular-nums text-muted-foreground">
          {formatElapsed(ended - started)}
        </span>
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

      {/* Isolation line: the worktree path + branch, mono and selectable. The
          user needs the branch name to inspect the work, and the 免确认 chip
          states up front that child tool calls are never approved by hand. */}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-ui-caption text-muted-foreground">
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

      {session.error && (
        <div className="mt-1 break-words text-ui-caption text-destructive">{session.error}</div>
      )}

      {session.summary && (
        <div className="mt-1">
          <button
            type="button"
            className="press text-left text-ui-caption text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowDetail((v) => !v)}
          >
            {showDetail ? t("收起摘要") : t("查看摘要")}
          </button>
          {showDetail && (
            <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-editor/60 px-2 py-1 text-ui-caption text-foreground">
              {session.summary}
            </div>
          )}
        </div>
      )}

      {/* Integration result: what happened to the branch when the child
          finished (auto-merge / PR / kept for manual merge). */}
      {session.integration && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-ui-caption text-muted-foreground">
          <Chip tone={INTEGRATION_TONE[session.integration.state]}>
            {t(superIntegrationLabel(session.integration))}
          </Chip>
          {session.integration.url ? (
            <span className="min-w-0 flex-1 truncate font-mono" title={session.integration.url}>
              {session.integration.url}
            </span>
          ) : (
            session.integration.detail && (
              <span className="min-w-0 flex-1 truncate" title={session.integration.detail}>
                {session.integration.detail}
              </span>
            )
          )}
        </div>
      )}

      {session.pending && (
        <SuperPendingArea session={session} />
      )}

      <div className="mt-1.5 flex items-center gap-1">
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
    <div className="mt-1.5 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1.5">
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
