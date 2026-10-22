import { useEffect, useRef, useState } from "react";
import { Brain, Check, Plus } from "lucide-react";
import type { MemoryScope } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, Field, ICON_INLINE, ModalShell, Segmented, TextArea } from "./ui";

/**
 * F3 Phase 2 — "记住这条" quick-add dialog. Prefilled with the assistant
 * message text (editable, capped), scope selector (the shared segmented
 * control), writes via the same host `appendMemoryFact` path as the settings
 * card. The host's `memorySaved` reply is the acknowledgement — matched by
 * `requestId` so another card's write can never masquerade as this ack (trap
 * #29); failure keeps the dialog open.
 */
export function MemoryQuickAdd({
  request,
  onClose,
}: {
  request: { text: string; seq: number };
  onClose: () => void;
}) {
  const send = useChat((s) => s.send);
  const [fact, setFact] = useState("");
  const [scope, setScope] = useState<MemoryScope>("global");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const activeRequest = useRef<number | null>(null);

  useEffect(() => {
    setFact(request.text.trim().slice(0, 2_000));
    setScope("global");
    setSaving(false);
    setDone(false);
    setError(null);
    activeRequest.current = null;
  }, [request.seq, request.text]);

  useEffect(() => {
    if (!saving) return;
    const timer = window.setTimeout(() => {
      if (activeRequest.current === null) return;
      activeRequest.current = null;
      setSaving(false);
      setError(t("保存超时，请重试"));
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [saving]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type?: string; ok?: boolean; error?: string; requestId?: number };
      if (msg?.type !== "memorySaved" || msg.requestId !== activeRequest.current) return;
      activeRequest.current = null;
      setSaving(false);
      if (!msg.ok) {
        setError(msg.error ?? t("保存失败"));
        return;
      }
      setDone(true);
      window.setTimeout(onClose, 700);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onClose]);

  function save() {
    const text = fact.trim();
    if (!text || saving) return;
    setError(null);
    setSaving(true);
    const requestId = ++requestSeq.current;
    activeRequest.current = requestId;
    send({ type: "appendMemoryFact", scope, fact: text, requestId });
  }

  return (
    <ModalShell
      title={t("记住这条")}
      icon={<Brain className={`${ICON_INLINE} shrink-0 text-primary`} />}
      ariaLabel={t("记住这条")}
      dismissible={!saving}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className={ICON_INLINE} />}
            disabled={!fact.trim() || saving || done}
            onClick={save}
          >
            {saving ? t("写入中…") : t("保存")}
          </Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>
            {t("取消")}
          </Button>
          <span className="ml-auto text-ui-micro text-muted-foreground">
            {t("保存后新建会话或重启 CLI 生效")}
          </span>
        </div>
      }
    >
      <div className="space-y-2 px-3 py-3">
        {done && (
          <div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 py-1.5 text-ui-caption text-success">
            <Check className="size-3 shrink-0" />
            {t("已加入记忆（新会话生效）")}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-ui-caption text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center gap-1">
          <Segmented
            ariaLabel={t("记忆作用域")}
            value={scope}
            options={[
              { value: "global", label: t("全局") },
              { value: "project", label: t("项目") },
            ]}
            onChange={setScope}
          />
          <span className="ml-1 text-ui-micro text-muted-foreground">
            {scope === "global" ? t("保存到全局记忆") : t("保存到项目记忆")}
          </span>
        </div>
        <Field label={t("要记住的内容（可编辑）")}>
          <TextArea
            aria-label={t("要记住的内容")}
            className="min-h-[120px] w-full"
            value={fact}
            onChange={(event) => setFact(event.target.value)}
          />
        </Field>
        <p className="text-ui-micro leading-relaxed text-muted-foreground/85">
          {t("记忆会随每次请求发送给模型，请勿写入密钥。")}
        </p>
      </div>
    </ModalShell>
  );
}