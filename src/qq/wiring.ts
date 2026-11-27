/**
 * QQ 面板接线的**纯逻辑**（Wave3-B2b）。
 *
 * `panel.ts` 里那段接线本身没法单测（要起 vscode、要 spawn bridge、要读写
 * SecretStorage），所以凡是「有判断」的部分都搬到此处，保持零 vscode 依赖、
 * 零副作用：
 *
 *  - {@link isTerminalSuperStatus}：等待子会话收尾时的终态口径（字符串入参，
 *    端口拿到的可能是一个陌生值，不能被 `SuperStatus` 的类型断言骗过去）；
 *  - {@link shouldRestartOnPatch}：**哪些设置改动必须重建 QQ 服务**。
 *
 * 关于「必须重启」的取舍（与 panel 里的热更新路径配套）：
 * `QqService` 在构造时拿走一份 `config` 快照，但白名单 / 策略 / 并发 / 限流 /
 * 详略 / 自动合并这些字段都是在**使用时**从同一个对象里读的，因此面板可以
 * 直接改字段让它们即时生效；而 `enabled`（起停）只能靠重建 QQ 服务才能生效
 * —— 这就是 {@link QQ_CONNECTION_FIELDS}。阶段4 移除了历史遗留的
 * `adapter` / `endpoint` / `bridgePort`，连接类字段现在只剩 `enabled`。
 */

import type { QqConfig } from "./config.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 轮询子会话终态的间隔。
 *
 * `SuperAgentManager` 只对外暴露**一个** `onSessionsChanged` 回调（面板已经
 * 用它把投影写进 store），没有「按订阅者分发」的事件面；为了不为了 QQ 通道
 * 就改动它的公开接口，这里退化为轮询 store 里的 `superSessions` 投影。
 * 1.5s 对「等一个可能跑几十分钟的子会话」绰绰有余，又不会让看板延迟可感。
 */
export const QQ_SETTLE_POLL_MS = 1_500;

/**
 * 只有 `enabled` 的改动需要重建 QQ 服务（见文件头注释）。
 *
 * 其余字段（allowedUsers / allowedGroups / workspace / remotePolicy /
 * maxConcurrentTasks / rateLimitPerMin / resultDetail / autoMerge）由面板
 * 直接热更新到运行中的 config 对象上，改完即时生效、不打断在跑的任务。
 */
export const QQ_CONNECTION_FIELDS = [
  "enabled",
] as const;

// ---------------------------------------------------------------------------
// 服务重启判定
// ---------------------------------------------------------------------------

/** 字段值比较：数组按元素逐位比较，其余按严格相等。 */
function sameFieldValue(previous: unknown, next: unknown): boolean {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return (
      previous.length === next.length &&
      previous.every((item, index) => item === next[index])
    );
  }
  return previous === next;
}

/**
 * 这次设置补丁是否要求重建 QQ 服务。
 *
 * - 只认 {@link QQ_CONNECTION_FIELDS}；白名单 / 策略等热更新字段一律返回 false。
 * - `undefined` 表示「本次不改」，不参与判定（与 `applyQqSettingsPatch` 同语义）。
 * - `previous` 缺失（服务没在跑，或调用方还没有快照）时，只要补丁碰到连接类
 *   字段就返回 true —— 交给调用方决定「该起还是该停」。
 * - 值没变（例如回写同一份 enabled）不算改动，避免无谓地重启 QQ 服务。
 */
export function shouldRestartOnPatch(
  previous: QqConfig | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): boolean {
  if (!patch || typeof patch !== "object") return false;
  for (const field of QQ_CONNECTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const next = patch[field];
    if (next === undefined) continue;
    if (!previous) return true;
    if (!sameFieldValue(previous[field], next)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 工作区根集合变化
// ---------------------------------------------------------------------------

/**
 * 路径比较键：trim、去掉尾部路径分隔符，Windows 上再小写。
 *
 * VSCode 回传的根路径在大小写 / 尾分隔符上并不稳定（用户从最近列表打开时
 * 盘符大小写会变），直接逐字比较会把「同一个根」判成变化并触发一次无谓的
 * 通道重建 —— 那会打断正在跑的 QQ 任务。
 */
function qqRootKey(root: string): string {
  const trimmed = root.trim().replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * 工作区根集合是否真的变了（**顺序敏感**）。
 *
 * 顺序必须参与比较：`roots[0]` 决定 CLI 进程 cwd 与默认任务目录，删掉第一个
 * 根会让剩余根本身不变、但语义已经改变。
 */
export function qqWorkspaceRootsChanged(
  previous: readonly string[] | null | undefined,
  next: readonly string[] | null | undefined,
): boolean {
  const before = previous ?? [];
  const after = next ?? [];
  if (before.length !== after.length) return true;
  return before.some((root, index) => qqRootKey(root) !== qqRootKey(after[index] ?? ""));
}

/**
 * 工作区根集合变化后的处置。
 *
 * QQ 通道的现场在启动时固定了一批与根相关的东西（配置快照、启动门控用的
 * activeRoot、任务 / 待审核存储目录），根一变就必须重新解析并重建，否则表现
 * 为「换工作区后 QQ 不生效，必须手动重新保存一次配置」：
 *  - `noop`：根没变。什么都不做（重建会打断在跑的 QQ 任务）；
 *  - `restart`：通道正在跑 → 释放旧现场后按新根重建（开关在新工作区里被关掉
 *    时，重建即「只停不起」）；
 *  - `start`：没有现场 → 按新工作区重新读设置，能起就起（空窗口激活时启动
 *    可能被工作区门控拦下，打开文件夹后正是这一次补起）。
 */
export type QqWorkspaceChangeAction = "noop" | "start" | "restart";

export function planQqWorkspaceChange(input: {
  previousRoots: readonly string[] | null | undefined;
  nextRoots: readonly string[] | null | undefined;
  running: boolean;
}): QqWorkspaceChangeAction {
  if (!qqWorkspaceRootsChanged(input.previousRoots, input.nextRoots)) return "noop";
  return input.running ? "restart" : "start";
}

// ---------------------------------------------------------------------------
// 子会话终态
// ---------------------------------------------------------------------------

/**
 * 子会话终态词表（**唯一权威**，大小写不敏感）。
 *
 * 除了 `SuperStatus` 的三个标准终态（completed / failed / cancelled），还包含
 * 上游执行体与归档里真实出现的别名：`done`（完成）、`error`（失败）、
 * `aborted` / `interrupted`（中断）、`merged`（已完成并合并）。
 *
 * 为什么必须收全：`src/panel/panel.ts` 的 QQ `waitForSettle` 用本模块的
 * {@link isTerminalSuperStatus} 轮询看板状态，漏判任一别名都会让本该收尾的
 * 子会话一直挂到 2 小时兜底超时；而 `src/qq/store.ts` 的归档清理词表也认这些
 * 别名 —— 两处口径必须一致，故集中在此导出。
 */
export const QQ_SUPER_TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "cancelled",
  "done",
  "error",
  "aborted",
  "interrupted",
  "merged",
];

/** 状态归一化：字符串 trim + 小写；非字符串（脏值）返回空串。 */
export function qqSuperStatusKey(status: string | null | undefined): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

/** 终态且语义为「失败」的别名。 */
export function isSuperFailureStatus(status: string | null | undefined): boolean {
  const key = qqSuperStatusKey(status);
  return key === "failed" || key === "error";
}

/** 终态且语义为「取消 / 中断」的别名。 */
export function isSuperCancelStatus(status: string | null | undefined): boolean {
  const key = qqSuperStatusKey(status);
  return key === "cancelled" || key === "canceled" || key === "aborted" || key === "interrupted";
}

/** 终态且语义为「已合并」的别名。 */
export function isSuperMergedStatus(status: string | null | undefined): boolean {
  return qqSuperStatusKey(status) === "merged";
}

/**
 * 子会话是否已到终态。
 *
 * 入参刻意是 `string`：状态来自 wire / 归档，可能带着旧版本或脏值；用
 * `SuperStatus` 断言会让「未知值」被当成终态或非终态的其中一边。词表来自
 * {@link QQ_SUPER_TERMINAL_STATUSES}，与归档清理、终态映射同一口径。
 */
export function isTerminalSuperStatus(status: string | null | undefined): boolean {
  const key = qqSuperStatusKey(status);
  if (key.length === 0) return false;
  return (QQ_SUPER_TERMINAL_STATUSES as readonly string[]).includes(key);
}
