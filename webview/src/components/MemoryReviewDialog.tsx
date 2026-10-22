import { useMemo, useState } from "react";
import { Brain, Check } from "lucide-react";
import type { MemoryCandidateUi, MemoryScope } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, Checkbox, Chip, ICON_INLINE, ModalShell, Select } from "./ui";

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
 * Controls come from the shared kit: the checkbox is the project's own box
 * (radius/colour tokens) instead of a browser accent, the scope picker is the
 * shared native-select species, and the footer rides the standard button pair.
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
      icon={<Brain className={`${ICON_INLINE} shrink-0 text-primary`} />}
      ariaLabel={t("记忆候选")}
      onClose={() => close(true)}
      footer={
        <div className="flex items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          <Button
            variant="primary"
            size="sm"
            icon={<Check className={ICON_INLINE} />}
            disabled={selectedCount === 0 || applied}
            onClick={save}
          >
            {t("保存选中（{0}）", selectedCount)}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => close(true)}>
            {t("全部忽略")}
          </Button>
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
            <Checkbox
              ariaLabel={candidate.text}
              className="mt-0.5"
              checked={selected[candidate.id] ?? false}
              onChange={(checked) =>
                setSelected((current) => ({ ...current, [candidate.id]: checked }))
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
                <Select
                  ariaLabel={`${t("记忆作用域")}: ${candidate.text.slice(0, 40)}`}
                  size="sm"
                  wrapperClass="ml-auto"
                  options={[
                    { value: "global", label: t("全局记忆") },
                    { value: "project", label: t("项目记忆") },
                  ]}
                  value={scopes[candidate.id] ?? candidate.scope}
                  onChange={(value) =>
                    setScopes((current) => ({
                      ...current,
                      [candidate.id]: value as MemoryScope,
                    }))
                  }
                />
              </span>
            </span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}