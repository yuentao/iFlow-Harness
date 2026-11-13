import { useState } from "react";
import { Plus } from "lucide-react";
import type { UserQuestion } from "../../../shared/messages";
import { t } from "../i18n";
import { Button, ICON_INLINE, OptionCard, OptionGroup, TextInput } from "./ui";

/**
 * 答案表：按 question 的 `header` 索引（wire 契约 —— CLI 的工具桥按 header 取值）。
 */
export type QuestionAnswerMap = Record<string, string | string[]>;

/**
 * 当某个选项的副文案超过这个长度时，选项行从横向排布切成单列全宽
 * （横向排布下长副文案会被挤成碎行，260px 的卡片列宽尤其明显）。
 */
const LONG_DESCRIPTION_CHARS = 30;

/**
 * 题目与选项渲染 —— **主会话提问卡与子会话看板共用同一份实现**。
 *
 * 之前看板里有一份「劣质平行实现」：选项的 description 被整个丢弃、没有
 * radiogroup/checkboxgroup 语义、没有自由文本作答、也没有倒计时提示。两处
 * 各写一份意味着同一个 `ask_user_question` 在两个界面里行为不同 —— 用户在
 * 看板里作答时拿不到选项副文案，键盘用户也拿不到选项组的导航。
 *
 * 这里的语义：
 *  - 单选题 = `OptionGroup` 的 radiogroup（选中项唯一，Arrow/Home/End 可移动，
 *    跳过 disabled）；多选题 = checkboxgroup 语义（逐项勾选）。
 *  - 每个选项的 description 副文案必须展示（`OptionCard` 的 description 槽）。
 *  - 每题都带一个自由文本入口（「其他」），与主会话卡片同构。
 *
 * 作答状态由本组件自己持有，答案表通过 `onAnswersChange` 上报给宿主组件
 * （提交方直接用它发回 wire）。上报走事件回调而不是 effect：父组件每次
 * 渲染都会新建回调，effect 依赖它会形成「上报 → 父重渲染 → 再上报」的回环。
 */
export function QuestionBody({
  questions,
  disabled = false,
  onAnswersChange,
  onSubmit,
}: {
  questions: UserQuestion[];
  /** 已提交/已放弃：所有选项与输入框锁死。 */
  disabled?: boolean;
  /** 每次作答变化时上报当前答案表。 */
  onAnswersChange: (answers: QuestionAnswerMap) => void;
  /** Ctrl/Cmd + 回车时提交整卡（主会话卡片用；不传则回车只收起该输入框）。 */
  onSubmit?: () => void;
}) {
  // 每题的勾选状态：header → 选中的 label 集合。
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  // 每题的自由文本。
  const [custom, setCustom] = useState<Record<string, string>>({});
  // 每题的自由文本输入框是否展开。
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});

  /** 由「勾选 + 自由文本」推导出 wire 答案表。自由文本优先于勾选。 */
  const buildAnswers = (
    picks: Record<string, Set<string>>,
    texts: Record<string, string>,
  ): QuestionAnswerMap => {
    const answers: QuestionAnswerMap = {};
    for (const q of questions) {
      const chosen = picks[q.header] ?? new Set<string>();
      const free = texts[q.header]?.trim() ?? "";
      if (free) {
        answers[q.header] = free;
      } else if (chosen.size === 1 && !q.multiSelect) {
        answers[q.header] = [...chosen][0]!;
      } else if (chosen.size > 0) {
        answers[q.header] = [...chosen];
      }
      // 没答的题直接不出现 —— CLI 把它格式化成「未回答」。
    }
    return answers;
  };

  const toggle = (header: string, label: string, multiSelect: boolean): void => {
    const current = selected[header] ?? new Set<string>();
    const next = new Set(current);
    if (multiSelect) {
      if (next.has(label)) next.delete(label);
      else next.add(label);
    } else {
      next.clear();
      next.add(label);
    }
    const picks = { ...selected, [header]: next };
    setSelected(picks);
    onAnswersChange(buildAnswers(picks, custom));
  };

  const changeCustom = (header: string, value: string): void => {
    const texts = { ...custom, [header]: value };
    setCustom(texts);
    onAnswersChange(buildAnswers(selected, texts));
  };

  return (
    <div className="space-y-3">
      {questions.map((q) => {
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
                  disabled={disabled}
                  title={opt.description}
                  label={opt.label}
                  description={opt.description}
                  className={vertical ? "w-full" : "max-w-[min(260px,100%)]"}
                  onClick={() => toggle(q.header, opt.label, q.multiSelect)}
                />
              ))}
              <Button
                variant="canvas"
                disabled={disabled}
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
                onChange={(e) => changeCustom(q.header, e.target.value)}
                onKeyDown={(e) => {
                  // IME-safe（与 Composer textarea 同纪律）：输入法确认的
                  // 回车不能触发任何动作。
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key !== "Enter") return;
                  if (e.ctrlKey || e.metaKey) {
                    if (onSubmit) {
                      e.preventDefault();
                      onSubmit();
                    }
                    return;
                  }
                  // 回车只确认这一个输入框并收起它，不提交整卡 —— 整卡由
                  // 「提交回答」按钮（或 Ctrl/Cmd + 回车）显式提交。
                  setCustomOpen((p) => ({ ...p, [q.header]: false }));
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
  );
}
