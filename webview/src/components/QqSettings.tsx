import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  PlugZap,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Unlink,
  X,
  Zap,
} from "lucide-react";
import {
  isQrDataUrl,
  type HostToWebview,
  type QqPendingUserUi,
  type QqSettingsPatch,
  type QqSettingsUi,
} from "../../../shared/messages";
import {
  isValidQqId,
  maskQqOpenId,
  QQ_APPROVAL_TIMEOUT_MINUTES,
  type QqAllowEntry,
} from "../../../shared/qq-access";
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
 *
 * 阶段5：通道恒走 QQ 官方机器人（QQBot），已移除旧的适配器分流与
 * endpoint / bridgePort 遗留字段。
 */

export type QqRoute = QqSettingsUi["route"];
export type QqRemotePolicy = QqSettingsUi["remotePolicy"];
export type QqResultDetail = QqSettingsUi["resultDetail"];
/** 一键托管（Wave5-D）的两条宿主回执与二维码动作枚举，直接取自共享契约。 */
export type QqLoginQr = Extract<HostToWebview, { type: "qqLoginQr" }>;
export type QqManagedStatus = Extract<HostToWebview, { type: "qqManagedStatus" }>;
export type QrAction = "startQrLogin" | "refreshQr" | "cancelQrLogin";

/**
 * 组件的受控值：共享设置快照 {@link QqSettingsUi}。
 *
 * 快照本身绝不含明文凭据（只有 `hasAppSecret` 布尔）；凭据由扫码成功后
 * 宿主直接写入 SecretStorage，面板既不需要也不允许手填。
 */
export type QqSettingsValue = QqSettingsUi;

export interface QqSettingsProps {
  value: QqSettingsValue;
  onChange: (patch: QqSettingsPatch) => void;
  onTestConnection: () => void;
  onUnbind: () => void;
  /** 最近一次连接检查的结果（宿主回执）。 */
  status?: { connected?: boolean; detail?: string };
  /**
   * 白名单外的人发来消息时留下的待审核记录（宿主每次全量重发）。
   * 空数组 = 不渲染「待审核用户」区。
   */
  pendingUsers?: QqPendingUserUi[];
  /** 对一条待审核记录的处置：放行写进白名单，拒绝记入拒绝集合。 */
  onUserAction?: (openid: string, action: "approve" | "reject") => void;
  /** 配置或运行环境的问题；非空时以警告色调呈现。 */
  warnings?: string[];
  /** 一键接入：请求宿主开始 / 停止 QQBot 接入流程。 */
  onManagedSetup?: (action: "start" | "stop") => void;
  /** 扫码授权动作：我已扫码 / 刷新二维码 / 取消登录 / 重新扫码授权。 */
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
 * Read-only allow-entry list (allowed users / allowed groups).
 *
 * openid 只以脱敏形式展示（{@link maskQqOpenId}，前 4 + 8 个 `*` + 后 4），
 * 页面里没有任何能改 openid 的输入框 —— 要换只能删除后重新添加（添加时必须
 * 输入完整 openid，脱敏后无法反推）。每行带一个备注字段（草稿 + blur/Enter
 * 提交）；行内控件的可访问名带实体名与序号，可见文案不足以区分多行。
 */
function AccessList({
  label,
  noun,
  addLabel,
  entries,
  onChange,
}: {
  label: string;
  /** 实体名（用户 / 群），用于「输入…的 openid」这类可访问名。 */
  noun: string;
  addLabel: string;
  entries: QqAllowEntry[];
  onChange: (next: QqAllowEntry[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /** 添加失败的就地说明：空值 / 格式非法 / 重复都留在这里，绝不静默丢弃。 */
  const [error, setError] = useState("");

  const cancelAdd = () => {
    setAdding(false);
    setDraft("");
    setError("");
  };
  const commitAdd = () => {
    const openid = draft.trim();
    if (openid.length === 0) {
      setError(t("请填写完整的{0}标识。", noun));
      return;
    }
    // 只接受完整原值：脱敏串（含 *）、空白与其它字符一律拒绝，否则保存成功
    // 却永远匹配不上（用户从界面复制 D754********8D11 是最常见的误操作）。
    if (!isValidQqId(openid)) {
      setError(
        t("无效的{0}标识：只能包含字母、数字、下划线或连字符（4–64 位），脱敏后的星号串不能用。", noun),
      );
      return;
    }
    // 同一条 openid 已在名单里就不重复追加（读取侧同样按 openid 去重），
    // 但要明确告诉用户「没添加」——否则看起来像成功。
    if (entries.some((entry) => entry.openid === openid)) {
      setError(t("该标识已在名单中，无需重复添加。"));
      return;
    }
    cancelAdd();
    onChange([...entries, { openid }]);
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <FieldLabel>{label}</FieldLabel>
      {entries.length === 0 && <Hint>{t("尚未添加条目")}</Hint>}
      {entries.length > 0 && (
        <Hint>{t("openid 已脱敏显示，无法在此修改；如需更换请删除后重新添加。")}</Hint>
      )}
      {entries.map((entry, index) => (
        <div key={entry.openid} className="flex flex-wrap items-center gap-1.5">
          {/* 备注在前：8 位左右的群号脱敏后是纯星号（`********`），多个群
              在脱敏 id 上完全无法区分，备注才是唯一可辨识信息；脱敏 id
              退居其后作参照。用户列表同构，保持两栏一致。 */}
          <CommitTextInput
            className="min-w-0 flex-1"
            value={entry.note ?? ""}
            label={t("{0} {1} 的备注", label, index + 1)}
            placeholder={t("备注")}
            onCommit={(note) =>
              onChange(
                entries.map((current, at) => {
                  if (at !== index) return current;
                  const trimmed = note.trim();
                  return trimmed.length > 0
                    ? { openid: current.openid, note: trimmed }
                    : { openid: current.openid };
                }),
              )
            }
          />
          {/* 只读文本，不是输入框：完整 openid 不在这里暴露，也不能被改写。 */}
          <span className="shrink-0 whitespace-nowrap font-mono text-ui-body text-muted-foreground">
            {maskQqOpenId(entry.openid)}
          </span>
          <IconButton
            size="sm"
            tone="danger"
            icon={<Trash2 className={ICON_INLINE} />}
            label={t("删除 {0} {1}", label, index + 1)}
            onClick={() => onChange(entries.filter((_, at) => at !== index))}
          />
        </div>
      ))}
      {adding ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <TextInput
              autoFocus
              mono
              className="min-w-0 flex-1"
              value={draft}
              placeholder={t("完整 openid")}
              aria-label={t("输入{0}的 openid", noun)}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelAdd();
                  return;
                }
                if (event.key !== "Enter") return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                commitAdd();
              }}
            />
            <IconButton
              size="sm"
              tone="primary"
              icon={<Check className={ICON_INLINE} />}
              label={t("确认添加")}
              onClick={commitAdd}
            />
            <IconButton
              size="sm"
              icon={<X className={ICON_INLINE} />}
              label={t("取消添加")}
              onClick={cancelAdd}
            />
          </div>
          {error && (
            <p role="alert" className="text-ui-caption leading-relaxed text-destructive">
              {error}
            </p>
          )}
        </>
      ) : (
        <ActionRow>
          <Button
            size="sm"
            icon={<Plus className={ICON_INLINE} />}
            onClick={() => {
              setError("");
              setAdding(true);
            }}
          >
            {addLabel}
          </Button>
        </ActionRow>
      )}
    </div>
  );
}

const ROUTE_OPTIONS: Array<{ value: QqRoute; label: string; description: string }> = [
  {
    value: "main",
    label: t("主会话"),
    description: t("消息排队注入当前主会话（与本地输入同一条对话线，可远程接续工作；忙时排队等待）。"),
  },
  {
    value: "child",
    label: t("独立子会话"),
    description: t("每条消息直接派一个独立子会话（旧行为，便于回滚与排查）。"),
  },
];

const POLICY_OPTIONS: Array<{ value: QqRemotePolicy; label: string; description: string }> = [
  {
    value: "readonly",
    label: t("只读"),
    description: t("只读：可以查看工作区，写文件与执行命令会被拒绝。"),
  },
  {
    value: "supervised",
    label: t("受监督"),
    description: t(
      // 分钟数取自 shared/qq-access.ts（与宿主 QQ_APPROVAL_TIMEOUT_MS 同为 4），
      // 不在 UI 里写死，避免文案与真实超时再次漂移。
      "受监督：工具调用需在 QQ 审批，{0} 分钟未响应按拒绝处理。",
      QQ_APPROVAL_TIMEOUT_MINUTES,
    ),
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

/** 一键接入（官方 QQBot 路线）的说明文案。 */
const MANAGED_INTRO = t(
  "使用 QQ 官方机器人，扫码授权后即可从 QQ 远程控制本工作区（需先在 q.qq.com 创建机器人）。",
);

/** 通道定位：官方合规。 */
const CHANNEL_LABEL = t("官方合规通道（推荐）");

/** 一键接入按钮文案。 */
const MANAGED_START_LABEL = t("一键接入 QQ 机器人");

/** 二维码区标题。 */
const QR_TITLE = t("扫码授权 QQ 机器人");

/**
 * 一键托管阶段机的中文标签（与共享契约的 phase 枚举一一对应，QQBot 官方
 * 授权语义）。`downloading` 沿用通用的「准备中」，不再暗含旧桥接工具的语义。
 */
const MANAGED_PHASE_LABEL: Record<QqManagedStatus["phase"], string> = {
  idle: t("空闲"),
  checking: t("检查环境"),
  downloading: t("准备中"),
  configuring: t("生成配置"),
  starting: t("启动中"),
  waiting_login: t("请用手机 QQ 扫描二维码完成授权"),
  logged_in: t("已连接 QQ 官方机器人"),
  error: t("出错"),
};

/** 列表里的时间按本地时区渲染成 `YYYY-MM-DD HH:mm`（不需要秒）。 */
function formatAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "—";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 消息预览截断（宿主已按 80 码点收敛，这里再兜一次底、避免撑破单行）。 */
function truncatePreview(preview: string): string {
  return preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
}

export function QqSettings({
  value,
  onChange,
  onTestConnection,
  onUnbind,
  status,
  pendingUsers = [],
  onUserAction,
  warnings = [],
  onManagedSetup,
  onQrAction,
  qqLoginQr,
  qqManagedStatus,
}: QqSettingsProps) {
  const route = ROUTE_OPTIONS.find((option) => option.value === value.route) ?? ROUTE_OPTIONS[0]!;
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
  const phaseLabel = managedPhase
    ? managedPhase === "downloading" && qqManagedStatus?.progress !== undefined
      ? `${MANAGED_PHASE_LABEL[managedPhase]} ${qqManagedStatus.progress}%`
      : MANAGED_PHASE_LABEL[managedPhase]
    : "";
  /**
   * 已连接 / 已登录 → 二维码区一律不渲染。
   *
   * 宿主成功后会主动推 confirmed 清屏帧，但 webview 可能先收到连接状态、
   * 后收到（或漏收）清屏帧；若只看 `qqLoginQr`，上一帧 waiting_scan 的旧码
   * 会连同倒计时挂在已连接界面上（用户实测 BUG：底部「已连接」+ 中间大二维码
   * 与「剩余 40s」并存）。
   */
  const qrConnected = status?.connected === true || managedPhase === "logged_in";
  /** 只有未连接、waiting_scan / scanned 且 dataUrl 通过 isQrDataUrl 护栏才渲染 <img>。 */
  const qrValid =
    !qrConnected &&
    qqLoginQr != null &&
    (qqLoginQr.phase === "waiting_scan" || qqLoginQr.phase === "scanned") &&
    isQrDataUrl(qqLoginQr.dataUrl);
  /**
   * 已授权：扫码写入过 App Secret，或当前已连接 / 托管已登录。
   * 此时提供「重新扫码授权」入口 —— 手填 Token / App Secret 已移除，
   * 更换凭据的唯一通道就是重新扫码。
   */
  const authorized =
    value.hasAppSecret === true || status?.connected === true || managedPhase === "logged_in";

  return (
    <div className="flex flex-col gap-3">
      {/* 一键接入：宿主完成 QQBot 接入（准备→配置→启动→扫码授权），面板只发请求与展示回执。 */}
      <div className="rounded-lg border border-border bg-surface/40 px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-ui-label font-semibold text-foreground">{t("一键接入")}</div>
            <Hint className="mt-0.5">{MANAGED_INTRO}</Hint>
            <Hint className="mt-0.5">{CHANNEL_LABEL}</Hint>
            <Hint className="mt-0.5">{t("首次使用需在 q.qq.com 创建机器人（个人账号即可）。")}</Hint>
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
              {MANAGED_START_LABEL}
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

        {qqLoginQr && !qrConnected && (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-md border border-border bg-editor/40 px-3 py-3">
            <div className="text-ui-label font-semibold text-foreground">{QR_TITLE}</div>
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
      {authorized && (
        <Hint className="px-1">{t("已通过扫码授权；如需更换请重新扫码。")}</Hint>
      )}

      {authorized && (
        <ActionRow className="px-1">
          <Button
            icon={<RefreshCw className={ICON_INLINE} />}
            onClick={() => onQrAction?.("startQrLogin")}
          >
            {t("重新扫码授权")}
          </Button>
          <Button icon={<PlugZap className={ICON_INLINE} />} onClick={onTestConnection}>
            {t("测试连接")}
          </Button>
          <Button variant="danger" icon={<Unlink className={ICON_INLINE} />} onClick={onUnbind}>
            {t("解除绑定")}
          </Button>
        </ActionRow>
      )}

      {pendingUsers.length > 0 && (
        <SettingsGroup
          title={t("待审核用户")}
          hint={t("白名单外的人发来消息时只会出现在这里，不会被执行；放行后即可派发任务，拒绝后不会再出现。")}
        >
          {pendingUsers.map((user) => (
            <div key={user.openid} className="flex flex-col gap-2 px-4 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ui-body font-medium text-foreground">
                  {maskQqOpenId(user.openid)}
                </span>
                <span className="text-ui-caption text-muted-foreground">{t("来源")}</span>
                <Chip tone="muted">
                  {user.chatType === "private"
                    ? t("私聊")
                    : // 群号与 openid 共用同一套脱敏（固定 8 个星号、≤8 位整体覆盖）。
                      // 取舍：QQ 群号常在 8 位上下，因此多数群会显示成纯星号 ——
                      // 牺牲可辨识性，换「不泄露原长/原值」这条硬底线。
                      t("群 {0}", user.groupId ? maskQqOpenId(user.groupId) : "—")}
                </Chip>
                <span className="text-ui-caption text-muted-foreground">
                  {t("出现次数")} {user.count}
                </span>
              </div>
              <div
                className="truncate text-ui-caption text-muted-foreground"
                title={user.preview}
              >
                {truncatePreview(user.preview)}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3 text-ui-caption text-muted-foreground">
                  <span>
                    {t("首次")} {formatAt(user.firstSeenAt)}
                  </span>
                  <span>
                    {t("最近")} {formatAt(user.lastSeenAt)}
                  </span>
                </div>
                <ActionRow>
                  <Button
                    size="sm"
                    variant="outline-primary"
                    onClick={() => onUserAction?.(user.openid, "approve")}
                  >
                    {t("批准")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => onUserAction?.(user.openid, "reject")}
                  >
                    {t("拒绝")}
                  </Button>
                </ActionRow>
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}

      <SettingsGroup title={t("连接")}>
        <Row label={t("启用 QQ 远程任务")} description={t("从 QQ 私聊或群聊接收任务，在独立分支上执行。")}>
          <Switch
            checked={value.enabled}
            label={t("启用 QQ 远程任务")}
            onChange={(enabled) => onChange({ enabled })}
          />
        </Row>
      </SettingsGroup>

      <SettingsGroup title={t("访问控制")} hint={t("留空表示不接受该来源的任务")}>
        <AccessList
          label={t("允许的用户")}
          noun={t("用户")}
          addLabel={t("添加用户")}
          entries={value.allowedUsers}
          onChange={(allowedUsers) => onChange({ allowedUsers })}
        />
        <AccessList
          label={t("允许的群")}
          noun={t("群")}
          addLabel={t("添加群")}
          entries={value.allowedGroups}
          onChange={(allowedGroups) => onChange({ allowedGroups })}
        />
      </SettingsGroup>

      <SettingsGroup title={t("执行策略")}>
        <Row label={t("消息去向")} description={route.description} wide>
          <Select
            ariaLabel={t("消息去向")}
            value={value.route}
            options={ROUTE_OPTIONS}
            onChange={(next) => onChange({ route: next as QqRoute })}
          />
        </Row>
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