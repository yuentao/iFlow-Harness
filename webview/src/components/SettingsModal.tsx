import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { Brain, Database, Download, ExternalLink, KeyRound, MessageSquare, MoreHorizontal, Palette, Pencil, Plus, RefreshCw, Server, Settings2, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type {
  AuthUiState,
  ThinkingModelRuleUi,
  UiCliApprovalMode,
  UiCliLanguage,
  UiDefaultMode,
  UiOsNotifications,
  UiThemeMode,
} from "../../../shared/messages";
import { validateAuthForm } from "../../../shared/messages";
import { matchProviderPreset, PROVIDER_PRESETS, type ProviderPreset } from "../../../shared/provider-presets";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, Chip, ConfirmDialog, Dropdown, HelpTip, ModalShell, SAVE_BTN, SettingsDisclosure, SettingsGroup, ActionRow, Field, Hint } from "./ui";
import { McpSection } from "./McpCard";
import { ApprovalPolicySection } from "./ApprovalPolicyCard";
import { MemorySection } from "./MemoryCard";
import { AssetSection } from "./AssetCard";

/**
 * Unified settings modal — the single home for everything the gear opens:
 * accounts & models, conversation behavior, appearance, permissions,
 * MCP tools, memory and runtime/data. Every control writes the same VSCode
 * user settings.json the CLI/config reads, so Settings Sync carries it.
 * Replaces the old three-modal sprawl (AuthCard embedding 「扩展设置」 buttons
 * that swapped into McpCard / ApprovalPolicyCard with no way back).
 *
 * Layout: fixed header (section title + back arrow while editing) → body =
 * nav rail (left on wide viewports, top tab strip when narrow, via the
 * @container on .auth-modal-wide) + scrolling content → fixed footer.
 */
export type SettingsTab = "api" | "chat" | "appearance" | "policy" | "mcp" | "memory" | "assets" | "runtime";

/** Editor-state header override a section reports to the shell (back arrow +
 * contextual title while a sub-editor is open). */
export interface SectionHeader {
  back: () => void;
  title: string;
}

type SectionHeaderSetter = (header: SectionHeader | null) => void;
type SectionHeaderDispatch = Dispatch<SetStateAction<SectionHeader | null>>;

export function SettingsModal({
  tab,
  onTabChange,
  onDismiss,
  dismissible,
  busy,
  auth,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onDismiss: () => void;
  /** False while unauthenticated — the credential setup is mandatory. */
  dismissible: boolean;
  busy: boolean;
  auth: AuthUiState;
}) {
  const send = useChat((s) => s.send);
  // The active section reports {back, title} when it opens a sub-editor; the
  // shell swaps its header accordingly. Reset on tab switch (sections remount).
  const [sectionHeader, setSectionHeader] = useState<SectionHeader | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Roving-tabindex nav: every tab button stays mounted, so the refs are
  // always live and an arrow key can focus the newly-active one right away.
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  useEffect(() => {
    setSectionHeader(null);
    // Each tab is an independent page — carrying the previous scroll offset
    // into it drops the user mid-list with the title out of view.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab]);

  // 4.7: eight peer tabs read as a flat wall. Group them into four named
  // sections (Apple-System-Settings style) — nothing is hidden, the user
  // just sees 4 groups first, then 1–3 items each.
  const TAB_GROUPS: Array<{ label: string; tabs: Array<{ id: SettingsTab; icon: typeof KeyRound; label: string }> }> = [
    { label: t("账户"), tabs: [{ id: "api", icon: KeyRound, label: t("账户与模型") }] },
    {
      label: t("工作方式"),
      tabs: [
        { id: "chat", icon: MessageSquare, label: t("对话") },
        { id: "appearance", icon: Palette, label: t("外观与交互") },
        { id: "policy", icon: ShieldCheck, label: t("权限与审批") },
      ],
    },
    {
      label: t("扩展"),
      tabs: [
        { id: "mcp", icon: Server, label: t("MCP 与工具") },
        { id: "memory", icon: Brain, label: t("记忆与知识") },
        { id: "assets", icon: Sparkles, label: t("技能与命令") },
      ],
    },
    { label: t("系统"), tabs: [{ id: "runtime", icon: Database, label: t("运行与数据") }] },
  ];
  const ALL_TABS = TAB_GROUPS.flatMap((g) => g.tabs.map((x) => x.id));
  const TABS = TAB_GROUPS.flatMap((g) => g.tabs);
  const tabTitle = TABS.find((x) => x.id === tab)?.label ?? "";

  const onNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Sub-editor open: ArrowLeft goes back to the list (same channel as the
    // header back arrow); the other arrows keep tab navigation.
    if (sectionHeader && event.key === "ArrowLeft") {
      event.preventDefault();
      sectionHeader.back();
      return;
    }
    const at = ALL_TABS.indexOf(tab);
    if (at < 0) return;
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (at + 1) % ALL_TABS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (at - 1 + ALL_TABS.length) % ALL_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ALL_TABS.length - 1;
    else return;
    event.preventDefault();
    const id = ALL_TABS[next]!;
    onTabChange(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <ModalShell
      wide
      className="settings-modal"
      role="dialog"
      ariaLabel={t("设置")}
      title={sectionHeader?.title ?? tabTitle}
      icon={<Settings2 className="size-3.5 shrink-0 text-primary" />}
      onBack={sectionHeader?.back ?? null}
      onClose={onDismiss}
      onEscape={() => {
        // Sub-editor open → Esc goes back to the list (matches the header
        // arrow); only the plain tab view closes, and never when mandatory.
        if (sectionHeader) sectionHeader.back();
        else if (dismissible) onDismiss();
      }}
      dismissible={dismissible}
      footer={
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          <HelpTip label={t("设置如何保存")} align="left">
            {t("面板设置写入 VSCode 用户 settings.json，可随 VSCode 设置同步；API Key 只存 SecretStorage，不同步。MCP、语言与审批模式写在 CLI 配置文件，重启 CLI 生效。")}
          </HelpTip>
          <button
            className="press text-ui-caption text-muted-foreground underline-offset-2 transition-colors duration-200 hover:text-foreground hover:underline"
            onClick={() => send({ type: "openSettings" })}
          >
            {t("在 VSCode 设置中编辑…")}
          </button>
          <button
            className={`${BTN} ml-auto`}
            disabled={busy}
            title={t("重启 CLI 进程（会话自动恢复），语言 / 审批模式 / MCP 等设置重启后生效")}
            onClick={() => {
              send({ type: "restartCli" });
              onDismiss();
            }}
          >
            <RefreshCw className="size-3.5" />
            {t("重启 CLI")}
          </button>
        </div>
      }
    >
      <div className="auth-modal-body flex min-h-0 flex-1 flex-col @min-[460px]:flex-row">
        <nav
          role="tablist"
          aria-label={t("设置分区")}
          onKeyDown={onNavKeyDown}
          className="flex shrink-0 flex-col gap-2 border-b border-border/60 p-2 @min-[460px]:w-[172px] @min-[460px]:gap-2.5 @min-[460px]:overflow-visible @min-[460px]:border-b-0 @min-[460px]:border-r"
        >
          {TAB_GROUPS.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex flex-wrap items-center gap-1 @min-[460px]:flex-col @min-[460px]:items-stretch @min-[460px]:gap-0.5"
            >
              <div
                aria-hidden="true"
                className="shrink-0 whitespace-nowrap rounded-md bg-accent/40 px-1.5 py-0.5 text-ui-micro font-semibold tracking-[0.08em] text-muted-foreground/70 @min-[460px]:rounded-none @min-[460px]:bg-transparent @min-[460px]:px-2.5 @min-[460px]:py-1.5"
              >
                {group.label}
              </div>
              {group.tabs.map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={tab === id}
                  aria-current={tab === id ? "page" : undefined}
                  tabIndex={tab === id ? 0 : -1}
                  data-autofocus={tab === id ? "true" : undefined}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  aria-controls="settings-panel"
                  className={`press flex grow basis-[calc(50%_-_2px)] items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-ui-body transition-all duration-200 @min-[460px]:grow-0 @min-[460px]:basis-auto ${
                    tab === id
                      ? "bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                  onClick={() => onTabChange(id)}
                >
                  <Icon className="size-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div
          ref={contentRef}
          id="settings-panel"
          role="tabpanel"
          aria-label={tabTitle}
          className="min-w-0 flex-1 overflow-y-auto px-4 py-4 @min-[460px]:px-5"
        >
          {tab === "api" && <ApiConfigSection auth={auth} busy={busy} onHeader={setSectionHeader} />}
          {tab === "chat" && <ChatSection />}
          {tab === "appearance" && <AppearanceSection />}
          {tab === "policy" && (
            <ApprovalPolicySection busy={busy} onHeader={setSectionHeader} defaults={<PermissionDefaults />} />
          )}
          {tab === "mcp" && <McpTab busy={busy} onHeader={setSectionHeader} />}
          {tab === "memory" && <MemorySection busy={busy} onHeader={setSectionHeader} />}
          {tab === "assets" && <AssetSection busy={busy} onHeader={setSectionHeader} />}
          {tab === "runtime" && <RuntimeSection />}
        </div>
      </div>
    </ModalShell>
  );
}

/** One label/description/control row inside a SettingsGroup. `description`
 * stays a short (≤40 char) "what does this change" line; long technical
 * caveats (restart-to-apply, write path, token cost) go in `detail`, surfaced
 * as an ⓘ tooltip so the row doesn't read as a paragraph. */
function SettingRow({
  label,
  description,
  detail,
  control,
  wideControl = false,
}: {
  label: string;
  description?: string;
  detail?: string;
  control: ReactNode;
  /** Let the control fill the row on narrow viewports (inputs/segmented). */
  wideControl?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 @min-[600px]:flex-row @min-[600px]:items-start @min-[600px]:gap-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-ui-body font-medium leading-snug text-foreground">{label}</span>
          {detail && (
            <HelpTip label={t("详细说明")} align="left">
              {detail}
            </HelpTip>
          )}
        </div>
        {description && <Hint className="mt-1">{description}</Hint>}
      </div>
      <div className={wideControl ? "w-full shrink-0 @min-[600px]:w-auto" : "shrink-0"}>{control}</div>
    </div>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`press relative mt-0.5 inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full border transition-colors duration-200 ${
        checked ? "border-primary/50 bg-primary/70" : "border-border bg-border/70"
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`inline-block size-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-[19px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  detail,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  detail?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return <SettingRow label={label} description={description} detail={detail} control={<Switch checked={checked} label={label} onChange={onChange} />} />;
}

function ChoiceRow<T extends string>({
  label,
  description,
  detail,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  detail?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <div
          role="group"
          aria-label={label}
          className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-panel/60 p-0.5"
        >
          {options.map((option) => (
            <button
              key={option.value || option.label}
              type="button"
              aria-pressed={value === option.value}
              className={`press rounded-md px-2.5 py-1.5 text-ui-label transition-colors duration-200 ${
                value === option.value
                  ? "bg-primary/15 font-semibold text-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    />
  );
}

function NumberRow({
  label,
  description,
  detail,
  value,
  min,
  max,
  step = 1,
  unit,
  onCommit,
}: {
  label: string;
  description: string;
  detail?: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  unit?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max ?? Number.POSITIVE_INFINITY, parsed));
    const next = Math.trunc(clamped);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            className={`${INPUT} w-full text-right @min-[600px]:w-28`}
            value={draft}
            aria-label={label}
            min={min}
            max={max}
            step={step}
            onFocus={() => setFocused(true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setFocused(false);
              commit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          {unit && <span className="shrink-0 text-ui-caption text-muted-foreground">{unit}</span>}
        </div>
      }
    />
  );
}

function TextRow({
  label,
  description,
  detail,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  description: string;
  detail?: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    const next = draft.trim();
    // Always show the normalized text: when it equals the stored value no host
    // echo follows, so the field would otherwise keep the untrimmed draft.
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <input
          type="text"
          className={`${INPUT} w-full font-mono text-ui-caption @min-[600px]:w-64`}
          value={draft}
          aria-label={label}
          placeholder={placeholder}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      }
    />
  );
}

function LinesRow({
  label,
  description,
  value,
  placeholder,
  rows = 3,
  onCommit,
}: {
  label: string;
  description: string;
  value: string[];
  placeholder?: string;
  rows?: number;
  onCommit: (value: string[]) => void;
}) {
  const serialized = value.join("\n");
  const [draft, setDraft] = useState(serialized);
  const [focused, setFocused] = useState(false);
  const last = useRef(serialized);
  useEffect(() => {
    if (last.current === serialized) return;
    last.current = serialized;
    if (!focused) setDraft(serialized);
  }, [serialized, focused]);
  const commit = () => {
    const next = draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const normalized = next.join("\n");
    // Mirror the stored form so the textarea never shows lines that were dropped.
    setDraft(normalized);
    if (normalized !== serialized) onCommit(next);
  };
  return (
    <div className="px-4 py-4">
      <div className="text-ui-body font-medium leading-snug text-foreground">{label}</div>
      <Hint className="mt-1">{description}</Hint>
      <textarea
        className={`${INPUT} mt-2 w-full resize-y font-mono text-ui-label leading-relaxed`}
        rows={rows}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
      />
    </div>
  );
}

function JsonRulesRow({
  value,
  onCommit,
}: {
  value: ThinkingModelRuleUi[];
  onCommit: (rules: ThinkingModelRuleUi[]) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const last = useRef(serialized);
  useEffect(() => {
    if (last.current === serialized) return;
    last.current = serialized;
    if (!dirty) {
      setDraft(serialized);
      setError(null);
    }
  }, [serialized, dirty]);
  function apply() {
    try {
      const parsed = JSON.parse(draft);
      if (!Array.isArray(parsed)) {
        setError(t("条目必须是数组"));
        return;
      }
      setError(null);
      setDirty(false);
      onCommit(parsed as ThinkingModelRuleUi[]);
    } catch {
      setError(t("JSON 格式无效"));
    }
  }
  return (
    <div className="px-4 py-4">
      <div className="text-ui-body font-medium leading-snug text-foreground">{t("思考模型规则")}</div>
      <Hint className="mt-1">
        {t("JSON 数组，每项含 pattern / supportsThinking 等字段；保存后同步到 ~/.iflow/thinking-models.json，重启 CLI 生效。")}
      </Hint>
      <textarea
        className={`${INPUT} mt-2 w-full resize-y font-mono text-ui-label leading-relaxed`}
        rows={6}
        value={draft}
        aria-label={t("思考模型规则")}
        spellCheck={false}
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
      />
      <ActionRow className="mt-2">
        <button className={BTN} onClick={apply}>
          {t("应用")}
        </button>
        {error && <span className="text-ui-caption text-destructive">{error}</span>}
      </ActionRow>
    </div>
  );
}

function RangeRow({
  label,
  description,
  value,
  onCommit,
}: {
  label: string;
  description: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      control={
        <div className="flex w-full items-center gap-2 @min-[600px]:w-48">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={draft}
            aria-label={label}
            className="w-full accent-[var(--color-primary)]"
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={commit}
            onBlur={commit}
            onKeyUp={(e) => {
              if (e.key.startsWith("Arrow")) commit();
            }}
          />
          <span className="w-9 shrink-0 text-right text-ui-caption tabular-nums text-muted-foreground">{draft}%</span>
        </div>
      }
    />
  );
}

/** Chat / turn-end behavior. 4.7: 自动生成标题 is a per-session action, not a
 * turn-end one — it moved to its own 会话 group so the group name stays
 * accurate. Descriptions are trimmed to one short line; the cost/threshold
 * caveats live in the ⓘ tooltip. */
function ChatSection() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("会话")}>
        <ToggleRow
          label={t("自动生成标题")}
          description={t("会话首轮完成后自动生成简短标题。")}
          detail={t("每会话一次，会产生一次轻量模型调用。")}
          checked={settings.autoTitle}
          onChange={(autoTitle) => update({ autoTitle })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("回合结束后")} hint={t("可能产生额外的模型调用")}>
        <ToggleRow
          label={t("下一步建议")}
          description={t("回复完成后推测下一步操作，显示在输入框上方。")}
          detail={t(
            "每轮回复完成后单独调用一次模型（会产生额外 token）。关闭后不再发起调用，已显示的候选会被清除。",
          )}
          checked={settings.nextStepSuggestions}
          onChange={(nextStepSuggestions) => update({ nextStepSuggestions })}
        />
        <ToggleRow
          label={t("自动压缩上下文")}
          description={t("上下文占用达到阈值时自动压缩会话。")}
          detail={t(
            "每轮回复结束后，若上下文占用达到 95%，自动压缩会话后再继续下一轮。默认关闭；网关报超限时仍会自动压缩。",
          )}
          checked={settings.autoCompressOnIdle}
          onChange={(autoCompressOnIdle) => update({ autoCompressOnIdle })}
        />
        <ToggleRow
          label={t("自动提取记忆")}
          description={t("回复完成后提取可长期保留的偏好候选。")}
          detail={t(
            "每轮回复结束后用当前模型提取可长期保留的偏好/约定候选；候选必须由你确认后才会写入（会产生额外 token）。",
          )}
          checked={settings.autoMemoryCapture}
          onChange={(autoMemoryCapture) => update({ autoMemoryCapture })}
        />
      </SettingsGroup>
    </div>
  );
}

/** Appearance, notifications and keyboard shortcuts. */
function AppearanceSection() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  const themeOptions: Array<{ value: UiThemeMode; label: string }> = [
    { value: "auto", label: t("跟随编辑器") },
    { value: "light", label: t("浅色") },
    { value: "dark", label: t("深色") },
  ];
  const notificationOptions: Array<{ value: UiOsNotifications; label: string }> = [
    { value: "off", label: t("从不") },
    { value: "approvals", label: t("仅审批/提问/计划") },
    { value: "all", label: t("全部完成事件") },
  ];
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("主题与排版")}>
        <ChoiceRow
          label={t("主题")}
          description={t("跟随编辑器主题，或固定为浅色/深色。")}
          detail={t("设置写入用户 settings.json，可随 VSCode 设置同步。")}
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => update({ theme })}
        />
        <ChoiceRow
          label={t("字号")}
          description={t("调整面板整体字号。")}
          detail={t("标准为基准，紧凑约 0.92×，大约 1.1×。")}
          value={settings.uiFontSize}
          options={[
            { value: "compact", label: t("紧凑") },
            { value: "standard", label: t("标准") },
            { value: "large", label: t("大") },
          ]}
          onChange={(uiFontSize) => update({ uiFontSize })}
        />
        <ChoiceRow
          label={t("密度")}
          description={t("调整控件内边距与间距。")}
          detail={t("标准为基准，紧凑约 0.92×，宽松约 1.12×。不影响字号。")}
          value={settings.uiDensity}
          options={[
            { value: "compact", label: t("紧凑") },
            { value: "standard", label: t("标准") },
            { value: "comfortable", label: t("宽松") },
          ]}
          onChange={(uiDensity) => update({ uiDensity })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("提示与通知")}>
        <ToggleRow
          label={t("提示音")}
          description={t("回复完成或失败时播放提示音。")}
          checked={settings.soundFeedback}
          onChange={(soundFeedback) => update({ soundFeedback })}
        />
        <ChoiceRow
          label={t("系统通知")}
          description={t("面板不可见时发送系统通知。")}
          detail={t("审批/提问/计划阻塞时，或整轮完成时发送。")}
          value={settings.osNotifications}
          options={notificationOptions}
          onChange={(osNotifications) => update({ osNotifications })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("快捷键")}>
        <div className="space-y-2 px-4 py-4">
          <ShortcutRow keys="Esc" label={t("停止生成（审批卡中为取消/拒绝）")} />
          <ShortcutRow keys="Y / N" label={t("审批允许 / 拒绝")} />
          <ShortcutRow keys="Y / N / R" label={t("计划批准 / 拒绝 / 重新规划")} />
          <ShortcutRow keys="Alt+← / Alt+→" label={t("上一个 / 下一个会话")} />
          <ShortcutRow keys="Alt+N" label={t("新建会话")} />
          <ShortcutRow keys="/" label={t("聚焦输入框")} />
          <ShortcutRow keys="Ctrl/Cmd+Alt+F" label={t("切换 Focus 视图")} />
        </div>
      </SettingsGroup>
      <SettingsDisclosure title={t("高级外观")} hint={t("可选")}>
        <RangeRow
          label={t("极光强度")}
          description={t("背景光斑的不透明度（0–100）。")}
          value={settings.auroraIntensity}
          onCommit={(auroraIntensity) => update({ auroraIntensity })}
        />
      </SettingsDisclosure>
    </div>
  );
}

/** Mode defaults shown above the approval-rule table. */
function PermissionDefaults() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  const approvalOptions: Array<{ value: UiCliApprovalMode; label: string }> = [
    { value: "", label: t("不覆写") },
    { value: "default", label: t("标准") },
    { value: "smart", label: t("智能") },
    { value: "yolo", label: t("免确认") },
    { value: "plan", label: t("规划") },
  ];
  const defaultModeOptions: Array<{ value: UiDefaultMode; label: string }> = [
    { value: "smart", label: t("智能") },
    { value: "default", label: t("标准") },
    { value: "yolo", label: t("免确认") },
    { value: "plan", label: t("规划") },
  ];
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("默认模式")}>
        <ChoiceRow
          label={t("面板默认权限模式")}
          description={t("新会话使用的权限模式。")}
          detail={t("当前会话可用输入框下方的模式菜单切换。")}
          value={settings.defaultMode}
          options={defaultModeOptions}
          onChange={(defaultMode) => update({ defaultMode })}
        />
      </SettingsGroup>
      <SettingsDisclosure title={t("CLI 兼容")} hint={t("重启 CLI 生效")}>
        <ChoiceRow
          label={t("CLI 默认审批模式")}
          description={t("写入 CLI 配置的启动审批模式。")}
          detail={t("写入 ~/.iflow/settings.json；与面板默认模式相互独立，修改后重启 CLI 生效。")}
          value={settings.approvalMode}
          options={approvalOptions}
          onChange={(approvalMode) => update({ approvalMode })}
        />
      </SettingsDisclosure>
    </div>
  );
}

/** Runtime, startup, checkpoints and the raw-settings escape hatch. */
function RuntimeSection() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  const languageOptions: Array<{ value: UiCliLanguage; label: string }> = [
    { value: "", label: t("跟随 CLI") },
    { value: "zh-CN", label: "中文" },
    { value: "en-US", label: "English" },
  ];
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("启动与会话")}>
        <ToggleRow
          label={t("后台预热 CLI")}
          description={t("窗口打开时预热 CLI，首次打开面板无需等待。")}
          detail={t("每窗口约 100MB 内存；下次窗口启动生效。")}
          checked={settings.warmStart}
          onChange={(warmStart) => update({ warmStart })}
        />
        <ToggleRow
          label={t("恢复上次会话")}
          description={t("面板启动时恢复上次使用的会话。")}
          detail={t("无可恢复记录时新建会话。")}
          checked={settings.restoreLastSession}
          onChange={(restoreLastSession) => update({ restoreLastSession })}
        />
        <ToggleRow
          label={t("启动时自动打开面板")}
          description={t("VSCode 启动时自动打开聊天面板。")}
          detail={t("下次启动生效。")}
          checked={settings.autoOpenPanel}
          onChange={(autoOpenPanel) => update({ autoOpenPanel })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("检查点")}>
        <ToggleRow
          label={t("启用检查点")}
          description={t("每轮对话前快照工作区，支持按轮回退。")}
          detail={t("快照写入独立的影子 git 仓库，不触碰你的 .git。")}
          checked={settings.checkpoints}
          onChange={(checkpoints) => update({ checkpoints })}
        />
        <div className="px-4 py-4">
          <div className="text-ui-body font-medium leading-snug text-foreground">{t("磁盘占用")}</div>
          <Hint className="mt-1">
            {t("快照保存在工作区存储中；容量上限等参数在「高级」中调整。")}
          </Hint>
        </div>
      </SettingsGroup>
      <SettingsDisclosure title={t("高级")} hint={t("检查点限额与 CLI 运行时")}>
        <NumberRow
          label={t("最大文件数")}
          description={t("超过该文件数时关闭快照。")}
          value={settings.checkpointMaxFiles}
          min={1}
          onCommit={(checkpointMaxFiles) => update({ checkpointMaxFiles })}
        />
        <NumberRow
          label={t("单文件上限（MB）")}
          description={t("跳过大于该尺寸的文件；0 表示不限。")}
          value={settings.checkpointMaxFileMB}
          min={0}
          unit="MB"
          onCommit={(checkpointMaxFileMB) => update({ checkpointMaxFileMB })}
        />
        <NumberRow
          label={t("保留轮数")}
          description={t("每会话保留的快照轮数；0 表示不清理。")}
          value={settings.checkpointMaxTurns}
          min={0}
          onCommit={(checkpointMaxTurns) => update({ checkpointMaxTurns })}
        />
        <NumberRow
          label={t("总大小上限（MB）")}
          description={t("所有会话快照的总磁盘上限；0 表示不限制。")}
          value={settings.checkpointMaxSizeMB}
          min={0}
          unit="MB"
          onCommit={(checkpointMaxSizeMB) => update({ checkpointMaxSizeMB })}
        />
        <TextRow
          label={t("存储目录")}
          description={t("留空使用默认工作区存储。")}
          detail={t("留空使用默认 workspaceStorage；支持 ~ 与相对路径。")}
          value={settings.checkpointDir}
          placeholder="~/.iflow/checkpoints"
          onCommit={(checkpointDir) => update({ checkpointDir })}
        />
        <TextRow
          label={t("Node.js 路径")}
          description={t("留空自动探测。")}
          detail={t("修改后重启 CLI 生效。")}
          value={settings.nodePath}
          placeholder="C:\\Program Files\\nodejs\\node.exe"
          onCommit={(nodePath) => update({ nodePath })}
        />
        <ChoiceRow
          label={t("CLI 语言")}
          description={t("CLI 界面的显示语言。")}
          detail={t("写入 ~/.iflow/settings.json；修改后重启 CLI 生效。")}
          value={settings.language}
          options={languageOptions}
          onChange={(language) => update({ language })}
        />
      </SettingsDisclosure>
    </div>
  );
}

/** MCP servers live in the CLI's settings file, not in VSCode settings. */
function McpTab({ busy, onHeader }: { busy: boolean; onHeader: SectionHeaderDispatch }) {
  return <McpSection busy={busy} onHeader={onHeader} />;
}

/** One keyboard-shortcut row in the settings cheat sheet. */
function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 font-mono text-ui-caption text-foreground">{keys}</span>
      <span className="min-w-0 flex-1 text-ui-label text-muted-foreground">{label}</span>
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
  const settings = useChat((s) => s.hostSettings);
  const updateHostSetting = useChat((s) => s.updateHostSetting);
  const switching = useChat((s) => s.pending?.kind === "profile");
  const awaitingChoice = useChat((s) => s.state?.pendingProfileSwitch != null);
  // null = list view; { name } = editing an existing profile; { name: null } = new.
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [form, setForm] = useState({ profileName: "", baseUrl: "", apiKey: "", modelName: "" });
  const [formError, setFormError] = useState<string | null>(null);
  // Selected onboarding preset (null = custom endpoint). Kept separate from
  // the form so editing the URL by hand never silently re-labels the form.
  const [presetId, setPresetId] = useState<string | null>(null);
  const preset = presetId ? PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null : null;
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
    setPresetId(null);
  }, []);
  const editingTitle = editing ? (editing.name ? t("编辑配置") : t("添加配置")) : null;
  useEffect(() => {
    onHeader(editingTitle ? { back, title: editingTitle } : null);
  }, [editingTitle, back, onHeader]);

  function applyPreset(next: ProviderPreset) {
    setPresetId(next.id);
    setForm((f) => {
      // Replace a model that the previous preset filled in automatically;
      // keep a model the user typed by hand.
      const wasSuggested = preset?.models.includes(f.modelName.trim()) ?? false;
      return {
        ...f,
        baseUrl: next.baseUrl,
        modelName: next.models[0] ?? (wasSuggested ? "" : f.modelName),
      };
    });
  }

  function openNew(chosen?: ProviderPreset) {
    // Prefill from the active credentials — switching gateways usually means
    // changing one field, not retyping everything. A preset wins when given,
    // including its (possibly empty) model list: never pair a new endpoint
    // with the previous gateway's model.
    setForm({
      profileName: "",
      baseUrl: chosen?.baseUrl ?? auth.saved?.baseUrl ?? "",
      apiKey: "",
      modelName: chosen ? (chosen.models[0] ?? "") : (auth.saved?.modelName ?? ""),
    });
    setPresetId(
      chosen?.id ?? (auth.saved?.baseUrl ? matchProviderPreset(auth.saved.baseUrl)?.id ?? null : null),
    );
    setFormError(null);
    setEditing({ name: null });
  }

  function openEdit(name: string) {
    const p = auth.profiles.find((x) => x.name === name);
    if (!p) return;
    setForm({ profileName: p.name, baseUrl: p.baseUrl, apiKey: "", modelName: p.modelName });
    setPresetId(matchProviderPreset(p.baseUrl)?.id ?? null);
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
      <div className="space-y-3">
        {editing.name && editingProfile?.source === "cli" && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-caption leading-relaxed text-warning">
            {t("这是只读的 CLI 配置；保存将另存为同名的扩展配置并优先使用它。")}
          </p>
        )}
        <div className="space-y-1">
          <div className="text-ui-caption text-muted-foreground">{t("服务商预设")}</div>
          <div className="flex flex-wrap gap-1">
            {PROVIDER_PRESETS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={presetId === option.id}
                className={`press rounded-full border px-2 py-0.5 text-ui-caption transition-colors duration-200 ${
                  presetId === option.id
                    ? "border-primary/50 bg-primary/10 font-semibold text-primary"
                    : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                onClick={() => applyPreset(option)}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={presetId === null}
              className={`press rounded-full border px-2 py-0.5 text-ui-caption transition-colors duration-200 ${
                presetId === null
                  ? "border-primary/50 bg-primary/10 font-semibold text-primary"
                  : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
              onClick={() => setPresetId(null)}
            >
              {t("自定义")}
            </button>
          </div>
        </div>
        {preset && (
          <div className="rounded-lg border border-border bg-surface/60 px-2.5 py-1.5">
            <p className="text-ui-caption leading-relaxed text-muted-foreground">{t(preset.note)}</p>
            <ActionRow className="mt-1">
              {preset.keyUrl && (
                <button
                  className={BTN}
                  onClick={() => send({ type: "openExternal", uri: preset.keyUrl! })}
                >
                  <ExternalLink className="size-3.5" />
                  {t("获取 API Key")}
                </button>
              )}
              {preset.docsUrl && (
                <button
                  className={BTN}
                  onClick={() => send({ type: "openExternal", uri: preset.docsUrl! })}
                >
                  {t("查看文档")}
                </button>
              )}
            </ActionRow>
          </div>
        )}
        <Field label={t("配置名称（可选，默认为模型名）")}>
          <input
            type="text"
            className={INPUT}
            value={form.profileName}
            placeholder={t("如 BUZZ、工作密钥…")}
            onChange={(e) => setForm((f) => ({ ...f, profileName: e.target.value }))}
          />
        </Field>
        <Field label={t("Base URL（OpenAI 兼容）")}>
          <input
            type="text"
            className={INPUT}
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
        </Field>
        <Field label="API Key">
          <input
            type="password"
            className={INPUT}
            value={form.apiKey}
            placeholder={keyPlaceholder}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
        </Field>
        <Field label={t("模型名称")}>
          <input
            type="text"
            className={INPUT}
            value={form.modelName}
            placeholder={t("如 glm-5.3-flash-free")}
            onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
          />
        </Field>
        {preset && preset.models.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-ui-caption text-muted-foreground">{t("常用模型")}</span>
            {preset.models.map((model) => (
              <button
                key={model}
                type="button"
                className="press rounded-full border border-border px-2 py-0.5 font-mono text-ui-caption text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground"
                onClick={() => setForm((f) => ({ ...f, modelName: model }))}
              >
                {model}
              </button>
            ))}
          </div>
        )}
        <ActionRow>
          <button className={SAVE_BTN} disabled={busy} onClick={submit}>
            {t("保存并激活")}
          </button>
          <button className={BTN} onClick={back}>
            {t("取消")}
          </button>
          {formError && <span className="text-ui-label text-destructive">{formError}</span>}
        </ActionRow>
        <Hint>
          {t(
            "凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存后将以 openai-compatible 方式重新认证会话。",
          )}
        </Hint>
      </div>
    );
  }

  // Import is an onboarding shortcut: once this panel has working extension
  // credentials, the CLI profiles below remain switchable but a permanent
  // "import me" banner would just nag.
  const showImport = auth.importable.length > 0 && (auth.needsSetup || auth.saved === null);

  return (
    <div className="space-y-3">
      {showImport && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-ui-label font-semibold text-foreground">
            <Download className="size-3.5 shrink-0 text-primary" />
            {t("检测到 iFlow CLI 已有凭据")}
          </div>
          <Hint className="mt-1">
            {t("可从 ~/.iflow/settings.json 导入为扩展配置；密钥写入 SecretStorage 后由面板管理。")}
          </Hint>
          <div className="mt-2 space-y-2">
            {auth.importable.map((candidate) => (
              <div
                key={candidate.name}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-ui-label font-semibold text-foreground">{candidate.name}</span>
                  <span className="ml-1.5 font-mono text-ui-caption text-muted-foreground">
                    {candidate.modelName} · {candidate.keyTail}
                  </span>
                </span>
                <button
                  className={`${SAVE_BTN} shrink-0 whitespace-nowrap`}
                  disabled={busy}
                  title={`${candidate.baseUrl} · ${candidate.modelName}（${candidate.keyTail}）`}
                  onClick={() => {
                    useChat.getState().beginPending("profile", candidate.name);
                    send({ type: "importCliCredentials", name: candidate.name });
                  }}
                >
                  {t("导入并激活")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {auth.needsSetup && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-caption leading-relaxed text-warning">
          {t("连接 iFlow 需要配置 API 凭据")}
        </p>
      )}
      {switching && (
        <p className="flex items-center gap-1.5 text-ui-caption text-muted-foreground">
          <Chip tone="primary">{awaitingChoice ? t("等待选择…") : t("正在重新认证…")}</Chip>
        </p>
      )}
      {auth.profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={BTN} disabled={busy} onClick={() => openNew()}>
            <Plus className="size-3.5" />
            {t("添加配置")}
          </button>
          <span className="text-ui-caption text-muted-foreground">{t("点击配置即可切换并重新认证")}</span>
        </div>
      )}
      {auth.profiles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4">
          <div className="text-center text-ui-label font-semibold text-foreground">
            {t("尚未添加 API 配置")}
          </div>
          <Hint className="mt-1 text-center">
            {t("选择服务商预设可自动填入端点，也可以手动填写任意 OpenAI 兼容端点。")}
          </Hint>
          <ActionRow className="mt-2 justify-center">
            {PROVIDER_PRESETS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="press rounded-full border border-border px-2 py-0.5 text-ui-caption text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-accent/60 hover:text-foreground"
                onClick={() => openNew(option)}
              >
                {option.label}
              </button>
            ))}
          </ActionRow>
          <ActionRow className="mt-2 justify-center">
            <button className={BTN} onClick={() => openNew()}>
              <Plus className="size-3.5" />
              {t("自定义配置")}
            </button>
          </ActionRow>
        </div>
      ) : (
        <div className="space-y-2">
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
                    <span className="truncate text-ui-label font-semibold text-foreground">{p.name}</span>
                    <Chip tone={p.source === "extension" ? "muted" : "info"}>
                      {p.source === "extension" ? t("扩展") : t("CLI")}
                    </Chip>
                  </span>
                  <span className="block truncate font-mono text-ui-caption text-muted-foreground">
                    {p.modelName} · {p.keyTail}
                  </span>
                </span>
              </button>
              <Dropdown
                align="right"
                menuClass="w-[10rem]"
                disabled={busy}
                trigger={(open) => (
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-label={t("配置 {0} 的操作", p.name)}
                    title={t("更多操作")}
                    disabled={busy}
                    className={`press shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${
                      open ? "bg-accent/60 text-foreground" : ""
                    }`}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <button
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-label text-foreground hover:bg-accent/60"
                      onClick={() => {
                        close();
                        openEdit(p.name);
                      }}
                    >
                      <Pencil className="size-3.5 shrink-0" />
                      {t("编辑")}
                    </button>
                    {p.source === "extension" && (
                      <button
                        role="menuitem"
                        data-variant="danger"
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-label text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          close();
                          setConfirmingDelete(p.name);
                        }}
                      >
                        <Trash2 className="size-3.5 shrink-0" />
                        {t("删除")}
                      </button>
                    )}
                  </>
                )}
              </Dropdown>
            </div>
          ))}
        </div>
      )}
      <Hint>
        {t("点击配置即切换并重新认证会话；来自 iFlow CLI 的配置为只读，可切换但不可在此删除。")}
      </Hint>

      <SettingsDisclosure title={t("模型元数据")} hint={t("高级，可选填")}>
        <LinesRow
          label={t("上下文窗口覆写")}
          description={t("每行「模型名=token数」（如「glm-4.6=200000」）；未知模型回退默认值。")}
          value={settings.contextWindowOverrides}
          placeholder="glm-4.6=200000"
          onCommit={(contextWindowOverrides) => updateHostSetting({ contextWindowOverrides })}
        />
        <LinesRow
          label={t("成本单价")}
          description={t("每行「模型名=输入价,输出价」（USD/百万 token，如「deepseek-v3=0.27,1.1」）。")}
          value={settings.costTable}
          placeholder="deepseek-v3=0.27,1.1"
          onCommit={(costTable) => updateHostSetting({ costTable })}
        />
        <JsonRulesRow
          value={settings.thinkingModelRules}
          onCommit={(thinkingModelRules) => updateHostSetting({ thinkingModelRules })}
        />
      </SettingsDisclosure>

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
