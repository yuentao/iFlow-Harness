import { useEffect, useRef, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import type { PendingPlanExitUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { CountdownBar } from "./ui";

/**
 * Plan-mode exit confirmation card. Rendered when the host surfaces a pending
 * `_iflow/plan/exit`; disappears once answered.
 * Note: like the approval card, this arrives mid-prompt (status is "streaming")
 * — the buttons must NOT be gated on streaming state (the agent is blocked
 * waiting for this answer). See AGENTS.md trap #12.
 */
export function PlanExitCard({ pending }: { pending: PendingPlanExitUi }) {
  const send = useChat((s) => s.send);
  // Optimistic lock: the first click answers the request; every button is
  // disabled until the host's next snapshot removes the card. Prevents
  // double-fire on rapid clicks.
  const [answered, setAnswered] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  const answer = (approved: boolean) => {
    if (answered) return;
    setAnswered(true);
    send({ type: "respondPlanExit", id: pending.id, approved });
  };

  return (
    <div
      className="acrylic stream-in glow-ring card-lift mx-3 mb-2 shrink-0 rounded-xl border border-primary/40"
      role="alertdialog"
      aria-label={t("iFlow 请求退出 Plan 模式")}
      onKeyDown={(e) => {
        // Escape means "reject" — consistent with the card's dismissal
        // semantics (the host treats a missing answer as rejected too).
        // 拦下冒泡：等待确认时 status 仍是 streaming，事件漏到 window 会
        // 连带触发「ESC 停止生成」，一次按键双语义。
        if (e.key === "Escape") {
          e.stopPropagation();
          answer(false);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ClipboardCheck className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold">{t("iFlow 请求退出 Plan 模式")}</span>
      </div>
      <div className="space-y-1.5 px-3 py-2.5 text-[12px]">
        <p className="text-[11px] text-muted-foreground">{t("退出 Plan 模式后将开始执行以下计划：")}</p>
        {/* break-words + scroll cap: the plan text is uncapped (the agent's full
            plan); unbroken tokens used to punch through the card border, long
            ones grew the shrink-0 card unbounded. */}
        <pre className="max-h-48 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-editor/60 p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
          {pending.plan}
        </pre>
      </div>
      <CountdownBar deadline={pending.deadline} timeoutMs={pending.timeoutMs} />
      <div
        ref={actionsRef}
        role="group"
        aria-label={t("计划审批操作")}
        className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2"
      >
        <button
          disabled={answered}
          aria-label={t("批准计划")}
          className="press rounded-lg bg-gradient-to-b from-primary to-primary/90 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(true)}
        >
          {t("批准计划")}
        </button>
        <button
          disabled={answered}
          aria-label={t("拒绝计划")}
          className="press rounded-lg border border-destructive/40 px-2.5 py-1 text-[11px] text-destructive transition-all duration-200 hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(false)}
        >
          {t("拒绝计划")}
        </button>
      </div>
    </div>
  );
}
