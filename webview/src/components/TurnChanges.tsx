import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, FilePen, History, Undo2 } from "lucide-react";
import type { Block, CheckpointUi, HostToWebview, TurnChangeUi } from "../../../shared/messages";
import { canReviewTurn, isLatestTurn } from "../../../shared/turn-changes";
import { ConfirmDialog, HelpTip, ICON_INLINE, IconButton } from "./ui";
import { useChat } from "../store";
import { t } from "../i18n";

let requestSequence = 0;

/**
 * Stable empty fallbacks — a fresh `[]` per selector call would change the
 * selector's identity on every store update (zustand compares with
 * Object.is), and the card would re-render on every patch.
 */
const EMPTY_BLOCKS: Block[] = [];
const EMPTY_CHECKPOINTS: CheckpointUi[] = [];

/** Basename for the row label; the full path stays in the tooltip. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function dirName(path: string): string {
  const base = baseName(path);
  return path.slice(0, path.length - base.length).replace(/[\\/]+$/, "");
}

function statusLabel(status: TurnChangeUi["status"]): string {
  return t(status === "completed" ? "已完成" : status === "failed" ? "失败" : status === "pending" ? "等待执行" : "执行中");
}

/**
 * Inline turn-change summary: rendered at the end of every completed turn
 * with recorded tool diffs, in the style of the competitors' changed-files
 * card (count + line totals + one row per file). The Host aggregates files
 * and computes counts (the webview may have evicted old diff payloads).
 * Clicking a row opens that file in the editor — no inline diff body.
 */
function TurnChangesInner({ sessionId, userBlockId }: {
  sessionId: string; userBlockId: string;
}) {
  const [records, setRecords] = useState<TurnChangeUi[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [confirmRollback, setConfirmRollback] = useState(false);
  // P-2-1 atomic selectors. The card used to subscribe to the WHOLE session
  // state (`useChat((s) => s.state)`): the host replaces that object on every
  // snapshot/patch, so every turn-change card in the transcript re-rendered
  // on every patch (12.5/s while streaming) — and a session with many turns
  // has one card per turn. Each subscription below is a primitive or a
  // stable reference, so a card only wakes when something it shows moved.
  const blocks = useChat((s) => s.state?.blocks ?? EMPTY_BLOCKS);
  const checkpoints = useChat((s) => s.state?.checkpoints ?? EMPTY_CHECKPOINTS);
  // One token for every field `canReviewTurn` reads besides `blocks`. The
  // token is a primitive, so it only changes when one of those fields does
  // — a metadata-only patch (mode / model / usage) leaves it untouched.
  const reviewGate = useChat((s) => {
    const st = s.state;
    if (!st) return "";
    return [
      st.sessionId ?? "",
      st.initializing ? "1" : "0",
      st.replaying ? "1" : "0",
      st.status ?? "",
      st.pendingApproval?.id ?? "",
      st.pendingQuestions?.id ?? "",
      st.pendingProfileSwitch?.id ?? "",
    ].join("|");
  });
  const valid = useMemo(() => {
    const st = useChat.getState().state;
    if (!st || st.sessionId !== sessionId) return false;
    return canReviewTurn(st, userBlockId);
    // `reviewGate` stands in for every non-block field `canReviewTurn` reads.
  }, [sessionId, userBlockId, blocks, reviewGate]);

  // ONE window listener for the whole card; the handler lives in a ref so a
  // re-render (or the refresh counter) never re-registers it. The old code
  // tore down and re-added a listener on every refresh — and every finished
  // turn added its own pair of listeners, so a session with N turns carried
  // 2N live listeners.
  const handlerRef = useRef<(event: MessageEvent<HostToWebview>) => void>(() => {});
  const requestIdRef = useRef("");
  const sessionIdRef = useRef(sessionId);
  const userBlockIdRef = useRef(userBlockId);
  sessionIdRef.current = sessionId;
  userBlockIdRef.current = userBlockId;
  handlerRef.current = (event: MessageEvent<HostToWebview>) => {
    const msg = event.data;
    if (!msg) return;
    const currentSessionId = sessionIdRef.current;
    const currentUserBlockId = userBlockIdRef.current;
    if (msg.type === "turnChanges") {
      if (msg.requestId !== requestIdRef.current) return;
      if (msg.sessionId !== currentSessionId || msg.userBlockId !== currentUserBlockId) return;
      const current = useChat.getState().state;
      if (!current || current.sessionId !== currentSessionId || !canReviewTurn(current, currentUserBlockId)) return;
      setRecords(msg.records);
      setUnavailable(msg.unavailable);
      return;
    }
    if (msg.type === "turnFileReverted") {
      if (msg.sessionId !== currentSessionId || msg.userBlockId !== currentUserBlockId) return;
      setRefresh((value) => value + 1);
    }
  };
  useEffect(() => {
    const listener = (event: MessageEvent<HostToWebview>) => handlerRef.current(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  // Ask the host for this turn's change records — on mount, when the turn
  // changes, and after a file revert (the host answers with fresh records).
  useEffect(() => {
    const requestId = `turn-changes-${++requestSequence}`;
    requestIdRef.current = requestId;
    useChat.getState().send({ type: "requestTurnChanges", sessionId, userBlockId, requestId });
  }, [sessionId, userBlockId, refresh]);
  if (!valid) return null;
  const additions = records?.reduce((sum, item) => sum + item.additions, 0) ?? 0;
  const deletions = records?.reduce((sum, item) => sum + item.deletions, 0) ?? 0;
  const latest = isLatestTurn(blocks, userBlockId);
  // UI-audit 4.3 P1: turn rollback lives in this footer; the user bubble keeps
  // 复制/编辑/删除 only. Same three-action ConfirmDialog and restoreCheckpoint
  // message as the per-turn user block.
  const checkpoint = checkpoints.find((c) => c.userBlockId === userBlockId);
  const canRollbackFiles = !!checkpoint && !checkpoint.partial;
  const rollback = (mode: "files" | "conversation" | "both") => {
    setConfirmRollback(false);
    useChat.getState().send({ type: "restoreCheckpoint", userBlockId, mode });
  };
  return (
    <>
    <section className="mt-2 rounded-lg border border-border bg-card/70 shadow-card" aria-label={t("本轮变更")}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <FilePen className="size-3.5 shrink-0 text-info" />
        <span className="text-ui-caption font-semibold text-foreground">
          {records === null || unavailable ? t("本轮变更") : records.length === 1 ? t("1 个文件已更改") : t("{0} 个文件已更改", records.length)}
        </span>
        {!!records?.length && <span className="flex items-center gap-1.5 font-mono text-ui-micro">
          <span className="text-diff-add-fg">+{additions}</span>
          <span className="text-diff-del-fg">−{deletions}</span>
        </span>}
        {!!records?.length && <HelpTip label={t("变更说明")} className="ml-auto">{t("这里只列出 iFlow 记录到改动的文件，可能不包含你手动改的内容，也不代表文件现在的最终差异。点击文件可在编辑器中打开。")}</HelpTip>}
      </div>
      <div className="space-y-2 p-3">
        {(unavailable || !records?.length) && <div role="status" className="text-ui-micro text-muted-foreground">
          {unavailable ? t("这一轮的变更记录已不可用。") : records === null ? t("正在读取本轮变更…") : t("本轮没有可显示的改动记录；这不表示没有文件修改。")}
        </div>}
        {!!records?.length && <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
          {records.map((item) => <li key={item.key} className="flex items-center bg-editor transition-colors hover:bg-surface">
            <button
              data-testid="turn-change-open"
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left focus-visible:bg-surface"
              title={`${item.key !== item.path ? `${item.key} (${item.path})` : item.path}\n${item.title} · ${statusLabel(item.status)}\n${t("在编辑器中打开")}`}
              onClick={() => useChat.getState().send({ type: "openLocation", path: item.path, toolCallId: item.toolCallId })}
            >
              <FileCode2 className="size-3.5 shrink-0 text-info" />
              <span className="min-w-0 flex-1 truncate text-ui-caption">
                <span className="text-foreground">{baseName(item.path)}</span>
                {dirName(item.key) && <span className="ml-1.5 text-ui-micro text-muted-foreground">{dirName(item.key)}</span>}
              </span>
              {(item.reverted || item.partiallyReverted || item.edits > 1) && <span className="shrink-0 text-ui-micro text-muted-foreground">
                {item.reverted ? t("已回退") : item.partiallyReverted ? t("部分回退") : t("{0} 次修改", item.edits)}
              </span>}
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-ui-micro">
                <span className="text-diff-add-fg">+{item.additions}</span>
                <span className="text-diff-del-fg">−{item.deletions}</span>
              </span>
            </button>
            {item.canUndo && !item.reverted && latest && (
              <IconButton
                icon={<Undo2 className={ICON_INLINE} />}
                label={t("回退此文件的本轮修改")}
                size="sm"
                tone="danger"
                className="mr-1.5"
                onClick={() => useChat.getState().send({ type: "revertTurnFile", sessionId, userBlockId, key: item.key })}
              />
            )}
          </li>)}
        </ul>}
        {!!records?.length && latest && checkpoint && (
          <IconButton
            icon={<History className="size-3" />}
            label={t("回滚这一轮")}
            size="sm"
            tone="danger"
            onClick={() => setConfirmRollback(true)}
          />
        )}
      </div>
    </section>
      {confirmRollback && (
        <ConfirmDialog
          title={t("回滚到这一轮之前")}
          message={
            canRollbackFiles
              ? t("选择回滚范围：只把文件回退到这一轮之前、只删除这条消息及之后的对话，或两者都做。")
              : t("这一轮的快照不完整，无法回退文件，只能删除这条消息及之后的对话。")
          }
          onCancel={() => setConfirmRollback(false)}
          actions={[
            {
              label: t("文件"),
              title: canRollbackFiles ? t("只把工作区文件回退到这一轮之前") : t("这一轮的快照不完整，无法回退文件"),
              disabled: !canRollbackFiles,
              onClick: () => rollback("files"),
            },
            {
              label: t("对话"),
              title: t("只删除这条消息及之后的所有对话"),
              onClick: () => rollback("conversation"),
            },
            {
              label: t("全部"),
              title: canRollbackFiles ? t("回退文件，并删除这条消息及之后的对话") : t("这一轮的快照不完整，无法回退文件"),
              variant: "primary",
              onClick: () => rollback("both"),
            },
          ]}
        />
      )}
    </>
  );
}
TurnChangesInner.displayName = "TurnChanges";

/**
 * Memoized card: the transcript renders one of these per finished turn, and
 * its parent (MessageList) re-renders on every patch. The props are two
 * stable strings, so React can skip the card entirely; the card's own
 * subscriptions (atomic selectors) still wake it when its own data moves.
 */
export const TurnChanges = memo(TurnChangesInner);