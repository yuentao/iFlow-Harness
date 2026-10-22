import { useEffect, useRef, useState, useId } from "react";
import { HelpCircle, Check, Plus } from "lucide-react";
import type { PendingQuestionsUi, UserAnswerValue } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, CountdownBar, HelpTip, ICON_INLINE, OptionCard, OptionGroup, TextInput } from "./ui";

/**
 * When any option's description exceeds this length, the option row switches
 * from horizontal wrap (cards of uneven height, cramped 260px columns with
 * broken line-wraps) to a single-column full-width list, which stays readable
 * for long copy.
 */
const LONG_DESCRIPTION_CHARS = 30;

/**
 * ask_user_question card (iFlow `_iflow/user/questions`). One section per
 * question: option cards (radio for single-select, checkbox for multiSelect)
 * in a shared OptionGroup — proper radiogroup/checkboxgroup semantics plus
 * arrow-key navigation — plus a free-text 「其他」 field. Answers are keyed by
 * the question's `header` — the wire contract the CLI's tool bridge expects.
 * Dismissing answers nothing: the agent proceeds with "no answer".
 *
 * Note: like ApprovalCard, questions arrive mid-prompt (status is
 * "streaming"), so buttons must NOT be gated on streaming state — the agent
 * is blocked waiting for this answer.
 */
export function QuestionCard({ pending }: { pending: PendingQuestionsUi }) {
  const send = useChat((s) => s.send);
  const [answered, setAnswered] = useState(false);
  const titleId = useId();
  const descId = useId();
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
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <HelpCircle className="size-3.5 shrink-0 text-primary" />
        <span id={titleId} className="min-w-0 truncate text-ui-label font-semibold">{t("iFlow 需要你的回答")}</span>
        <span className="ml-auto">
          <HelpTip label={t("提问说明")} align="right">
            <span className="block space-y-1">
              <span className="block">
                {t("agent 正在等待你的回答；卡片未回答前其他操作会被阻塞。")}
              </span>
              <span className="block">{t("超时未回答会按未回答继续。")}</span>
              {/* Milestone 14 §4.5: Enter used to submit the WHOLE card from
                  inside one free-text field, so a two-question ask fired on
                  the first Enter. The keystroke now closes that one field;
                  the whole card commits deliberately (button or Ctrl/Cmd+Enter). */}
              <span className="block">{t("回车只确认该输入；「提交回答」按钮或 Ctrl/Cmd + 回车提交整卡。")}</span>
            </span>
          </HelpTip>
        </span>
      </div>
      <div
        id={descId}
        className="max-h-[max(140px,calc(100vh-240px))] space-y-3 overflow-y-auto px-3 py-3 text-ui-label"
      >
        {pending.questions.map((q) => {
          const picks = selected[q.header] ?? new Set<string>();
          const isCustomOpen = customOpen[q.header] ?? false;
          const vertical = q.options.some((opt) => (opt.description?.length ?? 0) > LONG_DESCRIPTION_CHARS);
          return (
            <div key={q.header}>
              <p className="mb-2 flex items-start gap-1.5 leading-snug">
                <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-ui-caption font-medium text-primary">
                  {q.header}
                </span>
                <span className="min-w-0 text-foreground/90">{q.question}</span>
              </p>
              <OptionGroup
                ariaLabel={q.question}
                multi={q.multiSelect}
                className={vertical ? "grid gap-1.5" : "flex flex-wrap gap-1.5"}
              >
                {q.options.map((opt) => (
                  <OptionCard
                    key={opt.label}
                    type={q.multiSelect ? "checkbox" : "radio"}
                    checked={picks.has(opt.label)}
                    disabled={answered}
                    title={opt.description}
                    label={opt.label}
                    description={opt.description}
                    className={vertical ? "w-full" : "max-w-[min(260px,100%)]"}
                    onClick={() => toggle(q.header, opt.label, q.multiSelect)}
                  />
                ))}
                <Button
                  variant="canvas"
                  disabled={answered}
                  aria-label={t("填写自定义回答")}
                  icon={<Plus className={`${ICON_INLINE} shrink-0`} />}
                  className={`justify-start rounded-lg px-2.5 ${vertical ? "" : "py-1"} ${
                    isCustomOpen || custom[q.header]?.trim() ? "" : "border-dashed"
                  } ${
                    isCustomOpen || custom[q.header]?.trim()
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setCustomOpen((p) => ({ ...p, [q.header]: !p[q.header] }))}
                >
                  {t("其他")}
                  {vertical && <span className="text-muted-foreground/80">{t("自定义回答")}</span>}
                </Button>
              </OptionGroup>
              {isCustomOpen && (
                <TextInput
                  autoFocus
                  aria-label={`${t("自定义回答")}: ${q.header}`}
                  placeholder={t("输入自定义回答，回车确认")}
                  className="mt-2 w-full"
                  value={custom[q.header] ?? ""}
                  onChange={(e) => setCustom((p) => ({ ...p, [q.header]: e.target.value }))}
                  onKeyDown={(e) => {
                    // IME-safe (same discipline as the Composer textarea): a
                    // composition-confirming Enter must not act at all.
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    // Milestone 14 §4.5: Enter commits THIS answer and folds the
                    // field back so the card shows the typed text; it does not
                    // answer every question at once. The whole card commits
                    // deliberately (提交回答 button, or Ctrl/Cmd + Enter).
                    if (e.key !== "Enter") return;
                    if (e.ctrlKey || e.metaKey) submit();
                    else setCustomOpen((p) => ({ ...p, [q.header]: false }));
                  }}
                />
              )}
              {q.multiSelect && picks.size > 1 && (
                <p className="mt-1 text-ui-caption text-muted-foreground">
                  {t("已选 {0} 项", picks.size)}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <CountdownBar deadline={pending.deadline} timeoutMs={pending.timeoutMs} quietLabel={t("自动继续")} />
      <div ref={actionsRef} role="group" aria-label={t("回答操作")} className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          variant="primary"
          size="sm"
          disabled={answered}
          aria-label={t("提交回答")}
          icon={<Check className={ICON_INLINE} />}
          onClick={submit}
        >
          {t("提交回答")}
        </Button>
        <Button variant="secondary" size="sm" disabled={answered} aria-label={t("不回答并继续")} onClick={dismiss}>
          {t("不回答并继续")}
        </Button>
      </div>
    </div>
  );
}
