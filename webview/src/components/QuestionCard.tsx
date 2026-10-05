import { useEffect, useRef, useState } from "react";
import { HelpCircle, Check, Circle, CircleDot, Square, CheckSquare, Plus } from "lucide-react";
import type { PendingQuestionsUi, UserAnswerValue } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { CountdownBar } from "./ui";

/**
 * When any option's description exceeds this length, the option row switches
 * from horizontal wrap (cards of uneven height, cramped 260px columns with
 * broken line-wraps) to a single-column full-width list, which stays readable
 * for long copy.
 */
const LONG_DESCRIPTION_CHARS = 30;

/**
 * ask_user_question card (iFlow `_iflow/user/questions`). One section per
 * question: option buttons (radio for single-select, toggle for
 * multiSelect), plus a free-text "Other" field. Answers are keyed by the
 * question's `header` — the wire contract the CLI's tool bridge expects.
 * Dismissing answers nothing: the agent proceeds with "no answer".
 *
 * Note: like ApprovalCard, questions arrive mid-prompt (status is
 * "streaming"), so buttons must NOT be gated on streaming state — the agent
 * is blocked waiting for this answer.
 */
export function QuestionCard({ pending }: { pending: PendingQuestionsUi }) {
  const send = useChat((s) => s.send);
  const [answered, setAnswered] = useState(false);
  // Per-question selection state: header → Set<label>, plus free text.
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() => ({}));
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});

  const toggle = (header: string, label: string, multiSelect: boolean) => {
    setSelected((prev) => {
      const current = prev[header] ?? new Set<string>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...prev, [header]: next };
    });
  };

  const buildAnswers = (): Record<string, UserAnswerValue> => {
    const answers: Record<string, UserAnswerValue> = {};
    for (const q of pending.questions) {
      const picks = selected[q.header] ?? new Set<string>();
      const free = custom[q.header]?.trim() ?? "";
      if (free) {
        // Free text wins over selections for that question.
        answers[q.header] = free;
      } else if (picks.size === 1 && !q.multiSelect) {
        answers[q.header] = [...picks][0]!;
      } else if (picks.size > 0) {
        answers[q.header] = [...picks];
      }
      // Unanswered questions are simply omitted — the CLI formats them as
      // "no answer".
    }
    return answers;
  };

  const submit = () => {
    if (answered) return;
    setAnswered(true);
    send({ type: "answerQuestions", id: pending.id, answers: buildAnswers() });
  };

  const dismiss = () => {
    if (answered) return;
    setAnswered(true);
    send({ type: "answerQuestions", id: pending.id, answers: {} });
  };

  // Mirror ApprovalCard (W4): keyboard users should land on the question's
  // actions, not stay trapped in the Composer. Focus the first option button
  // on mount; the card body may contain other buttons (custom-text toggles)
  // that precede it, so scope to the actions row.
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  return (
    <div
      className="acrylic stream-in glow-ring card-lift pointer-events-auto mx-3 mb-2 shrink-0 rounded-xl border border-primary/40"
      role="alertdialog"
      aria-label={t("iFlow 提问")}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <HelpCircle className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate text-[12px] font-semibold">{t("iFlow 需要你的回答")}</span>
      </div>
      {/* Scroll cap (same discipline as ApprovalCard's max-h-40 title): the
          card is a bottom-anchored overlay, so uncapped question lists grew
          it past the viewport — the header got covered and the submit row
          pushed off-screen (multi-question asks with long descriptions).
          The cap is viewport-relative minus fixed slack for the editor
          header + Composer + this card's own chrome, so only the questions
          scroll while title / countdown / actions stay visible. */}
      <div className="max-h-[max(140px,calc(100vh-240px))] space-y-3 overflow-y-auto px-3 py-2.5 text-[12px]">
        {pending.questions.map((q) => {
          const picks = selected[q.header] ?? new Set<string>();
          const isCustomOpen = customOpen[q.header] ?? false;
          const vertical = q.options.some((opt) => (opt.description?.length ?? 0) > LONG_DESCRIPTION_CHARS);
          return (
            <div key={q.header}>
              <p className="mb-1.5 flex items-start gap-1.5 leading-snug">
                <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {q.header}
                </span>
                <span className="min-w-0 text-foreground/90">{q.question}</span>
              </p>
              <div className={vertical ? "grid gap-1.5" : "flex flex-wrap gap-1.5"}>
                {q.options.map((opt) => {
                  const active = picks.has(opt.label);
                  const Indicator = q.multiSelect
                    ? active
                      ? CheckSquare
                      : Square
                    : active
                      ? CircleDot
                      : Circle;
                  return (
                    <button
                      key={opt.label}
                      disabled={answered}
                      title={opt.description}
                      aria-label={opt.description ? t("{0}：{1}", opt.label, opt.description) : opt.label}
                      className={`press flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 ${
                        vertical ? "w-full" : "max-w-[min(260px,100%)]"
                      } ${
                        active
                          ? "border-primary/60 bg-primary/10 shadow-card"
                          : "border-border bg-surface/80 shadow-card hover:border-primary/30 hover:bg-surface-2"
                      }`}
                      onClick={() => toggle(q.header, opt.label, q.multiSelect)}
                    >
                      <Indicator
                        className={`mt-px size-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground/60"}`}
                      />
                      <span className="min-w-0">
                        <span className={`block font-medium leading-tight ${active ? "text-primary" : "text-foreground"}`}>
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 block leading-snug text-muted-foreground">{opt.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <button
                  disabled={answered}
                  className={`press flex items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 ${
                    vertical ? `w-full justify-start py-1.5 ${isCustomOpen ? "" : "border-dashed"}` : "py-1"
                  } ${
                    isCustomOpen || custom[q.header]?.trim()
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border bg-surface/80 text-muted-foreground shadow-card hover:border-primary/30 hover:text-foreground"
                  }`}
                  onClick={() => setCustomOpen((p) => ({ ...p, [q.header]: !p[q.header] }))}
                  aria-label={t("填写自定义回答")}
                >
                  <Plus className="size-3.5 shrink-0" />
                  {t("其他…")}
                  {vertical && <span className="text-muted-foreground/70">{t("自定义回答")}</span>}
                </button>
              </div>
              {isCustomOpen && (
                <input
                  autoFocus
                  className="mt-1.5 w-full rounded-lg border border-border bg-editor px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary/50"
                  placeholder={t("输入自定义回答，回车确认")}
                  value={custom[q.header] ?? ""}
                  onChange={(e) => setCustom((p) => ({ ...p, [q.header]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                />
              )}
              {q.multiSelect && picks.size > 1 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t("已选 {0} 项", picks.size)}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <CountdownBar deadline={pending.deadline} timeoutMs={pending.timeoutMs} />
      <div ref={actionsRef} role="group" aria-label={t("回答操作")} className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        <button
          disabled={answered}
          aria-label={t("提交回答")}
          className="press flex items-center gap-1 rounded-lg bg-gradient-to-b from-primary to-primary/90 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40"
          onClick={submit}
        >
          <Check className="size-3" />
          {t("提交回答")}
        </button>
        <button
          disabled={answered}
          aria-label={t("跳过提问")}
          className="press rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-[11px] text-muted-foreground shadow-card transition-all duration-200 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={dismiss}
        >
          {t("跳过")}
        </button>
      </div>
    </div>
  );
}
