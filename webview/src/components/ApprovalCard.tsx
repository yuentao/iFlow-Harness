import type { PendingApprovalUi, PermissionOptionUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

/** Stable visual class per option kind. */
function optionClass(kind: PermissionOptionUi["kind"]): string {
  if (kind.startsWith("allow")) return "allow";
  if (kind.startsWith("reject")) return "reject";
  return "neutral";
}

/**
 * Tool-execution approval card. Rendered when the host surfaces a pending
 * `session/request_permission`; disappears once answered.
 * Note: permission requests arrive mid-prompt (status is "streaming"), so the
 * buttons must NOT be gated on streaming state — the agent is blocked waiting
 * for this answer.
 */
export function ApprovalCard({ approval }: { approval: PendingApprovalUi }) {
  const send = useChat((s) => s.send);

  const options = [...approval.options].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );

  const primary = approval.locations[0];

  return (
    <div className="approval-card" role="alertdialog" aria-label={t("工具执行审批")}>
      <div className="approval-head">
        <span className="approval-icon">🛡</span>
        <span className="approval-title">{t("iFlow 请求执行工具")}</span>
      </div>
      <div className="approval-body">
        {approval.toolName && <code className="approval-tool">{approval.toolName}</code>}
        {approval.title && <span className="approval-desc">{approval.title}</span>}
        {primary && (
          <a
            className="approval-loc"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              send({ type: "openLocation", path: primary.path, line: primary.line });
            }}
          >
            {primary.path}
          </a>
        )}
      </div>
      <div className="approval-actions">
        {options.map((opt) => (
          <button
            key={opt.optionId}
            className={`btn approval-btn ${optionClass(opt.kind)}`}
            onClick={() => send({ type: "respondApproval", id: approval.id, optionId: opt.optionId })}
          >
            {opt.name}
          </button>
        ))}
        <button
          className="btn approval-btn neutral"
          onClick={() => send({ type: "respondApproval", id: approval.id, optionId: null })}
        >
          {t("取消")}
        </button>
      </div>
    </div>
  );
}
