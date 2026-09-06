import { useState } from "react";
import type { AuthUiState } from "../../../shared/messages";
import { useChat } from "../store";

/**
 * M3 auth card: API profile management + credential form.
 *
 * - Profile list: every known API config (extension-owned editable ones and
 *   read-only ones imported from the CLI's settings.json). One click switches
 *   the active profile (host re-authenticates the session with it).
 * - Form: saves credentials as a (new or updated) named profile and activates
 *   it. Empty API key keeps the stored one (shown masked).
 */
export function AuthCard({
  auth,
  editable,
  onDismiss,
}: {
  auth: AuthUiState;
  editable: boolean;
  onDismiss: () => void;
}) {
  const send = useChat((s) => s.send);
  const [baseUrl, setBaseUrl] = useState(auth.saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState(auth.saved?.modelName ?? "");
  const [profileName, setProfileName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const hasStored = auth.saved !== null;
  const keyPlaceholder = hasStored ? `已保存（${auth.saved.keyTail}）— 留空保持不变` : "sk-…";

  function submit() {
    const b = baseUrl.trim();
    if (!/^https?:\/\//i.test(b)) {
      setFormError("Base URL 必须以 http:// 或 https:// 开头");
      return;
    }
    if (!modelName.trim()) {
      setFormError("模型名称不能为空");
      return;
    }
    setFormError(null);
    send({
      type: "saveAuth",
      baseUrl: b,
      apiKey: apiKey.trim() === "" ? null : apiKey.trim(),
      modelName: modelName.trim(),
      profileName: profileName.trim() || null,
    });
    onDismiss();
  }

  return (
    <div className="approval-card auth-card" role="dialog" aria-label="API 凭据配置">
      <div className="approval-head">
        <span className="approval-icon">🔑</span>
        <span className="approval-title">
          {auth.authenticated ? "API 配置" : "连接 iFlow 需要配置 API 凭据"}
        </span>
        {!editable && (
          <button className="approval-dismiss" title="收起" onClick={onDismiss}>
            ✕
          </button>
        )}
      </div>

      {auth.profiles.length > 0 && (
        <div className="profile-list">
          <div className="auth-label">API 配置（点击切换，切换后重新认证会话）</div>
          {auth.profiles.map((p) => (
            <div key={p.name} className={`profile-row${p.active ? " active" : ""}`}>
              <button
                className="profile-main"
                title={`${p.baseUrl} · ${p.modelName}（${p.keyTail}）`}
                onClick={() => {
                  if (!p.active) send({ type: "activateProfile", name: p.name });
                }}
              >
                <span className="profile-active-mark">{p.active ? "●" : "○"}</span>
                <span className="profile-name">{p.name}</span>
                <span className="profile-meta">{p.modelName}</span>
              </button>
              <span className={`profile-source ${p.source}`}>{p.source === "extension" ? "扩展" : "CLI"}</span>
              {p.source === "extension" && (
                <button
                  className="profile-delete"
                  title={`删除 ${p.name}`}
                  onClick={() => send({ type: "deleteProfile", name: p.name })}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="auth-form">
        <div className="auth-label">新增 / 更新配置</div>
        <label className="auth-field">
          <span className="auth-label">配置名称（可选，默认为模型名）</span>
          <input
            type="text"
            value={profileName}
            placeholder="如 BUZZ、工作密钥…"
            onChange={(e) => setProfileName(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span className="auth-label">Base URL（OpenAI 兼容）</span>
          <input
            type="text"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span className="auth-label">API Key</span>
          <input
            type="password"
            value={apiKey}
            placeholder={keyPlaceholder}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span className="auth-label">模型名称</span>
          <input
            type="text"
            value={modelName}
            placeholder="如 glm-5.3-flash-free"
            onChange={(e) => setModelName(e.target.value)}
          />
        </label>
        <div className="approval-actions">
          <button className="btn approval-btn allow" onClick={submit}>
            保存并激活
          </button>
        </div>
        {formError && <div className="auth-error">{formError}</div>}
        <div className="auth-note">
          凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存/切换后将以 openai-compatible
          方式重新认证会话。来自 iFlow CLI 的配置为只读，可点击切换但不可在此删除。
        </div>
      </div>
    </div>
  );
}