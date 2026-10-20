import { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import type { PendingApprovalUi, PermissionOptionUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { FileRef, CountdownBar, HelpTip } from "./ui";
import { DiffView } from "./DiffView";

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

/**
 * Visual risk tiering per option kind: a ONE-TIME allow is the primary action
 * (solid gradient), while an ALWAYS allow changes the safety boundary for the
 * whole session — it renders as a secondary outlined button with a lock glyph
 * so the two can never be conflated by muscle memory (visual audit P0-2).
 */
function optionClass(kind: PermissionOptionUi["kind"]): string {
  if (kind === "allow_once")
    return "bg-gradient-to-b from-primary to-primary/90 font-semibold text-primary-foreground shadow-btn hover:shadow-btn-hover hover:brightness-105";
  if (kind === "allow_always")
    return "border border-primary/40 bg-primary/10 font-medium text-primary hover:bg-primary/20";
  if (kind.startsWith("allow"))
    return "bg-gradient-to-b from-primary to-primary/90 font-semibold text-primary-foreground shadow-btn hover:shadow-btn-hover hover:brightness-105";
  if (kind.startsWith("reject"))
    return "border border-destructive/40 text-destructive hover:bg-destructive/10";
  return "border border-border bg-surface/80 text-foreground hover:bg-surface-2 shadow-card";
}

/**
 * Tool-execution approval card. Rendered when the host surfaces a pending
 * `session/request_permission`; disappears once answered.
 * Note: permission requests arrive mid-prompt (status is "streaming"), so the
 * buttons must NOT be gated on streaming state — the agent is blocked waiting
 * for this answer.
 */
export function ApprovalCard({ approval }: { approval: PendingApprovalUi }) {
  const send = useChat((s) => s.send);
  // Optimistic lock: the first click answers the request; every button is
  // disabled until the host's next snapshot removes the card. Prevents
  // double-fire on rapid clicks.
  const [answered, setAnswered] = useState(false);
  // W4: keyboard users should land on the action buttons, not tab through the
  // whole Composer. Scope the focus to the actions row — the card body may
  // contain other <button>s (FileRef file chips) that precede it. The first
  // button in the row is the highest-priority option (options are pre-sorted
  // by KIND_ORDER — allow variants first).
  const cardRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  const answer = (optionId: string | null) => {
    if (answered) return;
    setAnswered(true);
    send({ type: "respondApproval", id: approval.id, optionId });
  };

  const options = [...approval.options].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );

  const primary = approval.locations[0];
  // Y is deliberately bound to allow_once ONLY: binding it to whichever allow
  // variant comes first could silently grant an `allow_always` with one key.
  const allowOption = options.find((option) => option.kind === "allow_once");
  const rejectOption = options.find((option) => option.kind.startsWith("reject"));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (answered || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      // A modal above this card (settings / confirm) owns the keyboard; the
      // card is still mounted underneath and must not answer a hidden prompt.
      if (document.querySelector(".auth-backdrop")) return;
      const target = e.target as HTMLElement | null;
      if (
        target
        && (target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.tagName === "SELECT"
          || target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "y" && allowOption) {
        e.preventDefault();
        e.stopPropagation();
        setAnswered(true);
        send({ type: "respondApproval", id: approval.id, optionId: allowOption.optionId });
      } else if (key === "n") {
        e.preventDefault();
        e.stopPropagation();
        setAnswered(true);
        send({ type: "respondApproval", id: approval.id, optionId: rejectOption?.optionId ?? null });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [answered, allowOption?.optionId, rejectOption?.optionId, approval.id, send]);

  return (
    <div
      ref={cardRef}
      className="acrylic stream-in glow-ring card-lift pointer-events-auto mx-3 mb-2 shrink-0 rounded-xl border border-primary/40"
      role="alertdialog"
      aria-label={t("工具执行审批")}
      onKeyDown={(e) => {
        // W4: Escape means "cancel" — consistent with the card's dismissal
        // semantics (the host treats a missing answer as cancelled too).
        // 拦下冒泡：等待审批时 status 仍是 streaming，事件漏到 window 会
        // 连带触发「ESC 停止生成」，一次按键双语义。
        if (e.key === "Escape") {
          e.stopPropagation();
          answer(null);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate text-ui-label font-semibold">{t("iFlow 请求执行工具")}</span>
        <span className="ml-auto">
          <HelpTip label={t("审批说明")} align="right">
            <span className="block space-y-1">
              <span className="block">
                {t("允许会立即执行该工具；「始终允许」会在本次会话内记住该工具。")}
              </span>
              <span className="block">
                {t("拒绝或取消都不会执行；可在设置 → 审批策略中预审规则。")}
              </span>
              <span className="block font-mono text-ui-micro text-muted-foreground">
                {t("Y 允许一次 · N 拒绝 · Esc 取消")}
              </span>
            </span>
          </HelpTip>
        </span>
      </div>
      <div className="space-y-2 px-3 py-3 text-ui-label">
        {/* break-words + scroll cap: the wire title is uncapped (whole shell
            commands / descriptions); unbroken tokens used to punch through
            the card border, long ones grew the shrink-0 card unbounded. */}
        <p className="max-h-40 select-text overflow-y-auto break-words text-foreground/90">
          {approval.toolName && (
            <code className="mr-1.5 rounded bg-editor px-1.5 py-0.5 font-mono text-ui-caption">
              {approval.toolName}
            </code>
          )}
          {approval.title}
        </p>
        {primary && (
          <p className="text-ui-caption text-muted-foreground">
            <FileRef path={primary.path} line={primary.line} />
          </p>
        )}
      </div>
      {/* Pre-execution diff preview (edit tools only): the wire request itself
          carries old/new text, so the user approves the CHANGE, not a title.
          Read-only DiffView — hunk editing belongs to the post-completion
          tool card, not the approval gate. */}
      {approval.diff && (
        <div className="border-t border-border/60">
          <DiffView diff={approval.diff} maxHeightClass="max-h-[max(120px,calc(100vh-360px))]" />
        </div>
      )}
      <CountdownBar deadline={approval.deadline} timeoutMs={approval.timeoutMs} />
      <div ref={actionsRef} role="group" aria-label={t("审批操作")} className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {options.map((opt) => (
          <button
            key={opt.optionId}
            disabled={answered}
            aria-label={approval.toolName ? t("{0}（{1}）", opt.name, approval.toolName) : opt.name}
            className={`press inline-flex h-6 items-center justify-center gap-1 rounded-md px-2.5 text-ui-caption transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 ${optionClass(opt.kind)}`}
            onClick={() => answer(opt.optionId)}
          >
            {opt.kind === "allow_always" && <Lock className="size-3.5 shrink-0" />}
            {opt.name}
          </button>
        ))}
        <button
          disabled={answered}
          aria-label={t("取消审批")}
          className="press inline-flex h-6 items-center justify-center rounded-md border border-border bg-surface/80 px-2.5 text-ui-caption text-muted-foreground shadow-card transition-all duration-200 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(null)}
        >
          {t("取消")}
        </button>
        <span className="ml-auto self-center text-ui-micro text-muted-foreground/80">
          {t("Y 允许一次 · N 拒绝 · Esc 取消")}
        </span>
      </div>
    </div>
  );
}