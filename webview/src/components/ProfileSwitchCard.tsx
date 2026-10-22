import { useState } from "react";
import { ArrowLeftRight, MessageSquare, PlusCircle } from "lucide-react";
import type { PendingProfileSwitchUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, ICON_INLINE, ModalShell } from "./ui";

/**
 * Profile-switch choice dialog: a custom centered modal (same acrylic form
 * language as the settings modal) replacing the native showWarningMessage
 * dialog, which broke the panel's visual language. The user chooses how the
 * current conversation survives the switch:
 * - 停留在当前会话 → host reloads the SAME session under the new credentials
 *   (the recommended side, so it carries the primary outline + light fill)
 * - 开启新会话     → host clears the transcript and starts fresh
 * - X / Escape / backdrop / 取消 → the ENTIRE switch is cancelled.
 * No countdown: this dialog blocks no agent, so it waits for the user
 * indefinitely (the host resolves it as cancelled on panel teardown).
 */
export function ProfileSwitchCard({ pending }: { pending: PendingProfileSwitchUi }) {
  const send = useChat((s) => s.send);
  // Optimistic lock: the first click answers the dialog; every button is
  // disabled until the host's next snapshot removes the card (same pattern
  // as the approval / plan-exit cards — prevents double-fire on rapid clicks).
  const [answered, setAnswered] = useState(false);

  const answer = (keepSession: boolean | null) => {
    if (answered) return;
    setAnswered(true);
    // Cancelling aborts the whole switch host-side (no authenticate). Drop
    // the optimistic row lock here too: the settings list keys its chip off
    // `pending`, so without this it flips from "等待选择…" to
    // "正在重新认证…" and stays disabled until the 10s timeout.
    if (keepSession === null) useChat.getState().clearPending();
    send({ type: "respondProfileSwitch", id: pending.id, keepSession });
  };

  return (
    <ModalShell
      role="alertdialog"
      ariaLabel={t("切换 API 配置")}
      title={t("切换 API 配置")}
              icon={<ArrowLeftRight className={`${ICON_INLINE} shrink-0 text-primary`} />}      onClose={() => answer(null)}
      initialFocus="first"
    >
      <div className="space-y-3 px-3 py-3">
        <p className="text-ui-label leading-relaxed text-foreground/90">
          {t("切换到 API 配置「{0}」后，当前对话如何处理？", pending.profileName)}
        </p>
        <Button
          variant="outline-primary"
          disabled={answered}
          data-autofocus
          aria-label={t("停留在当前会话")}
          className="w-full items-start justify-start rounded-lg bg-primary/10 px-2.5 py-2 hover:bg-primary/15"
          icon={<MessageSquare className={`${ICON_INLINE} mt-0.5 shrink-0 text-primary`} />}
          onClick={() => answer(true)}
        >
          <span className="min-w-0">
            <span className="block text-ui-label font-semibold text-foreground">{t("停留在当前会话")}</span>
            <span className="block text-ui-caption leading-relaxed text-muted-foreground">
              {t("保留当前对话，改用新配置继续")}
            </span>
          </span>
        </Button>
        <Button
          variant="canvas"
          disabled={answered}
          aria-label={t("开启新会话")}
          className="w-full items-start justify-start rounded-lg px-2.5 py-2 hover:border-destructive/40 hover:bg-destructive/10"
          icon={<PlusCircle className={`${ICON_INLINE} mt-0.5 shrink-0 text-muted-foreground`} />}
          onClick={() => answer(false)}
        >
          <span className="min-w-0">
            <span className="block text-ui-label font-semibold text-foreground">{t("开启新会话")}</span>
            <span className="block text-ui-caption leading-relaxed text-muted-foreground">
              {t("以新配置开始新对话")}
            </span>
          </span>
        </Button>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button variant="secondary" size="sm" disabled={answered} aria-label={t("取消切换")} onClick={() => answer(null)}>
          {t("取消")}
        </Button>
      </div>
    </ModalShell>
  );
}
