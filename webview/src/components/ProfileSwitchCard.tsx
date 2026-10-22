import { useState } from "react";
import { ArrowLeftRight, MessageSquare, PlusCircle } from "lucide-react";
import type { PendingProfileSwitchUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, ICON_INLINE, ModalShell, OptionCard, OptionGroup } from "./ui";

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
        {/* Option rows (not Button): the two-line body needs a card that grows
            with its content — the button species is a fixed 28px tall and
            overflowed its own border. */}
        <OptionGroup ariaLabel={t("切换 API 配置")} className="space-y-2">
          <OptionCard
            checked={false}
            emphasis
            disabled={answered}
            ariaLabel={t("停留在当前会话")}
            className="w-full"
            icon={<MessageSquare className={`${ICON_INLINE} mt-0.5 shrink-0 text-primary`} />}
            label={<span className="text-ui-label font-semibold">{t("停留在当前会话")}</span>}
            description={t("保留当前对话，改用新配置继续")}
            onClick={() => answer(true)}
          />
          <OptionCard
            checked={false}
            disabled={answered}
            ariaLabel={t("开启新会话")}
            className="w-full"
            icon={<PlusCircle className={`${ICON_INLINE} mt-0.5 shrink-0 text-muted-foreground`} />}
            label={<span className="text-ui-label font-semibold">{t("开启新会话")}</span>}
            description={t("以新配置开始新对话")}
            onClick={() => answer(false)}
          />
        </OptionGroup>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button variant="secondary" size="sm" disabled={answered} aria-label={t("取消切换")} onClick={() => answer(null)}>
          {t("取消")}
        </Button>
      </div>
    </ModalShell>
  );
}
