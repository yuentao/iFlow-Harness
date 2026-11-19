import { useChat } from "../store";
import { ConfirmDialog } from "./ui";

/**
 * 新建会话前的 Super Agent 残留清空二次确认框。
 *
 * 宿主用 `vscode.l10n.t` 组装好的 title / message / 按钮文案随
 * `superResidueConfirm` 消息下发，这里原样渲染 —— 不新增 i18n key、不改写
 * 「未合并 worktree 将永久丢失」的警示。`ConfirmDialog` 自身会 createPortal
 * 到 document.body，不受 acrylic backdrop-filter 包含块 / overflow-hidden 裁剪。
 *
 * 回答走 store 的 `respondSuperResidueConfirm`：它先同步清空展示态再回传，
 * 保证同一请求只回答一次（重复点击 / Esc 取消不会再发第二条消息）。
 */
export function SuperResidueConfirmDialog() {
  const request = useChat((s) => s.superResidueConfirm);
  const respond = useChat((s) => s.respondSuperResidueConfirm);
  if (!request) return null;
  return (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      onConfirm={() => respond(true)}
      onCancel={() => respond(false)}
    />
  );
}
