import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, Pencil, Eye } from "lucide-react";
import type { PendingPlanExitUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { CountdownBar } from "./ui";
import { Markdown } from "./Markdown";

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
  // Plan body render/edit modes: the agent's plan is markdown, rendered via
  // the shared Markdown component; 编辑计划 switches to a textarea draft so
  // the user can revise it before 重新规划 (the edited text rides the
  // `reason` field of respondPlanExit — the host already forwards it to the
  // CLI as the rejection reason the agent sees).
  const [editing, setEditing] = useState(false);
  const [planText, setPlanText] = useState(pending.plan);
  const actionsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const answer = (approved: boolean, replan = false) => {
    if (answered) return;
    setAnswered(true);
    const edited = planText !== pending.plan ? planText : undefined;
    send({
      type: "respondPlanExit",
      id: pending.id,
      approved,
      replan,
      // Edited text only matters when replanning (the agent revises the plan);
      // approve/reject send the plan as-is with no reason.
      reason: replan ? edited : undefined,
    });
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
        <ClipboardCheck className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate text-[12px] font-semibold">{t("iFlow 请求退出 Plan 模式")}</span>
        <button
          type="button"
          disabled={answered}
          aria-label={editing ? t("预览计划") : t("编辑计划")}
          title={editing ? t("预览计划") : t("编辑计划")}
          className="press ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors duration-200 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? <Eye className="size-3" /> : <Pencil className="size-3" />}
          {editing ? t("预览") : t("编辑")}
        </button>
      </div>
      <div className="space-y-1.5 px-3 py-2.5 text-[12px]">
        <p className="text-[11px] text-muted-foreground">{t("退出 Plan 模式后将开始执行以下计划：")}</p>
        {editing ? (
          <textarea
            ref={textareaRef}
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
            aria-label={t("编辑计划")}
            spellCheck={false}
            /* mono + generous height: the plan is source-like markdown the
               user edits verbatim; min-height keeps short plans usable,
               max-h-64 caps the shrink-0 card like the render mode. */
            className="max-h-64 min-h-40 w-full resize-y rounded-lg border border-primary/40 bg-editor p-2 font-mono text-[11px] leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
        ) : (
          /* Markdown render + scroll cap: the plan text is uncapped (the
             agent's full plan); unbroken tokens used to punch through the
             card border, long ones grew the shrink-0 card unbounded. The
             cap now lives on the wrapper so the .md table/pre scroll rules
             stay intact inside. */
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border/60 bg-editor/60 p-2">
            <Markdown text={planText} />
          </div>
        )}
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
        <button
          disabled={answered}
          aria-label={t("重新规划")}
          className="press rounded-lg border border-primary/40 px-2.5 py-1 text-[11px] text-primary transition-all duration-200 hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(false, true)}
        >
          {t("重新规划")}
        </button>
      </div>
    </div>
  );
}
