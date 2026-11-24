import { useEffect, useRef, useState, useId } from "react";
import { HelpCircle, Check } from "lucide-react";
import type { PendingQuestionsUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, CountdownBar, HelpTip, ICON_INLINE } from "./ui";
import { QuestionBody, type QuestionAnswerMap } from "./QuestionBody";

/**
 * ask_user_question card (iFlow `_iflow/user/questions`). One section per
 * question: option cards (radio for single-select, checkbox for multiSelect)
 * in a shared OptionGroup — proper radiogroup/checkboxgroup semantics plus
 * arrow-key navigation — plus a free-text 「其他」 field. Answers are keyed by
 * the question's `header` — the wire contract the CLI's tool bridge expects.
 * Dismissing answers nothing: the agent proceeds with "no answer".
 *
 * The question/option rendering itself lives in `QuestionBody` — the Super
 * Agent board answers the same `ask_user_question` payload and must not
 * maintain a second, poorer copy of it.
 *
 * Note: like ApprovalCard, questions arrive mid-prompt (status is
 * "streaming"), so buttons must NOT be gated on streaming state — the agent
 * is blocked waiting for this answer.
 */
export function QuestionCard({
  pending,
  active = true,
}: {
  pending: PendingQuestionsUi;
  /**
   * Whether this card is the one the user can act on. PendingCards passes
   * `false` for a card covered by a newer arrival in the stack. A buried
   * card must not answer ESC — `inert` mutes DOM focus/hit-testing but NOT
   * a `window` keydown listener, so the shortcut is gated on this flag.
   */
  active?: boolean;
}) {
  const send = useChat((s) => s.send);
  // 远程接续冻结：独立于 streaming 的全局态，接管期间不得回答问题。
  const remoteTakeover = useChat((s) => s.remoteTakeover);
  const [answered, setAnswered] = useState(false);
  const titleId = useId();
  const descId = useId();
  // The answer map lives here: QuestionBody owns the selection state and
  // reports the derived answers back, so submitting needs no second source
  // of truth.
  const [answers, setAnswers] = useState<QuestionAnswerMap>({});

  const submit = () => {
    if (answered || remoteTakeover) return;
    setAnswered(true);
    send({ type: "answerQuestions", id: pending.id, answers });
  };

  const dismiss = () => {
    if (answered || remoteTakeover) return;
    setAnswered(true);
    send({ type: "answerQuestions", id: pending.id, answers: {} });
  };

  // Mirror ApprovalCard (W4): keyboard users should land on the question's
  // actions, not stay trapped in the Composer. Focus the first option button
  // on mount; the card body may contain other buttons (custom-text toggles)
  // that precede it, so scope to the actions row.
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A question can arrive while the user is mid-typing in the Composer.
    // Do not steal that focus: once it moves to this card's button, the next
    // keystroke has a BUTTON target and slips past the editable-target gate
    // in the ESC handler below. The card remains clickable / Tab-reachable.
    const active = document.activeElement as HTMLElement | null;
    if (
      active
      && (active.tagName === "INPUT"
        || active.tagName === "TEXTAREA"
        || active.tagName === "SELECT"
        || active.isContentEditable)
    ) {
      return;
    }
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  // ESC on a question card means "不回答并继续" (dismiss) — the card's own
  // safe-side exit, never "stop generation". It was previously absent here
  // entirely, so ESC while a question waited always fell through to
  // Composer's window listener and killed the whole turn. Same gates as
  // ApprovalCard: active card only, no modal above, not from an editable
  // target, not already consumed; preventDefault + stopPropagation keep the
  // global stop shortcut out.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      // Same IME-safe condition as ApprovalCard / Composer: the composition
      // start/commit keystrokes can carry keyCode 229 / key "Process" with
      // isComposing false, so they must never dismiss the card.
      if (
        answered || remoteTakeover || e.defaultPrevented
        || e.isComposing || e.key === "Process" || e.keyCode === 229
        || e.ctrlKey || e.metaKey || e.altKey
      ) return;
      if (e.key !== "Escape") return;
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
      e.preventDefault();
      e.stopPropagation();
      setAnswered(true);
      send({ type: "answerQuestions", id: pending.id, answers: {} });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, answered, remoteTakeover, pending.id, send]);

  return (
    <div
      className="acrylic stream-in glow-ring card-lift pointer-events-auto mx-3 flex max-h-full shrink-0 flex-col rounded-xl border border-primary/40"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <HelpCircle className="size-3.5 shrink-0 text-primary" />
        <span id={titleId} className="min-w-0 truncate text-ui-label font-semibold">{t("iFlow 有问题想问你")}</span>
        <span className="ml-auto">
          <HelpTip label={t("提问说明")} align="right">
            <span className="block space-y-1">
              <span className="block">
                {t("iFlow 正在等你回答，回答前它会先暂停。")}
              </span>
              <span className="block">{t("超时没回答，iFlow 会按「未回答」继续往下走。")}</span>
              {/* Milestone 14 §4.5: Enter used to submit the WHOLE card from
                  inside one free-text field, so a two-question ask fired on
                  the first Enter. The keystroke now closes that one field;
                  the whole card commits deliberately (button or Ctrl/Cmd+Enter). */}
              <span className="block">{t("回车只确认当前输入框；要提交整张卡片，请点「提交回答」或按 Ctrl/Cmd + 回车。")}</span>
            </span>
          </HelpTip>
        </span>
      </div>
      {/* Scroll body: the card caps at the overlay wrapper (max-h-full), so
          the body takes whatever is left after header/countdown/actions and
          scrolls internally — no viewport guess, and the action buttons stay
          visible even for multi-question asks with long option copy. */}
      <div
        id={descId}
        className="min-h-0 flex-auto space-y-3 overflow-y-auto px-3 py-3 text-ui-label"
      >
        <QuestionBody
          questions={pending.questions}
          disabled={answered || remoteTakeover}
          onAnswersChange={setAnswers}
          onSubmit={submit}
        />
      </div>
      <div className="shrink-0">
        <CountdownBar deadline={pending.deadline} timeoutMs={pending.timeoutMs} quietLabel={t("自动继续")} />
      </div>
      <div ref={actionsRef} role="group" aria-label={t("回答操作")} className="flex shrink-0 flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          variant="primary"
          size="sm"
          disabled={answered || remoteTakeover}
          aria-label={t("提交回答")}
          icon={<Check className={ICON_INLINE} />}
          onClick={submit}
        >
          {t("提交回答")}
        </Button>
        <Button variant="secondary" size="sm" disabled={answered || remoteTakeover} aria-label={t("不回答并继续")} onClick={dismiss}>
          {t("不回答并继续")}
        </Button>
      </div>
    </div>
  );
}