import type { InitializingReason } from "../../shared/messages";
import { t } from "./i18n";

/**
 * Label for the `initializing` busy signal. The host reuses that lock for
 * several async flows (new session, session delete, message delete, rollback,
 * restore) — claiming 「正在创建新会话…」 for all of them was simply wrong.
 *
 * Lives outside App.tsx so the transcript's floating pill can reuse the same
 * mapping (App keeps its own local copy; the host forbids touching that file
 * from this change).
 */
export function initializingLabel(reason: InitializingReason | null | undefined): string {
  switch (reason) {
    case "deleteSession":
      return t("正在删除会话…");
    case "deleteMessage":
      return t("正在删除消息…");
    case "rollback":
      return t("正在回滚对话…");
    case "restore":
      return t("正在恢复会话…");
    default:
      return t("正在创建新会话…");
  }
}
