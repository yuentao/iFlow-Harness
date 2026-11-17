/**
 * QQ 远程任务的配置层（Wave2-E）。
 *
 * 职责边界：
 *  - `normalizeQqConfig` / `validateQqConfig` / `checkQqStartupGate`
 *    与 secret 键名都是**纯逻辑**，不 import vscode，便于单测；
 *  - 读设置的实际入口在 `src/qq/settings-host.ts`（`readQqSettings`），
 *    本模块只负责把裸值归一化、校验与门控。
 *
 * 归一化纪律：设置来自用户手写的 settings.json，脏值是常态。这里把每一处
 * 「类型不符 / 非法枚举 / 越界裁剪」都收敛到默认值或允许范围，并**如实**记进
 * `warnings`，不静默吞掉 —— 调用方可以据此提示用户，而不是让人以为配置生效了。
 *
 * 校验纪律：`validateQqConfig` 只报问题、不做修正。启用通道却没有任何白名单
 * 这类问题必须由调用方决定是否拦下。
 *
 * 日志纪律：secret 只出现在 `QQ_SECRET_KEYS` 的键名里；本模块不打印任何东西。
 *
 * 配置收敛（阶段4）：QQ 通道只走 QQ 官方机器人网关（真实 WS transport
 * `src/qq/qqbot/ws-transport.ts` + `src/qq/qqbot/adapter.ts`）。曾经用于旧协议
 * 后端的「协议选择 / 接入地址 / 桥接端口」三个设置项已移除，不再归一化、不再
 * 校验、不再参与启动门控。
 */

import { isAbsolute, relative, resolve } from "node:path";
import {
  normalizeQqAllowEntries,
  normalizeQqAllowEntry,
} from "../../shared/qq-access.js";
import type { QqRemotePolicy, QqResultDetail } from "../../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 枚举取值
// ---------------------------------------------------------------------------

/** 远程执行策略：readonly 只读，supervised 逐次确认，trusted 免确认。 */
const REMOTE_POLICIES = [
  "readonly",
  "supervised",
  "trusted",
] as const satisfies readonly QqRemotePolicy[];
/** 回传结果的详细程度。 */
const RESULT_DETAILS = [
  "summary",
  "standard",
  "full",
] as const satisfies readonly QqResultDetail[];

/** 权威类型在 `shared/qq-task.ts`，此处只做转出，避免两份枚举漂移。 */
export type { QqRemotePolicy, QqResultDetail };

// ---------------------------------------------------------------------------
// 配置形状与默认值
// ---------------------------------------------------------------------------

/** 归一化后的 QQ 通道配置（`iflow.qq.*` 9 项）。 */
export interface QqConfig {
  enabled: boolean;
  /**
   * 允许通过 QQ 派发任务的用户标识（QQ 官方 openid，不是 QQ 号）。
   *
   * 只有两个来源：扫码绑定成功时的扫码者本人（宿主自动写入）、以及面板里
   * 对「待审核用户」的人工放行。没有任何聊天命令能把自己加进来。
   */
  allowedUsers: string[];
  /** 允许通过 QQ 派发任务的群号。 */
  allowedGroups: string[];
  /** 远程任务的工作目录；空串表示沿用主工作区。 */
  workspace: string;
  remotePolicy: QqRemotePolicy;
  /** 同时运行的任务上限。 */
  maxConcurrentTasks: number;
  /** 每用户每分钟允许的指令数。 */
  rateLimitPerMin: number;
  resultDetail: QqResultDetail;
  /** 任务完成后是否自动合并回当前分支。 */
  autoMerge: boolean;
}

/**
 * 权威默认值（只此一份）。
 *
 * 不对外导出：返回值里的数组必须由 `normalizeQqConfig` 新建，避免调用方拿到
 * 共享引用后互相污染。
 */
const DEFAULTS: QqConfig = {
  enabled: false,
  allowedUsers: [],
  allowedGroups: [],
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
};

/** 数字项的允许范围（闭区间，先取整再裁剪）。 */
const RANGES = {
  maxConcurrentTasks: { min: 1, max: 10 },
  rateLimitPerMin: { min: 1, max: 60 },
} as const;

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

export interface QqNormalizeResult {
  config: QqConfig;
  /** 每一处回退 / 裁剪的原因（为空表示输入完全合法）。 */
  warnings: string[];
}

/**
 * 把任意 settings 值收敛成完整配置。
 *
 * 规则：
 *  - 字符串 `trim()`（`workspace` 为空串时原样保留）；
 *  - 白名单数组去空白、去空项、去重（保持首次出现顺序），非字符串项跳过并告警；
 *  - 数字先四舍五入取整，再裁剪到允许范围，偏离原值即告警；
 *  - 非法枚举 / 类型不符一律回退默认值并告警；键缺失（`undefined`）静默用默认值。
 *  - 阶段4 移除的三个旧协议设置键被忽略，不进配置、不产 warning。
 */
export function normalizeQqConfig(raw: Record<string, unknown>): QqNormalizeResult {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnings: string[] = [];

  const config: QqConfig = {
    enabled: readBoolean(source, "enabled", DEFAULTS.enabled, warnings),
    allowedUsers: readIdList(source, "allowedUsers", warnings),
    allowedGroups: readIdList(source, "allowedGroups", warnings),
    workspace: readString(source, "workspace", DEFAULTS.workspace, warnings),
    remotePolicy: readEnum(
      source,
      "remotePolicy",
      REMOTE_POLICIES,
      DEFAULTS.remotePolicy,
      warnings,
    ),
    maxConcurrentTasks: readInteger(
      source,
      "maxConcurrentTasks",
      RANGES.maxConcurrentTasks,
      DEFAULTS.maxConcurrentTasks,
      warnings,
    ),
    rateLimitPerMin: readInteger(
      source,
      "rateLimitPerMin",
      RANGES.rateLimitPerMin,
      DEFAULTS.rateLimitPerMin,
      warnings,
    ),
    resultDetail: readEnum(
      source,
      "resultDetail",
      RESULT_DETAILS,
      DEFAULTS.resultDetail,
      warnings,
    ),
    autoMerge: readBoolean(source, "autoMerge", DEFAULTS.autoMerge, warnings),
  };

  return { config, warnings };
}

function readString(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warnings: string[],
): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    warnings.push(`iflow.qq.${key} 期望字符串，已回退默认值 ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return value.trim();
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    warnings.push(`iflow.qq.${key} 期望布尔值，已回退默认值 ${String(fallback)}`);
    return fallback;
  }
  return value;
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const value = source[key];
  if (value === undefined) return fallback;
  const options = allowed.join(" / ");
  if (typeof value !== "string") {
    warnings.push(
      `iflow.qq.${key} 期望字符串（可选值：${options}），已回退默认值 ${fallback}`,
    );
    return fallback;
  }
  const trimmed = value.trim();
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  warnings.push(
    `iflow.qq.${key} 的值 ${JSON.stringify(value)} 不在可选范围（${options}），已回退默认值 ${fallback}`,
  );
  return fallback;
}

function readInteger(
  source: Record<string, unknown>,
  key: string,
  range: { readonly min: number; readonly max: number },
  fallback: number,
  warnings: string[],
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(
      `iflow.qq.${key} 期望 ${range.min}..${range.max} 之间的整数，已回退默认值 ${fallback}`,
    );
    return fallback;
  }
  const adjusted = Math.min(range.max, Math.max(range.min, Math.round(value)));
  if (adjusted !== value) {
    warnings.push(
      `iflow.qq.${key} 期望 ${range.min}..${range.max} 之间的整数，已把 ${value} 调整为 ${adjusted}`,
    );
  }
  return adjusted;
}

function readIdList(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
): string[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`iflow.qq.${key} 期望字符串数组，已回退为空列表`);
    return [];
  }
  // 存储格式是联合：裸 openid（历史）或 { openid, note }（带备注）。
  // 运行期匹配只认完整 openid，备注不进 QqConfig。
  const ids = normalizeQqAllowEntries(value).map((entry) => entry.openid);
  let skipped = 0;
  for (const item of value) {
    if (typeof item === "string") continue;
    if (normalizeQqAllowEntry(item)) continue;
    skipped += 1;
  }
  if (skipped > 0) {
    warnings.push(`iflow.qq.${key} 有 ${skipped} 个无效条目被忽略`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export type QqConfigIssueSeverity = "error" | "warning";

export type QqConfigIssueCode =
  | "allowlist_empty"
  | "workspace_relative"
  | "workspace_not_in_roots"
  | "trusted_policy"
  | "workspace_not_active_root";

export interface QqConfigIssue {
  severity: QqConfigIssueSeverity;
  code: QqConfigIssueCode;
  message: string;
}

/**
 * 校验配置（只报问题，不修正）。
 *
 * `roots` 是当前窗口的多根工作区列表；传了才检查 `workspace` 是否落在其中
 * （等于某个根或位于某个根之内都算合法）。不传则跳过该项。
 */
export function validateQqConfig(
  config: QqConfig,
  roots?: readonly string[],
): QqConfigIssue[] {
  const issues: QqConfigIssue[] = [];

  if (
    config.enabled &&
    config.allowedUsers.length === 0 &&
    config.allowedGroups.length === 0
  ) {
    // 只提示不拦启动：QqService.acceptInbound 本身要求白名单命中，空名单
    // 意味着「谁都不能派发任务」——不是「裸奔」，而是只有待审核记录。扫码
    // 成功后宿主会自动把扫码者写进白名单，因此这里也不该拦启动。
    issues.push({
      severity: "warning",
      code: "allowlist_empty",
      message:
        "已启用 QQ 通道，但用户白名单与群白名单都为空：任何人都无法派发任务，只会收到待审核记录；扫码绑定会自动加入扫码者，其余人可在面板里审核放行。",
    });
  }

  const workspace = config.workspace.trim();
  const workspaceAbsolute = workspace.length > 0 && isAbsolute(workspace);
  if (workspace.length > 0 && !workspaceAbsolute) {
    issues.push({
      severity: "warning",
      code: "workspace_relative",
      message: `workspace 不是绝对路径（${workspace}）：远程任务的工作目录无法可靠定位。`,
    });
  }
  if (
    workspaceAbsolute &&
    roots &&
    roots.length > 0 &&
    !roots.some((root) => isWithinRoot(workspace, root))
  ) {
    issues.push({
      severity: "error",
      code: "workspace_not_in_roots",
      message: `workspace 不在当前工作区目录列表内（${workspace}）：远程任务无法在该目录启动。`,
    });
  }

  // 只有 trusted 是「免确认」；readonly / supervised 都会经过审批，不该报警。
  if (config.remotePolicy === "trusted") {
    issues.push({
      severity: "warning",
      code: "trusted_policy",
      message: "remotePolicy=trusted 表示远程任务免确认执行（审批不再拦路），风险自负。",
    });
  }

  return issues;
}

/** `child` 是否等于 `root` 或位于 `root` 之内（路径归一化后按相对路径判断）。 */
function isWithinRoot(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  if (rel.length === 0) return true;
  if (isAbsolute(rel)) return false;
  // `..` / `../x`（Windows 上是 `..\x`）表示逃出了 root。
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

/** 两个路径是否指向同一个目录（Windows 大小写不敏感）。 */
function isSamePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------------------
// 启动门控
// ---------------------------------------------------------------------------

/**
 * `workspace` 是否与任务实际执行的工作区根兼容。
 *
 * 远程任务由 `SuperAgentManager` 在主仓根（当前激活工作区）上起 worktree，
 * `iflow.qq.workspace` 并不会把 spawn 挪到别处 —— 所以只接受「留空」或
 * 「恰好等于当前工作区根」；指向其它目录（哪怕是当前根的子目录）都会让
 * 用户以为任务跑在那里，实际却不是。`activeRoot` 缺失（没打开工作区）时
 * 任何非空 workspace 都不兼容。
 */
export function isWorkspaceCompatible(
  config: QqConfig,
  activeRoot?: string | null,
): boolean {
  const workspace = config.workspace.trim();
  if (workspace.length === 0) return true;
  const root = activeRoot?.trim() ?? "";
  if (root.length === 0) return false;
  return isSamePath(workspace, root);
}

/**
 * 启动前必须满足的硬门控（只报问题，不做修正）。
 *
 * 与 `validateQqConfig` 分开：那些是「配置写错了」（白名单为空），这些是
 * 「环境不满足」——即使其余配置完美也必须拒绝启动。QQ 通道只走 QQBot 官方
 * 网关，当前唯一硬门控是 workspace 必须落在当前工作区根（远程任务由主仓根
 * 上的 worktree 执行）。
 *
 * 调用方负责先判断 `config.enabled`；本函数只看路径兼容性。
 */
export function checkQqStartupGate(
  config: QqConfig,
  activeRoot?: string | null,
): QqConfigIssue[] {
  const issues: QqConfigIssue[] = [];

  if (!isWorkspaceCompatible(config, activeRoot)) {
    issues.push({
      severity: "error",
      code: "workspace_not_active_root",
      message: "QQ 任务暂只支持当前工作区，请改为当前工作区根或清空该设置",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// SecretStorage 键名
// ---------------------------------------------------------------------------

/**
 * QQ 通道的 secret 在 VSCode SecretStorage 里的键名。
 *
 * 键名沿用 `iflow.qq.*` 命名空间（与 `src/acp/auth.ts` 的
 * `iflow.openai-compatible` / `iflow.profiles` 同风格：全小写、点分段、
 * 段内用连字符），只给键，不给值；secret 本体永远由调用方从 SecretStorage
 * 读写。
 */
export const QQ_SECRET_KEYS = {
  /** 适配器应用凭据：qqbot 用它计算签名、换取 access token。 */
  appSecret: "iflow.qq.app-secret",
  /** 入站回调的签名密钥：校验 QQ 平台推送的事件确实来自本应用。 */
  signingSecret: "iflow.qq.signing-secret",
  /** bridge 子进程向宿主 IPC 出示的 Bearer token（即 `IFLOW_QQ_BRIDGE_TOKEN` 的来源）。 */
  bridgeToken: "iflow.qq.bridge-token",
} as const;