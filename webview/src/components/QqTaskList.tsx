import { useState } from "react";
import { BellRing, Check, GitBranch, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { QqTaskUi } from "../../../shared/messages";
import { t } from "../i18n";
import { useChat } from "../store";
import { ActionRow, Button, Chip, Hint, ICON_INLINE, IconButton, TextInput } from "./ui";

/**
 * QQ 远程任务看板（Wave3-C）。
 *
 * 纯投影：每条 `QqTaskUi` 由宿主维护（终态粘性、幂等 upsert 都在宿主），这里
 * 只如实渲染状态与待办，并把用户动作经 `onAction` 交回宿主——组件自己不发
 * 消息、不改任务状态。
 */

export type QqTaskAction = "stop" | "approve" | "deny" | "answer" | "merge" | "discard" | "refresh";

export interface QqTaskListProps {
  tasks: QqTaskUi[];
  onAction: (taskId: string, action: QqTaskAction, text?: string) => void;
}

/** 一条列表最多渲染的行数；更长的任务列表只展示前 N 条并给出提示。 */
export const QQ_TASK_RENDER_LIMIT = 50;

function statusLabel(status: QqTaskUi["status"]): string {
  switch (status) {
    case "received":
      return t("已收到");
    case "validated":
      return t("已校验");
    case "queued":
      return t("排队中");
    case "dispatched":
      return t("已派发");
    case "running":
      return t("执行中");
    case "waiting_approval":
      return t("等待审批");
    case "waiting_answer":
      return t("等待回答");
    case "succeeded":
      return t("已完成");
    case "failed":
      return t("失败");
    case "canceled":
      return t("已取消");
    case "timeout":
      return t("已超时");
    case "needs_review":
      return t("待复核");
  }
}

/** 中性 = 还没真正开始；成功 / 警告 / 错误 / 信息各占一档。 */
function statusTone(status: QqTaskUi["status"]): "muted" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "timeout":
      return "danger";
    case "waiting_approval":
    case "waiting_answer":
    case "needs_review":
      return "warning";
    case "running":
    case "dispatched":
      return "info";
    default:
      return "muted";
  }
}

/** 会话 id 脱敏：保留前两位与末两位，中间固定 4 个星号。 */
export function maskQqChatId(chatId: string): string {
  const id = chatId.trim();
  if (id.length <= 4) return "***";
  return `${id.slice(0, 2)}****${id.slice(-2)}`;
}

/** 耗时：秒 / 分秒 / 时分三档，只用于已产生的时长。 */
export function formatQqDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t("{0} 小时 {1} 分", hours, minutes);
  if (minutes > 0) return t("{0} 分 {1} 秒", minutes, seconds);
  return t("{0} 秒", seconds);
}

function TaskRow({
  task,
  onAction,
}: {
  task: QqTaskUi;
  onAction: QqTaskListProps["onAction"];
}) {
  const [answer, setAnswer] = useState("");
  const source = task.chatType === "private" ? t("私聊") : t("群聊");
  const pendingKind = task.pending?.kind;
  const canStop =
    task.status === "received" ||
    task.status === "validated" ||
    task.status === "queued" ||
    task.status === "dispatched" ||
    task.status === "running";
  const canReview = task.status === "succeeded" || task.status === "needs_review";
  const canDiscard = Boolean(task.branch) && (canReview || task.status === "failed" || task.status === "canceled" || task.status === "timeout");
  const hasChangeStats =
    Boolean(task.branch) ||
    typeof task.changes === "number" ||
    typeof task.additions === "number" ||
    typeof task.deletions === "number";

  return (
    <article data-qq-task={task.taskId} className="rounded-lg border border-border bg-surface/50 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 font-mono text-ui-caption text-muted-foreground">#{task.shortId}</span>
        <Chip tone={statusTone(task.status)}>{statusLabel(task.status)}</Chip>
        <span className="min-w-0 truncate text-ui-caption text-muted-foreground">
          {source} · {maskQqChatId(task.chatId)}
        </span>
        <span className="ml-auto shrink-0 text-ui-caption text-muted-foreground">
          {t("耗时 {0}", formatQqDuration(task.updatedAt - task.createdAt))}
        </span>
      </div>

      <p className="mt-1 truncate text-ui-label text-foreground" title={task.promptPreview}>
        {task.promptPreview || t("（没有提示词）")}
      </p>

      {hasChangeStats && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-ui-caption text-muted-foreground">
          {task.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className={`${ICON_INLINE} shrink-0`} />
              <span className="truncate font-mono">{task.branch}</span>
            </span>
          )}
          {typeof task.changes === "number" && <span>{t("{0} 个文件", task.changes)}</span>}
          {typeof task.additions === "number" && <span className="text-success">+{task.additions}</span>}
          {typeof task.deletions === "number" && <span className="text-destructive">-{task.deletions}</span>}
        </div>
      )}

      {task.errorMessage && (
        <p
          className={`mt-1 break-words text-ui-caption leading-relaxed ${
            task.status === "canceled" ? "text-warning" : "text-destructive"
          }`}
        >
          {task.errorMessage}
        </p>
      )}

      {task.pending && (
        <div className="mt-2 rounded-md border border-warning/45 bg-warning/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-ui-caption font-semibold text-warning">
            <BellRing className={`${ICON_INLINE} shrink-0`} />
            {pendingKind === "approval" ? t("等待你的审批") : t("等待你的回答")}
          </div>
          <p className="mt-1 break-words text-ui-caption leading-relaxed text-foreground/90">{task.pending.summary}</p>
          {pendingKind === "answer" && (
            <div className="mt-2 flex items-center gap-1.5">
              <TextInput
                className="min-w-0 flex-1"
                value={answer}
                placeholder={t("回答内容")}
                aria-label={t("回答任务 {0}", task.shortId)}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <Button
                size="sm"
                icon={<Check className={ICON_INLINE} />}
                disabled={!answer.trim()}
                onClick={() => {
                  onAction(task.taskId, "answer", answer);
                  setAnswer("");
                }}
              >
                {t("提交回答")}
              </Button>
            </div>
          )}
        </div>
      )}

      <ActionRow className="mt-2">
        {canStop && (
          <Button size="sm" variant="danger" icon={<X className={ICON_INLINE} />} onClick={() => onAction(task.taskId, "stop")}>
            {t("停止")}
          </Button>
        )}
        {pendingKind === "approval" && (
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<ShieldCheck className={ICON_INLINE} />}
              onClick={() => onAction(task.taskId, "approve")}
            >
              {t("批准")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<X className={ICON_INLINE} />}
              onClick={() => onAction(task.taskId, "deny")}
            >
              {t("拒绝")}
            </Button>
          </>
        )}
        {canReview && (
          <Button size="sm" variant="primary" icon={<GitBranch className={ICON_INLINE} />} onClick={() => onAction(task.taskId, "merge")}>
            {t("合并")}
          </Button>
        )}
        {canDiscard && (
          <Button size="sm" variant="danger" onClick={() => onAction(task.taskId, "discard")}>
            {t("丢弃")}
          </Button>
        )}
        <IconButton
          className="ml-auto"
          size="sm"
          icon={<RefreshCw className={ICON_INLINE} />}
          label={t("刷新任务 {0}", task.shortId)}
          onClick={() => onAction(task.taskId, "refresh")}
        />
      </ActionRow>
    </article>
  );
}

export function QqTaskList({ tasks, onAction }: QqTaskListProps) {
  const visible = tasks.slice(0, QQ_TASK_RENDER_LIMIT);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-ui-body font-semibold text-foreground">{t("远程任务")}</h3>
        <Chip tone="muted">{t("共 {0} 条", tasks.length)}</Chip>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-ui-label text-foreground">{t("还没有远程任务")}</p>
          <Hint className="mt-1">{t("在 QQ 里发送 /qq task <任务描述> 就能派发一个任务。")}</Hint>
        </div>
      ) : (
        <>
          {visible.map((task) => (
            <TaskRow key={task.taskId} task={task} onAction={onAction} />
          ))}
          {tasks.length > QQ_TASK_RENDER_LIMIT && (
            <Hint>{t("只显示前 {0} 条，共 {1} 条。", QQ_TASK_RENDER_LIMIT, tasks.length)}</Hint>
          )}
        </>
      )}
    </div>
  );
}

/** Stable empty list: a zustand selector must not mint a new array per render. */
const EMPTY_QQ_TASKS: QqTaskUi[] = [];

/**
 * 远程任务区的宿主接线层（Wave3-C）。
 *
 * `QqTaskList` 保持纯展示；这一层只做两件事：读 store 的 `qqTasks` 投影，
 * 把行内动作统一转成 `qqTaskAction` 消息。没有任务时渲染 null —— 远程任务
 * 区只在真的存在任务时出现在看板附近。
 */
export function QqTasksPanel() {
  const tasks = useChat((s) => s.state?.qqTasks) ?? EMPTY_QQ_TASKS;
  const send = useChat((s) => s.send);
  if (tasks.length === 0) return null;
  return (
    <section
      aria-label={t("远程任务")}
      className="mx-3 my-1 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-panel/40"
    >
      <div className="max-h-[30vh] overflow-y-auto px-3 py-2">
        <QqTaskList
          tasks={tasks}
          onAction={(taskId, action, text) =>
            send({
              type: "qqTaskAction",
              taskId,
              action,
              ...(text !== undefined ? { text } : {}),
            })
          }
        />
      </div>
    </section>
  );
}
