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
 * - 取消 → the ENTIRE switch is cancelled (X / Escape / backdrop do not close
 *   this dialog; only the two choices and 取消 are exits).
 * No countdown: this dialog blocks no agent, so it waits for the user
 * indefinitely (the host resolves it as cancelled on panel teardown).
 */
export function ProfileSwitchCard({ pending }: { pending: PendingProfileSwitchUi }) {
  const send = useChat((s) => s.send);
  // Optimistic lock: the first click answers the dialog; every button is
  // disabled until the host's next snapshot removes the card (same pattern
  // as the approval card — prevents double-fire on rapid clicks).
  const [answered, setAnswered] = useState(false);

  const answer = (keepSession: boolean | null) => {
    if (answered) return;
    setAnswered(true);
    // Cancelling aborts the whole switch host-side (no authenticate). Drop
    // the optimistic row lock here too: the settings list keys its chip off
    // `pending`, so without this it flips from "等待选择…" to
    // "正在重新连接…" and stays disabled until the 10s timeout.
    if (keepSession === null) useChat.getState().clearPending();
    send({ type: "respondProfileSwitch", id: pending.id, keepSession });
  };

  return (
    <ModalShell
      role="alertdialog"
      ariaLabel={t("切换配置")}
      title={t("切换配置")}
              icon={<ArrowLeftRight className={`${ICON_INLINE} shrink-0 text-primary`} />}      onClose={() => answer(null)}
      dismissible={false}
      initialFocus="first"
    >
      <div className="space-y-3 px-3 py-3">
        <p className="text-ui-label leading-relaxed text-foreground/90">
          {t("切换到配置「{0}」后，当前对话要怎么处理？", pending.profileName)}
        </p>
        {/* Option rows (not Button): the two-line body needs a card that grows
            with its content — the button species is a fixed 28px tall and
            overflowed its own border. */}
        <OptionGroup ariaLabel={t("切换配置")} className="space-y-2">
          <OptionCard
            checked={false}
            emphasis
            disabled={answered}
            ariaLabel={t("停留在当前会话")}
            className="w-full"
            icon={<MessageSquare className={`${ICON_INLINE} mt-0.5 shrink-0 text-primary`} />}
            label={<span className="text-ui-label font-semibold">{t("停留在当前会话")}</span>}
            description={t("这段对话保留，用新配置接着聊")}
            onClick={() => answer(true)}
          />
          <OptionCard
            checked={false}
            disabled={answered}
            ariaLabel={t("开启新会话")}
            className="w-full"
            icon={<PlusCircle className={`${ICON_INLINE} mt-0.5 shrink-0 text-muted-foreground`} />}
            label={<span className="text-ui-label font-semibold">{t("开启新会话")}</span>}
            description={t("从一段空白对话重新开始")}
            onClick={() => answer(false)}
          />
        </OptionGroup>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button variant="secondary" size="sm" disabled={answered} aria-label={t("取消切换")} onClick={() => answer(null)}>
          {t("取消切换")}
        </Button>
      </div>
    </ModalShell>
  );
}
