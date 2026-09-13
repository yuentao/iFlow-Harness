import { useState } from "react";
import { HelpCircle, Check } from "lucide-react";
import type { PendingQuestionsUi, UserAnswerValue } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { CountdownBar } from "./ui";

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

  return (
    <div
      className="acrylic stream-in glow-ring card-lift mx-3 mb-2 shrink-0 rounded-xl border border-primary/40"
      role="alertdialog"
      aria-label={t("iFlow 提问")}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <HelpCircle className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold">{t("iFlow 需要你的回答")}</span>
      </div>
      <div className="space-y-3 px-3 py-2.5 text-[12px]">
        {pending.questions.map((q) => {
          const picks = selected[q.header] ?? new Set<string>();
          const isCustomOpen = customOpen[q.header] ?? false;
          return (
            <div key={q.header}>
              <p className="mb-1 flex items-center gap-1.5">
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {q.header}
                </span>
                <span className="text-foreground/90">{q.question}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const active = picks.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      disabled={answered}
                      title={opt.description}
                      className={`press rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 ${
                        active
                          ? "border-primary bg-gradient-to-b from-primary to-primary/90 font-semibold text-primary-foreground shadow-btn"
                          : "border-border bg-surface/80 text-foreground shadow-card hover:bg-surface-2"
                      }`}
                      onClick={() => toggle(q.header, opt.label, q.multiSelect)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <button
                  disabled={answered}
                  className={`press rounded-lg border px-2.5 py-1 text-[11px] transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 ${
                    isCustomOpen || custom[q.header]?.trim()
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface/80 text-muted-foreground shadow-card hover:text-foreground"
                  }`}
                  onClick={() => setCustomOpen((p) => ({ ...p, [q.header]: !p[q.header] }))}
                >
                  {t("其他…")}
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
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        <button
          disabled={answered}
          className="press flex items-center gap-1 rounded-lg bg-gradient-to-b from-primary to-primary/90 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40"
          onClick={submit}
        >
          <Check className="size-3" />
          {t("提交回答")}
        </button>
        <button
          disabled={answered}
          className="rounded-lg px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={dismiss}
        >
          {t("跳过")}
        </button>
      </div>
    </div>
  );
}
