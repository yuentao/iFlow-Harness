/**
 * Super Agent — 子会话编排（Extension Host only；编排逻辑本身不直接 import
 * vscode，但为了复用 `shared/session-state.ts` 的 reducer 而传递依赖它）。
 *
 * 一个子会话 = 一个独立 CLI 进程 + 一个独立 ACP session + 一个独立工作目录
 * （git worktree）。子会话的转录**不进主会话的 blocks**（会污染主转录并破坏
 * blockPatch 锚），主会话只看到一份投影：`SuperSessionUi` 列表。子会话自己的
 * 实时转录走独立通道（`onTranscript` → `superTranscript` 消息），详情面板用与
 * 主会话相同的 reducer / 块组件渲染。
 *
 * 关键设计（取自 Orca / dsh / DeepSeek 的共同骨架）：
 *  - 并发上限 + FIFO 排队：超过上限的派发请求排队而不是被拒绝 —— 用户要求
 *    「主会话可以随时开启子会话」。
 *  - 终态粘性：`applySuperEvent` 让终态不可回退，迟到的进度帧不会把已完成的
 *    子会话改回运行中（Orca `worker_done`「恰好发一次」的宿主侧等价物）。
 *  - 内部进展不打扰主会话：只有 ready / blocked / failed / dropped 会上报，
 *    progress 只更新看板（dsh 的 `internal_only` vs `notify`）。
 *  - **子会话默认免确认且完全自主**（缺省审批策略 `auto`）：内核被推到
 *    `yolo` 模式 —— 这是刻意的产品语义，子会话必须完全自主、不因审批往返而
 *    停顿，也不该把审批变成人工负担。代价是 `yolo` 下内核通常**不发**
 *    `session/request_permission`，所以宿主在审批点上的依赖护栏
 *    （`shared/super-agent-guard.ts`，拦会破坏主工作区依赖的安装/联接命令）
 *    只是**兜底**而非主防线：万一某类工具仍然发审批，宿主就地自动放行
 *    （shell 用 allow_once，危险命令 deny），既不产生待办也不阻塞子会话。
 *    需要「审批真的发生」的调用方（例如 QQ 远程任务）可以传
 *    `spawn(spec, { policy })`：`supervised` 不推 `yolo`、把权限请求交给回调
 *    裁决（未提供/抛错/超时按拒绝），`deny` 直接拒绝。三者都仍然保护依赖
 *    护栏这条硬底线。
 *    只有 `_iflow/user/questions` 是真正的信息缺口 —— 那是只有人才能回答的，
 *    落到子会话自己的 pending 槽位由看板就地作答（主会话的 pending 是单数槽位，
 *    多子会话并发会互相覆盖）。提问不是权限，任何策略下都走这条路。
 *  - **完成后自动带回改动**：按 `iflow.superAgent.integration` 自动合并到主
 *    工作区的当前分支，或推送分支并创建 PR。合并**串行**执行；是否安全先用
 *    `git merge-tree` 在对象库里预演（不碰索引与工作区），因此主工作区有未提交
 *    改动也能合并 —— 只有「合并会改动你正在改的已跟踪文件」或「正处于
 *    merge/rebase/cherry-pick 中间态」时才跳过并保留分支。冲突在预演阶段就被
 *    识别，实际 `merge` 不会启动，仓库永远不会被留在冲突态。
 *
 * 汇报的来源是宿主观察到的事件，不是内核的 report 工具 —— 内核的
 * agent→client 方法表是固定集合，新增原生工具必须改 fork bundle（v1 不做）。
 */

import path from "node:path";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AcpClient, AcpClientCallbacks } from "../acp/client.js";
import type { McpServer, SessionSettings } from "../acp/protocol.js";
import type {
  ContentBlock,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TurnUsageReport,
  UserQuestion,
  UserQuestionsResponse,
} from "../acp/protocol.js";
import { errorMessage } from "../acp/jsonrpc.js";
import { applySessionUpdate, estimateTokens, estimateTokensChunked } from "../../shared/session-state.js";
import {
  classifyChildFileWrite,
  classifyChildShellCommand,
  classifyChildToolCall,
  extractShellCommand,
  isShellToolCall,
  pickChildPermissionOption,
  type ChildShellGuardContext,
} from "../../shared/super-agent-guard.js";
import { EFFICIENCY_TURBO_PROMPT, renderPrompt } from "../../prompts/index.js";
import { estimateCost } from "../../shared/context-window.js";
import {
  EVICT_KEEP_BLOCKS,
  evictBlockPayloads,
  initialSessionState,
  type Block,
  type SessionState,
} from "../../shared/messages.js";
import {
  applySuperEvent,
  applySuperDiagnostic,
  applySuperFailure,
  buildSuperReportPrompt,
  canRetrySuperSession,
  capReportTail,
  clampMaxConcurrentSuperSessions,
  clampSuperMaxAttempts,
  DEFAULT_SUPER_MAX_ATTEMPTS,
  isTerminalSuperStatus,
  normalizeSuperTodos,
  groupSuperReportsByWave,
  reportForSession,
  retrySuperSession,
  shouldRetrySuperFailure,
  superTaskKey,
  toPersistedSuperSession,
  toSuperBoardSession,
  withIntegration,
  withUsage,
  type SuperDiagnosticKind,
  type SuperFailureKind,
  type PersistedSuperSession,
  type SuperAttachment,
  type SuperEvent,
  type SuperIntegration,
  type SuperIntegrationMode,
  type SuperInterruptSource,
  type SuperPending,
  type SuperReport,
  type SuperSessionUi,
  type SuperStatus,
  type SuperTaskSpec,
  type SuperTodoUi,
  type SuperTokenUsage,
} from "../../shared/super-agent.js";
import {
  branchHasUnmergedCommits,
  commitWorktree,
  comparisonPathKey,
  createPullRequest,
  createWorktree,
  currentBranch,
  deleteSuperBranch,
  discardFailedWorktree,
  ensureSuperIsolationIgnored,
  ghAvailable,
  inspectWorkingTree,
  isBranchMerged,
  listSuperBranches,
  listWorktrees,
  mergeBranch,
  previewMerge,
  probeGitRepo,
  pruneWorktrees,
  pushBranch,
  remoteOriginUrl,
  removeWorktree,
  sanitizeWorktreeName,
  SUPER_BRANCH_PREFIX,
  superBranchName,
  superIsolationDir,
  superWorktreeRoots,
  type WorkingTreeState,
  worktreeHasUncommittedChanges,
  worktreePathFor,
} from "./worktree.js";
import {
  deleteSuperTranscriptSnapshot,
  writeSuperTranscriptSnapshot,
} from "./super-store.js";

/**
 * 提问的自动放行时限（与主会话的审批卡同一纪律：超时就放行/继续，避免 agent
 * 永久阻塞）。审批不走这里 —— 缺省策略（auto）下子会话免确认、审批由宿主立即
 * 放行；`supervised` 策略的审批回调另有 {@link SUPER_PERMISSION_TIMEOUT_MS}。
 */
export const SUPER_PENDING_TIMEOUT_MS = 5 * 60_000;

/**
 * 子会话首轮 prompt 前等待 MCP 工具就绪的上限（毫秒）。
 *
 * 背景（2026-11 只读审计，CLI 0.5.19 + mcp-background-loader）：子会话走 host
 * MCP broker（不是零 MCP、也不是保留全部 server），但 CLI 侧的 MCP 工具是**后台
 * 异步注册**的 —— `startMcpDiscoveryInBackground()` 不 await，`newSession` 返回时
 * 工具可能还没挂上。紧接着发首轮 prompt，模型就会缺 MCP 工具。这里在两者之间
 * 加一次**有界**等待：轮询 `mcpStatus` 的 `discoveryState` 到 `completed`。
 *
 * 超时 / 查询失败一律只记一条降级日志后照常发送，绝不让子会话永久卡住。作为
 * 实例字段的默认值（见 {@link SuperAgentManager.mcpReadyTimeoutMs}），便于单测
 * 注入极小值验证超时路径，而不必真的等满数秒。
 */
export const SUPER_MCP_READY_TIMEOUT_MS = 4_000;

/** 上述等待的轮询间隔（毫秒），同样作为实例字段便于测试注入。 */
export const SUPER_MCP_READY_POLL_MS = 120;

/**
 * 子会话「无进展」看门狗阈值（毫秒）：收到任意 session/update 即刷新最近进展
 * 时刻，超过这个时长没有任何进展 → 归一为 failed、回收并发槽位并上报。
 *
 * 背景（SA-1 / 调研 G1，2026-11）：子会话有独立 CLI 进程与 ACP session，但宿主
 * 此前没有任何探活 / 无进展超时 —— 一个 CLI 进程失联、在途请求永不返回、或
 * 长时间不发 session/update 的子会话，状态会永远停在 running，并发槽位不回收，
 * 心跳空转，主会话的「等待 N 个子会话」永不结束。
 *
 * 刻意保守：真实长任务可能跑数小时，但只要它在正常工作就会持续发工具调用 /
 * 思考 / 文本帧，`lastProgressAt` 会不断刷新。只有「连续这么久一声不吭」才算
 * 卡死；且看门狗到点还会先用「进程是否存活」二次确认（见 onWatchdogTick）。
 * 这是实例字段的默认值（见 SuperAgentManager.stallTimeoutMs），单测注入极小值
 * 即可确定性验证超时路径，生产路径永不改写。
 *
 * 分级（批次2A）：准备阶段（spawn / newSession / MCP 就绪 / setMode / 首轮 prompt
 * 之前）没有在途 SSE 可产出事件，比在途 prompt 更早、更容易卡在内核握手上，因此
 * 用更短的阈值；进入 running（收到 started）后恢复到更保守的运行阈值。两档都保留
 * 「静默超时 + 进程存活二次确认才杀」的安全网（见 onWatchdogTick），绝不降低门槛。
 */
export const SUPER_STALL_WATCHDOG_PREPARE_MS = 5 * 60_000;
export const SUPER_STALL_WATCHDOG_RUNNING_MS = 30 * 60_000;

/** 看门狗所处的子会话阶段（准备 / 运行中），决定用哪一档静默阈值。 */
export type SuperWatchdogPhase = "prepare" | "running";

/**
 * 活性诊断的节流窗口（毫秒）：session/update 每帧都追加诊断会把看板与归档撑爆，
 * 因此同类活动（工具调用 / 文本帧）在这个窗口内只记一条。
 */
export const SUPER_ACTIVITY_DIAG_THROTTLE_MS = 5_000;

/**
 * 失败自动重试的退避窗口（毫秒）：retryable 失败归一后在后台等待这么久再自动
 * retry（不超过 maxAttempts）。作为实例字段便于单测注入极小值。仅当子会话显式
 * 声明 `maxAttempts > 1` 时启用，避免改变既有 fixture 的行为。
 */
export const SUPER_AUTO_RETRY_BACKOFF_MS = 200;

/**
 * 依赖跳过（上游失败 → 下游 blocked）时写入 `statusDetail` / `lastError` 的原因
 * 前缀。看板的失败分类 chip 由 `lastError.kind === "blocked"` 驱动。
 */
export const SUPER_DEPENDENCY_BLOCK_REASON = "上游任务失败，已跳过本任务";

/**
 * 单条诊断文本上限（共享层合并版未导出该常量，这里按同一口径本地定义）。
 * 防止把整段错误文本 / 任务书塞进诊断把看板与归档撑大。
 */
const SUPER_DIAGNOSTIC_TEXT_MAX_CHARS = 500;

/**
 * `.iflow/super/attachments/` 下附件副本的空闲清扫阈值（7 天）。
 *
 * 附件是主会话附件的临时拷贝，只服务一次子会话派发；正常终态会立即删除，
 * 这里只兜底清扫「进程被强杀 / 升级中断」等来不及收尾的孤儿。与 OS 临时
 * 附件 (`ATTACHMENT_TMP_MAX_AGE_MS`) 同一档，避免两套清理策略漂移。
 */
export const SUPER_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `.iflow/super/dirs/` 下降级目录的空闲清扫阈值（14 天）。
 *
 * 目录隔离比附件副本更容易留下「还有用的东西」（非 git 仓库的降级工作目录），
 * 因此阈值取附件的两倍，只回收长期无人问津的残留。
 */
export const SUPER_DIR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 可配置审批策略（Wave3-A）
// ---------------------------------------------------------------------------

/**
 * 子会话审批模式。
 *
 * - `auto`（缺省）：**完全维持既有行为** —— 内核推 `yolo`，宿主对任何
 *   `session/request_permission` 直接放行（shell 仍过依赖护栏）。本地现有
 *   调用零回归。
 * - `supervised`：**不推 `yolo`**；权限请求先交给策略里的
 *   `onPermissionRequest` 回调裁决，未提供回调、回调抛错或超时一律按拒绝处理
 *   （安全默认）。提问不是权限，仍落到看板作答。
 * - `deny`：**不推 `yolo`**；所有权限请求直接拒绝（取消输出）；提问仍走看板。
 *
 * - 计划模式已移除（2026-11-18）：`_iflow/plan/exit` 遗留请求按 spawn 审批策略
 *   处置 —— `auto` 快速放行、`deny` 拒绝、`supervised` 走策略回调（见
 *   `autoApproveRemovedPlanExit`），绝不让它成为 supervised 的策略后门。
 */
export type SuperApprovalMode = "auto" | "supervised" | "deny";

const SUPER_APPROVAL_MODES: readonly SuperApprovalMode[] = ["auto", "supervised", "deny"];

/**
 * 交给审批回调的请求摘要。
 *
 * `request` 是**原始 wire 请求**（含 `options`），回调可以据此做更细的判断。
 */
export interface SuperPermissionRequest {
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  /** 工具 kind（`execute` / `edit` / ...，wire 上的 `toolCall.kind`）。 */
  kind?: string;
  /** 人类可读摘要：工具标题。 */
  summary: string;
  /** 原始权限请求。 */
  request?: RequestPermissionRequest;
}

/**
 * 审批回调的裁决结果。
 *
 * 前三个值刻意与 wire 的 `PermissionOptionKind` 同名（`deny` 对应
 * `reject_once`/`reject_always`），由 {@link resolvePermissionResponse} 映射回
 * **agent 自己给出的 optionId** —— 宿主绝不伪造 optionId（CLI 用原生枚举解析，
 * 伪造会抛）。
 */
export type SuperPermissionDecision = "allow_once" | "allow_always" | "deny" | "cancel";

const SUPER_PERMISSION_DECISIONS: readonly SuperPermissionDecision[] = [
  "allow_once",
  "allow_always",
  "deny",
  "cancel",
];

/** 审批回调的裁决时限（略小于主会话审批卡的 5 分钟，超时按拒绝处理）。 */
export const SUPER_PERMISSION_TIMEOUT_MS = 4 * 60_000;

/**
 * spawn 时可选携带的策略。
 *
 * 缺省（不传）等价于 `{ approval: "auto" }` —— 现有调用点的行为一个字节都不变。
 */
export interface SuperSpawnPolicy {
  approval: SuperApprovalMode;
  /**
   * 传给子会话 `session/new` 的 `settings.disallowed_tools`（与主会话的
   * `MAIN_SESSION_DISALLOWED_TOOLS` 同名机制）。非空时才会出现在请求里。
   */
  disallowedTools?: string[];
  /**
   * `supervised` 模式的裁决回调。未提供时按拒绝处理（安全默认），
   * `auto` / `deny` 模式下不会被调用。
   */
  onPermissionRequest?: (request: SuperPermissionRequest) => Promise<SuperPermissionDecision>;
}

/** 归一化之后的策略（运行时形态：工具名去重、审批模式收敛为合法值）。 */
export interface ResolvedSuperSpawnPolicy {
  approval: SuperApprovalMode;
  disallowedTools: string[];
  onPermissionRequest?: (request: SuperPermissionRequest) => Promise<SuperPermissionDecision>;
}

/**
 * 工具名列表归一化：去掉非字符串、空白项与重复项（保留首次出现的顺序）。
 *
 * 这是 wire 边界：策略可能来自面板设置、JSON 或模型生成的指令块，脏值不应
 * 让 `session/new` 携带一个毫无意义的黑名单。
 */
export function normalizeDisallowedTools(raw?: readonly unknown[] | null): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 把 spawn 的可选 policy 归一化成运行时策略。
 *
 * 纯函数：不读环境、不碰磁盘。缺省 / null / 脏值（例如被手改成 `"Auto"`）一律
 * 收敛为 `auto` —— 「不认识就按现状跑」比「猜一个更严格的模式」更安全，因为
 * 策略缺失时用户期待的是现有行为。
 */
export function resolveSpawnPolicy(
  spec?: { policy?: SuperSpawnPolicy | null } | null,
): ResolvedSuperSpawnPolicy {
  const raw = spec?.policy ?? null;
  const approval =
    raw && (SUPER_APPROVAL_MODES as readonly string[]).includes(raw.approval)
      ? raw.approval
      : "auto";
  const resolved: ResolvedSuperSpawnPolicy = {
    approval,
    disallowedTools: normalizeDisallowedTools(raw?.disallowedTools),
  };
  if (raw?.onPermissionRequest) resolved.onPermissionRequest = raw.onPermissionRequest;
  return resolved;
}

/**
 * repo 档合并子会话**必须**带上的机械工具黑名单。
 *
 * 合并子会话跑在主仓工作区（无版本隔离），任务书里的硬边界只是提示词
 * 约束。这里从工具层面再收一道：
 *  - `task`：进程内子代理与合并子会话共享 cwd（主仓工作区）与完整工具集，
 *    它的写文件工具调用不带命令文本、绕开 shell 命令护栏；派它等于开出
 *    一块宿主看不见的执行面。合并这件事本身不需要任何子代理。
 *  - `super-agent`：内置子会话派发工具，同样会把工作扩散到别的执行体。
 *
 * **刻意不剔除** `run_shell_command` / `write_file` / `replace` / `read_file`：
 * `git merge --no-ff`、冲突文件读写、收尾的 `git log` / `git status` 都依赖
 * 它们，剔除任一项都会让正常合并直接失效（这是本加固的红线）。
 * 这些工具带来的风险由 wire 帧上的护栏兜住（见 `callbacksFor` 的预检）。
 */
export const SUPER_MERGE_CHILD_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "task",
  "super-agent",
]);

/** 合并子会话的 spawn 策略：审批维持 `auto`，只叠加机械工具黑名单。 */
export function superMergeChildPolicy(): SuperSpawnPolicy {
  return { approval: "auto", disallowedTools: [...SUPER_MERGE_CHILD_DISALLOWED_TOOLS] };
}

/** 一个值是否是合法的裁决（回调返回脏值时不采纳，按拒绝处理）。 */
function isSuperPermissionDecision(value: unknown): value is SuperPermissionDecision {
  return typeof value === "string" && (SUPER_PERMISSION_DECISIONS as readonly string[]).includes(value);
}

/**
 * 执行审批回调并收敛结果。
 *
 * 三条安全默认：**没有回调**、**回调抛错**、**超过时限**一律返回 `deny`。
 * 回调返回非枚举值时同样按拒绝处理 —— 绝不把脏值当成放行。
 *
 * `timeoutMs` 是显式参数（默认 {@link SUPER_PERMISSION_TIMEOUT_MS}），便于单测
 * 用极小的超时验证超时路径，而不必伪造定时器。
 */
export async function awaitSuperPermissionDecision(
  handler: ((request: SuperPermissionRequest) => Promise<SuperPermissionDecision>) | undefined,
  request: SuperPermissionRequest,
  timeoutMs: number = SUPER_PERMISSION_TIMEOUT_MS,
): Promise<SuperPermissionDecision> {
  if (!handler) return "deny";
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<SuperPermissionDecision>((resolve) => {
      timer = setTimeout(() => resolve("deny"), Math.max(0, timeoutMs));
      if (typeof timer.unref === "function") timer.unref();
    });
    const decided = await Promise.race([handler(request), timedOut]);
    return isSuperPermissionDecision(decided) ? decided : "deny";
  } catch {
    return "deny";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * MCP 发现是否已经稳定（工具已注册，可以安全发首轮 prompt）。
 *
 * 只有 `completed` 算“发现结束”。`undefined` / `"unknown"` 表示被查询的 CLI
 * 没上报发现状态（旧 bundle / 无 loader）—— 没有可等的信号，按“已就绪”立即
 * 返回，避免为一个永远不会来的状态白等满超时。`in_progress` / `not_started`
 * 才需要继续等。
 */
function mcpDiscoverySettled(state: string | undefined): boolean {
  return state === undefined || state === "unknown" || state === "completed";
}

/**
 * 子会话首轮 prompt 前，有界等待 MCP 工具注册完成（见
 * {@link SUPER_MCP_READY_TIMEOUT_MS} 的背景说明）。
 *
 * 三条降级路径都**不阻塞**子会话，只记一条日志后返回：
 *  - `mcpStatus` 抛错（mcp-status-refactor Mod 缺失 / CLI 已拆）—— 与面板
 *    「无指示灯」同一纪律，绝不假装就绪；
 *  - 超过 `timeoutMs` —— 整体 deadline 连“某次 mcpStatus 一直挂着”也卡住
 *    （`JsonRpcPeer.request` 默认 120s，远超这里的小上限）；
 *  - `discoveryState` 为 undefined/unknown —— 无可等信号，立即返回。
 *
 * `client` 只取 `mcpStatus` 一个方法，便于单测用极小的 FakeClient 直接验证。
 */
export async function waitForChildMcpReady(options: {
  client: Pick<AcpClient, "mcpStatus">;
  sessionId: string;
  timeoutMs: number;
  pollMs: number;
  log: SuperAgentDeps["log"];
  label: string;
}): Promise<void> {
  const { client, sessionId, timeoutMs, pollMs, log, label } = options;
  let stopped = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
    if (typeof timer.unref === "function") timer.unref();
  });
  const poll = (async () => {
    while (!stopped) {
      try {
        const report = await client.mcpStatus(sessionId);
        if (stopped) return;
        // 记录 MCP 发现状态与每个服务器的连接状态，便于排查子会话
        // 中 MCP 工具不可见的问题（discoveryState / servers[].status / error）。
        const serverEntries = Object.entries(report.servers ?? {}).map(
          ([name, s]) => `${name}=${s.status}${s.error ? `(${s.error})` : ""}`,
        );
        log.info(
          `[${label}] MCP 就绪状态：discoveryState=${report.discoveryState}, servers=[${serverEntries.join(", ")}]`,
        );
        if (mcpDiscoverySettled(report.discoveryState)) {
          settled = true;
          return;
        }
      } catch (error) {
        if (stopped) return;
        settled = true;
        log.warn(`[${label}] 查询 MCP 就绪状态失败，照常发送首轮 prompt：${errorMessage(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollMs)));
    }
  })();
  await Promise.race([poll, deadline]);
  stopped = true;
  if (timer) clearTimeout(timer);
  if (!settled) {
    log.warn(
      `[${label}] 等待 MCP 工具就绪超过 ${timeoutMs}ms，照常发送首轮 prompt（首轮可能缺 MCP 工具）`,
    );
  } else {
    log.info(`[${label}] MCP 工具已就绪，继续发送首轮 prompt`);
  }
}

/**
 * 把裁决映射回 wire 响应。
 *
 * **只用 agent 给出的 option id**：allow 类找不到允许选项、deny 类找不到拒绝
 * 选项时退回「取消」（与审批超时同一条路），绝不伪造批准。
 */
export function resolvePermissionResponse(
  options: readonly PermissionOption[],
  decision: SuperPermissionDecision,
): RequestPermissionResponse {
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const preferred: PermissionOptionKind[] =
    decision === "allow_once"
      ? ["allow_once", "allow_always"]
      : decision === "allow_always"
        ? ["allow_always", "allow_once"]
        : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const option = options.find((item) => item.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** 原始权限请求 → 交给策略回调的摘要（保留 wire 请求本体供回调细判）。 */
export function toSuperPermissionRequest(request: RequestPermissionRequest): SuperPermissionRequest {
  const tool = request.toolCall;
  const summary = tool.title ?? tool.toolName ?? "tool permission request";
  const out: SuperPermissionRequest = {
    sessionId: request.sessionId,
    summary,
    request,
  };
  if (tool.toolCallId) out.toolCallId = tool.toolCallId;
  if (tool.toolName) out.toolName = tool.toolName;
  if (typeof tool.kind === "string") out.kind = tool.kind;
  return out;
}

/**
 * 实时进度的尾部上限。子会话的完整转录不进快照，看板只拿一段尾部文本做
 * 「进度详情」；不设上限的话长输出会随每次 flush 反复序列化。
 */
export const SUPER_PROGRESS_MAX_CHARS = 4_000;

/** 实时进度推送节流：流式 chunk 不必逐个上屏，但要让看板看得出「它在动」。 */
export const SUPER_PROGRESS_THROTTLE_MS = 700;

/**
 * 子会话助手文本（含思考文本）的累计上限。
 *
 * 子会话的输出没有天然上限：一次长任务能吐几十万字符。全量留着有两个问题：
 *  1. 内存 —— 每个子会话都攒着一份纯文本，长会话多起来时是可观的常驻占用；
 *  2. 收尾时的 token 估算要对这份文本做一次 BPE —— 文本越长，那次同步估算
 *     在扩展宿主事件循环里占的时间越长（见 `estimateTokensChunked`）。
 *
 * 超限时只保留**尾部**（进度尾部、汇报摘要都只看尾部；头部被丢掉不影响
 * 任何现有语义）。
 */
export const SUPER_TEXT_MAX_CHARS = 120_000;

/**
 * 作为视觉块直接送给子会话的图片上限（与主会话的 `ATTACHMENT_IMAGE_MAX_BYTES`
 * 同口径 5MB）。
 *
 * 刻意**不**用 8MB：base64 膨胀约三分之一，8MB 的图片块序列化后会超过 ACP
 * NDJSON 帧的 8MB 上限（见 `src/acp/jsonrpc.ts` 的帧护栏），prompt 会被解析端
 * 丢弃而永久悬挂。超过阈值的图片仍会落盘并作为文件路径交给子会话（它可读到），
 * 只是不作为内联视觉块发送。
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** 单份附件超过这个大小就不复制 —— 提示词里如实说明，不静默丢。 */
const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 隔离释放失败后的后台重试间隔（毫秒）。
 *
 * 只针对「目录删不掉」这一类**可重试**的失败（Windows 上子进程刚退出、
 * 文件仍被占用等）。刻意保留的情况（工作目录有未提交改动、分支还没并入
 * HEAD）不重试 —— 重试多少次都不会变好，只会白占定时器。
 */
const RELEASE_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * 释放隔离的结果。
 *
 * `retryable` 区分两类失败：**可重试**（磁盘层面的偶发失败，重试有意义）
 * 与**有意保留**（有未提交改动、分支未并入 HEAD —— 那是刻意的安全闸门，
 * 重试只是白跑）。
 */
type ReleaseOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

/** 残留清扫的结果（供宿主如实上报）。 */
export interface SuperSweepResult {
  /** 删掉的残留 worktree 数量。 */
  removed: number;
  /** 因各种原因保留的数量。 */
  kept: number;
  /** 疑似残留的目录（不在 git worktree 注册表里）—— 只记日志，不自动删。 */
  orphans: string[];
}

/** 跨历史会话的 Super Agent 残留计数（新建会话时的轻量检测）。 */
export interface SuperResidueCount {
  worktrees: number;
  dirs: number;
  attachments: number;
  total: number;
}

/** 「清空并新建」授权下的全量清空结果。 */
export interface SuperResiduePurgeResult {
  worktrees: number;
  dirs: number;
  attachments: number;
  /** 删除失败的目录数（best-effort：记日志继续，不阻断新建会话）。 */
  failed: number;
}

/**
 * 一条残留明细（批次2A 宿主侧聚合）。
 *
 * 只描述「磁盘上还在、但已中断/放弃/孤儿」的隔离产物，供看板逐条展示与一键
 * 处理；**不**在这里执行合并或删除 —— 丢弃必须等业务侧二次确认令牌，合并沿用
 * 现有的 merge-tree 预演与中间态检测纪律。
 */
export interface SuperResidueItem {
  /** 稳定标识：worktree = path，孤儿目录 = path，供 UI 回传定位。 */
  key: string;
  kind: "worktree" | "directory" | "attachment";
  path: string;
  branch?: string;
  /** 关联的子会话（能从隔离路径反查到时给出；孤儿为空）。 */
  sessionId?: string;
  title?: string;
  status?: SuperStatus;
  /** 分支上是否有未合并进当前 HEAD 的提交（git 不可用时保守为 true）。 */
  unmerged: boolean;
  /** 工作目录是否有未提交改动 —— 丢弃必须保护它。 */
  uncommitted: boolean;
  /** 主仓是否停在 merge/rebase/cherry-pick 中间态 —— 丢弃/合并都必须让路。 */
  inProgress: boolean;
}

/**
 * 「中断子会话」的结果。
 *
 * `ok` 的口径是「**意图是否达成**」，不是「宿主有没有真的动过手」：
 *  - `cancelled`：真的中断了一个在跑的子会话；
 *  - `already-terminal`：目标**已经是终态** —— 幂等重复，意图（「别再跑了」）
 *    已经达成，宿主什么都不用做。**不是**「未生效」；
 *  - `not-found`：目标根本不存在（可能已被清理）—— 这才是真的没生效。
 *
 * 把它单列出来，是因为「幂等重复」被报成「未生效」会让主会话以为动作失败，
 * 然后**重复发同一个动作**（真实故障：主会话 cancel 一个早已结束的子会话，
 * 看到「未生效」就又发一次）。
 */
export type SuperCancelOutcome =
  | { ok: true; reason: "cancelled"; status: SuperStatus }
  | { ok: true; reason: "already-terminal"; status: SuperStatus }
  | { ok: false; reason: "not-found" };

/** 扩展名 → MIME：复制来的图片除了落盘，也作为图片块直接给模型看。 */
const IMAGE_MIME_BY_EXT = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
]);
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

/** 子会话创建子 CLI 客户端的工厂。由宿主（panel）实现，复用主会话的
 * entry / node / 凭据解析，但把 cwd 与 allowedRoots 收窄到 worktree。 */
export type SuperClientFactory = (params: {
  cwd: string;
  allowedRoots: string[];
  /**
   * 传给 CLI 的 `--include-directories`（工作目录之外的额外可读写根）。
   *
   * 由管理器显式给出，不让宿主自己猜：CLI 侧的 `isPathWithinWorkspace` 与
   * 宿主侧的 `resolveAgentPath` 必须认同一组根，否则子会话能碰到的范围和
   * 宿主允许的范围会打架。主仓工作区档（合并子会话）尤其关键 —— 主仓根必须
   * 显式交给 CLI，否则它读不到主仓文件。
   */
  includeDirectories: string[];
  label: string;
  callbacks: AcpClientCallbacks;
}) => Promise<AcpClient>;

export interface SuperAgentDeps {
  /** 主仓根目录（worktree / 隔离目录的来源）；非 git 仓库时降级为目录隔离。 */
  repoRoot: string;
  createClient: SuperClientFactory;
  /**
   * MCP servers for a child's `session/new` (host broker endpoints).
   *
   * The broker owns ONE process per configured MCP server; each child gets a
   * loopback HTTP endpoint for it, so N concurrent children still mean a single
   * server process. The host also scopes the child's CLI process to exactly
   * these names (`--allowed-mcp-server-names`), which is what stops the child
   * from spawning the user's configured stdio servers itself.
   *
   * Optional so fixtures/tests that do not care about MCP keep working; an
   * absent dependency means "no MCP in child sessions" (the previous default).
   */
  childMcpServers?: () => McpServer[];
  /**
   * 子会话 `session/new` 的附加 settings（工具白名单，由宿主读配置后经
   * `buildChildSessionSettings` 算出）。管理器把它与审批策略的
   * `disallowed_tools` 合并；返回 `undefined` 或未产生任何键时不带 settings，
   * 缺省请求形状与接线前逐字节一致。可选是为了让既有 fixture 不必补齐。
   */
  childSessionSettings?: () => SessionSettings | undefined;
  /** 子会话列表变化（宿主写进 store.superSessions）。 */
  onSessionsChanged: (sessions: SuperSessionUi[]) => void;
  /**
   * 子会话的实时转录增量。`from` 是起始块索引，`blocks` 是从 `from` 到末尾
   * 的切片（webview 用 `[...已有.slice(0, from), ...blocks]` 合并）。
   *
   * 子会话跑在独立 CLI 进程里，转录**不能**进主 `blocks`（污染主转录、
   * 破坏 blockPatch 锚），所以走这条独立通道；节流由管理器负责。
   */
  onTranscript?: (sessionId: string, from: number, blocks: Block[]) => void;
  /**
   * 转录快照的落盘目录（扩展存储，不是仓库）。终态时子会话的转录在这里写
   * 一份旁路快照，重启恢复时由宿主读回；归档仍只存记录，两者互不污染。
   * 可选：单测 / fixture 不传就只保留内存转录（现有行为不变）。
   */
  superStoreDir?: () => string | null;
  /** 需要主会话知道的状态更新（宿主转成给主会话的提示词）。 */
  onReport: (entries: { session: SuperSessionUi; report: SuperReport }[]) => void;
  /**
   * 子会话**开始等你回答**（`needs_input` 让 `pending` 从空变有值）时触发一次。
   *
   * 只通知、不改行为：宿主据此弹系统通知（与主会话的提问卡同一档）。同一个
   * pending 的重复 apply、恢复出来的历史子会话都不会再触发 —— 用户只需要被
   * 打扰一次。可选是为了让单测与 fixture 不必逐个补齐。
   */
  onNeedInput?: (session: SuperSessionUi) => void;
  /**
   * 自动集成没能把改动带回主分支（改动与本地未提交改动重叠 / 预演冲突 /
   * git 拒绝合并等），但分支里确实有提交 —— 宿主据此**自动**派出一个合并
   * 子会话（repo 档，跑在主仓工作区里执行 `git merge --no-ff`），而不是把
   * 按钮留给用户自己点。
   *
   * `reason` 是宿主如实记下的原因（会写进合并任务书，让执行者知道背景）。
   * 只有 merge 模式会触发：pr 模式的语义是开 PR，manual 模式压根不做集成。
   */
  onNeedAgentMerge?: (session: SuperSessionUi, reason: string) => void;
  /**
   * 合并子会话跑完后的结果（宿主据此如实 toast）。
   *
   * `merged` = 只读 git 检测确认目标分支已并入当前分支；false = 合并没成，
   * 分支仍保留。宿主拿到的是**检测结果**，不是子会话的自述 —— 子会话可能只
   * 做了一半，或者把改动合到了别的地方。
   */
  onMergeResult?: (info: {
    /** 来源子会话（被合并的那个）的 id。 */
    sourceId: string;
    /** 来源子会话的标题（给人看的）。 */
    title: string;
    /** 被合并的分支名。 */
    branch: string;
    /** 分支是否真的并入了当前分支。 */
    merged: boolean;
    /** 合并子会话本身是否失败 / 被中断。 */
    failed: boolean;
    /** 人话说明。 */
    detail: string;
  }) => void;
  /** 子会话使用的模型；跟随主会话当前模型，null = 用 CLI 的默认值。 */
  currentModel: () => string | null;
  /**
   * 方案D：子会话 `session/set_model` 成功后，把用户显式覆盖的上下文窗口同步
   * 进子 CLI 缓存的 tokensLimit（set_model 只改名、不重算）。宿主按 modelId
   * 解析窗口（只推 source === "user"）并串行 await 推送，保证子会话首轮 prompt
   * 不会带着旧模型的压缩阈值跑。可选：不关心的 fixture / 单测无需补齐。
   */
  setTokensLimit?: (client: AcpClient, sessionId: string, modelId: string) => Promise<void>;
  /**
   * 当前主会话 id —— 派发出来的子会话归属它。
   *
   * 子会话是主会话的产物：主会话 A 派发的子会话不能在主会话 B 的看板上出现
   * （分支、汇报、重试都归 A 所有），重启恢复历史会话时也靠它把归档取回来。
   */
  currentMainSessionId: () => string | null;
  /** 模型单价（USD / 百万 token）；null = 无单价记录，不显示成本。 */
  priceFor?: (modelId: string | null) => { input: number; output: number } | null;
  /** 完成后如何把分支带回主工作区（`iflow.superAgent.integration`，每次实时读）。 */
  integrationMode: () => SuperIntegrationMode;
  /**
   * 同时运行的子会话上限（`iflow.superAgent.maxConcurrent`，每次实时读）。
   * 实时读而不是构造时快照：设置页改完要立刻影响下一次 pump，且调高上限后
   * 排队中的派发不必等重启面板。
   */
  maxConcurrentSessions: () => number;
  /**
   * 子会话的**总尝试次数上限**（含首次执行），来自
   * `iflow.superAgent.maxAttempts`（缺省 {@link DEFAULT_SUPER_MAX_ATTEMPTS}
   * = 2，范围 1–5）。
   *
   * 可选只是为了让单测与 fixture 不必逐个补齐；**缺省不是「不限」**：所有
   * 重试 / 重派路径（手动 retry、批量 retryWave / retryFailed、retryable
   * 失败的自动重试）都读同一个上限，缺省值统一走
   * {@link DEFAULT_SUPER_MAX_ATTEMPTS}。spawn 时把当时的值写进
   * `session.maxAttempts`，因此设置改完对**下一个启动**的子会话生效
   * （与设置项文案一致）。
   */
  maxAttempts?: () => number;
  /**
   * 上游失败时对下游任务的处理策略，来自 `iflow.superAgent.dependencyPolicy`。
   * `block`（默认）= 跳过下游并标记 blocked；`continue` = 照常执行。
   */
  dependencyPolicy?: () => "block" | "continue";
  /**
   * 完全信任模式（`iflow.superAgent.fullTrust`，每次实时读）。开启后子会话
   * 直接在主仓工作区运行（不建 worktree）、不收窄工具与 MCP，且任务书允许
   * push / 开 PR / 合并。缺省 undefined 即 false —— 既有行为逐字节不变。
   */
  fullTrust?: () => boolean;
  /**
   * 是否保留正常完成子会话的工作目录（`iflow.superAgent.keepWorktree`，
   * 每次实时读）。
   *
   * 默认 false = 完成即回收目录、**保留分支**（失败/中断从不回收，重试要复用
   * 现场）。可选是为了让单测与 fixture 不必逐个补齐。
   */
  keepWorktree?: () => boolean;
  /**
   * 效率开关档位（`iflow.efficiencyMode`，每次实时读）。`turbo` 时子会话任务书
   * 会前置同一段速推规则，与主会话同档；缺省/`steady` 时任务书逐字节不变。
   * 可选是为了让单测与 fixture 不必逐个补齐。
   */
  efficiencyMode?: () => "steady" | "turbo";
  /**
   * 磁盘上最多保留多少个已结束子会话的工作目录
   * （`iflow.superAgent.maxWorktrees`，每次实时读；0 = 不限制）。
   */
  maxWorktrees?: () => number;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

interface PendingResolver {
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout | null;
  /** 这个 resolver（及其定时器）属于哪一次 `needs_input`；与 session.pending.requestId 比对。 */
  requestId: string;
}

/**
 * One child session's transcript buffer.
 *
 * The state is a full `SessionState` only so the SAME reducer the main
 * transcript uses (`applySessionUpdate`) can be reused — the detail pane then
 * renders tool cards / thoughts / plans / sub-agent cards with identical
 * semantics instead of a second, drifting mini-reducer.
 */
interface SuperTranscript {
  state: SessionState;
  /** Lowest block index mutated since the last push (null = nothing new). */
  dirtyFrom: number | null;
}

/** 重试时带给 `prepare` 的上一轮上下文。 */
interface SuperRetryState {
  /** 本次执行的序号（2 = 第一次重试）。 */
  attempt: number;
  /** 上一次中断的原因。 */
  error?: string;
  /** 上一次留下的进展摘要。 */
  summary?: string;
  /** 优先复用上一次的隔离目录（worktree 里可能有未提交的工作）。 */
  reuseIsolation: boolean;
}

interface SuperQueueEntry {
  spec: SuperTaskSpec;
  id: string;
  /** 仅重试时存在。 */
  retry?: SuperRetryState;
  /** 审批策略（spawn 时归一化；重试沿用上一轮的那份）。 */
  policy: ResolvedSuperSpawnPolicy;
  /** 运行组 id（一次委派块 = 一个运行组），用于波次依赖解析。 */
  runId?: string;
  /** 所属波次（0 基）。 */
  wave?: number;
}

export class SuperAgentManager {
  private readonly sessions = new Map<string, SuperSessionUi>();
  private readonly clients = new Map<string, AcpClient>();
  /**
   * 每个子会话的审批策略。
   *
   * 队列项里也带一份（`SuperQueueEntry.policy`）供 `prepare` 使用；这张表是
   * **重试**的依据 —— 重试时只拿得到会话记录，拿不到原始的 spawn 参数。
   */
  private readonly policies = new Map<string, ResolvedSuperSpawnPolicy>();
  private readonly resolvers = new Map<string, PendingResolver>();
  /**
   * 从磁盘恢复回来的历史子会话，按**归属主会话**分组。
   *
   * 与 `sessions` 分开存：这些子会话的 CLI 进程早随扩展宿主退出了，没有
   * 客户端、没有实时转录、也不能重试 —— 只是「那次运行发生过什么」的记录。
   * 分开放是为了让重试/中断这些**进程级**操作天然找不到它们（不会去 kill
   * 一个不存在的会话）。
   *
   * 按主会话分组而不是一个总表：归档是按主会话分文件的，落盘时要能逐个会话
   * 取出来写回 —— 一个总表会让「写 A 的归档」顺手抹掉 B 的记录。
   */
  private readonly archived = new Map<string, SuperSessionUi[]>();
  /**
   * 曾经派发过子会话的主会话 id —— 归档按它分文件。
   *
   * 记的是「历史全集」而不是「现在还有子会话的」：子会话被清理掉之后，那个
   * 会话的归档要写成空数组，否则磁盘上留着旧记录，下次恢复又冒出已经清理
   * 掉的子会话。
   */
  private readonly archiveOwners = new Set<string>();
  /** 每个子会话的助手文本 —— 汇报摘要与输出 token 估算的来源。 */
  private readonly lastText = new Map<string, string>();
  /** 每个子会话的思考文本 —— 只用于输出 token 估算（思考也算生成开销）。 */
  private readonly lastThought = new Map<string, string>();
  /**
   * 被用户中断的子会话 → 中断发生时的**尝试序号**。
   *
   * 为什么不能只看会话状态：终态是粘性的，「完成」也是终态，而收尾代码
   * （代提交 + 自动合并）恰恰跑在「完成」事件**之后** —— 那时状态已经是
   * completed。所以「是不是终态」根本区分不出「正常做完」与「用户喊停」。
   * 这里记的是**用户喊停这件事本身**。
   *
   * 值是尝试序号：重试会让序号 +1，于是上一轮的标记自然不再命中新一轮。
   */
  private readonly interrupted = new Map<string, number>();
  /** 交给子会话的任务提示 token 估算 —— 内核没上报输入时的兜底下界。 */
  private readonly promptTokens = new Map<string, number>();
  /** 实时进度的节流定时器（每个子会话最多一个在飞）。 */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 子会话卡死看门狗的最近进展时刻与归属尝试序号（SA-1）。
   * 收到任意 session/update 即刷新 lastProgressAt；attempt 用于防止重试后
   * 旧一轮的定时器误杀新尝试。
   */
  private readonly watchdogs = new Map<string, {
    lastProgressAt: number;
    /** 最近一次收到真实 session/update 的时刻（活性采集，心跳可读）。 */
    lastActivityAt: number;
    attempt: number;
    /** 当前阶段：准备 / 运行，决定静默阈值。 */
    phase: SuperWatchdogPhase;
  }>();
  /** 看门狗定时器（每个子会话最多一个在飞，unref，不阻塞宿主退出）。 */
  private readonly watchdogTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 活性诊断的节流戳：同一子会话在 {@link SUPER_ACTIVITY_DIAG_THROTTLE_MS} 窗口内
   * 只追加一条活动诊断，避免流式每帧都写。
   */
  private readonly lastActivityDiagAt = new Map<string, number>();
  /** 每个子会话的实时转录缓冲（详情看板的数据源）。 */
  private readonly transcripts = new Map<string, SuperTranscript>();
  /** 转录推送的节流定时器（流式块高频到达，合并成一次消息）。 */
  private transcriptTimer: NodeJS.Timeout | null = null;
  /** 超过并发上限时排队的派发请求（重试项额外带上上一轮的中断信息）。 */
  private readonly queue: SuperQueueEntry[] = [];
  /** 已开始准备（真正占用了并发槽位）的子会话 id。 */
  private readonly started = new Set<string>();
  /**
   * 合并子会话 → 它要合并的目标。
   *
   * 只有 repo 档的合并子会话会进这张表：它们没有自己的分支，合并结束后由
   * 宿主用只读 git 检测目标分支是否并入了当前分支，再把结果写回**来源**
   * 子会话的 integration。
   */
  private readonly mergeTargets = new Map<
    string,
    { sourceId: string; branch: string; title: string }
  >();
  /**
   * 集成结果的**模型面向**原因（英文）。
   *
   * `SuperIntegration.detail` 是看板给用户看的中文说明，不能直接进英文的
   * 汇报提示词与合并任务书 —— 中途翻语言会让模型读着别扭（与
   * `shared/super-agent.ts` 里中文标签 / 英文标签并存的同一纪律）。
   *
   * 所以这里另存一份英文事实描述：与 `detail` 一一对应，由写 `detail` 的
   * 同一个调用点同时给出（见 {@link recordIntegration}）。
   */
  private readonly integrationReasonEn = new Map<string, string>();
  /** 集成（自动合并 / PR）的串行链 —— 并发合并同一个工作区会把仓库搅乱。 */
  private integrationChain: Promise<void> = Promise.resolve();
  /**
   * 首轮 prompt 前等待 MCP 工具就绪的上限 / 轮询间隔。
   *
   * 公开且非常量，测试注入极小值（如 40ms / 5ms）即可确定性地验证超时降级
   * 路径，而不必真的等满 {@link SUPER_MCP_READY_TIMEOUT_MS}。生产路径永不改写。
   */
  mcpReadyTimeoutMs = SUPER_MCP_READY_TIMEOUT_MS;
  mcpReadyPollMs = SUPER_MCP_READY_POLL_MS;
  /**
   * 运行档（收到 started 之后）的卡死看门狗无进展阈值。公开且非常量，测试注入
   * 极小值即可确定性验证超时路径；生产路径永不改写。默认
   * {@link SUPER_STALL_WATCHDOG_RUNNING_MS}，足够保守，只作用于子会话 —— 主会话
   * prompt 刻意无限等待（见 AGENTS.md 陷阱 #13）。
   */
  stallTimeoutMs = SUPER_STALL_WATCHDOG_RUNNING_MS;
  /**
   * 准备档（spawn → started 之前）的卡死看门狗无进展阈值。这一阶段没有 SSE 帧
   * 可刷新活性，内核握手 / MCP 就绪卡住时比在途 prompt 更容易发现，因此阈值更短。
   * 同样可由测试注入极小值；生产路径永不改写。
   */
  prepareStallTimeoutMs = SUPER_STALL_WATCHDOG_PREPARE_MS;
  /**
   * 「分支上没有任何独有提交」的隔离，等子进程退出后再释放。
   *
   * 目录删除必须等 CLI 进程先走：Windows 上进程的 cwd 还停在 worktree 里时，
   * 目录删不掉（会留下半删的目录）。所以集成阶段只登记，释放动作由
   * `prepare()` 的 finally 在回收进程之后执行。
   */
  private readonly pendingEmptyRelease = new Set<string>();
  /** 隔离释放失败后的后台重试定时器（每个子会话最多一个在飞）。 */
  private readonly releaseRetryTimers = new Map<string, NodeJS.Timeout>();
  /** 每个子会话已安排过的释放重试次数（用来限制重试轮数）。 */
  private readonly releaseRetryAttempts = new Map<string, number>();
  /**
   * 波次依赖索引：`${runId}\u0000${taskKey}` → sessionId。
   * `dependsOn` 引用的是任务标识（id 或 title），而 session.id 是宿主生成的，
   * 派发时把两者登记进来，pump 才能把依赖解析成具体的上游会话。
   */
  private readonly waveTaskIndex = new Map<string, string>();
  /**
   * retryable 失败自动重试的退避定时器（每个子会话最多一个在飞，unref）。
   * 只在尝试上限 > 1 时安排（上限统一读同一个值，见 {@link maybeAutoRetry}）。
   */
  private readonly autoRetryTimers = new Map<string, NodeJS.Timeout>();
  /**
   * **重试重入锁**：正在被重试的子会话 id。
   *
   * 所有重试路径（手动 retry、批量 retryWave / retryFailed、retryable 失败
   * 的自动重试）都汇到 {@link SuperAgentManager.retry} 一个入口，而该方法
   * 在第一个 await 之前不做任何状态变更 —— 没有这把锁，两条路径撞在一起
   * 时会各自把同一条 id 塞进队列、把子会话跑两遍（每次重跑都是一整个子会话
   * 会话的全部 token），而 attempt 计数只 +1（上限形同虚设）。
   */
  private readonly retrying = new Set<string>();
  /** 自动重试退避窗口（实例字段，测试注入极小值）。 */
  autoRetryBackoffMs = SUPER_AUTO_RETRY_BACKOFF_MS;
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: SuperAgentDeps) {}

  // --- 对外 API -------------------------------------------------------------

  /**
   * 看板投影：活着的子会话 + 当前主会话的历史子会话。
   *
   * **活着的子会话一律可见**（不分主会话）：它们是正在跑的进程，用户必须
   * 能看到并随时中断 —— 按主会话藏起来会让子会话跑到天荒地老也没人管。
   *
   * **历史子会话按主会话归属**：主会话 A 当年派发的子会话属于 A 的那段对话，
   * 恢复 A 时才回到看板上；恢复 B 时它们不会串到 B 面前。不传 `mainSessionId`
   * 时不含历史子会话（汇总门槛等「只关心活着的」的场合用）。
   */
  list(mainSessionId?: string | null): SuperSessionUi[] {
    const live = [...this.sessions.values()];
    const history = mainSessionId ? this.archived.get(mainSessionId) ?? [] : [];
    // 这是**看板投影**，不是记录本身：`superSessions` 属于非 blocks 元数据，
    // 随每次 snapshot / blockPatch 整份重发，而 webview 从不渲染 `task`。
    // 投影里只带预览（见 `toSuperBoardSession`）；完整任务书仍在本管理器的
    // 记录里（重试 / PR 正文 / 归档都读那边）。
    return [...live, ...history]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toSuperBoardSession);
  }

  get(id: string): SuperSessionUi | undefined {
    return this.sessions.get(id) ?? this.findArchived(id);
  }

  /**
   * 找到一条子会话记录（活着的或历史恢复的）。
   *
   * 历史子会话的进程早就没了，但它们的**分支与工作目录还在磁盘上** —— 所以
   * 「让智能体合并」「清理工作目录」这些针对磁盘事实的操作对它们同样有效。
   */
  private findArchived(id: string): SuperSessionUi | undefined {
    for (const records of this.archived.values()) {
      const found = records.find((s) => s.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** 移除一条子会话记录（活着的或历史恢复的）。 */
  private removeSession(id: string): void {
    this.sessions.delete(id);
    for (const [owner, records] of this.archived) {
      const next = records.filter((s) => s.id !== id);
      if (next.length !== records.length) this.archived.set(owner, next);
    }
  }

  /**
   * 采纳从磁盘恢复的历史子会话（重启后恢复主会话时调用）。
   *
   * 这些记录**不是**活着的子会话：它们的 CLI 进程早已随扩展宿主退出。所以
   * 它们不进 `sessions`（进程级操作——重试/中断——找不到它们），只进
   * `archived`，看板照样能看见、照样能清理工作目录或让智能体合并分支。
   */
  restoreSessions(mainSessionId: string, records: SuperSessionUi[]): void {
    this.archived.set(mainSessionId, records);
    this.archiveOwners.add(mainSessionId);
    this.emit();
  }

  /**
   * 需要归档的主会话 id 集合 —— 落盘时逐个写归档。
   *
   * 按**归属**逐个写，而不是只写「当前主会话」：子会话是异步跑的，用户随时
   * 可能切到别的会话去 —— 只写当前会话会把别人的归档覆盖成空。
   *
   * 这个集合是**曾经有过子会话**的会话全集，而不是「现在还有子会话」的：
   * 子会话被清理掉之后，那个会话的归档必须被写成空数组（否则磁盘上留着旧
   * 记录，恢复时又冒出已经清理掉的子会话）。
   */
  archivableMainSessionIds(): string[] {
    return [...this.archiveOwners];
  }

  /**
   * 某个主会话名下所有子会话（活着的 + 历史的）—— 落盘时用。
   *
   * 归档的是**记录**，不是运行态：活着的子会话剥掉运行期字段（待应答、实时
   * 进度、已死的 cliSessionId），历史子会话本来就是记录，原样落盘。
   */
  archivableSessions(mainSessionId: string): PersistedSuperSession[] {
    const out: PersistedSuperSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.mainSessionId !== mainSessionId) continue;
      out.push(toPersistedSuperSession(session));
    }
    for (const session of this.archived.get(mainSessionId) ?? []) {
      out.push(toPersistedSuperSession(session));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 某个子会话的完整转录（详情首次打开 / webview 重同步时拉取）。 */
  transcriptBlocks(id: string): Block[] {
    return this.transcripts.get(id)?.state.blocks.slice() ?? [];
  }

  /** 全部子会话的转录快照（webview 重启后 `ready` 时重推）。 */
  transcriptEntries(): { sessionId: string; blocks: Block[] }[] {
    const entries: { sessionId: string; blocks: Block[] }[] = [];
    for (const [sessionId, entry] of this.transcripts) {
      entries.push({ sessionId, blocks: entry.state.blocks.slice() });
    }
    return entries;
  }

  /**
   * 采纳从磁盘读回的终态转录快照（重启恢复时由宿主填入）。
   *
   * 只进 `transcripts` Map 供详情面板展示：不进 `sessions` / `archived`、
   * 不产生任何进程操作 —— 恢复出来的转录是**纯展示数据**，绝不能让历史
   * 子会话变得可重试。快照是宿主侧 `evictBlockPayloads` 已裁剪的窗口，超长
   * 子会话的旧载荷不可恢复（块上的 `evicted` 标记如实呈现）。
   */
  restoreTranscripts(entries: { sessionId: string; blocks: Block[] }[]): void {
    for (const { sessionId, blocks } of entries) {
      this.transcripts.set(sessionId, {
        state: { ...initialSessionState(), blocks },
        dirtyFrom: null,
      });
    }
  }

  /**
   * 派发一个子会话。立即返回记录（status = preparing），准备工作异步进行 ——
   * 委派指令一次可能带多个任务，调用方不该被 worktree 创建 + CLI 握手阻塞。
   *
   * 超过并发上限时请求进 FIFO 排队，槽位一空就自动开跑（「随时开启」）。
   *
   * `options.isolation = "repo"` 派的是**主仓工作区档**子会话：它没有
   * worktree、没有自己的分支，直接在主仓根目录里干活（合并子会话专用 ——
   * 合并只能在目标分支所在的工作区发生）。
   *
   * `options.policy` 是可选审批策略：**缺省即 `{ approval: "auto" }`**，与既有
   * 调用点（面板派发 / 合并子会话）的行为逐字节一致。
   */
  spawn(
    spec: SuperTaskSpec,
    options?: {
      isolation?: "repo";
      policy?: SuperSpawnPolicy | null;
      runId?: string;
      wave?: number;
    },
  ): SuperSessionUi {
    const now = Date.now();
    const id = `super-${now.toString(36)}-${(this.seq++).toString(36)}`;
    const repoIsolation = options?.isolation === "repo";
    const fullTrust = !repoIsolation && (this.deps.fullTrust?.() ?? false);
    const policy = resolveSpawnPolicy({ policy: options?.policy ?? null });
    const runId = options?.runId;
    const wave = options?.wave ?? 0;
    const session: SuperSessionUi = {
      id,
      title: spec.title,
      task: spec.task,
      status: "preparing",
      queued: true,
      attempts: 1,
      // 完全信任：直接落在主仓工作区档（与合并子会话同档，但带 fullTrust
      // 标记走另一套任务书契约），看板从派发那一刻就显示「完全信任」。
      isolation:
        repoIsolation || fullTrust
          ? {
              kind: "repo",
              path: this.deps.repoRoot,
              ...(fullTrust ? { fullTrust: true, note: "完全信任（主仓工作区）" } : {}),
            }
          : { kind: "directory", path: "", note: "正在准备隔离环境" },
      // 归属主会话：归档按它分文件，恢复历史会话时按它取回。
      mainSessionId: this.deps.currentMainSessionId() ?? undefined,
      createdAt: now,
      updatedAt: now,
      reports: [],
      // 波次依赖调度元数据（缺省 wave 0 / 无依赖 / 无上限 = 既有平铺行为）。
      ...(runId ? { runId } : {}),
      wave,
      ...(spec.dependsOn && spec.dependsOn.length > 0 ? { dependsOn: [...spec.dependsOn] } : {}),
      ...(spec.batch !== undefined ? { batch: spec.batch } : {}),
      // 尝试上限在**派发时**定格：设置改完对下一个启动的子会话生效（与设置项
      // 文案一致）。取值走夹取，脏值（NaN / 越界）落到统一的缺省常量，绝不
      // 出现「声明 2、运行时 0」这种分裂。
      ...(this.deps.maxAttempts
        ? { maxAttempts: clampSuperMaxAttempts(this.deps.maxAttempts()) }
        : {}),
    };
    this.sessions.set(id, session);
    this.policies.set(id, policy);
    if (session.mainSessionId) this.archiveOwners.add(session.mainSessionId);
    // 登记任务标识 → 会话 id：dependsOn 用 id/title 引用上游，pump 据此解析。
    if (runId) {
      const key = spec.id?.trim() || spec.title.trim();
      if (key) this.waveTaskIndex.set(`${runId}\u0000${key}`, id);
    }
    this.recordDiagnostic(id, "spawn", "info", `已派发「${spec.title}」（runId=${runId ?? "-"} / wave ${wave}）`, now);
    this.queue.push({ spec, id, policy, runId, wave });
    this.emit();
    this.pump();
    return session;
  }

  /**
   * 派一个**合并子会话**（repo 档）。
   *
   * 合并子会话跑在**主仓工作区**里执行 `git merge --no-ff` —— 合并只能发生
   * 在目标分支所在的工作区，在别的 worktree 里 merge 等于白做（合并出来的
   * 提交不会落到主仓当前分支上）。它没有自己的分支：产出就是主仓当前分支上
   * 的那个合并提交，因此它不会进入「完成后自动合并它的分支」那条流程。
   *
   * 合并结束后由宿主用**只读** git 检测（`git merge-base --is-ancestor`）
   * 判断目标分支是否真的并入了当前分支，再把结果写进**来源**子会话的
   * integration —— 检测不出来就如实记「分支仍保留」，绝不谎报成功。
   *
   * 返回 null 表示现在派不了：来源子会话没有自己的分支（没有可合并的目标），
   * 或已有一个合并子会话在跑 —— 主仓工作区没有版本隔离，同一时刻只能有一个。
   */
  async spawnMerge(options: {
    /** 来源子会话（提供分支与归属；集成结果写回它）。 */
    source: SuperSessionUi;
    /** 合并任务书（`buildSuperMergeRequestPrompt` 的产物）。 */
    task: string;
    /** 看板标题（如「合并分支 iflow/super/x」）。 */
    title: string;
  }): Promise<SuperSessionUi | null> {
    const branch = options.source.isolation.branch;
    if (!branch) {
      this.deps.log.warn("super agent: 来源超流体没有分支，无法派合并超流体");
      return null;
    }
    if (this.repoMergeRunning()) {
      this.deps.log.warn("super agent: 已有一个合并超流体在跑（主仓工作区无版本隔离），本次不派发");
      return null;
    }
    const child = this.spawn(
      { title: options.title, task: options.task },
      { isolation: "repo", policy: superMergeChildPolicy() },
    );
    this.mergeTargets.set(child.id, {
      sourceId: options.source.id,
      branch,
      title: options.source.title,
    });
    this.deps.log.info(`super agent: 派出合并超流体 ${child.id}（合并 ${branch}）`);
    return child;
  }

  /**
   * 是否已有一个**真合并子会话**在跑（主仓工作区没有版本隔离）。
   *
   * 判据是合并目标表（`spawnMerge` 登记、`finalizeMergeChild` / 清理时删除）
   * 而不是 `isolation.kind === "repo"`：完全信任子会话也跑在主仓工作区，
   * 把它算成合并子会话会让真正的合并请求被拒派（队列永久卡住）。
   */
  private repoMergeRunning(): boolean {
    return this.hasRunningMergeChild();
  }

  /**
   * 是否真有合并子会话在跑（只认 `spawnMerge` 派出、尚未收尾的那一个）。
   *
   * 宿主用它在汇报 / 回执 / 委派轮的 drain 上做互斥：只有合并子会话在主仓
   * 工作区跑 git 时才需要让主会话避让。完全信任子会话不占这条车道 ——
   * 否则它的存在会挡住主会话的汇报（真实故障：汇报轮永远投不出去）。
   */
  hasRunningMergeChild(): boolean {
    for (const id of this.mergeTargets.keys()) {
      const session = this.sessions.get(id);
      if (session && !isTerminalSuperStatus(session.status)) return true;
    }
    return false;
  }

  /**
   * 中断一个子会话（终止其 CLI 进程与当前轮次）。
   *
   * 返回**区分后的结果**：对一个**已经是终态**的子会话再发一次 cancel 是幂等
   * 重复 —— 意图（「别再跑了」）已经达成，宿主什么都不用做。这**不是**「未生效」：
   * 报成未生效会让主会话以为动作失败，然后**重复发同一个动作**（真实故障：
   * cancel 了一个早已结束的子会话，主会话看不到生效，于是又发一次）。
   * 只有「目标根本不存在」才是真的没生效。
   */
  async cancel(id: string, source: SuperInterruptSource = "system"): Promise<SuperCancelOutcome> {
    const session = this.sessions.get(id);
    if (!session) {
      // 历史归档子会话的进程早随扩展退出，中断意图天然达成（幂等）—— 按
      // already-terminal 回报，不报 not-found。主会话从上一轮冻结的看板
      // 抄 id 时，抄到这类「已结束」记录不该被误判成「抄错 id」。
      const archived = this.findArchived(id);
      if (archived) return { ok: true, reason: "already-terminal", status: archived.status };
      return { ok: false, reason: "not-found" };
    }
    if (isTerminalSuperStatus(session.status)) {
      // 幂等重复：目标已经不在跑 —— 意图已达成，如实说成「已终态」，不是失败。
      return { ok: true, reason: "already-terminal", status: session.status };
    }
    // 还在排队的话先撤掉 —— 否则槽位空出后 pump 会把它启动起来。
    this.dequeue(id);
    // 用户喊停优先于任何在飞的失败自动重试。
    const retryTimer = this.autoRetryTimers.get(id);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.autoRetryTimers.delete(id);
    }
    // 提问定时器随中断一起收口：会话已终态，不该再有到点的定时器去 resolve
    // 一个早被丢弃的提问（更不该误删此处之后新尝试的 resolver）。
    this.discardQuestionResolver(id);
    // 先记「这一轮被用户喊停」：收尾路径（代提交 + 自动合并）靠它决定
    // 还能不能动这轮的结果。必须落在 apply 之前 —— apply 之后状态已是终态，
    // 再也分不清「正常完成」与「被中断」。
    this.interrupted.set(id, session.attempts ?? 1);
    // 先落「已中断」再杀进程：终止进程会触发 AcpClient 的 onExit，而管理层把
    // 内核退出一律记成 failed —— 终态粘性会让随后的 cancelled 被丢弃，手动
    // 停止就显示成失败。先把终态占住，onExit 的失败事件会被幂等地忽略。
    this.apply(id, { type: "cancelled", at: Date.now(), source });
    // 已被用户喊停：清掉看门狗，避免进程回收前的迟到定时器把 cancelled 误判成超时。
    this.clearWatchdog(id);
    const client = this.clients.get(id);
    if (client && session.cliSessionId) {
      try {
        client.cancel(session.cliSessionId);
      } catch {
        // 进程可能已经死了 —— 下面的 dispose 会兜住。
      }
    }
    await this.disposeClient(id);
    // 排队中就被中断的合并子会话不会走到 prepare 的收尾（它根本没启动）——
    // 这里补一次判定，否则来源子会话的 integration 会永远停在旧状态。
    if (!session.cliSessionId) await this.finalizeMergeChild(id);
    this.notifyReport(id);
    return { ok: true, reason: "cancelled", status: "cancelled" };
  }

  /** 中断全部子会话，返回被中断的数量。 */
  async cancelAll(source: SuperInterruptSource = "system"): Promise<number> {
    const ids = [...this.sessions.values()]
      .filter((s) => !isTerminalSuperStatus(s.status))
      .map((s) => s.id);
    for (const id of ids) await this.cancel(id, source);
    return ids.length;
  }

  /**
   * 主会话被删除：终止并清掉它名下的全部子会话与归档记录。
   *
   * 删除会话意味着「这段对话不存在了」：它派发的子会话进程不能继续跑（跑完
   * 也没人接汇报），排队中的派发要撤掉，看板记录与归档归属必须一起消失 ——
   * 否则下一次落盘会把这个主会话重新写回归档文件（文件复活），而活着的子
   * 进程会让宿主的心跳永远停不下来。
   *
   * **worktree 与分支保留**：里面可能有还没合并的工作，与 `dispose()` 同
   * 纪律 —— 删目录不可逆，绝不借「删会话」偷偷丢改动。保留的目录仍由
   * `sweepStaleWorktrees` 按既有规则（只清已并入 HEAD 且干净的）回收；返回
   * 清单供宿主如实记日志。
   *
   * 返回被清掉的子会话 id（宿主据此清掉属于它们的待办队列）。
   */
  async forgetMainSession(
    mainSessionId: string,
  ): Promise<{ ids: string[]; worktrees: { id: string; path: string; branch?: string }[] }> {
    const ids: string[] = [];
    const worktrees: { id: string; path: string; branch?: string }[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.mainSessionId !== mainSessionId) continue;
      const id = session.id;
      ids.push(id);
      // 排队中的先撤掉，否则槽位一空 pump 还会把它拉起来。
      this.dequeue(id);
      this.started.delete(id);
      if (!isTerminalSuperStatus(session.status)) {
        // 先落「已中断」再杀进程：dispose 会触发 onExit，管理层把它记成
        // failed；终态粘性会让随后的 cancelled 被丢弃。
        this.interrupted.set(id, session.attempts ?? 1);
        this.apply(id, { type: "cancelled", at: Date.now(), source: "system" });
      }
      await this.disposeClient(id);
      // 附件副本是这个子会话的临时拷贝：记录都没了，它只剩占盘。
      await rm(this.attachmentDirFor(id), { recursive: true, force: true }).catch(() => undefined);
      if (
        session.isolation.path &&
        !session.isolation.released &&
        session.isolation.kind !== "repo"
      ) {
        worktrees.push({ id, path: session.isolation.path, branch: session.isolation.branch });
      }
      // 提问定时器随会话删除一起收口（统一走 discardQuestionResolver）。
      this.discardQuestionResolver(id);
      this.forgetChild(id);
      this.transcripts.delete(id);
      this.policies.delete(id);
      this.mergeTargets.delete(id);
      this.removeSession(id);
    }
    // 归档归属也要清：留着它，下一次 persistSuperSessions 会把空数组重新写回
    // 磁盘（会话已删，归档文件却复活）。
    //
    // 归档里的子会话**不在 this.sessions 里**，上面的循环碰不到它们：它们的
    // 进程早死了，但附件副本与 worktree 还在磁盘上。会话都被删了，这些东西
    // 再没有回收人 —— 一并删附件、把 worktree 交给宿主 force 清理（与活会话
    // 同纪律：清目录不可逆，但删主会话意味着「这段对话不存在了」）。
    for (const archived of this.archived.get(mainSessionId) ?? []) {
      await rm(this.attachmentDirFor(archived.id), { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (
        archived.isolation.path &&
        !archived.isolation.released &&
        archived.isolation.kind !== "repo"
      ) {
        worktrees.push({
          id: archived.id,
          path: archived.isolation.path,
          branch: archived.isolation.branch,
        });
      }
      this.discardQuestionResolver(archived.id);
      this.transcripts.delete(archived.id);
      this.discardTranscriptSnapshot(archived.id);
    }
    this.archived.delete(mainSessionId);
    this.archiveOwners.delete(mainSessionId);
    this.emit();
    return { ids, worktrees };
  }

  /**
   * 重试一个「意外中断」的子会话（`failed` / `cancelled`）。
   *
   * 复用同一个记录与隔离目录：worktree 里可能有中断前没提交的改动，重试的
   * 提示词会告诉新进程「上一轮中断了、先检查现状再继续」，而不是假装从零
   * 开始。目录已被删掉 / 从未建好时退化为新建隔离环境。返回 false 表示该
   * 子会话当前不可重试。
   *
   * **唯一入口**：手动重试、批量重试（retryWave / retryFailed）、retryable
   * 失败的自动重试全部走这里。因此尝试上限与 attempt 计数也只在这里维护
   * 一次 —— 两条路径各记一份就会把同一个任务跑两遍（每次重跑都是一整个
   * 子会话会话的全部 token）。
   */
  async retry(id: string): Promise<boolean> {
    if (this.disposed) return false;
    // **重入锁**：本方法在第一个 await 之前没有任何状态变更，而 await 之后
    // 才有 —— 不加锁的话，「自动重试的退避定时器到点」与「用户/主 Agent 手动
    // 重试」撞在一起时，两次调用都会读到 attempts=1、都通过上限检查、都把
    // 队列塞进同一条 id：子会话被**跑两遍**，而 attempt 只 +1（上限形同虚设）。
    // 锁覆盖整个方法体：第二次调用直接判定「已在重试中」。
    if (this.retrying.has(id)) {
      this.deps.log.info(`[${id}] 已有一次重试在进行，忽略重复的重试请求`);
      return false;
    }
    const session = this.sessions.get(id);
    if (!session || !canRetrySuperSession(session)) return false;
    // 尝试上限（含首次）：maxAttempts=2 表示最多两次；当前已是第 N 次且 N>=上限
    // 就不再重试。**缺省值统一**走 DEFAULT_SUPER_MAX_ATTEMPTS（= 设置项
    // `iflow.superAgent.maxAttempts` 的声明缺省）—— 各路径各读各的默认值
    // 会让同一个任务在不同路径上被判定成「已达上限」与「还没到上限」。
    const maxAttempts = clampSuperMaxAttempts(
      session.maxAttempts ?? this.deps.maxAttempts?.() ?? DEFAULT_SUPER_MAX_ATTEMPTS,
    );
    const attempts = session.attempts ?? 1;
    if (attempts >= maxAttempts) {
      this.deps.log.info(
        `[${id}] 已达最大尝试次数（${attempts}/${maxAttempts}），不再重试`,
      );
      return false;
    }

    // 手动 / 自动 retry 都先撤掉在飞的退避定时器，避免一次失败触发两次重试。
    const timer = this.autoRetryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.autoRetryTimers.delete(id);
    }

    this.retrying.add(id);
    try {
      // 上一轮的进程本该在终态时回收；这里再做一次防御性回收（幂等），并把
      // 它从并发槽位摘掉 —— 否则重置后的会话会把自己算成「已占用」而永远
      // 排在自己前面。
      await this.disposeClient(id);
      this.started.delete(id);
      // 上一轮看门狗随旧尝试收口：旧定时器若到点，attempt 守卫本就会放过新尝试，
      // 这里主动清掉省得它空转到点。
      this.clearWatchdog(id);
      // 上一轮若正卡在提问上，它的 resolver/定时器必须随旧尝试一起收口 ——
      // 否则旧定时器到点会误删新一轮刚挂上的 resolver（跨尝试串包）。
      this.discardQuestionResolver(id);
      // 重试是一次**新的尝试**（序号 +1）：上一轮的中断标记不该命中新一轮。
      this.interrupted.delete(id);

      const retry: SuperRetryState = {
        attempt: attempts + 1,
        error: session.error,
        summary: session.summary ?? (this.lastText.get(id)?.trim() || undefined),
        reuseIsolation: true,
      };
      const reset = retrySuperSession(session, Date.now());
      this.sessions.set(id, reset);
      // retry 诊断：审计里能看到「失败 → 重试 → 完成」的诊断轨迹（与 reports 同构）。
      this.recordDiagnostic(
        id,
        "retry",
        "info",
        `自动重试第 ${retry.attempt} 次（上次失败：${session.lastError?.message ?? session.error ?? "未知"}）`,
      );
      this.lastText.delete(id);
      this.queue.push({
        spec: {
          title: session.title,
          task: session.task,
          ...(session.dependsOn ? { dependsOn: [...session.dependsOn] } : {}),
          ...(session.batch !== undefined ? { batch: session.batch } : {}),
        },
        id,
        retry,
        runId: session.runId,
        wave: session.wave,
        // 重试是同一份派发的延续：策略必须沿用，否则一次重试会把 supervised
        // 静默退回 auto（重新变成无审批执行）。
        policy: this.policies.get(id) ?? resolveSpawnPolicy(null),
      });
      this.emit();
      this.pump();
      return true;
    } finally {
      // 重入锁只覆盖到「队列已入队 + 状态已重置」为止：此后子会话的状态是
      // preparing（非终态），canRetrySuperSession 会挡住第二次重试，不需要
      // 再靠锁兜底。
      this.retrying.delete(id);
    }
  }

  /**
   * 最近一个仍有会话的运行组 id（`superRetryWave` / `superRetryFailed` 的 runId
   * 缺省值）。取 updatedAt 最大者，即最近一次委派块，与消息契约「当前运行组」一致。
   */
  private latestRunId(): string | undefined {
    let latest: { runId: string; updatedAt: number } | undefined;
    for (const session of this.sessions.values()) {
      if (!session.runId) continue;
      if (!latest || session.updatedAt >= latest.updatedAt) {
        latest = { runId: session.runId, updatedAt: session.updatedAt };
      }
    }
    return latest?.runId;
  }

  /**
   * 批量重试某一波次（WebviewToHost `superRetryWave` 的宿主实现）。
   *
   * 圈定范围：runId 缺省为最近运行组；只取该波次里处于 failed / cancelled 的
   * 会话（下游被上游失败阻塞时也是 failed + lastError.kind="blocked"，因此会被
   * 正确纳入「波次重排」）。用户显式点重试 → 失败分类（blocked / interrupted）
   * 不再挡路，但**尝试上限仍按批次1A 的 shouldRetrySuperFailure 精确执行** ——
   * 这里借它的次数判定（kind 传 retryable），不放宽 maxAttempts。
   */
  async retryWave(options: { runId?: string; wave: number }): Promise<string[]> {
    const runId = options.runId ?? this.latestRunId();
    const ids = [...this.sessions.values()]
      .filter((s) => s.runId === runId && (s.wave ?? 0) === options.wave)
      .filter((s) => canRetrySuperSession(s))
      .filter((s) =>
        shouldRetrySuperFailure(
          "retryable",
          s.attempts ?? 1,
          clampSuperMaxAttempts(
            s.maxAttempts ?? this.deps.maxAttempts?.() ?? DEFAULT_SUPER_MAX_ATTEMPTS,
          ),
        ),
      )
      .map((s) => s.id);
    const retried: string[] = [];
    for (const id of ids) {
      if (await this.retry(id)) retried.push(id);
    }
    return retried;
  }

  /**
   * 重试当前运行组里所有失败任务（WebviewToHost `superRetryFailed` 的宿主实现）。
   * 与 {@link retryWave} 只差「不限波次」，同样守终态与 maxAttempts 上限。
   */
  async retryFailed(options: { runId?: string } = {}): Promise<string[]> {
    const runId = options.runId ?? this.latestRunId();
    const ids = [...this.sessions.values()]
      .filter((s) => s.runId === runId)
      .filter((s) => canRetrySuperSession(s))
      .filter((s) =>
        shouldRetrySuperFailure(
          "retryable",
          s.attempts ?? 1,
          clampSuperMaxAttempts(
            s.maxAttempts ?? this.deps.maxAttempts?.() ?? DEFAULT_SUPER_MAX_ATTEMPTS,
          ),
        ),
      )
      .map((s) => s.id);
    const retried: string[] = [];
    for (const id of ids) {
      if (await this.retry(id)) retried.push(id);
    }
    return retried;
  }

  /**
   * retryable 失败的自动重试决策：失败已在 apply() 里归一为 lastError.kind ===
   * "retryable"，这里用任务 A 的 canRetrySuperSession 决策函数复核终态，再核对
   * 尝试上限，满足则退避一个窗口后自动 retry。其余分类（terminal / blocked /
   * interrupted）直接上报、不自动重试。
   *
   * 上限与手动重试**读同一个值**（会话声明的 `maxAttempts` → 设置项 →
   * {@link DEFAULT_SUPER_MAX_ATTEMPTS} 缺省），不再各用一个「自动=1、手动=无限」
   * 的分裂缺省：分裂会让同一个任务在自动路径上被判「已达上限」、在手动路径上
   * 又被判「还能再来一次」，实际就是被多跑几轮。
   */
  private maybeAutoRetry(id: string): void {
    if (this.disposed) return;
    const session = this.sessions.get(id);
    if (!session || !canRetrySuperSession(session)) return;
    const maxAttempts = clampSuperMaxAttempts(
      session.maxAttempts ?? this.deps.maxAttempts?.() ?? DEFAULT_SUPER_MAX_ATTEMPTS,
    );
    // 批次1A 的确切决策签名：只有 retryable 且 attempts < maxAttempts 才自动重试。
    // terminal / blocked / interrupted 或已达上限一律不重试（NaN 等非法上限由纯函数
    // 内部的 `<` 自然退化为「不重试」）。
    if (
      !shouldRetrySuperFailure(
        session.lastError?.kind ?? "terminal",
        session.attempts ?? 1,
        maxAttempts,
      )
    ) return;
    if (this.autoRetryTimers.has(id)) return; // 退避已安排，避免重复
    const timer = setTimeout(() => {
      this.autoRetryTimers.delete(id);
      void this.retry(id);
    }, this.autoRetryBackoffMs);
    if (typeof timer.unref === "function") timer.unref();
    this.autoRetryTimers.set(id, timer);
  }

  /**
   * 清掉一个子会话的提问 resolver 与定时器（**跨尝试收口的唯一入口**）。
   *
   * resolver 与定时器按会话 id 只存一份，但一个会话可能经历「提问 → 失败 →
   * 重试 → 再提问」：上一轮的定时器若到点无条件 `delete(id)`，会删掉新一轮
   * 刚挂上的 resolver。所有清理入口（超时 / 应答 / 重试 / 清理 / 中断 / 面板
   * 关闭）统一走这里，且调用前必须先用 `requestId` 确认对象是自己的那一份。
   *
   * 刻意**不** resolve promise：retry / cancel / cleanup 时旧 CLI 进程即将被
   * 回收，若用空答案 resolve 它，那条在途的 `onUserQuestions` 会让旧内核继续
   * 往下跑，并通过同一个 id 的回调污染新一轮的状态。让它随旧客户端一起 GC。
   */
  private discardQuestionResolver(id: string): PendingResolver | undefined {
    const resolver = this.resolvers.get(id);
    if (!resolver) return undefined;
    if (resolver.timer) clearTimeout(resolver.timer);
    this.resolvers.delete(id);
    return resolver;
  }

  /**
   * 回答子会话的提问（`_iflow/user/questions`）。
   *
   * 子会话的审批不经过这里 —— 它们始终免确认，由宿主直接放行。返回 false 表示
   * 该子会话没有挂起的提问（已超时或已被回答）。
   */
  respond(id: string, answer: SuperAnswer): boolean {
    const session = this.sessions.get(id);
    const pending = session?.pending;
    const resolver = this.resolvers.get(id);
    if (!session || !pending || !resolver) return false;
    // 只认当前 pending 的那一份：旧尝试残留的 resolver 绝不能被新 pending
    // 的应答消费（反之亦然），否则一次应答会收口错轮的 promise。
    if (resolver.requestId !== pending.requestId) return false;

    this.discardQuestionResolver(id);
    resolver.resolve({ answers: answer.answers ?? {} });
    this.apply(id, { type: "input_resolved", at: Date.now() });
    return true;
  }

  /**
   * 清理一个子会话：移除 worktree（以及按策略处理分支）。
   *
   * **只在它已经停下来、且工作目录没有未提交改动时才动手**：
   *  - 非终态（准备中 / 运行中 / 等你处理）→ 拒绝，让调用方先中断 ——
   *    「清理」不是「中断」，删掉它正在用的目录等于当场毁掉它的工作；
   *  - worktree 里有未提交改动 → 拒绝，删目录不可逆。
   *
   * 两种情况都返回 `ok: false` 并带上原因，**不做任何状态变更**。
   *
   * `keepBranch` 为真时分支一定保留；否则当分支上还有未合并提交时也保留，
   * 并在返回值里说明原因（不静默吞掉用户可能需要的提交）。
   *
   * **历史子会话也适用**：它的进程早没了，但 worktree 与分支还在磁盘上 ——
   * 这正是「重启后把上次遗留的分支收拾干净」需要的操作。
   */
  async cleanup(
    id: string,
    options: { keepBranch?: boolean } = {},
  ): Promise<{ ok: boolean; branchKept?: boolean; reason?: string }> {
    const session = this.get(id);
    if (!session) return { ok: false };
    // 两道硬闸门，都在改动任何状态之前判：
    //  1. 还在跑（准备中 / 运行中 / 等你处理）→ 清理会把它的进程与正在用的
    //     目录一起端掉，等于用「清理」这个按钮偷偷做了「中断 + 丢工作」。
    //     用户想停就先按中断（cancel），清理不是中断的替代品。
    //  2. worktree 里还有未提交改动 → 删目录不可逆，那些改动会永久消失。
    // 两者都**如实拒绝**并给出原因，绝不静默放行、也绝不先删再报告。
    if (!isTerminalSuperStatus(session.status)) {
      return { ok: false, reason: "超流体仍在运行，请先中断再清理工作目录" };
    }
    if (
      session.isolation.kind === "git_worktree" &&
      session.isolation.path &&
      !session.isolation.released &&
      existsSync(session.isolation.path) &&
      (await worktreeHasUncommittedChanges(session.isolation.path))
    ) {
      return {
        ok: false,
        reason: "工作目录还有未提交的改动，已拒绝清理（请先提交或丢弃这些改动）",
      };
    }
    // 排队中的会话被清理后不能再被 pump 启动。
    this.dequeue(id);
    this.started.delete(id);
    this.lastText.delete(id);
    this.policies.delete(id);
    // 提问定时器/recorder 随记录一起收口 —— 清理后不该再有定时器去动已删的会话。
    this.discardQuestionResolver(id);
    await this.disposeClient(id);
    this.forgetChild(id);
    // 排队中就被清理的合并子会话不会走到 prepare 的收尾（它根本没启动）——
    // 这里补一次判定，否则来源子会话的 integration 会永远停在旧状态。
    if (!session.cliSessionId) await this.finalizeMergeChild(id);
    // 附件副本只服务这个子会话：清理时一并删掉（worktree 的保留策略不适用于它）。
    await rm(this.attachmentDirFor(id), { recursive: true, force: true }).catch(() => undefined);
    // 合并成功时 worktree 与分支已经清理过 —— 这里只删记录，别拿已经不存在的
    // 路径再做一次磁盘操作（那只会产生误导性的失败日志）。
    if (session.isolation.released) {
      this.removeSession(id);
      this.transcripts.delete(id);
      this.emit();
      return { ok: true };
    }
    if (!session.isolation.path) {
      this.removeSession(id);
      this.transcripts.delete(id);
      this.emit();
      return { ok: true };
    }
    if (session.isolation.kind === "repo") {
      // 主仓工作区档：path 是**主仓根**，不是隔离产物 —— 清理绝不能删它。
      // 只移除记录（工作目录与分支都不归这个子会话管）。
      this.removeSession(id);
      this.transcripts.delete(id);
      this.emit();
      return { ok: true };
    }
    const probe = await probeGitRepo(this.deps.repoRoot);
    if (session.isolation.kind === "git_worktree" && probe.isRepo && session.isolation.branch) {
      // 合并成功后，分支的提交已并入 HEAD、不再以 baseRef 为祖先，
      // `baseRef..branch` 会把它们数成「未合并」，导致手动清理误判「有未合并
      // 提交」而保留分支。与 releaseMergedIsolation 同一口径：先用只读的
      // isBranchMerged 核验，通过则不传 baseRef、显式给出已核验信号。
      const merged =
        session.integration?.state === "merged" &&
        (await isBranchMerged({ repoRoot: this.deps.repoRoot, branch: session.isolation.branch }));
      const result = await removeWorktree({
        repoRoot: this.deps.repoRoot,
        targetPath: session.isolation.path,
        branch: session.isolation.branch,
        ...(merged
          ? { branchDeletionVerified: true }
          : { baseRef: session.isolation.baseRef }),
        keepBranch: options.keepBranch,
      });
      this.removeSession(id);
      this.transcripts.delete(id);
      this.emit();
      return { ok: result.removed, branchKept: result.branchKept, reason: result.reason };
    }
    // 目录隔离：直接删掉那个独立目录。
    await rm(session.isolation.path, { recursive: true, force: true }).catch(() => undefined);
    this.removeSession(id);
    this.transcripts.delete(id);
    this.emit();
    return { ok: true };
  }

  /**
   * 清扫磁盘上的残留 worktree。
   *
   * 只处理**同时满足**下列全部条件的 worktree：
   *  1. 在 `git worktree list` 里注册，且路径就在 `.iflow/super/worktrees/` 下；
   *  2. 分支名在 `iflow/super/` 命名空间下（用户自己的分支绝不碰）；
   *  3. 分支已完全并入当前 HEAD（`merge-base --is-ancestor`）—— 没并入的
   *     分支上可能有还没人审的提交，绝不能删；
   *  4. worktree 自身干净（`git status --porcelain` 为空）；
   *  5. 不是活着的子会话正在用的工作目录。
   *
   * **孤儿目录（目录在、但已不在 git 注册表里或没有 .git 关联）一律不自动
   * 删**：无法确认里面有没有独有改动，删掉就是丢数据 —— 只记日志请人工确认。
   *
   * 主循环之后还有**第二阶段：保留上限**（`options.maxKeep`）。主循环只清
   * 「分支已并入 HEAD」的残留；未合并的干净 worktree 会一直堆着。第二阶段把
   * 「仍在注册表里、`iflow/super/` 分支、不是活着的子会话、工作目录干净」的
   * 残留按目录 mtime 升序排列，回收超出 `maxKeep` 的部分 —— **只删目录，
   * `keepBranch: true`**（分支上可能有还没人审的提交，与主循环里「已合并所以
   * 连分支一起删」是两回事）。脏目录、未注册的孤儿目录仍然只记日志、不自动删。
   *
   * `maxKeep` 为 0 或 undefined = 不限制（`iflow.superAgent.maxWorktrees` 的
   * 「0 = 不限制」语义）。
   *
   * 幂等：可重复调用。只删隔离子树下的目录与 `iflow/super/` 分支，绝不碰
   * 主仓工作区，也绝不碰用户自己的分支。
   */
  async sweepStaleWorktrees(options: { maxKeep?: number } = {}): Promise<SuperSweepResult> {
    const result: SuperSweepResult = { removed: 0, kept: 0, orphans: [] };
    if (this.disposed) return result;

    const roots = superWorktreeRoots(this.deps.repoRoot);
    const entries: { root: string; entry: Dirent }[] = [];
    for (const root of roots) {
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          entries.push({ root, entry });
        }
      } catch {
        // 某个隔离子树不存在 → 跳过（回退场景下旧根可能从未建过）。
      }
    }
    if (entries.length === 0) return result;

    const registered = await listWorktrees(this.deps.repoRoot);
    const registeredByPath = new Map<string, string | null>();
    for (const item of registered) {
      // 比较键必须是 realpath 归一的：git 报的是真实路径，而我们的目录枚举
      // 基于 repoRoot（可能是 symlink / junction 形式）。只做词法归一的话，
      // macOS 上（`/var` → `/private/var`）注册表里的 worktree 会全部被判成
      // 孤儿目录，清扫恒为 0。
      registeredByPath.set(await comparisonPathKey(item.path), item.branch);
    }

    // 活着的子会话正在用的工作目录：绝不能删（它还在跑）。
    const livePaths = new Set<string>();
    for (const session of this.sessions.values()) {
      if (isTerminalSuperStatus(session.status)) continue;
      if (!session.isolation.path) continue;
      livePaths.add(await comparisonPathKey(session.isolation.path));
    }

    for (const { root, entry } of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(root, entry.name);
      const key = await comparisonPathKey(target);
      const branch = registeredByPath.get(key);
      if (branch === undefined) {
        // 孤儿目录：不在 git 的 worktree 注册表里（半删残留 / 手删过 .git）。
        // 无法确认里面有没有独有改动 —— 只记日志，绝不自动删。
        result.orphans.push(target);
        this.deps.log.warn(
          `super agent: 发现疑似残留目录（已不在 git worktree 注册表中，可能含独有改动，需人工确认）：${target}`,
        );
        continue;
      }
      if (!branch || !branch.startsWith(SUPER_BRANCH_PREFIX)) {
        result.kept += 1;
        this.deps.log.info(
          `super agent: 跳过残留目录 ${target}（不是 ${SUPER_BRANCH_PREFIX} 命名空间下的分支：${branch ?? "detached"}）`,
        );
        continue;
      }
      if (livePaths.has(key)) {
        result.kept += 1;
        this.deps.log.info(`super agent: 跳过残留目录 ${target}（仍是活着的超流体的工作目录）`);
        continue;
      }
      if (!(await isBranchMerged({ repoRoot: this.deps.repoRoot, branch }))) {
        result.kept += 1;
        this.deps.log.info(`super agent: 保留残留目录 ${target}（分支 ${branch} 尚未并入当前 HEAD）`);
        continue;
      }
      if (await worktreeHasUncommittedChanges(target)) {
        result.kept += 1;
        this.deps.log.warn(`super agent: 保留残留目录 ${target}（工作目录还有未提交改动）`);
        continue;
      }
      const removal = await removeWorktree({
        repoRoot: this.deps.repoRoot,
        targetPath: target,
        branch,
        keepBranch: false,
        // 上面已用 isBranchMerged 核过「分支已并入当前 HEAD」：合并后 baseRef
        // 不再是祖先，delete 的依据是这次核验，而不是 baseRef..branch 的计数。
        branchDeletionVerified: true,
      });
      if (!removal.removed || removal.branchKept) {
        result.kept += 1;
        this.deps.log.warn(
          `super agent: 清理残留目录 ${target} 未完成（removed=${removal.removed}, branchKept=${removal.branchKept}）${removal.reason ?? ""}`,
        );
        continue;
      }
      result.removed += 1;
      this.deps.log.info(`super agent: 已清理残留 worktree ${target} 与分支 ${branch}`);
      // 被清掉的记录也要标成「已释放」，否则看板一直显示待清理。
      this.markWorktreeReleased(target);
    }

    // 第二阶段：保留上限（`iflow.superAgent.maxWorktrees`）。主循环只清
    // 「分支已并入 HEAD」的；未合并但干净的残留会一直堆在磁盘上。按目录
    // mtime 从旧到新回收超出的部分 —— **只删目录，分支一律保留**（与主循环
    // 里「已合并所以连分支一起删」是两回事）。
    const maxKeep = options.maxKeep ?? 0;
    if (maxKeep > 0) {
      const recyclable: { path: string; branch: string; mtimeMs: number }[] = [];
      for (const { root, entry } of entries) {
        if (!entry.isDirectory()) continue;
        const target = path.join(root, entry.name);
        const key = await comparisonPathKey(target);
        const branch = registeredByPath.get(key);
        // 孤儿（undefined）已在上面记过日志；非 iflow/super/ 分支不碰。
        if (!branch || !branch.startsWith(SUPER_BRANCH_PREFIX)) continue;
        if (livePaths.has(key)) continue;
        // 主循环刚删掉的目录也会走到这里：目录不存在 → 证明不了干净 → 排除。
        if (await worktreeHasUncommittedChanges(target)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(target)).mtimeMs;
        } catch {
          // 读不到 mtime 就按最旧处理（先回收），不阻断清扫。
          mtimeMs = 0;
        }
        recyclable.push({ path: target, branch, mtimeMs });
      }
      recyclable.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = recyclable.length - maxKeep;
      for (let index = 0; index < excess; index += 1) {
        const item = recyclable[index]!;
        const removal = await removeWorktree({
          repoRoot: this.deps.repoRoot,
          targetPath: item.path,
          branch: item.branch,
          keepBranch: true,
        });
        if (!removal.removed) {
          result.kept += 1;
          this.deps.log.warn(
            `super agent: 回收超出保留上限的 worktree ${item.path} 未完成${removal.reason ? `：${removal.reason}` : ""}`,
          );
          continue;
        }
        result.removed += 1;
        this.deps.log.info(
          `super agent: 已回收超出保留上限（${maxKeep}）的 worktree ${item.path}，分支 ${item.branch} 保留`,
        );
        this.markWorktreeReleased(item.path, { recycled: true });
      }
      // 保留在限额内的那些也是「有意保留」，如实计数。
      result.kept += Math.max(0, recyclable.length - Math.max(excess, 0));
    }
    if (result.removed > 0) this.emit();
    return result;
  }

  /**
   * 清扫 `.iflow/super/attachments/` 下按 mtime 过期的附件副本。
   *
   * `sweepStaleAttachmentDirs`（attachments.ts）只扫 OS 临时目录，不碰项目内
   * 的 super 隔离子树 —— 子会话附件的孤儿目录此前无人清扫。这里只删「年轻」
   * 的反面：mtime 老于阈值的目录，活着的子会话正在用的附件目录即使老也保留。
   * best-effort：单个目录删除失败只记日志，继续其它。
   */
  async sweepStaleSuperAttachmentDirs(options: {
    now?: number;
    maxAgeMs?: number;
  } = {}): Promise<number> {
    return this.sweepStaleIsolationDir("attachments", {
      maxAgeMs: options.maxAgeMs ?? SUPER_ATTACHMENT_MAX_AGE_MS,
      now: options.now,
    });
  }

  /** 清扫 `.iflow/super/dirs/` 下按 mtime 过期的降级目录（非 git 仓库 / worktree 建失败时创建）。 */
  async sweepStaleSuperDirs(options: { now?: number; maxAgeMs?: number } = {}): Promise<number> {
    return this.sweepStaleIsolationDir("dirs", {
      maxAgeMs: options.maxAgeMs ?? SUPER_DIR_MAX_AGE_MS,
      now: options.now,
    });
  }

  /**
   * `sweepStaleSuperAttachmentDirs` / `sweepStaleSuperDirs` 共用的实现。
   *
   * `attachments/` 的目录名是子会话 id，`dirs/` 的目录名是 `<slug>-<unique>`；
   * 保护集按两处分别构造：活着的子会话 id（附件）与它的 isolation.path 末段
   * （降级目录）。终态的历史记录不保护 —— 它们正是清扫对象。
   */
  private async sweepStaleIsolationDir(
    kind: "attachments" | "dirs",
    options: { maxAgeMs: number; now?: number },
  ): Promise<number> {
    if (this.disposed) return 0;
    const root = superIsolationDir(this.deps.repoRoot, kind);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return 0; // 子树还没建过 —— 没有残留。
    }
    const liveAttachments = new Set<string>();
    const liveDirs = new Set<string>();
    for (const session of this.sessions.values()) {
      if (isTerminalSuperStatus(session.status)) continue;
      liveAttachments.add(session.id);
      if (session.isolation.kind === "directory" && session.isolation.path) {
        liveDirs.add(path.basename(session.isolation.path));
      }
    }
    const now = options.now ?? Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (kind === "attachments" ? liveAttachments.has(entry.name) : liveDirs.has(entry.name)) {
        continue;
      }
      const target = path.join(root, entry.name);
      try {
        const info = await stat(target);
        if (now - info.mtimeMs < options.maxAgeMs) continue;
        await rm(target, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        // 单个目录失败（被占用 / 权限）不影响其它：记日志继续。
        this.deps.log.warn(
          `super agent: 清扫 ${kind} 残留 ${target} 失败：${errorMessage(error)}`,
        );
      }
    }
    if (removed > 0) {
      this.deps.log.info(`super agent: 已清扫 ${removed} 个过期 ${kind} 残留目录`);
    }
    return removed;
  }

  /**
   * 轻量统计跨历史会话的残留目录（新建会话时的检测）。
   *
   * 只读目录 + 计数，不跑任何 git 探测（那些要几秒到几十秒），因此不阻塞新建
   * 会话主流程。三类目录同在 `.iflow/super/` 下：worktrees / dirs / attachments。
   */
  async countResidue(): Promise<SuperResidueCount> {
    const countDirs = async (kind: "worktrees" | "dirs" | "attachments"): Promise<number> => {
      const roots =
        kind === "worktrees"
          ? superWorktreeRoots(this.deps.repoRoot)
          : [superIsolationDir(this.deps.repoRoot, kind)];
      let total = 0;
      for (const root of roots) {
        try {
          const entries = await readdir(root, { withFileTypes: true });
          total += entries.filter((entry) => entry.isDirectory()).length;
        } catch {
          // 子树不存在 = 零残留。
        }
      }
      return total;
    };
    const [worktrees, dirs, attachments] = await Promise.all([
      countDirs("worktrees"),
      countDirs("dirs"),
      countDirs("attachments"),
    ]);
    return { worktrees, dirs, attachments, total: worktrees + dirs + attachments };
  }

  /**
   * 残留明细聚合（批次2A，只读）：列出磁盘上仍在的 super worktree / 孤儿目录，
   * 并逐条补齐「分支是否未合并、目录是否有未提交改动、主仓是否停在中间态」。
   *
   * 只读、不删任何东西；丢弃动作必须经过业务侧二次确认令牌（见宿主
   * `handleSuperResidueDiscard`），且未提交改动 / 中间态一律拒绝丢弃。
   */
  async listResidueItems(): Promise<SuperResidueItem[]> {
    if (this.disposed) return [];
    const [registered, tree] = await Promise.all([
      listWorktrees(this.deps.repoRoot).catch(() => [] as { path: string; branch: string | null }[]),
      inspectWorkingTree(this.deps.repoRoot).catch(() => ({
        available: false,
        clean: true,
        dirtyCount: 0,
        inProgress: null,
        trackedPaths: [] as string[],
        untrackedCount: 0,
      })),
    ]);
    const inProgress = tree.inProgress !== null;
    const items: SuperResidueItem[] = [];
    const seenPaths = new Set<string>();

    for (const wt of registered) {
      if (!wt.branch?.startsWith(SUPER_BRANCH_PREFIX)) continue;
      seenPaths.add(path.resolve(wt.path));
      const [unmerged, uncommitted] = await Promise.all([
        branchHasUnmergedCommits({
          repoRoot: this.deps.repoRoot,
          branch: wt.branch,
          baseRef: "HEAD",
        }),
        worktreeHasUncommittedChanges(wt.path),
      ]);
      const linked = this.findSessionByIsolationPath(wt.path);
      items.push({
        key: wt.path,
        kind: "worktree",
        path: wt.path,
        branch: wt.branch,
        sessionId: linked?.id,
        title: linked?.title,
        status: linked?.status,
        unmerged,
        uncommitted,
        inProgress,
      });
    }

    for (const kind of ["worktrees", "dirs", "attachments"] as const) {
      const roots =
        kind === "worktrees"
          ? superWorktreeRoots(this.deps.repoRoot)
          : [superIsolationDir(this.deps.repoRoot, kind)];
      for (const root of roots) {
        let entries: Dirent[];
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const target = path.join(root, entry.name);
          if (kind === "worktrees" && seenPaths.has(path.resolve(target))) continue;
          const linked = this.findSessionByIsolationPath(target);
          const itemKind = kind === "worktrees" ? "worktree" : kind === "dirs" ? "directory" : "attachment";
          items.push({
            key: target,
            kind: itemKind,
            path: target,
            sessionId: linked?.id,
            title: linked?.title,
            status: linked?.status,
            unmerged: false,
            uncommitted:
              kind === "worktrees"
                ? await worktreeHasUncommittedChanges(target).catch(() => false)
                : false,
            inProgress,
          });
        }
      }
    }
    return items;
  }

  /** 从隔离路径反查关联的子会话（live 记录优先）。 */
  private findSessionByIsolationPath(target: string): SuperSessionUi | undefined {
    const abs = path.resolve(target);
    for (const session of this.sessions.values()) {
      if (path.resolve(session.isolation.path) === abs) return session;
    }
    return undefined;
  }

  /**
   * 丢弃一条残留（**调用方必须先拿到业务侧二次确认令牌**）。
   *
   * 硬保护（任一命中即拒绝，令牌也不放行）：
   *  - 主仓停在 merge/rebase/cherry-pick 中间态；
   *  - 目标目录有未提交改动 —— 绝不以「清空残留」之名丢用户的工作；
   *  - merge-tree 预演不可用且工作区不干净（旧版 git / criss-cross 的保守回退）。
   *
   * 通过后再删 worktree（含分支 force 删除）或孤儿目录，并 markWorktreeReleased。
   */
  async discardResidueItem(item: SuperResidueItem): Promise<{ ok: boolean; reason?: string }> {
    if (this.disposed) return { ok: false, reason: "子会话管理器已释放" };
    if (item.inProgress) return { ok: false, reason: "主仓停在 git 中间态，不能丢弃" };
    if (item.uncommitted) return { ok: false, reason: "目录有未提交改动，已保护不丢弃" };

    if (item.kind === "worktree" && item.branch) {
      const [preview, tree] = await Promise.all([
        previewMerge({ repoRoot: this.deps.repoRoot, branch: item.branch }),
        inspectWorkingTree(this.deps.repoRoot).catch(() => null),
      ]);
      if (!preview.available && tree && !tree.clean) {
        return { ok: false, reason: "合并预演不可用且工作区不干净，已保守拒绝" };
      }
      const removal = await removeWorktree({
        repoRoot: this.deps.repoRoot,
        targetPath: item.path,
        branch: item.branch,
        keepBranch: false,
        // 二次确认已授权；未提交改动 / 中间态的硬保护已在上面拦下。
        branchDeletionVerified: true,
      }).catch(() => ({ removed: false, reason: "删除命令失败" }));
      this.markWorktreeReleased(item.path);
      return removal.removed
        ? { ok: true }
        : { ok: false, reason: removal.reason ?? "删除 worktree 失败" };
    }

    try {
      await rm(item.path, { recursive: true, force: true, maxRetries: 3 });
      this.markWorktreeReleased(item.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  /**
   * 用户明确授权后的**全量清空**（「清空并新建」）。
   *
   * 与 `sweepStaleWorktrees` / `cleanup` 的安全闸门刻意不同：这里**不再保护**
   * 未合并 worktree、未提交改动与未合并分支 —— 二次确认框已经醒目警示过
   * 「未提交/未合并工作会永久丢失」，用户点确认就是授权。清空范围：
   *  1. 所有 `iflow/super/` 命名空间下已注册的 worktree（含未合并、含脏目录）；
   *     目录用 Node 递归删（不跟随链接，见 worktree.ts#defaultRemoveDir），
   *     分支用 `branchDeletionVerified` 走 force 删除，不做合并核验；
   *  2. `worktrees/` 下不在注册表里的孤儿目录（半删残留）；
   *  3. 所有 `iflow/super/` 本地分支（含上面目录已删但分支还在的孤儿）；
   *  4. `dirs/` 与 `attachments/` 下的全部目录。
   *
   * best-effort：单个目录删除失败只记日志、计入 failed，继续其它，绝不阻断
   * 随后的新建会话。清空后把受影响的记录标成 released，看板不再显示待清理。
   */
  async purgeAllResidue(): Promise<SuperResiduePurgeResult> {
    const result: SuperResiduePurgeResult = { worktrees: 0, dirs: 0, attachments: 0, failed: 0 };
    if (this.disposed) return result;

    // 1. 已注册的 super worktree：强制删目录 + 强制删分支（含未合并）。
    const registered = await listWorktrees(this.deps.repoRoot).catch(() => []);
    for (const item of registered) {
      if (!item.branch?.startsWith(SUPER_BRANCH_PREFIX)) continue;
      const removal = await removeWorktree({
        repoRoot: this.deps.repoRoot,
        targetPath: item.path,
        branch: item.branch,
        keepBranch: false,
        // 用户已授权连未合并分支一起清空：跳过 baseRef 合并核验，走 -D。
        branchDeletionVerified: true,
      });
      this.markWorktreeReleased(item.path);
      if (removal.removed) {
        result.worktrees += 1;
      } else {
        result.failed += 1;
        this.deps.log.warn(`super agent: 清空 worktree ${item.path} 失败：${removal.reason ?? ""}`);
      }
    }

    // 2 + 4. 三类子树里剩下的目录（孤儿 worktree、dirs、attachments）全删。
    // worktrees/ 里第 1 步已删掉的目录这里会 readdir 不到，天然幂等。
    for (const kind of ["worktrees", "dirs", "attachments"] as const) {
      const roots =
        kind === "worktrees"
          ? superWorktreeRoots(this.deps.repoRoot)
          : [superIsolationDir(this.deps.repoRoot, kind)];
      for (const root of roots) {
        let entries: Dirent[];
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const target = path.join(root, entry.name);
          try {
            await rm(target, { recursive: true, force: true, maxRetries: 3 });
            if (kind === "worktrees") result.worktrees += 1;
            else if (kind === "dirs") result.dirs += 1;
            else result.attachments += 1;
            this.markWorktreeReleased(target);
          } catch (error) {
            result.failed += 1;
            this.deps.log.warn(`super agent: 清空 ${kind} 目录 ${target} 失败：${errorMessage(error)}`);
          }
        }
      }
    }

    // 3. 孤儿分支（目录已不在、worktree 元数据已 prune，但分支仍留着）。
    for (const branch of await listSuperBranches(this.deps.repoRoot)) {
      const deleted = await deleteSuperBranch(this.deps.repoRoot, branch);
      if (!deleted) {
        this.deps.log.warn(`super agent: 清空分支 ${branch} 失败（可能仍被签出）`);
      }
    }
    // 让 git 的 worktree 记账与磁盘现状一致（避免留下坏元数据）。
    await pruneWorktrees(this.deps.repoRoot);
    this.emit();
    return result;
  }

  /**
   * 把指向某个 worktree 目录的记录都标成「隔离已释放」。
   *
   * 清扫掉的可能是历史（archived）子会话的工作目录 —— 它们的记录留在归档里，
   * 不打 released 标记的话看板会一直显示「还有工作目录没清理」。
   *
   * `recycled` 区分两种清理：主循环里「已合并 → 连分支一起删」只打 released；
   * 保留上限阶段「只删目录、分支留着待审」额外打 recycled。
   */
  private markWorktreeReleased(
    targetPath: string,
    options: { recycled?: boolean } = {},
  ): void {
    const key = normalizePathKey(targetPath);
    const mark = (session: SuperSessionUi): SuperSessionUi => ({
      ...session,
      isolation: {
        ...session.isolation,
        released: true,
        ...(options.recycled ? { recycled: true } : {}),
      },
    });
    const matches = (session: SuperSessionUi): boolean =>
      Boolean(session.isolation.path) && normalizePathKey(session.isolation.path) === key;
    for (const [id, session] of [...this.sessions]) {
      if (!matches(session)) continue;
      this.sessions.set(id, mark(session));
    }
    for (const [owner, records] of [...this.archived]) {
      if (!records.some(matches)) continue;
      this.archived.set(owner, records.map((s) => (matches(s) ? mark(s) : s)));
    }
  }

  /**
   * 面板关闭 / 内核重启时终止全部子进程。
   *
   * **worktree 保留**：里面可能有用户还没合并的工作，随手删掉就是丢数据。
   * 它们的分支与路径记在返回的清单里，由用户显式清理。
   */
  async dispose(): Promise<{ id: string; path: string; branch?: string }[]> {
    this.disposed = true;
    // 清掉全部在飞的自动重试退避定时器 —— 宿主已关闭，不能再触发 retry。
    for (const timer of this.autoRetryTimers.values()) clearTimeout(timer);
    this.autoRetryTimers.clear();
    const kept: { id: string; path: string; branch?: string }[] = [];
    for (const [id, session] of this.sessions) {
      // 与 cancel 同理：先落「已中断」再杀进程，否则 onExit 会把这次终止记成
      // 内核异常退出（failed），且终态粘性让随后的 cancelled 无法覆盖。
      if (!isTerminalSuperStatus(session.status)) {
        // 面板正在关闭 —— 这一轮同样不许落改动、不许自动合并。
        this.interrupted.set(id, session.attempts ?? 1);
        this.apply(id, { type: "cancelled", at: Date.now(), source: "system" });
      }
      await this.disposeClient(id);
      // worktree 保留（里面可能有未合并的工作），附件副本是纯拷贝 → 删掉。
      await rm(this.attachmentDirFor(id), { recursive: true, force: true }).catch(() => undefined);
      // 合并成功时 worktree 与分支已清理：磁盘上没有需要用户收拾的对象了。
      // 主仓工作区档的 path 是主仓根 —— 它不是待清理的隔离产物，绝不能报给
      // 用户当「遗留的 worktree」。
      if (
        session.isolation.path &&
        !session.isolation.released &&
        session.isolation.kind !== "repo"
      ) {
        kept.push({ id, path: session.isolation.path, branch: session.isolation.branch });
      }
    }
    for (const resolver of this.resolvers.values()) {
      if (resolver.timer) clearTimeout(resolver.timer);
    }
    this.resolvers.clear();
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
    // 卡死看门狗定时器随面板关闭一并清掉：残留的 unref 定时器会在宿主还活着时
    // 对一个已 dispose 的子会话触发归一（会话记录可能已被清理）。
    for (const timer of this.watchdogTimers.values()) clearTimeout(timer);
    this.watchdogTimers.clear();
    this.watchdogs.clear();
    // 隔离释放的重试定时器也要清掉：面板正在关闭，不能让后台重试去动
    // 磁盘上的 worktree（它与 dispose 的收尾会互相踩）。
    for (const timer of this.releaseRetryTimers.values()) clearTimeout(timer);
    this.releaseRetryTimers.clear();
    this.releaseRetryAttempts.clear();
    this.pendingEmptyRelease.clear();
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    this.transcripts.clear();
    this.lastText.clear();
    this.lastThought.clear();
    this.promptTokens.clear();
    this.policies.clear();
    this.queue.length = 0;
    return kept;
  }

  /**
   * 设置页改了并发上限后立刻重试队列。
   *
   * pump 平时由 spawn / settle / retry 驱动；调**高**上限时可能一个事件都没有
   * （队列里排着队，但没人结束），不主动补一次就会一直等到下一次事件。
   * 调低不需要额外动作 —— 已在运行的子会话按约定不受影响。
   */
  pumpQueue(): void {
    if (this.disposed) return;
    this.pump();
  }

  // --- 内部 -----------------------------------------------------------------

  /**
   * 队列泵：并发有空位时把排队的派发请求放出去。
   *
   * 波次依赖门控（单层主→子，不引入新的层级）：每个运行组按 wave 分层，
   *  - 显式 `dependsOn`（任务标识）指向的上游必须全部终态才放行；
   *  - 没有显式依赖但 wave > 0 时，同一运行组里所有低波次会话必须终态
   *    （批次模式的串行语义）；
   *  - 上游非终态 → 该条目**留在队列**等下一次 pump（由上游收尾的 finally 触发）；
   *  - 上游失败 / 中断 → 下游标记 failed + `lastError.kind="blocked"` +
   *    `statusDetail`（除非 dependencyPolicy="continue"），并上报主会话。
   */
  private pump(): void {
    const limit = clampMaxConcurrentSuperSessions(this.deps.maxConcurrentSessions());
    let i = 0;
    while (i < this.queue.length && this.activeCount() < limit) {
      const next = this.queue[i]!;
      const gate = this.dependencyGate(next);
      if (gate === "wait") {
        i++; // 上游还在跑：跳过本条，尝试后面的任务（它们可能无依赖）。
        continue;
      }
      if (gate.blocked) {
        // 先摘掉队列项再标记终态，避免下一次 pump 重复处理同一条。
        this.queue.splice(i, 1);
        this.blockDependent(next.id, gate.reason);
        continue;
      }
      this.queue.splice(i, 1);
      this.started.add(next.id);
      void this.prepare(next.id, next.spec, next.retry, next.policy);
    }
  }

  /**
   * 依赖门控判定。返回 "wait"=上游未终态（留队列）；对象 blocked=true=上游失败
   * 需跳过下游；blocked=false=放行。
   */
  private dependencyGate(
    entry: SuperQueueEntry,
  ): "wait" | { blocked: false } | { blocked: true; reason: string } {
    const session = this.sessions.get(entry.id);
    if (!session) return { blocked: false };
    const runId = entry.runId ?? session.runId;
    // 平铺派发（无运行组）：保持既有行为，零依赖零等待。
    if (!runId) return { blocked: false };
    const policy = this.deps.dependencyPolicy?.() ?? "block";

    const upstreamCheck = (up: SuperSessionUi | undefined, label: string) => {
      if (!up) return "ok" as const; // 上游已被清理：shared 校验保证不会悬空，防御性放行
      if (isTerminalSuperStatus(up.status)) {
        if (up.status === "failed" || up.status === "cancelled") {
          return policy === "continue" ? ("ok" as const) : ("failed" as const);
        }
        return "ok" as const;
      }
      void label;
      return "wait" as const;
    };

    // ① 显式依赖：任务标识 → sessionId 索引。
    for (const dep of session.dependsOn ?? []) {
      const key = superTaskKey({ title: dep });
      const upId = this.waveTaskIndex.get(`${runId}\u0000${key}`);
      const verdict = upstreamCheck(upId ? this.sessions.get(upId) : undefined, dep);
      if (verdict === "wait") return "wait";
      if (verdict === "failed") {
        return { blocked: true, reason: `任务「${dep}」失败 / 中断` };
      }
    }

    // ② 批次串行：无显式依赖时，所有低波次会话必须终态。
    if ((session.dependsOn ?? []).length === 0 && (entry.wave ?? session.wave ?? 0) > 0) {
      const wave = entry.wave ?? session.wave ?? 0;
      for (const other of this.sessions.values()) {
        if (other.id === session.id) continue;
        if ((other.runId ?? "") !== runId) continue;
        if ((other.wave ?? 0) >= wave) continue;
        const verdict = upstreamCheck(other, other.title);
        if (verdict === "wait") return "wait";
        if (verdict === "failed") {
          return { blocked: true, reason: `上游波次 ${other.wave ?? 0}「${other.title}」失败 / 中断` };
        }
      }
    }
    return { blocked: false };
  }

  /** 上游失败 → 下游标记 blocked 并上报（ resumed by dependencyPolicy=continue 时不调用）。 */
  private blockDependent(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return;
    const detail = `${SUPER_DEPENDENCY_BLOCK_REASON}：${reason}`;
    // 错误文本含「上游任务失败」→ apply() 的四分类归为 blocked；statusDetail
    // 显式写入同一句话，供看板与失败分类 chip 读取。
    this.apply(id, { type: "failed", error: detail, at: Date.now() }, detail);
    this.notifyReport(id);
  }

  /** 把一个会话的排队项移除（取消 / 清理 / 重试重新入队时用）。 */
  private dequeue(id: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.id === id) this.queue.splice(i, 1);
    }
  }

  /**
   * 占着并发槽位的子会话数（排队中的不占槽位）。
   *
   * **额度按「活着的 CLI 进程」算，而不是按会话状态算。** 旧口径只看
   * 「已启动且状态不是终态」：而一个子会话的回合结束（状态 → completed）到
   * 它的进程被回收之间，还夹着一段**集成**时间（自动合并 / PR 是串行的，
   * 排在队尾时可能等很久）。这段时间里它的额度会被释放，新子会话继续起进程
   * —— 活着的子进程数就会超过上限，集成排队越久涨得越多。
   *
   * 现在的口径：
   *  - 进程还活着（回合已结束、还在集成 / 收尾）→ **仍占槽位**；
   *  - 还没拿到进程（正在准备隔离环境）→ 也占槽位，否则准备阶段可以无限并发。
   */
  private activeCount(): number {
    let count = 0;
    for (const id of this.started) {
      const session = this.sessions.get(id);
      if (!session) continue;
      if (this.clients.has(id)) {
        count++;
        continue;
      }
      if (!isTerminalSuperStatus(session.status)) count++;
    }
    return count;
  }

  /**
   * 准备并执行一个子会话。
   *
   * `prepareInner` 只把「隔离环境建好之后」的部分放进 try/finally：准备阶段
   * 的抛错（worktree 降级目录的 `mkdir` 遇到 ENOTDIR/EPERM、附件目录
   * `mkdir` 失败……）会直接冒出来。旧实现因此把并发槽位（`started`）永久
   * 占着 —— 一个根本没起来的子会话就把并发池吃掉一格，会话也卡在「准备中」。
   *
   * 这层 wrapper 兜住三条纪律：
   *  - **任何路径**（正常结束 / 提前 return / 抛错）都归还槽位；
   *  - 抛错时如实记成 failed 并上报，绝不谎称它在跑；
   *  - 合并子会话即使在准备阶段失败也要走一次收尾判定 —— 否则来源子会话的
   *    integration 永远停在旧状态。
   */
  private async prepare(
    id: string,
    spec: SuperTaskSpec,
    retry?: SuperRetryState,
    policy: ResolvedSuperSpawnPolicy = resolveSpawnPolicy(null),
  ): Promise<void> {
    const attempt = this.sessions.get(id)?.attempts ?? 1;
    try {
      await this.prepareInner(id, spec, retry, policy);
    } catch (error) {
      // 准备阶段抛错：会话不能被留在「准备中」，也不能假装它跑过。
      const latest = this.sessions.get(id);
      if (
        latest &&
        (latest.attempts ?? 1) === attempt &&
        !isTerminalSuperStatus(latest.status)
      ) {
        this.apply(id, { type: "failed", error: errorMessage(error), at: Date.now() });
        this.notifyReport(id);
      }
      // 合并子会话的收尾不看进程是否跑过：目标分支没并入就如实记「仍保留」。
      await this.finalizeMergeChild(id);
    } finally {
      // 槽位必须回收。已被一次重试接管（attempts 变了）时不能动 —— 那一轮
      // 才是槽位现在的主人。看门狗同理：只能清属于本轮的定时器。
      const latest = this.sessions.get(id);
      if (!latest || (latest.attempts ?? 1) === attempt) {
        this.started.delete(id);
        this.clearWatchdog(id);
      }
      this.pump();
    }
  }

  private async prepareInner(
    id: string,
    spec: SuperTaskSpec,
    retry: SuperRetryState | undefined,
    policy: ResolvedSuperSpawnPolicy,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || this.disposed || isTerminalSuperStatus(session.status)) {
      // 排队期间被取消 / 清理 / 面板关闭 —— 不要为它建目录或起进程。
      this.started.delete(id);
      return;
    }
    // 本次执行的序号：finally 据此判断自己是否已被一次重试取代。
    const attempt = session.attempts ?? 1;

    let isolation: SuperSessionUi["isolation"];
    const reused = retry?.reuseIsolation ? reusableIsolation(session.isolation) : null;
    if (reused) {
      // 重试复用上次的目录：worktree 里可能有中断前没提交的改动。
      isolation = reused;
      this.deps.log.info(`super agent: ${id} 重试复用工作目录 ${reused.path}`);
    } else if (session.isolation.kind === "repo") {
      // 主仓工作区档：不建 worktree、不建分支 —— 子会话直接在主仓根目录里
      // 干活。合并子会话与完全信任子会话共用这一档；fullTrust 标记与看板
      // note 必须带过去，否则任务书会退回「不许 push」的合并契约。
      isolation = {
        kind: "repo",
        path: this.deps.repoRoot,
        ...(session.isolation.fullTrust
          ? { fullTrust: true, note: "完全信任（主仓工作区）" }
          : {}),
      };
    } else {
      const slug = sanitizeWorktreeName(spec.title);
      const unique = `${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
      const probe = await probeGitRepo(this.deps.repoRoot);
      // 隔离子树在项目内：先把它写进仓库本地 exclude。否则 worktree 一建出来
      // 主工作区就变脏，自动合并会被 inspectWorkingTree 挡掉。
      if (probe.isRepo) await ensureSuperIsolationIgnored(this.deps.repoRoot);

      if (probe.isRepo && probe.head) {
        const branch = superBranchName(`${slug}-${unique}`);
        const target = worktreePathFor(this.deps.repoRoot, slug, unique);
        try {
          await createWorktree({ repoRoot: this.deps.repoRoot, targetPath: target, branch, baseRef: probe.head });
          isolation = { kind: "git_worktree", path: target, branch, baseRef: probe.head };
        } catch (error) {
          // 建 worktree 失败不能让整个委派失败 —— 退回目录隔离，并把真实原因
          // 交给子会话与看板（否则它只看到「空目录、不是 git 仓库」）。
          const fullReason = errorMessage(error);
          // 降级前再确认一次现场已清干净：残留目录会让下一次重试直接撞上
          // 「目录已存在」，空分支则占着分支名。清理是幂等的。
          await discardFailedWorktree({
            repoRoot: this.deps.repoRoot,
            targetPath: target,
            branch,
            baseRef: probe.head,
          });
          // 日志保留**完整** stderr（多次重试后最后一次的原文），排查时才看得
          // 出 git 到底抱怨什么；看板 note 仍截断到 200 字符。
          const reason = truncateForPrompt(fullReason.replace(/\s+/g, " "), 200);
          this.deps.log.warn(`worktree 创建失败，退回目录隔离：\n${fullReason}`);
          const dir = path.join(superIsolationDir(this.deps.repoRoot, "dirs"), `${slug}-${unique}`);
          await mkdir(dir, { recursive: true });
          isolation = {
            kind: "directory",
            path: dir,
            note: `独立工作目录创建失败（${reason}），仅目录隔离`,
            degradeReason: `worktree creation failed: ${reason}`,
          };
        }
      } else {
        const dir = path.join(superIsolationDir(this.deps.repoRoot, "dirs"), `${slug}-${unique}`);
        await mkdir(dir, { recursive: true });
        isolation = {
          kind: "directory",
          path: dir,
          note: probe.isRepo ? "仓库还没有任何提交，仅目录隔离" : "当前目录不是 git 仓库，仅目录隔离",
          degradeReason: probe.isRepo
            ? "the repository has no commits yet"
            : "the current directory is not a git repository",
        };
      }
    }

    // 隔离一建好就**先写回记录**，再判 early-return：此前 cancel 只 apply
    // cancelled，prepareInner 在这里（worktree 已建好、isolation 还没写回）命中
    // 终态守卫直接 return，磁盘上的 worktree 与分支不在任何记录里，成为无人
    // 认领的孤儿（清理/清扫都找不到它）。写回按 attempt 号守住 —— 已被一次
    // 重试取代的旧一轮不得把它的 isolation 盖到新一轮头上。
    const beforeGuards = this.sessions.get(id);
    if (beforeGuards && !this.disposed && (beforeGuards.attempts ?? 1) === attempt) {
      this.sessions.set(id, {
        ...beforeGuards,
        isolation,
        queued: false,
        updatedAt: Date.now(),
      });
      this.emit();
    }

    const current = this.sessions.get(id);
    if (!current || this.disposed || isTerminalSuperStatus(current.status)) {
      this.started.delete(id);
      return;
    }
    // 准备期间又发生了一次重试 —— 让新的一次执行接管。
    if ((current.attempts ?? 1) !== attempt) return;

    let model: string | null = null;
    let usageReport: TurnUsageReport | undefined;

    // Attachments live OUTSIDE the worktree: the child may not be able to see
    // the main workspace, and copying staged/picked files into a dedicated
    // dir keeps them out of any `git add -A` the child runs.
    const attachmentDir = this.attachmentDirFor(id);
    const staged = await stageSuperAttachments(attachmentDir, spec.attachments ?? [], this.deps.log);
    const allowedRoots = [isolation.path];
    if (staged.copies.length > 0) allowedRoots.push(attachmentDir);
    // CLI 侧 `isPathWithinWorkspace` 与宿主侧 `resolveAgentPath` 必须同源：
    // 主仓工作区档要把主仓根**显式**交给 CLI（--include-directories），否则
    // 合并子会话读不到主仓文件（读不到冲突文件就无从解决冲突）。
    const includeDirectories =
      isolation.kind === "repo"
        ? [...allowedRoots]
        : allowedRoots.filter((root) => path.resolve(root) !== path.resolve(isolation.path));

    try {
      // 附件拷贝是异步的 —— 这段时间里用户可能已经中断了这一轮。为一个已经
      // 被喊停的子会话再起一个 CLI 进程没有意义（它跑完了也不会被采纳）。
      const ready = this.sessions.get(id);
      if (
        !ready ||
        this.disposed ||
        isTerminalSuperStatus(ready.status) ||
        (ready.attempts ?? 1) !== attempt
      ) {
        this.started.delete(id);
        return;
      }
      const client = await this.deps.createClient({
        cwd: isolation.path,
        allowedRoots,
        includeDirectories,
        label: id,
        callbacks: this.callbacksFor(id),
      });
      if (this.disposed) {
        await client.dispose();
        return;
      }
      // 准备期间用户可能已经中断了这一轮（或这一轮已被一次重试取代）。
      // 这时**根本不该再把任务交给内核**：子会话会真的跑完，而它的产出随后
      // 会被收尾路径当成正常结果处理。先把进程收掉，一轮都不跑。
      const live = this.sessions.get(id);
      if (
        !live ||
        isTerminalSuperStatus(live.status) ||
        (live.attempts ?? 1) !== attempt ||
        this.disposed
      ) {
        await client.dispose();
        this.started.delete(id);
        return;
      }
      this.clients.set(id, client);
      // 卡死看门狗从「进程已就绪、即将发第一个 ACP 请求」开始布防：覆盖
      // newSession / MCP 就绪等待 / setMode / 首轮 prompt 等所有可能在途挂起的
      // 阶段。此后每个 session/update 都会刷新最近进展时刻（见 callbacksFor）。
      this.armWatchdog(id, attempt);

      // Broker endpoints for the configured MCP servers (one shared process
      // per server across ALL children). Empty when the host has no broker
      // (no configured servers, or broker startup failed — the CLI process
      // is then scoped to the sentinel by the host and spawns nothing).
      // 取一次复用：既进 session/new，也用来判断首轮 prompt 前要不要等 MCP。
      const childMcpServers = this.deps.childMcpServers?.() ?? [];
      this.deps.log.info(
        `[${id}] 子会话 MCP 服务器：${childMcpServers.length} 个（${childMcpServers.map((s) => s.name).join(", ") || "无"}]`,
      );
      // 工具白名单来自宿主配置（buildChildSessionSettings），与审批策略的
      // 黑名单合并成一份 settings。两者都为空时不带 settings —— 缺省
      // `session/new` 的请求形状必须与既有行为逐字节一致（既有测试断言
      // 子会话不传 settings）。
      const settings: SessionSettings = {
        ...(this.deps.childSessionSettings?.() ?? {}),
        ...(policy.disallowedTools.length > 0
          ? { disallowed_tools: [...policy.disallowedTools] }
          : {}),
      };
      const { sessionId } = await client.newSession({
        cwd: isolation.path,
        mcpServers: childMcpServers,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
      this.apply(id, { type: "started", cliSessionId: sessionId, at: Date.now() });

      // CLI 的 MCP 发现走后台（mcp-background-loader 的
      // startMcpDiscoveryInBackground() 不 await），newSession 返回时工具可能
      // 还没注册。首轮 prompt 前做一次**有界**等待，避免模型首轮缺 MCP 工具。
      // 没配置任何 MCP server 时立即跳过（无 broker 场景与修复前逐字节同行为），
      // 超时 / 查询失败都只记日志后照常发 prompt，绝不永久卡住子会话。
      if (childMcpServers.length > 0) {
        await waitForChildMcpReady({
          client,
          sessionId,
          timeoutMs: this.mcpReadyTimeoutMs,
          pollMs: this.mcpReadyPollMs,
          log: this.deps.log,
          label: id,
        });
      }

      // 子会话推 `yolo` 是 `auto` 策略**刻意**的语义：子会话完全自主，不因审批
      // 往返而停顿。代价是 `yolo` 下内核通常**不发** `session/request_permission`，
      // 所以审批点上的依赖护栏（callbacksFor 里的 classifyChildShellCommand）只是
      // **兜底** —— 万一某类工具仍然发审批，就仍然自动放行（shell 用 allow_once）
      // + 拦危险 shell；它不是主防线，不能依赖它。
      //
      // `supervised` / `deny` **绝不推 yolo**：它们的全部意义就是让审批真的发生
      // （远程任务不能静默清零风险）。
      if (policy.approval === "auto") {
        try {
          await client.setMode(sessionId, "yolo");
        } catch (error) {
          this.deps.log.warn(`超流体切换到免确认模式失败（改由宿主自动放行）：${errorMessage(error)}`);
        }
      }

      model = this.deps.currentModel();
      if (model) {
        try {
          await client.setModel(sessionId, model);
          // 方案D：set_model 只改模型名，不重算子 CLI 缓存的 tokensLimit。用户
          // 显式覆盖的窗口必须串行推送，否则子会话首轮会用旧模型的压缩阈值。
          // 失败沿用内核默认，绝不阻断子会话。
          if (this.deps.setTokensLimit) {
            await this.deps.setTokensLimit(client, sessionId, model);
          }
        } catch (error) {
          this.deps.log.warn(`超流体设置模型或上下文长度失败（沿用内核默认）：${errorMessage(error)}`);
        }
        this.patchModel(id, model);
      }

      const taskPrompt = buildTaskPrompt(
        current.title,
        current.task,
        isolation,
        staged,
        retry ? { attempt: retry.attempt, error: retry.error, summary: retry.summary } : undefined,
        this.deps.efficiencyMode?.() ?? "steady",
      );
      this.promptTokens.set(id, estimateTokens(taskPrompt));
      // The delegation prompt is deliberately NOT written into the child's
      // transcript: the board's 「查看实时操作」 dialog is a view of what the
      // child *does* (thoughts / tool calls / text), not a re-read of the
      // host-authored instructions. Nothing is pushed until the child's first
      // update arrives.

      const prompt: ContentBlock[] = [{ type: "text", text: taskPrompt }];
      for (const image of staged.images) {
        prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      const response = await client.prompt({ sessionId, prompt });
      usageReport = response.usage;
      const at = Date.now();
      // **收尾守卫**：用户已经喊停（或这一轮已被重试取代 / 会话已被清理）时，
      // 绝不能代提交、绝不能自动合并 —— 用户喊停之后，子会话的代码改动不许
      // 流进当前分支。分支与 worktree 原样保留，并如实记成
      // 「已中断，改动保留在分支（未合并）」。
      const blocked = this.settleBlockReason(id, attempt);
      if (response.stopReason === "cancelled") {
        this.apply(id, { type: "cancelled", at, source: "system" });
        // 回合被取消：子会话可能已经在 worktree 里改了东西 —— 那些改动留在
        // 分支上，**没有**被合并。如实记下来，别让看板装作「什么都没发生」。
        this.recordInterrupted(id, blocked ?? "cancelled");
        this.notifyReport(id);
      } else if (blocked) {
        this.recordInterrupted(id, blocked);
        this.notifyReport(id);
      } else {
        this.apply(id, {
          type: "report",
          at,
          report: { state: "ready", summary: this.summarize(id), at },
        });
        // 子会话不一定会自己提交（系统提示禁止未经用户明示的 commit），而
        // 自动集成只认提交：正常完成时由宿主在它自己的 worktree 内补一次提交。
        // 失败 / 中断刻意不提交 —— 重试要能直达未完成的现场。
        // 主仓工作区档（合并子会话）在这里什么都不做：它的产出是合并提交，
        // 绝不能对主仓跑 `git add -A`（那会把用户未提交的其它改动卷进去）。
        const commit = await this.commitChildWork(id, isolation, attempt);
        if (commit.error) {
          this.recordIntegration(id, {
            mode: this.deps.integrationMode(),
            at: Date.now(),
            state: "skipped",
            needsAction: true,
            detail: `宿主代提交失败，分支已保留：${commit.error}`,
          });
        } else {
          if (commit.committed) {
            this.appendReport(id, {
              state: "progress",
              summary: `宿主已代超流体提交 ${commit.files} 个文件`,
              at: Date.now(),
            });
          }
          // 自动合并 / PR 只依赖 worktree 里的提交，与子进程无关。
          await this.integrate(id, attempt);
          // 改动没能自动带回主分支（重叠 / 冲突 / git 拒绝）→ 自动请主会话
          // 智能体合并，不再把这件事留给用户点按钮。
          this.maybeRequestAgentMerge(id);
        }
        this.notifyReport(id);
      }
    } catch (error) {
      this.apply(id, { type: "failed", error: errorMessage(error), at: Date.now() });
      this.notifyReport(id);
    } finally {
      // 结算进度与 token 用量：取消/失败也要留下已经产生的开销。
      this.finalizeProgress(id);
      await this.recordUsage(id, model, usageReport);
      // Flush before the process goes away: the last text/tool chunks must
      // reach the webview even if the throttle timer has not fired yet.
      this.flushTranscripts();
      // 终态写一次转录快照：重启恢复后详情面板要能读到最后的转录。紧接
      // flush 之后，块已是裁剪过的窗口；失败静默降级，不挡收尾。
      await this.persistTranscriptSnapshot(id);
      // 子会话的进程在轮次结束后不再需要 —— 留着只会白占内存。
      // 已被一次重试取代时（attempts 变了），这一轮的进程早就该被清掉，
      // 但客户端槽位已经归新的一次执行，不能再按 id 误杀。
      const latest = this.sessions.get(id);
      const isCurrentAttempt = latest !== undefined && (latest.attempts ?? 1) === attempt;
      if (!latest || (latest.attempts ?? 1) === attempt) {
        await this.disposeClient(id);
        this.started.delete(id);
      }
      // 自动合并成功后释放隔离。必须在进程回收之后：Windows 上子进程的 cwd
      // 还停在 worktree 里时，目录删不掉（会留下半删的目录）。
      // 已被一次重试取代时同样**绝不能删** —— 新的一轮复用的就是这个目录。
      if (isCurrentAttempt && this.sessions.get(id)?.integration?.state === "merged") {
        await this.releaseIsolationWithRetry(id, "merged");
      }
      // 「没有产生任何提交」的子会话同样要释放隔离（目录与空分支都是残留）。
      // 已被一次重试取代时**绝不能删** —— 新的一轮还在用这个 worktree。
      const pendingEmpty = this.pendingEmptyRelease.delete(id);
      if (isCurrentAttempt && pendingEmpty) {
        await this.releaseIsolationWithRetry(id, "empty");
      }
      // 终态默认回收（`iflow.superAgent.keepWorktree`，默认关）：正常完成时
      // 删掉工作目录、**保留分支**，避免合并被跳过 / PR / manual / 中断之外
      // 的正常收尾把 worktree 永久堆在磁盘上。
      //
      // 三条边界，缺一不可：
      //  - 只对 `completed` 回收：failed / cancelled 刻意保留现场（重试要复用
      //    未完成的工作目录），`dispose()` 也从不回收；
      //  - 只对当前 attempt 回收：已被一次重试取代时新的一轮还在用这个目录；
      //  - 空分支路径（`pendingEmpty`）已经自己处理过目录与分支，不能被这里
      //    抢先删掉目录 —— 它的后台重试还要继续收尾。
      const completedNow = this.sessions.get(id)?.status === "completed";
      if (
        isCurrentAttempt &&
        !pendingEmpty &&
        completedNow &&
        !this.keepWorktreeEnabled()
      ) {
        await this.releaseIsolationWithRetry(id, "recycle");
      }
      // 合并子会话收尾：用只读 git 检测目标分支是否真的并入了当前分支，
      // 再把结果写回来源子会话的 integration（失败/中断同样要如实记）。
      await this.finalizeMergeChild(id);
      // 附件副本只服务这一轮子会话：终态（completed / failed / cancelled）
      // 一律删掉，避免跨会话堆积。旧的附件泄漏点只有 cleanup / dispose /
      // forgetMainSession，正常完成/失败/中断都不会删。
      //
      // 两道边界：只对当前 attempt 删 —— 已被一次重试取代时，新的 prepareInner
      // 已经把新一份附件 stage 到同一个 id 目录，旧的一轮绝不能把它删掉；
      // 重试会重新 stage（`stageSuperAttachments` 在 prepare 阶段调用），因此
      // 这里删除不会影响重试再次取用附件。
      if (isCurrentAttempt) {
        await rm(this.attachmentDirFor(id), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      this.pump();
    }
  }

  /**
   * 合并子会话的收尾判定。
   *
   * **只信 git，不信子会话的自述**：子会话可能只做了一半、或者把改动合到了
   * 其它地方。用只读的 `git merge-base --is-ancestor` 判断目标分支是不是真
   * 的并进了当前 HEAD，检测不出来就如实记「分支仍保留」，绝不谎报成功。
   *
   * 结果写回**来源**子会话的 integration（看板上「改动去向」看的是它）。
   */
  private async finalizeMergeChild(id: string): Promise<void> {
    const target = this.mergeTargets.get(id);
    if (!target) return;
    this.mergeTargets.delete(id);
    const child = this.sessions.get(id);
    const merged = await isBranchMerged({
      repoRoot: this.deps.repoRoot,
      branch: target.branch,
    });
    const targetBranch = (await currentBranch(this.deps.repoRoot)) ?? "当前分支";
    if (merged) {
      this.recordIntegration(
        target.sourceId,
        {
          mode: this.deps.integrationMode(),
          state: "merged",
          detail: `合并超流体已把 ${target.branch} 合入 ${targetBranch}`,
          at: Date.now(),
        },
        `merged into ${targetBranch}`,
      );
      // 分支确实并入 HEAD：来源子会话的 worktree 与分支可以清掉。
      await this.releaseIsolationWithRetry(target.sourceId, "merged");
      this.deps.onMergeResult?.({
        sourceId: target.sourceId,
        title: target.title,
        branch: target.branch,
        merged: true,
        failed: false,
        detail: `已合入 ${targetBranch}`,
      });
      return;
    }
    const failed = child?.status === "failed" || child?.status === "cancelled";
    const detail = failed
      ? `合并超流体${child?.status === "cancelled" ? "被中断" : "失败"}，${target.branch} 仍保留${
          child?.error ? `：${child.error}` : ""
        }`
      : `合并超流体没有把 ${target.branch} 合入当前分支，${target.branch} 仍保留`;
    this.recordIntegration(
      target.sourceId,
      {
        mode: this.deps.integrationMode(),
        state: failed ? "failed" : "skipped",
        needsAction: true,
        detail,
        at: Date.now(),
      },
      failed
        ? `the merge child session ${child?.status === "cancelled" ? "was interrupted" : "failed"}; ${target.branch} is kept`
        : `the merge child session did not merge ${target.branch} into the current branch; ${target.branch} is kept`,
    );
    this.deps.onMergeResult?.({
      sourceId: target.sourceId,
      title: target.title,
      branch: target.branch,
      merged: false,
      failed,
      detail,
    });
  }

  private callbacksFor(id: string): AcpClientCallbacks {
    return {
      onSessionUpdate: (notification) => {
        // SA-1 看门狗：任意 session/update（流式文本、thought、tool_call /
        // tool_call_update、plan 等）都证明子会话还活着，刷新最近进展时刻。
        // 必须放在护栏判定之前 —— 即便这一帧随后被护栏拦下，它本身也是「进程
        // 仍在产出事件」的证据，不该被算成无进展。
        this.touchWatchdog(id);
        const update = notification.update;
        // 活性采集（批次2A）：在刷活性时间戳的同时，按节流窗口留一条可查询的
        // 诊断，说明这条 update 属于哪类活动 / 哪个工具调用。共享契约没有单列
        // activity/tool_call 枚举，recordActivityDiagnostic 用确切的 "session"
        // kind + 具体消息落地，既不臆造新 kind，也让看板能看出「它在动」。
        const activityWhat = (() => {
          const toolName = "toolName" in update ? String(update.toolName ?? "") : "";
          const status = "status" in update ? String(update.status ?? "") : "";
          switch (update.sessionUpdate) {
            case "tool_call":
            case "tool_call_update":
              return `工具调用${toolName ? ` ${toolName}` : ""}${status ? `（${status}）` : ""}`;
            case "agent_message_chunk":
              return "文本流输出";
            case "agent_thought_chunk":
              return "思考流输出";
            case "plan":
              return "计划更新";
            default:
              return String(update.sessionUpdate);
          }
        })();
        this.recordActivityDiagnostic(id, activityWhat);
        const session = this.sessions.get(id);
        // **所有隔离档位都要过预检**：此前这里跳过了 repo 档（`kind !== "repo"`），
        // 而 repo 档（主仓工作区 / 合并子会话）恰恰是唯一一档「命令直接作用于
        // 用户工作区」的隔离方式 —— `git reset --hard` / `git clean -fd` 会在
        // 那里不可逆地丢掉用户未提交的改动。护栏按 `repoWorkspace` 区分档位：
        // 破坏性 git 规则只对 repo 档生效，worktree 档的判定结果不变。
        if (session) {
          const guardCtx: ChildShellGuardContext = {
            cwd: session.isolation.path,
            repoRoot: this.deps.repoRoot,
            repoWorkspace: session.isolation.kind === "repo",
            // 合并任务书的硬边界只对**真合并子会话**生效：完全信任子会话
            // 同样跑在 repo 档（主仓工作区），但它的任务书允许 push / 合并。
            // 真源就是派发时登记的合并目标表，不看隔离档位。
            mergeChild: this.mergeTargets.has(id),
            nodeModulesIsLink: isLinkedNodeModules(session.isolation.path),
            readLocalFile: (filePath) => {
              try {
                if (statSync(filePath).size > 1024 * 1024) return null;
                return readFileSync(filePath, "utf8");
              } catch {
                return null;
              }
            },
          };
          const toolFrame = {
            sessionUpdate: update.sessionUpdate,
            toolCallId: "toolCallId" in update ? update.toolCallId : undefined,
            toolName: "toolName" in update ? update.toolName : undefined,
            kind: "kind" in update ? update.kind : undefined,
            status: "status" in update ? update.status : undefined,
            title: "title" in update ? update.title : undefined,
            args: "args" in update ? update.args : undefined,
          };
          const verdict = classifyChildToolCall(toolFrame, guardCtx);
          if (verdict?.decision === "deny" && verdict.severity === "session") {
            this.blockChildSession(id, verdict.reason ?? "blocked by the host guard");
            return;
          }
          // 写 / 编辑工具不带命令文本，shell 护栏对它们完全失明。repo 档
          // 直接跑在主仓工作区，必须在同一帧上拦住改写 .git/ 元数据或宿主
          // .iflow/super/ 子会话记录的动作 —— 那会绕过全部安全网。
          const writeVerdict = classifyChildFileWrite(toolFrame, guardCtx);
          if (writeVerdict?.decision === "deny" && writeVerdict.severity === "session") {
            this.blockChildSession(id, writeVerdict.reason ?? "blocked by the host guard");
            return;
          }
        }
        // Keep the summary source (the final assistant prose) and the live
        // progress tail.
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = extractText(update.content);
          if (text) {
            // 累计文本设上限：子会话的输出没有天然上限，不设限的话内存与收尾
            // 估算的开销都会随输出长度线性增长（只保留尾部即可）。
            this.lastText.set(
              id,
              capTail((this.lastText.get(id) ?? "") + text, SUPER_TEXT_MAX_CHARS),
            );
            this.scheduleProgress(id);
          }
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = extractText(update.content);
          if (text) {
            this.lastThought.set(
              id,
              capTail((this.lastThought.get(id) ?? "") + text, SUPER_TEXT_MAX_CHARS),
            );
          }
        }
        // And feed EVERY update into the shared reducer so the detail pane
        // renders the same live transcript as the main session (tool cards,
        // thoughts, plans, nested sub-agents). Live `user_message_chunk`
        // echoes are ignored by the reducer; the task prompt is added by
        // `prepare` as the user turn.
        const transcript = this.transcriptFor(id);
        const index = applySessionUpdate(transcript.state, notification);
        if (index !== null) this.markTranscriptDirty(id, index);

        // A `plan` update is the CLI's mirror of todo_write — a FULL snapshot
        // of the child's own todolist every time (probed, CLI 0.5.19). The
        // reducer above renders it as a TaskList card in the live transcript;
        // here we also project it onto SuperSessionUi so the board timeline
        // shows the child's own steps instead of host-side stage facts.
        // Nested SubAgent plans stamp an agentId on the notification / update /
        // update._meta (wire, CLI 0.5.19) and belong to a DIFFERENT agent —
        // ignore them so another agent's todos never leak into this child.
        if (update.sessionUpdate === "plan") {
          const wire = update as { agentId?: unknown; _meta?: { agentId?: unknown } };
          const nested =
            notification.agentId ||
            (typeof wire.agentId === "string" ? wire.agentId : "") ||
            (typeof wire._meta?.agentId === "string" ? wire._meta.agentId : "");
          if (!nested) this.patchTodos(id, normalizeSuperTodos(update.entries));
        }
      },
      // 审批策略（Wave3-A）：缺省 `auto` = 既有行为（`yolo` + 自动放行兜底）；
      // `supervised` 先问策略回调（未提供/抛错/超时按拒绝）；`deny` 直接拒绝。
      // 依赖护栏对 `auto` 与 `supervised` 都是硬底线，见 `decidePermission`。
      onRequestPermission: async (request) => this.decidePermission(id, request),
      onUserQuestions: async (request) =>
        (await this.awaitQuestion(id, request.questions)) as UserQuestionsResponse,
      // Plan 模式已移除（2026-11-18）：CLI 仍可能发来 stale `_iflow/plan/exit`，
      // 按 spawn 审批策略处置（auto 放行 / deny 拒绝 / supervised 走回调），
      // 绝不让它成为 supervised 的策略后门（见 autoApproveRemovedPlanExit）。
      onExitPlanMode: async (request) => this.autoApproveRemovedPlanExit(id, request),
      onExit: (code) => {
        const session = this.sessions.get(id);
        if (!session || isTerminalSuperStatus(session.status)) return;
        this.apply(id, { type: "failed", error: `超流体内核退出（code=${code ?? "null"}）`, at: Date.now() });
        this.notifyReport(id);
      },
      onStderr: (line) => this.deps.log.debug?.(`[${id}] ${line}`),
    };
  }

  /** 该子会话的审批策略；拿不到时按缺省 `auto`（与既有行为一致）。 */
  private policyFor(id: string): ResolvedSuperSpawnPolicy {
    return this.policies.get(id) ?? resolveSpawnPolicy(null);
  }

  /**
   * 权限请求裁决。
   *
   * - `deny`：直接拒绝（映射到 agent 自己给出的 reject 选项；没有就取消）。
   * - `supervised` / `auto`：**先过依赖护栏**（保护主工作区依赖的硬底线，
   *   2026-11-11 事故）；`supervised` 随后交给策略回调，未提供/抛错/超时按拒绝；
   *   `auto` 走既有的兜底放行（shell 用 `allow_once`，其余 `allow_always`），
   *   与旧实现逐字等价。
   */
  private async decidePermission(
    id: string,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const policy = this.policyFor(id);
    if (policy.approval === "deny") {
      this.deps.log.info(
        `[${id}] 审批策略 deny：拒绝 ${request.toolCall.toolName ?? "tool"}`,
      );
      return resolvePermissionResponse(request.options, "deny");
    }

    // 依赖护栏：对 auto / supervised 都是硬底线 —— 即使审批人点了「允许」，
    // 会清空主仓依赖的命令也绝不放行。
    const guarded = this.dependencyGuard(id, request);
    if (guarded) {
      this.deps.log.warn(`[${id}] 拒绝超流体命令（保护主工作区依赖）：${guarded.reason ?? ""}`);
      return resolvePermissionResponse(request.options, "deny");
    }

    if (policy.approval === "supervised") {
      const decision = await awaitSuperPermissionDecision(
        policy.onPermissionRequest,
        toSuperPermissionRequest(request),
      );
      this.deps.log.info(
        `[${id}] 审批策略 supervised：${request.toolCall.toolName ?? "tool"} → ${decision}`,
      );
      return resolvePermissionResponse(request.options, decision);
    }

    // auto —— 既有兜底放行逻辑（yolo 下通常根本走不到这里）。
    const shell = isShellToolCall(request.toolCall);
    // shell 类必须 `allow_once`：`allow_always` 会让 CLI 对该工具的后续
    // 调用不再请求权限，宿主护栏就只看得到第一条命令（形同虚设）。
    const allow = pickChildPermissionOption(request.options, shell);
    if (!allow) {
      // 没有任何可放行的选项 —— 只能说「取消」，绝不伪造批准。
      this.deps.log.warn(
        `[${id}] 审批请求没有${shell ? " allow_once 允许选项" : "允许选项"}，按取消处理：${
          request.toolCall.toolName ?? "tool"
        }`,
      );
      return { outcome: { outcome: "cancelled" } } as RequestPermissionResponse;
    }
    this.deps.log.debug?.(
      `[${id}] 自动放行 ${request.toolCall.toolName ?? "tool"}（免确认模式，${allow.kind}）`,
    );
    return {
      outcome: { outcome: "selected", optionId: allow.optionId },
    } as RequestPermissionResponse;
  }

  /**
   * 依赖护栏（纯判定）：shell 命令命中「会破坏主工作区依赖」的规则时返回理由，
   * 否则返回 null。与审批策略无关 —— 它是所有放行路径的共同底线。
   */
  private dependencyGuard(
    id: string,
    request: RequestPermissionRequest,
  ): { reason?: string } | null {
    const session = this.sessions.get(id);
    if (!session || !isShellToolCall(request.toolCall)) return null;
    const command = extractShellCommand(request.toolCall);
    if (!command) return null;
    const verdict = classifyChildShellCommand(command, {
      cwd: session.isolation.path,
      repoRoot: this.deps.repoRoot,
      repoWorkspace: session.isolation.kind === "repo",
      // 与预检路径同一口径：合并边界只看真合并子会话。
      mergeChild: this.mergeTargets.has(id),
      nodeModulesIsLink: isLinkedNodeModules(session.isolation.path),
    });
    return verdict.decision === "deny" ? { reason: verdict.reason } : null;
  }

  /**
   * 预检命中（`session` 档）时终止子会话，并让原因可见。
   *
   * 预检路径只能终止整个子会话（wire 上没有「拒掉单次调用」的通道），而
   * `session` 档的规则都意味着命令会在用户工作区里造成不可逆损失 —— 停掉
   * 子会话是唯一能保证命令不执行的处置。
   *
   * 原因可见性分档：
   *  - worktree 档沿用既有行为（`cancel` + 日志）：它的命中只关乎子会话自己的
   *    临时目录，看板显示「已中断」足够；
   *  - repo 档改用 `failed` 并把原因写进 `error`：`cancel` 只会留下「被打断」，
   *    主会话与看板看不出为什么 —— 那是刚被补齐的护栏，原因必须可追溯。
   *    同时打上 `interrupted` 标记，收尾路径不会代提交、不会自动合并。
   */
  private blockChildSession(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return;
    this.deps.log.warn(`[${id}] 预检拒绝超流体命令并终止会话：${reason}`);
    if (session.isolation.kind !== "repo") {
      void this.cancel(id);
      return;
    }
    // 先占住终态再杀进程：内核退出会被记成 failed，终态粘性让随后的迟到
    // 事件无法改写这条结论（与 cancel 的顺序纪律一致）。
    this.interrupted.set(id, session.attempts ?? 1);
    this.apply(
      id,
      {
        type: "failed",
        error: `Host guard blocked a destructive command and stopped the child session: ${reason}`,
        at: Date.now(),
      },
      `护栏拦截：${reason}`,
    );
    const client = this.clients.get(id);
    if (client && session.cliSessionId) {
      try {
        client.cancel(session.cliSessionId);
      } catch {
        // 进程可能已经死了 —— 下面的 dispose 会兜住。
      }
    }
    void this.disposeClient(id);
    this.notifyReport(id);
  }

  /**
   * 处理遗留的 `_iflow/plan/exit`（计划模式已移除，2026-11-18）。
   *
   * 子会话理论上不会再进入 plan 模式（宿主在 `session/new` 后推 yolo），但 CLI
   * 内部仍保留该模式与 `exit_plan_mode` 工具。旧会话归档、外部
   * `~/.iflow/settings.json` 的 `approvalMode: "plan"` 仍可能让它发来
   * `_iflow/plan/exit`。这条 stale 请求**不能成为策略绕过的后门**：
   *
   *  - `auto`（缺省）：无审批语义，记警告后快速放行，与既有行为一致；
   *  - `deny`：一律拒绝；
   *  - `supervised`：走与权限请求同一个策略回调裁决（未提供/抛错/超时按拒绝），
   *    决不允许一个已移除模式的遗留请求悄悄拿到批准、使 supervised 子会话
   *    在该节点上变成无审批执行。
   */
  private async autoApproveRemovedPlanExit(
    id: string,
    request: ExitPlanModeRequest,
  ): Promise<ExitPlanModeResponse> {
    const planChars = (request.plan ?? "").length;
    const policy = this.policyFor(id);
    if (policy.approval === "auto") {
      this.deps.log.warn(
        `[${id}] plan mode removed: auto-approving stale _iflow/plan/exit (${planChars} chars of plan text)`,
      );
      return { approved: true };
    }
    if (policy.approval === "deny") {
      this.deps.log.warn(`[${id}] plan mode removed: 审批策略 deny 拒绝 stale _iflow/plan/exit`);
      return { approved: false, reason: "审批策略 deny 拒绝了已移除的 Plan 模式退出请求" };
    }
    // supervised：按策略回调裁决，安全默认（回调缺失/抛错/超时）为 deny。
    const decision = await awaitSuperPermissionDecision(policy.onPermissionRequest, {
      sessionId: request.sessionId || id,
      summary: `退出已移除的 Plan 模式（计划 ${planChars} 字符）`,
    });
    const approved = decision === "allow_once" || decision === "allow_always";
    this.deps.log.warn(
      `[${id}] plan mode removed: supervised 策略 ${approved ? "批准" : "拒绝"} stale _iflow/plan/exit（${decision}）`,
    );
    return approved
      ? { approved: true }
      : { approved: false, reason: `审批策略未批准 stale _iflow/plan/exit（裁决：${decision}）` };
  }

  /** Lazily create the transcript buffer for a child session. */
  private transcriptFor(id: string): SuperTranscript {
    let entry = this.transcripts.get(id);
    if (!entry) {
      entry = { state: initialSessionState(), dirtyFrom: null };
      this.transcripts.set(id, entry);
    }
    return entry;
  }

  /** Record the lowest mutated block index and schedule a throttled push. */
  private markTranscriptDirty(id: string, index: number): void {
    const entry = this.transcripts.get(id);
    if (!entry) return;
    if (entry.dirtyFrom === null || index < entry.dirtyFrom) entry.dirtyFrom = index;
    this.scheduleTranscriptFlush();
  }

  /**
   * Streaming chunks arrive far faster than a human can read; coalesce them
   * into one message per ~120ms (the same idea as the main store's throttled
   * flush, at a smaller budget because a child transcript is short-lived).
   */
  private scheduleTranscriptFlush(): void {
    if (this.transcriptTimer) return;
    const timer = setTimeout(() => {
      this.transcriptTimer = null;
      this.flushTranscripts();
    }, 120);
    if (typeof timer.unref === "function") timer.unref();
    this.transcriptTimer = timer;
  }

  /** Push every dirty child transcript to the host (incremental from `from`). */
  private flushTranscripts(): void {
    const send = this.deps.onTranscript;
    if (!send) return;
    for (const [id, entry] of this.transcripts) {
      const from = entry.dirtyFrom;
      if (from === null) continue;
      entry.dirtyFrom = null;
      send(id, from, entry.state.blocks.slice(from));
      this.evictTranscriptPayloads(entry);
    }
  }

  /**
   * 宿主侧子会话转录的载荷裁剪（**与 webview 同一口径**）。
   *
   * 子会话的转录只活在宿主内存里（不落盘），但工具输出（64K 上限）、结构化
   * diff（256K）、图片 data URL（≤8MB）会随子会话跑得越久堆得越多 —— 一个
   * 长任务就能把扩展宿主顶到几百 MB。这里复用 webview 的
   * `evictBlockPayloads`：同样的块数上限（`EVICT_KEEP_BLOCKS`，必然大于
   * 挂载窗口）与字符预算（`EVICT_BUDGET_CHARS`），只释放保留窗口之外的旧
   * 载荷并打 `evicted` 标记，最新轮次永远可读。
   *
   * 裁剪只动载荷、不删块：详情面板的增量通道按索引合并（`from`），删块会
   * 让索引错位。已在窗口内的块不会被改写，`evictBlockPayloads` 无变化时返回
   * 原数组（幂等），因此每次推送后顺手跑一遍没有额外拷贝。
   */
  private evictTranscriptPayloads(entry: SuperTranscript): void {
    const blocks = entry.state.blocks;
    const evicted = evictBlockPayloads(blocks, EVICT_KEEP_BLOCKS);
    if (evicted !== blocks) entry.state.blocks = evicted;
  }

  /**
   * 终态写一次转录快照，供宿主重启恢复后详情面板读回。
   *
   * 调用点在 `prepare()` 的 finally —— 紧接 `flushTranscripts()` 之后，此时
   * `entry.state.blocks` 已是 `evictBlockPayloads` 裁剪过的窗口（不做第二套
   * 磁盘保真算法）。写失败/无目录都静默降级（记日志不抛），绝不拖住收尾。
   * 若子会话在写之前已被删除（`forgetChild` 清了 transcripts），跳过，
   * 避免把已删子会话的转录复活到磁盘上。
   */
  private async persistTranscriptSnapshot(id: string): Promise<void> {
    const dir = this.deps.superStoreDir?.();
    if (!dir) return;
    const entry = this.transcripts.get(id);
    if (!entry) return;
    try {
      await writeSuperTranscriptSnapshot(dir, id, entry.state.blocks.slice());
    } catch (error) {
      this.deps.log.warn(`super agent: transcript snapshot write failed: ${errorMessage(error)}`);
    }
  }

  /**
   * 把子会话的提问挂起，直到用户在看板作答或超时。
   *
   * 超时按「未回答」继续（空答案），与主会话的纪律一致：宁可让 agent 自己判断，
   * 也不让它永久阻塞。
   */
  private awaitQuestion(id: string, questions: UserQuestion[]): Promise<unknown> {
    const requestId = `${id}-question-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 旧定时器（上一轮提问留下的）到点时，若 resolver 或 pending 已不是
        // 这一份，绝不能碰当前状态 —— 那会把新一轮正在等回答的子会话误复位，
        // 或删掉它的 resolver 让真正的应答永远收不了口。
        const resolver = this.resolvers.get(id);
        if (!resolver || resolver.requestId !== requestId) return;
        const session = this.sessions.get(id);
        if (session?.pending?.requestId !== requestId) {
          this.discardQuestionResolver(id);
          return;
        }
        this.discardQuestionResolver(id);
        // 与 respond() 走同一条 reducer 迁移：status 从 awaiting_input 回到
        // running、pending 清空。原来只清 pending 不动 status，看板会永远显示
        // 「等待你回答」却无可答问题，心跳的等待计数也一直虚高。
        this.apply(id, { type: "input_resolved", at: Date.now() });
        resolve({ answers: {} });
      }, SUPER_PENDING_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();

      this.resolvers.set(id, { resolve, timer, requestId });
      const pending: SuperPending = {
        kind: "question",
        requestId,
        questions,
        deadline: Date.now() + SUPER_PENDING_TIMEOUT_MS,
        timeoutMs: SUPER_PENDING_TIMEOUT_MS,
      };
      this.apply(id, { type: "needs_input", pending, at: Date.now() });
      this.notifyReport(id);
    });
  }

  // --- 集成（自动合并 / PR） -------------------------------------------------

  /** 串行执行集成：并发合并同一个工作区会把仓库搅乱。 */
  private async integrate(id: string, attempt: number): Promise<void> {
    this.integrationChain = this.integrationChain
      .then(() => this.runIntegration(id, attempt))
      .catch((error) => {
        const reason = errorMessage(error);
        this.deps.log.error(`超流体集成失败：${reason}`);
        // runIntegration 抛错时若还没写下任何结论，看板会停在旧状态、
        // maybeRequestAgentMerge 读到空直接 return —— 集成结果彻底丢失。补写
        // 一条 failed + needsAction：看板有明确去向，主会话也会被请去处理分支。
        // 若抛错前已记下结论（例如 record 之后才失败），不覆盖它。
        if (this.sessions.get(id)?.integration) return;
        this.recordIntegration(
          id,
          {
            mode: this.deps.integrationMode(),
            state: "failed",
            needsAction: true,
            detail: `自动集成失败：${reason}；分支已保留，请手动合并或让智能体合并`,
            at: Date.now(),
          },
          `automatic integration failed: ${reason}; the branch is kept and still has to be merged`,
        );
      });
    await this.integrationChain;
  }

  /**
   * 只读读取主工作区状态。
   *
   * 收敛成一个方法是为了单测能覆盖它：合并提示的误报根源正是「用旧快照决定
   * 文案」—— 单测注入「合并前脏、合并后干净」的序列即可验证文案只认实时结果。
   */
  private readWorkingTree(): Promise<WorkingTreeState> {
    return inspectWorkingTree(this.deps.repoRoot);
  }

  private async runIntegration(id: string, attempt: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || this.disposed) return;
    // 收尾守卫（入口）：集成是**串行排队**的，一个子会话可能排了很久才轮到。
    // 等到它时用户可能早就中断了它 —— 那就不能再把它的改动合进主分支。
    const blocked = this.settleBlockReason(id, attempt);
    if (blocked) {
      this.recordInterrupted(id, blocked);
      return;
    }
    const mode = this.deps.integrationMode();
    if (mode === "manual") return;

    const isolation = session.isolation;
    if (isolation.kind !== "git_worktree" || !isolation.branch || !isolation.baseRef) return;

    const record = (
      integration: Omit<SuperIntegration, "mode" | "at">,
      reasonEn?: string,
    ): void => {
      this.recordIntegration(id, { mode, at: Date.now(), ...integration }, reasonEn);
    };

    if (
      !(await branchHasUnmergedCommits({
        repoRoot: this.deps.repoRoot,
        branch: isolation.branch,
        baseRef: isolation.baseRef,
      }))
    ) {
      // 分支上没有任何独有提交 → 删掉 worktree 目录与这条空分支不会丢任何
      // 东西（子会话若在 worktree 里另建过分支，提交在那个分支上，删目录
      // 也不会删掉它）。
      //
      // 这里**不直接删**：CLI 进程的 cwd 还停在这个 worktree 里，Windows 上
      // 目录删不掉。先登记，实际释放由 prepare() 的 finally 在进程回收之后
      // 执行（与「合并成功后释放隔离」同一时序）。
      record(
        { state: "not_needed", detail: "无需合并：超流体没有产生任何提交" },
        "the child session produced no commits",
      );
      this.pendingEmptyRelease.add(id);
      return;
    }

    if (mode === "merge") {
      const tree = await this.readWorkingTree();
      if (!tree.available) {
        record(
          {
            state: "skipped",
            needsAction: true,
            detail: "读不到主工作区状态（git 不可用），分支已保留待你手动合并",
          },
          "the state of the main workspace could not be read (git is unavailable)",
        );
        return;
      }
      // 中间态一律让路：在别人的合并/变基上再叠一次，冲突回滚可能带走用户工作。
      if (tree.inProgress) {
        record(
          {
            state: "skipped",
            needsAction: true,
            detail: `主工作区正处于 ${tree.inProgress} 中间态，分支已保留待你手动合并`,
          },
          `the main workspace is in the middle of a ${tree.inProgress}`,
        );
        return;
      }
      // 对象库预演：不碰索引与工作区就知道会不会冲突。冲突时连 merge 都不启动。
      const preview = await previewMerge({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
      if (preview.available && !preview.clean) {
        record(
          {
            state: "conflict",
            needsAction: true,
            detail: `与当前分支存在内容冲突（已预演，工作区未被改动）；分支 ${isolation.branch} 仍在，请手动合并解决`,
          },
          "the branch conflicts with the current branch (the merge was previewed; the working tree was not modified)",
        );
        return;
      }
      // 脏工作区不再一律挡路：git 能带着未提交改动合并其它文件（用户的改动原样
      // 保留在工作区）。只有合并会改动「你正在改的已跟踪文件」时才必须让路 ——
      // 未跟踪文件只在同名时才被 git 拒绝，而那次拒绝发生在动手之前。
      if (!tree.clean) {
        if (!preview.available) {
          record(
            {
              state: "skipped",
              needsAction: true,
              detail: `主工作区有 ${tree.dirtyCount} 处未提交改动，且当前 git 无法预演合并，分支已保留待你手动合并`,
            },
            `the main workspace has ${tree.dirtyCount} uncommitted change(s) and this git version cannot preview the merge`,
          );
          return;
        }
        const overlap = tree.trackedPaths.filter((file) => preview.paths.includes(file));
        if (overlap.length > 0) {
          record(
            {
              state: "skipped",
              needsAction: true,
              detail: `主工作区有未提交改动，其中 ${overlap.length} 个文件与超流体的改动重叠（${describePaths(overlap)}），分支已保留待你手动合并`,
            },
            `the main workspace has uncommitted changes in ${overlap.length} file(s) that overlap the child session's changes (${describePathsEn(overlap)})`,
          );
          return;
        }
      }
      // 最后一道闸：真正动手合并前再确认一次这一轮仍然算数。
      // 上面的检查可能已经过时（git 调用要时间，用户随时可能点中断）——
      // 用户喊停之后，这一轮的改动绝不能进主分支。
      const stillBlocked = this.settleBlockReason(id, attempt);
      if (stillBlocked) {
        this.recordInterrupted(id, stillBlocked);
        return;
      }
      const result = await mergeBranch({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
      if (result.ok) {
        const target = (await currentBranch(this.deps.repoRoot)) ?? "当前分支";
        // 文案以**合并之后**的实时工作区为准：合并前的 `tree` 只是一次快照，
        // 用户可能在这期间提交了改动（或被前一次合并吸收），照抄旧快照就会
        // 谎报「你本地未提交的 N 处改动原样保留」—— 主会话会据此让用户去
        // 清理并不存在的东西。真正需要如实告知的是「此刻还留在工作区里的
        // 未提交改动」。探测失败（null）时什么都不声称，只报已合入。
        const live = await this.readWorkingTree().catch(() => null);
        const kept = describeKeptLocalChanges(live);
        record(
          {
            state: "merged",
            detail: kept ? `已合入 ${target}（${kept.zh}）` : `已合入 ${target}`,
          },
          kept ? `merged into ${target} (${kept.en})` : `merged into ${target}`,
        );
      } else {
        // 合并没成：确认它到底有没有启动（预演之后 HEAD 可能被别处改过）。
        const after = await inspectWorkingTree(this.deps.repoRoot);
        if (after.inProgress === "merge") {
          record(
            {
              state: "conflict",
              needsAction: true,
              detail: `合并冲突且自动撤销失败，仓库可能停在合并中间态（可用 git merge --abort 恢复）；分支 ${isolation.branch} 仍在：${result.error}`,
            },
            "the merge conflicted and the automatic rollback failed; the repository may be stuck in a merge state (recover it with `git merge --abort`)",
          );
        } else {
          record(
            {
              state: "skipped",
              needsAction: true,
              detail: `git 拒绝合并，工作区未被改动（常见原因：未跟踪文件与超流体新增的文件同名，请先移走或提交它）；分支 ${isolation.branch} 已保留：${result.error}`,
            },
            "git refused the merge and the working tree was not modified (a common cause is an untracked file with the same name as a file the child session added)",
          );
        }
      }
      return;
    }

    // mode === "pr"
    if (!(await remoteOriginUrl(this.deps.repoRoot))) {
      record(
        { state: "failed", needsAction: true, detail: "仓库没有配置 origin 远程，分支已保留" },
        "the repository has no origin remote configured",
      );
      return;
    }
    if (!(await ghAvailable())) {
      record(
        {
          state: "failed",
          needsAction: true,
          detail: "未找到 gh CLI，分支已保留（可手动合并或自行推送）",
        },
        "the gh CLI was not found",
      );
      return;
    }
    const pushed = await pushBranch({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
    if (!pushed.ok) {
      record(
        { state: "failed", needsAction: true, detail: `推送分支失败：${pushed.error}` },
        `pushing the branch failed: ${pushed.error}`,
      );
      return;
    }
    const base = (await currentBranch(this.deps.repoRoot)) ?? isolation.baseRef;
    const pr = await createPullRequest({
      repoRoot: this.deps.repoRoot,
      branch: isolation.branch,
      base,
      title: session.title,
      body: buildPullRequestBody(session),
    });
    if (pr.ok) {
      record(
        {
          state: "pr_created",
          detail: `已推送到 origin，目标分支 ${base}`,
          url: pr.url || undefined,
        },
        `pushed to origin, target branch ${base}`,
      );
    } else {
      record(
        { state: "failed", needsAction: true, detail: `创建 PR 失败：${pr.error}` },
        `creating the pull request failed: ${pr.error}`,
      );
    }
  }

  /**
   * 自动集成没能把改动带回来时，自动请主会话智能体合并。
   *
   * 只在 merge 模式下触发：pr 模式的语义是开 PR（本地合并违背用户的选择），
   * manual 模式压根不做集成（用户要自己收拾分支）。`needsAction` 是宿主给
   * 「需要人动手」打的结构化标记 —— 「子会话没有产生任何提交」不带这个标记，
   * 那时没有任何东西可合并，不该白跑一轮。
   */
  private maybeRequestAgentMerge(id: string): void {
    const session = this.sessions.get(id);
    const integration = session?.integration;
    if (!session || !integration) return;
    if (integration.mode !== "merge") return;
    if (integration.state === "merged") return;
    if (!integration.needsAction) return;
    // The reason goes into the merge task book, which is **model-facing**:
    // it must be the English fact description, not the Chinese board text.
    this.deps.onNeedAgentMerge?.(session, this.integrationReasonEn.get(id) ?? "");
  }

  /**
   * 正常结束后把子会话的未提交改动固化成一次提交（只发生在它自己的
   * worktree，主工作区完全不受影响）。失败时把错误交回调用方如实上报。
   *
   * **主仓工作区档绝不代提交**：那里的 `git add -A` 会把用户尚未提交的其它
   * 改动一起卷进合并提交 —— 那等于替用户改了他的工作区。合并子会话的产出
   * 是合并提交本身，不需要也不允许宿主再补一刀。
   *
   * **被中断的一轮绝不代提交**：用户喊停之后，这一轮的产物不该再被加工成
   * 提交（守卫见 {@link canSettle}）。
   */
  private async commitChildWork(
    id: string,
    isolation: SuperSessionUi["isolation"],
    attempt: number,
  ): Promise<{ committed: boolean; files: number; error?: string; interrupted?: boolean }> {
    // 守卫放在**入口**：调用点再多也绕不过去。
    if (!this.canSettle(id, attempt)) {
      return { committed: false, files: 0, interrupted: true };
    }
    if (isolation.kind !== "git_worktree" || !isolation.path) {
      return { committed: false, files: 0 };
    }
    const session = this.sessions.get(id);
    if (!session) return { committed: false, files: 0 };
    const result = await commitWorktree({
      repoRoot: this.deps.repoRoot,
      worktreePath: isolation.path,
      message: `super-agent: ${session.title}\n\n${this.summarize(id)}`,
    });
    if (result.error) {
      this.deps.log.warn(`超流体代提交失败：${result.error}`);
    } else if (result.committed) {
      this.deps.log.info(`super agent: ${id} 宿主代提交 ${result.files} 个文件`);
    }
    return result;
  }

  /** 补一条汇报：终态粘性会丢弃状态事件，元数据补记不走状态机。 */
  private appendReport(id: string, report: SuperReport): void {
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.set(id, {
      ...current,
      reports: [...current.reports, report],
      updatedAt: report.at,
    });
    this.emit();
  }

  /**
   * **收尾守卫**：这一轮的收尾动作（宿主代提交 / 自动合并）还算不算数。
   *
   * 用户点了中断 → 状态变 cancelled（终态粘性），但内核那边的 promise 照样
   * 会 resolve（它可能刚好跑完，也可能被 kill 后回一个 cancelled）。收尾代码
   * 如果只看「内核有没有正常返回」，就会在用户喊停之后继续代提交、并把改动
   * 自动合并进当前分支 —— 那等于无视用户的停止意图。
   *
   * 三个条件缺一不可：
   *  - 这一轮**没被中断**（`interrupted` 里没有这一轮的序号）；
   *  - 还是**同一次尝试**（被一次重试取代的那一轮不算数 —— 重试要能直达
   *    未完成的现场，不能把上一轮的半成品也提交了）；
   *  - **会话还在**（已被清理掉的会话不算数）。
   *
   * 注意这里刻意**不**看会话状态：「完成」也是终态，而收尾恰恰跑在完成
   * 事件之后 —— 用状态判断会把每一次正常完成都误判成「不许收尾」。
   */
  private canSettle(id: string, attempt: number): boolean {
    return this.settleBlockReason(id, attempt) === null;
  }

  /**
   * 收尾被挡住的原因（null = 这一轮仍然算数）。
   *
   * 单独抽出来是为了让「如实记录」能说清**为什么**没落改动：是用户喊停、
   * 还是被一次重试取代 —— 两者对用户的含义完全不同。
   */
  private settleBlockReason(
    id: string,
    attempt: number,
  ): "interrupted" | "superseded" | "gone" | null {
    const session = this.sessions.get(id);
    if (!session) return "gone";
    if (this.interrupted.get(id) === attempt) return "interrupted";
    if ((session.attempts ?? 1) !== attempt) return "superseded";
    return null;
  }

  /**
   * 收尾被挡住时：如实记「改动保留在分支（未合并）」。
   *
   * 不能悄悄跳过 —— 看板与主会话汇报都要知道「这个分支还在磁盘上、改动没
   * 进主分支」，否则用户会以为白跑了一场。`needsAction` 刻意为 false：
   * 用户是**主动**喊停的，不该再自动派智能体去合并它；分支与工作目录仍在，
   * 用户想合并时随时可以手动合并或让智能体合并。
   */
  private recordInterrupted(
    id: string,
    reason: "interrupted" | "superseded" | "cancelled" | "gone",
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // 已经被一次重试取代：当前这条记录属于**新一轮**，上一轮的结论不能写到
    // 它头上（会把新一轮自己的集成结果盖掉 —— 分支是共享的，新一轮的结果
    // 才是权威的）。
    if (reason === "superseded") return;
    // 主仓工作区档（合并子会话）：它的结果由 finalizeMergeChild 写回**来源**
    // 子会话的 integration。而且它的 path 是主仓根 —— 说「改动保留在工作
    // 目录」是假的。
    if (session.isolation.kind === "repo") return;
    // 已经有集成结果（例如合并子会话的只读判定）就别覆盖它。
    if (session.integration) return;
    const branch = session.isolation.branch;
    const what = reason === "cancelled" ? "超流体的回合被取消" : "超流体已被中断";
    this.recordIntegration(
      id,
      {
        mode: this.deps.integrationMode(),
        state: "skipped",
        needsAction: false,
        detail: branch
          ? `${what}，改动保留在分支 ${branch}（未合并）`
          : `${what}，改动保留在工作目录（未合并）`,
        at: Date.now(),
      },
      reason === "cancelled"
        ? "the child session's turn was cancelled; its changes are kept on the branch and were not merged"
        : "the child session was interrupted; its changes are kept on the branch and were not merged",
    );
  }

  /**
   * 写入集成结果（元数据补记，不经过状态机 —— 终态会话的事件会被丢弃）。
   *
   * `reasonEn` 是这条结果的**模型面向**英文说明：中文的 `detail` 给看板看，
   * 英文的 `reasonEn` 进汇报提示词与合并任务书。两份由同一个调用点给出，
   * 所以不会各说各话。
   */
  private recordIntegration(
    id: string,
    integration: SuperIntegration,
    reasonEn?: string,
  ): void {
    const current = this.get(id);
    if (!current) return;
    if (reasonEn) this.integrationReasonEn.set(id, reasonEn);
    else this.integrationReasonEn.delete(id);
    const next = withIntegration(current, integration);
    // 历史子会话不在 sessions 里 —— 补记要写回 archived，否则合并结果会丢。
    if (this.sessions.has(id)) {
      this.sessions.set(id, next);
    } else {
      for (const [owner, records] of this.archived) {
        if (!records.some((s) => s.id === id)) continue;
        this.archived.set(owner, records.map((s) => (s.id === id ? next : s)));
      }
    }
    this.emit();
    // merge 诊断：改动去向（自动合并 / PR / 保留分支）作为生命周期节点入时间线。
    this.recordDiagnostic(
      id,
      "merge",
      integration.state === "skipped" || integration.state === "conflict" ? "warn" : "info",
      `集成结果：${integration.state}${integration.detail ? ` — ${integration.detail}` : ""}`,
      integration.at,
    );
    this.deps.log.info(
      `super agent: ${id} 集成 ${integration.state}${integration.detail ? ` — ${integration.detail}` : ""}`,
    );
  }

  /**
   * 释放隔离，并在**可重试**的失败上安排有限次后台重试。
   *
   * 有意保留的失败（有未提交改动、分支未并入 HEAD）不重试 —— 重试多少次都
   * 不会变好，只会把定时器白白占着。
   */
  private async releaseIsolationWithRetry(
    id: string,
    mode: "merged" | "empty" | "recycle",
  ): Promise<void> {
    const outcome = await this.releaseIsolation(id, mode);
    if (!outcome.ok && outcome.retryable) {
      this.scheduleReleaseRetry(id, mode, outcome.reason);
    }
  }

  /** `iflow.superAgent.keepWorktree`（默认 false = 完成即回收工作目录）。 */
  private keepWorktreeEnabled(): boolean {
    return this.deps.keepWorktree?.() ?? false;
  }

  /**
   * 释放隔离：删掉 worktree 目录（以及某些路径下的本地分支），只保留看板记录。
   *
   * 三条路径共用一道闸门骨架，差别只在「分支能不能删」的判据：
   *  - `merged`：分支已并入 HEAD → 可以删分支（`isBranchMerged` 复核）；
   *  - `empty`：分支上没有任何独有提交 → 删分支不会丢东西
   *    （`branchHasUnmergedCommits` 复核，判据是 baseRef..branch 为空）；
   *  - `recycle`：正常完成后的默认回收 → 只删目录，**分支一律保留**
   *    （分支上可能有还没人审的提交，删掉就是丢提交）。
   *
   * 幂等：已释放（`released` 为真）直接成功，可重复调用。
   *
   * 调用时机由调用方保证：必须在子会话 CLI 进程退出之后。Windows 上进程的
   * cwd 还停在 worktree 里时，目录是删不掉的。
   */
  private async releaseIsolation(
    id: string,
    mode: "merged" | "empty" | "recycle",
  ): Promise<ReleaseOutcome> {
    if (mode === "merged") return this.releaseMergedIsolation(id);
    if (mode === "recycle") return this.releaseWorktreeKeepingBranch(id);
    return this.releaseEmptyIsolation(id);
  }

  /**
   * 合并成功后释放隔离：删掉 worktree 目录与本地分支，只保留看板记录。
   *
   * 三道保守闸门，任何一道不过都**不删**并如实返回：
   *  1. `released` 已为真 → 磁盘上早没了，直接成功。
   *  2. worktree 里还有未提交改动 → 删目录会永久丢数据（用户也可能在里面手动
   *     改过），留给用户自己处置。**有意保留，不重试。**
   *  3. `removeWorktree` 没删干净 / 分支没删掉 → 可重试（磁盘层面的偶发
   *     失败，比如子进程刚退出、文件仍被占用）。
   *
   * 「分支还没并入 HEAD」也是有意保留，不重试 —— 重试多少次它都不会并入。
   */
  private async releaseMergedIsolation(id: string): Promise<ReleaseOutcome> {
    const session = this.get(id);
    if (!session) return { ok: true };
    const isolation = session.isolation;
    if (isolation.kind !== "git_worktree") return { ok: true };
    if (!isolation.path || !isolation.branch) return { ok: true };
    if (isolation.released) return { ok: true };

    if (await worktreeHasUncommittedChanges(isolation.path)) {
      this.deps.log.warn(
        `super agent: ${id} 的工作目录还有未提交改动，保留 worktree 与分支 ${isolation.branch}`,
      );
      return { ok: false, retryable: false, reason: "工作目录还有未提交改动" };
    }

    // 删分支前再核一次「真的并入 HEAD」。调用方只在 merged 之后调用，但这里
    // 不能拿状态当授权：分支可能被别处改动过（或记录来自一次被手工修改的
    // 归档），删掉未合并的分支就是丢提交。
    if (!(await isBranchMerged({ repoRoot: this.deps.repoRoot, branch: isolation.branch }))) {
      this.deps.log.warn(
        `super agent: ${id} 的分支 ${isolation.branch} 尚未并入当前 HEAD，保留 worktree 与分支`,
      );
      return { ok: false, retryable: false, reason: "分支尚未并入当前 HEAD" };
    }

    // 刻意不传 baseRef：baseRef 是分支起点，合并后分支的提交虽然已经在 HEAD
    // 里，却不再以 baseRef 为祖先，`git rev-list baseRef..branch` 会把它们
    // 数成「未合并」，分支反而被保留。合并已由上面的 isBranchMerged 确认，
    // 这个核验本身就是删分支的依据（branchDeletionVerified）。
    const result = await removeWorktree({
      repoRoot: this.deps.repoRoot,
      targetPath: isolation.path,
      branch: isolation.branch,
      keepBranch: false,
      branchDeletionVerified: true,
    });
    if (!result.removed || result.branchKept) {
      const reason = result.reason ?? "目录或分支未能删除";
      this.deps.log.warn(
        `super agent: ${id} 隔离清理未完成（removed=${result.removed}, branchKept=${result.branchKept}）：${reason}`,
      );
      return { ok: false, retryable: true, reason };
    }

    // 记录保留、只打 released：看板仍要能说清「改动去了哪里」。
    this.markReleased(id);
    this.deps.log.info(
      `super agent: ${id} 合并成功，已清理 worktree 与分支 ${isolation.branch}`,
    );
    return { ok: true };
  }

  /**
   * 「没有产生任何提交」的隔离释放：删掉 worktree 目录与那条空分支。
   *
   * 与合并路径的区别只有一处：**不要求分支并入 HEAD** —— 分支上本来就没有
   * 独有提交，删掉它不会丢任何东西。其余闸门一致：
   *  - 有未提交改动 → 有意保留（删目录就是丢数据），不重试、不谎称已清理；
   *  - 分支上突然出现未合并提交（状态在这期间变了）→ 有意保留，不重试；
   *  - 目录/分支删不掉 → 可重试。
   *
   * 子会话可能在自己的 worktree 里另建过分支（那样提交不在
   * `iflow/super/` 分支上）：删目录不会删掉那个分支，提交仍在。
   */
  private async releaseEmptyIsolation(id: string): Promise<ReleaseOutcome> {
    const session = this.get(id);
    if (!session) return { ok: true };
    const isolation = session.isolation;
    if (isolation.kind !== "git_worktree") return { ok: true };
    if (!isolation.path || !isolation.branch) return { ok: true };
    if (isolation.released) return { ok: true };

    const keep = (detail: string, reasonEn: string): ReleaseOutcome => {
      this.deps.log.warn(`super agent: ${id} ${detail}，保留 worktree 与分支 ${isolation.branch}`);
      this.recordIntegration(
        id,
        {
          mode: session.integration?.mode ?? this.deps.integrationMode(),
          state: "skipped",
          detail,
          at: Date.now(),
        },
        reasonEn,
      );
      return { ok: false, retryable: false, reason: detail };
    };

    if (await worktreeHasUncommittedChanges(isolation.path)) {
      return keep(
        "超流体没有产生任何提交，工作目录保留（还有未提交改动）",
        "the child session produced no commits and the working directory still has uncommitted changes",
      );
    }

    // 删分支前再核一次「确实没有独有提交」—— 状态可能在这期间变了
    // （比如子会话临收尾前才提交）。
    const baseRef = isolation.baseRef;
    if (!baseRef) {
      return keep(
        "超流体没有产生任何提交，工作目录保留（缺少分支起点，无法确认分支为空）",
        "the child session produced no commits and the branch start point is unknown, so the branch cannot be confirmed empty",
      );
    }
    if (
      await branchHasUnmergedCommits({
        repoRoot: this.deps.repoRoot,
        branch: isolation.branch,
        baseRef,
      })
    ) {
      return keep(
        "超流体没有产生任何提交（分支上出现新提交），工作目录保留",
        "the child session produced no commits, but new commits appeared on the branch",
      );
    }

    // 上面已用 branchHasUnmergedCommits 核过「分支上没有独有提交」：删分支
    // 的依据是这次核验，因此配合 branchDeletionVerified（baseRef 只用于核验，
    // 不再重复传给 removeWorktree 做第二次计数）。
    const result = await removeWorktree({
      repoRoot: this.deps.repoRoot,
      targetPath: isolation.path,
      branch: isolation.branch,
      keepBranch: false,
      branchDeletionVerified: true,
    });
    if (!result.removed || result.branchKept) {
      const reason = result.reason ?? "目录或分支未能删除";
      this.deps.log.warn(
        `super agent: ${id} 空分支的 worktree 清理未完成（removed=${result.removed}, branchKept=${result.branchKept}）：${reason}`,
      );
      this.recordIntegration(
        id,
        {
          mode: session.integration?.mode ?? this.deps.integrationMode(),
          state: "not_needed",
          detail: "无需合并：超流体没有产生任何提交，工作目录清理未完成（稍后重试）",
          at: Date.now(),
        },
        "the child session produced no commits and its working directory could not be cleaned up yet",
      );
      return { ok: false, retryable: true, reason };
    }

    this.markReleased(id);
    this.recordIntegration(
      id,
      {
        mode: session.integration?.mode ?? this.deps.integrationMode(),
        state: "not_needed",
        detail: "无需合并：超流体没有产生任何提交，工作目录已清理",
        at: Date.now(),
      },
      "the child session produced no commits; its working directory was cleaned up",
    );
    this.deps.log.info(
      `super agent: ${id} 没有产生任何提交，已清理 worktree 与分支 ${isolation.branch}`,
    );
    return { ok: true };
  }

  /**
   * 终态默认回收：删掉工作目录，**分支一律保留**。
   *
   * 这是「子会话正常完成」的默认收尾（`iflow.superAgent.keepWorktree` 默认
   * 关闭）。与 `merged` / `empty` 两条路径的关键差别：这里**没有**「分支可以
   * 删」的前提 —— 正常完成不等于改动已经落地（自动合并可能被跳过、PR 模式
   * 只推送、manual 模式什么都不做），分支上很可能有还没人审的提交。删目录
   * 只是不再让工作副本占着磁盘，分支原样留着（Orca 的 “Review N Branches”）。
   *
   * 闸门：
   *  1. `released` 已为真 → 磁盘上早没了，直接成功（幂等）；
   *  2. 工作目录还有未提交改动 → **不删**（删目录就是丢数据），有意保留、不重试；
   *  3. 目录删不掉 → 可重试（子进程刚退出、文件仍被占用这类磁盘层面的偶发失败）。
   */
  private async releaseWorktreeKeepingBranch(id: string): Promise<ReleaseOutcome> {
    const session = this.get(id);
    if (!session) return { ok: true };
    const isolation = session.isolation;
    if (isolation.kind !== "git_worktree") return { ok: true };
    if (!isolation.path || !isolation.branch) return { ok: true };
    if (isolation.released) return { ok: true };

    if (await worktreeHasUncommittedChanges(isolation.path)) {
      this.deps.log.warn(
        `super agent: ${id} 的工作目录还有未提交改动，保留 worktree 与分支 ${isolation.branch}`,
      );
      return { ok: false, retryable: false, reason: "工作目录还有未提交改动" };
    }

    const result = await removeWorktree({
      repoRoot: this.deps.repoRoot,
      targetPath: isolation.path,
      branch: isolation.branch,
      keepBranch: true,
    });
    if (!result.removed) {
      const reason = result.reason ?? "工作目录未能删除";
      this.deps.log.warn(
        `super agent: ${id} 工作目录回收未完成（removed=${result.removed}）：${reason}`,
      );
      return { ok: false, retryable: true, reason };
    }
    if (!result.branchKept) {
      // keepBranch=true 时不该发生；真发生了就是分支被删了 —— 如实记日志，
      // 但目录已经没了，只能继续（无法恢复）。
      this.deps.log.warn(`super agent: ${id} 回收工作目录时分支 ${isolation.branch} 未被保留`);
    }

    this.markRecycled(id);
    this.deps.log.info(
      `super agent: ${id} 已完成，回收工作目录并保留分支 ${isolation.branch}`,
    );
    return { ok: true };
  }

  /**
   * 释放失败后的有限后台重试。
   *
   * 只重试**可重试**的失败（目录删不掉这类磁盘层面的偶发失败）。有意保留
   * 的情况（有未提交改动 / 分支未并入 HEAD）不重试。
   *
   * 与面板关闭互斥：`dispose()` 会清掉所有定时器，重试回调也会先看
   * `disposed` —— 不会跟面板的收尾抢同一个 worktree。
   */
  private scheduleReleaseRetry(
    id: string,
    mode: "merged" | "empty" | "recycle",
    reason: string,
  ): void {
    if (this.disposed) return;
    if (this.releaseRetryTimers.has(id)) return;
    const attempt = this.releaseRetryAttempts.get(id) ?? 0;
    if (attempt >= RELEASE_RETRY_DELAYS_MS.length) {
      this.deps.log.warn(
        `super agent: ${id} 隔离释放重试 ${attempt} 次仍未成功，放弃自动清理（请手动处理）：${reason}`,
      );
      return;
    }
    const delay = RELEASE_RETRY_DELAYS_MS[attempt] ?? RELEASE_RETRY_DELAYS_MS[0]!;
    this.releaseRetryAttempts.set(id, attempt + 1);
    const timer = setTimeout(() => {
      this.releaseRetryTimers.delete(id);
      void this.runReleaseRetry(id, mode, reason);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.releaseRetryTimers.set(id, timer);
    this.deps.log.warn(
      `super agent: ${id} 隔离释放失败（${reason}），${Math.round(delay / 1000)}s 后进行第 ${attempt + 1} 次重试`,
    );
  }

  /** 后台重试的一次尝试。 */
  private async runReleaseRetry(
    id: string,
    mode: "merged" | "empty" | "recycle",
    reason: string,
  ): Promise<void> {
    if (this.disposed) return;
    const outcome = await this.releaseIsolation(id, mode);
    if (outcome.ok) {
      this.releaseRetryAttempts.delete(id);
      return;
    }
    if (!outcome.retryable) {
      // 有意保留 —— 不再重试，如实上报即可。
      this.releaseRetryAttempts.delete(id);
      return;
    }
    this.scheduleReleaseRetry(id, mode, outcome.reason || reason);
  }

  /**
   * 把一条子会话记录标成「隔离已释放」（worktree 与分支都已从磁盘上清掉）。
   *
   * 与 recordIntegration 同一条写回路径：历史子会话不在 sessions 里，必须
   * 写回 archived，否则重启后看板又会拿旧记录去删一个不存在的目录。
   */
  private markReleased(id: string): void {
    const updated = this.updateSessionRecord(id, (session) => ({
      ...session,
      isolation: { ...session.isolation, released: true },
    }));
    if (updated) this.emit();
  }

  /**
   * 把一条子会话记录标成「工作目录已回收、本地分支仍保留」。
   *
   * 与 {@link markReleased} 的区别只在语义：`released` 是「目录与分支都清理
   * 干净了」，`recycled` 是「目录删了，但分支上有未合并的提交留着待审」。
   * 两者都打 `released` 是因为「磁盘上不再有需要用户收拾的目录」这个事实
   * 相同（看板据此不再显示「待清理」）。
   */
  private markRecycled(id: string): void {
    const updated = this.updateSessionRecord(id, (session) => ({
      ...session,
      isolation: { ...session.isolation, released: true, recycled: true },
    }));
    if (updated) this.emit();
  }

  /**
   * 改一条子会话记录（活着的或历史恢复的），返回是否真的改到了。
   *
   * 单一写回通道：sessions 与 archived 各一份，改哪份取决于记录在哪。
   */
  private updateSessionRecord(
    id: string,
    transform: (session: SuperSessionUi) => SuperSessionUi,
  ): boolean {
    const live = this.sessions.get(id);
    if (live) {
      this.sessions.set(id, transform(live));
      return true;
    }
    let updated = false;
    for (const [owner, records] of this.archived) {
      if (!records.some((s) => s.id === id)) continue;
      this.archived.set(
        owner,
        records.map((s) => (s.id === id ? transform(s) : s)),
      );
      updated = true;
    }
    return updated;
  }

  /**
   * 应用一次会话状态迁移，并在同一处留下诊断 / 失败分类 / 状态说明。
   *
   * 诊断是追加式的（任务 A 的 applySuperDiagnostic / applySuperFailure 都不改状态
   * 机），所以放在 applySuperEvent 之后、写回 map 之前完成 —— 一次迁移一份记录，
   * 看板的「诊断」视图与失败分类 chip 因此有真实数据。`statusDetail` 用错误文本，
   * 看门狗 / 护栏 / 依赖跳过等失败点还可以传入更具体的一句话说明。
   */
  private apply(id: string, event: SuperEvent, statusDetail?: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    let next = applySuperEvent(session, event);
    if (next === session) return;
    const at = event.at;
    switch (event.type) {
      case "started":
        next = applySuperDiagnostic(next, {
          at,
          kind: "session",
          level: "info",
          message: `内核会话已建立（${event.cliSessionId}）`,
        });
        // 会话建立 = 从准备档切到运行档：首轮 prompt 的首 token 等待改用更保守的
        // 运行阈值，避免用准备档的短阈值误杀慢模型。
        this.promoteWatchdogToRunning(id);
        break;
      case "report":
        next = applySuperDiagnostic(next, {
          at,
          kind: "report",
          level: "info",
          message: `汇报：${event.report.state}`,
          detail: event.report.summary?.slice(0, SUPER_DIAGNOSTIC_TEXT_MAX_CHARS),
        });
        break;
      case "failed": {
        const kind = classifySuperFailureKind(event.error);
        next = applySuperFailure(next, { kind, message: event.error, at });
        const detail = (statusDetail ?? event.error).slice(0, SUPER_DIAGNOSTIC_TEXT_MAX_CHARS);
        if (detail) next = { ...next, statusDetail: detail, updatedAt: Math.max(next.updatedAt, at) };
        break;
      }
      case "cancelled":
        next = applySuperDiagnostic(next, {
          at,
          kind: "error",
          level: "info",
          message: `已被中断（${event.source ?? "system"}）`,
        });
        break;
    }
    this.sessions.set(id, next);
    // 「开始等你回答」只惊动用户一次：prev 没有 pending、next 有 pending 才算
    // 真正进入等待（同一 pending 的重复 apply 不会重复通知）。恢复出来的历史
    // 子会话不在 `sessions` 里，压根走不到这里；`restored` 判断是额外的护栏。
    if (event.type === "needs_input" && !session.pending && next.pending && !next.restored) {
      this.deps.onNeedInput?.(next);
    }
    this.emit();
    // retryable 失败归一后按上限自动重试（见 maybeAutoRetry）。放在 emit 之后，
    // 让看板先看到 failed 状态再进入退避。
    if (event.type === "failed") this.maybeAutoRetry(id);
  }

  /** 追加一条任意诊断（spawn / merge / retry 等生命周期节点）。 */
  private recordDiagnostic(
    id: string,
    kind: SuperDiagnosticKind,
    level: "info" | "warn" | "error",
    message: string,
    at: number = Date.now(),
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.set(
      id,
      applySuperDiagnostic(session, {
        at,
        kind,
        level,
        message: message.slice(0, SUPER_DIAGNOSTIC_TEXT_MAX_CHARS),
      }),
    );
    this.emit();
  }

  /** 把子会话的当前状态推给宿主；只有终态与「等人处理」才值得惊动主会话。 */
  private notifyReport(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const report =
      this.integrationReport(session) ??
      reportForSession(session, Date.now(), this.summarize(id));
    if (!report || report.state === "progress") return;
    this.deps.onReport([{ session, report }]);
  }

  /**
   * 集成没能把改动带回主工作区时，用 blocked 覆盖「已完成」的乐观上报 ——
   * 主会话需要知道分支还在、要用户动手。
   *
   * **正文是英文**：这份汇报会作为主会话的一次真实 prompt 发出去，混中文
   * 会让模型在对话中间翻语言。中文的看板说明仍在 `integration.detail`
   * （看板给用户看），这里用同一调用点写下的英文事实描述。
   */
  private integrationReport(session: SuperSessionUi): SuperReport | null {
    const integration = session.integration;
    if (!integration || !integration.needsAction) return null;
    const reason =
      this.integrationReasonEn.get(session.id) ??
      "the changes were not brought back into the main workspace automatically";
    return {
      state: "blocked",
      summary: `The changes were not integrated automatically: ${reason}. The branch is kept and still has to be merged into the current branch of the main repository.`,
      at: integration.at,
      humanAction: `Merge the branch of this child session into the current branch of the main repository (${reason}).`,
    };
  }

  /**
   * 汇报给主会话的提示词（宿主用它向主会话发一条 prompt）。
   *
   * `pendingCount` = 还在跑（非终态）的子会话数。逐个即时汇报意味着这一轮
   * 往往**不是**收尾：还在跑的孩子结束后宿主会再交一次汇报，所以提示词里
   * 会明确「先处理这批结果、此时不要向用户做最终完整汇报」。
   */
  reportPrompt(entries: { session: SuperSessionUi; report: SuperReport }[]): string {
    return this.reportPromptWithPending(entries).text;
  }

  /**
   * 与 {@link reportPrompt} 同文本，额外返回这次汇报的 pendingCount（仍在跑、
   * 同归属主会话的子会话数）。面板据此把 pendingCount=0 的汇总轮标记为 QQ
   * 最终答复轮；两处共用同一份计算口径，避免提示词说「还在跑」却标记成最终。
   */
  reportPromptWithPending(
    entries: { session: SuperSessionUi; report: SuperReport }[],
    options?: { pendingOwner?: string | null; finalOverride?: boolean },
  ): { text: string; pendingCount: number } {
    // pendingCount 只统计**同一归属主会话**下还在跑的子会话：这份汇报是投给
    // 某个主会话的，别人家的子会话跟它无关。混进来算的话，提示词里的
    // 「还有 N 个在跑」与面板上的「等待 N 个子会话汇报」就对不上当前会话
    // （用户在会话 A 开着，却看到 B 的孩子也被算成 A 的）。
    //
    // QQ 主渠道的最终回执也用这个口径判「汇总轮」（pendingCount===0）。面板
    // 允许显式传入 pendingOwner，让统计口径与等最终答复的 QQ 任务归属对齐，
    // 避免从 entries[0] 推断 owner 时因异步归属回填而与 awaiter 漂移。普通
    // 汇报不传该参数，行为与从前逐字节一致。
    const owner =
      options?.pendingOwner !== undefined
        ? options.pendingOwner
        : (entries[0]?.session.mainSessionId ?? this.deps.currentMainSessionId() ?? null);
    const pendingCount = this.list().filter(
      (session) =>
        !isTerminalSuperStatus(session.status) && (session.mainSessionId ?? owner) === owner,
    ).length;
    // 按 wave 重排汇报（任务 A 的 groupSuperReportsByWave）：同批汇报按波次先后
    // 聚合，上游先说、下游后说，主会话拿到的是有依赖顺序的结果而非乱序拼盘。
    // 缺 wave 的旧条目归 0 组，顺序保持原样 —— 平铺派发的提示词逐字不变。
    const ordered = groupSuperReportsByWave(entries, (entry) => entry.session.wave).flat();
    return {
      text: buildSuperReportPrompt(ordered, {
        pendingCount,
        finalOverride: options?.finalOverride === true,
      }),
      pendingCount,
    };
  }

  /**
   * 子会话的文本摘要（模型面向：它会作为汇报正文回到主会话）。
   *
   * 结论写在**末尾**，所以走 `capReportTail` 的尾部优先截断：旧的
   * `text.slice(0, 799)` 只留开头，把末尾的结论砍掉，才有了「汇报以省略号
   * 结尾、看不到最终结论」。上限放宽到能容纳完整结论（见 shared 里的
   * `SUPER_REPORT_SUMMARY_MAX_CHARS`），中间被丢掉的部分带明确省略标记。
   *
   * 没有正文时的兜底仍是英文：汇报提示词整体是英文的，兜底夹一句中文会让
   * 模型在对话中间翻语言（与 `shared/super-agent.ts` 的 `describePending`
   * 兜底同一纪律）。
   */
  private summarize(id: string): string {
    const text = (this.lastText.get(id) ?? "").trim();
    if (!text) return "(the child session left no text summary)";
    return capReportTail(text);
  }

  /** 清理已删除子会话的附属状态（文本缓冲、节流定时器、实时转录）。 */
  private forgetChild(id: string): void {
    const timer = this.progressTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(id);
    }
    this.clearWatchdog(id);
    this.lastText.delete(id);
    this.lastThought.delete(id);
    this.promptTokens.delete(id);
    this.interrupted.delete(id);
    this.transcripts.delete(id);
    this.integrationReasonEn.delete(id);
    this.discardTranscriptSnapshot(id);
  }

  /** 旁路转录快照的删除（fire-and-forget + 吞错，绝不挡清理）。 */
  private discardTranscriptSnapshot(id: string): void {
    const dir = this.deps.superStoreDir?.();
    if (!dir) return;
    void deleteSuperTranscriptSnapshot(dir, id).catch((error: unknown) => {
      this.deps.log.warn(`super agent: transcript snapshot delete failed: ${errorMessage(error)}`);
    });
  }

  /** 记录子会话实际使用的模型（看板详情要显示它，成本也按它查单价）。 */
  private patchModel(id: string, model: string): void {
    const session = this.sessions.get(id);
    if (!session || session.model === model) return;
    this.sessions.set(id, { ...session, model, updatedAt: Date.now() });
    this.emit();
  }

  /**
   * 全量替换子会话自己的 todolist（plan update 每次都是完整快照，不追加 /
   * 不合并）。只走既有的 `emit()`：宿主在 onSessionsChanged 里既刷新看板投影，
   * 又调用 persistSuperSessions 落盘 —— 不新建第二条广播 / 落盘通道。
   * 全量快照可能重复推同一份内容，逐字比对避免无谓刷新与写放大。
   */
  private patchTodos(id: string, todos: SuperTodoUi[]): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // 首帧一定写入（哪怕是空数组：`todos` 缺省与「没有 todolist」语义不同，
    // 但都要让看板与归档拿到确定的 []）。仅已有快照且逐字相同时才跳过。
    if (session.todos !== undefined && JSON.stringify(session.todos) === JSON.stringify(todos)) {
      return;
    }
    this.sessions.set(id, { ...session, todos, updatedAt: Date.now() });
    this.emit();
  }

  // --- 卡死看门狗（SA-1，只作用于子会话）------------------------------------

  /** 当前阶段对应的静默阈值（分级：准备档更短，运行档更保守）。 */
  private watchdogDelay(id: string): number {
    const phase = this.watchdogs.get(id)?.phase;
    return phase === "running" ? this.stallTimeoutMs : this.prepareStallTimeoutMs;
  }

  /** 布防子会话看门狗（进程就绪、首个 ACP 请求前调用，初始为 prepare 档）。 */
  private armWatchdog(id: string, attempt: number, phase: SuperWatchdogPhase = "prepare"): void {
    this.clearWatchdog(id);
    const now = Date.now();
    this.watchdogs.set(id, { lastProgressAt: now, lastActivityAt: now, attempt, phase });
    this.resetWatchdogTimer(id);
  }

  /**
   * 提升为 running 档（收到 started 事件时调用）：从更短的准备阈值切到更保守的
   * 运行阈值，并把「最近进展 / 最近活动」重新计时 —— 首轮 prompt 可能要等模型
   * 首 token，这段静默不应被算进准备档。
   */
  private promoteWatchdogToRunning(id: string): void {
    const state = this.watchdogs.get(id);
    if (!state || state.phase === "running") return;
    const now = Date.now();
    state.phase = "running";
    state.lastProgressAt = now;
    state.lastActivityAt = now;
    this.resetWatchdogTimer(id);
  }

  /** 收到任意 session/update：刷新最近进展 / 最近活动时刻并重置定时器。 */
  private touchWatchdog(id: string): void {
    const state = this.watchdogs.get(id);
    if (!state) return;
    const now = Date.now();
    state.lastProgressAt = now;
    state.lastActivityAt = now;
    this.resetWatchdogTimer(id);
  }

  /** 重设某个子会话的看门狗定时器（clear + 重新 setTimeout，恒 unref）。 */
  private resetWatchdogTimer(id: string, delayMs?: number): void {
    const prev = this.watchdogTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.watchdogTimers.delete(id);
      this.onWatchdogTick(id);
    }, Math.max(1, delayMs ?? this.watchdogDelay(id)));
    if (typeof timer.unref === "function") timer.unref();
    this.watchdogTimers.set(id, timer);
  }

  /**
   * 活性快照（宿主心跳读取）：每个仍受看门狗监控的子会话的最近活动时刻、阶段
   * 与静默时长。只读，不刷新任何时间戳 —— 真正在动的证据只能来自 session/update，
   * 心跳读它只是为了「最近活动」在宿主侧有一份可查询的投影。
   */
  activitySnapshot(): {
    id: string;
    lastActivityAt: number;
    phase: SuperWatchdogPhase;
    silentForMs: number;
  }[] {
    const now = Date.now();
    const out: {
      id: string;
      lastActivityAt: number;
      phase: SuperWatchdogPhase;
      silentForMs: number;
    }[] = [];
    for (const [id, state] of this.watchdogs) {
      out.push({
        id,
        lastActivityAt: state.lastActivityAt,
        phase: state.phase,
        silentForMs: now - state.lastActivityAt,
      });
    }
    return out;
  }

  /**
   * 追加一条「活性 / 工具调用」诊断（纯诊断，不改状态机）。
   *
   * 共享契约 {@link SuperDiagnosticKind} 未单列 activity / tool_call 两个枚举值
   * （当前为 spawn/session/report/merge/retry/error/timeout/restore/blocked），因此
   * 这里按确切签名用 `kind: "session"` 记录会话活性，并在消息里写明具体是哪一类
   * update —— 既不臆造新枚举，也让看板能看出「它在动、刚做了什么」。
   *
   * 节流按子会话 + 窗口：窗口内重复到达的活动帧只刷新看门狗时间戳（touchWatchdog
   * 已在 onSessionUpdate 顶部调用），不重复写诊断、不重复 emit。
   */
  private recordActivityDiagnostic(id: string, what: string, at: number = Date.now()): void {
    const prev = this.lastActivityDiagAt.get(id) ?? 0;
    if (at - prev < SUPER_ACTIVITY_DIAG_THROTTLE_MS) return;
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return;
    this.lastActivityDiagAt.set(id, at);
    this.sessions.set(
      id,
      applySuperDiagnostic(session, {
        at,
        kind: "session",
        level: "info",
        message: `活动：${what}`.slice(0, SUPER_DIAGNOSTIC_TEXT_MAX_CHARS),
      }),
    );
    this.emit();
  }

  /**
   * 用户主动「判定卡死」：如实先记一条 timeout 诊断（写明是用户判定，不是内核
   * 超时），再按 user 来源中断，走与看板「中断」完全相同的 cancel 收口。
   * 返回 cancel 的真实结果（幂等 / not-found 都照实上报）。
   */
  async judgeStuck(id: string): Promise<SuperCancelOutcome> {
    const session = this.sessions.get(id);
    if (session && !isTerminalSuperStatus(session.status)) {
      this.recordDiagnostic(id, "timeout", "warn", "用户判定卡死，主动中断");
    }
    this.lastActivityDiagAt.delete(id);
    return this.cancel(id, "user");
  }

  /** 清除某个子会话的看门狗（终态 / 清理 / dispose 的统一入口）。 */
  private clearWatchdog(id: string): void {
    const timer = this.watchdogTimers.get(id);
    if (timer) clearTimeout(timer);
    this.watchdogTimers.delete(id);
    this.watchdogs.delete(id);
  }

  /**
   * 看门狗到点：双条件判定，避免误杀慢任务。
   *
   *  - 会话已终态 / 已被重试取代 → 直接收口（迟到的定时器什么都不做）；
   *  - 进程仍存活但「实际静默时长」不足阈值（定时器漂移 / 注入值过小）→
   *    按剩余时间重新布防，绝不误杀；
   *  - 进程仍存活且确实静默超阈值 → 判为「在途请求永不返回 / 事件断流」，
   *    归一为 failed 并写明确 error；
   *  - 进程已死但状态没被 onExit 归一（兜底）→ 同样归一为 failed。
   *
   * 归一后用 dispose 杀掉卡死的进程（在途请求被 reject 会走 prepareInner 既有
   * 的 catch/finally 收尾），并**显式**回收并发槽位 —— 覆盖「没有在途请求可
   * reject」的阶段（如集成 / 准备阶段卡死）。槽位回收带 attempt 守卫，已被新
   * 一轮重试接管时不能误删新尝试的槽位。
   */
  private onWatchdogTick(id: string): void {
    const state = this.watchdogs.get(id);
    if (!state) return;
    const session = this.sessions.get(id);
    if (
      !session ||
      isTerminalSuperStatus(session.status) ||
      (session.attempts ?? 1) !== state.attempt
    ) {
      this.clearWatchdog(id);
      return;
    }
    // clientAlive 缺失（测试桩）/ 抛错时按「存活」处理 —— 走无进展超时这条更保守
    // 的路径，绝不因为一次存活探测失败就把正在跑的子会话误杀。
    const client = this.clients.get(id);
    const alive = client ? isClientAlive(client) : false;
    const silentFor = Date.now() - state.lastProgressAt;
    // 分级阈值：准备档 / 运行档各自独立，二次确认的两个条件（进程存活 + 实际
    // 静默不足阈值）一个都不放宽 —— 若因定时器漂移导致提前到点，一律重新
    // 布防剩余时间，绝不因为分级就降低门槛。
    const thresholdMs = this.watchdogDelay(id);
    if (alive && silentFor < thresholdMs) {
      // 定时器漂移：静默还不够久，重新布防剩余时间。
      this.resetWatchdogTimer(id, thresholdMs - silentFor);
      return;
    }
    const phaseLabel = state.phase === "running" ? "运行中" : "准备中";
    const reason = alive
      ? `子会话${phaseLabel}无响应超时（${Math.round(thresholdMs / 1000)} 秒无进展）`
      : "子会话进程已退出但状态未归一（看门狗兜底）";
    this.recordDiagnostic(
      id,
      "timeout",
      "warn",
      `看门狗判定${phaseLabel}卡死：静默 ${Math.round(silentFor / 1000)}s ≥ 阈值 ${Math.round(thresholdMs / 1000)}s（进程${alive ? "存活" : "已退出"}）`,
    );
    this.deps.log.warn(`[${id}] 子会话看门狗触发：${reason}`);
    this.apply(id, { type: "failed", error: reason, at: Date.now() }, `看门狗：${reason}`);
    this.discardQuestionResolver(id);
    this.finalizeProgress(id);
    this.clearWatchdog(id);
    this.notifyReport(id);
    // 杀进程 + 主动回收槽位。dispose 会让真实客户端的在途请求 reject，走既有
    // catch/finally；FakeClient 等不 reject 在途请求的桩则由这里的 finally 兜底。
    void this.disposeClient(id).finally(() => {
      const latest = this.sessions.get(id);
      if (!latest || (latest.attempts ?? 1) === state.attempt) {
        this.started.delete(id);
        this.pump();
      }
    });
  }

  /** 节流推送实时进度：流式 chunk 不必逐个上屏，但要让看板看得出「它在动」。 */
  private scheduleProgress(id: string): void {
    if (this.progressTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.progressTimers.delete(id);
      this.publishProgress(id);
    }, SUPER_PROGRESS_THROTTLE_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.progressTimers.set(id, timer);
  }

  private publishProgress(id: string): void {
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return;
    const tail = this.progressTail(id);
    if (!tail || session.progress === tail) return;
    this.sessions.set(id, { ...session, progress: tail });
    this.emit();
  }

  /** 回合结束时把最后一帧进度落定（终态会话也能补记，方法不经过状态机）。 */
  private finalizeProgress(id: string): void {
    const timer = this.progressTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(id);
    }
    const session = this.sessions.get(id);
    if (!session) return;
    const tail = this.progressTail(id);
    if (!tail || session.progress === tail) return;
    this.sessions.set(id, { ...session, progress: tail });
  }

  /** 助手文本的尾部快照（含省略号，明确告知前面还有内容）。 */
  private progressTail(id: string): string | undefined {
    const text = (this.lastText.get(id) ?? "").trim();
    if (!text) return undefined;
    if (text.length > SUPER_PROGRESS_MAX_CHARS) {
      const tail = text.slice(-SUPER_PROGRESS_MAX_CHARS);
      // 缓冲区本身可能已经被 capTail 截断过（它带一个「…」标记）—— 别叠成「……」。
      return tail.startsWith("…") ? tail : `…${tail}`;
    }
    return text;
  }

  /**
   * 结算子会话的 token 开销。
   *
   * 输入取内核上报的**末次请求上下文**（权威）；没上报时退回任务提示的 BPE
   * 估算并标记非权威 —— 绝不把估算值冒充成内核数据。输出取
   * `completionTokens` 与全部助手/思考文本估算的较大值（工具循环的多轮生成
   * wire 不带拆分，这是保守下界）。成本只在有单价时计算。
   *
   * 文本估算走**分块**版本：一次性的全量 BPE 是几百毫秒级的同步尖峰，放在
   * 扩展宿主的事件循环里就是一次可见的卡顿（面板无响应、快捷键延迟）。
   */
  private async recordUsage(
    id: string,
    model: string | null,
    report: TurnUsageReport | undefined,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    const text = (this.lastText.get(id) ?? "") + (this.lastThought.get(id) ?? "");
    const estimatedOutput = await estimateTokensChunked(text);
    const output = Math.max(report?.completionTokens ?? 0, estimatedOutput);
    const input = report?.lastRequestInputTokens ?? this.promptTokens.get(id) ?? 0;
    if (input <= 0 && output <= 0) return;
    const price = this.deps.priceFor?.(model) ?? null;
    const usage: SuperTokenUsage = {
      input,
      output,
      ...(typeof report?.cachedReadTokens === "number" && report.cachedReadTokens > 0
        ? { cachedRead: report.cachedReadTokens }
        : {}),
      estimatedCost: price ? estimateCost({ inputTokens: input, outputTokens: output }, price) : null,
      authoritative: typeof report?.lastRequestInputTokens === "number" && report.lastRequestInputTokens > 0,
    };
    this.sessions.set(id, withUsage(session, usage, Date.now()));
    this.emit();
  }

  private async disposeClient(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) return;
    try {
      await client.dispose();
    } catch (error) {
      this.deps.log.warn(`超流体进程回收失败：${errorMessage(error)}`);
    } finally {
      // 回收完成才摘掉：**进程被杀掉之前它还活着**，并发额度要按活着的进程
      // 算 —— 提前摘掉会让额度在这个窗口里被提前释放。
      this.clients.delete(id);
    }
  }

  /**
   * 子会话的附件目录：在 worktree 之外，避免子会话 `git add -A` 把附件提交进
   * 分支；但它落在项目内的隔离子树里（`.iflow/super/attachments`，已被仓库
   * 本地 exclude 排除），不写扩展的数据目录。
   */
  private attachmentDirFor(id: string): string {
    return path.join(superIsolationDir(this.deps.repoRoot, "attachments"), id);
  }

  private emit(): void {
    this.deps.onSessionsChanged(this.list(this.deps.currentMainSessionId()));
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 失败四分类归一（把宿主各失败点的错误文本映射到任务 A 的 SuperFailureKind）。
 *
 * 这是宿主侧的分类策略（shared 层只提供 applySuperFailure 纯函数与类型），按
 * 错误语义归到四类：
 *  - `blocked`：护栏拦截 / 依赖跳过（前提失效，重试没用，但也不是内核故障）；
 *  - `interrupted`：用户/系统中断（Stop、面板关闭、宿主回收）；
 *  - `retryable`：内核意外退出 / 无响应超时 / 限流 / 网络瞬断（值得退避重试）；
 *  - `terminal`：其余确定失败（准备阶段错误、脚本错误等）。
 */
export function classifySuperFailureKind(error: string): SuperFailureKind {
  const text = (error || "").toLowerCase();
  if (/blocked|destructive|guard|护栏|依赖.*失败|上游/.test(text)) return "blocked";
  if (/interrupt|cancel|abort|中断|已停止|stopped by|user stop/.test(text)) return "interrupted";
  if (
    /退出|exit|crash|崩溃|timeout|timed?[\s-]+out|超时|无响应|限流|rate.?limit|econn|network|网络瞬断|watchdog|看门狗/.test(
      text,
    )
  ) {
    return "retryable";
  }
  return "terminal";
}

/**
 * 重试时优先复用上一次的隔离环境。
 *
 * 只要求目录还在：worktree 的 `.git` 指向主仓，目录存在就说明它仍是这个
 * 子会话的工作副本。目录已被手工删掉 / 从未建成时返回 null，由调用方新建
 * （分支也随之一并重建）。
 */
function reusableIsolation(
  isolation: SuperSessionUi["isolation"],
): SuperSessionUi["isolation"] | null {
  if (!isolation.path || !existsSync(isolation.path)) return null;
  if (isolation.kind === "git_worktree" && !isolation.branch) return null;
  return isolation;
}

/**
 * 只读进程存活判定（SA-1 看门狗）：复用 {@link AcpClient.isAlive}。
 *
 * 测试桩 / 旧客户端可能没有该方法，或探测本身抛错 —— 两种情况都按「存活」
 * 处理，交回「无进展超时」这条更保守的判定路径，绝不因探测失败误杀正在跑的
 * 子会话。
 */
function isClientAlive(client: AcpClient): boolean {
  try {
    const probe = (client as Partial<AcpClient>).isAlive;
    if (typeof probe !== "function") return true;
    return probe.call(client) !== false;
  } catch {
    return true;
  }
}

/**
 * 截断文本到上限，**保留尾部**并标注截断。
 *
 * 子会话的进度尾部、汇报摘要都只看最近的内容，所以丢头留尾不会丢信息；
 * 反过来留头丢尾会让看板停在最开头的内容上。前面被丢掉的部分用「…」标注
 * —— 看板与汇报里必须看得出「这里还有内容被截掉了」，不能装作全文都在。
 */
export function capTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  return tail.startsWith("…") ? tail : `…${tail}`;
}

/**
 * 路径比较键：统一分隔符，Windows 上忽略大小写。
 *
 * git 的 worktree 列表用正斜杠输出，主仓给的路径是反斜杠 —— 不归一化就比不出
 * 同一个目录（残留清扫会因此把在用的 worktree 误判成孤儿）。
 */
function normalizePathKey(target: string): string {
  const resolved = path.resolve(target).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 子会话工作目录的 `node_modules` 是不是一个指向别处的链接。
 *
 * Windows 目录联接（junction）在 Node 里同样报 `lstat().isSymbolicLink()`
 * 为 true —— 正是 2026-11-11 事故的形态：worktree 的 `node_modules` 链到
 * 主仓那份，`npm ci` 第一步删目录就顺着链接清空了用户依赖。`lstat` 看的是
 * 链接本身（不跟进去），所以这项探测只读不写。文件不存在 / 无权限时按
 * 「不是链接」处理（新 worktree 本来就没有 node_modules）。
 */
function isLinkedNodeModules(cwd: string): boolean {
  try {
    return lstatSync(path.join(cwd, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface SuperAnswer {
  answers?: Record<string, string | string[]>;
}

/** 已经落盘的子会话附件（复制到 worktree 之外的专用目录）。 */
export interface StagedSuperAttachments {
  /** 已复制的文件（路径为绝对路径，位于子会话的附件目录里）。 */
  copies: { name: string; path: string; caption?: string }[];
  /** 作为图片块直接交给模型的图片（视觉模型可直读，无需再调工具）。 */
  images: { data: string; mimeType: string }[];
  /** 复制失败的如实说明（不静默丢用户附件）。 */
  failures: string[];
}

/**
 * 把随任务声明的附件复制到子会话可见的附件目录。
 *
 * 目录刻意放在 **worktree 之外**：子会话常会 `git add -A`，把附件放进工作区
 * 会被提交进它的分支、随自动合并污染主仓库。调用方把这个目录加入
 * `allowedRoots` / `--include-directories`，子会话因此仍能读到它。
 */
async function stageSuperAttachments(
  dir: string,
  attachments: readonly SuperAttachment[],
  log: SuperAgentDeps["log"],
): Promise<StagedSuperAttachments> {
  const staged: StagedSuperAttachments = { copies: [], images: [], failures: [] };
  if (attachments.length === 0) return staged;
  await mkdir(dir, { recursive: true });
  const used = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    try {
      // The fallback names become file names in the attachment dir and are
      // listed in the task prompt — that is model-facing text, so English.
      const fallback = attachment.data
        ? `image${index + 1}${extensionForMime(attachment.mimeType)}`
        : `attachment${index + 1}`;
      let name = sanitizeAttachmentName(attachment.name || attachment.path || "", fallback);
      if (attachment.data && !path.extname(name)) name += extensionForMime(attachment.mimeType);
      const target = uniqueAttachmentPath(dir, name, used);
      let size: number;
      if (attachment.data) {
        const bytes = Buffer.from(attachment.data, "base64");
        if (bytes.byteLength === 0) throw new Error("the image payload is empty");
        if (bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES) throw new Error("the image is too large");
        await writeFile(target, bytes);
        size = bytes.byteLength;
      } else {
        if (!attachment.path) throw new Error("there is no readable source file");
        const info = await stat(attachment.path);
        if (!info.isFile()) throw new Error("the source is not a regular file");
        if (info.size > MAX_ATTACHMENT_FILE_BYTES) {
          throw new Error(
            `the file is too large (limit ${Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB)`,
          );
        }
        // 非图片附件只做磁盘到磁盘的复制，绝不整个读进内存。
        await copyFile(attachment.path, target);
        size = info.size;
      }
      staged.copies.push({
        name: path.basename(target),
        path: target,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      });
      const mime = attachment.data
        ? attachment.mimeType ?? "image/png"
        : IMAGE_MIME_BY_EXT.get(path.extname(target).toLowerCase());
      if (mime && size <= MAX_INLINE_IMAGE_BYTES) {
        staged.images.push({
          data: attachment.data ?? (await readFile(target)).toString("base64"),
          mimeType: mime,
        });
      }
    } catch (error) {
      const label = attachment.name || attachment.path || `attachment${index + 1}`;
      // The failure line is quoted verbatim in the task prompt (model-facing):
      // English, so the child session reads it in the same language as the
      // rest of its instructions.
      staged.failures.push(`${label}: ${errorMessage(error)}`);
      log.warn(`超流体附件复制失败（${label}）：${errorMessage(error)}`);
    }
  }
  return staged;
}

/** 文件名清洗：只保留 basename，剥掉分隔符与控制字符（宿主收到的名字不可信）。 */
function sanitizeAttachmentName(raw: string, fallback: string): string {
  const base = path
    .basename(raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  return base || fallback;
}

/** 同一批附件里重名时加序号，避免互相覆盖。 */
function uniqueAttachmentPath(dir: string, name: string, used: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem}-${n++}${ext}`;
  used.add(candidate.toLowerCase());
  return path.join(dir, candidate);
}

function extensionForMime(mime: string | undefined): string {
  return (mime ? MIME_EXT[mime] : undefined) || ".png";
}

/** 重试时附加到任务提示词里的上一轮上下文。 */
export interface SuperRetryContext {
  /** 本次执行的序号（2 = 第一次重试）。 */
  attempt: number;
  /** 上一次中断的原因。 */
  error?: string;
  /** 上一次留下的进展摘要。 */
  summary?: string;
}

/**
 * 交给子会话的任务提示词。子会话看不到主会话的上下文，所以任务说明必须自包含。
 *
 * 措辞刻意是英文：子会话跑的是同一份英文系统提示，中文包装会让语言在对话中间
 * 翻转。任务说明本身原样传入（它属于派发方），因此回答语言跟随任务说明 ——
 * 模板里已明确这一点。骨架措辞在 `prompts/super-agent-task.md`，宿主只负责拼
 * 动态段落（附件 / 隔离 / 重试 / 提交契约）。
 *
 * 目录隔离这里只用 `degradeReason`（英文，面向模型）；`isolation.note` 是中文
 * 看板文案，不进提示词。
 */
export function buildTaskPrompt(
  title: string,
  task: string,
  isolation: SuperSessionUi["isolation"],
  attachments?: StagedSuperAttachments,
  retry?: SuperRetryContext,
  /**
   * 效率开关档位（`iflow.efficiencyMode`）。`turbo` 时把速推规则前置到任务书
   * 之前（空行分隔），让子会话与主会话同档；缺省/`steady` 时任务书逐字节
   * 不变。
   */
  efficiencyMode?: "steady" | "turbo",
): string {
  const brief = renderPrompt("super-agent-task", {
    title,
    task: task.trim(),
    attachments: describeAttachments(attachments),
    attachmentFailures: describeAttachmentFailures(attachments),
    isolation: describeIsolation(isolation),
    retry: retry ? describeRetry(retry) : "",
    submission: describeSubmission(isolation),
  });
  return efficiencyMode === "turbo" ? `${EFFICIENCY_TURBO_PROMPT}\n\n${brief}` : brief;
}

/** 附件段落（无附件时返回空串，模板行整行折叠）。 */
function describeAttachments(attachments?: StagedSuperAttachments): string {
  if (!attachments || attachments.copies.length === 0) return "";
  return (
    "\n" +
    [
      "Files attached to this task (copied outside your working directory; read them as reference only and do not modify them). Any caption after the em dash came from the user and says what that attachment is — use it to map images to the user's intent:",
      ...attachments.copies.map((copy) => {
        const caption = copy.caption?.trim();
        return `- ${copy.name} → ${copy.path}${caption ? ` — ${caption}` : ""}`;
      }),
    ].join("\n")
  );
}

/** 复制失败的附件段落（如实列出，不静默丢）。 */
function describeAttachmentFailures(attachments?: StagedSuperAttachments): string {
  if (!attachments || attachments.failures.length === 0) return "";
  return (
    "\n" +
    [
      "These attachments could not be delivered (the host failed to copy them — use your own judgement from the task description):",
      ...attachments.failures.map((failure) => `- ${failure}`),
    ].join("\n")
  );
}

/** 工作目录段落：worktree、目录隔离与主仓工作区三档的边界说明。 */
function describeIsolation(isolation: SuperSessionUi["isolation"]): string {
  const lines = [`Working directory: ${isolation.path}`];
  if (isolation.fullTrust) {
    // 完全信任档：跑在主仓工作区里，拥有本机用户的几乎全部权限。边界只留
    // 「只提交本任务文件 + 禁 force push / --no-verify + 不丢用户未提交改动」。
    lines.push(
      "This is the MAIN repository workspace in FULL TRUST mode: no worktree isolation and no branch of your own. You have the full privileges of the local user — you may read and write repository files, run arbitrary commands, push, open pull requests and merge here.",
      "Hard boundaries: commit only files that belong to this task; never force push (`--force` / `--force-with-lease`) and never use `--no-verify` to bypass hooks; never discard the user's other uncommitted changes.",
    );
  } else if (isolation.kind === "repo") {
    // 主仓工作区档：这是唯一一档允许在主仓里动 git 的隔离方式，边界必须
    // 写死 —— 尤其是「不许 git add -A / commit -a / stash」：那会把用户
    // 尚未提交的其它改动卷进合并提交。
    lines.push(
      "This working directory is the MAIN repository workspace: no version isolation, no branch of your own. The task brief explicitly authorizes integration (merging) here, so you may read the repository files and run `git merge --no-ff <branch>` plus conflict resolution.",
      "Hard boundaries for this workspace: never push, rebase, delete or switch branches; never modify files unrelated to the merge; never run `git add -A`, `git commit -a`, `git stash` or any other command that would stage or discard the user's uncommitted changes; never touch anything outside this working directory.",
    );
  } else if (isolation.branch) {
    lines.push(
      `All of your changes belong on branch ${isolation.branch}. Stay on that branch and touch nothing outside the working directory.`,
    );
  } else {
    const reason = isolation.degradeReason?.trim() || "directory isolation only";
    lines.push(
      `Note: the host could not create a separate git worktree (${reason}). This working directory is a standalone directory, not a git repository — do not run git commands and do not look for files in the main workspace.`,
    );
  }
  return "\n" + lines.join("\n");
}

/** 重试段落：说明上一轮被中断，要求先看现场、别重做也别丢改动。 */
function describeRetry(retry: SuperRetryContext): string {
  const lines = [
    `This is a retry (attempt ${retry.attempt}). The previous run was interrupted unexpectedly${
      retry.error ? `: ${truncateForPrompt(retry.error, 300)}` : ""
    }.`,
    "The working directory may still hold partial changes from that run: inspect the current state first, do not redo work that is already finished, and do not discard existing changes.",
  ];
  if (retry.summary) {
    lines.push(`Previous progress summary: ${truncateForPrompt(retry.summary, 600)}`);
  }
  return "\n" + lines.join("\n");
}

/** 提交契约段落：worktree 内要求自己提交；目录隔离明确不要碰 git；
 * 主仓工作区档则明确「合并提交就是交付物，不许自己提交」；完全信任档
 * 放开 push / PR / 合并，但仍只提交本任务文件并禁 force push / --no-verify。 */
function describeSubmission(isolation: SuperSessionUi["isolation"]): string {
  if (isolation.fullTrust) {
    return (
      "\n" +
      [
        "Submitting your work:",
        "- Commit before finishing: stage and commit ONLY the files that belong to this task (use explicit `git add <file>` paths — never `git add -A` / `git add .`, which would sweep the user's uncommitted changes into your commit).",
        "- Full trust mode: you may push, open pull requests, merge, and switch/create/delete branches in the main repository as needed to deliver the task.",
        "- Hard boundaries: never force push (`git push --force` / `--force-with-lease`) and never use `--no-verify`; never modify files unrelated to this task or discard the user's uncommitted work.",
      ].join("\n")
    );
  }
  if (isolation.kind === "repo") {
    return (
      "\n" +
      [
        "Submitting your work:",
        "- The merge commit is the deliverable — do not create commits of your own. Never run `git add -A`, `git commit -a`, `git stash` or `git checkout --`: they would sweep the user's uncommitted changes into the merge commit or throw them away.",
      ].join("\n")
    );
  }
  if (isolation.branch) {
    return (
      "\n" +
      [
        "Submitting your work:",
        '- Commit before finishing: `git add -A && git commit -m "<message describing the change>"`. Commit only the files that belong to this task.',
        "- Do not switch, rename or delete branches, and do not push, create a pull request or merge.",
        "- The host brings the branch back into the main workspace after you finish, and commits any changes you leave uncommitted — but only on normal completion, with a `super-agent: <title>` message before integrating.",
        "- If you fail or are interrupted the host deliberately does not commit, so a retry lands directly on the unfinished work; cleaning up the worktree discards uncommitted changes — do not rely on the fallback, commit before finishing.",
      ].join("\n")
    );
  }
  return (
    "\n" +
    [
      "Submitting your work:",
      "- This working directory is not a git repository: do not commit and do not run any git command. Leave your changes in the working directory.",
    ].join("\n")
  );
}

/**
 * PR 正文：任务说明 + 来源标注（不编造测试结果或影响面）。
 *
 * **保持中文**：这是给人看的产出物（GitHub 上的 PR 描述），不是发给模型的
 * 提示词 —— 产出物语言不随提示词英文化而改变。
 */
function buildPullRequestBody(session: SuperSessionUi): string {
  return [session.task.trim(), "", `_由 iFlow Harness 超流体 \`${session.id}\` 自动创建。_`].join("\n");
}

/**
 * 从 `agent_message_chunk.content` 里取文本。
 *
 * ACP 的 `content` 是**单个** ContentBlock（`session.started` 的流式增量），
 * 不是数组 —— 早期实现只处理数组，导致子会话摘要永远是空的。这里同时接受
 * 单个块与块数组，两种形态都不丢字。
 */
function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) out += extractText(block);
    return out;
  }
  if (content && typeof content === "object") {
    const record = content as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return "";
}

/** 重叠文件列表的人话渲染（看板与汇报都读它，太长会淹掉正文）。 */
function describePaths(paths: readonly string[], limit = 5): string {
  const head = paths.slice(0, limit).join("、");
  return paths.length > limit ? `${head} 等 ${paths.length} 个` : head;
}

/**
 * 重叠文件列表的**模型面向**渲染（英文）。
 *
 * 与 {@link describePaths} 一一对应：中文那份给看板看，英文这份进汇报提示词
 * 与合并任务书（两边都是英文，不能各说各话）。
 */
function describePathsEn(paths: readonly string[], limit = 5): string {
  const head = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${head} and ${paths.length - limit} more` : head;
}

/**
 * 合并成功后「你本地未提交的改动原样保留」这句文案的**实时**来源。
 *
 * 判据必须是合并**之后**重新读到的 `git status`，不能沿用合并前的快照：
 * 预演 + 真实 merge + 分支探测要花时间，用户完全可能在这期间提交或丢弃了
 * 改动（改动也可能被前一次合并吸收）—— 照抄旧快照就会报出一个早已不存在的
 * 脏工作区，主会话据此让用户去清理并不存在的东西。
 *
 * 返回 null = 此刻工作区干净、或状态读不到（宁可什么都不声称），调用方只报
 * 「已合入 X」。返回文案时如实列出仍在工作区的具体文件 —— 真正脏的时候，
 * 用户仍必须知道自己的改动没被合并覆盖。
 */
export function describeKeptLocalChanges(
  tree: WorkingTreeState | null,
): { zh: string; en: string } | null {
  if (!tree || !tree.available || tree.dirtyCount === 0) return null;
  const tracked = tree.trackedPaths;
  if (tracked.length === 0) {
    // 只有未跟踪文件：git 从不覆盖它们，如实计数即可（逐个列会淹掉正文）。
    return {
      zh: `工作区仍有你未跟踪的 ${tree.untrackedCount} 个文件，未被合并触碰`,
      en: `your ${tree.untrackedCount} untracked file(s) are still in the working tree, untouched by the merge`,
    };
  }
  const untrackedNote = tree.untrackedCount > 0 ? `，另有未跟踪文件 ${tree.untrackedCount} 个` : "";
  const untrackedNoteEn =
    tree.untrackedCount > 0 ? `, plus ${tree.untrackedCount} untracked file(s)` : "";
  return {
    zh: `你本地未提交的改动原样保留：${describePaths(tracked)}${untrackedNote}`,
    en: `your uncommitted local changes were kept as they were: ${describePathsEn(tracked)}${untrackedNoteEn}`,
  };
}

/** 重试提示词里的截断：上一次的错误/摘要可能很长，别把它们整段塞进提示词。 */
function truncateForPrompt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
