import { useState } from "react";
import { ArrowLeftRight, MessageSquare, PlusCircle } from "lucide-react";
import type { PendingProfileSwitchUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { ModalShell } from "./ui";

/**
 * Profile-switch choice dialog: a custom centered modal (same acrylic form
 * language as the settings modal) replacing the native showWarningMessage
 * dialog, which broke the panel's visual language. The user chooses how the
 * current conversation survives the switch:
 * - 停留在当前会话 → host reloads the SAME session under the new credentials
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

  const OPTION =
    "card-lift press flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left shadow-card transition-all duration-200 disabled:pointer-events-none disabled:opacity-40";

  return (
    <ModalShell
      role="alertdialog"
      ariaLabel={t("切换 API 配置")}
      title={t("切换 API 配置")}
      icon={<ArrowLeftRight className="size-3.5 shrink-0 text-primary" />}
      onClose={() => answer(null)}
      initialFocus="first"
    >
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-[12px] leading-relaxed text-foreground/90">
          {t("切换到 API 配置「{0}」后，当前对话如何处理？", pending.profileName)}
        </p>
        <button
          type="button"
          disabled={answered}
          data-autofocus
          aria-label={t("停留在当前会话")}
          className={`${OPTION} border-primary/50 bg-primary/10 hover:border-primary/70 hover:bg-primary/15`}
          onClick={() => answer(true)}
        >
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-foreground">{t("停留在当前会话")}</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              {t("保留当前对话，改用新配置继续")}
            </span>
          </span>
        </button>
        <button
          type="button"
          disabled={answered}
          aria-label={t("开启新会话")}
          className={`${OPTION} border-border hover:border-destructive/40 hover:bg-destructive/10`}
          onClick={() => answer(false)}
        >
          <PlusCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold text-foreground">{t("开启新会话")}</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              {t("以新配置开始新对话")}
            </span>
          </span>
        </button>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <button
          type="button"
          disabled={answered}
          aria-label={t("取消切换")}
          className="press rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-all duration-200 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={() => answer(null)}
        >
          {t("取消")}
        </button>
      </div>
    </ModalShell>
  );
}