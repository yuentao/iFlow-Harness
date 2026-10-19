import { useMemo, useState } from "react";
import { Brain, Check } from "lucide-react";
import type { MemoryCandidateUi, MemoryScope } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, Chip, ModalShell, SAVE_BTN } from "./ui";

function categoryLabel(category: MemoryCandidateUi["category"]): string {
  switch (category) {
    case "preference": return t("偏好");
    case "convention": return t("约定");
    case "decision": return t("决策");
    case "gotcha": return t("陷阱");
    default: return t("其他");
  }
}

/**
 * F3 Phase 2 — review dialog for auto-extracted memory candidates. Nothing is
 * written until the user saves; every row can be unchecked or re-scoped.
 */
export function MemoryReviewDialog({
  sessionId,
  candidates,
  onClose,
}: {
  sessionId: string | null;
  candidates: MemoryCandidateUi[];
  onClose: () => void;
}) {
  const send = useChat((s) => s.send);
  const [selected, setSelected] = useState<Record<string, boolean>>(
    () => Object.fromEntries(candidates.map((candidate) => [candidate.id, true])),
  );
  const [scopes, setScopes] = useState<Record<string, MemoryScope>>(
    () => Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.scope])),
  );
  const [applied, setApplied] = useState(false);
  const selectedCount = useMemo(
    () => candidates.filter((candidate) => selected[candidate.id]).length,
    [candidates, selected],
  );

  function close(dismiss: boolean) {
    if (dismiss && !applied) {
      send({ type: "dismissMemoryCandidates", sessionId });
    }
    onClose();
  }

  function save() {
    if (selectedCount === 0) return;
    const chosen = candidates
      .filter((candidate) => selected[candidate.id])
      .map((candidate) => ({ ...candidate, scope: scopes[candidate.id] ?? candidate.scope }));
    setApplied(true);
    send({ type: "applyMemoryCandidates", sessionId, candidates: chosen });
    onClose();
  }

  return (
    <ModalShell
      wide
      dismissible={false}
      title={t("记忆候选")}
      icon={<Brain className="size-3.5 shrink-0 text-primary" />}
      ariaLabel={t("记忆候选")}
      onClose={() => close(true)}
      footer={
        <div className="flex items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          <button className={SAVE_BTN} disabled={selectedCount === 0 || applied} onClick={save}>
            <Check className="mr-0.5 inline size-3 align-[-2px]" />
            {t("保存选中（{0}）", selectedCount)}
          </button>
          <button className={BTN} onClick={() => close(true)}>
            {t("全部忽略")}
          </button>
          <span className="ml-auto text-ui-micro text-muted-foreground">
            {t("自动提取只生成候选，确认后才会写入记忆")}
          </span>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        <p className="text-ui-caption leading-relaxed text-muted-foreground">
          {t("以下是模型从最近对话中提取的长期记忆候选。请勾选要保留的内容，并确认作用域。")}
        </p>
        {candidates.map((candidate) => (
          <div
            key={candidate.id}
            className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2 shadow-card"
          >
            <input
              type="checkbox"
              aria-label={candidate.text}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
              checked={selected[candidate.id] ?? false}
              onChange={(event) =>
                setSelected((current) => ({ ...current, [candidate.id]: event.target.checked }))
              }
            />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-ui-label leading-relaxed text-foreground">
                {candidate.text}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1">
                <Chip tone="muted">{categoryLabel(candidate.category)}</Chip>
                <span title={t("模型对该候选的置信度（0–100%）")}>
                  <Chip tone="info">{t("置信度 {0}%", Math.round(candidate.confidence * 100))}</Chip>
                </span>
                <select
                  aria-label={`${t("记忆作用域")}: ${candidate.text.slice(0, 40)}`}
                  className={`${INPUT} ml-auto w-auto py-0.5 text-ui-micro`}
                  value={scopes[candidate.id] ?? candidate.scope}
                  onChange={(event) =>
                    setScopes((current) => ({
                      ...current,
                      [candidate.id]: event.target.value as MemoryScope,
                    }))
                  }
                >
                  <option value="global">{t("全局记忆")}</option>
                  <option value="project">{t("项目记忆")}</option>
                </select>
              </span>
            </span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
