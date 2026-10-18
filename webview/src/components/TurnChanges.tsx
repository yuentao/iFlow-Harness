import { useEffect, useState } from "react";
import { FileCode2, FilePen, Undo2 } from "lucide-react";
import type { HostToWebview, TurnChangeUi } from "../../../shared/messages";
import { canReviewTurn, isLatestTurn } from "../../../shared/turn-changes";
import { useChat } from "../store";
import { t } from "../i18n";

let requestSequence = 0;

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
export function TurnChanges({ sessionId, userBlockId }: {
  sessionId: string; userBlockId: string;
}) {
  const [records, setRecords] = useState<TurnChangeUi[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const state = useChat((s) => s.state);
  const valid = state?.sessionId === sessionId && canReviewTurn(state, userBlockId);
  useEffect(() => {
    const requestId = `turn-changes-${++requestSequence}`;
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      const current = useChat.getState().state;
      if (msg?.type !== "turnChanges" || msg.requestId !== requestId ||
          msg.sessionId !== sessionId || msg.userBlockId !== userBlockId ||
          current?.sessionId !== sessionId || !canReviewTurn(current, userBlockId)) return;
      setRecords(msg.records);
      setUnavailable(msg.unavailable);
    };
    window.addEventListener("message", handler);
    useChat.getState().send({ type: "requestTurnChanges", sessionId, userBlockId, requestId });
    return () => window.removeEventListener("message", handler);
  }, [sessionId, userBlockId, refresh]);
  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg?.type !== "turnFileReverted" ||
          msg.sessionId !== sessionId || msg.userBlockId !== userBlockId) return;
      setRefresh((value) => value + 1);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [sessionId, userBlockId]);
  if (!valid) return null;
  const additions = records?.reduce((sum, item) => sum + item.additions, 0) ?? 0;
  const deletions = records?.reduce((sum, item) => sum + item.deletions, 0) ?? 0;
  const latest = isLatestTurn(state.blocks, userBlockId);
  return (
    <section className="mt-2 overflow-hidden rounded-xl border border-border bg-card/70 shadow-card" aria-label={t("本轮变更")}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <FilePen className="size-3.5 shrink-0 text-info" />
        <span className="text-[11.5px] font-semibold text-foreground">
          {records === null || unavailable ? t("本轮变更") : records.length === 1 ? t("1 个文件已更改") : t("{0} 个文件已更改", records.length)}
        </span>
        {!!records?.length && <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
          <span className="text-diff-add-fg">+{additions}</span>
          <span className="text-diff-del-fg">−{deletions}</span>
        </span>}
      </div>
      <div className="space-y-2 p-2.5">
        {(unavailable || !records?.length) && <div role="status" className="text-[10.5px] text-muted-foreground">
          {unavailable ? t("该轮次已不可用。") : records === null ? t("正在读取本轮变更…") : t("本轮没有可展示的变更记录；这不表示没有文件修改。")}
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
              <span className="min-w-0 flex-1 truncate text-[11px]">
                <span className="text-foreground">{baseName(item.path)}</span>
                {dirName(item.key) && <span className="ml-1.5 text-[10px] text-muted-foreground">{dirName(item.key)}</span>}
              </span>
              {(item.reverted || item.partiallyReverted || item.edits > 1) && <span className="shrink-0 text-[9.5px] text-muted-foreground">
                {item.reverted ? t("已回退") : item.partiallyReverted ? t("部分回退") : t("{0} 次修改", item.edits)}
              </span>}
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
                <span className="text-diff-add-fg">+{item.additions}</span>
                <span className="text-diff-del-fg">−{item.deletions}</span>
              </span>
            </button>
            {item.canUndo && !item.reverted && latest && <button
              className="press mr-1.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t("撤销此文件的本轮修改")}
              aria-label={t("撤销此文件的本轮修改")}
              onClick={() => useChat.getState().send({ type: "revertTurnFile", sessionId, userBlockId, key: item.key })}
            >
              <Undo2 className="size-3.5" />
            </button>}
          </li>)}
        </ul>}
        {!!records?.length && <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("仅列出已记录的工具差异文件，不保证覆盖全部磁盘修改或代表当前净变更。点击文件在编辑器中打开。")}
        </p>}
      </div>
    </section>
  );
}