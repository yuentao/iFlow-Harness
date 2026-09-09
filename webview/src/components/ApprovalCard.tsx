import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { PendingApprovalUi, PermissionOptionUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { FileRef } from "./ui";

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

/** Stable visual class per option kind, mirroring the reference design. */
function optionClass(kind: PermissionOptionUi["kind"]): string {
  if (kind.startsWith("allow")) return "bg-primary font-semibold text-primary-foreground hover:opacity-90";
  if (kind.startsWith("reject"))
    return "border border-destructive/40 text-destructive hover:bg-destructive/10";
  return "border border-border bg-surface text-foreground hover:bg-surface-2";
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

  return (
    <div
      ref={cardRef}
      className="stream-in glow-ring mx-3 mb-2 shrink-0 rounded-lg border border-primary/40 bg-card"
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
        <ShieldCheck className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold">{t("iFlow 请求执行工具")}</span>
      </div>
      <div className="space-y-1.5 px-3 py-2.5 text-[12px]">
        {/* break-words + scroll cap: the wire title is uncapped (whole shell
            commands / descriptions); unbroken tokens used to punch through
            the card border, long ones grew the shrink-0 card unbounded. */}
        <p className="max-h-40 overflow-y-auto break-words text-foreground/90">
          {approval.toolName && (
            <code className="mr-1.5 rounded bg-editor px-1.5 py-0.5 font-mono text-[11px]">
              {approval.toolName}
            </code>
          )}
          {approval.title}
        </p>
        {primary && (
          <p className="text-[11px] text-muted-foreground">
            <FileRef path={primary.path} line={primary.line} />
          </p>
        )}
      </div>
      <div ref={actionsRef} className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {options.map((opt) => (
          <button
            key={opt.optionId}
            disabled={answered}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-40 ${optionClass(opt.kind)}`}
            onClick={() => answer(opt.optionId)}
          >
            {opt.name}
          </button>
        ))}
        <button
          disabled={answered}
          className="rounded-md px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(null)}
        >
          {t("取消")}
        </button>
      </div>
    </div>
  );
}