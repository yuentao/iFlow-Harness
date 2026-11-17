import { BellRing, GitBranch, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { QqTaskUi } from "../../../shared/messages";
import { maskQqOpenId } from "../../../shared/qq-access";
import { t } from "../i18n";
import { useChat } from "../store";
import { ActionRow, Button, Chip, Hint, ICON_INLINE, IconButton } from "./ui";

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
    case "injected":
      return t("已注入待回复");
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
    case "discarded":
      return t("已丢弃");
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
    case "injected":
      return "info";
    default:
      return "muted";
  }
}

/*
 * chatId（单聊的 openid / 群聊的群 openid）与设置页的白名单、待审核区用同一套
 * 脱敏：`maskQqOpenId`（前 4 + 固定 8 个星号 + 后 4）。原先这里另有一个
 * `maskQqChatId`（前 2 + 4 星 + 末 2），同一功能两套口径会让用户以为看到的是
 * 不同的 id；那个函数只用于展示，已删除。
 */

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
  const source = task.chatType === "private" ? t("私聊") : t("群聊");
  const pendingKind = task.pending?.kind;
  const canStop =
    task.status === "received" ||
    task.status === "validated" ||
    task.status === "queued" ||
    task.status === "dispatched" ||
    task.status === "injected" ||
    task.status === "running";
  // 合并是子会话渠道的动作：主会话渠道没有自己的分支，按钮不该出现
  // （点了只会回一句「没有可合并的分支」，读起来像失败）。
  const canReview =
    Boolean(task.branch) &&
    (task.status === "succeeded" || task.status === "needs_review");
  const canDiscard = Boolean(task.branch) && (canReview || task.status === "failed" || task.status === "canceled" || task.status === "timeout");
  // 已丢弃 = 处置完毕：产物（worktree/分支）可能已经不存在，任何动作按钮
  // （停止/审批/合并/丢弃/刷新）都只会产出误导或失败，整行收起。
  const discarded = task.status === "discarded";
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
        {/* 策略 chip 只在宿主回填了 policy 时出现：看板不猜，缺省就不显示。 */}
        {task.policy && (
          <Chip tone={task.policy === "trusted" ? "warning" : "muted"}>
            {task.policy === "trusted"
              ? t("免确认")
              : task.policy === "supervised"
                ? t("需审批")
                : t("只读")}
          </Chip>
        )}
        <span className="min-w-0 truncate text-ui-caption text-muted-foreground">
          {source} · {maskQqOpenId(task.chatId)}
        </span>
        <Chip tone={task.channel === "main" ? "info" : "muted"}>
          {task.channel === "main" ? t("渠道：主会话") : t("渠道：子会话")}
        </Chip>
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
            task.status === "canceled" || discarded ? "text-warning" : "text-destructive"
          }`}
        >
          {task.errorMessage}
        </p>
      )}

      {/* 丢弃处置说明：工作目录是否删掉、分支是否因未合并提交被保留。 */}
      {task.discardNote && (
        <p className="mt-1 break-words text-ui-caption leading-relaxed text-muted-foreground">
          {task.discardNote}
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
            // 提问通道（_iflow/user/questions）还没接到 QQ：这里原先的「提交回答」
            // 输入框点了也只是个死路（宿主侧 `answerTask` 恒回「没有等待回答的
            // 问题」）。如实说明，不保留看似可用的入口。
            <Hint className="mt-1">
              {t("提问通道尚未接通，暂不支持在此回答；可停止任务后重新派发。")}
            </Hint>
          )}
        </div>
      )}

      {!discarded && (
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
      )}
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
