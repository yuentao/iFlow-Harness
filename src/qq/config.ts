/**
 * QQ 远程任务的配置层（Wave2-E）。
 *
 * 职责边界：
 *  - `normalizeQqConfig` / `validateQqConfig` / `checkQqStartupGate` /
 *    `buildBridgeEnv` 与 secret 键名都是**纯逻辑**，不 import vscode，便于单测；
 *  - 读设置的实际入口在 `src/qq/settings-host.ts`（`readQqSettings`），
 *    本模块只负责把裸值归一化、校验与门控。
 *
 * 归一化纪律：设置来自用户手写的 settings.json，脏值是常态。这里把每一处
 * 「类型不符 / 非法枚举 / 越界裁剪」都收敛到默认值或允许范围，并**如实**记进
 * `warnings`，不静默吞掉 —— 调用方可以据此提示用户，而不是让人以为配置生效了。
 *
 * 校验纪律：`validateQqConfig` 只报问题、不做修正。启用通道却没有任何白名单、
 * 或启用却连不上后端这类问题必须由调用方决定是否拦下。
 *
 * 日志纪律：secret 只出现在 `buildBridgeEnv` 的返回值与 `QQ_SECRET_KEYS` 的键名
 * 里；本模块不打印任何东西。
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { QqRemotePolicy, QqResultDetail } from "../../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 枚举取值
// ---------------------------------------------------------------------------

/**
 * QQ 适配器种类（取值与 package.json 的 `iflow.qq.adapter` 枚举逐字一致）。
 *
 * `onebot` 走 OneBot v11（`src/qq/adapter/onebot.ts`）；`qqbot` 走 QQ 官方
 * 机器人网关（M3-B 起有真实 WS transport `src/qq/qqbot/ws-transport.ts` +
 * M2 的 `src/qq/qqbot/adapter.ts`），两者都已实现、都可通过启动门控。
 * 新增适配器时在这里追加并同步设置项枚举。
 */
const ADAPTERS = ["onebot", "qqbot"] as const;
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

export type QqAdapterKind = (typeof ADAPTERS)[number];
/** 权威类型在 `shared/qq-task.ts`，此处只做转出，避免两份枚举漂移。 */
export type { QqRemotePolicy, QqResultDetail };

// ---------------------------------------------------------------------------
// 配置形状与默认值
// ---------------------------------------------------------------------------

/** 归一化后的 QQ 通道配置（`iflow.qq.*` 12 项）。 */
export interface QqConfig {
  enabled: boolean;
  adapter: QqAdapterKind;
  /** OneBot HTTP API 基地址，例如 `http://127.0.0.1:3000/`。 */
  endpoint: string;
  /** bridge 的入站端口；0 = 由系统分配。 */
  bridgePort: number;
  /** 允许通过 QQ 派发任务的用户 QQ 号。 */
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
  adapter: "onebot",
  endpoint: "",
  bridgePort: 0,
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
  bridgePort: { min: 0, max: 65535 },
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
 *  - 字符串 `trim()`（`endpoint` / `workspace` 为空串时原样保留）；
 *  - 白名单数组去空白、去空项、去重（保持首次出现顺序），非字符串项跳过并告警；
 *  - 数字先四舍五入取整，再裁剪到允许范围，偏离原值即告警；
 *  - 非法枚举 / 类型不符一律回退默认值并告警；键缺失（`undefined`）静默用默认值。
 */
export function normalizeQqConfig(raw: Record<string, unknown>): QqNormalizeResult {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnings: string[] = [];

  const config: QqConfig = {
    enabled: readBoolean(source, "enabled", DEFAULTS.enabled, warnings),
    adapter: readEnum(source, "adapter", ADAPTERS, DEFAULTS.adapter, warnings),
    endpoint: readString(source, "endpoint", DEFAULTS.endpoint, warnings),
    bridgePort: readInteger(
      source,
      "bridgePort",
      RANGES.bridgePort,
      DEFAULTS.bridgePort,
      warnings,
    ),
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
  const seen = new Set<string>();
  const ids: string[] = [];
  let skipped = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      skipped += 1;
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (skipped > 0) {
    warnings.push(`iflow.qq.${key} 有 ${skipped} 个非字符串项被忽略`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export type QqConfigIssueSeverity = "error" | "warning";

export type QqConfigIssueCode =
  | "endpoint_required"
  | "allowlist_empty"
  | "workspace_relative"
  | "workspace_not_in_roots"
  | "bridge_port_conflict"
  | "trusted_policy"
  | "adapter_unsupported"
  | "workspace_not_active_root";

export interface QqConfigIssue {
  severity: QqConfigIssueSeverity;
  code: QqConfigIssueCode;
  message: string;
}

/**
 * OneBot 后端的常见默认端口（NapCat 3000 / go-cqhttp 5700、6700）。
 * bridge 占用它们大概率起不来，因此只报 warning、不拦保存。
 */
export const QQ_RESERVED_BRIDGE_PORTS: readonly number[] = [3000, 5700, 6700];

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

  const endpoint = config.endpoint.trim();
  if (config.enabled && endpoint.length === 0) {
    issues.push({
      severity: "error",
      code: "endpoint_required",
      message: "已启用 QQ 通道，但 endpoint 为空：bridge 无从连接 OneBot 后端。",
    });
  }

  if (
    config.enabled &&
    config.allowedUsers.length === 0 &&
    config.allowedGroups.length === 0
  ) {
    issues.push({
      severity: "error",
      code: "allowlist_empty",
      message:
        "已启用 QQ 通道，但用户白名单与群白名单都为空：任何 QQ 号都能远程派发任务（等于裸奔）。",
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

  if (config.bridgePort !== 0 && QQ_RESERVED_BRIDGE_PORTS.includes(config.bridgePort)) {
    issues.push({
      severity: "warning",
      code: "bridge_port_conflict",
      message: `bridgePort=${config.bridgePort} 与 OneBot 后端默认端口冲突，bridge 可能无法启动。`,
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
 * 当前是否真的有可用的适配器实现。
 *
 * M3-B 起 `onebot`（OneBot v11）与 `qqbot`（QQ 官方机器人，M2 的 adapter +
 * 真实 WS transport）都已实现，两者均受支持；保留此函数供门控与 UI 复用。
 */
export function isAdapterSupported(config: QqConfig): boolean {
  return config.adapter === "onebot" || config.adapter === "qqbot";
}

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
 * 与 `validateQqConfig` 分开：那些是「配置写错了」（缺 endpoint、白名单为空），
 * 这些是「环境不满足」——即使其余配置完美也必须拒绝启动。M3-B 起 onebot 与
 * qqbot 都已实现，不再因适配器种类拒绝；当前唯一硬门控是 workspace 必须落在
 * 当前工作区根（qqbot 也一样，远程任务由主仓根上的 worktree 执行）。
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
// bridge 环境变量
// ---------------------------------------------------------------------------

export interface QqBridgeEnvOptions {
  /** 宿主 IPC 服务实际监听的端口（loopback）。 */
  hostPort: number;
  /** bridge → 宿主的 Bearer token。 */
  bridgeToken: string;
  /** 请求签名用的 HMAC 密钥。 */
  hmacSecret: string;
  /** OneBot 后端的 access token。 */
  onebotToken: string;
  /** OneBot HTTP API 基地址；省略时用 `config.endpoint`。 */
  onebotUrl?: string;
  /** bridge 自己的入站端口。 */
  incomingPort: number;
  /** 入站端口对应的 token。 */
  incomingToken: string;
}

/**
 * 构造 bridge 子进程的环境变量。
 *
 * 键名是 bridge 侧的硬约定，**只产出这 7 个键**（测试断言无多余键）；
 * secret 只出现在返回值里，本函数不打印任何东西。
 */
export function buildBridgeEnv(
  config: QqConfig,
  opts: QqBridgeEnvOptions,
): Record<string, string> {
  return {
    IFLOW_QQ_HOST_PORT: String(opts.hostPort),
    IFLOW_QQ_BRIDGE_TOKEN: opts.bridgeToken,
    IFLOW_QQ_HMAC_SECRET: opts.hmacSecret,
    IFLOW_QQ_ONEBOT_URL: opts.onebotUrl ?? config.endpoint,
    IFLOW_QQ_ONEBOT_TOKEN: opts.onebotToken,
    IFLOW_QQ_INCOMING_PORT: String(opts.incomingPort),
    IFLOW_QQ_INCOMING_TOKEN: opts.incomingToken,
  };
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
  /** 适配器访问 QQ 开放平台的 access token（qqbot 适配器用；OneBot 走 endpoint + 自己的 token）。 */
  botToken: "iflow.qq.bot-token",
  /** 适配器应用凭据：qqbot 用它计算签名、换取 access token。 */
  appSecret: "iflow.qq.app-secret",
  /** 入站回调的签名密钥：校验 QQ 平台推送的事件确实来自本应用。 */
  signingSecret: "iflow.qq.signing-secret",
  /** bridge 子进程向宿主 IPC 出示的 Bearer token（即 `IFLOW_QQ_BRIDGE_TOKEN` 的来源）。 */
  bridgeToken: "iflow.qq.bridge-token",
} as const;
