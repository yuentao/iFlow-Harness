import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ExternalLink, KeyRound, Lock, Sparkles } from "lucide-react";
import type { AuthUiState, ModelInfoUi, UiDefaultMode } from "../../../shared/messages";
import { validateAuthForm } from "../../../shared/messages";
import { matchProviderPreset, PROVIDER_PRESETS, type ProviderPreset } from "../../../shared/provider-presets";
import { useChat } from "../store";
import { modeDisplay, t } from "../i18n";
import { Button, Field, ICON_DISPLAY, ICON_INLINE, ModalShell, OptionCard, OptionGroup, SearchInput, TextInput, ToggleChip, fuzzyScore } from "./ui";
import type { SettingsTab } from "./SettingsModal";
import logo from "../assets/iflow.svg";

/**
 * First-run wizard. Deliberately NOT the settings modal: a new user gets one
 * decision per screen, a visible progress bar, and a single escape door.
 * The settings modal remains the long-term home for everything here (and the
 * deeper MCP / approval-policy / memory / appearance editors).
 *
 * UI-audit 4.8: welcome merged into the connect step (one header line instead
 * of three marketing cards) and the preferences step moved out entirely — theme
 * and font size now ship with sane defaults, and the done step links to
 * Settings → Appearance. Four steps: connect → model → mode → done.
 */

type Step = "connect" | "model" | "mode" | "done";

const STEPS: Step[] = ["connect", "model", "mode", "done"];

const EMPTY_MODELS: ModelInfoUi[] = [];

/** Search only earns a row once the catalog is long enough to need it. */
const MODEL_SEARCH_MIN = 8;

const MODE_FALLBACK: Array<{ id: string; name: string }> = [
  { id: "smart", name: "" },
  { id: "default", name: "" },
  { id: "yolo", name: "" },
  { id: "plan", name: "" },
];

const DEFAULT_MODES: readonly UiDefaultMode[] = ["default", "smart", "yolo", "plan"];

function isDefaultMode(value: string): value is UiDefaultMode {
  return (DEFAULT_MODES as readonly string[]).includes(value);
}

function stepTitle(step: Step): string {
  switch (step) {
    case "connect":
      return t("连接 iFlow");
    case "model":
      return t("选择模型");
    case "mode":
      return t("权限模式");
    case "done":
      return t("完成");
  }
}

export function OnboardingWizard({
  auth,
  onClose,
  onOpenSettings,
}: {
  auth: AuthUiState;
  onClose: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
}) {
  const send = useChat((s) => s.send);
  const status = useChat((s) => s.state?.status ?? null);
  const errorMessage = useChat((s) => s.state?.errorMessage ?? null);
  const initializing = useChat((s) => s.state?.initializing ?? false);
  const sessionId = useChat((s) => s.state?.sessionId ?? null);
  const modes = useChat((s) => s.state?.modes ?? null);
  const models = useChat((s) => s.state?.models ?? EMPTY_MODELS);
  const currentModelId = useChat((s) => s.state?.currentModelId ?? null);
  const hostSettings = useChat((s) => s.hostSettings);
  const updateHostSetting = useChat((s) => s.updateHostSetting);

  const [step, setStep] = useState<Step>("connect");
  const index = STEPS.indexOf(step);

  // --- API step state -------------------------------------------------------
  const [draft, setDraft] = useState({
    baseUrl: auth.saved?.baseUrl ?? "",
    apiKey: "",
    modelName: auth.saved?.modelName ?? "",
  });
  const [presetId, setPresetId] = useState<string | null>(
    auth.saved?.baseUrl ? (matchProviderPreset(auth.saved.baseUrl)?.id ?? null) : null,
  );
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiSubmitted, setApiSubmitted] = useState(false);
  const preset = presetId ? (PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null) : null;
  const connecting = status === "connecting" || initializing;

  // Initial focus lands on the first field that still needs typing (audit 4.8:
  // "API 步初始焦点放在第一个空输入"), not on the primary button — otherwise
  // the whole form has to be reached with Shift+Tab. Later steps move focus to
  // the primary action instead of leaving it on a field that just disappeared.
  const [connectFocus] = useState<"baseUrl" | "apiKey" | "modelName" | "primary">(() => {
    if (!(auth.saved?.baseUrl ?? "").trim()) return "baseUrl";
    if (!auth.saved) return "apiKey";
    if (!(auth.saved?.modelName ?? "").trim()) return "modelName";
    return "primary";
  });
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const modelNameRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (step !== "connect") {
      primaryRef.current?.focus();
      return;
    }
    const target =
      connectFocus === "baseUrl"
        ? baseUrlRef
        : connectFocus === "apiKey"
          ? apiKeyRef
          : connectFocus === "modelName"
            ? modelNameRef
            : null;
    (target?.current ?? primaryRef.current)?.focus();
    // Mount + step change only: re-focusing on every keystroke would fight the caret.
  }, [step, connectFocus]);

  function updateDraft(patch: Partial<typeof draft>) {
    setDraft((f) => ({ ...f, ...patch }));
    if (apiError) setApiError(null);
  }

  function applyPreset(next: ProviderPreset) {
    setPresetId(next.id);
    setDraft((f) => {
      const wasSuggested = preset?.models.includes(f.modelName.trim()) ?? false;
      return {
        ...f,
        baseUrl: next.baseUrl,
        modelName: next.models[0] ?? (wasSuggested ? "" : f.modelName),
      };
    });
    if (apiError) setApiError(null);
  }

  function saveCredentials(advance = true) {
    const baseUrl = draft.baseUrl.trim();
    const modelName = draft.modelName.trim();
    const apiKey = draft.apiKey.trim();
    const error =
      validateAuthForm({ baseUrl, modelName, apiKey: apiKey || undefined }) ??
      (!apiKey && !auth.saved ? t("API Key 不能为空") : null);
    if (error) {
      setApiError(t(error));
      return;
    }
    setApiError(null);
    send({ type: "saveAuth", baseUrl, apiKey: apiKey || null, modelName, profileName: null });
    setApiSubmitted(true);
    if (advance) setStep("model");
  }

  function importCredentials(name: string) {
    useChat.getState().beginPending("profile", name);
    send({ type: "importCliCredentials", name });
    setApiSubmitted(true);
    setStep("model");
  }

  // --- Mode step ------------------------------------------------------------
  const modeOptions = modes?.availableModes?.length ? modes.availableModes : MODE_FALLBACK;

  function chooseMode(id: string) {
    if (isDefaultMode(id) && id !== hostSettings.defaultMode) {
      updateHostSetting({ defaultMode: id });
    }
    if (sessionId && id !== modes?.currentModeId) {
      useChat.getState().beginPending("mode", id);
      send({ type: "setMode", modeId: id });
    }
  }

  // --- Model step -----------------------------------------------------------
  const [modelQuery, setModelQuery] = useState("");
  const visibleModels = useMemo(() => {
    const q = modelQuery.trim();
    if (!q) return models;
    return models
      .map((model) => ({
        model,
        score: Math.max(fuzzyScore(q, model.name) ?? -1, fuzzyScore(q, model.id) ?? -1),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.model);
  }, [modelQuery, models]);

  function chooseModel(model: ModelInfoUi) {
    if (model.id === currentModelId) return;
    useChat.getState().beginPending("model", model.id);
    send({ type: "setModel", modelId: model.id });
  }

  // --- Navigation -----------------------------------------------------------
  // Single escape door (audit 4.8): one "稍后设置" instead of a global skip plus
  // an API-step "稍后配置".
  function skip() {
    send({ type: "setOnboardingDismissed", dismissed: true });
    onClose();
  }

  function finish(openTab?: SettingsTab) {
    send({ type: "setOnboardingDismissed", dismissed: true });
    onClose();
    if (openTab) onOpenSettings(openTab);
  }

  function advance() {
    switch (step) {
      case "connect":
        saveCredentials();
        break;
      case "model":
        setStep("mode");
        break;
      case "mode":
        setStep("done");
        break;
      case "done":
        finish();
        break;
    }
  }

  function back() {
    if (index > 0) setStep(STEPS[index - 1]!);
  }

  const savedModelLabel = currentModelId ?? auth.saved?.modelName ?? t("尚未选择");
  const connectionLabel = auth.authenticated && !auth.needsSetup
    ? `${auth.saved?.modelName ?? savedModelLabel}`
    : t("尚未配置（可稍后在设置中完成）");

  return (
    <ModalShell
      wide
      ariaLabel={t("初始化引导")}
      title={stepTitle(step)}
      icon={<Sparkles className={`${ICON_INLINE} shrink-0 text-primary`} />}
      onClose={skip}
      dismissible={false}
      initialFocus="first"
      footer={
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          {step !== "done" && (
            <Button variant="ghost" onClick={skip}>
              {t("稍后设置")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {index > 0 && step !== "done" && (
              <Button onClick={back}>
                {t("上一步")}
              </Button>
            )}
            <Button
              variant="primary"
              ref={primaryRef}
              disabled={step === "connect" && apiSubmitted && connecting}
              onClick={advance}
            >
              {step === "done"
                ? t("开始使用")
                : step === "connect"
                  ? t("保存并继续")
                  : t("下一步")}
              {step !== "done" && <ArrowRight className="size-3.5" />}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div
            className="flex flex-1 items-center gap-1"
            role="progressbar"
            aria-label={t("初始化进度")}
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={index + 1}
            aria-valuetext={`${index + 1} / ${STEPS.length} · ${stepTitle(step)}`}
          >
            {STEPS.map((name, i) => (
              <span
                key={name}
                className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                  i <= index ? "bg-primary" : "bg-border"
                }`}
              />
            ))}
          </div>
          <span className="shrink-0 text-ui-caption tabular-nums text-muted-foreground">
            {t("第 {0} / {1} 步", index + 1, STEPS.length)}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {step === "connect" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <img src={logo} alt="" className="size-8 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-ui-label font-semibold text-foreground">{t("欢迎使用 心流·驭光")}</h2>
                  <p className="text-ui-caption leading-relaxed text-muted-foreground">
                    {t("连接模型服务后即可开始对话；其他设置都能在 ⚙ 中修改。")}
                  </p>
                </div>
              </div>

              <p className="text-ui-caption leading-relaxed text-muted-foreground">
                {t("选择服务商预设可自动填入端点，也可以手动填写任意 OpenAI 兼容端点。")}
              </p>
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

              {preset && (
                <div className="rounded-lg border border-border bg-surface/60 px-2.5 py-1.5">
                  <p className="text-ui-caption leading-relaxed text-muted-foreground">{t(preset.note)}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
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
                  </div>
                </div>
              )}

              {auth.importable.length > 0 && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 text-ui-label font-semibold text-foreground">
                    <KeyRound className="size-3.5 shrink-0 text-primary" />
                    {t("检测到 iFlow CLI 已有凭据")}
                  </div>
                  <div className="mt-1 space-y-1">
                    {auth.importable.map((candidate) => (
                      <div
                        key={candidate.name}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-2 py-1"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-ui-label font-semibold text-foreground">{candidate.name}</span>
                          <span className="ml-1.5 min-w-0 truncate font-mono text-ui-caption text-muted-foreground">
                            {candidate.modelName} · {candidate.keyTail}
                          </span>
                        </span>
                        <Button
                          variant="primary"
                          size="sm"
                          className="shrink-0 whitespace-nowrap"
                          onClick={() => importCredentials(candidate.name)}
                        >
                          {t("导入并激活")}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Field label={t("Base URL（OpenAI 兼容）")}>
                <TextInput
                  mono
                  ref={baseUrlRef}
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(e) => updateDraft({ baseUrl: e.target.value })}
                />
              </Field>
              <Field label="API Key">
                <TextInput
                  type="password"
                  mono
                  ref={apiKeyRef}
                  value={draft.apiKey}
                  placeholder={auth.saved?.keyTail ? t("已保存（{0}）— 留空保持不变", auth.saved.keyTail) : "sk-…"}
                  onChange={(e) => updateDraft({ apiKey: e.target.value })}
                />
              </Field>
              <Field label={t("模型名称")}>
                <TextInput
                  mono
                  ref={modelNameRef}
                  value={draft.modelName}
                  placeholder={t("如 glm-5.3-flash-free")}
                  onChange={(e) => updateDraft({ modelName: e.target.value })}
                />
              </Field>
              {preset && preset.models.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-ui-caption text-muted-foreground">{t("常用模型")}</span>
                  {preset.models.map((model) => (
                    <ToggleChip key={model} mono active={draft.modelName.trim() === model} onClick={() => updateDraft({ modelName: model })}>
                      {model}
                    </ToggleChip>
                  ))}
                </div>
              )}
              {apiError && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-ui-caption text-destructive">
                  {apiError}
                </p>
              )}
              <p className="flex items-start gap-1 text-ui-caption leading-relaxed text-muted-foreground/85">
                <Lock className="mt-0.5 size-3 shrink-0" />
                {t("凭据保存在 VSCode SecretStorage，不写入磁盘明文；保存后将以 openai-compatible 方式重新认证会话。")}
              </p>
            </div>
          )}

          {step === "model" && (
            <div className="space-y-2">
              <p className="text-ui-label leading-relaxed text-muted-foreground">
                {t("选择默认使用的模型；随时可以在面板顶部的模型下拉中切换。")}
              </p>
              {models.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                  <div className="text-ui-label font-semibold text-foreground">
                    {connecting
                      ? t("正在连接 iFlow CLI 并获取模型列表…")
                      : auth.needsSetup
                        ? t("尚未连接")
                        : t("暂无可用模型列表")}
                  </div>
                  <p className="mt-1 text-ui-caption leading-relaxed text-muted-foreground">
                    {auth.needsSetup && !connecting
                      ? t("保存凭据后会自动获取模型；也可以稍后在模型下拉中选择。")
                      : t("可点击下方按钮重新获取。")}
                  </p>
                  <div className="mt-2 flex justify-center gap-1.5">
                    <Button onClick={() => send({ type: "refreshModels" })}>
                      {t("重新获取")}
                    </Button>
                    {auth.needsSetup && (
                      <Button onClick={() => setStep("connect")}>
                        {t("返回填写凭据")}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* Search appears only for long catalogs (same rule as the
                      composer's model menu) and stays pinned above the list. */}
                  {models.length > MODEL_SEARCH_MIN && (
                    <SearchInput
                      mono
                      ariaLabel={t("搜索模型")}
                      placeholder={t("搜索模型…")}
                      value={modelQuery}
                      onChange={setModelQuery}
                    />
                  )}
                  <OptionGroup
                    ariaLabel={t("可用模型")}
                    className="max-h-[min(50vh,20rem)] space-y-1 overflow-y-auto"
                  >
                    {visibleModels.length === 0 && (
                      <div className="px-2 py-3 text-center text-ui-label text-muted-foreground">
                        {t("无匹配模型")}
                      </div>
                    )}
                    {visibleModels.map((model) => (
                      <OptionCard
                        key={model.id}
                        checked={model.id === currentModelId}
                        label={model.name || model.id}
                        description={model.id}
                        className="w-full"
                        onClick={() => chooseModel(model)}
                      />
                    ))}
                  </OptionGroup>
                </>
              )}
              {apiSubmitted && errorMessage && (
                <p className="whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-ui-caption text-destructive">
                  {errorMessage}
                </p>
              )}
              <p className="text-ui-caption text-muted-foreground">
                {t("当前模型：{0}", savedModelLabel)}
              </p>
            </div>
          )}

          {step === "mode" && (
            <div className="space-y-2">
              <p className="text-ui-label leading-relaxed text-muted-foreground">
                {t("选择新会话默认的权限模式；点击选项后当前会话也会立即切换。之后可在设置 → 审批策略中细化规则。")}
              </p>
              <OptionGroup ariaLabel={t("默认权限模式")} className="space-y-1">
                {modeOptions.map((mode) => {
                  const display = modeDisplay(mode);
                  return (
                    <OptionCard
                      key={mode.id}
                      checked={mode.id === hostSettings.defaultMode}
                      label={display.label}
                      description={display.desc}
                      className="w-full"
                      onClick={() => chooseMode(mode.id)}
                    />
                  );
                })}
              </OptionGroup>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-2">
              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-3 text-center">
                <Sparkles className={`mx-auto ${ICON_DISPLAY} text-primary`} />
                <div className="mt-1 text-ui-body font-semibold text-foreground">{t("配置完成")}</div>
                <p className="mt-0.5 text-ui-caption leading-relaxed text-muted-foreground">
                  {t("可以开始对话了；其余设置在 ⚙ 中随时可改。")}
                </p>
              </div>
              <div className="space-y-1 rounded-lg border border-border bg-surface/60 px-2.5 py-2 text-ui-caption">
                <SummaryRow label={t("连接")} value={connectionLabel} />
                <SummaryRow label={t("默认模式")} value={modeDisplay({ id: hostSettings.defaultMode, name: "" }).label} />
              </div>
              <div className="rounded-lg border border-dashed border-border px-2.5 py-2">
                <div className="text-ui-caption font-semibold text-foreground">{t("继续配置")}</div>
                <p className="mt-0.5 text-ui-caption leading-relaxed text-muted-foreground">
                  {t("这些能力可以稍后再设置。")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button onClick={() => finish("appearance")}>{t("外观与交互")}</Button>
                  <Button onClick={() => finish("mcp")}>{t("MCP 服务器")}</Button>
                  <Button onClick={() => finish("policy")}>{t("审批策略")}</Button>
                  <Button onClick={() => finish("memory")}>{t("记忆")}</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
}