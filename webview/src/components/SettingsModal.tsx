import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Brain, Database, ExternalLink, Globe, KeyRound, Loader2, MessageSquare, MoreHorizontal, Palette, Pencil, Plus, RefreshCw, Server, Settings2, Sparkles, Trash2, Users } from "lucide-react";
import type {
  AuthProfileUi,
  AuthUiState,
  HostSettingsUi,
  ThinkingModelRuleUi,
  UiCliLanguage,
  UiOsNotifications,
  UiThemeMode,
} from "../../../shared/messages";
import { validateAuthForm } from "../../../shared/messages";
import { matchProviderPreset, PROVIDER_PRESETS, type ProviderPreset } from "../../../shared/provider-presets";
import {
  parseContextWindowRow,
  validateContextWindowDraft,
} from "../../../shared/context-window-overrides";
import { useChat } from "../store";
import { t } from "../i18n";
import {
  ActionRow,
  Button,
  Chip,
  CommitNumberInput,
  CommitTextInput,
  ConfirmDialog,
  Dropdown,
  Field,
  HelpTip,
  Hint,
  ICON_INLINE,
  IconButton,
  LinesCommitTextArea,
  ModalShell,
  Segmented,
  Select,
  SettingsDisclosure,
  SettingsGroup,
  Slider,
  Switch,
  TabButton,
  TextArea,
  TextInput,
  ToggleChip,
  rovingTabKeyDown,
} from "./ui";
import { McpSection } from "./McpCard";
import { MemorySection } from "./MemoryCard";
import { AssetSection } from "./AssetCard";
import { QqSettings } from "./QqSettings";

/**
 * Unified settings modal — the single home for everything the gear opens:
 * accounts & models, conversation behavior, appearance, permissions,
 * MCP tools, memory and runtime/data. Every control writes the same VSCode
 * user settings.json the CLI/config reads, so Settings Sync carries it.
 * Replaces the old three-modal sprawl (AuthCard embedding 「扩展设置」 buttons
 * that swapped into other cards with no way back).
 *
 * Layout: fixed header (section title + back arrow while editing) → body =
 * nav rail (left sidebar on wide viewports; below a 560px container a
 * single-row horizontally scrolling tab strip, so the content keeps the full
 * width — the old stacked wrap stole ~312px of height at 360px viewports),
 * via the @container on .auth-modal-wide) + scrolling content → fixed footer.
 */
export type SettingsTab = "api" | "chat" | "appearance" | "mcp" | "memory" | "assets" | "super" | "qq" | "runtime";

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
    // The selected tab must stay visible in the nav (narrow: horizontal
    // scroll strip; the wide rail has its own overflow too) — a keyboard
    // switch from the last visible tab would otherwise leave the selection
    // offscreen. Optional call: jsdom does not implement scrollIntoView.
    tabRefs.current[tab]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  // 4.7: eight peer tabs read as a flat wall. Group them into four named
  // sections (Apple-System-Settings style) — nothing is hidden, the user
  // just sees 4 groups first, then 1–3 items each.
  const TAB_GROUPS: Array<{ label: string; tabs: Array<{ id: SettingsTab; icon: typeof KeyRound; label: string }> }> = [
    { label: t("账户"), tabs: [{ id: "api", icon: KeyRound, label: t("账户与模型") }] },
    {
      label: t("工作方式"),
      tabs: [
        { id: "chat", icon: MessageSquare, label: t("会话") },
        { id: "appearance", icon: Palette, label: t("外观与交互") },
      ],
    },
    {
      label: t("扩展"),
      tabs: [
        { id: "mcp", icon: Server, label: t("MCP 与工具") },
        { id: "memory", icon: Brain, label: t("记忆与知识") },
        { id: "assets", icon: Sparkles, label: t("技能与命令") },
        { id: "super", icon: Users, label: t("超流体") },
        { id: "qq", icon: Globe, label: t("QQ 机器人") },
      ],
    },
    { label: t("系统"), tabs: [{ id: "runtime", icon: Database, label: t("运行与数据") }] },
  ];
  const ALL_TABS = TAB_GROUPS.flatMap((g) => g.tabs.map((x) => x.id));
  const TABS = TAB_GROUPS.flatMap((g) => g.tabs);
  const tabTitle = TABS.find((x) => x.id === tab)?.label ?? "";

  return (
    <ModalShell
      wide
      className="settings-modal"
      role="dialog"
      ariaLabel={t("设置")}
      title={sectionHeader?.title ?? tabTitle}
              icon={<Settings2 className={`${ICON_INLINE} shrink-0 text-primary`} />}      onBack={sectionHeader?.back ?? null}
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
          <HelpTip label={t("设置保存在哪里")} align="left">
            {t("外观、提示这类面板偏好保存在 VSCode 用户设置里，可以随 VSCode 设置同步。API 配置与密钥、MCP、语言保存在本机 iFlow 配置中（密钥为明文，请注意本机安全），重启内核后由新超流体使用最新配置。")}
          </HelpTip>
          <Button
            variant="ghost"
            className="underline-offset-2 hover:underline"
            onClick={() => send({ type: "openSettings" })}
          >
            {t("打开 VSCode 设置")}
          </Button>
          <Button
            className="ml-auto"
            disabled={busy}
            icon={<RefreshCw className={ICON_INLINE} />}
            title={t("重启内核，当前会话会自动恢复。语言改动在重启后生效；MCP 仅供超流体使用，重启后的新超流体会通过共享代理加载。")}
            onClick={() => {
              send({ type: "restartCli" });
              onDismiss();
            }}
          >
            {t("重启内核")}
          </Button>
        </div>
      }
    >
      {/* Narrow container: the nav is a single-row horizontally scrolling tab
       * strip (old stacked wrap ate ~312px of height at 360px viewports);
       * wide container: the classic 172px left sidebar. */}
      <div className="auth-modal-body flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
        <nav
          role="tablist"
          aria-label={t("设置分区")}
          onKeyDown={(event) => {
            // Sub-editor open: ArrowLeft goes back to the list (same channel as
            // the header back arrow); the other arrows keep tab navigation.
            if (sectionHeader && event.key === "ArrowLeft") {
              event.preventDefault();
              sectionHeader.back();
              return;
            }
            rovingTabKeyDown(ALL_TABS, tab, onTabChange, (id) => tabRefs.current[id]?.focus())(event);
          }}
          className="flex min-h-0 flex-row items-center gap-1 overflow-x-auto border-b border-border/60 p-2 @min-[560px]:w-[172px] @min-[560px]:shrink-0 @min-[560px]:flex-col @min-[560px]:items-stretch @min-[560px]:gap-2.5 @min-[560px]:overflow-x-hidden @min-[560px]:overflow-y-auto @min-[560px]:border-b-0 @min-[560px]:border-r"
        >
          {TAB_GROUPS.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex shrink-0 flex-nowrap items-center gap-1 @min-[560px]:flex-col @min-[560px]:items-stretch @min-[560px]:gap-0.5"
            >
              {/* Group caption: narrow strip has no room for it (the row must
               * stay one line tall) — semantics stay on the role="group" wrapper. */}
              <div
                aria-hidden="true"
                className="hidden shrink-0 whitespace-nowrap rounded-md bg-accent/40 px-1.5 py-0.5 text-ui-micro font-semibold tracking-[0.08em] text-muted-foreground/70 @min-[560px]:block @min-[560px]:rounded-none @min-[560px]:bg-transparent @min-[560px]:px-2.5 @min-[560px]:py-1.5"
              >
                {group.label}
              </div>
              {group.tabs.map(({ id, icon: Icon, label }) => (
                <TabButton
                  key={id}
                  active={tab === id}
                  id={`settings-tab-${id}`}
                  controls="settings-panel"
                  icon={<Icon className="size-4 shrink-0" />}
                  onActivate={() => onTabChange(id)}
                  refCallback={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  data-autofocus={tab === id ? "true" : undefined}
                  className="shrink-0"
                >
                  {label}
                </TabButton>
              ))}
            </div>
          ))}
        </nav>
        <div
          ref={contentRef}
          id="settings-panel"
          role="tabpanel"
          aria-label={tabTitle}
          className="min-w-0 flex-1 overflow-y-auto px-4 py-4 @min-[560px]:px-5"
        >
          {tab === "api" && <ApiConfigSection auth={auth} busy={busy} onHeader={setSectionHeader} />}
          {tab === "chat" && <ChatSection />}
          {tab === "appearance" && <AppearanceSection />}
          {tab === "mcp" && <McpTab busy={busy} onHeader={setSectionHeader} />}
          {tab === "memory" && (
            <MemorySection busy={busy} onHeader={setSectionHeader} footer={<MemoryMaintenanceGroup />} />
          )}
          {tab === "assets" && <AssetSection busy={busy} onHeader={setSectionHeader} />}
          {tab === "super" && <SuperAgentSection />}
          {tab === "qq" && <QqSection />}
          {tab === "runtime" && <RuntimeSection />}
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * 「QQ 机器人」页：把纯展示的 QqSettings 接到宿主通道上。
 *
 * 两条通道严格分离：普通设置 → `qqSettingsPatch`，连接/配对/解绑/扫码动作 →
 * `qqConfigAction`。凭据不再手填（扫码成功后由宿主写入 SecretStorage）。
 */
function QqSection() {
  const qqSettings = useChat((s) => s.qqSettings);
  const qqStatus = useChat((s) => s.qqStatus);
  const qqPendingUsers = useChat((s) => s.qqPendingUsers);
  const qqLoginQr = useChat((s) => s.qqLoginQr);
  const qqManagedStatus = useChat((s) => s.qqManagedStatus);
  const send = useChat((s) => s.send);

  return (
    <QqSettings
      value={qqSettings}
      onChange={(patch) => send({ type: "qqSettingsPatch", patch })}
      onTestConnection={() => send({ type: "qqConfigAction", action: "testConnection" })}
      onUnbind={() => send({ type: "qqConfigAction", action: "unbind" })}
      status={qqStatus ?? undefined}
      pendingUsers={qqPendingUsers}
      onUserAction={(openid, action) => send({ type: "qqUserAction", openid, action })}
      onManagedSetup={(action) => send({ type: "qqManagedSetup", action })}
      onQrAction={(action) => send({ type: "qqConfigAction", action })}
      qqLoginQr={qqLoginQr}
      qqManagedStatus={qqManagedStatus}
    />
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

/** Single-choice row: the shared segmented control (one species with the MCP
 * scope / asset kind strips — same surface, padding and active state). */
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
      control={<Segmented ariaLabel={label} options={options} value={value} onChange={onChange} />}
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
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <CommitNumberInput
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          unit={unit}
          className="w-full text-right @min-[600px]:w-28"
          onCommit={onCommit}
        />
      }
    />
  );
}

/** Path row with a native folder-picker trigger. The host owns the dialog;
 * the text field stays for manual entry / echo and keeps the existing
 * absolute-path validation on commit. */
function DirectoryRow({
  label,
  description,
  detail,
  value,
  placeholder,
  buttonLabel,
  onCommit,
}: {
  label: string;
  description: string;
  detail?: string;
  value: string;
  placeholder?: string;
  buttonLabel: string;
  onCommit: (value: string) => void;
}) {
  const send = useChat((s) => s.send);
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <div className="flex min-w-0 items-center gap-2">
          <CommitTextInput
            label={label}
            mono
            value={value}
            placeholder={placeholder}
            className="min-w-0 flex-1"
            onCommit={onCommit}
          />
          <Button size="sm" onClick={() => send({ type: "pickDefaultWorkspace" })}>
            {buttonLabel}
          </Button>
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
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <CommitTextInput
          label={label}
          mono
          value={value}
          placeholder={placeholder}
          className="w-full text-ui-caption @min-[600px]:w-64"
          onCommit={onCommit}
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
  return (
    <div className="px-4 py-4">
      <div className="text-ui-body font-medium leading-snug text-foreground">{label}</div>
      <Hint className="mt-1">{description}</Hint>
      <LinesCommitTextArea
        label={label}
        rows={rows}
        placeholder={placeholder}
        className="mt-2"
        value={value}
        onCommit={onCommit}
      />
    </div>
  );
}

/**
 * 上下文窗口覆写：结构化编辑器（模型名 + 窗口长度），取代原先「每行写
 * `模型名=数值`」的多行文本框。
 *
 * 为什么必须结构化：覆写行的值只能是**纯数字**——`960K` 在运行时会被
 * `parseContextWindowOverrides` 静默丢弃（shared/context-window.ts），文本框
 * 里写错一个单位，用户会以为配好了、实际根本没生效。这里把两个输入框拆开
 * 并做行内校验，让错误在写盘之前就可见。
 *
 * 展示与写盘都走运行时同一套规则（`shared/context-window-overrides.ts`）：
 * 展示时归一化 `auto/x` → `x`；**不能解析的旧行照样列出来并标明「不生效」**，
 * 用户能看见、能删，但不会被一次保存静默吞掉。
 */
function ContextWindowOverridesGroup({
  overrides,
  currentModelId,
  builtinWindow,
  onChange,
}: {
  overrides: string[];
  currentModelId?: string;
  builtinWindow?: number;
  onChange: (next: string[]) => void;
}) {
  const [modelDraft, setModelDraft] = useState("");
  const [windowDraft, setWindowDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows = overrides.map((raw) => ({ raw, parsed: parseContextWindowRow(raw) }));

  function add() {
    const check = validateContextWindowDraft(modelDraft, windowDraft);
    if (!check.ok) {
      setError(
        check.reason === "model"
          ? t("请填写模型名")
          : t("上下文窗口必须是正整数（纯数字，不带 K / M 单位）"),
      );
      return;
    }
    setError(null);
    onChange([...overrides, check.row]);
    setModelDraft("");
    setWindowDraft("");
  }

  function remove(index: number) {
    onChange(overrides.filter((_, i) => i !== index));
  }

  const canSuggest = Boolean(currentModelId) && typeof builtinWindow === "number";

  return (
    <div className="px-4 py-4">
                <div className="text-ui-body font-medium leading-snug text-foreground">{t("自定义上下文窗口")}</div>      <Hint className="mt-1">
        {t("按模型指定上下文窗口（token）。没列出的模型用内建表里的值；模型名精确匹配，不支持通配。")}
      </Hint>
      {rows.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {rows.map((row, index) => (
            <li
              key={`${row.raw}-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/40"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ui-label text-foreground">
                {row.parsed ? row.parsed.model : row.raw}
              </span>
              {row.parsed ? (
                <span className="shrink-0 font-mono text-ui-caption text-muted-foreground">{row.parsed.window}</span>
              ) : (
                <Chip tone="warning">{t("不生效")}</Chip>
              )}
              <IconButton
                icon={<Trash2 className={ICON_INLINE} />}
                tone="danger"
                size="sm"
                label={t("删除覆写 {0}", row.parsed ? row.parsed.model : row.raw)}
                onClick={() => remove(index)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TextInput
          aria-label={t("模型名")}
          value={modelDraft}
          onChange={(event) => {
            setModelDraft(event.target.value);
            setError(null);
          }}
          placeholder="deepseek-v4.1-flash"
          className="min-w-0 flex-1"
        />
        <TextInput
          aria-label={t("上下文窗口")}
          value={windowDraft}
          onChange={(event) => {
            setWindowDraft(event.target.value);
            setError(null);
          }}
          placeholder="960000"
          className="w-32"
        />
        <Button icon={<Plus className={ICON_INLINE} />} onClick={add}>
          {t("添加")}
        </Button>
      </div>
      {error && <div className="mt-1 text-ui-caption text-destructive">{error}</div>}
      {canSuggest && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-ui-caption text-muted-foreground">
            {t("当前模型 {0} 的内建上下文窗口是 {1}。", currentModelId ?? "", builtinWindow ?? 0)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setModelDraft(currentModelId ?? "");
              setWindowDraft(String(builtinWindow ?? ""));
              setError(null);
            }}
          >
            {t("填入建议值")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** JSON editor (explicit apply, not blur-commit): dirty text must survive an
 * invalid parse, so the kit's commit-on-blur species does not fit here. The
 * field still uses the shared textarea chrome; only the save timing differs. */
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
        setError(t("内容需要是列表（最外层用 [ ]）"));
        return;
      }
      setError(null);
      setDirty(false);
      onCommit(parsed as ThinkingModelRuleUi[]);
    } catch {
      setError(t("JSON 格式有误，请检查括号与引号"));
    }
  }
  return (
    <div className="px-4 py-4">
      <div className="text-ui-body font-medium leading-snug text-foreground">{t("思考模型规则")}</div>
      <Hint className="mt-1">
        {t("用 JSON 列表写明哪些模型支持思考：每项包含 pattern（模型匹配）与 supportsThinking（是否支持）。保存后写入本机 iFlow 配置，重启内核生效。")}
      </Hint>
      <TextArea
        mono
        rows={6}
        aria-label={t("思考模型规则")}
        invalid={error !== null}
        className="mt-2 w-full leading-relaxed"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
      />
      <ActionRow className="mt-2">
        <Button onClick={apply}>
          {t("应用修改")}
        </Button>
        {error && <span className="text-ui-caption text-destructive">{error}</span>}
      </ActionRow>
    </div>
  );
}

function RangeRow({
  label,
  description,
  detail,
  value,
  min = 0,
  max = 100,
  onCommit,
}: {
  label: string;
  description: string;
  detail?: string;
  value: number;
  /** Slider band (the Slider's own default is 0–100). */
  min?: number;
  max?: number;
  onCommit: (value: number) => void;
}) {
  return (
    <SettingRow
      wideControl
      label={label}
      description={description}
      detail={detail}
      control={
        <Slider
          label={label}
          value={value}
          min={min}
          max={max}
          step={5}
          format={(v) => `${v}%`}
          className="@min-[600px]:w-48"
          onCommit={onCommit}
        />
      }
    />
  );
}

/**
 * A setting that belongs to the toggle right above it: indented one step and
 * drawn as part of the same block. The group body's `divide-y` strikes the
 * block wrappers, not the toggle and its own row — so no separator appears
 * between a feature and its dependent setting, and the two read as one unit.
 */
function DependentRow({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/50 pl-4">{children}</div>;
}

/**
 * `iflow.superAgent.dependencyPolicy` 的取值，与 package.json 的枚举逐字一致。
 */
type SuperDependencyPolicy = "block" | "continue";

/**
 * Super Agent 的「最大尝试次数」与「依赖策略」两个设置。
 *
 * 宿主接线（`shared/messages.ts` 的 `HostSettingsUi` + `src/panel/panel.ts` 的
 * 读写）由 host 侧负责；这里用「可选扩展视图」读取：字段还没进 `HostSettingsUi`
 * 时回落到下面的默认值（与 package.json 的 `default` 一致），接线后字段自然出现，
 * 本文件不需要再改一次。
 */
type SuperAgentRetryUi = {
  /** `iflow.superAgent.maxAttempts`：失败后最多自动尝试几次（含首次）。 */
  superAgentMaxAttempts?: number;
  /** `iflow.superAgent.dependencyPolicy`：上游失败时下游任务怎么处理。 */
  superAgentDependencyPolicy?: SuperDependencyPolicy;
};

/** 写回宿主设置用的补丁类型。两个字段目前还没进 `HostSettingsUi`，纯扩展类型
 * 又会被 TS 的弱类型检测拦下，所以用交叉类型把它们一起送出去。 */
type SuperAgentRetryPatch = Partial<HostSettingsUi> & SuperAgentRetryUi;

/** 选择器兜底用的空数组：常量引用，避免每次渲染新建数组导致的无谓更新。 */
const EMPTY_AUTH_PROFILES: AuthProfileUi[] = [];

/** manifest 声明的默认值：宿主接线前的兜底读数。 */
const SUPER_MAX_ATTEMPTS_DEFAULT = 2;
const SUPER_MAX_ATTEMPTS_MIN = 1;
const SUPER_MAX_ATTEMPTS_MAX = 5;
const SUPER_DEPENDENCY_POLICY_DEFAULT: SuperDependencyPolicy = "block";

/** 超流体（Super Agent / 子会话）行为：并发、集成、重试、依赖策略、工作目录与
 * 完全信任模式。原先挂在「对话」里，现在拆成独立分类，避免对话页被十余个
 * 超流体控件淹没；分类内再拆两组——「编排与并发」放调度类开关，「安全与信任」
 * 只放完全信任模式及其风险提示，组标题因此不会与分类名（超流体）重复。 */
function SuperAgentSection() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  // Super Agent 的两个新设置：宿主把字段接进 HostSettingsUi 之前，用可选扩展
  // 视图读取并回落到 manifest 声明的默认值。
  const superRetry = settings as HostSettingsUi & SuperAgentRetryUi;
  const superMaxAttempts = Math.min(
    SUPER_MAX_ATTEMPTS_MAX,
    Math.max(SUPER_MAX_ATTEMPTS_MIN, Math.round(superRetry.superAgentMaxAttempts ?? SUPER_MAX_ATTEMPTS_DEFAULT)),
  );
  const superDependencyPolicy = superRetry.superAgentDependencyPolicy ?? SUPER_DEPENDENCY_POLICY_DEFAULT;
  const updateSuper = (patch: SuperAgentRetryPatch) => update(patch);
  const send = useChat((s) => s.send);
  // 超流体链路的两个指针：共享的 HostSettingsUi 已经带有 `superAgentProfile` /
  // `superAgentModel`（可选，空串 = 走回退链），直接读，不再本地维护同形状类型。
  const superProfile = settings.superAgentProfile ?? "";
  const superModel = settings.superAgentModel ?? "";
  // 选项来源：API 配置来自鉴权态快照；模型列表走「按所选 Profile 实时查询」的
  // 专用通道（宿主 GET {baseUrl}/models），**不再**复用主会话的 state.models ——
  // 超流体选了别的 API 配置时，主会话那份列表属于另一个端点，正是要消除的
  // 「同一功能两条通道」隐患。
  const profiles = useChat((s) => s.state?.auth.profiles ?? EMPTY_AUTH_PROFILES);
  const superModelsView = useChat((s) => s.superProfileModelsView);
  // 挂载、切换 API 配置、或宿主回推的 superAgentProfile 变化时，按当前选择重拉。
  // 空串 = 跟随主会话：宿主 resolveSuperProfileTarget 在 profileName 为空时按
  // 回退链（工作区握手凭据 → SecretStorage 活动凭据 → 内核活动 Profile）解析出
  // 活动端点，所以显式传空串即可拿到对应的实时列表，webview 侧不需要另做回退。
  useEffect(() => {
    send({ type: "refreshSuperProfileModels", profileName: superProfile });
  }, [send, superProfile]);
  // 迟到的旧配置回包不参与渲染：store 已按所选名丢弃不匹配的回包，这里再对齐
  // 一次 profileName，避免切换瞬间把旧端点的列表当成新选择的结果。空串选择时
  // 宿主回包是被解析出的活动 Profile 名（不是空串），因此不参与比对。
  const modelsView =
    superModelsView && (!superProfile || superModelsView.profileName === superProfile)
      ? superModelsView
      : null;
  const profileOptions: Array<{ value: string; label: string; description?: string }> = [
    { value: "", label: t("跟随主会话") },
  ];
  for (const profile of profiles) {
    profileOptions.push({ value: profile.name, label: profile.name, description: profile.baseUrl });
  }
  // 当前值对应的配置可能已被删除（或用户手改过 settings.json）：补一条占位选项，
  // 否则下拉会显示成空白，看不出到底选了什么。
  if (superProfile && !profiles.some((profile) => profile.name === superProfile)) {
    profileOptions.push({ value: superProfile, label: superProfile, description: t("找不到这个 API 配置") });
  }
  const modelOptions: Array<{ value: string; label: string; description?: string }> = [
    { value: "", label: t("跟随所选 API 配置") },
  ];
  /** 空串是「跟随所选配置」本身，先占位避免模型 id 恰好为空串时重复。 */
  const knownModels = new Set<string>([""]);
  const pushModel = (id: string | undefined, label?: string, description?: string) => {
    const value = id?.trim();
    if (!value || knownModels.has(value)) return;
    knownModels.add(value);
    modelOptions.push({ value, label: label || value, description });
  };
  for (const model of modelsView?.models ?? []) pushModel(model.id, model.name || model.id, model.id);
  // 所选配置自带的模型名（空串选择时取活动配置）—— 与宿主把 currentModelId
  // 补到列表头的口径一致，保证「配置名不是模型名」时下拉仍能看到实际模型。
  const selectedProfile = superProfile
    ? profiles.find((profile) => profile.name === superProfile)
    : profiles.find((profile) => profile.active);
  pushModel(selectedProfile?.modelName);
  // 当前值不在候选里时补占位，下拉不会显示成空白；宿主回包里的 currentModelId
  // 也补一次（陈旧回包 / 端点列表变化时，实际生效的模型仍可见）。
  if (superModel && !knownModels.has(superModel)) {
    pushModel(superModel, superModel, t("当前模型不在列表里"));
  } else if (modelsView?.currentModelId) {
    pushModel(modelsView.currentModelId);
  }
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("API 与模型")}>
        <SettingRow
          wideControl
          label={t("API 配置")}
          description={t("超流体自己发请求时用的 API 配置。")}
          detail={t("留空（默认）时跟随主会话当前使用的 API 配置；填了名字后，新派发的超流体改用该配置（接口地址、API Key 与默认模型），主会话不受影响。API 配置在「账户与模型」页创建。修改后对下一个派发的超流体生效，已在运行的超流体保持启动时的配置不变。")}
          control={
            <Select
              ariaLabel={t("API 配置")}
              value={superProfile}
              options={profileOptions}
              onChange={(superAgentProfile) => update({ superAgentProfile })}
            />
          }
        />
        <div>
          <SettingRow
            wideControl
            label={t("模型")}
            description={t("超流体自己发请求时用的模型 id。")}
            detail={t("留空（默认）时使用所选 API 配置自带的模型名；下拉里是按所选 API 配置实时查询到的模型列表（端点不可达时不回退内置目录）。修改后对下一个派发的超流体生效，已在运行的超流体保持启动时的模型不变。")}
            control={
              <Select
                ariaLabel={t("模型")}
                value={superModel}
                options={modelOptions}
                onChange={(superAgentModel) => update({ superAgentModel })}
              />
            }
          />
          {modelsView?.error ? (
            <p role="alert" className="-mt-2 px-4 pb-3 text-ui-caption leading-relaxed text-destructive">
              {modelsView.error}
            </p>
          ) : !modelsView ? (
            <p className="-mt-2 flex items-center gap-1.5 px-4 pb-3 text-ui-caption leading-relaxed text-muted-foreground">
              <Loader2 className={`${ICON_INLINE} shrink-0 animate-spin text-primary`} />
              {t("正在连接并读取可用模型…")}
            </p>
          ) : null}
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("后台任务与并发")}>
        <NumberRow
          label={t("并发上限")}
          description={t("最多同时运行几个超流体。")}
          detail={t("默认 5，可设 1–20。超出上限的派发会排队，等有空位再开始；调低后已经在跑的超流体不受影响。")}
          value={settings.superAgentMaxConcurrent}
          min={1}
          max={20}
          unit={t("个")}
          onCommit={(superAgentMaxConcurrent) => update({ superAgentMaxConcurrent })}
        />
        <ChoiceRow
          label={t("完成后如何合并")}
          description={t("超流体完成后，把它的改动并回当前分支的方式。")}
          detail={t("自动合并：并入当前分支（先预演冲突，避开你未提交的改动）；创建 PR：推送分支并开 PR（需要 gh 命令）；手动：只保留分支，自己在看板里合并。改完对下一个完成的超流体生效。")}
          value={settings.superAgentIntegration}
          options={[
            { value: "merge", label: t("自动合并") },
            { value: "pr", label: t("创建 PR") },
            { value: "manual", label: t("手动") },
          ]}
          onChange={(superAgentIntegration) => update({ superAgentIntegration })}
        />
        <NumberRow
          label={t("最大尝试次数")}
          description={t("超流体失败后最多自动尝试几次（含首次）。")}
          detail={t("默认 2，可设 1–5；填 1 表示不自动重试。修改后对下一个启动的超流体生效。")}
          value={superMaxAttempts}
          min={SUPER_MAX_ATTEMPTS_MIN}
          max={SUPER_MAX_ATTEMPTS_MAX}
          unit={t("次")}
          onCommit={(superAgentMaxAttempts) => updateSuper({ superAgentMaxAttempts })}
        />
        <ChoiceRow
          label={t("依赖策略")}
          description={t("上游任务失败时，依赖它的超流体怎么处理。")}
          detail={t("阻塞：跳过后续任务并标记为阻塞；继续：让它照常执行。默认阻塞。")}
          value={superDependencyPolicy}
          options={[
            { value: "block", label: t("阻塞") },
            { value: "continue", label: t("继续") },
          ]}
          onChange={(superAgentDependencyPolicy) => updateSuper({ superAgentDependencyPolicy })}
        />
        <NumberRow
          label={t("工作目录上限")}
          description={t("磁盘上最多保留几个已结束超流体的工作目录。")}
          detail={t("默认 10，可设 0–100；填 0 表示不限。超出时按修改时间从旧到新回收，分支一律保留，有未提交改动的目录不会被回收。")}
          value={settings.superAgentMaxWorktrees}
          min={0}
          max={100}
          unit={t("个")}
          onCommit={(superAgentMaxWorktrees) => update({ superAgentMaxWorktrees })}
        />
        <ToggleRow
          label={t("保留工作目录")}
          description={t("超流体完成后，是否保留它的工作目录。")}
          detail={t("默认关闭：完成后自动回收工作目录（分支一律保留）；失败或中断的超流体从不回收。开启后工作目录会留在磁盘上，可随时手动清理。")}
          checked={settings.superAgentKeepWorktree}
          onChange={(superAgentKeepWorktree) => update({ superAgentKeepWorktree })}
        />
        <DirectoryRow
          label={t("默认工作区")}
          description={t("没有打开任何文件夹时，超流体改用这个目录作为工作区。")}
          detail={t("填绝对路径；留空使用内置默认目录 ~/.iflow/workspace（首次派发会自动创建）。相对路径、以 ~ 开头或指向文件的路径不会写入设置。")}
          value={settings.superAgentDefaultWorkspace}
          placeholder="~/.iflow/workspace"
          buttonLabel={t("选择目录")}
          onCommit={(superAgentDefaultWorkspace) => update({ superAgentDefaultWorkspace })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("安全与信任")}>
        <div>
          <ToggleRow
            label={t("完全信任模式")}
            description={t(
              "超流体直接在主仓工作区运行，不做 Git 工作目录隔离。默认关闭：开启后不再向超流体施加工具白名单与 MCP 服务器白名单限制。",
            )}
            detail={t(
              "开启后超流体保留全部内置工具与共享代理的全部 MCP 服务器，可读写主仓工作区、执行命令，并允许在主仓 push、开 PR、合并。修改后对下一个派发的超流体生效。",
            )}
            checked={settings.superAgentFullTrust}
            onChange={(superAgentFullTrust) => update({ superAgentFullTrust })}
          />
          <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-ui-label leading-relaxed text-warning">
            {t(
              "开启后超流体无需审批即可修改主仓文件、执行任意命令并推送/开 PR，仅在你完全信任派生任务时使用。",
            )}
          </p>
        </div>
      </SettingsGroup>
    </div>
  );
}

/** Chat / turn-end behavior. 4.7: 自动生成标题 is a per-session action, not a
 * turn-end one — it lives in its own 会话 group so the group name stays
 * accurate. 超流体（Super Agent）设置已拆到独立的「超流体」分类；
 * 「记忆整理」整理的是记忆文件本身，已迁到「记忆与知识」分类
 * （见 MemoryMaintenanceGroup），对话页只保留回合级动作。
 * Descriptions are trimmed to one short line; the cost/threshold caveats live
 * in the ⓘ tooltip. */
function ChatSection() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("会话")}>
        <ToggleRow
          label={t("自动生成标题")}
          description={t("首轮对话结束后，自动给会话起一个简短标题。")}
          detail={t("每个会话只生成一次，会额外消耗少量 token。")}
          checked={settings.autoTitle}
          onChange={(autoTitle) => update({ autoTitle })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("回合结束后")} hint={t("每轮结束可能多花一次模型调用")}>
        <div>
          <ToggleRow
            label={t("下一步建议")}
            description={t("每轮回复结束后，推测你接下来可能想做什么，显示在输入框上方。")}
            detail={t(
              "每轮结束会多调用一次模型（消耗额外 token）。关闭后不再调用，已显示的候选会立即清除。",
            )}
            checked={settings.nextStepSuggestions}
            onChange={(nextStepSuggestions) => update({ nextStepSuggestions })}
          />
          {settings.nextStepSuggestions && (
            <DependentRow>
              <NumberRow
                label={t("下一步预测超时")}
                description={t("下一步建议最多等多久。")}
                detail={t(
                  "回合结束时，标题、下一步建议与记忆提取会合并成一次模型调用，实际按其中最长的时间等待。填 0 表示一直等。",
                )}
                value={settings.nextStepTimeoutSeconds}
                min={0}
                max={300}
                unit={t("秒")}
                onCommit={(nextStepTimeoutSeconds) => update({ nextStepTimeoutSeconds })}
              />
            </DependentRow>
          )}
        </div>
        <div>
          <ToggleRow
            label={t("自动压缩上下文")}
            description={t("上下文快满时自动压缩会话，腾出空间继续对话。")}
            detail={t(
              "每轮结束后检查一次，达到设定比例就先压缩再继续。默认关闭；即使关闭，模型报「上下文超出上限」时仍会自动压缩。",
            )}
            checked={settings.autoCompressOnIdle}
            onChange={(autoCompressOnIdle) => update({ autoCompressOnIdle })}
          />
          {settings.autoCompressOnIdle && (
            <DependentRow>
              <NumberRow
                label={t("压缩超时")}
                description={t("压缩最多等多久。")}
                detail={t(
                  "默认 0，表示一直等——很大的会话压缩几分钟是正常的。填入秒数后，超时会取消这次压缩并提示你。",
                )}
                value={settings.compressTimeoutSeconds}
                min={0}
                max={600}
                unit={t("秒")}
                onCommit={(compressTimeoutSeconds) => update({ compressTimeoutSeconds })}
              />
              <RangeRow
                label={t("自动压缩阈值")}
                description={t("上下文用到多少时开始压缩。")}
                detail={t("可调 50–100%，默认 95%。")}
                value={settings.autoCompressThresholdPercent}
                min={50}
                max={100}
                onCommit={(autoCompressThresholdPercent) => update({ autoCompressThresholdPercent })}
              />
            </DependentRow>
          )}
        </div>
        <div>
          <ToggleRow
            label={t("自动提取记忆")}
            description={t("每轮结束后，找出值得长期记住的偏好与约定。")}
            detail={t(
              "用当前模型提取候选，必须经你确认才会写入记忆；每轮会多消耗一次 token。",
            )}
            checked={settings.autoMemoryCapture}
            onChange={(autoMemoryCapture) => update({ autoMemoryCapture })}
          />
          {settings.autoMemoryCapture && (
            <DependentRow>
              <NumberRow
                label={t("记忆提取超时")}
                description={t("记忆提取最多等多久。")}
                detail={t(
                  "回合结束时，标题、下一步建议与记忆提取会合并成一次模型调用，实际按其中最长的时间等待。填 0 表示一直等。",
                )}
                value={settings.memoryExtractTimeoutSeconds}
                min={0}
                max={600}
                unit={t("秒")}
                onCommit={(memoryExtractTimeoutSeconds) => update({ memoryExtractTimeoutSeconds })}
              />
            </DependentRow>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}

/**
 * 记忆整理（P1）：定期在面板空闲时清理记忆托管区块——去重、合并、归档低价值条目。
 *
 * 它整理的是记忆文件本身，因此归入「记忆与知识」分类（原先挂在「对话」页，
 * 与回合结束后的自动提取混在一起，容易被误读为又一个回合级动作）。控件与
 * 文案保持原样：总开关关闭时从属行（策略 / 周期 / 阈值 / 预算）全部隐藏，
 * 避免用户以为关掉开关仍在按默认值整理。
 */
function MemoryMaintenanceGroup() {
  const settings = useChat((s) => s.hostSettings);
  const update = useChat((s) => s.updateHostSetting);
  return (
    <SettingsGroup title={t("记忆整理")} hint={t("只在面板空闲时运行；默认只预览，不改动文件")}>
      <div>
        <ToggleRow
          label={t("定期整理记忆")}
          description={t("空闲时整理记忆文件里由 iFlow 自动维护的那一段：去重、合并，把用处不大的内容移出常用记忆（不再每轮发送）。")}
          detail={t(
            "只在没有进行中的回合、没有待处理的审批或提问、没有运行中的超流体，且空闲达到阈值时运行。默认关闭。",
          )}
          checked={settings.memoryMaintenanceEnabled}
          onChange={(memoryMaintenanceEnabled) => update({ memoryMaintenanceEnabled })}
        />
        {settings.memoryMaintenanceEnabled && (
          <DependentRow>
            <ChoiceRow
              label={t("整理策略")}
              description={t("「只预览」只统计会改动哪些文件，「执行」才真正改写记忆文件。")}
              detail={t(
                "应用策略下每个文件先备份；若期间被其它程序改动则跳过该文件，绝不覆盖。",
              )}
              value={settings.memoryMaintenanceStrategy}
              options={[
                { value: "report", label: t("只预览（不改文件）") },
                { value: "apply", label: t("执行并改写文件") },
              ]}
              onChange={(memoryMaintenanceStrategy) => update({ memoryMaintenanceStrategy })}
            />
            <NumberRow
              label={t("整理周期")}
              description={t("每隔多少天自动整理一次。")}
              value={settings.memoryMaintenanceIntervalDays}
              min={1}
              max={90}
              unit={t("天")}
              onCommit={(memoryMaintenanceIntervalDays) => update({ memoryMaintenanceIntervalDays })}
            />
            <NumberRow
              label={t("空闲阈值")}
              description={t("面板空闲多少分钟后才整理。")}
              value={settings.memoryMaintenanceIdleMinutes}
              min={1}
              max={240}
              unit={t("分钟")}
              onCommit={(memoryMaintenanceIdleMinutes) => update({ memoryMaintenanceIdleMinutes })}
            />
            <NumberRow
              label={t("全局记忆预算")}
              description={t("全局记忆里由 iFlow 自动维护的那一段的 token 预算，超出后优先把用处不大的内容移出常用记忆（不再每轮发送）。")}
              value={settings.memoryMaintenanceGlobalTokenBudget}
              min={500}
              max={50000}
              unit={t("tokens")}
              onCommit={(memoryMaintenanceGlobalTokenBudget) => update({ memoryMaintenanceGlobalTokenBudget })}
            />
            <NumberRow
              label={t("项目记忆预算")}
              description={t("每个项目记忆文件的 token 预算。")}
              value={settings.memoryMaintenanceProjectTokenBudget}
              min={500}
              max={50000}
              unit={t("tokens")}
              onCommit={(memoryMaintenanceProjectTokenBudget) => update({ memoryMaintenanceProjectTokenBudget })}
            />
            <NumberRow
              label={t("总量预算")}
              description={t("所有自动维护的记忆内容合计的 token 阈值，超出就触发整理。")}
              detail={t(
                "超过它时即使未到整理周期也会触发整理；冷却期为 6 小时与周期的四分之一中较大者，冷却期内不重复触发。",
              )}
              value={settings.memoryMaintenanceTotalTokenBudget}
              min={1000}
              max={200000}
              unit={t("tokens")}
              onCommit={(memoryMaintenanceTotalTokenBudget) => update({ memoryMaintenanceTotalTokenBudget })}
            />
          </DependentRow>
        )}
      </div>
    </SettingsGroup>
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
    { value: "approvals", label: t("仅等待你处理时") },
    { value: "all", label: t("每轮完成时") },
  ];
  return (
    <div className="space-y-4">
      <SettingsGroup title={t("主题与排版")}>
        <ChoiceRow
          label={t("主题")}
          description={t("跟随编辑器主题，或固定为浅色/深色。")}
          detail={t("保存在 VSCode 用户设置里，可随 VSCode 设置同步。")}
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => update({ theme })}
        />
        <ChoiceRow
          label={t("字号")}
          description={t("调整面板整体字号")}
          detail={t("以「标准」为基准：紧凑约 0.92 倍字号，大号约 1.1 倍。")}
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
          description={t("调整控件之间的间距，不改字号。")}
          detail={t("以标准为基准：紧凑约 0.92 倍，宽松约 1.12 倍。")}
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
          description={t("面板不在前台时，用系统通知提醒你。")}
          detail={t("审批/提问/计划阻塞时，或整轮完成时发送。")}
          value={settings.osNotifications}
          options={notificationOptions}
          onChange={(osNotifications) => update({ osNotifications })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("快捷键")}>
        <div className="space-y-2 px-4 py-4">
          <ShortcutRow keys="Esc" label={t("停止生成（在审批卡上为拒绝）")} />
          <ShortcutRow keys="Y / N" label={t("审批允许 / 拒绝")} />
          <ShortcutRow keys="Alt+← / Alt+→" label={t("上一个 / 下一个会话")} />
          <ShortcutRow keys="Alt+N" label={t("新建会话")} />
          <ShortcutRow keys="/" label={t("聚焦输入框")} />
          <ShortcutRow keys="Ctrl/Cmd+Alt+F" label={t("切换 Focus 视图")} />
        </div>
      </SettingsGroup>
      <SettingsDisclosure title={t("高级外观")} hint={t("可选")}>
        <RangeRow
          label={t("极光强度")}
          description={t("背景光晕的浓淡：0 为关闭，100 最亮。")}
          value={settings.auroraIntensity}
          onCommit={(auroraIntensity) => update({ auroraIntensity })}
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
    { value: "", label: t("跟随内核") },
    { value: "zh-CN", label: "中文" },
    { value: "en-US", label: "English" },
  ];
  return (
    <div className="space-y-4">
      <Hint className="px-1">
        {t("内核：在后台运行的 iFlow 服务进程；重启后会重新加载记忆、技能与 MCP 服务器。")}
      </Hint>
      <SettingsGroup title={t("启动与会话")}>
        <ToggleRow
          label={t("后台预热内核")}
          description={t("窗口打开时提前启动内核，首次打开面板不用等。")}
          detail={t("每个窗口约 100MB 内存；下次窗口启动生效。")}
          checked={settings.warmStart}
          onChange={(warmStart) => update({ warmStart })}
        />
        <ToggleRow
          label={t("恢复上次会话")}
          description={t("面板启动时恢复上次使用的会话。")}
          detail={t("没有可恢复的记录时会新建会话。")}
          checked={settings.restoreLastSession}
          onChange={(restoreLastSession) => update({ restoreLastSession })}
        />
        <ToggleRow
          label={t("启动时自动打开面板")}
          description={t("VSCode 启动时自动打开聊天面板。")}
          detail={t("下次启动生效")}
          checked={settings.autoOpenPanel}
          onChange={(autoOpenPanel) => update({ autoOpenPanel })}
        />
      </SettingsGroup>
      <SettingsGroup title={t("检查点")}>
        <ToggleRow
          label={t("启用检查点")}
          description={t("每轮对话前保存一份工作区快照，之后可以按轮回退。")}
          detail={t("快照放在单独的目录里，不会动你的 Git 仓库。")}
          checked={settings.checkpoints}
          onChange={(checkpoints) => update({ checkpoints })}
        />
        <div className="px-4 py-4">
          <div className="text-ui-body font-medium leading-snug text-foreground">{t("磁盘占用")}</div>
          <Hint className="mt-1">
            {t("快照会占用磁盘空间，上限等参数在「高级」里调整。")}
          </Hint>
        </div>
      </SettingsGroup>
      <SettingsDisclosure title={t("高级")} hint={t("检查点限额与内核运行时")}>
        <NumberRow
          label={t("最大文件数")}
          description={t("工作区文件超过这个数量就不再保存快照。")}
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
          description={t("快照存放在哪里")}
          detail={t("留空则用默认位置；支持 ~ 和相对路径。")}
          value={settings.checkpointDir}
          placeholder="~/.iflow/checkpoints"
          onCommit={(checkpointDir) => update({ checkpointDir })}
        />
        <TextRow
          label={t("Node.js 路径")}
          description={t("留空则自动查找")}
          detail={t("修改后重启内核生效")}
          value={settings.nodePath}
          placeholder="C:\\Program Files\\nodejs\\node.exe"
          onCommit={(nodePath) => update({ nodePath })}
        />
        <ChoiceRow
          label={t("内核语言")}
          description={t("内核的显示语言")}
          detail={t("修改后重启内核生效")}
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
 * credential editor. Saving upserts a named profile into the kernel config
 * (`~/.iflow/settings.json`); only the row the panel is actually running on
 * re-authenticates the session — editing another row just saves it.
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
  const metadata = useChat((s) => s.modelMetadata);
  // The dedicated override channel carries the rows plus the current model's
  // built-in window (for the one-click suggestion). `hostSettings` is the
  // fallback until that channel's first push arrives.
  const contextWindowView = useChat((s) => s.contextWindowOverridesView);
  const switching = useChat((s) => s.pending?.kind === "profile");
  const awaitingChoice = useChat((s) => s.state?.pendingProfileSwitch != null);
  // null = list view; { name } = editing an existing profile; { name: null } = new.
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [form, setForm] = useState({ profileName: "", baseUrl: "", apiKey: "", modelName: "" });
  const [formError, setFormError] = useState<string | null>(null);
  // A save keeps the editor OPEN until the host replies with an explicit
  // `saveAuthResult`. Optimistic close used to destroy the typed values on a
  // failed save (validation, duplicate name, kernel-write failure). `saving`
  // disables submit and shows progress; `pendingSaveRef` correlates the reply
  // so a receipt from another save (onboarding wizard / other tab) can neither
  // close this form nor stamp an unrelated error onto it.
  const [saving, setSaving] = useState(false);
  const pendingSaveRef = useRef<number | null>(null);
  const nextSaveIdRef = useRef(0);
  // Selected onboarding preset (null = custom endpoint). Kept separate from
  // the form so editing the URL by hand never silently re-labels the form.
  const [presetId, setPresetId] = useState<string | null>(null);
  const preset = presetId ? PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null : null;
  // Modal delete confirm (same dialog as sessions / MCP rows — the host delete
  // is irreversible: the profile's key leaves SecretStorage for good).
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  // .card-lift's hover transform makes every row a stacking context. While a
  // menu is open its row must outrank later siblings, or the menu's z-30 stays
  // trapped beneath the next row's more button.
  const [openMenuProfile, setOpenMenuProfile] = useState<string | null>(null);
  // Ignore stale names after a profile becomes active or is deleted.
  const raisedProfileName = openMenuProfile && auth.profiles.some((p) => !p.active && p.name === openMenuProfile)
    ? openMenuProfile
    : null;
  // Delete receipt: the host answers with `profileDeleteResult` after it
  // really removed the profile (SecretStorage + kernel file). The row shows a
  // pending chip until then — the confirm dialog used to close and the row
  // just lingered with zero feedback while the write was in flight.
  const [deletingProfile, setDeletingProfile] = useState<string | null>(null);
  useEffect(() => {
    if (!deletingProfile) return;
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type?: string; name?: string };
      if (msg?.type !== "profileDeleteResult" || msg.name !== deletingProfile) return;
      setDeletingProfile(null);
    };
    window.addEventListener("message", handler);
    // Failsafe: a lost reply must not lock the row forever (the host also
    // surfaces a toast when the delete failed).
    const timer = setTimeout(() => setDeletingProfile(null), 10_000);
    return () => {
      window.removeEventListener("message", handler);
      clearTimeout(timer);
    };
  }, [deletingProfile]);

  // saveAuth receipt: the form stays open until the host actually confirms
  // the write. Only a matching requestId may settle this editor — the wizard
  // and other tabs send saveAuth too, and a stale/foreign receipt must not
  // discard what the user just typed.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        requestId?: number;
        ok?: boolean;
        error?: string;
      };
      if (msg?.type !== "saveAuthResult") return;
      if (pendingSaveRef.current === null || msg.requestId !== pendingSaveRef.current) return;
      pendingSaveRef.current = null;
      setSaving(false);
      if (msg.ok) {
        setEditing(null);
        setFormError(null);
        setPresetId(null);
      } else {
        // Keep every field as typed; surface the host's concrete reason
        // inline (not just a toast the user can miss).
        setFormError(msg.error ?? t("保存失败，请稍后重试"));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const editingProfile = editing?.name ? auth.profiles.find((p) => p.name === editing.name) : undefined;
  // Saving the profile the panel is actually running on re-authenticates the
  // live session, so it must wait for a free turn. Adding a new profile also
  // activates it (cold re-auth). Editing any other row only writes the kernel
  // file — the host does not touch the running session — so it stays
  // saveable while a turn or a child session is in flight.
  const editingActiveProfile = editing?.name != null && editingProfile?.active === true;
  const saveBlocked = busy && (editing?.name == null || editingActiveProfile);
  // The stored-key notice is rendered as a secondary line under the field,
  // never as the placeholder: a placeholder never wraps nor ellipsizes, so in
  // a narrow panel the sentence was clipped mid-way and the reveal toggle
  // floated away from the collapsed input.
  const savedKeyTail = editingProfile?.keyTail ?? auth.saved?.keyTail;

  const back = useCallback(() => {
    pendingSaveRef.current = null;
    setSaving(false);
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
    const requestId = ++nextSaveIdRef.current;
    pendingSaveRef.current = requestId;
    setSaving(true);
    send({
      type: "saveAuth",
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() === "" ? null : form.apiKey.trim(),
      modelName: form.modelName.trim(),
      profileName: form.profileName.trim() || null,
      // Editing an existing profile: tell the host which key to drop if the
      // user renamed it (or cleared the name) — otherwise the old row lingers
      // next to the new one. A new profile has no previous name.
      replaceName: editing?.name ?? null,
      requestId,
    });
    // Do NOT close here. The host owns persistence (SecretStorage + kernel
    // settings.json + possible re-auth); only its `saveAuthResult` may settle
    // this form. On failure every field stays exactly as typed and the inline
    // error explains why. `saving` disables the button meanwhile.
  }

  if (editing) {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <div className="text-ui-caption text-muted-foreground">{t("服务商预设")}</div>
          <div className="flex flex-wrap gap-1">
            {PROVIDER_PRESETS.map((option) => (
              <ToggleChip key={option.id} active={presetId === option.id} onClick={() => applyPreset(option)}>
                {option.label}
              </ToggleChip>
            ))}
            <ToggleChip active={presetId === null} onClick={() => setPresetId(null)}>
              {t("自定义")}
            </ToggleChip>
          </div>
        </div>
        {preset && (
          <div className="rounded-lg border border-border bg-surface/60 px-2.5 py-1.5">
            <p className="text-ui-caption leading-relaxed text-muted-foreground">{t(preset.note)}</p>
            <ActionRow className="mt-1">
              {preset.keyUrl && (
                <Button icon={<ExternalLink className={ICON_INLINE} />} onClick={() => send({ type: "openExternal", uri: preset.keyUrl! })}>
                  {t("获取 API Key")}
                </Button>
              )}
              {preset.docsUrl && (
                <Button onClick={() => send({ type: "openExternal", uri: preset.docsUrl! })}>
                  {t("查看文档")}
                </Button>
              )}
            </ActionRow>
          </div>
        )}
        <Field label={t("配置名称（可选，默认用模型名）")}>
          <TextInput
            value={form.profileName}
            placeholder={t("如 工作密钥、备用线路")}
            onChange={(e) => setForm((f) => ({ ...f, profileName: e.target.value }))}
          />
        </Field>
        <Field label={t("接口地址（Base URL）")}>
          <TextInput
            mono
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
        </Field>
        <Field label="API Key">
          <TextInput
            type="password"
            revealable
            mono
            value={form.apiKey}
            placeholder="sk-…"
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
        </Field>
        {savedKeyTail && <Hint>{t("已保存（{0}），留空则不改", savedKeyTail)}</Hint>}
        <Field label={t("模型名称")}>
          <TextInput
            mono
            value={form.modelName}
            placeholder={t("如 glm-5.3-flash-free")}
            onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
          />
        </Field>
        {preset && preset.models.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-ui-caption text-muted-foreground">{t("常用模型")}</span>
            {preset.models.map((model) => (
              <ToggleChip
                key={model}
                mono
                active={form.modelName.trim() === model}
                onClick={() => setForm((f) => ({ ...f, modelName: model }))}
              >
                {model}
              </ToggleChip>
            ))}
          </div>
        )}
        <ActionRow>
          <Button variant="primary" disabled={saveBlocked || saving} onClick={submit}>
            {saving ? t("保存中…") : t("保存")}
          </Button>
          {formError && (
            <span role="alert" aria-live="assertive" className="text-ui-label text-destructive">
              {formError}
            </span>
          )}
        </ActionRow>
        {saveBlocked && editingActiveProfile && (
          <Hint>{t("这是正在使用的配置。正在生成或有超流体在跑，暂时不能保存。")}</Hint>
        )}
        <Hint>
          {t(
            "配置与密钥以明文保存在本机 iFlow 配置中。编辑正在使用的配置会重新连接；编辑其他配置只是保存，不会切换。",
          )}
        </Hint>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {auth.needsSetup && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-caption leading-relaxed text-warning">
          {t("还没有 API 配置，暂时无法开始对话")}
        </p>
      )}
      {switching && (
        <p className="flex items-center gap-1.5 text-ui-caption text-muted-foreground">
          <Chip tone="primary">{awaitingChoice ? t("等待选择…") : t("正在重新连接…")}</Chip>
        </p>
      )}
      {auth.profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Plus className={ICON_INLINE} />} disabled={busy} onClick={() => openNew()}>
            {t("添加配置")}
          </Button>
          <span className="text-ui-caption text-muted-foreground">{t("点一下配置即可切换，当前会话会重新连接")}</span>
        </div>
      )}
      {auth.profiles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4">
          <div className="text-center text-ui-label font-semibold text-foreground">
            {t("还没有 API 配置")}
          </div>
          <Hint className="mt-1 text-center">
            {t("选一个服务商预设可自动填好接口地址，也可以手动填写任意兼容 OpenAI 的接口。")}
          </Hint>
          <ActionRow className="mt-2 justify-center">
            {PROVIDER_PRESETS.map((option) => (
              <ToggleChip key={option.id} onClick={() => openNew(option)}>
                {option.label}
              </ToggleChip>
            ))}
          </ActionRow>
          <ActionRow className="mt-2 justify-center">
            <Button icon={<Plus className={ICON_INLINE} />} onClick={() => openNew()}>
              {t("自定义配置")}
            </Button>
          </ActionRow>
        </div>
      ) : (
        <div className="space-y-2">
          {auth.profiles.map((p) => {
            const menuOpen = raisedProfileName === p.name;
            const deleting = deletingProfile === p.name;
            return (
              <div
                key={p.name}
                className={`card-lift flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-card transition-colors duration-200 ${
                  p.active ? "border-primary/50 bg-primary/10" : "border-border"
                } ${menuOpen ? "relative z-20" : ""}`}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:pointer-events-none disabled:opacity-40"
                  title={`${p.baseUrl} · ${p.modelName}（${p.keyTail}）`}
                  disabled={busy || p.active || deleting}
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
                    <span className="block truncate text-ui-label font-semibold text-foreground">{p.name}</span>
                    <span className="block truncate font-mono text-ui-caption text-muted-foreground">
                      {p.modelName} · {p.keyTail}
                    </span>
                  </span>
                </button>
                {deleting ? (
                  <Chip tone="info">
                    <Loader2 className={`${ICON_INLINE} animate-spin`} />
                    {t("删除中…")}
                  </Chip>
                ) : !p.active ? (
                  <Dropdown
                    align="right"
                    menuClass="w-[10rem]"
                    disabled={busy}
                    onOpenChange={(open) =>
                      setOpenMenuProfile((current) => {
                        if (open) return p.name;
                        return current === p.name ? null : current;
                      })
                    }
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
                      </>
                    )}
                  </Dropdown>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <Hint>
        {t("点击配置即可切换，当前会话会用新配置重新连接。配置与密钥以明文保存在本机 iFlow 配置中。")}
      </Hint>

      <SettingsDisclosure title={t("模型元数据")} hint={t("高级，可选填")}>
        <div>
          <SettingRow
            label={t("联网补充模型数据")}
            description={t("联网查官方资料，由当前模型提炼后补进下面的表。")}
            detail={t(
              "检索由面板直接发起，不占用当前会话；资料交给当前模型提炼一次（额外消耗 token）。只补充、不覆盖已有数据；资料里找不到依据的条目会被丢弃。",
            )}
            control={
              <Button
                variant="secondary"
                disabled={metadata.state === "searching"}
                icon={metadata.state === "searching"
                  ? <Loader2 className={`${ICON_INLINE} animate-spin`} />
                  : <Globe className={ICON_INLINE} />}
                onClick={() => send({ type: "fetchModelMetadata" })}
              >
                {metadata.state === "searching" ? t("正在检索…") : t("开始检索")}
              </Button>
            }
          />
          <div className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pb-3">
            {metadata.state === "searching" ? (
              <>
                <Loader2 className={`${ICON_INLINE} shrink-0 animate-spin text-primary`} />
                <span className="min-w-0 flex-1 text-ui-caption leading-relaxed text-muted-foreground">
                  {t("正在检索资料，随后交给当前模型提炼…")}
                </span>
                <Button variant="secondary" size="sm" onClick={() => send({ type: "cancelModelMetadata" })}>
                  {t("停止检索")}
                </Button>
              </>
            ) : metadata.state === "error" && metadata.error ? (
              <span className="min-w-0 flex-1 text-ui-caption leading-relaxed text-destructive">{metadata.error}</span>
            ) : metadata.state === "done" && metadata.added ? (
              <>
                <Sparkles className={`${ICON_INLINE} shrink-0 text-primary`} />
                <span className="min-w-0 flex-1 text-ui-caption leading-relaxed text-muted-foreground">
                  {metadata.added.windows + metadata.added.costs + metadata.added.rules > 0
                    ? t(
                        "已追加：上下文窗口 {0} 条 · 成本单价 {1} 条 · 思考规则 {2} 条",
                        metadata.added.windows,
                        metadata.added.costs,
                        metadata.added.rules,
                      )
                    : t("检索完成，资料中没有可补充的新数据。")}
                </span>
              </>
            ) : (
              <>
                <Sparkles className={`${ICON_INLINE} shrink-0 text-primary`} />
                <span className="min-w-0 flex-1 text-ui-caption leading-relaxed text-muted-foreground">
                  {t("检索到的资料会交给当前模型提炼一次，额外消耗 token。")}
                </span>
              </>
            )}
          </div>
        </div>
        <ContextWindowOverridesGroup
          overrides={contextWindowView?.overrides ?? settings.contextWindowOverrides}
          currentModelId={contextWindowView?.currentModelId}
          builtinWindow={contextWindowView?.builtinWindow}
          onChange={(overrides) => send({ type: "setContextWindowOverrides", overrides })}
        />
        <LinesRow
          label={t("成本单价")}
          description={t("每行写「模型名=输入价，输出价」，单位为美元/百万 token，如 deepseek-v3=0.27,1.1。")}
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
          message={t("配置「{0}」和它的密钥会一起删除，无法恢复。", confirmingDelete)}
          onConfirm={() => {
            if (confirmingDelete) setDeletingProfile(confirmingDelete);
            send({ type: "deleteProfile", name: confirmingDelete });
            setConfirmingDelete(null);
          }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  );
}
