import { useState, type ReactNode } from "react";
import { AlertTriangle, Link2, PlugZap, Plus, RefreshCw, Square, Trash2, Unlink, Zap } from "lucide-react";
import { isQrDataUrl, type HostToWebview, type QqSettingsUi } from "../../../shared/messages";
import { t } from "../i18n";
import {
  ActionRow,
  Button,
  Chip,
  CommitNumberInput,
  CommitTextInput,
  CountdownSeconds,
  Field,
  FieldLabel,
  Hint,
  ICON_INLINE,
  IconButton,
  Segmented,
  Select,
  SettingsDisclosure,
  SettingsGroup,
  Switch,
  TextInput,
} from "./ui";

/**
 * QQ 远程任务设置（Wave3-C）。
 *
 * 纯展示 + 回调：组件自己不发任何宿主消息、不写设置——`value` 是宿主的
 * 唯一真值，`onChange(patch)` 只把用户改动交回调用方，落盘与校验都由宿主
 * 负责。这样设置页可以接在任何数据源上（当前宿主还没有 QQ 配置的读写通道，
 * Wave3-B 接线时只需要把这份组件接到真实的 settings 快照）。
 */

/** 共享契约里的枚举（不重复声明字面量，改契约时这里自动跟随）。 */
export type QqAdapter = QqSettingsUi["adapter"];
export type QqRemotePolicy = QqSettingsUi["remotePolicy"];
export type QqResultDetail = QqSettingsUi["resultDetail"];
/** 一键托管（Wave5-D）的两条宿主回执与二维码动作枚举，直接取自共享契约。 */
export type QqLoginQr = Extract<HostToWebview, { type: "qqLoginQr" }>;
export type QqManagedStatus = Extract<HostToWebview, { type: "qqManagedStatus" }>;
export type QrAction = "startQrLogin" | "refreshQr" | "cancelQrLogin";

/**
 * 组件的受控值：共享设置快照 {@link QqSettingsUi} 加上**仅用于编辑**的凭据
 * 草稿。
 *
 * 快照本身绝不含明文凭据（只有 `hasBotToken` / `hasAppSecret` 布尔）；
 * `botToken` / `appSecret` 是宿主递进来的临时输入值，组件只在 password 字段
 * 里回显它们，落盘与遮罩都由宿主负责。
 */
export type QqSettingsValue = QqSettingsUi & {
  botToken?: string;
  appSecret?: string;
};

export interface QqSettingsProps {
  value: QqSettingsValue;
  onChange: (patch: Partial<QqSettingsValue>) => void;
  onTestConnection: () => void;
  onGenerateBindCode: () => void;
  onUnbind: () => void;
  /**
   * 凭据提交（密码框失焦）：只带用户真正编辑过的字段；空串表示清空该凭据。
   * 凭据与普通设置走两条通道，绝不混进 {@link onChange} 的设置补丁。
   */
  onSecretsCommit?: (secrets: { botToken?: string; appSecret?: string }) => void;
  /** 最近一次连接检查的结果（宿主回执）。 */
  status?: { connected?: boolean; detail?: string };
  /** 当前有效的配对码与其绝对过期时间（epoch ms）。 */
  bindCode?: { code: string; expiresAt: number };
  /** 配置或运行环境的问题；非空时以警告色调呈现。 */
  warnings?: string[];
  /** 一键托管：请求宿主开始 / 停止 go-cqhttp 托管。 */
  onManagedSetup?: (action: "start" | "stop") => void;
  /** 扫码登录动作：我已扫码 / 刷新二维码 / 取消登录。 */
  onQrAction?: (action: QrAction) => void;
  /** 当前二维码回执；null = 无二维码。 */
  qqLoginQr?: QqLoginQr | null;
  /** 当前托管阶段进度；null = 未开始托管。 */
  qqManagedStatus?: QqManagedStatus | null;
}

/** Label + description on the left, one control on the right — the same row
 * rhythm the other settings sections use (SettingsModal's SettingRow). */
function Row({
  label,
  description,
  wide = false,
  children,
}: {
  label: string;
  description?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 @min-[600px]:flex-row @min-[600px]:items-start @min-[600px]:gap-5">
      <div className="min-w-0 flex-1">
        <div className="text-ui-body font-medium leading-snug text-foreground">{label}</div>
        {description && <Hint className="mt-1">{description}</Hint>}
      </div>
      <div className={wide ? "w-full shrink-0 @min-[600px]:w-auto" : "shrink-0"}>{children}</div>
    </div>
  );
}

/**
 * Editable id list (allowed users / allowed groups). Each row carries its own
 * explicit accessible name (entity + 1-based index) — a bare placeholder is
 * not a name, and these rows have no visible per-row label.
 */
function IdList({
  label,
  placeholder,
  addLabel,
  entries,
  onChange,
}: {
  label: string;
  placeholder: string;
  addLabel: string;
  entries: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <FieldLabel>{label}</FieldLabel>
      {entries.length === 0 && <Hint>{t("尚未添加条目")}</Hint>}
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <TextInput
            mono
            className="min-w-0 flex-1"
            value={entry}
            placeholder={placeholder}
            aria-label={t("{0} {1}", label, index + 1)}
            onChange={(event) =>
              onChange(entries.map((current, at) => (at === index ? event.target.value : current)))
            }
          />
          <IconButton
            size="sm"
            tone="danger"
            icon={<Trash2 className={ICON_INLINE} />}
            label={t("删除 {0} {1}", label, index + 1)}
            onClick={() => onChange(entries.filter((_, at) => at !== index))}
          />
        </div>
      ))}
      <ActionRow>
        <Button size="sm" icon={<Plus className={ICON_INLINE} />} onClick={() => onChange([...entries, ""])}>
          {addLabel}
        </Button>
      </ActionRow>
    </div>
  );
}

const POLICY_OPTIONS: Array<{ value: QqRemotePolicy; label: string; description: string }> = [
  {
    value: "readonly",
    label: t("只读"),
    description: t("只读：可以查看工作区，写文件与执行命令会被拒绝。"),
  },
  {
    value: "supervised",
    label: t("受监督"),
    description: t("受监督：工具调用需在 QQ 审批，5 分钟未响应按拒绝处理。"),
  },
  {
    value: "trusted",
    label: t("受信任"),
    description: t("受信任：工具调用无需 QQ 审核直接执行，仅建议对自己完全掌控的账号与群使用。"),
  },
];

const DETAIL_OPTIONS: Array<{ value: QqResultDetail; label: string; description: string }> = [
  { value: "summary", label: t("一行结论"), description: t("一行结论：成功或失败，加上改动的文件数。") },
  { value: "standard", label: t("简短摘要"), description: t("简短摘要：涉及的文件与最终回复。") },
  { value: "full", label: t("完整回复"), description: t("完整最终回复，受 QQ 单条消息长度限制。") },
];

const ADAPTER_OPTIONS: Array<{ value: QqAdapter; label: string }> = [
  { value: "onebot", label: t("OneBot v11") },
  { value: "qqbot", label: t("QQ 官方机器人") },
];

const ADAPTER_DESCRIPTION: Record<QqAdapter, string> = {
  onebot: t("OneBot v11 桥，例如本机的 NapCat 或 LLOneBot 的 HTTP/WebSocket 端点。"),
  qqbot: t("QQ 官方机器人接口，通过配置的端点与机器人凭据访问。"),
};

/**
 * 一键接入（M4 官方 QQBot 路线）按当前 adapter 显示的文案。
 * qqbot 走官方扫码 SDK（窗口内二维码），不再下载 go-cqhttp；onebot 保留旧的自动托管但标注 legacy。
 */
const MANAGED_INTRO: Record<QqAdapter, string> = {
  qqbot: t("使用 QQ 官方机器人，扫码授权后即可从 QQ 远程控制本工作区（需先在 q.qq.com 创建机器人）。"),
  onebot: t("自动下载并配置 go-cqhttp，扫码登录即可从 QQ 远程控制本工作区。"),
};

/** 明确的通道定位：官方合规（推荐） vs 需自跑 OneBot（legacy）。 */
const ADAPTER_CHANNEL: Record<QqAdapter, string> = {
  qqbot: t("官方合规通道（推荐）"),
  onebot: t("需自跑 OneBot（legacy）"),
};

/** 一键接入按钮文案（qqbot 是官方机器人，onebot 是 legacy 的 OneBot）。 */
const MANAGED_START_LABEL: Record<QqAdapter, string> = {
  qqbot: t("一键接入 QQ 机器人"),
  onebot: t("一键接入 OneBot"),
};

/** 二维码区标题：qqbot 是「扫码授权」，onebot 保留「扫码登录」。 */
const QR_TITLE: Record<QqAdapter, string> = {
  qqbot: t("扫码授权 QQ 机器人"),
  onebot: t("扫码登录"),
};

/** 一键托管阶段机的中文标签（与共享契约的 phase 枚举一一对应）。 */
const MANAGED_PHASE_LABEL: Record<QqManagedStatus["phase"], string> = {
  idle: t("空闲"),
  checking: t("检查环境"),
  downloading: t("下载中"),
  configuring: t("生成配置"),
  starting: t("启动中"),
  waiting_login: t("等待扫码"),
  logged_in: t("已登录"),
  error: t("出错"),
};

/** qqbot 专属阶段文案（官方授权语义）；onebot（legacy）沿用上表。 */
const QQBOT_PHASE_LABEL: Partial<Record<QqManagedStatus["phase"], string>> = {
  waiting_login: t("请用手机 QQ 扫描二维码完成授权"),
  logged_in: t("已连接 QQ 官方机器人"),
};

export function QqSettings({
  value,
  onChange,
  onTestConnection,
  onGenerateBindCode,
  onUnbind,
  onSecretsCommit,
  status,
  bindCode,
  warnings = [],
  onManagedSetup,
  onQrAction,
  qqLoginQr,
  qqManagedStatus,
}: QqSettingsProps) {
  /** 凭据字段是否被用户改过；没改过的空字段失焦不得提交（会误清空）。 */
  const [secretDirty, setSecretDirty] = useState<{ botToken?: boolean; appSecret?: boolean }>({});
  function commitSecret(field: "botToken" | "appSecret", next: string): void {
    if (!secretDirty[field]) return;
    setSecretDirty((prev) => ({ ...prev, [field]: false }));
    onSecretsCommit?.({ [field]: next.trim() });
  }
  /** 当前适配器：qqbot 走官方扫码授权，onebot 为 legacy 自跑 OneBot。 */
  const adapter = value.adapter;
  const policy = POLICY_OPTIONS.find((option) => option.value === value.remotePolicy)!;
  const detail = DETAIL_OPTIONS.find((option) => option.value === value.resultDetail)!;
  const statusTone =
    status?.connected === true ? "success" : status?.connected === false ? "danger" : "muted";
  const statusLabel =
    status?.connected === true
      ? t("已连接")
      : status?.connected === false
        ? t("未连接")
        : t("连接状态未知");
  /** 一键托管（Wave5-D）派生状态：托管进行中才给「停止托管」，出错给错误色调。 */
  const managedPhase = qqManagedStatus?.phase ?? null;
  const managing =
    managedPhase === "checking" ||
    managedPhase === "downloading" ||
    managedPhase === "configuring" ||
    managedPhase === "starting" ||
    managedPhase === "waiting_login" ||
    managedPhase === "logged_in";
  const managedError = managedPhase === "error";
  /** qqbot 用官方授权语义的阶段文案，onebot（legacy）保留原标签。 */
  function phaseLabelFor(phase: QqManagedStatus["phase"]): string {
    return (adapter === "qqbot" && QQBOT_PHASE_LABEL[phase]) || MANAGED_PHASE_LABEL[phase];
  }
  const phaseLabel = managedPhase
    ? managedPhase === "downloading" && qqManagedStatus?.progress !== undefined
      ? `${phaseLabelFor(managedPhase)} ${qqManagedStatus.progress}%`
      : phaseLabelFor(managedPhase)
    : "";
  /** 只有 waiting_scan / scanned 且 dataUrl 通过 isQrDataUrl 护栏才渲染 <img>。 */
  const qrValid =
    qqLoginQr != null &&
    (qqLoginQr.phase === "waiting_scan" || qqLoginQr.phase === "scanned") &&
    isQrDataUrl(qqLoginQr.dataUrl);

  return (
    <div className="flex flex-col gap-3">
      {/* 一键接入（Wave5-D）：宿主自下载→配置→启动 go-cqhttp，面板只发请求与展示回执。 */}
      <div className="rounded-lg border border-border bg-surface/40 px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-ui-label font-semibold text-foreground">{t("一键接入")}</div>
            <Hint className="mt-0.5">{MANAGED_INTRO[adapter]}</Hint>
            <Hint className="mt-0.5">{ADAPTER_CHANNEL[adapter]}</Hint>
            {adapter === "qqbot" && (
              <Hint className="mt-0.5">{t("首次使用需在 q.qq.com 创建机器人（个人账号即可）。")}</Hint>
            )}
          </div>
          {managing ? (
            <Button
              size="sm"
              variant="danger"
              icon={<Square className={ICON_INLINE} />}
              onClick={() => onManagedSetup?.("stop")}
            >
              {t("停止托管")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<Zap className={ICON_INLINE} />}
              onClick={() => onManagedSetup?.("start")}
            >
              {MANAGED_START_LABEL[adapter]}
            </Button>
          )}
        </div>

        {qqManagedStatus && managedPhase !== "idle" && (
          <div
            className={`mt-3 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 ${
              managedError ? "border-destructive/50 bg-destructive/10" : "border-border bg-editor/40"
            }`}
          >
            <Chip tone={managedError ? "danger" : "primary"}>{phaseLabel}</Chip>
            <span
              className={`min-w-0 break-words text-ui-caption ${
                managedError ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {qqManagedStatus.message}
            </span>
          </div>
        )}

        {qqLoginQr && (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-md border border-border bg-editor/40 px-3 py-3">
            <div className="text-ui-label font-semibold text-foreground">{QR_TITLE[adapter]}</div>
            {qrValid ? (
              <>
                <img
                  src={qqLoginQr.dataUrl}
                  alt={t("QQ 登录二维码")}
                  className="object-contain"
                  style={{ width: 220, height: 220, imageRendering: "pixelated" }}
                />
                <div className="flex items-center gap-1 text-ui-caption text-muted-foreground">
                  <span>{t("剩余")}</span>
                  <CountdownSeconds deadline={qqLoginQr.expiresAt} />
                </div>
              </>
            ) : qqLoginQr.phase === "expired" ? (
              <div className="text-ui-caption text-warning" role="status">
                {t("二维码已过期，请刷新")}
              </div>
            ) : qqLoginQr.phase === "confirmed" ? (
              <div className="text-ui-caption text-success" role="status">
                {t("已确认，正在完成登录")}
              </div>
            ) : null}
            {qqLoginQr.detail && (
              <div className="max-w-full break-words text-ui-caption text-muted-foreground">
                {qqLoginQr.detail}
              </div>
            )}
            <ActionRow className="justify-center">
              <Button
                size="sm"
                icon={<RefreshCw className={ICON_INLINE} />}
                onClick={() => onQrAction?.("refreshQr")}
              >
                {t("刷新二维码")}
              </Button>
              <Button size="sm" variant="primary-soft" onClick={() => onQrAction?.("startQrLogin")}>
                {t("我已扫码")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onQrAction?.("cancelQrLogin")}>
                {t("取消")}
              </Button>
            </ActionRow>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div role="alert" className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2">
          <div className="flex items-center gap-1.5 text-ui-label font-semibold text-warning">
            <AlertTriangle className={`${ICON_INLINE} shrink-0`} />
            {t("需要注意")}
          </div>
          <ul className="mt-1 space-y-1">
            {warnings.map((warning, index) => (
              <li key={index} className="break-words text-ui-caption leading-relaxed text-warning">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-1">
        <Chip tone={statusTone} title={status?.detail}>
          {statusLabel}
        </Chip>
        {status?.detail && <span className="min-w-0 truncate text-ui-caption text-muted-foreground">{status.detail}</span>}
      </div>

      {bindCode && (
        <div className="rounded-lg border border-border bg-surface/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel>{t("配对码")}</FieldLabel>
            <span className="font-mono text-ui-body font-semibold tracking-[0.2em] text-foreground">{bindCode.code}</span>
            <span className="text-ui-caption text-muted-foreground">{t("剩余")}</span>
            <CountdownSeconds deadline={bindCode.expiresAt} />
          </div>
          <Hint className="mt-1">{t("在 QQ 里发送 /qq bind {0} 完成绑定；倒计时结束后配对码失效，需要重新生成。", bindCode.code)}</Hint>
        </div>
      )}

      <ActionRow className="px-1">
        <Button icon={<PlugZap className={ICON_INLINE} />} onClick={onTestConnection}>
          {t("测试连接")}
        </Button>
        <Button icon={<Link2 className={ICON_INLINE} />} onClick={onGenerateBindCode}>
          {t("生成配对码")}
        </Button>
        <Button variant="danger" icon={<Unlink className={ICON_INLINE} />} onClick={onUnbind}>
          {t("解除绑定")}
        </Button>
      </ActionRow>

      <SettingsGroup title={t("连接与适配器")}>
        <Row label={t("启用 QQ 远程任务")} description={t("从 QQ 私聊或群聊接收任务，在独立分支上执行。")}>
          <Switch
            checked={value.enabled}
            label={t("启用 QQ 远程任务")}
            onChange={(enabled) => onChange({ enabled })}
          />
        </Row>
        <Row label={t("协议适配器")} description={ADAPTER_DESCRIPTION[value.adapter]} wide>
          <Segmented<QqAdapter>
            ariaLabel={t("协议适配器")}
            options={ADAPTER_OPTIONS}
            value={value.adapter}
            onChange={(adapter) => onChange({ adapter })}
          />
        </Row>
        <Row label={t("适配器端点")} wide>
          <CommitTextInput
            mono
            value={value.endpoint}
            label={t("适配器端点")}
            placeholder={
              value.adapter === "onebot" ? "http://127.0.0.1:3000" : "https://api.sgroup.qq.com"
            }
            onCommit={(endpoint) => onChange({ endpoint })}
          />
        </Row>
        {value.adapter === "qqbot" && (
          <>
            <Row
              label={t("机器人 Token")}
              description={
                value.hasBotToken
                  ? t("已保存；输入新值并在失焦后提交，清空并失焦可删除。")
                  : t("输入后失焦即提交给宿主，面板不保存明文。")
              }
              wide
            >
              <Field label={t("机器人 Token")}>
                <TextInput
                  type="password"
                  revealable
                  mono
                  aria-label={t("机器人 Token")}
                  value={value.botToken ?? ""}
                  onChange={(event) => {
                    setSecretDirty((prev) => ({ ...prev, botToken: true }));
                    onChange({ botToken: event.target.value });
                  }}
                  onBlur={(event) => commitSecret("botToken", event.currentTarget.value)}
                />
              </Field>
            </Row>
            <Row
              label={t("App Secret")}
              description={
                value.hasAppSecret
                  ? t("已保存；输入新值并在失焦后提交，清空并失焦可删除。")
                  : t("输入后失焦即提交给宿主，面板不保存明文。")
              }
              wide
            >
              <Field label={t("App Secret")}>
                <TextInput
                  type="password"
                  revealable
                  mono
                  aria-label={t("App Secret")}
                  value={value.appSecret ?? ""}
                  onChange={(event) => {
                    setSecretDirty((prev) => ({ ...prev, appSecret: true }));
                    onChange({ appSecret: event.target.value });
                  }}
                  onBlur={(event) => commitSecret("appSecret", event.currentTarget.value)}
                />
              </Field>
            </Row>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("访问控制")} hint={t("留空表示不接受该来源的任务")}>
        <IdList
          label={t("允许的用户")}
          placeholder={t("QQ 号")}
          addLabel={t("添加用户")}
          entries={value.allowedUsers}
          onChange={(allowedUsers) => onChange({ allowedUsers })}
        />
        <IdList
          label={t("允许的群")}
          placeholder={t("群号")}
          addLabel={t("添加群")}
          entries={value.allowedGroups}
          onChange={(allowedGroups) => onChange({ allowedGroups })}
        />
      </SettingsGroup>

      <SettingsGroup title={t("执行策略")}>
        <Row label={t("远程任务策略")} description={policy.description} wide>
          <Select
            ariaLabel={t("远程任务策略")}
            value={value.remotePolicy}
            options={POLICY_OPTIONS}
            onChange={(next) => onChange({ remotePolicy: next as QqRemotePolicy })}
          />
        </Row>
        <Row label={t("结果详细度")} description={detail.description} wide>
          <Select
            ariaLabel={t("结果详细度")}
            value={value.resultDetail}
            options={DETAIL_OPTIONS}
            onChange={(next) => onChange({ resultDetail: next as QqResultDetail })}
          />
        </Row>
        <Row label={t("同时运行的任务数")} description={t("范围 1–10，超出后排队等待。")}>
          <CommitNumberInput
            label={t("同时运行的任务数")}
            value={value.maxConcurrentTasks}
            min={1}
            max={10}
            onCommit={(maxConcurrentTasks) => onChange({ maxConcurrentTasks })}
          />
        </Row>
        <Row label={t("每分钟任务上限")} description={t("范围 1–60，超过上限的任务会被拒绝。")}>
          <CommitNumberInput
            label={t("每分钟任务上限")}
            value={value.rateLimitPerMin}
            min={1}
            max={60}
            onCommit={(rateLimitPerMin) => onChange({ rateLimitPerMin })}
          />
        </Row>
        <Row label={t("完成后自动合并")} description={t("任务成功后把分支自动合并回当前分支。")}>
          <Switch checked={value.autoMerge} label={t("完成后自动合并")} onChange={(autoMerge) => onChange({ autoMerge })} />
        </Row>
      </SettingsGroup>

      <SettingsDisclosure title={t("高级")}>
        <Row label={t("桥接端口")} description={t("0 表示使用适配器默认端口；范围 0–65535。")}>
          <CommitNumberInput
            label={t("桥接端口")}
            value={value.bridgePort}
            min={0}
            max={65535}
            onCommit={(bridgePort) => onChange({ bridgePort })}
          />
        </Row>
        <Row label={t("工作区目录")} description={t("远程任务运行的工作区；留空表示当前工作区根目录。")} wide>
          <Field label={t("工作区目录")}>
            <CommitTextInput
              mono
              value={value.workspace}
              label={t("工作区目录")}
              placeholder={t("留空使用当前工作区")}
              onCommit={(workspace) => onChange({ workspace })}
            />
          </Field>
        </Row>
      </SettingsDisclosure>
    </div>
  );
}
