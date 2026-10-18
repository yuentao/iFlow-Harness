import { useCallback, useEffect, useState } from "react";
import { KeyRound, Moon, Pencil, Plus, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sun, Trash2 } from "lucide-react";
import type { AuthUiState } from "../../../shared/messages";
import { validateAuthForm } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, Chip, ConfirmDialog, ModalShell, SAVE_BTN } from "./ui";
import { McpSection } from "./McpCard";
import { ApprovalPolicySection } from "./ApprovalPolicyCard";

/**
 * Unified settings modal — the single home for everything the gear opens:
 * API profiles & credentials, MCP servers, approval policies, plus the
 * VSCode-settings / CLI-restart utilities and the light/dark theme control
 * in the footer (the theme toggle used to sit in the header). Replaces the
 * old three-modal sprawl (AuthCard embedding 「扩展设置」 buttons that swapped
 * into McpCard / ApprovalPolicyCard with no way back), which made the whole
 * settings surface feel disjointed.
 *
 * Layout: fixed header (section title + back arrow while editing) → body =
 * nav rail (left on wide viewports, top tab strip when narrow, via the
 * @container on .auth-modal-wide) + scrolling content → fixed footer.
 */
export type SettingsTab = "api" | "mcp" | "policy" | "general";

/** Editor-state header override a section reports to the shell (back arrow +
 * contextual title while a sub-editor is open). */
export interface SectionHeader {
  back: () => void;
  title: string;
}

type SectionHeaderSetter = (header: SectionHeader | null) => void;

export function SettingsModal({
  tab,
  onTabChange,
  onDismiss,
  dismissible,
  busy,
  auth,
  dark,
  onThemeChange,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onDismiss: () => void;
  /** False while unauthenticated — the credential setup is mandatory. */
  dismissible: boolean;
  busy: boolean;
  auth: AuthUiState;
  /** Effective theme (manual choice ?? editor theme) — drives the footer
   * segmented control's active state. */
  dark: boolean;
  /** Persist an explicit theme choice (replaces the old header toggle). */
  onThemeChange: (mode: "light" | "dark") => void;
}) {
  const send = useChat((s) => s.send);
  // The active section reports {back, title} when it opens a sub-editor; the
  // shell swaps its header accordingly. Reset on tab switch (sections remount).
  const [sectionHeader, setSectionHeader] = useState<SectionHeader | null>(null);
  useEffect(() => {
    setSectionHeader(null);
  }, [tab]);

  const TABS: Array<{ id: SettingsTab; icon: typeof KeyRound; label: string }> = [
    { id: "api", icon: KeyRound, label: t("API 配置") },
    { id: "mcp", icon: Server, label: t("MCP 服务器") },
    { id: "policy", icon: ShieldCheck, label: t("审批策略") },
    { id: "general", icon: SlidersHorizontal, label: t("通用") },
  ];
  const tabTitle = TABS.find((x) => x.id === tab)?.label ?? "";

  return (
    <ModalShell
      wide
      role="dialog"
      ariaLabel={t("设置")}
      title={sectionHeader?.title ?? tabTitle}
      icon={<Settings2 className="size-3.5 shrink-0 text-primary" />}
      onBack={sectionHeader?.back ?? null}
      onClose={onDismiss}
      dismissible={dismissible}
      footer={
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          <button className={BTN} onClick={() => send({ type: "openSettings" })}>
            {t("打开 VSCode 设置…")}
          </button>
          <button
            className={BTN}
            disabled={busy}
            title={t("重启 CLI 进程（会话自动恢复），语言 / 审批模式 / MCP 等设置重启后生效")}
            onClick={() => {
              send({ type: "restartCli" });
              onDismiss();
            }}
          >
            <RefreshCw className="mr-0.5 inline size-3 align-[-2px]" />
            {t("重启 CLI")}
          </button>
          {/* Theme control (moved out of the header): an explicit choice
              persists and overrides the editor theme, same semantics as the
              old header toggle. */}
          <div
            className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-surface/60 p-0.5"
            role="group"
            aria-label={t("主题")}
          >
            <button
              type="button"
              aria-pressed={!dark}
              title={t("浅色主题")}
              className={`press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-200 ${
                !dark ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
              onClick={() => onThemeChange("light")}
            >
              <Sun className="size-3" /> {t("浅色")}
            </button>
            <button
              type="button"
              aria-pressed={dark}
              title={t("深色主题")}
              className={`press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-200 ${
                dark ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
              onClick={() => onThemeChange("dark")}
            >
              <Moon className="size-3" /> {t("深色")}
            </button>
          </div>
        </div>
      }
    >
      <div className="auth-modal-body flex min-h-0 flex-1 flex-col @min-[460px]:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 p-1.5 @min-[460px]:w-[132px] @min-[460px]:flex-col @min-[460px]:overflow-visible @min-[460px]:border-b-0 @min-[460px]:border-r">
          {TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              className={`press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-all duration-200 ${
                tab === id
                  ? "bg-primary/10 font-semibold text-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
              onClick={() => onTabChange(id)}
            >
              <Icon className="size-3.5 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-3 py-2.5">
          {tab === "api" && <ApiConfigSection auth={auth} busy={busy} onHeader={setSectionHeader} />}
          {tab === "mcp" && <McpSection busy={busy} onHeader={setSectionHeader} />}
          {tab === "policy" && <ApprovalPolicySection busy={busy} onHeader={setSectionHeader} />}
          {tab === "general" && <GeneralSection />}
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * General behavior toggles mirrored from VSCode configuration. The host owns
 * the authoritative values (`hostSettings` message); toggling is optimistic
 * locally and confirmed by the host's echo.
 */
function GeneralSection() {
  const settings = useChat((s) => s.hostSettings);
  const updateHostSetting = useChat((s) => s.updateHostSetting);
  return (
    <div className="space-y-2">
      <ToggleRow
        label={t("下一步建议")}
        description={t(
          "每轮回复完成后单独调用一次模型，推测可选的下一步操作并显示在输入框上方（会产生额外 token 消耗）。",
        )}
        checked={settings.nextStepSuggestions}
        onChange={(value) => updateHostSetting({ nextStepSuggestions: value })}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground/85">
        {t("默认开启。关闭后不再发起该模型调用，已显示的候选会被清除。")}
      </p>
      <ToggleRow
        label={t("自动压缩上下文")}
        description={t(
          "每轮回复结束后，若上下文占用达到 95%，自动压缩会话后再继续下一轮（会产生一次压缩轮次）。",
        )}
        checked={settings.autoCompressOnIdle}
        onChange={(value) => updateHostSetting({ autoCompressOnIdle: value })}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground/85">
        {t("默认关闭。未开启时仍会在网关报上下文超限后自动压缩，也可点击提示中的「立即压缩」。")}
      </p>
    </div>
  );
}

/** One labeled switch row shared by the general settings toggles. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface/60 px-2.5 py-2 shadow-card">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-foreground">{label}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`press relative mt-0.5 inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border transition-colors duration-200 ${
          checked ? "border-primary/50 bg-primary/70" : "border-border bg-border/70"
        }`}
        onClick={() => onChange(!checked)}
      >
        <span
          className={`inline-block size-[12px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-[17px]" : "translate-x-[2px]"
          }`}
        />
      </button>
    </div>
  );
}

/**
 * API profiles & credentials section: the profile list (one click switches —
 * with the same optimistic switch lock the header dropdown uses — edit loads
 * the profile into the form, delete keeps the two-step confirm) and the
 * credential editor. Saving upserts a named profile and re-authenticates the
 * session (host-side, SecretStorage only).
 */
function ApiConfigSection({
  auth,
  busy,
  onHeader,
}: {
  auth: AuthUiState;
  busy: boolean;
  onHeader: SectionHeaderSetter;
}) {
  const send = useChat((s) => s.send);
  const switching = useChat((s) => s.pending?.kind === "profile");
  // null = list view; { name } = editing an existing profile; { name: null } = new.
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [form, setForm] = useState({ profileName: "", baseUrl: "", apiKey: "", modelName: "" });
  const [formError, setFormError] = useState<string | null>(null);
  // Modal delete confirm (same dialog as sessions / MCP rows — the host delete
  // is irreversible: the profile's key leaves SecretStorage for good).
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const editingProfile = editing?.name ? auth.profiles.find((p) => p.name === editing.name) : undefined;
  const keyPlaceholder = (() => {
    const tail = editingProfile?.keyTail ?? auth.saved?.keyTail;
    return tail ? t("已保存（{0}）— 留空保持不变", tail) : "sk-…";
  })();

  const back = useCallback(() => {
    setEditing(null);
    setFormError(null);
  }, []);
  const editingTitle = editing ? (editing.name ? t("编辑配置") : t("添加配置")) : null;
  useEffect(() => {
    onHeader(editingTitle ? { back, title: editingTitle } : null);
  }, [editingTitle, back, onHeader]);

  function openNew() {
    // Prefill from the active credentials — switching gateways usually means
    // changing one field, not retyping everything.
    setForm({
      profileName: "",
      baseUrl: auth.saved?.baseUrl ?? "",
      apiKey: "",
      modelName: auth.saved?.modelName ?? "",
    });
    setFormError(null);
    setEditing({ name: null });
  }

  function openEdit(name: string) {
    const p = auth.profiles.find((x) => x.name === name);
    if (!p) return;
    setForm({ profileName: p.name, baseUrl: p.baseUrl, apiKey: "", modelName: p.modelName });
    setFormError(null);
    setEditing({ name: p.name });
  }

  function submit() {
    const error = validateAuthForm({
      baseUrl: form.baseUrl.trim(),
      modelName: form.modelName.trim(),
      apiKey: form.apiKey.trim() === "" ? undefined : form.apiKey.trim(),
    });
    if (error) {
      setFormError(t(error));
      return;
    }
    setFormError(null);
    send({
      type: "saveAuth",
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() === "" ? null : form.apiKey.trim(),
      modelName: form.modelName.trim(),
      profileName: form.profileName.trim() || null,
    });
    // Stay in the modal: the list re-renders with the new active profile once
    // the host's re-auth snapshot lands (the switch chip covers the wait).
    setEditing(null);
  }

  if (editing) {
    return (
      <div className="space-y-2">
        {editing.name && editingProfile?.source === "cli" && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
            {t("这是只读的 CLI 配置；保存将另存为同名的扩展配置并优先使用它。")}
          </p>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-[11.5px] text-muted-foreground">{t("配置名称（可选，默认为模型名）")}</span>
          <input
            type="text"
            className={INPUT}
            value={form.profileName}
            placeholder={t("如 BUZZ、工作密钥…")}
            onChange={(e) => setForm((f) => ({ ...f, profileName: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11.5px] text-muted-foreground">{t("Base URL（OpenAI 兼容）")}</span>
          <input
            type="text"
            className={INPUT}
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11.5px] text-muted-foreground">API Key</span>
          <input
            type="password"
            className={INPUT}
            value={form.apiKey}
            placeholder={keyPlaceholder}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11.5px] text-muted-foreground">{t("模型名称")}</span>
          <input
            type="text"
            className={INPUT}
            value={form.modelName}
            placeholder={t("如 glm-5.3-flash-free")}
            onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button className={SAVE_BTN} disabled={busy} onClick={submit}>
            {t("保存并激活")}
          </button>
          <button className={BTN} onClick={back}>
            {t("取消")}
          </button>
          {formError && <span className="text-[12px] text-destructive">{formError}</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground/85">
          {t(
            "凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存后将以 openai-compatible 方式重新认证会话。",
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {auth.needsSetup && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
          {t("连接 iFlow 需要配置 API 凭据。")}
        </p>
      )}
      {switching && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Chip tone="primary">{t("正在重新认证…")}</Chip>
        </p>
      )}
      {auth.profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center">
          <div className="text-[12px] text-muted-foreground">{t("尚未添加 API 配置")}</div>
          <button className={`${SAVE_BTN} mt-2`} onClick={openNew}>
            <Plus className="mr-0.5 inline size-3 align-[-2px]" />
            {t("添加 API 配置")}
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {auth.profiles.map((p) => (
            <div
              key={p.name}
              className={`card-lift flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-card transition-colors duration-200 ${
                p.active ? "border-primary/50 bg-primary/10" : "border-border"
              }`}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:pointer-events-none disabled:opacity-40"
                title={`${p.baseUrl} · ${p.modelName}（${p.keyTail}）`}
                disabled={busy || p.active}
                onClick={() => {
                  if (p.active) return;
                  // Same optimistic switch lock as the header dropdown —
                  // without it every switcher stayed live during the
                  // re-auth round trip (the old AuthCard list bug).
                  useChat.getState().beginPending("profile", p.name);
                  send({ type: "activateProfile", name: p.name });
                }}
              >
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    p.active ? "bg-primary shadow-[0_0_0_3px] shadow-primary/25" : "border border-muted-foreground/50"
                  }`}
                />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[12px] font-semibold text-foreground">{p.name}</span>
                    <Chip tone={p.source === "extension" ? "muted" : "info"}>
                      {p.source === "extension" ? t("扩展") : t("CLI")}
                    </Chip>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {p.modelName} · {p.keyTail}
                  </span>
                </span>
              </button>
              <button
                className="press shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                title={t("编辑 {0}", p.name)}
                disabled={busy}
                onClick={() => openEdit(p.name)}
              >
                <Pencil className="size-3.5" />
              </button>
              {p.source === "extension" && (
                <button
                  data-variant="danger"
                  className="press shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                  title={t("删除 {0}", p.name)}
                  onClick={() => setConfirmingDelete(p.name)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {auth.profiles.length > 0 && (
        <button className={BTN} disabled={busy} onClick={openNew}>
          <Plus className="mr-0.5 inline size-3 align-[-2px]" />
          {t("添加配置")}
        </button>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground/85">
        {t("点击配置即切换并重新认证会话；来自 iFlow CLI 的配置为只读，可切换但不可在此删除。")}
      </p>

      {confirmingDelete && (
        <ConfirmDialog
          title={t("删除配置")}
          message={t("确定删除配置「{0}」吗？其密钥将从 SecretStorage 中永久移除。", confirmingDelete)}
          onConfirm={() => {
            send({ type: "deleteProfile", name: confirmingDelete });
            setConfirmingDelete(null);
          }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  );
}
