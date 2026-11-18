import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Pencil,
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
  ConfirmDialog,
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
 * Allow-entry table (allowed users / allowed groups) — **two columns only**.
 *
 * 列 =「条目」+「操作」：
 *  - 条目列上行是备注（主信息，最多两行），下行是脱敏 id（次要色、小一号）；
 *  - 操作列固定宽度，只放编辑 / 删除两个图标按钮，右对齐且不换行。
 *
 * 为什么不再拆「备注 / openid / 操作」三列：500px 视口下三列各只分到 ~70px，
 * 脱敏串 `D754********8D11` 需要 ~110px，被 `truncate` 切成 `D754**...`，
 * 后 4 位（唯一可辨识的尾巴）完全看不到。两列 + 上下两行后，条目列拿到
 * 操作列之外的全部宽度，脱敏串用 `break-all` 换行而**绝不截尾**。
 *
 * 默认行内**没有任何输入框**——备注与脱敏 id 都是纯文本，谁只读、谁可编辑
 * 一眼可分。openid 永远不可编辑（完整值不进 UI，{@link maskQqOpenId} 只给
 * 前 4 + 8 个 `*` + 后 4；要换只能删除后重新添加）。
 *
 * 编辑与添加共用同一种「行内编辑态」：点铅笔 / 「+ 添加」后该行变成输入态，
 * 输入框占满条目列，右侧换成保存 / 取消；Enter（IME 组合中不提交）保存、
 * Esc 取消。选行内而非弹窗，是因为编辑对象只有一条备注、上下文（同表格里
 * 的其它条目与脱敏 id）恰恰是判断依据，弹窗会把这份上下文挡掉；添加也
 * 天然落在表格末尾，两种操作共用一套心智模型。
 *
 * 删除走 {@link ConfirmDialog}：条目一旦删除就找不回完整 openid（脱敏显示
 * 无法反推），误点的代价是重新找对方要 id，值得一次确认。
 */
function AccessList({
  label,
  idLabel,
  idPlaceholder,
  noun,
  addLabel,
  entries,
  onChange,
}: {
  label: string;
  /** 脱敏标识的叫法（openid / 群号），用于说明文案。 */
  idLabel: string;
  /** 添加行标识输入框的占位（完整 openid / 完整群号）。 */
  idPlaceholder: string;
  /** 实体名（用户 / 群），用于「输入…标识」这类可访问名。 */
  noun: string;
  addLabel: string;
  entries: QqAllowEntry[];
  onChange: (next: QqAllowEntry[]) => void;
}) {
  /** 正在行内编辑的行下标；null = 全展示态。 */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [idDraft, setIdDraft] = useState("");
  /** 添加/编辑失败的就地说明：空值 / 格式非法 / 重复都留在这里，绝不静默丢弃。 */
  const [error, setError] = useState("");
  /** 待确认删除的行下标；非 null 时渲染 ConfirmDialog。 */
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  /** 可辨识的实体名：有备注用备注（多条群号脱敏后都是星号，备注才是唯一
   * 可区分信息），否则退回脱敏 id。 */
  const entityName = (entry: QqAllowEntry): string => {
    const note = entry.note?.trim();
    return note && note.length > 0 ? note : maskQqOpenId(entry.openid);
  };

  const cancelEditing = () => {
    setAdding(false);
    setEditingIndex(null);
    setNoteDraft("");
    setIdDraft("");
    setError("");
  };
  /**
   * 当前编辑行的草稿是否真的变了（与已存备注同样 trim 后比较）。
   *
   * 切行/删除/进入添加前都要先过这一关：草稿有变才落盘，未修改就切走
   * 不产生任何写入（否则「点开看看再点走」也会白写一次设置）。
   */
  const draftChanged = (): boolean => {
    if (editingIndex === null) return false;
    const entry = entries[editingIndex];
    if (!entry) return false;
    return noteDraft.trim() !== (entry.note ?? "").trim();
  };
  /**
   * 把当前编辑行的草稿并入条目数组；无变化时原样返回同一引用。
   *
   * 删除等后续改动直接在返回值上做，草稿与本次操作同一次落盘——若先
   * `onChange(草稿)` 再 `onChange(过滤后的旧数组)`，后一次会用旧数组把
   * 草稿又盖回去（宿主按全量数组写入）。
   */
  const entriesWithDraft = (): QqAllowEntry[] => {
    if (!draftChanged()) return entries;
    const trimmed = noteDraft.trim();
    return entries.map((current, at) => {
      if (at !== editingIndex) return current;
      // 清空备注 = 写回不带 note 的条目（存储层仍是旧形状）。
      return trimmed.length > 0 ? { openid: current.openid, note: trimmed } : { openid: current.openid };
    });
  };
  /** 草稿有变才写回；没有变化绝不触发 onChange。 */
  const flushDraft = () => {
    const next = entriesWithDraft();
    if (next !== entries) onChange(next);
  };
  const beginAdd = () => {
    // 先落盘正在编辑的备注，再切到添加行——否则草稿会随切换被静默丢弃。
    flushDraft();
    setError("");
    setEditingIndex(null);
    setNoteDraft("");
    setIdDraft("");
    setAdding(true);
  };
  const beginEdit = (index: number, entry: QqAllowEntry) => {
    // 已经在编辑这一行：保留草稿，不做任何重置（避免自己把输入清掉）。
    if (editingIndex === index) return;
    // 正在添加且已经填了内容：先尝试提交添加；校验失败就留在原地报错，
    // 绝不静默丢掉用户刚输入的标识 / 备注。
    if (adding && (idDraft.trim().length > 0 || noteDraft.trim().length > 0)) {
      if (!commitAdd()) return;
    }
    // 正在编辑另一行：草稿有变就先落盘，然后进入新行（推荐行为）。
    flushDraft();
    setError("");
    setAdding(false);
    setIdDraft("");
    setNoteDraft(entry.note ?? "");
    setEditingIndex(index);
  };
  const commitEdit = () => {
    if (editingIndex === null) return;
    onChange(entriesWithDraft());
    cancelEditing();
  };
  /** 提交添加行；返回是否成功（失败时保留输入并就地报错）。 */
  const commitAdd = (): boolean => {
    const openid = idDraft.trim();
    if (openid.length === 0) {
      setError(t("请填写完整的{0}标识。", noun));
      return false;
    }
    // 只接受完整原值：脱敏串（含 *）、空白与其它字符一律拒绝，否则保存成功
    // 却永远匹配不上（用户从界面复制 D754********8D11 是最常见的误操作）。
    if (!isValidQqId(openid)) {
      setError(
        t("无效的{0}标识：只能包含字母、数字、下划线或连字符（4–64 位），脱敏后的星号串不能用。", noun),
      );
      return false;
    }
    // 同一条 openid 已在名单里就不重复追加（读取侧同样按 openid 去重），
    // 但要明确告诉用户「没添加」——否则看起来像成功。
    if (entries.some((entry) => entry.openid === openid)) {
      setError(t("该标识已在名单中，无需重复添加。"));
      return false;
    }
    const note = noteDraft.trim();
    onChange([...entries, note.length > 0 ? { openid, note } : { openid }]);
    cancelEditing();
    return true;
  };
  /** Enter 提交 / Esc 取消；IME 组合中的 Enter 是确认候选词，不能当提交。 */
  const editorKeyDown =
    (commit: () => void) =>
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
        return;
      }
      if (event.key !== "Enter") return;
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      commit();
    };

  const pendingEntry = pendingDelete === null ? null : entries[pendingDelete];

  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <FieldLabel>{label}</FieldLabel>
      {/* 空态走项目既有的虚线空态盒（与 QqTaskList / McpCard / AssetCard 同一
          视觉语言），不用裸 Hint 段落——后者读起来像未完成的占位说明。 */}
      {entries.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed border-border px-2 py-2 text-center text-ui-label text-muted-foreground">
          {t("尚未添加条目")}
        </div>
      )}
      {entries.length > 0 && (
        <Hint>{t("{0} 已脱敏显示，无法在此修改；如需更换请删除后重新添加。", idLabel)}</Hint>
      )}
      {(entries.length > 0 || adding) && (
        // 两列：条目（备注 + 脱敏 id 上下两行）/ 操作（固定宽度图标）。
        // `table-fixed` 让列宽只由表头决定：内容再长也只压条目列，绝不把
        // 操作列推出视口（360 / 500px 均无横向溢出）。
        <table aria-label={label} className="w-full table-fixed border-collapse text-ui-label">
          <thead>
            <tr className="border-b border-border/60">
              <th
                scope="col"
                className="py-1.5 pr-2 text-left text-ui-caption font-medium text-muted-foreground"
              >
                {t("条目")}
              </th>
              {/* 操作列固定 64px（两个 24px 图标 + 2px 间距 + 8px 左侧留白），
                  不参与伸缩。 */}
              <th
                scope="col"
                className="w-16 py-1.5 pl-2 text-right text-ui-caption font-medium text-muted-foreground"
              >
                {t("操作")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const editingThis = editingIndex === index;
              const name = entityName(entry);
              const masked = maskQqOpenId(entry.openid);
              const displayNote = entry.note?.trim() ?? "";
              return (
                <tr key={entry.openid} className="border-b border-border/40 last:border-b-0">
                  {/* 条目列：上行备注（空备注用低调占位，最多两行），
                      下行脱敏 id。脱敏串**绝不 truncate**（截掉后 4 位就等于
                      不可辨识）：宽度不够时靠 `break-all` 换行，始终完整可见。 */}
                  <td className="min-w-0 py-1.5 pr-2 align-top">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {editingThis ? (
                        <TextInput
                          autoFocus
                          className="w-full min-w-0"
                          value={noteDraft}
                          placeholder={t("备注")}
                          aria-label={t("备注 {0}", name)}
                          onChange={(event) => setNoteDraft(event.target.value)}
                          onKeyDown={editorKeyDown(commitEdit)}
                        />
                      ) : (
                        <span
                          className={`line-clamp-2 min-w-0 break-words${displayNote ? " text-foreground" : " text-muted-foreground/70"}`}
                          title={displayNote || t("未命名")}
                        >
                          {displayNote || t("未命名")}
                        </span>
                      )}
                      {/* 脱敏值只读，任何状态下都不出现完整 id。 */}
                      <span
                        className="block min-w-0 whitespace-normal break-all font-mono text-ui-caption text-muted-foreground"
                        title={masked}
                      >
                        {masked}
                      </span>
                    </div>
                  </td>
                  {/* 操作列：固定宽度，两个图标横向不换行、右对齐。 */}
                  <td className="w-16 py-1.5 pl-2 align-middle">
                    <div className="flex items-center justify-end gap-0.5">
                      {editingThis ? (
                        <>
                          <IconButton
                            size="sm"
                            tone="primary"
                            icon={<Check className={ICON_INLINE} />}
                            label={t("保存")}
                            onClick={commitEdit}
                          />
                          <IconButton
                            size="sm"
                            icon={<X className={ICON_INLINE} />}
                            label={t("取消")}
                            onClick={cancelEditing}
                          />
                        </>
                      ) : (
                        <>
                          <IconButton
                            size="sm"
                            icon={<Pencil className={ICON_INLINE} />}
                            label={t("编辑 {0}", name)}
                            onClick={() => beginEdit(index, entry)}
                          />
                          <IconButton
                            size="sm"
                            tone="danger"
                            icon={<Trash2 className={ICON_INLINE} />}
                            label={t("删除 {0}", name)}
                            onClick={() => setPendingDelete(index)}
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {adding && (
              <tr className="border-b border-border/40 last:border-b-0">
                {/* 添加行与行内编辑同构：标识输入占满条目列，可选备注在其下。 */}
                <td className="min-w-0 py-1.5 pr-2 align-top">
                  <div className="flex min-w-0 flex-col gap-1">
                    <TextInput
                      autoFocus
                      mono
                      className="w-full min-w-0"
                      value={idDraft}
                      placeholder={idPlaceholder}
                      aria-label={t("输入{0}标识", noun)}
                      onChange={(event) => {
                        setIdDraft(event.target.value);
                        if (error) setError("");
                      }}
                      onKeyDown={editorKeyDown(commitAdd)}
                    />
                    <TextInput
                      className="w-full min-w-0"
                      value={noteDraft}
                      placeholder={t("备注（可选）")}
                      aria-label={t("新{0}的备注", noun)}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      onKeyDown={editorKeyDown(commitAdd)}
                    />
                  </div>
                </td>
                <td className="w-16 py-1.5 pl-2 align-middle">
                  <div className="flex items-center justify-end gap-0.5">
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
                      onClick={cancelEditing}
                    />
                  </div>
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={2} className="pt-1.5">
                  <p role="alert" className="text-ui-caption leading-relaxed text-destructive">
                    {error}
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {!adding && (
        <ActionRow>
          <Button size="sm" icon={<Plus className={ICON_INLINE} />} onClick={beginAdd}>
            {addLabel}
          </Button>
        </ActionRow>
      )}
      {pendingEntry && (
        <ConfirmDialog
          title={t("删除条目")}
          message={t(
            "删除「{0}」后将无法恢复：完整标识已脱敏，无法从界面还原，需要时只能重新添加。",
            entityName(pendingEntry),
          )}
          confirmLabel={t("删除")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (pendingDelete === null) return;
            const target = pendingDelete;
            if (editingIndex === target) {
              // 删的就是正在编辑的这一行：显式删除，草稿随行作废（不写回）。
              cancelEditing();
              onChange(entries.filter((_, at) => at !== target));
            } else {
              // 编辑的是另一行：草稿先并入，再在同一份数组里删除（一次落盘），
              // 然后退出编辑态——删除后行下标会前移，继续编辑会错行。
              onChange(entriesWithDraft().filter((_, at) => at !== target));
              cancelEditing();
            }
            setPendingDelete(null);
          }}
        />
      )}
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
        <Row
          label={t("启用 QQ 远程任务")}
          description={t(
            "从 QQ 私聊或群聊接收任务，在独立分支上执行。关闭面板不会停止 QQ 通道（通道随扩展宿主存活，重开面板可继续查看）。",
          )}
        >
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
          idLabel={t("openid")}
          idPlaceholder={t("完整 openid")}
          noun={t("用户")}
          addLabel={t("添加用户")}
          entries={value.allowedUsers}
          onChange={(allowedUsers) => onChange({ allowedUsers })}
        />
        <AccessList
          label={t("允许的群")}
          idLabel={t("群号")}
          idPlaceholder={t("完整群号")}
          noun={t("群")}
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