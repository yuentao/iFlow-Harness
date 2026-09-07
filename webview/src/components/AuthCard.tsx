import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { AuthUiState } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";

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
  const activeProfile = auth.profiles.find((p) => p.active && p.source === "extension");
  const [baseUrl, setBaseUrl] = useState(auth.saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState(auth.saved?.modelName ?? "");
  const [profileName, setProfileName] = useState(activeProfile?.name ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  const keyPlaceholder = auth.saved ? t("已保存（{0}）— 留空保持不变", auth.saved.keyTail) : "sk-…";

  function submit() {
    const b = baseUrl.trim();
    if (!/^https?:\/\//i.test(b)) {
      setFormError(t("Base URL 必须以 http:// 或 https:// 开头"));
      return;
    }
    if (!modelName.trim()) {
      setFormError(t("模型名称不能为空"));
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

  const INPUT =
    "rounded-md border border-border bg-editor px-2.5 py-1.5 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60";

  return (
    <div
      className="auth-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("API 凭据配置")}
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onMouseDown={(e) => {
        // Backdrop click / Escape dismiss (not while unauthenticated — the
        // setup banner is mandatory).
        if (e.target === e.currentTarget && !auth.needsSetup) onDismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !auth.needsSetup) onDismiss();
      }}
    >
      <div className="auth-modal">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-2">
          <KeyRound className="size-3.5 text-primary" />
          <span className="text-[12px] font-semibold">
            {auth.authenticated ? t("API 配置") : t("连接 iFlow 需要配置 API 凭据")}
          </span>
          {/* The setup banner is not dismissible while unauthenticated. */}
          {!auth.needsSetup && (
            <button
              className="ml-auto text-[12px] text-muted-foreground hover:text-foreground"
              title={t("收起")}
              onClick={onDismiss}
            >
              ✕
            </button>
          )}
        </div>

        <div className="space-y-2.5 px-3 py-2.5">
        {auth.profiles.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11.5px] text-muted-foreground">
              {t("API 配置（点击切换，切换后重新认证会话）")}
            </div>
            {auth.profiles.map((p) => (
              <div
                key={p.name}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] ${
                  p.active ? "border-primary/50 bg-primary/10" : "border-border"
                }`}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={`${p.baseUrl} · ${p.modelName}（${p.keyTail}）`}
                  onClick={() => {
                    if (!p.active) send({ type: "activateProfile", name: p.name });
                  }}
                >
                  <span className={p.active ? "text-primary" : "text-muted-foreground"}>
                    {p.active ? "●" : "○"}
                  </span>
                  <span className="truncate font-semibold text-foreground">{p.name}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{p.modelName}</span>
                </button>
                <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                  {p.source === "extension" ? t("扩展") : t("CLI")}
                </span>
                {p.source === "extension" && (
                  <button
                    className="shrink-0 text-[11px] text-muted-foreground opacity-70 hover:opacity-100 hover:text-destructive"
                    title={t("删除 {0}", p.name)}
                    onClick={() => send({ type: "deleteProfile", name: p.name })}
                  >
                    🗑
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[11.5px] text-muted-foreground">{t("新增 / 更新配置")}</div>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("配置名称（可选，默认为模型名）")}</span>
            <input
              type="text"
              className={INPUT}
              value={profileName}
              placeholder={t("如 BUZZ、工作密钥…")}
              onChange={(e) => setProfileName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("Base URL（OpenAI 兼容）")}</span>
            <input
              type="text"
              className={INPUT}
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">API Key</span>
            <input
              type="password"
              className={INPUT}
              value={apiKey}
              placeholder={keyPlaceholder}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("模型名称")}</span>
            <input
              type="text"
              className={INPUT}
              value={modelName}
              placeholder={t("如 glm-5.3-flash-free")}
              onChange={(e) => setModelName(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              onClick={submit}
            >
              {t("保存并激活")}
            </button>
            {formError && <span className="text-[12px] text-destructive">{formError}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            {t(
              "凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存/切换后将以 openai-compatible 方式重新认证会话。来自 iFlow CLI 的配置为只读，可点击切换但不可在此删除。",
            )}
          </p>
          </div>
        </div>
      </div>
    </div>
  );
}
