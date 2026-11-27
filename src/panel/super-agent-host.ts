/**
 * SuperAgentHost — Super Agent 宿主编排逻辑，从 `panel.ts` 下沉（panel 拆分阶段 6；等价重构）。
 *
 * Owns the ENTIRE host-side orchestration of Super Agent child sessions:
 * constructing {@link SuperAgentManager} with all its callbacks, the heartbeat
 * timer, the report-delivery queue (SuperReportBuffer + id:attempt in-flight
 * tracking), the five auto-turn hidden-prompt queues, the merge-request queue,
 * the "waiting for children" toast state, directive/action scanning, and the
 * board projection. All of these state machines move here **as one group** —
 * splitting the timers/queues between the panel and the host would break the
 * mutual-exclusion and dedup invariants.
 *
 * This module NEVER touches the manager body in `src/panel/super-agent.ts`:
 * its watchdog (SA-1), report reliability (SA-2: drainSettled/confirm/release,
 * superReportKey, QQ dedup) and submission contract (SA-3) are all left intact.
 * `SuperReportBuffer` here is only *driven* through its public API, verbatim.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. Everything it needs
 * from the panel arrives through {@link SuperAgentHostCallbacks}; the panel
 * constructs those callbacks with arrow wrappers (call-time reads, never a
 * snapshot — AGENTS.md pitfall #8) so `this` stays bound. Local panel proxies
 * below forward `this.store` / `this.sendPrompt` / etc. to the callbacks so the
 * migrated method bodies stay byte-for-byte identical to their panel originals.
 * `ChatPanel` keeps same-named thin delegates, so the webview-message switch,
 * `extension.ts` and every existing test keep the exact same contract. New
 * wire message types: zero.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import * as vscode from "vscode";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { AcpClient, type AcpClientCallbacks } from "../acp/client.js";
import { errorMessage } from "../acp/jsonrpc.js";
import { buildAcpCommand, concealNodeExecutable, locateNodeExecutable } from "../acp/cli-locator.js";
import { McpBroker, normalizeBrokerServers } from "../acp/mcp-broker.js";
import { loadCredentials, loadProfiles } from "../acp/auth.js";
import { readKernelApiProfiles } from "../acp/api-profiles.js";
import {
  queryModelIds,
  readActiveEndpoint,
  readCliSettings,
  retireStaleOAuthCreds,
} from "../acp/models-query.js";
import {
  resolveCliTokensLimit,
  resolveSuperCliTokensLimit,
  superTokensLimitEnv,
  tokensLimitEnvFromSettings,
} from "../acp/cli-tokens-limit.js";
import {
  resolveSuperApiSpec,
  type SuperApiProfile,
  type SuperApiSpec,
  type SuperEndpointInput,
} from "../../shared/super-profile.js";
import {
  buildChildSessionSettingsForTrust,
  effectiveMcpServerNamesForTrust,
} from "../../shared/super-tool-policy.js";
import { parseContextWindowOverrides, parseCostTable, resolveCost } from "../../shared/context-window.js";
import {
  resolveSuperWorkspaceRoot,
  type SuperWorkspaceEnsureOutcome,
  type SuperWorkspaceResolution,
} from "../../shared/super-workspace.js";
import {
  type Block,
  type ContextRefUi,
  type WebviewToHost,
} from "../../shared/messages.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallBase,
} from "../acp/protocol.js";
import type { OsNotifyEvent } from "../../shared/notifications.js";
import type { OpenAiCompatCredentials } from "../acp/auth.js";
import {
  SuperAgentManager,
  type SuperResidueCount,
  type SuperResidueItem,
} from "./super-agent.js";
import {
  buildSuperActionReceiptPrompt,
  buildSuperDigest,
  buildDelegatedUserTurnPrompt,
  buildSuperMergeRequestPrompt,
  clampMaxConcurrentSuperSessions,
  clampMaxSuperWorktrees,
  clampSuperMaxAttempts,
  DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  DEFAULT_MAX_SUPER_WORKTREES,
  DEFAULT_SUPER_MAX_ATTEMPTS,
  extractSuperActions,
  fromPersistedSuperSession,
  isTerminalSuperStatus,
  MAX_SUPER_ATTACHMENTS,
  planSuperWaves,
  superArchiveFingerprint,
  superDirectiveDedupeKey,
  SuperDirectiveScanner,
  SuperReportBuffer,
  superReportKey,
  superTaskKey,
  type SuperAction,
  type SuperActionReceipt,
  type SuperAttachment,
  type SuperDirectiveAction,
  type SuperReportEntry,
  type SuperSessionUi,
  type SuperStatus,
  type SuperTaskSpec,
} from "../../shared/super-agent.js";
import {
  classifySuperToolArgs,
  classifySuperToolName,
  classifySuperToolTitle,
  parseSuperToolCall,
} from "../../shared/super-tool-call.js";
import {
  readSuperSessionArchive,
  readSuperTranscriptSnapshot,
  writeSuperSessionArchive,
} from "./super-store.js";
import { SessionStore } from "./store.js";
import { sanitizeQqReportFallback } from "./qq-host.js";
import type { QqHost } from "./qq-host.js";
import { isWithin } from "../memory/files.js";
import { attachmentSessionDir } from "./attachments.js";

/** 子会话归档的节流写窗口（毫秒）。Mirrors the panel constant (阶段 6). */
const SUPER_ARCHIVE_THROTTLE_MS = 800;
/** Child-wait heartbeat / merge wakeup interval (mirrors the panel constant). */
const SUPER_HEARTBEAT_MS = 1_500;
/** 已归档子会话迟到结论 toast 截断长度. */
const SUPER_ARCHIVED_REPORT_MAX_CHARS = 480;

/**
 * 派发前 live `/models` 查询的短超时（毫秒）。
 *
 * 它只用来提供「模型已下架」的**证据**：超时 / 连接失败 / 非 2xx / 解析失败
 * 一律视为「无证据」（不降级、不阻断派发），因此宁可早早放弃，也不能把子会话
 * 的冷启动卡住。设置页那条查询是用户主动点刷新、等得起，仍用默认 10s。
 */
const SUPER_SPAWN_LIVE_MODELS_TIMEOUT_MS = 4_000;

/**
 * `createSuperClient` 与 `spawnModel` 之间复用同一份 spawn 计划的暂存时长
 * （毫秒）。
 *
 * 管理器对**一次**派发会先后调用这两个回调（先建 client，再问模型），原来
 * 各自把端点/模型/live 校验解析一遍 —— 同一次派发解析两次。这里把
 * `createSuperClient` 的结果按任务覆盖键暂存、`spawnModel` 消费即删，只留
 * 一个很短的 TTL 兜住「消费没发生」（例如 client 起来后立刻被中断）的残留。
 * 键含 profileId/modelId，不同 Profile 的派发互不命中（不串台）。
 */
const SUPER_SPAWN_PLAN_REUSE_MS = 60_000;

/** `resolveSuperSpawnPlan` 的解析结果 —— 一次派发只解析一份。 */
interface SuperSpawnPlan {
  spec: SuperApiSpec;
  configured: boolean;
  modelConfigured: boolean;
}

/** 路径比较键（Windows 文件系统大小写不敏感）。Mirrors the panel helper (阶段 6). */
function normalizePathKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

type SuperToolCallOutcome = "pending" | "dispatched" | "actions" | "rejected" | "dropped" | "failed";

/** 一条待投递给主会话的子会话汇报回合（delivered-unacked 账本与队列共用）。 */
type PendingSuperReportPrompt = {
  mainSessionId: string | null;
  text: string;
  final?: boolean;
  fallbackText?: string;
  suppressQqProgress?: boolean;
  reportKeys?: string[];
};

/**
 * 一条待投递的动作回执（方案 B）：结构与汇报项兼容，因而可直接复用
 * delivered-unacked 账本。带 `reportKeys` 时说明它已并入同一次 agent cancel
 * 的 dropped 上报 —— 这轮同时是汇报轮（reportTurn / finalReport）。
 */
type PendingSuperActionReceipt = PendingSuperReportPrompt & {
  /** 本条回执覆盖的 agent cancel 目标子会话 id。 */
  cancelSessionIds?: string[];
};

/** agent cancel 的 dropped 汇报：暂存到同一 cancel 的动作回执入队时合并。 */
type HeldAgentCancelReport = {
  item: PendingSuperReportPrompt;
  entries: SuperReportEntry[];
  sessionIds: string[];
  at: number;
};

/** delivered-unacked 账本条目：重投目标是汇报队列还是回执队列。 */
type UnackedSuperDelivery = {
  kind: "report" | "receipt";
  item: PendingSuperReportPrompt;
  attempts: number;
  at: number;
};

/** Structural mirror of the panel's SuperMergeDispatchResult (no panel import). */
export type SuperMergeDispatchResult =
  | { dispatched: true; mergeSessionId: string }
  | { dispatched: false; queued: boolean; reason: string };

/** 一次委派派发的同步结果（{@link SuperAgentHost.dispatchSuperTasks} 的返回）。 */
export interface SuperDispatchResult {
  dispatched: number;
  duplicates: number;
  managerAvailable: boolean;
  /**
   * 本次派发被转到了异步链（没有打开工作区、但配置了默认工作区，需要异步
   * `fs.stat` 校验）。为 true 时不代表失败 —— 真实结果稍后由后台链回填。
   */
  deferred?: boolean;
}

/** 派发结果 → 结构化工具调用的终态账本取值（两条通道共用同一口径）。 */
export function dispatchOutcome(result: SuperDispatchResult): "dispatched" | "failed" {
  if (!result.managerAvailable) return "failed";
  return result.dispatched > 0 || result.duplicates > 0 ? "dispatched" : "failed";
}

/** 本工作区记录的活动 API Profile（与 `src/panel/panel.ts` 同键）。 */
const SUPER_WORKSPACE_PROFILE_KEY = "iflow.workspaceActiveProfile";

/** Narrow callback surface the host needs from the panel. No panel import. */
export interface SuperAgentHostCallbacks {
  readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  getContext(): vscode.ExtensionContext;
  getServices(): { workspaceRoot?: string | null };
  getStore(): SessionStore;
  isDisposed(): boolean;
  getEditorPanel(): vscode.WebviewPanel | undefined;
  isHistorySyncBusy(): boolean;
  getQqHost(): QqHost;
  getQqFinalRescueText(): Map<string, string>;
  announceCue(event: OsNotifyEvent, text: string, kind: "done" | "child"): void;
  appendQqArchiveEvent(...args: Parameters<QqHost["appendQqArchiveEvent"]>): ReturnType<QqHost["appendQqArchiveEvent"]>;
  captureQqReportTurnText(...args: Parameters<QqHost["captureQqReportTurnText"]>): ReturnType<QqHost["captureQqReportTurnText"]>;
  currentMainSessionId(): string | null;
  contextReportFile(): string;
  /** Self-calls tests spy on through the panel delegate (one-way re-delegation). */
  getSuperAgent(): SuperAgentManager | null;
  refreshSuperWaitHeartbeat(): void;
  deliverQqMainIntermediateText(...args: Parameters<QqHost["deliverQqMainIntermediateText"]>): ReturnType<QqHost["deliverQqMainIntermediateText"]>;
  forwardQqMainTaskChildQuestion(...args: Parameters<QqHost["forwardQqMainTaskChildQuestion"]>): ReturnType<QqHost["forwardQqMainTaskChildQuestion"]>;
  forwardQqTaskQuestion(...args: Parameters<QqHost["forwardQqTaskQuestion"]>): ReturnType<QqHost["forwardQqTaskQuestion"]>;
  /** Materialise the system-prompt file for the CLI; child sessions pass "child". */
  materializeSystemPrompt(variant?: "main" | "child"): Promise<string | null>;
  mcpProjectCwd(): string | null;
  notifyOs(event: OsNotifyEvent, text: string): boolean;
  postToWebview(message: unknown): void;
  qqFinalRescueDue(...args: Parameters<QqHost["qqFinalRescueDue"]>): ReturnType<QqHost["qqFinalRescueDue"]>;
  qqFinalRescueOwnerPending(...args: Parameters<QqHost["qqFinalRescueOwnerPending"]>): ReturnType<QqHost["qqFinalRescueOwnerPending"]>;
  readMcpScopes(): { global: Record<string, unknown>; project?: Record<string, unknown> | null };
  refreshMcpStatusFromBroker(): void;
  resolveEntry(): string;
  resolveWorkspaceHandshakeCreds(): Promise<OpenAiCompatCredentials | null>;
  /** The spawn-env patch carrying the effective context window
   * (`IFLOW_TOKENS_LIMIT`). The panel owns it so the main session and every
   * child session share ONE resolution — including the cold-start lookup-key
   * fallbacks. Optional: a host built without the panel (tests) falls back to
   * the same resolver with fewer key facts (the store's model) — never to
   * "push nothing". */
  tokensLimitEnv?: () => { IFLOW_TOKENS_LIMIT?: string };
  /** Same read-through-stash channel as the panel's own settings reads (see
   * ChatPanel.readUserSetting): a value stashed during an in-place upgrade
   * must be visible here before the window reloads. Optional — a host built
   * without the panel (tests) falls back to the raw configuration. */
  readUserSetting?: <T>(key: string, fallback: T) => T;
  /**
   * 子会话派发前 live `/models` 取证的**共享**查询通道（可选）。
   *
   * 面板注入自己的实现 —— 与设置页**同一份** 30s TTL 缓存（key = 归一化
   * models URL，逐次比对 apiKey），所以「设置页刚查过」或「同批并行派发」
   * 都只产生一次真实请求。宿主拿不到面板的私有状态（也不该 import
   * panel），因此走回调；未接线（单测里直接 new 的 host）时回退到无缓存
   * 直连（见 {@link SuperAgentHost.querySpawnLiveModelIds}）。
   */
  querySuperModelIds?: (creds: {
    baseUrl: string;
    apiKey: string;
  }) => Promise<{ ids: string[]; error?: string }>;
  chunkText(content: unknown): string;
  sendPrompt(
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: ContextRefUi[],
    options?: {
      internal?: boolean;
      delegateOnBusy?: boolean;
      hidden?: boolean;
      reportTurn?: boolean;
      finalReport?: boolean;
      finalFallbackText?: string;
      /** 与 `images` 同下标的逐图说明（多模态方案 C）。 */
      imageCaptions?: string[];
    },
  ): Promise<boolean>;
}

/** 5 条宿主自动回合队列的种类；单一来源，避免与优先级数组各写一份。 */
type SuperAutoTurnKind = (typeof SuperAgentHost.SUPER_AUTO_TURN_PRIORITY)[number];

/**
 * 一条队列的「派发 + 判空」成对封装。仲裁与判空共用同一张表，新增队列时
 * Record<Kind, ...> 在编译期强制两件事同时补齐（替代原来两处无 default 的
 * switch 各自穷尽的约束）。
 */
interface SuperAutoTurnHandler {
  /** 选中后的投递入口；真正的门控仍在各 drain 内部。 */
  drain: (host: SuperAgentHost) => Promise<void>;
  /** 轻量非空判断；merges 不带主会话归属，只看非空。 */
  hasWork: (host: SuperAgentHost, owner: string | null) => boolean;
}

export class SuperAgentHost {
  constructor(private readonly deps: SuperAgentHostCallbacks) {}

  /** One `iflow.*` setting with the panel's pending-write stash on top. */
  private setting<T>(key: string, fallback: T): T {
    return this.deps.readUserSetting
      ? this.deps.readUserSetting<T>(key, fallback)
      : vscode.workspace.getConfiguration("iflow").get<T>(key, fallback);
  }

  /**
   * 读一个 `iflow.*` 字符串设置，**永远**返回字符串（去空白）。
   *
   * settings.json 是用户可手改的：`"superAgentProfile": 123` 这类脏值会被
   * `readUserSetting<string>()` 原样返回，随后 `.trim()` 直接抛 TypeError。
   * 非字符串一律当空串（= 跟随主链路 / 未选模型），绝不抛错。
   */
  private readStringSetting(key: string): string {
    const raw = this.setting<unknown>(key, "");
    return typeof raw === "string" ? raw.trim() : "";
  }

  // --- Migrated state (整组迁移；panel 仅保留兼容访问器) -------------------
  superAgent: SuperAgentManager | null = null;
  /**
   * `iflow.superAgent.defaultWorkspace` 已通过异步校验的根（无打开工作区时
   * 的派发回退）。只有 stat 成功且确实是目录才会被写入 —— 未校验 / 校验失败
   * 一律保持 null，绝不让一个不存在的路径进入 worktree / 附件边界。
   */
  defaultWorkspaceRoot: string | null = null;
  /**
   * 内置默认工作区 `~/.iflow/workspace`（设置留空 / 设置值无效时的最终回退）。
   *
   * 由 `os.homedir()` 拼出，**不硬编码用户名**；缺失时派发前用异步 `mkdir -p`
   * 创建。字段化只为让测试把它指向临时目录 —— 否则每个用例都会在真实家目录
   * 里建一个目录。用户从不需要手工创建它。
   */
  builtinDefaultWorkspace: string = path.join(homedir(), ".iflow", "workspace");
  /**
   * 默认工作区派发的串行链：默认工作区需要异步 stat / mkdir，而派发入口是同步的。
   * 串行化保证同一份载荷的重复帧（pending → in_progress）跑在同一个账本上，
   * 后一帧看到前一帧已写入的去重键，不会双开子会话。
   */
  private defaultWorkspaceDispatchChain: Promise<void> = Promise.resolve();
  /**
   * 默认工作区解析的 in-flight promise 缓存（激活期 prefetch 与首次派发共享）。
   *
   * 派发入口是同步的，默认工作区却需要异步 stat/mkdir；把解析前置到激活期后，
   * 用户可能在 prefetch 尚未结束时点击派发。两者必须 join **同一个** promise，
   * 否则会双重 stat/mkdir、构造两个管理器、让子会话 cwd 不一致。任何一次解析
   * settle 后清空缓存；配置改动也会作废它（见 {@link invalidateDefaultWorkspace}），
   * 让下次派发重新解析。恢复历史会话走 {@link resolveSuperWorkspace} 的
   * `create:false` 直连，不经过这里，保持原语义逐字节不变。
   */
  private superWorkspaceResolveInFlight: Promise<SuperWorkspaceResolution> | null = null;
  /**
   * 最近一次解析结果。prefetch 阶段没有 webview、静默跳过 fallback 警告；
   * 首次派发命中已预热的管理器时用这份缓存补发，避免「设置写错却毫无提示」。
   * `fallbackToastSent` 保证同一份解析只警告一次。
   */
  private lastSuperWorkspaceResolution: {
    resolution: SuperWorkspaceResolution;
    fallbackToastSent: boolean;
  } | null = null;
  mcpBroker: import("../acp/mcp-broker.js").McpBroker | null = null;
  mcpBrokerStarting: Promise<import("../acp/mcp-broker.js").McpBroker | null> | null = null;
  /**
   * 每个子会话 spawn 时按**超流体自己的模型/Profile**算出的上下文窗口。
   *
   * `session/set_model` 只改模型名、不重算 CLI 缓存的 tokensLimit；set_model
   * 之后必须把同一口径的窗口推回去。这里按 client 实例记录，避免热切换那条
   * 路径又回落到主会话 `currentApiProfile` 的窗口（那正是要消除的分叉）。
   * WeakMap：client 被回收后自动释放，不泄漏。
   */
  private readonly superClientTokensLimits = new WeakMap<AcpClient, number>();
  /**
   * 派发时已提示过的「下架模型 → 实际回退目标」组合（键为
   * `delisted\u0000fallback`）。一批并行派发会各自解析出同一结论，去重后
   * 只弹一次 toast；日志不受影响，每次仍记。
   */
  private readonly superSpawnDegradeNotices = new Set<string>();
  /**
   * `createSuperClient` 解析出的 spawn 计划，按「任务级 profileId/modelId」键
   * 暂存给紧随其后的 `spawnModel` 复用（同一次派发只解析一次端点/模型/live
   * 校验）。消费即删；未被消费的条目按 {@link SUPER_SPAWN_PLAN_REUSE_MS}
   * 在后续写入时清理 —— 键含 Profile，不同 Profile 的派发不会命中彼此的条目。
   */
  private readonly superSpawnPlans = new Map<string, { plan: SuperSpawnPlan; at: number }>();
  pendingSuperMerges: Array<{ id: string; reason: string }> = [];
  superMergeRunning = false;
  readonly superScan = new SuperDirectiveScanner();
  readonly superDispatchedDirectives = new Set<string>();
  static readonly SUPER_DISPATCHED_DIRECTIVES_CAP = 100;
  readonly superToolCallWarned = new Set<string>();
  static readonly SUPER_TOOL_CALL_WARN_CAP = 100;
  readonly superToolCallActionsDone = new Set<string>();
  static readonly SUPER_TOOL_CALL_ACTIONS_CAP = 100;
  readonly superToolCallOutcomes = new Map<string, SuperToolCallOutcome>();
  static readonly SUPER_TOOL_CALL_OUTCOME_CAP = 100;
  static readonly SUPER_TOOL_CALL_CORRECTION_CAP = 2;
  readonly superToolCallCorrections = new Map<string, number>();
  pendingSuperToolCallCorrections: Array<{ mainSessionId: string | null; text: string }> = [];
  superMergeWakeupTimer: ReturnType<typeof setTimeout> | null = null;
  superActionScanText = "";
  superActionScanOffset = 0;
  superActionPending = false;
  superActionPendingBody = "";
  superActionReceiptLast = "";
  superActionZeroWarned = false;
  readonly pendingSuperReports = new Map<string, SuperReportBuffer>();
  pendingSuperReportPrompts: PendingSuperReportPrompt[] = [];
  /**
   * G2 delivered-unacked 账本：`sendPrompt` 起来了、但回合中途 Stop / 失败导致
   * 主会话没有产出真正汇报的条目。键 = reportKeys.join(",")，值记录重试次数。
   * 这些报告的缓冲键刻意保持 in-flight（不 confirm），条目重新入投递队列，由
   * 心跳重投 —— 回合中途失败 / Stop 时汇报不会「投出去即丢」。
   */
  readonly reportDeliveryUnacked = new Map<string, UnackedSuperDelivery>();
  /** 隐藏汇报回合最多重投几次，之后确认出缓冲、靠 QQ 兜底缓存送真实结论。 */
  maxReportDeliveryAttempts = 3;
  /**
   * 方案 B 关联登记簿：`runSuperActions` 里由主 Agent 主动 cancel 的目标 id。
   * `manager.cancel(id,"agent")` 会同步触发 notifyReport → settleSuperReportsIfReady，
   * 借此把「本次 cancel 的 dropped 上报」暂存下来，等同一批动作回执入队时合并。
   * QQ 指令侧的 cancel（qq-host）不登记，照旧走独立汇报轮（它没有动作回执）。
   */
  private readonly agentCancelWithReceiptIds = new Set<string>();
  /** 等待并入动作回执的 agent-cancel 汇报；绝不静默丢弃（回执入队 / 换会话时回退）。 */
  private readonly pendingAgentCancelMerges: HeldAgentCancelReport[] = [];
  pendingSuperActionReceipts: PendingSuperActionReceipt[] = [];
  superReportRunning = false;
  static readonly SUPER_AUTO_TURN_PRIORITY = [
    "reports",
    "actionReceipts",
    "delegated",
    "corrections",
    "merges",
  ] as const;
  /** 派发与判空的唯一映射表：两处 switch 合并于此，避免规则漂移。 */
  private static readonly SUPER_AUTO_TURN_HANDLERS: Record<SuperAutoTurnKind, SuperAutoTurnHandler> = {
    reports: {
      drain: (host) => host.drainSuperReports(),
      hasWork: (host, owner) => host.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner),
    },
    actionReceipts: {
      drain: (host) => host.drainSuperActionReceipts(),
      hasWork: (host, owner) => host.pendingSuperActionReceipts.some((item) => item.mainSessionId === owner),
    },
    delegated: {
      drain: (host) => host.drainDelegatedUserTurns(),
      hasWork: (host, owner) => host.pendingDelegatedUserTurns.some((item) => item.mainSessionId === owner),
    },
    corrections: {
      drain: (host) => host.drainSuperToolCallCorrections(),
      hasWork: (host, owner) => host.pendingSuperToolCallCorrections.some((item) => item.mainSessionId === owner),
    },
    merges: {
      drain: (host) => host.drainSuperMerges(),
      hasWork: (host) => host.pendingSuperMerges.length > 0,
    },
  };
  superAutoTurnCursor = 0;
  mainLane: symbol | null = null;
  superHeartbeatTimer: NodeJS.Timeout | null = null;
  superWaitToastId: number | null = null;
  superWaitToastKey: string | null = null;
  deferredAutoTurnsToastId: number | null = null;
  superArchiveTimer: NodeJS.Timeout | null = null;
  superArchiveFingerprint = "";
  /** 终态 / 失败分类 / 改动去向的上一次指纹（批次2A 项6，触发 urgent 写）。 */
  superCriticalFingerprint = "";
  /** 运行组 id 序号 —— 一次委派块 = 一个 runId。 */
  private superRunSeq = 0;
  sweepInFlight = false;
  superSweepDelayMs = 3_000;
  readonly superReportedChildIds = new Set<string>();
  superLastStatus = new Map<string, SuperStatus>();
  currentTurnAttachments: {
    images: { data: string; mimeType: string }[];
    files: { name: string; path: string }[];
  } | null = null;
  pendingDelegatedUserTurns: Array<{
    mainSessionId: string | null;
    text: string;
    images: { data: string; mimeType: string }[];
    /** 与 `images` 同下标的逐图说明；无说明时为空数组。 */
    imageCaptions: string[];
    files: { name: string; path: string }[];
    contexts?: ContextRefUi[];
    droppedByChild: number;
  }> = [];
  readonly pendingSuperResidueConfirms = new Map<string, {
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  superResidueConfirmSeq = 0;
  /**
   * 丢弃残留的二次确认令牌表（批次2A，项5）。posted 的 superResidueConfirm 消息
   * 带 requestId，webview 回 `respondSuperResidueConfirm` 时凭它认领；确认为真才
   * 执行丢弃，超时/取消一律按不丢弃处理。
   */
  readonly pendingSuperDiscardConfirms = new Map<string, {
    items: SuperResidueItem[];
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  superDiscardConfirmSeq = 0;
  /** 心跳维护的「最近活动」投影（时间戳来自 manager.activitySnapshot()）。 */
  readonly superLastActivity = new Map<string, number>();
  autoTurnsStoppedFor: string | null = null;

  // --- Panel proxies (call-time forwarding; bodies below stay verbatim) ----
  private get log() { return this.deps.log; }
  private get context(): vscode.ExtensionContext { return this.deps.getContext(); }
  private get services() { return this.deps.getServices(); }
  private get store(): SessionStore { return this.deps.getStore(); }
  private get disposed(): boolean { return this.deps.isDisposed(); }
  private get editorPanel() { return this.deps.getEditorPanel(); }
  private get historySyncBusy(): boolean { return this.deps.isHistorySyncBusy(); }
  private get qqHost(): QqHost { return this.deps.getQqHost(); }
  private get qqFinalRescueText(): Map<string, string> { return this.deps.getQqFinalRescueText(); }
  private announceCue(...args: Parameters<SuperAgentHostCallbacks["announceCue"]>) { return this.deps.announceCue(...args); }
  private appendQqArchiveEvent(...args: Parameters<SuperAgentHostCallbacks["appendQqArchiveEvent"]>) { return this.deps.appendQqArchiveEvent(...args); }
  private captureQqReportTurnText(...args: Parameters<SuperAgentHostCallbacks["captureQqReportTurnText"]>) { return this.deps.captureQqReportTurnText(...args); }
  private currentMainSessionId() { return this.deps.currentMainSessionId(); }
  private contextReportFile(): string { return this.deps.contextReportFile(); }
  private deliverQqMainIntermediateText(...args: Parameters<SuperAgentHostCallbacks["deliverQqMainIntermediateText"]>) { return this.deps.deliverQqMainIntermediateText(...args); }
  private forwardQqMainTaskChildQuestion(...args: Parameters<SuperAgentHostCallbacks["forwardQqMainTaskChildQuestion"]>) { return this.deps.forwardQqMainTaskChildQuestion(...args); }
  private forwardQqTaskQuestion(...args: Parameters<SuperAgentHostCallbacks["forwardQqTaskQuestion"]>) { return this.deps.forwardQqTaskQuestion(...args); }
  private materializeSystemPrompt(variant: "main" | "child" = "main") { return this.deps.materializeSystemPrompt(variant); }
  private mcpProjectCwd() { return this.deps.mcpProjectCwd(); }
  private notifyOs(...args: Parameters<SuperAgentHostCallbacks["notifyOs"]>) { return this.deps.notifyOs(...args); }
  private postToWebview(message: unknown): void { this.deps.postToWebview(message); }
  private qqFinalRescueDue(...args: Parameters<SuperAgentHostCallbacks["qqFinalRescueDue"]>) { return this.deps.qqFinalRescueDue(...args); }
  private qqFinalRescueOwnerPending(...args: Parameters<SuperAgentHostCallbacks["qqFinalRescueOwnerPending"]>) { return this.deps.qqFinalRescueOwnerPending(...args); }
  private readMcpScopes() { return this.deps.readMcpScopes(); }
  private refreshMcpStatusFromBroker(): void { this.deps.refreshMcpStatusFromBroker(); }
  private resolveEntry(): string { return this.deps.resolveEntry(); }
  private resolveWorkspaceHandshakeCreds() { return this.deps.resolveWorkspaceHandshakeCreds(); }
  private chunkText(content: unknown): string { return this.deps.chunkText(content); }
  private sendPrompt(...args: Parameters<SuperAgentHostCallbacks["sendPrompt"]>): ReturnType<SuperAgentHostCallbacks["sendPrompt"]> {
    return this.deps.sendPrompt(...args);
  }

  // --- Migrated methods (verbatim from panel.ts) ---------------------------

  /**
   * The main session's hidden Super Agent report turn settled: the main agent
   * has read the child results and reported back. That IS main-session work
   * finishing, so it keeps the regular completion chime — but on its own OS
   * event (`superReport`) so it is never conflated with a child settling.
   */
  announceSuperReport(text: string): void {
    this.announceCue("superReport", text, "done");
  }

  /** ONE child session reached a terminal state (per-child light cue). */

  announceChildDone(text: string): void {
    this.announceCue("childDone", text, "child");
  }


  /**
   * Super Agent 内置工具（`super-agent` / `super-agent-actions`）的权限请求
   * 直接放行，不弹审批卡。
   *
   * 理由：该工具本身**只回 ack**，真正干活的是宿主 —— `handleSuperToolCall`
   * 从 `args` 取载荷，交给与正文围栏完全相同的派发 / 动作链路。正文围栏派发
   * 从来不经审批，所以同一条信任级别的内置工具也不额外加卡；否则模型每派一次
   * 子会话就要用户点一次，把「随时开启」变成「每次确认」，安全边界却没有任何
   * 增量（工具不执行任何东西）。
   *
   * 只对这一个工具生效：其它工具仍走审批卡。响应里的 `optionId` **必须是
   * agent 真正给出的** —— CLI 用 `nativeEnum` 解析，伪造会抛错并卡死回合；
   * 没有 allow 选项时按现有取消路径回 `cancelled`，绝不伪造批准。
   */
  autoApproveSuperAgentTool(req: RequestPermissionRequest): RequestPermissionResponse | null {
    // 识别顺序按证据强度从强到弱（全部只对「命中即放行」生效，未命中仍走
    // 规则表 / 审批卡）：
    //  1. 工具名归一（含命名空间前缀与分隔符变体）；
    //  2. 标题里直接写着工具名（CLI 0.5.19 的权限请求经常省略 toolName）；
    //  3. 标题是内置工具的短标签 —— 智能审批（SMART）的 RISKY 分支构造
    //     toolCall 时只填 `title: getDescription(params)`，派发形态是
    //     `Delegate 1 task`、管理形态是 `Manage 1 child session action`
    //     （bundle 实证 0.5.19，见 shared/super-tool-call.ts 的
    //     classifySuperToolTitle）；
    //  4. 以上都没有时按**真实载荷结构**兜底（tasks / actions 严格校验）。
    // 只看 title 会漏掉无标题形态、只看载荷会漏掉智能审批（它不带 args），
    // 两者叠加才覆盖当前已知的全部形态。
    const toolName = (req.toolCall.toolName ?? "").trim();
    const title = (req.toolCall.title ?? "").trim();
    const kind =
      (toolName ? classifySuperToolName(toolName) : null) ??
      (title ? classifySuperToolName(title) : null) ??
      (title ? classifySuperToolTitle(title) : null) ??
      classifySuperToolArgs(req.toolCall.args);
    if (!kind) return null;
    const label = toolName || title || "super-agent";
    const option =
      req.options.find((o) => o.kind === "allow_always") ??
      req.options.find((o) => o.kind.startsWith("allow"));
    if (!option) {
      this.log.warn(`super agent: "${label}" permission request offers no allow option — cancelling`);
      return { outcome: { outcome: "cancelled" } };
    }
    this.log.info(`super agent: auto-allowed built-in tool "${label}" (${kind}, ${option.kind})`);
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  


  // --- Tool approval flow (session/request_permission) --------------------------


  /**
   * 用户停止后如实告诉用户还有多少自动回合被压住。
   *
   * 静默压制会让「我明明点了停止，怎么还有东西在等」变成新的困惑；数量为 0
   * 时保持安静（每次停止都弹一条会变成噪声）。提示常驻并带「继续处理」动作：
   * 一次性的 toast 转瞬即逝，用户看到的就是「点了停止、按钮还禁着、没人告诉我
   * 出路」的死锁。压制解除（下一条消息 / 新建会话 / 面板关闭 / 点了动作）时
   * 由 clearDeferredAutoTurnsToast 收掉，绝不常驻到下一轮。
   */
  announceDeferredAutoTurns(): void {
    const pending = this.pendingAutoTurnCount();
    if (pending === 0) return;
    this.clearDeferredAutoTurnsToast();
    this.deferredAutoTurnsToastId = this.store.sendToast(
      "info",
      vscode.l10n.t("已停止；还有 {0} 项超流体结果待处理。发送下一条消息，或点「继续处理」查看结果", pending),
      {
        persistent: true,
        action: { actionId: "resume-super-turns", label: vscode.l10n.t("继续处理") },
      },
    );
    // 常驻「等待子会话」提示的文案也要跟着变（它默认写着「会自动继续」）。
    this.deps.refreshSuperWaitHeartbeat();
  }

  /** 收掉「已停止 · N 项待处理」常驻提示（压制解除的各条路径共用）。 */

  clearDeferredAutoTurnsToast(): void {
    if (this.deferredAutoTurnsToastId !== null) {
      this.store.dismissToast(this.deferredAutoTurnsToastId);
      this.deferredAutoTurnsToastId = null;
    }
  }


  /**
   * 请求 webview 弹出「清空并新建」二次确认框。
   *
   * 警示文案在宿主侧组装（含明确写出「未合并 worktree 的未提交/未合并工作
   * 永久丢失且不可恢复」），webview 只渲染、不改写。所有 teardown 路径都要
   * 收口未答的 promise：无 webview 应答时 60s 超时按「取消」处理，绝不擅自
   * 清空用户磁盘。
   */
  requestSuperResidueConfirm(count: SuperResidueCount): Promise<boolean> {
    this.cancelAllSuperResidueConfirms();
    const requestId = `super-residue-${++this.superResidueConfirmSeq}`;
    const title = vscode.l10n.t("清空并新建会话？");
    const message = vscode.l10n.t(
      "检测到 {0} 个历史超流体残留目录（Git 工作目录 {1} 个 / 降级目录 {2} 个 / 附件 {3} 个）。继续将清空全部残留，包括未合并的 Git 工作目录——其中未提交/未合并的代码改动将永久丢失且不可恢复。请确认这些工作不再需要。",
      count.total,
      count.worktrees,
      count.dirs,
      count.attachments,
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时 = 用户没答：按取消处理，只新建不清空。
        this.pendingSuperResidueConfirms.delete(requestId);
        resolve(false);
      }, 60_000);
      this.pendingSuperResidueConfirms.set(requestId, { resolve, timer });
      this.postToWebview({
        type: "superResidueConfirm",
        requestId,
        title,
        message,
        confirmLabel: vscode.l10n.t("清空并新建"),
        cancelLabel: vscode.l10n.t("取消"),
      });
    });
  }


  handleSuperResidueConfirmResponse(requestId: string, confirmed: boolean): void {
    const pending = this.pendingSuperResidueConfirms.get(requestId);
    if (pending) {
      this.pendingSuperResidueConfirms.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(confirmed);
      return;
    }
    // 丢弃残留用的是同一条 superResidueConfirm 消息 / respondSuperResidueConfirm
    // 回包，只是 requestId 前缀不同；确认为真才真正执行丢弃。
    const discard = this.pendingSuperDiscardConfirms.get(requestId);
    if (discard) {
      this.pendingSuperDiscardConfirms.delete(requestId);
      clearTimeout(discard.timer);
      discard.resolve(confirmed);
    }
  }


  cancelAllSuperResidueConfirms(): void {
    for (const pending of this.pendingSuperResidueConfirms.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingSuperResidueConfirms.clear();
    for (const pending of this.pendingSuperDiscardConfirms.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingSuperDiscardConfirms.clear();
  }


  /**
   * 新建会话前的残留检测 + 用户授权下的全量清空（跨全部历史会话）。
   *
   * 检测只读目录计数，不跑 git 探测；没有 webview（命令面板入口）时跳过 ——
   * 没有弹框就无从确认，不能拿一个永远没人答的 promise 挡住新建会话。
   * 用户取消 / 检测失败 / 清空失败都只记日志，继续正常新建会话。
   */
  async confirmAndPurgeSuperResidue(): Promise<void> {
    if (this.disposed || !this.editorPanel) return;
    const manager = this.deps.getSuperAgent();
    if (!manager) return;
    const count = await manager.countResidue().catch((error: unknown) => {
      this.log.warn(`super agent: 残留检测失败（不影响新建会话）：${errorMessage(error)}`);
      return null;
    });
    if (!count || count.total === 0) return;
    const confirmed = await this.requestSuperResidueConfirm(count);
    if (this.disposed) return;
    if (!confirmed) {
      this.log.info(`super agent: 用户取消清空（残留 ${count.total} 个），只新建会话`);
      return;
    }
    const purged = await manager.purgeAllResidue().catch((error: unknown) => {
      this.log.warn(`super agent: 全量清空失败（继续新建会话）：${errorMessage(error)}`);
      return null;
    });
    if (purged) {
      this.log.info(
        `super agent: 已清空残留（worktree ${purged.worktrees} / 目录 ${purged.dirs} / 附件 ${purged.attachments}，失败 ${purged.failed}）`,
      );
      if (purged.failed > 0) {
        this.store.sendToast(
          "warning",
          vscode.l10n.t("已清空历史超流体残留，但有 {0} 个目录未能删除（请手动检查）", purged.failed),
        );
      }
    }
  }

  // --- 残留聚合与一键处理（批次2A 项5）-------------------------------------
  //
  // 注明：listSuperResidue / requestSuperResidueDiscardConfirm / handleSuperResidueAction
  // 这条「令牌化残留处置」通道是为批量令牌化场景保留的；当前 webview 的残留处置
  // 走 superAgent.cleanup / superAgent.merge 旧协议，两套并存、功能等价。勿因
  // 「当前 UI 未调用」就当作死代码删除。

  /**
   * 宿主侧残留明细：未合并 / 已中断 / 放弃的 super worktree 与孤儿目录。
   * 只读聚合，绝不在这里删任何东西。
   */
  async listSuperResidue(): Promise<SuperResidueItem[]> {
    const manager = this.deps.getSuperAgent();
    if (!manager || typeof manager.listResidueItems !== "function") return [];
    return manager.listResidueItems().catch(() => []);
  }

  /**
   * 发起「丢弃残留」二次确认，返回令牌（requestId）。webview 必须把令牌随
   * `respondSuperResidueConfirm` 回传（`handleSuperResidueConfirmResponse` 认领）；
   * 超时 / 取消一律按不丢弃处理，确认为真才执行。
   */
  requestSuperResidueDiscardConfirm(items: SuperResidueItem[]): string {
    this.cancelAllSuperResidueConfirms();
    const requestId = `super-residue-discard-${++this.superDiscardConfirmSeq}`;
    const title = vscode.l10n.t("丢弃残留工作目录？");
    const names = items.map((item) => item.branch ?? item.title ?? item.key).join("、");
    const message = vscode.l10n.t(
      "即将丢弃 {0} 项残留（{1}）。含未提交改动的目录会被保护、不会删除；其余工作将被永久删除且不可恢复。请确认不再需要。",
      items.length,
      names,
    );
    const timer = setTimeout(() => {
      this.pendingSuperDiscardConfirms.delete(requestId);
    }, 60_000);
    if (typeof timer.unref === "function") timer.unref();
    this.pendingSuperDiscardConfirms.set(requestId, {
      items,
      resolve: (confirmed) => {
        if (!confirmed) return;
        void this.executeSuperResidueDiscard(items);
      },
      timer,
    });
    this.postToWebview({
      type: "superResidueConfirm",
      requestId,
      title,
      message,
      confirmLabel: vscode.l10n.t("丢弃"),
      cancelLabel: vscode.l10n.t("取消"),
    });
    return requestId;
  }

  /** 二次确认通过后逐条丢弃；单条失败记日志并汇总，绝不批量吞错。 */
  private async executeSuperResidueDiscard(items: SuperResidueItem[]): Promise<void> {
    const manager = this.deps.getSuperAgent();
    if (!manager || typeof manager.discardResidueItem !== "function") return;
    let done = 0;
    let failed = 0;
    let lastReason = "";
    for (const item of items) {
      try {
        const result = await manager.discardResidueItem(item);
        if (result.ok) done += 1;
        else {
          failed += 1;
          lastReason = result.reason ?? "未知原因";
        }
      } catch (error) {
        failed += 1;
        lastReason = errorMessage(error);
      }
    }
    await this.persistSuperSessions({ force: true });
    if (failed > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已丢弃 {0} 项残留，{1} 项未能丢弃（{2}）", done, failed, lastReason),
      );
    } else {
      this.store.sendToast("info", vscode.l10n.t("已丢弃 {0} 项残留", done));
    }
  }

  /**
   * 一键处理一条残留。`merge` 走既有「让智能体合并」通道 —— 宿主绝不机械合并
   * 用户工作区；`discard` 的硬性前置是业务侧二次确认令牌：首次调用只发确认框并
   * 返回 token，绝不直接删。
   */
  async handleSuperResidueAction(input: {
    key: string;
    action: "merge" | "discard";
  }): Promise<{ ok: boolean; token?: string; reason?: string }> {
    const items = await this.listSuperResidue();
    const item = items.find((candidate) => candidate.key === input.key);
    if (!item) return { ok: false, reason: "该残留已不存在" };
    if (input.action === "merge") {
      if (!item.sessionId) {
        return { ok: false, reason: "孤儿分支没有关联子会话，宿主不能机械合并" };
      }
      // requestSuperMerge 内部已含 merge-tree 预演与中间态检测纪律。
      await this.requestSuperMerge(item.sessionId);
      return { ok: true };
    }
    const token = this.requestSuperResidueDiscardConfirm([item]);
    return { ok: false, token, reason: "待二次确认" };
  }

  /**
   * 批量丢弃：把一次请求里选中的多个残留聚合到**同一条**二次确认。
   *
   * 逐条调用 `handleSuperResidueAction` 会让每次 `requestSuperResidueDiscardConfirm`
   * 先 `cancelAllSuperResidueConfirms()` 取消上一次待确认请求 —— 批量时只有
   * 最后一项能弹出确认框，其余被静默取消（用户以为全部丢弃，实际只丢了最后
   * 一条）。`requestSuperResidueDiscardConfirm` 本身接受数组并在确认后逐条执行，
   * 因此这里先解析出全部条目、只发一次确认。
   */
  async handleSuperResidueDiscardBatch(input: {
    keys: string[];
  }): Promise<{ ok: boolean; token?: string; reason?: string }> {
    const items = await this.listSuperResidue();
    const wanted = new Set(input.keys);
    const selected = items.filter((item) => wanted.has(item.key));
    if (selected.length === 0) return { ok: false, reason: "这些残留已不存在" };
    const token = this.requestSuperResidueDiscardConfirm(selected);
    return { ok: false, token, reason: "待二次确认" };
  }

  // --- 重试 / 判定卡死 handler（批次2A 项1、项2）--------------------------

  /** WebviewToHost `superRetryWave` 的宿主入口（按波次重排重试）。 */
  async retrySuperWave(input: { runId?: string; wave: number }): Promise<void> {
    const manager = this.deps.getSuperAgent();
    if (!manager || typeof manager.retryWave !== "function") return;
    const ids = await manager.retryWave(input);
    if (ids.length === 0) {
      this.store.sendToast("warning", vscode.l10n.t("该波次没有可重试的任务"));
    } else {
      this.store.sendToast("info", vscode.l10n.t("已重新派发第 {0} 波的 {1} 个任务", input.wave, ids.length));
    }
    await this.persistSuperSessions({ force: true });
  }

  /** WebviewToHost `superRetryFailed` 的宿主入口（整组失败重试）。 */
  async retrySuperFailed(input: { runId?: string } = {}): Promise<void> {
    const manager = this.deps.getSuperAgent();
    if (!manager || typeof manager.retryFailed !== "function") return;
    const ids = await manager.retryFailed(input);
    if (ids.length === 0) {
      this.store.sendToast("warning", vscode.l10n.t("当前运行组没有可重试的任务"));
    } else {
      this.store.sendToast("info", vscode.l10n.t("已重新派发 {0} 个失败任务", ids.length));
    }
    await this.persistSuperSessions({ force: true });
  }

  /**
   * 用户主动「判定卡死」：如实先记一条用户判定的 timeout 诊断，再按 user 来源
   * 中断，走与看板「中断」完全相同的收口（不是静默杀进程）。
   */
  async judgeSuperStuck(sessionId: string): Promise<void> {
    const manager = this.deps.getSuperAgent();
    if (!manager || typeof manager.judgeStuck !== "function") return;
    const outcome = await manager.judgeStuck(sessionId);
    if (outcome.reason === "cancelled") {
      this.store.sendToast("info", vscode.l10n.t("已按你的判断中止超流体（判定为卡住），原因已记入诊断。"));
    } else if (outcome.reason === "already-terminal") {
      this.store.sendToast("info", vscode.l10n.t("这个超流体已经结束了，无需判定卡死"));
    } else {
      this.store.sendToast("warning", vscode.l10n.t("该超流体不存在或已被清理"));
    }
    await this.persistSuperSessions({ force: true });
  }

  // --- Diff revert ----------------------------------------------------------------


  /**
   * 批次2A 项6：计算「终态 / 失败分类 / 改动去向 / 结束时刻」的关键指纹，返回是否
   * 发生了必须**立即**落盘的变化。批次1A 的 superArchiveFingerprint 刻意不含
   * diagnostics（高频追加流），这里用独立指纹兜住「重启后必须还在」的事实。
   */
  noteSuperCriticalChange(sessions: readonly SuperSessionUi[]): boolean {
    const critical = sessions
      .map((s) =>
        [
          s.id,
          s.status,
          s.lastError ? `${s.lastError.kind}@${s.lastError.at}` : "",
          s.integration?.state ?? "",
          s.integration?.needsAction ? "1" : "0",
          s.endedAt ?? "",
        ].join("|"),
      )
      .sort()
      .join("\n");
    const urgent = critical !== this.superCriticalFingerprint;
    this.superCriticalFingerprint = critical;
    return urgent;
  }

  /**
   * 把看板投影推给 webview（按当前主会话取历史子会话）。
   *
   * 会话切换后必须重推一次：看板的归属跟着主会话走，A 的历史子会话不能在
   * B 的看板上出现。管理器只在子会话状态变化时 emit，纯切换不会触发。
   */
  publishSuperSessions(): void {
    const sessions = this.superAgent?.list(this.currentMainSessionId()) ?? [];
    this.store.setSuperSessions(sessions);
    // 看板换了归属，等待态也得跟着重算（否则切完会话还留着旧的忙碌标记）。
    this.syncSuperWaitingState();
  }


  /**
   * 把子会话记录落盘（重启后据此恢复看板）。
   *
   * 只存**记录**：分支、工作目录、结束状态、汇报历史。子会话的实时转录本来
   * 就不落盘（既定边界），待应答的提问随进程一起没了 —— 恢复出来也答不了，
   * 所以不存。
   *
   * 按**归属的主会话**逐个写：子会话是异步跑的，用户随时可能切到别的会话
   * 去，只写当前会话会把别人的归档覆盖成空。
   *
   * 返回 Promise：面板关闭时要 await 它 —— 那时宿主随时会退出，fire-and-forget
   * 的写很可能来不及落盘，子会话记录就此丢失。
   *
   * **写放大控制**：看板每变一次就会触发一次落盘，而实时进度每秒能变好几次
   * —— 每次都整份重写归档是纯粹的磁盘 IO 浪费（子会话多时能把 IO 拉满）。
   * 但**关键变更不能拖**：终态、改动去向、归档归属是「重启后必须还在」的
   * 事实，扩展随时可能被重启，拖到最后就等于那次运行发生过什么彻底丢了。
   * 所以按内容分两类：关键内容变了立刻写，只有展示性字段变化时合并到一次
   * 节流写里（`force` = true 时无视节流，直接写）。
   */
  persistSuperSessions(options: { force?: boolean } = {}): Promise<void> {
    const manager = this.superAgent;
    // 测试桩 / 只实现部分表面的 manager 可能没有归档接口 —— 安全跳过。
    if (!manager || typeof manager.archivableMainSessionIds !== "function") {
      return Promise.resolve();
    }
    const fingerprint = superArchiveFingerprint(
      manager.archivableMainSessionIds().map((mainSessionId) => ({
        mainSessionId,
        sessions: manager.archivableSessions(mainSessionId),
      })),
    );
    const urgent = options.force === true || fingerprint !== this.superArchiveFingerprint;
    if (urgent) {
      this.superArchiveFingerprint = fingerprint;
      // 关键变更立刻写：还没跑的节流写也就不需要了（它写的是同一份内容）。
      if (this.superArchiveTimer) {
        clearTimeout(this.superArchiveTimer);
        this.superArchiveTimer = null;
      }
      return this.writeSuperArchives();
    }
    if (!this.superArchiveTimer) {
      const timer = setTimeout(() => {
        this.superArchiveTimer = null;
        void this.writeSuperArchives();
      }, SUPER_ARCHIVE_THROTTLE_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.superArchiveTimer = timer;
    }
    return Promise.resolve();
  }

  /** 真正写归档（每个归属主会话一个文件）。 */

  writeSuperArchives(): Promise<void> {
    const manager = this.superAgent;
    if (!manager) return Promise.resolve();
    const writes = manager.archivableMainSessionIds().map((mainSessionId) =>
      writeSuperSessionArchive(
        this.superStoreDir(),
        mainSessionId,
        manager.archivableSessions(mainSessionId),
      ).catch((error) => {
        this.log.warn(`super agent archive write failed: ${errorMessage(error)}`);
      }),
    );
    return Promise.all(writes).then(() => undefined);
  }

  /** 子会话归档的存放目录（扩展自己的存储，不进用户的仓库）。 */

  superStoreDir(): string {
    return (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
  }


  /**
   * 恢复某个主会话的子会话历史（重启后恢复该会话时调用）。
   *
   * 归档里是「那次运行发生过什么」的记录，进程早已不存在，所以状态归一在
   * `fromPersistedSuperSession` 里做（运行中 → 已中断）。分支与工作目录照旧
   * 保留 —— 它们还在磁盘上，用户照样能清理或让智能体合并。
   */
  async restoreSuperSessions(mainSessionId: string): Promise<void> {
    const archive = await readSuperSessionArchive(this.superStoreDir(), mainSessionId);
    // 归档**读不出来**是故障，不是「这个会话没有子会话」。必须如实告诉用户
    // —— 旧实现把两者都当成空数组，用户重启后只看到空板子，完全看不出发生过
    // 什么。损坏的原件已由读侧留底（归档名.corrupt），路径一并报出。
    if (archive.damaged) {
      this.log.warn(
        `super agent: 超流体归档读不出来（${archive.damage ?? "unknown"}），备份：${archive.backupPath ?? "-"}`,
      );
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "超流体记录已损坏，原文件已备份；这条会话的超流体记录无法恢复（{0}）",
          archive.backupPath ?? archive.damage ?? "unknown",
        ),
      );
    }
    const records = archive.sessions;
    if (records.length > 0) {
      // 归档里的隔离目录可能已被外部手工删除，或上次失败的清理留下半删残迹。
      // 恢复前核对磁盘事实，让 fromPersistedSuperSession 如实校正 released /
      // recycled —— 否则看板会对一个早就不存在的目录显示「待清理」。
      // **必须用原始 isolation.path 判存在性**：comparisonPathKey 为路径比较做了
      // toLowerCase，Linux 大小写敏感，用它 existsSync 会把 mkdtemp 随机后缀含大写
      // 字母的现存目录误判为不存在（ubuntu CI 实测），进而错误保留 released:true。
      // 核对失败时不猜（留 undefined = 保留归档原样）；这里只读盘，**绝不自动删**
      // 任何孤儿目录或分支。
      const restored = await Promise.all(
        records.map(async (record) => {
          const kind = record.isolation.kind;
          if (kind === "repo") return fromPersistedSuperSession(record);
          try {
            return fromPersistedSuperSession(record, {
              worktreePresent: existsSync(record.isolation.path),
            });
          } catch {
            return fromPersistedSuperSession(record);
          }
        }),
      );
      this.log.info(`super agent: restored ${restored.length} historical child session(s) for ${mainSessionId}`);
      // 历史记录同样要能落到默认工作区上：管理器需要一个 repoRoot 才能构造。
      // 启动阶段静默解析（不弹 toast）—— 路径没配 / 写错不该在恢复历史时打扰
      // 用户，真正需要提示的时机是派发。`create:false`：恢复不是派发，不该
      // 顺手在用户家目录里建 `~/.iflow/workspace`。
      if (this.superRepoRoot() === null) await this.resolveSuperWorkspace({ create: false });
      this.deps.getSuperAgent()?.restoreSessions(mainSessionId, restored);
      // 终态转录是旁路展示数据：读回填充详情面板。只读小 JSON、读失败静默
      // 跳过，绝不因它挡住看板恢复（与 sweepStaleWorktrees 改后台同一纪律：
      // 启动序列不可被重 IO 拖住）。恢复出来的转录只进管理器展示缓存，不进
      // 归档记录、不让历史子会话变得可重试。
      await this.restoreSuperTranscriptSnapshots(records.map((record) => record.id));
    }
    // 恢复归档时顺带清扫磁盘上的残留 worktree（只在恢复时触发，不是每次
    // 快照都跑）：上次运行遗留的、已经并入当前分支的空 worktree 与分支，
    // 在这里被收掉 —— 否则它们会一直堆在 `.iflow/super/worktrees/` 下。
    // 超过 `iflow.superAgent.maxWorktrees` 的干净残留（含未合并的）按目录
    // mtime 从旧到新回收目录、保留分支。
    //
    // **绝不 await**：这一步要逐个残留目录跑 `git status` + merge-base 探测，
    // 而本方法处于 connect() 的启动序列里（restoreSession 被 await），新建
    // 会话又要先等在飞的恢复 settle —— 串起来就是用户实测的「点新建会话
    // 毫无反应，只在控制台反复打 new session: joining the in-flight run」。
    this.sweepStaleWorktreesInBackground();
  }


  /**
   * 读回终态转录快照并推给 webview 的详情面板。
   *
   * 只读小 JSON，读失败静默跳过 —— 转录是旁路展示数据，绝不因它挡住看板
   * 恢复。恢复出来的转录只进管理器展示缓存，不进归档记录、不让历史子会话
   * 变得可重试（见 {@link SuperAgentManager.restoreTranscripts}）。
   */
  async restoreSuperTranscriptSnapshots(childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;
    const manager = this.superAgent;
    if (!manager) return;
    const dir = this.superStoreDir();
    // 并行读小文件：一个会话可能有多个子会话，串行读会让启动序列无谓变慢。
    const snapshots = await Promise.all(
      childIds.map(async (id) => {
        try {
          const blocks = await readSuperTranscriptSnapshot(dir, id);
          return blocks.length > 0 ? { sessionId: id, blocks } : null;
        } catch (error) {
          // readSuperTranscriptSnapshot 自身不抛；这里是防御性兜底。
          this.log.warn(`super agent: transcript snapshot read failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
    const present = snapshots.filter((item): item is { sessionId: string; blocks: Block[] } => item !== null);
    if (present.length === 0) return;
    // 与实时通道同一条消息、同一起点（from:0 覆盖式写入）。
    for (const { sessionId, blocks } of present) {
      this.postToWebview({ type: "superTranscript", sessionId, from: 0, blocks });
    }
    manager.restoreTranscripts(present);
  }


  /**
   * 后台清扫磁盘上的残留 worktree（**绝不阻塞会话恢复 / 新建会话**）。
   *
   * 因果链（2026-11-18 用户实测）：`connect()` → `restoreSession()` →
   * `restoreSuperSessions()` → `await sweepStaleWorktrees()`。每个残留目录都要
   * 跑 `git status --porcelain` 与 `merge-base --is-ancestor`，工程一大（或磁盘
   * 被索引器/杀软占着）就是几十秒；期间用户点「新建会话」→ `startNewSession`
   * 发现恢复在飞 → 停在恢复的 settle 上 → 后续点击全部 join 同一次 run。
   *
   * 纪律：
   *  - fire-and-forget，但**必须有 catch**：清扫失败只记警告 + 一条提示，
   *    绝不变 unhandled rejection，也绝不影响新建会话；
   *  - 同一时刻只跑一次（`sweepInFlight`）：恢复被反复触发时不叠多份 git 子进程；
   *  - 清扫本身幂等（见 `SuperAgentManager.sweepStaleWorktrees`），晚一点跑与
   *    早一点跑结果相同，代价只是磁盘残留多留一会儿。
   */
  sweepStaleWorktreesInBackground(): void {
    if (this.disposed || this.sweepInFlight) return;
    const manager = this.deps.getSuperAgent();
    if (!manager) return;
    const maxKeep = clampMaxSuperWorktrees(
      this.setting<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
    );
    // 同步占位：延时窗口内反复恢复 / 新建会话也只排一份 sweep。manager 的
    // 同步抛错仍在调用点按原语义冒泡（由上层 catch 兜住），不推迟到定时器里。
    this.sweepInFlight = true;
    const timer = setTimeout(() => {
      if (this.disposed) {
        this.sweepInFlight = false;
        return;
      }
      void Promise.resolve()
        // 用一个已 resolve 的 promise 起链：manager 的同步抛错也落进 catch，
        // 不会在定时器回调里炸出去变成 unhandled rejection。
        .then(async () => {
          // 三类残留同在 `.iflow/super/` 下：worktrees（既有清扫）、attachments、
          // dirs（降级目录）。并排跑，任何一类失败都落进下面的 catch，不影响会话。
          // 每一项都经 Promise.resolve().then() 包一层：即便某个 manager 方法同步
          // 抛错（stub 未实现 / 未来改动），也只是该项变成 rejected，不会在数组
          // 求值时打断其余项的 handler 绑定 —— 否则先返回的 rejected promise 会
          // 变成 unhandled rejection（Vitest Errors 1）。
          const [swept] = await Promise.all([
            Promise.resolve().then(() => manager.sweepStaleWorktrees({ maxKeep })),
            Promise.resolve().then(() => manager.sweepStaleSuperAttachmentDirs()),
            Promise.resolve().then(() => manager.sweepStaleSuperDirs()),
          ]);
          return swept;
        })
        .then((swept) => {
          if (this.disposed) return;
          if (swept.removed > 0 || swept.kept > 0 || swept.orphans.length > 0) {
            this.log.info(
              `super agent: 残留清扫（后台）— 删除 ${swept.removed} 个，保留 ${swept.kept} 个，疑似残留 ${swept.orphans.length} 个（需人工确认）`,
            );
          }
        })
        .catch((error: unknown) => {
          // 背景清扫失败不是会话故障：可观测（日志 + 提示），但绝不冒泡。
          this.log.warn(`super agent: 后台残留清扫失败（不影响会话）：${errorMessage(error)}`);
          if (!this.disposed) {
            this.store.sendToast(
              "warning",
              vscode.l10n.t("后台清理残留工作目录失败（不影响会话）：{0}", errorMessage(error)),
            );
          }
        })
        .finally(() => {
          this.sweepInFlight = false;
        });
    }, this.superSweepDelayMs);
    // 定时器本身不该把扩展宿主 / 测试进程吊住。
    timer.unref?.();
  }


  /**
   * 主仓根目录（worktree 的来源，也是委派附件路径的允许边界）。
   *
   * 顺序：打开的工作区根 → 已校验的默认工作区（`iflow.superAgent.defaultWorkspace`）
   * → null。默认工作区只在异步校验成功后才会出现在这里（见
   * {@link resolveSuperWorkspace}），所以同步读取不会把不存在的路径交给
   * worktree / 附件边界。
   *
   * 没有可用目录时返回 null，调用方必须经
   * {@link ensureSuperAgentForDispatch} 统一判空并给出真实原因 —— 不要各自
   * 再写一份拒绝逻辑（那正是「未配置 / 路径不存在 / 不是目录」被压成一句
   * 话的来源）。
   */
  superRepoRoot(): string | null {
    return (
      this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.defaultWorkspaceRoot ??
      null
    );
  }


  /**
   * 激活期静默预热默认工作区（`extension.ts` 在 warmStart 之后 fire-and-forget 调用）。
   *
   * 无打开工作区时提前异步解析并按需建目录（`create:true`），让首次派发同步命中、
   * 不再 deferred；有工作区时 {@link resolveSuperWorkspace} 内部走零 I/O 分支，
   * 不建目录、不弹提示。此刻没有 webview，失败只记日志，用户可见提示仍归
   * {@link ensureSuperAgentForDispatch}。不预热管理器：`dispatchSuperTasks` 的
   * `getSuperAgent()` 会在首次点击时同步按已校验的根构造，避免激活期多余副作用。
   */
  async prefetchSuperWorkspace(): Promise<void> {
    if (this.disposed) return;
    const resolution = await this.resolveSuperWorkspaceShared({ create: true });
    if (!resolution.ok) {
      this.log.warn(
        `super agent: 激活期默认工作区预热失败（不影响启动，派发时会重试并给出原因）：${resolution.reason} ${resolution.path}`,
      );
      return;
    }
    if (resolution.source === "default-workspace") {
      this.log.info(`super agent: 激活期已预热默认工作区 ${resolution.root}`);
    }
  }

  /**
   * prefetch 与派发共用的解析入口：join 同一个 in-flight promise，并缓存结果。
   * 并发语义详见 {@link superWorkspaceResolveInFlight}。
   */
  private resolveSuperWorkspaceShared(
    options: { create?: boolean } = {},
  ): Promise<SuperWorkspaceResolution> {
    if (this.superWorkspaceResolveInFlight) return this.superWorkspaceResolveInFlight;
    const run = this.resolveSuperWorkspace(options)
      .then((resolution) => {
        this.lastSuperWorkspaceResolution = { resolution, fallbackToastSent: false };
        return resolution;
      })
      .finally(() => {
        // 只清自己那一份：极端交错下可能已有更新的解析占住了缓存。
        if (this.superWorkspaceResolveInFlight === run) this.superWorkspaceResolveInFlight = null;
      });
    this.superWorkspaceResolveInFlight = run;
    return run;
  }

  /** 首次派发补发 prefetch 静默跳过的 fallback 警告（同一份解析只发一次）。 */
  private emitCachedFallbackToast(): void {
    const cached = this.lastSuperWorkspaceResolution;
    if (!cached || cached.fallbackToastSent) return;
    cached.fallbackToastSent = true;
    const { resolution } = cached;
    // 只有「当前根确实是这次解析采纳的默认工作区」才补发：工作区用户 /
    // 配置已变更的用户都不该收到这条与现状不符的警告。
    if (!resolution.ok || resolution.source !== "default-workspace") return;
    if (!resolution.fallback || this.superRepoRoot() !== resolution.root) return;
    this.log.warn(
      `super agent: 默认工作区设置无效（${resolution.fallback.reason}: ${resolution.fallback.configured}），已改用 ${resolution.root}`,
    );
    this.store.sendToast("warning", this.superWorkspaceFallbackToast(resolution));
  }

  /**
   * `iflow.superAgent.defaultWorkspace` 在运行中被改动时由 panel 调用：
   * 作废 prefetch / adopt 的默认工作区缓存，下次派发重新解析。
   * 有打开工作区时默认工作区本就不参与，无需处理；沿用
   * {@link adoptDefaultWorkspaceRoot} 的约束：有子会话在跑时保持旧根不切换。
   */
  invalidateDefaultWorkspace(): void {
    if (this.services.workspaceRoot || (vscode.workspace.workspaceFolders?.length ?? 0) > 0) return;
    const manager = this.superAgent;
    if (manager && !this.isSuperAgentIdle(manager)) {
      this.log.warn("super agent: 默认工作区设置已改，但仍有子会话在跑，本次不换根");
      return;
    }
    this.defaultWorkspaceRoot = null;
    this.superWorkspaceResolveInFlight = null;
    this.lastSuperWorkspaceResolution = null;
    if (manager) {
      this.superAgent = null;
      void manager.dispose().catch(() => undefined);
    }
  }

  /** 管理器是否空闲（没有在跑的子会话）——换根 / 作废缓存的安全条件。 */
  private isSuperAgentIdle(manager: SuperAgentManager): boolean {
    try {
      return manager.list().length === 0;
    } catch {
      return false;
    }
  }


  /**
   * 派发可用工作目录的唯一 resolver。
   *
   * 顺序与 {@link SuperWorkspaceResolution} 一致：
   *   1. 打开的工作区根 → 直接返回（零 I/O，既有行为逐字节不变）；
   *   2. 没有 → `iflow.superAgent.defaultWorkspace`：留空 / 空白直接用内置默认
   *      目录；非绝对路径或指向普通文件 → **非阻断**回退内置默认（带 fallback
   *      原因，由调用方弹一条警告 toast）；合法但不存在 → 异步 mkdir 后使用；
   *   3. 内置默认目录 `~/.iflow/workspace` 同样按需创建；
   *   4. 只有 mkdir / stat 真失败才返回 `ok:false`（附底层错误）；
   *   5. 成功 → 缓存进 {@link superRepoRoot}，让子会话 cwd、
   *      `--include-directories`、allowedRoots、附件边界全部同源。
   *
   * 陷阱 #18：绝不同步探测 —— stat / mkdir 全部走 `node:fs/promises`。
   * `create:false` 只用于恢复历史记录：用户没在派发的场景下不该被我们
   * 悄悄在家目录里建目录。
   */
  async resolveSuperWorkspace(options: { create?: boolean } = {}): Promise<SuperWorkspaceResolution> {
    const roots: string[] = [];
    if (this.services.workspaceRoot) roots.push(this.services.workspaceRoot);
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri.fsPath);
    const configured = this.setting<string>("superAgent.defaultWorkspace", "");
    const create = options.create !== false;
    const resolution = await resolveSuperWorkspaceRoot(
      roots,
      configured,
      this.builtinDefaultWorkspace,
      (candidate) => this.prepareSuperWorkspaceDirectory(candidate, create),
    );
    if (resolution.ok && resolution.source === "default-workspace") {
      this.adoptDefaultWorkspaceRoot(resolution.root);
    } else if (!resolution.ok) {
      // 目录被删掉 / 设置被清空：缓存必须同步失效，否则 superRepoRoot() 会把
      // 一个已不存在的路径交给管理器（worktree 建不出来，报错也指错方向）。
      this.defaultWorkspaceRoot = null;
    }
    return resolution;
  }


  /**
   * 异步「确保该绝对路径是目录」：存在且是目录 → directory；存在但是普通文件
   * → file；不存在且允许创建 → `mkdir -p` 后再 stat 确认；其余（权限 / 磁盘 /
   * 符号链断裂……）→ 把底层错误原样带回，由调用方给出真实 errno / message。
   */
  private async prepareSuperWorkspaceDirectory(
    absolutePath: string,
    create: boolean,
  ): Promise<SuperWorkspaceEnsureOutcome> {
    try {
      const info = await stat(absolutePath);
      return info.isDirectory() ? { kind: "directory" } : { kind: "file" };
    } catch (error) {
      // 只有「不存在」才值得尝试创建；权限 / 其它 errno 原样上报，不猜。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "error", error };
    }
    if (!create) return { kind: "error", error: new Error(`ENOENT: no such directory, '${absolutePath}'`) };
    try {
      await mkdir(absolutePath, { recursive: true });
      const info = await stat(absolutePath);
      return info.isDirectory() ? { kind: "directory" } : { kind: "file" };
    } catch (error) {
      return { kind: "error", error };
    }
  }


  /** 采纳（并缓存）一个已校验的默认工作区根；根变了且没有在跑的子会话时重建管理器。 */
  private adoptDefaultWorkspaceRoot(root: string): void {
    if (this.defaultWorkspaceRoot === root) return;
    const previous = this.defaultWorkspaceRoot;
    this.defaultWorkspaceRoot = root;
    // 管理器在首次派发时把 repoRoot 固定下来。默认工作区是用户可改的设置，
    // 若已有管理器绑在旧根上：没有子会话就重建（安全），有子会话则保持旧根
    // 并如实记日志 —— 中途换根会让在跑的子会话与 allowedRoots 失配。
    if (this.superAgent) {
      const idle = this.isSuperAgentIdle(this.superAgent);
      if (idle && typeof this.superAgent.dispose === "function") {
        const stale = this.superAgent;
        this.superAgent = null;
        void stale.dispose().catch(() => undefined);
      } else {
        this.log.warn(
          `super agent: 默认工作区已改为 ${root}，但仍有子会话绑定旧根 ${previous ?? ""}，本次不切换`,
        );
        return;
      }
    }
    this.log.info(`super agent: 使用默认工作区 ${root}（没有打开的工作区）`);
  }


  /**
   * 默认工作目录**真的**不可用（mkdir / stat 失败，或内置默认目录被占成普通
   * 文件）→ 带真实路径与底层 errno / message 的 toast 文案。
   *
   * 正常流程（无打开工作区）不会再走到这里：设置留空用内置默认，设置值非法
   * 只警告不阻断。只有磁盘 / 权限层面的真失败才拒绝派发。
   */
  private superWorkspaceRejectToast(resolution: SuperWorkspaceResolution): string {
    if (resolution.ok) return "";
    if (resolution.reason === "not-a-directory") {
      return vscode.l10n.t(
        "无法准备超流体工作目录 {0}：该路径是一个文件（请修改设置 iflow.superAgent.defaultWorkspace）",
        resolution.path,
      );
    }
    return vscode.l10n.t(
      "无法准备超流体工作目录 {0}：{1}（请检查该目录的权限，或修改设置 iflow.superAgent.defaultWorkspace）",
      resolution.path,
      errorMessage(resolution.error),
    );
  }


  /** 设置值无效、已非阻断回退到内置默认目录 → 警告 toast 文案。 */
  private superWorkspaceFallbackToast(
    resolution: Extract<SuperWorkspaceResolution, { ok: true }>,
  ): string {
    const fallback = resolution.fallback;
    if (!fallback) return "";
    if (fallback.reason === "not-absolute") {
      return vscode.l10n.t(
        "默认工作区设置无效（{0} 不是绝对路径），已改用默认目录 {1}",
        fallback.configured,
        resolution.root,
      );
    }
    if (fallback.reason === "not-a-directory") {
      return vscode.l10n.t(
        "默认工作区设置无效（{0} 不是目录），已改用默认目录 {1}",
        fallback.configured,
        resolution.root,
      );
    }
    return vscode.l10n.t(
      "默认工作区设置不可用（{0}：{1}），已改用默认目录 {2}",
      fallback.configured,
      errorMessage(fallback.cause),
      resolution.root,
    );
  }


  /**
   * 派发前拿到子会话管理器 —— **唯一**的判空 + 提示入口。
   *
   * 有工作区时立即返回（同步零 I/O）；没有时解析默认工作区，失败按真实原因
   * 弹 toast 并返回 null。调用方拿到 null 时不要再自己弹拒绝文案。
   */
  async ensureSuperAgentForDispatch(): Promise<SuperAgentManager | null> {
    const existing = this.deps.getSuperAgent();
    if (existing) {
      // 首次派发命中已预热的管理器：补发 prefetch 阶段静默跳过的 fallback 警告
      // （那时没有 webview，不弹 toast；用户可见提示统一归这里）。
      this.emitCachedFallbackToast();
      return existing;
    }
    // join 激活期 prefetch 的 in-flight 解析（若有），避免并发重复 stat/mkdir。
    const resolution = await this.resolveSuperWorkspaceShared();
    if (!resolution.ok) {
      this.log.warn(
        `super agent: 无法派发——工作目录不可用（${resolution.reason}: ${resolution.path}${
          resolution.reason === "directory-unavailable" ? ` — ${errorMessage(resolution.error)}` : ""
        }）`,
      );
      this.store.sendToast("warning", this.superWorkspaceRejectToast(resolution));
      return null;
    }
    // 设置值无效（相对路径 / ~ / 普通文件 / 不可用）时如实告知改用哪个目录；
    // 同一份解析只警告一次（emitCachedFallbackToast 内部去重）。
    this.emitCachedFallbackToast();
    const manager = this.deps.getSuperAgent();
    if (!manager) {
      // 解析成功却仍拿不到管理器：工作目录可用但管理器构造失败（异常注入）。
      this.log.warn(`super agent unavailable: manager construction failed for ${resolution.root}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("超流体工作目录 {0} 已就绪，但超流体管理器未能启动，请重试", resolution.root),
      );
    }
    return manager;
  }


  /**
   * 把一个委派说明补全成交给子会话的最终 spec。
   *
   * 附件有两个来源：
   *  - 本轮用户附件（图片 base64 / 文件路径）—— 自动带上，子会话看不到对话，
   *    不带给它等于静默丢用户上下文；
   *  - 指令里显式写的 `attachments` 路径 —— 只放行工作区内的路径与暂存目录，
   *    以及用户本轮亲自附上的文件；模型不能借这条通道把任意磁盘文件复制出去。
   *
   * 超过上限的部分丢弃并计数（调用方据此提示，不静默裁掉）。
   */
  prepareSuperSpec(spec: SuperTaskSpec, onDropped: (count: number) => void): SuperTaskSpec {
    const repoRoot = this.superRepoRoot();
    const attachments: SuperAttachment[] = [];
    const seen = new Set<string>();
    const carried = this.currentTurnAttachments;
    const userPaths = new Set<string>();
    if (carried) {
      let imageIndex = 0;
      for (const image of carried.images) {
        attachments.push({
          // The name becomes the file name in the child's attachment dir and is
          // listed in the child's task prompt — model-facing, so English.
          name: `image${++imageIndex}`,
          data: image.data,
          mimeType: image.mimeType,
        });
      }
      for (const file of carried.files) {
        attachments.push({ name: file.name, path: file.path });
        userPaths.add(normalizePathKey(file.path));
        seen.add(normalizePathKey(file.path));
      }
    }
    let dropped = 0;
    for (const candidate of spec.attachments ?? []) {
      if (candidate.data) {
        attachments.push(candidate);
        continue;
      }
      if (!candidate.path) continue;
      if (!repoRoot) {
        // 没有工作区就没有解析基准：只保留随任务附带的 base64 图片。
        dropped++;
        continue;
      }
      const resolved = this.resolveSuperAttachmentPath(candidate.path, repoRoot, userPaths);
      if (!resolved) {
        dropped++;
        continue;
      }
      const key = normalizePathKey(resolved);
      if (seen.has(key)) continue; // 用户附件已在列表里，模型重复引用不再加一份
      seen.add(key);
      attachments.push({ name: candidate.name, path: resolved });
    }
    if (dropped > 0) onDropped(dropped);
    if (attachments.length > MAX_SUPER_ATTACHMENTS) {
      onDropped(attachments.length - MAX_SUPER_ATTACHMENTS);
      attachments.length = MAX_SUPER_ATTACHMENTS;
    }
    const next: SuperTaskSpec = {
      title: spec.title,
      task: spec.task,
      ...(spec.id ? { id: spec.id } : {}),
      ...(spec.dependsOn && spec.dependsOn.length > 0 ? { dependsOn: [...spec.dependsOn] } : {}),
      ...(spec.batch !== undefined ? { batch: spec.batch } : {}),
      // 任务级覆盖：白名单拷贝必须显式放行，否则「单次任务临时换网关/模型」
      // 会在派发前被静默丢掉（子会话照旧用超流体指针/主链路）。
      ...(spec.profileId ? { profileId: spec.profileId } : {}),
      ...(spec.modelId ? { modelId: spec.modelId } : {}),
    };
    if (attachments.length > 0) next.attachments = attachments;
    return next;
  }


  /**
   * 本轮用户附件 → 子会话可携带的形态。
   *
   * 图片走内联 base64（用户粘贴的截图从来没有磁盘路径），文件留源路径、由
   * `SuperAgentManager` 复制到子会话自己的附件目录 —— 子会话在独立 worktree
   * 里，主工作区的路径它读不到，所以必须复制而不是引用。超过
   * `MAX_SUPER_ATTACHMENTS` 的部分丢弃并回报数量（调用方提示，不静默裁掉）。
   */
  collectSuperAttachments(
    images: { data: string; mimeType: string }[] | undefined,
    files: { name: string; path: string }[] | undefined,
    onDropped: (count: number) => void,
    /** 与 `images` 同下标的逐图说明（多模态方案 C）。 */
    imageCaptions?: string[],
  ): SuperAttachment[] {
    const attachments: SuperAttachment[] = [];
    let imageIndex = 0;
    for (const image of images ?? []) {
      const caption = imageCaptions?.[imageIndex]?.trim();
      imageIndex += 1;
      attachments.push({
        // The name becomes the file name in the child's attachment dir and is
        // listed in the child's task prompt — model-facing, so English.
        name: `image${imageIndex}`,
        data: image.data,
        mimeType: image.mimeType,
        // 用户说明原样转交（不是模型侧措辞，不翻译）。
        ...(caption ? { caption } : {}),
      });
    }
    for (const file of files ?? []) {
      attachments.push({ name: file.name, path: file.path });
    }
    if (attachments.length > MAX_SUPER_ATTACHMENTS) {
      onDropped(attachments.length - MAX_SUPER_ATTACHMENTS);
      attachments.length = MAX_SUPER_ATTACHMENTS;
    }
    return attachments;
  }


  /**
   * 解析指令里的附件路径：相对路径按主仓根解析；只有工作区内、暂存目录内、
   * 或用户本轮亲自附上的文件才放行（其余一律拒绝，不把任意磁盘文件复制给子会话）。
   */
  resolveSuperAttachmentPath(
    raw: string,
    repoRoot: string,
    userPaths: ReadonlySet<string>,
  ): string | null {
    // 模型常把提示词里的 `@path` 原样抄回来 —— 去掉标记再解析。
    const value = raw.trim().replace(/^@/, "");
    if (!value) return null;
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
    if (userPaths.has(normalizePathKey(absolute))) return absolute;
    if (isWithin(repoRoot, absolute)) return absolute;
    // 只有**本会话**的暂存目录（用户拖入/粘贴的文件落在这里）。
    const stageRoot = attachmentSessionDir(this.store.getState().sessionId ?? "adhoc");
    if (isWithin(stageRoot, absolute)) return absolute;
    return null;
  }


  /**
   * The Super Agent orchestrator, created on first delegation.
   *
   * `createClient` mirrors the main session's spawn path (same vendored
   * entry, same node runtime, same credentials) but narrows the boundary to
   * the worktree: `cwd` and `allowedRoots` are the worktree root ONLY, so
   * neither the CLI's own workspace check nor our fs-callback boundary can
   * reach the main working copy. That is the whole point of the isolation.
   */
  getSuperAgent(): SuperAgentManager | null {
    if (this.superAgent) return this.superAgent;
    const repoRoot = this.superRepoRoot();
    if (!repoRoot) {
      this.log.warn("super agent unavailable: no workspace folder open");
      return null;
    }
    this.superAgent = new SuperAgentManager({
      repoRoot,
      createClient: (params) => this.createSuperClient(params),
      // createSuperClient awaits ensureMcpBroker() first, so by the time the
      // manager asks for entries the broker (when any server is configured) is
      // already listening. Read lazily: a child spawned later still sees it.
      childMcpServers: () => this.mcpBroker?.sessionServers() ?? [],
      // 完全信任模式：实时读，开启后子会话直接跑在主仓工作区、不收窄工具/MCP、
      // 任务书允许 push/PR/合并。缺省 false 保持既有行为逐字节不变。
      fullTrust: () => this.setting<boolean>("superAgent.fullTrust", false),
      // 子会话工具白名单：实时读配置，缺省两个数组都是 [] → 纯函数返回
      // undefined → newSession 不带 settings（既有行为逐字节不变）。MCP
      // 白名单也传进去（它的收窄在 spawn 层完成，settings 里不会多出键）。
      // 完全信任时纯函数直接返回 undefined，忽略用户配置的白名单。
      childSessionSettings: () =>
        buildChildSessionSettingsForTrust(
          this.setting<boolean>("superAgent.fullTrust", false),
          vscode.workspace.getConfiguration("iflow").get<string[]>("superAgent.childToolAllowlist", []),
          vscode.workspace.getConfiguration("iflow").get<string[]>("superAgent.childMcpServerAllowlist", []),
        ),
      onSessionsChanged: (sessions) => {
        this.store.setSuperSessions(sessions);
        // 批次2A 项6：终态转换 / 失败分类（lastError）/ 改动去向（integration）
        // 变化时强制立即落盘。子会话状态一变就把记录落盘：扩展随时可能被重启
        // （窗口关闭、宿主崩溃），不落盘就等于「那次运行发生过什么」永远丢了。
        this.persistSuperSessions({ force: this.noteSuperCriticalChange(sessions) });
        // Child progress frames arrive continuously; the heartbeat is what
        // turns "main turn ended, children still working" into a visible
        // waiting state and keeps the report delivery retrying.
        if (sessions.some((session) => !isTerminalSuperStatus(session.status))) {
          this.ensureSuperHeartbeat();
        }
        this.deps.refreshSuperWaitHeartbeat();
      },
      // A child's transcript rides its OWN channel: putting it in the main
      // `blocks` would pollute the main transcript and break the blockPatch
      // anchor. `from` is the incremental start index.
      onTranscript: (sessionId, from, blocks) =>
        this.postToWebview({ type: "superTranscript", sessionId, from, blocks }),
      // 转录快照落在扩展存储（与归档同一目录），终态写一次、恢复时读回。
      superStoreDir: () => this.superStoreDir(),
      onReport: (entries) => this.queueSuperReport(entries),
      // 子会话在等你回答：与主会话的提问卡同一档通知（`question` 属
      // approvals 默认档），只弹系统通知、不发提示音 —— 子会话的汇报回合
      // 已经统一静音，提问是唯一需要当场惊动用户的子会话事件。
      // 远程派发的任务还要把这条提问提醒转发给 QQ 发起者（本地任务不受影响：
      // 服务侧找不到对应的 QQ 任务就会直接忽略）。
      onNeedInput: (session) => {
        this.notifyOs("question", vscode.l10n.t("超流体「{0}」在等你回答", session.title));
        if (session.pending?.kind === "question") {
          // main 渠道 QQ 任务派生的子会话：按 QQ 主任务寻址，答案回灌子会话。
          // 旧 child 渠道仍走 superSessionId 匹配，两者互不干扰。
          const qqMainTaskId = this.qqHost.qqTaskBySuperSession.get(session.id);
          if (qqMainTaskId) {
            this.forwardQqMainTaskChildQuestion(qqMainTaskId, session.id, session.pending.questions);
          } else {
            this.forwardQqTaskQuestion(session.id, session.pending.questions);
          }
        }
      },
      // 自动集成没能把子会话的改动带回主分支 → 自动请智能体合并，
      // 不再把这件事留给用户点看板上的按钮。
      onNeedAgentMerge: (session, reason) => {
        this.scheduleSuperMerge(session.id, reason);
        // 集成诉求也是「改动去向」的一部分，必须立刻落盘（批次2A 项6）。
        void this.persistSuperSessions({ force: true });
      },
      // 合并子会话跑完：宿主用只读 git 检测的结果如实告知（成功 / 失败 /
      // 分支仍保留），并把队列里的下一个合并请求放出去。
      onMergeResult: (info) => {
        // integration 结果落地：强制写，绝不拖到节流窗口（批次2A 项6）。
        void this.persistSuperSessions({ force: true });
        if (info.merged) {
          this.store.sendToast(
            "info",
            vscode.l10n.t(
              "合并超流体已把超流体「{0}」的分支 {1} 合入当前分支",
              info.title,
              info.branch,
            ),
          );
        } else {
          this.store.sendToast(
            "warning",
            vscode.l10n.t(
              "合并超流体没能完成合并，分支仍保留：{0}（{1}）",
              info.branch,
              info.detail,
            ),
          );
        }
        void this.drainSuperMerges();
      },
      currentModel: () => this.store.getState().currentModelId,
      // 子会话该用的模型 —— 超流体独立模型链（任务级 modelId →
      // `iflow.superAgentModel` → 目标 Profile 的 modelName → 主会话当前模型）。
      // 未配置任何超流体指针时链尾就是主 store 的 currentModelId，与既有
      // `currentModel` 取值一致，管理器据此推 `session/set_model`。
      spawnModel: async (spec) => this.resolveSpawnModelForSpec(spec),
      // 方案D：子会话 set_model 成功后同步该模型的有效上下文窗口。
      //
      // 已按超流体口径在 spawn 时算过窗口的 client 直接复用那份（`set_model`
      // 只改模型名，不会让窗口变另一个口径）；其余情况按超流体 Profile 解析，
      // **未配置超流体时**才沿用主会话 resolver（既有行为逐字节不变）。
      setTokensLimit: async (client, sessionId, modelId) => {
        const overrides = parseContextWindowOverrides(
          this.setting<string[]>("contextWindowOverrides", []),
        );
        const stashed = this.superClientTokensLimits.get(client);
        const superProfileName = this.readStringSetting("superAgentProfile");
        const configured = Boolean(superProfileName || this.readStringSetting("superAgentModel"));
        const resolved =
          stashed !== undefined
            ? { limit: stashed, source: undefined }
            : configured
              ? resolveSuperCliTokensLimit({
                  modelId,
                  overrides,
                  profileName: superProfileName || null,
                })
              : resolveCliTokensLimit({ modelId, overrides });
        if (resolved.limit !== undefined) {
          await client.setTokensLimit(sessionId, resolved.limit);
        }
      },
      // 子会话归属当前主会话：归档按它分文件，恢复历史会话时按它取回。
      currentMainSessionId: () => this.currentMainSessionId(),
      // Child sessions spend the same money as the main session: reuse the
      // exact same price resolution (`iflow.costTable` overrides → curated
      // table → null) so the two surfaces can never disagree.
      priceFor: (modelId) =>
        resolveCost(modelId, parseCostTable(this.setting<string[]>("costTable", []))),
      // Read on every integration, so flipping the setting applies to the
      // next finished child without a restart.
      integrationMode: () => {
        const mode = this.setting<string>("superAgent.integration", "merge");
        return mode === "pr" || mode === "manual" ? mode : "merge";
      },
      // 同样实时读：pump 每次都取当前值，设置页改完不需要重启面板。
      maxConcurrentSessions: () =>
        clampMaxConcurrentSuperSessions(
          this.setting<number>("superAgent.maxConcurrent", DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS),
        ),
      // 子会话的总尝试次数上限（含首次）—— `iflow.superAgent.maxAttempts`。
      //
      // **接线到运行时是这个设置存在的全部意义**：声明了却从不读 = 空设置
      // （陷阱 #14），而后果是重试上限在运行时分裂成「手动=无限 / 自动=1」，
      // 用户把上限调到 1 也照样被多跑几轮（每轮都是一整个子会话的 token）。
      // 缺省与 package.json 声明的默认值一致（DEFAULT_SUPER_MAX_ATTEMPTS）。
      maxAttempts: () =>
        clampSuperMaxAttempts(
          vscode.workspace
            .getConfiguration("iflow")
            .get<number>("superAgent.maxAttempts", DEFAULT_SUPER_MAX_ATTEMPTS),
        ),
      // 上游失败时的下游策略：只有 `continue` 放行，脏值一律按 `block`
      // （与 package.json 的 enum 一致）。实时读，改完对下一次失败判定生效。
      dependencyPolicy: () =>
        this.setting<string>("superAgent.dependencyPolicy", "block") === "continue" ? "continue" : "block",
      // 默认关闭 = 子会话正常完成后回收工作目录（分支一律保留）。失败/中断
      // 从不回收，重试要复用现场。每次实时读，改完对下一个结束的子会话生效。
      keepWorktree: () => this.setting<boolean>("superAgent.keepWorktree", false),
      // 效率开关：turbo 时子会话任务书前置速推规则，与主会话同档。实时读，
      // 改完对下一次派发生效；未知值按 steady（不注入）。
      efficiencyMode: () => {
        const mode = this.setting<string>("efficiencyMode", "steady");
        return mode === "turbo" ? "turbo" : "steady";
      },
      // 磁盘上最多保留多少个已结束子会话的工作目录（0 = 不限制）。
      maxWorktrees: () =>
        clampMaxSuperWorktrees(
          this.setting<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
        ),
      log: this.log,
    });
    return this.superAgent;
  }


  /**
   * Start (once) the host MCP broker for the configured servers.
   *
   * Merging mirrors the CLI: `{...user, ...workspace}` — the project entry of a
   * name wins. Disabled / unusable entries are skipped and logged; because the
   * child's `--allowed-mcp-server-names` list comes from the broker's names, a
   * skipped server is also absent from the child instead of being silently
   * spawned per child.
   *
   * Returns null when there is nothing to broker, or when startup itself
   * failed — callers then scope the child to the sentinel (no MCP). A broker
   * whose UPSTREAM fails is not a startup failure: the failure surfaces on the
   * child's first request and in the panel log, and never blocks spawning.
   */
  async ensureMcpBroker(): Promise<McpBroker | null> {
    if (this.mcpBroker) return this.mcpBroker;
    if (this.mcpBrokerStarting) return this.mcpBrokerStarting;
    this.mcpBrokerStarting = (async (): Promise<McpBroker | null> => {
      const scopes = this.readMcpScopes();
      const servers: Record<string, unknown> = { ...scopes.global, ...(scopes.project ?? {}) };
      const { servers: usable, skipped } = normalizeBrokerServers(servers);
      for (const entry of skipped) {
        this.log.warn(`MCP broker: 跳过 "${entry.name}"（${entry.reason}）`);
      }
      if (usable.length === 0) return null;
      try {
        const broker = await McpBroker.start({
          servers,
          cwd: this.mcpProjectCwd() ?? undefined,
          log: (level, message) => this.log[level](`[mcp-broker] ${message}`),
          // Broker connects/fails in the background; push a fresh status to
          // the card when it settles so the user need not open the settings
          // modal and press 刷新 to see the real state.
          onStatusChange: () => this.refreshMcpStatusFromBroker(),
        });
        this.mcpBroker = broker;
        // Eager handshake so failures land in the log early instead of only on
        // the first tool call; never awaited — a slow `npx` must not delay the
        // child spawn (the child's own initialize waits on the same promise).
        void broker.prewarm();
        this.log.info(
          `MCP broker listening on ${broker.baseUrl} for: ${broker.names().join(", ")}`,
        );
        return broker;
      } catch (error) {
        this.log.error(`MCP broker failed to start: ${errorMessage(error)}`);
        this.store.sendToast(
          "error",
          vscode.l10n.t("MCP 共享代理启动失败，超流体将无 MCP 工具：{0}", errorMessage(error)),
        );
        return null;
      }
    })().finally(() => {
      this.mcpBrokerStarting = null;
    });
    return this.mcpBrokerStarting;
  }

  /**
   * 收集「超流体端点解析链」的输入 —— 与面板 `superEndpointInput`
   * （`src/panel/panel.ts`）**同口径**：这里是子会话的真实派发路径，必须和
   * 设置页/模型列表那条路径读到同一份事实，否则两边解析出的端点会分叉。
   *
   * 只负责取事实，回退顺序仍由 `shared/super-profile.ts` 的唯一实现决定：
   *   ① task `profileId` → ② `iflow.superAgentProfile` → ③
   *   `iflow.workspaceActiveProfile`（本工作区握手指针）→ ④ 握手调用点的
   *   下一级（`resolveWorkspaceHandshakeCreds() ?? loadCredentials()`）→
   *   ⑤ 内核 `currentApiProfile` → 内核顶层默认。
   */
  private async superEndpointInput(taskProfileId: string | null): Promise<SuperEndpointInput> {
    const kernelProfiles = readKernelApiProfiles();
    const legacyProfiles = await loadProfiles(this.context.secrets).catch(
      () => ({}) as Record<string, { baseUrl: string; apiKey: string; modelName: string }>,
    );
    const profiles: Record<string, SuperApiProfile> = {};
    for (const [name, creds] of Object.entries(legacyProfiles)) {
      profiles[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    }
    // 同名 Profile 冲突时内核 `apiProfiles` 优先 —— 与握手路径
    // `kernelProfileCredentials(name) ?? profiles[name]` 完全同序。
    for (const [name, creds] of Object.entries(kernelProfiles)) {
      profiles[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    }
    const cli = readCliSettings();
    const kernelActive =
      cli?.selectedAuthType === "openai-compatible" ? cli.currentApiProfile?.trim() : undefined;
    // 只认**完整**的内核 Profile（`readKernelApiProfiles` 已过滤缺字段的条目）：
    // 若只用 `cli.apiProfiles?.[name]` 判存在，一个「缺少 apiKey/modelName」的
    // 内核条目也会通过门控，随后合并表里只剩 SecretStorage 的同名历史 Profile
    // —— 它就会冒充内核指针、解析出 `readActiveEndpoint()` 永远不会用的凭据。
    // 内核条目残缺时交给 ⑤b：`readActiveEndpoint()` 按内核文件自身语义逐字段
    // 回退（它自己会校验 baseUrl/apiKey），全程不碰 SecretStorage。
    const kernelProfileName =
      kernelActive && Object.hasOwn(kernelProfiles, kernelActive) ? kernelActive : null;
    return {
      taskProfileId,
      superProfileName: this.readStringSetting("superAgentProfile") || null,
      mainProfileName:
        this.context.workspaceState.get<string>(SUPER_WORKSPACE_PROFILE_KEY)?.trim() || null,
      kernelProfileName,
      profiles,
      // 第 4 级 = 子会话握手调用点的下一级（`resolveWorkspaceHandshakeCreds()
      // ?? loadCredentials()`）：它**先于**内核 currentApiProfile 命中，与今天
      // 子会话的凭据解析同序。
      activeCredentials:
        (await this.resolveWorkspaceHandshakeCreds().catch(() => null)) ??
        (await loadCredentials(this.context.secrets).catch(() => null)),
      // ⑤b 内核顶层默认：`readActiveEndpoint()` 已把「具名 Profile → 顶层
      // baseUrl/apiKey」逐字段合并完，直接作为最后一档喂进去。
      kernelDefaultEndpoint: readActiveEndpoint(),
    };
  }

  /**
   * 解析「这个子会话该用的端点 + 模型」—— 单真值层 `shared/super-profile.ts`。
   *
   * `configured` 表示用户配置了任何超流体专属**指针**（任务级 Profile 覆盖 /
   * `iflow.superAgentProfile` / `iflow.superAgentModel`）。调用方据此决定：
   * 未配置时**完全沿用今天的行为**（同一个握手凭据、同一个主会话模型、
   * 同一套主会话窗口解析），保证老用户零配置零变化。
   *
   * `modelConfigured` 表示子会话的**模型**可能不是主会话当前模型（`configured`
   * 成立，或任务级 `modelId` 覆盖）。窗口解析必须用它而不是 `configured`：
   * 任务级 `modelId` 只换模型、不换凭据（端点链仍与今天同序，不启用内核 ⑤），
   * 但窗口必须按子会话自己的模型解析 —— 否则会出现「模型是替代的、窗口是
   * 主会话的」这种自相矛盾。
   */
  private async resolveSuperSpawnPlan(
    taskProfileId: string | null,
    taskModelId: string | null,
  ): Promise<SuperSpawnPlan> {
    const input = await this.superEndpointInput(taskProfileId);
    const superModelId = this.readStringSetting("superAgentModel");
    const configured = Boolean(
      (typeof taskProfileId === "string" && taskProfileId.trim()) ||
        input.superProfileName ||
        superModelId,
    );
    const modelConfigured =
      configured || (typeof taskModelId === "string" && taskModelId.trim().length > 0);
    // 模型链第③级「目标 Profile 自带的 modelName」只在用户**点名了 Profile**
    // （任务级覆盖或超流体 Profile）时参与；未点名时显式传 `null`，让模型链
    // 落到主 store 的 `currentModelId` —— 这正是今天子会话的取值，否则完全
    // 未配置的用户会在主会话换过模型后被子会话静默换回 Profile 默认模型。
    const namedPointer = Boolean(
      (typeof taskProfileId === "string" && taskProfileId.trim()) || input.superProfileName,
    );
    // 零配置硬约束：今天子会话的凭据链只有 `resolveWorkspaceHandshakeCreds()
    // ?? loadCredentials()`（第 4 级已装这两档），**从不**回退内核
    // currentApiProfile / 顶层默认。未配置超流体时把⑤两小步置空，端点因此与
    // 今天逐字段相同；配置了超流体才启用完整的①→⑤链。
    const endpointInput: SuperEndpointInput = configured
      ? input
      : { ...input, kernelProfileName: null, kernelDefaultEndpoint: null };
    const resolutionInput = {
      ...endpointInput,
      taskModelId: taskModelId ?? null,
      superModelId: superModelId || null,
      profileModelName: namedPointer ? undefined : null,
      mainModelId: this.store.getState().currentModelId,
    };
    // 第一遍只解「端点 + 链上的目标模型」（纯函数，无网络）：有了目标模型和
    // 实际要用的端点，才知道该向哪个 `/models` 取证、要不要取证。
    const baseSpec = resolveSuperApiSpec(resolutionInput);
    // 派发时的 live 下架校验（方案 §7.8 的取舍已反转：派发也校验）。
    //
    // 三点纪律：
    //   • **只在 `modelConfigured` 时查**：零配置子会话的模型就是主会话当前
    //     模型，给它额外一跳 HTTP 既拖慢冷启动，又可能让「零配置零行为变化」
    //     失守（§4.1）—— 主会话自己正在用的模型，下架时主会话会先报错。
    //   • **查询失败 / 超时 / 空列表 = 无证据**：`querySpawnLiveModelIds` 返回
    //     `undefined`，这里就不重解，`resolveSuperModel` 绝不会降级。
    //   • 取证成功才用**同一份** `resolveSuperModel` 重解（判定只有一份实现）；
    //     降级则显式提示，绝不静默换模型、绝不改写 `superAgentModel`。
    let spec = baseSpec;
    if (modelConfigured && baseSpec.endpoint && baseSpec.model.modelId) {
      const liveModelIds = await this.querySpawnLiveModelIds(baseSpec.endpoint);
      if (liveModelIds) spec = resolveSuperApiSpec({ ...resolutionInput, liveModelIds });
    }
    if (spec.model.degraded) this.noticeSpawnModelDegraded(spec.model);
    return { spec, configured, modelConfigured };
  }

  /** spawn 计划的暂存键：任务级 Profile / 模型覆盖的组合（同一次派发两端一致）。 */
  private spawnPlanKey(profileId: string | null, modelId: string | null): string {
    return `${profileId ?? ""}\u0000${modelId ?? ""}`;
  }

  /**
   * 暂存 `createSuperClient` 解析出的计划，供紧随其后的 `spawnModel` 复用。
   *
   * 顺带清理过期条目：只有「client 起来但模型回调没被调用」才会留下残条
   * （例如派发在 set_model 之前被中断），TTL 到期后下一次写入即删除。
   */
  private rememberSpawnPlan(profileId: string | null, modelId: string | null, plan: SuperSpawnPlan): void {
    const now = Date.now();
    for (const [key, entry] of this.superSpawnPlans) {
      if (now - entry.at >= SUPER_SPAWN_PLAN_REUSE_MS) this.superSpawnPlans.delete(key);
    }
    this.superSpawnPlans.set(this.spawnPlanKey(profileId, modelId), { plan, at: now });
  }

  /** 消费暂存的计划（消费即删）：未命中或已过期返回 undefined，由调用方重解。 */
  private takeSpawnPlan(profileId: string | null, modelId: string | null): SuperSpawnPlan | undefined {
    const key = this.spawnPlanKey(profileId, modelId);
    const entry = this.superSpawnPlans.get(key);
    if (!entry) return undefined;
    this.superSpawnPlans.delete(key);
    return Date.now() - entry.at < SUPER_SPAWN_PLAN_REUSE_MS ? entry.plan : undefined;
  }

  /**
   * `spawnModel` 回调的实现：**优先复用** `createSuperClient` 刚解析出的同一
   * 份计划（同一次派发只解析一次端点/模型/live 校验）；只有在没有暂存条目
   * （例如宿主被单测直接驱动、或条目已被另一路消费）时才重新解析。
   */
  private async resolveSpawnModelForSpec(spec: SuperTaskSpec): Promise<string | null> {
    const profileId = spec.profileId ?? null;
    const modelId = spec.modelId ?? null;
    const plan = this.takeSpawnPlan(profileId, modelId) ?? (await this.resolveSuperSpawnPlan(profileId, modelId));
    return plan.spec.model.modelId;
  }

  /**
   * 派发前的一次 live `/models` 查询（`GET {baseUrl}/models`）。
   *
   * 数据源是**实时查询**（原生 `node:http(s)` 直连，绝不用被代理 patch 过的
   * 全局 `fetch`；**绝不**回退 CLI 内建的 `_meta.models.availableModels`）：
   *   • 面板注入了 `querySuperModelIds` 时走那条通道 —— 与设置页**同一份**
   *     30s TTL 缓存（key = 归一化 models URL + apiKey 比对），命中即零请求；
   *     同批并行派发因此最多产生一次真实请求。
   *   • 未接线（单测里直接 new 的 host）时回退到无缓存直连（`queryModelIds`）。
   *
   * 纪律（两条通道一致）：
   *   • **空列表 / 超时 / 连接失败 / 非 2xx / 解析失败一律按「无证据」处理** →
   *     返回 `undefined`：不降级、不抛错、派发照常进行（AGENTS.md 陷阱 #25）。
   *   • **短超时**：这是派发路径上的额外一跳，宁可放弃证据也不能卡住冷启动；
   *     共享通道（设置页那条默认 10s）同样受 4s 上限约束，被放弃的请求仍在
   *     后台填充面板缓存，下一次派发直接命中。
   */
  private async querySpawnLiveModelIds(endpoint: {
    baseUrl: string;
    apiKey: string;
    modelName?: string | null;
  }): Promise<string[] | undefined> {
    const work: Promise<string[] | undefined> = this.deps.querySuperModelIds
      ? this.deps
          .querySuperModelIds({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey })
          .then((result) => {
            if (result.error) {
              this.log.info(
                `超流体派发前查询模型列表失败（按无证据处理，照常派发）：${result.error}`,
              );
              return undefined;
            }
            return result.ids;
          })
      : queryModelIds(
          {
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey,
            modelName: endpoint.modelName ?? null,
          },
          SUPER_SPAWN_LIVE_MODELS_TIMEOUT_MS,
        );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race<string[] | undefined>([
        // 被放弃（超时）的请求之后仍可能 reject：这里先挂 catch，避免成为
        // 未处理的 rejection。
        work.catch((error: unknown) => {
          this.log.info(
            `超流体派发前查询模型列表失败（按无证据处理，照常派发）：${errorMessage(error)}`,
          );
          return undefined;
        }),
        new Promise<string[] | undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SUPER_SPAWN_LIVE_MODELS_TIMEOUT_MS);
        }),
      ]);
      // 200 但没有任何模型 = 端点异常，同样不构成「模型下架」的证据。
      return raced && raced.length > 0 ? raced : undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 派发时的模型降级必须**显式**：用真实原因（被下架的模型 id + 实际回退
   * 目标）提示用户，并**绝不**因此改写用户的 `iflow.superAgentModel`。
   *
   * 同一批派发（并行的多个子会话）会重复拿到同一个结论，因此同一组
   * 「下架 → 回退」只弹一次 toast；日志每次照记，便于排查。
   */
  private noticeSpawnModelDegraded(model: SuperApiSpec["model"]): void {
    const delisted = model.delistedModelId ?? "";
    const fallback = model.modelId ?? "";
    const message = vscode.l10n.t(
      "子会话模型 {0} 已不在可用模型中，本次派发改用 {1}（不会修改你的超流体模型设置）",
      delisted || "（未知）",
      fallback || "（未知）",
    );
    this.log.warn(message);
    const key = `${delisted}\u0000${fallback}`;
    if (this.superSpawnDegradeNotices.has(key)) return;
    this.superSpawnDegradeNotices.add(key);
    this.store.sendToast("warning", message);
  }

  /** Spawn a CLI client for a child session (own process, own worktree). */

  async createSuperClient(params: {
    cwd: string;
    allowedRoots: string[];
    includeDirectories: string[];
    label: string;
    callbacks: AcpClientCallbacks;
    /** 任务级 API Profile 覆盖（`SuperTaskSpec.profileId`）。 */
    profileId?: string;
    /** 任务级模型覆盖（`SuperTaskSpec.modelId`）。 */
    modelId?: string;
  }): Promise<AcpClient> {
    const entry = this.resolveEntry();
    const nodePathConfigured = this.setting<string>("nodePath", "");
    const locatedNode = nodePathConfigured ? null : await locateNodeExecutable();
    const node = nodePathConfigured || locatedNode || process.execPath;
    const runtime = await concealNodeExecutable(node, this.context.globalStorageUri.fsPath);
    // The child's cwd is its worktree (or, for a merge child, the main
    // workspace). The extra roots come from the manager, which knows the
    // isolation kind: worktree children get only their attachment dir, while
    // a merge child gets the main repo root so the CLI's own workspace check
    // and our fs boundary agree on what it may read.
    const includeDirectories = params.includeDirectories;
    // 子会话必须能用 MCP，但**不能**每个子会话各起一套服务器：宿主 broker
    // 先认领每个配置的 server（每 server 只一份进程），子会话经 loopback
    // streamable-HTTP 连它。这里把子会话的 CLI 进程作用域收窄到 broker 的
    // server 名，用户配置里的 stdio server 因此在子会话进程里根本不会被拉起。
    // broker 为空（没有配置 / 启动失败）时传空数组 → 哨兵 → 子会话无 MCP，
    // 与启动失败时的 toast 一起如实暴露，绝不伪造共享。
    const broker = await this.ensureMcpBroker();
    const brokerNames = broker?.names() ?? [];
    const fullTrust = this.setting<boolean>("superAgent.fullTrust", false);
    const mcpAllowlist = vscode.workspace
      .getConfiguration("iflow")
      .get<string[]>("superAgent.childMcpServerAllowlist", []);
    const { args } = buildAcpCommand(entry, includeDirectories, {
      // 完全信任：忽略白名单，用 broker 全量 server；broker 为空时不传该参数
      // （绝不退化成「无 MCP」哨兵）。非完全信任时逐字沿用既有表达式，默认
      // 行为不变。
      mcpServerNames: effectiveMcpServerNamesForTrust(fullTrust, mcpAllowlist, brokerNames),
    });
    // Same effective context window as the main session (see panel.ts
    // spawnEnv), resolved through the very same five-tier authority chain
    // (user override → active profile → settings top-level → curated table →
    // nothing). Without this the child falls back to the CLI's own tiny
    // built-in default and compresses its baseline immediately on start.
    //
    // The panel computes the patch (ONE site for both spawn paths) so the
    // cold-start lookup-key fallbacks — store's model → pending switch →
    // workspace model → kernel profile's modelName — apply here too: the
    // child's CLI is spawned long before any `currentModelId` exists.
    //
    // A host that does not wire the callback (a standalone SuperAgentHost,
    // e.g. in tests) must not SILENTLY lose the limit — that is exactly the
    // "window falls back to the CLI's 65k" symptom. The degraded branch uses
    // the SAME resolver, only with fewer key facts (the store's model).
    // 超流体独立凭据 / 模型的单真值解析。`configured === false` = 用户没有
    // 配置任何超流体专属指针，下面所有分支都刻意与今天逐字节一致。
    const spawnPlan = await this.resolveSuperSpawnPlan(
      params.profileId ?? null,
      params.modelId ?? null,
    );
    const contextWindowOverrides = parseContextWindowOverrides(
      this.setting<string[]>("contextWindowOverrides", []),
    );
    const childTokensLimitEnv = spawnPlan.modelConfigured
      ? superTokensLimitEnv({
          // tier 1/4 按**子会话自己的模型**查表；tier 2 按超流体端点命中的
          // 具名 Profile 取 tokensLimit —— 绝不读主会话 `currentApiProfile`。
          modelId: spawnPlan.spec.model.modelId,
          overrides: contextWindowOverrides,
          profileName: spawnPlan.spec.endpoint?.profileName ?? null,
        })
      : (this.deps.tokensLimitEnv?.() ??
        tokensLimitEnvFromSettings({
          modelId: this.store.getState().currentModelId,
          overrides: contextWindowOverrides,
        }));
    // spawn 时算出的窗口在 `set_model` 之后按同一口径推进子 CLI 缓存的
    // tokensLimit（见 setTokensLimit 回调）；不记录会让两条路径各算各的。
    const spawnTokensLimit = (() => {
      const raw = childTokensLimitEnv.IFLOW_TOKENS_LIMIT;
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    })();
    const systemPromptFile = await this.materializeSystemPrompt("child");
    const spawnEnv: NodeJS.ProcessEnv = {
      IFLOW_HARNESS: "1",
      IFLOW_HARNESS_CONTEXT_FILE: this.contextReportFile(),
      // 子会话专属标记：CLI 侧 super-child-memory MOD 仅在 --experimental-acp
      // + 本键=1 时把层级记忆里的项目 AGENTS.md/IFLOW.md 全文换成随包下发的
      // 精简纪律切片（~/.iflow 全局记忆与其它段保留）。主会话 spawnEnv 不带
      // 此键，行为与上游逐字节一致。IFLOW_SUPER_MEMORY=0|false 可在 CLI 侧
      // 显式退回上游；loader 缺失/抛错亦静默回退。
      IFLOW_SUPER_CHILD: "1",
      // 子会话绝不能拿到主会话的内置 `super-agent` 工具开关：那个工具负责
      // 派发子会话，给了子会话就等于允许无限套娃。AcpClient 把 process.env
      // 铺在 options.env 之下，这里用 undefined 显式抹掉该键（Node 的 spawn
      // 会跳过值为 undefined 的环境变量），即便用户 shell 里设了也不继承。
      IFLOW_SUPER_TOOL: undefined,
      // 凭据只走 ACP `authenticate`（见下方 client.authenticate）。vendor CLI
      // 另有一条 **env 凭据通道**：`IFLOW_SELECTED_AUTH_TYPE` + `IFLOW_API_KEY`
      // / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME`（实测存在，且能越过
      // `session/new` 的 authRequired 门禁）。子会话绝不能继承用户 shell 里
      // 残留的这组变量 —— 否则端点/密钥会被环境悄悄改写，子会话派生的任何
      // shell 也能读到。用 undefined 显式抹掉（Node 的 spawn 跳过值为
      // undefined 的环境变量），`IFLOW_MODEL` 是同一通道的旧别名，一并抹除。
      IFLOW_API_KEY: undefined,
      IFLOW_BASE_URL: undefined,
      IFLOW_MODEL_NAME: undefined,
      IFLOW_MODEL: undefined,
      IFLOW_SELECTED_AUTH_TYPE: undefined,
      // Same effective context window as the main session: without this the
      // child falls back to the CLI's own 128000/65000 default and compresses
      // its baseline immediately on start.
      ...childTokensLimitEnv,
    };
    if (systemPromptFile) spawnEnv.IFLOW_SYSTEM_MD = systemPromptFile;
    const client = new AcpClient(
      {
        command: runtime,
        args,
        cwd: params.cwd,
        env: spawnEnv,
        requestTimeoutMs: 120_000,
        allowedRoots: params.allowedRoots,
      },
      params.callbacks,
    );
    // 只有走了超流体口径（模型 / 凭据被覆盖）的 client 才留 spawn 快照：
    // 零配置路径的 set_model 必须与今天相同（届时按当时的设置重算），快照
    // 会让它回放 spawn 时的旧数。
    if (spawnPlan.modelConfigured && spawnTokensLimit !== undefined) {
      this.superClientTokensLimits.set(client, spawnTokensLimit);
    }
    // 防御纵深：即使 vendor 的 `IFLOW_OAUTH_STRIP=0` 回滚，已过期的 OAuth
    // 缓存也不会让**每个**子会话在 authenticate 上白卡 60s。该函数只做可逆
    // 改名（`.bak`），token 未过期 / 文件缺失 / 内容不可解析时原样不动。
    const archivedOAuth = retireStaleOAuthCreds();
    if (archivedOAuth) {
      this.log.info(`super agent: 归档过期的 OAuth 凭据缓存 → ${archivedOAuth}`);
    }
    await client.connect();
    // 端点 = 超流体独立解析结果（未配置超流体时与主会话握手结果同源）。
    const endpoint = spawnPlan.spec.endpoint;
    if (endpoint) {
      await client.authenticate({
        methodId: "openai-compatible",
        methodInfo: {
          apiKey: endpoint.apiKey,
          baseUrl: endpoint.baseUrl,
          modelName: endpoint.modelName ?? "",
        },
      });
    }
    // 同一次派发的后续 `spawnModel` 复用这份计划（消费即删）：端点/模型/live
    // 校验只解析一遍；键含 profileId/modelId，不同 Profile 的派发互不命中。
    this.rememberSpawnPlan(params.profileId ?? null, params.modelId ?? null, spawnPlan);
    return client;
  }


  /**
   * 换会话 / 恢复会话 / 热重认证时重置委派与动作扫描状态。
   *
   * 滚动缓冲里是上一个会话的助手文本（可能还有没收口的围栏），去重账本里是
   * 上一个会话派发过的载荷 —— 两者都跟新会话无关：不清掉会让新会话的扫描
   * 基线落在别人的文本上，还会把本该重新派发的指令误判成重复。
   *
   * 动作通道同理：`superActionScanText/Offset` 是上一个会话的助手文本与消费
   * 偏移；`superActionReceiptLast` 是**上一个会话**最后一条回执文本。
   * 后者不清会让另一个主会话里**一模一样**的动作回执被当成重复丢弃 ——
   * 那个会话根本没收到过这条回执，主会话因此以为动作没生效、反复重发。
   */
  resetSuperDirectiveScans(): void {
    this.superScan.reset();
    this.superDispatchedDirectives.clear();
    this.superToolCallWarned.clear();
    this.superToolCallActionsDone.clear();
    this.superToolCallOutcomes.clear();
    this.superToolCallCorrections.clear();
    this.superActionScanText = "";
    this.superActionScanOffset = 0;
    this.superActionPending = false;
    this.superActionPendingBody = "";
    this.superActionZeroWarned = false;
    this.superActionReceiptLast = "";
    // 方案 B：换会话时同批 cancel 回执已不会再与本会话关联，暂存汇报必须
    // 回退为普通汇报轮（按归属主会话过滤投递），不能留在 in-flight 里烂掉。
    for (const held of this.pendingAgentCancelMerges) this.pendingSuperReportPrompts.push(held.item);
    this.pendingAgentCancelMerges.length = 0;
    this.agentCancelWithReceiptIds.clear();
  }


  /**
   * Scan the MAIN session's assistant text for delegation directives.
   *
   * The directive is a `super-agent` fenced block carrying JSON:
   * `{ "tasks": [{ "title", "task" }] }`. Scanning happens per chunk, so a
   * delegation takes effect mid-turn — the main session can open child
   * sessions at any time, not only at turn end.
   *
   * Only the main agent's OWN text is scanned: nested SubAgent events (the
   * CLI's own `task` tool) carry an `agentId` and are ignored — v1 supports
   * exactly one level of children.
   */
  scanSuperDirectives(content: unknown): void {
    const text = this.chunkText(content);
    if (!text) return;
    // 扫描器自己持有滚动缓冲与消费偏移：扫完就把死区丢掉，缓冲因此不随
    // 会话长度增长（宿主自己攒字符串的话是无界的）。只有正文通道会调用。
    const scan = this.superScan.push(text);
    if (scan.invalidBlocks.length > 0) {
      // 只报「无法解析」等于让用户和模型都没法自查；带上失败原因与正文长度，
      // 才能一眼看出是 JSON 写坏了还是任务书太长被截断。原因里含字段级诊断
      // （如 tasks[0].title 必填），这里同步记日志定位是哪个任务缺标题。
      const first = scan.invalidBlocks[0]!;
      this.log.warn(
        `super agent: invalid delegation directive (${first.reason}, ${first.body.length} chars) — nothing dispatched`,
      );
      this.store.sendToast(
        "warning",
        vscode.l10n.t("超流体派发指令无法解析（{0}，内容共 {1} 字符），已忽略", first.reason, first.body.length),
      );
    }
    if (scan.blocks.length === 0) return;
    this.dispatchSuperTasks(scan.blocks, scan.issues);
  }


  /**
   * 把解析出的委派任务交给子会话管理器。
   *
   * 正文围栏（{@link scanSuperDirectives}）与结构化工具调用
   * （{@link handleSuperToolCall}）共用这一段：去重键、附件丢弃计数、
   * toast 文案都不允许两条通道各写一份 —— 同一份载荷从两条路径同时到达时，
   * `superDirectiveDedupeKey` 必须能看见同一个账本，否则会双开子会话。
   *
   * 有管理器时完全同步（既有行为逐字节不变）；只有「没有打开工作区、但设置
   * 了默认工作区」这一条新路径需要异步 fs.stat，因此同步返回 `deferred`，
   * 由后台链在解析成功后真正派发并回填结果。
   */
  dispatchSuperTasks(
    blocks: readonly SuperTaskSpec[][],
    issues: readonly string[] = [],
    toolCallId?: string,
  ): SuperDispatchResult {
    const manager = this.deps.getSuperAgent();
    if (manager) {
      // prefetch 静默解析出的 fallback 原因在这里补发；有工作区用户不会命中
      // 这条缓存（guard 在 emitCachedFallbackToast 内），行为逐字节不变。
      this.emitCachedFallbackToast();
      return this.dispatchSuperTasksWith(manager, blocks, issues);
    }
    const resolvedRoot = this.superRepoRoot();
    if (resolvedRoot !== null) {
      // 工作目录已经可用却没有管理器：这是管理器构造失败，不是「没有工作区」。
      // 不要再用那句与事实相反的固定文案。
      this.log.error(`super agent: manager unavailable for resolved root ${resolvedRoot}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("超流体工作目录 {0} 已就绪，但超流体管理器未能启动，请重试", resolvedRoot),
      );
      return { dispatched: 0, duplicates: 0, managerAvailable: false };
    }
    // 没有打开任何工作区：可能是「配置了默认工作区」的场景。存在性校验必须
    // 异步，因此这里先如实返回「本次未派发」，由后台链决定派发还是给出真实
    // 拒绝原因（未配置 / 非绝对路径 / 不存在 / 不是目录）。
    // 先同步登记 pending：同一工具调用的后续帧据此跳过（不重复排队），
    // completed 帧的审核也不会把「还在校验」误判成「载荷整轮没送达」。
    if (toolCallId) this.recordSuperToolCallOutcome(toolCallId, "pending");
    void this.dispatchSuperTasksViaDefaultWorkspace(blocks, issues, toolCallId);
    return { dispatched: 0, duplicates: 0, managerAvailable: false, deferred: true };
  }


  /** 同步入口判定为 deferred 时，后台链串行解析默认工作区并派发。 */
  private dispatchSuperTasksViaDefaultWorkspace(
    blocks: readonly SuperTaskSpec[][],
    issues: readonly string[],
    toolCallId?: string,
  ): void {
    const run = this.defaultWorkspaceDispatchChain
      .then(async () => {
        const manager = await this.ensureSuperAgentForDispatch();
        if (!manager) {
          if (toolCallId) this.recordSuperToolCallOutcome(toolCallId, "failed");
          return;
        }
        const result = this.dispatchSuperTasksWith(manager, blocks, issues);
        if (toolCallId) this.recordSuperToolCallOutcome(toolCallId, dispatchOutcome(result));
      })
      .catch((error: unknown) => {
        // 后台链绝不能冒成 unhandled rejection：onSessionUpdate 的调用方是同步
        // 通知分发，一帧异常会把整条流打断。
        this.log.error(`super agent: 默认工作区派发失败：${errorMessage(error)}`);
        if (toolCallId) this.recordSuperToolCallOutcome(toolCallId, "failed");
      });
    this.defaultWorkspaceDispatchChain = run;
  }


  /** 拿到管理器之后的派发体（同步；两条派发通道共用）。 */
  private dispatchSuperTasksWith(
    manager: SuperAgentManager,
    blocks: readonly SuperTaskSpec[][],
    issues: readonly string[] = [],
  ): SuperDispatchResult {
    if (issues.length > 0) {
      // 宿主侧可诊断日志：字段级原因里带 tasks[i]，这里整条记下来（尤其 title 必填
      // 的拒绝），便于从日志直接定位是哪个任务缺标题，而不是只有一句笼统 toast。
      this.log.warn(
        `super agent: rejected ${issues.length} malformed task entry(ies): ${issues.join("; ")}`,
      );
      // 混合载荷：合法任务照常派发，但被丢掉的畸形条目必须可见 —— 静默丢一半
      // 正是「用户只看到一堵 JSON 墙」的来源。只报首条原因，避免 toast 过长。
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "已忽略 {0} 个格式错误的任务条目（{1}）",
          issues.length,
          issues[0] ?? "",
        ),
      );
      // 被丢掉的条目不会自己回来：把原因送回主会话，让模型重发完整条目。
      // 与「整体不可解析」共用同一限次账本（同一轮最多 2 次）。
      this.queueSuperToolCallCorrection(issues[0] ?? "");
    }
    let dispatched = 0;
    let attempted = 0;
    let duplicates = 0;
    let blockErrors = 0;
    let droppedAttachments = 0;
    for (const tasks of blocks) {
      // 波次计划（任务 A 纯函数）：依赖模式 = 最长依赖路径，批次模式 = batch 排名；
      // 混合模式 / 成环 / 悬空依赖等块级错误 → 整块拒绝，绝不部分派发。
      const plan = planSuperWaves(tasks);
      if (plan.issues.some((issue) => issue.blockLevel)) {
        const reasons = plan.issues.filter((i) => i.blockLevel).map((i) => i.message);
        this.log.warn(`super agent: 拒绝含依赖/批次错误的委派块：${reasons.join("; ")}`);
        this.store.sendToast(
          "warning",
          vscode.l10n.t("委派指令的依赖/批次配置有误，已整块忽略：{0}", reasons[0] ?? ""),
        );
        this.queueSuperToolCallCorrection(reasons[0] ?? "");
        blockErrors++;
        continue;
      }
      // 一次委派块 = 一个运行组；runId 让看板按组聚合、pump 按组解析依赖。
      const runId = `run-${Date.now().toString(36)}-${(this.superRunSeq++).toString(36)}`;
      for (const task of tasks) {
        // 同一份载荷在正文里被重复写出时只派发第一次。
        const dedupeKey = SuperAgentHost.superDirectiveFingerprint(superDirectiveDedupeKey([task]));
        if (this.superDispatchedDirectives.has(dedupeKey)) {
          duplicates++;
          this.log.info(`super agent: skipped-duplicate directive 「${task.title}」`);
          continue;
        }
        const spec = this.prepareSuperSpec(task, (count) => {
          droppedAttachments += count;
        });
        const wave = plan.taskWave[superTaskKey(task)] ?? 0;
        attempted++;
        let session: ReturnType<SuperAgentManager["spawn"]>;
        try {
          session = manager.spawn(spec, { runId, wave });
        } catch (error) {
          // spawn 抛错绝不能冒到 onSessionUpdate：上层 jsonrpc 通知分发若被
          // 一帧异常打断，整条流都会停。这里记 failed 并继续处理后续任务。
          const reason = errorMessage(error);
          this.log.error(`super agent: spawn failed 「${spec.title}」: ${reason}`);
          this.store.sendToast(
            "warning",
            vscode.l10n.t("派发超流体「{0}」失败：{1}", spec.title, reason),
          );
          this.queueSuperToolCallCorrection(`spawn failed: ${reason}`);
          continue;
        }
        // 注入回合（qqInjectedTaskId 非空）里派生的子会话归属该 QQ 主任务：记下
        // 映射，子会话随后 ask_user_question 时才能把提醒转发给同一个 QQ 用户。
        // 本地回合派生（qqInjectedTaskId 为空）不登记，保持本地提问不转发。
        if (this.qqHost.qqInjectedTaskId) {
          this.qqHost.qqTaskBySuperSession.set(session.id, this.qqHost.qqInjectedTaskId);
        }
        this.rememberDispatchedDirective(dedupeKey);
        dispatched++;
        this.log.info(`super agent: dispatched ${session.id} 「${spec.title}」(runId=${runId} wave=${wave})`);
      }
    }
    if (droppedAttachments > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("超流体派发指令中有 {0} 个附件不可用（不在工作区或暂存目录），已忽略", droppedAttachments),
      );
    }
    if (dispatched === 0) {
      // 零派发绝不能静默：用户/模型都以为指令已生效正是这次要消灭的故障。
      if (attempted === 0 && duplicates > 0) {
        // 纯重复：载荷此前已派发过（同一份载荷从正文 / 工具两条通道到达）。
        this.log.info(
          `super agent: all ${duplicates} directive task(s) were already dispatched — skipped as duplicate(s)`,
        );
        this.store.sendToast(
          "info",
          vscode.l10n.t("该超流体指令已派发过，已跳过 {0} 个重复任务", duplicates),
        );
      } else if (attempted === 0 && blockErrors === 0) {
        // 载荷里没有可派发的任务（空块 / 全被过滤）：给一条可见提示。
        this.log.warn("super agent: no super session dispatched — the payload had no dispatchable task");
        this.store.sendToast(
          "warning",
          vscode.l10n.t("派发指令没有产生任何超流体，请检查任务内容"),
        );
      } else if (attempted > 0) {
        // 每个失败已各自 toast；这里补一条汇总，避免只剩零散错误。
        this.log.warn(
          `super agent: all ${attempted} spawn attempt(s) failed — nothing dispatched (${duplicates} duplicate(s) skipped)`,
        );
      }
      // blockErrors>0 且 attempted===0：整块错误已 toast，不再重复。
      return { dispatched, duplicates, managerAvailable: true };
    }
    // 提示里报实际生效的上限（设置页可调），而不是写死的常量。
    const concurrency = clampMaxConcurrentSuperSessions(
      this.setting<number>("superAgent.maxConcurrent", DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS),
    );
    this.store.sendToast(
      "info",
      vscode.l10n.t("已派发 {0} 个超流体（并发上限 {1}）", dispatched, concurrency),
    );
    return { dispatched, duplicates, managerAvailable: true };
  }


  /**
   * 结构化工具调用兜底。
   *
   * 模型把派发 / 管理写成 `super-agent` / `super-agent-actions` 工具调用时，
   * 内核 registry 里没有这两个工具 —— 旧实现既不执行也不提示，用户以为已经
   * 派了，实际什么都没发生。这里从 `args` 取载荷、包成对应围栏文本，再交给
   * 现有解析器（`shared/super-tool-call.ts` 复用 `extractSuperDirectives` /
   * `extractSuperActions`，不复制校验逻辑）。
   *
   * 失败**必须留痕**：名字命中了却取不出可用载荷时记一条日志并弹一次 toast
   * （按 toolCallId 去重）。绝不伪造派发 —— 载荷坏了就当没派，明确告诉用户。
   *
   * 工具帧本身仍照常进 store（失败的工具卡是可见性，不能屏蔽）。
   */
  handleSuperToolCall(update: ToolCallBase): void {
    const name = (update.toolName ?? update.title ?? "").trim();
    // 名字归一之外也认 getDescription 的短标签：智能审批形态的权限请求 /
    // 工具帧可能只带标题（`Delegate 1 task` / `Manage 1 child session action`），
    // 见 shared/super-tool-call.ts 的 classifySuperToolTitle。
    const kind = classifySuperToolName(name) ?? classifySuperToolTitle(name);
    if (!kind) return;
    // 账本键与 superToolCallWarned 用同一个原始 id（不裁剪），否则同一个
    // 工具调用的告警记录与结果记录会被当成两个键。
    const toolCallId = update.toolCallId ?? "";
    // 失败帧已经由内核把真实错误回给模型（functionResponse.error），宿主
    // 不需要再核对 —— 再说一遍只会制造重复噪音。
    if (update.status === "failed") return;
    // 同一条调用已经处理过（派发 / 动作 / 已留痕），后续帧一律跳过：
    // 否则 in_progress 与 completed 各带一次载荷会各派一遍。
    if (toolCallId && this.superToolCallOutcomes.has(toolCallId)) return;
    const hasArgs = update.args !== undefined && update.args !== null;
    if (!hasArgs) {
      // Wire 实证（CLI 0.5.19，见 protocol.ts 的 `args` 注释）：原始参数只随
      // `tool_call_update(in_progress)` 到达，pending 帧通常没有 args。此时还
      // 不能下结论 —— 下一帧就会带载荷；在 pending 帧弹「未派发子会话」是
      // 误报。但 completed 帧仍然没有载荷，就说明这次调用整轮都没把东西交给
      // 宿主，必须核对（工具层只回 ack，模型会以为派成功）。
      if (update.status === "completed") this.auditSuperToolCallCompletion(update, name);
      return;
    }
    const parsed = parseSuperToolCall(kind, update.args);
    if (!parsed.ok) {
      this.warnUnsupportedSuperToolCall(update, name, parsed.reason, parsed.issues);
      return;
    }
    // 载荷纠偏：新版 `super-agent` 工具同时收 tasks / actions，模型做管理动作
    // 时可能只传 `{"actions":[…]}`（名字仍是 dispatch）。分流以解析器纠偏后的
    // kind 为准 —— 管理动作走动作链路，既不派发子会话，也不是「未派发」失败。
    this.log.info(
      `super agent: accepted structured ${parsed.kind} tool call (${update.toolCallId || "no-id"})`,
    );
    if (parsed.kind === "dispatch") {
      const result = this.dispatchSuperTasks(parsed.tasks, parsed.issues, toolCallId);
      if (result.deferred) {
        // 没有打开工作区、可能回退默认工作区：结果要等异步 stat 之后才知道。
        // 这里先不记账（记 failed 会是假账，记 dispatched 更是谎报），由
        // dispatchSuperTasksViaDefaultWorkspace 回填同一 toolCallId 的终态。
        return;
      }
      // 记账必须反映真实结果，不能只因为「解析成功」就写 dispatched：
      //  - 没有管理器 → 零 spawn，记 failed（旧实现这里记 dispatched 是假账）；
      //  - 有管理器但一条都没派出去（spawn 全抛错 / 无任务）→ 记 failed；
      //  - 纯重复载荷此前确实已派发过 → 仍记 dispatched。
      this.recordSuperToolCallOutcome(toolCallId, dispatchOutcome(result));
      return;
    }
    // 同一工具帧会在 pending / in_progress 两帧各带一次载荷；动作没有载荷
    // 账本（派发侧有 `superDispatchedDirectives`），不去重就会执行两次 ——
    // `cleanup` / `retry` 的第二次会报假失败，`cleanup` 还可能并发操作同一个
    // worktree。按「工具调用 + 载荷」去重，不同调用照常各自执行。
    const actionKey = `${update.toolCallId || "no-id"}#${parsed.text}`;
    if (this.superToolCallActionsDone.has(actionKey)) {
      this.log.info(
        `super agent: skipped-duplicate structured actions tool call (${update.toolCallId || "no-id"})`,
      );
      this.recordSuperToolCallOutcome(toolCallId, "actions");
      return;
    }
    this.rememberSuperToolCallActions(actionKey);
    // 记账在启动前：runSuperActions 是异步的，completed 帧可能在它 settle 前
    // 到达，先记才能保证不重复执行同一条动作。
    this.recordSuperToolCallOutcome(toolCallId, "actions");
    // 带上 toolCallId：runSuperActions 收尾时把每条动作的真实结果回填到这张
    // 工具帧，动作卡才能显示「中断成功 / not-found」而不是绿色「已完成」。
    void this.runSuperActions(parsed.actions, update.toolCallId);
  }


  /**
   * completed 帧核对：这次结构化工具调用到底有没有把载荷交给宿主。
   *
   * 触发条件是「载荷整轮都没到达」（见 {@link handleSuperToolCall} 的
   * `!hasArgs` 分支）。此时工具层已经向模型回了 `Delegation request accepted.`，
   * 但宿主什么都没做 —— 用户会看到「模型说已派发、看板空空如也」。这里补上
   * 两条留痕：用户可见 toast + 回给主会话的纠错提示（带原因与正确格式），
   * 让模型能在同一轮里重发。
   *
   * 之前报过「载荷不合法」的调用不再重复报（toast 已经在
   * {@link warnUnsupportedSuperToolCall} 里弹过），只补记终态。
   */
  auditSuperToolCallCompletion(update: ToolCallBase, name: string): void {
    const id = update.toolCallId ?? "";
    if (id && this.superToolCallOutcomes.has(id)) return;
    if (id && this.superToolCallWarned.has(id)) {
      this.recordSuperToolCallOutcome(id, "rejected");
      return;
    }
    this.recordSuperToolCallOutcome(id, "dropped");
    this.log.warn(
      `super agent: tool call 「${name}」 (${id || "no-id"}) completed without a usable payload — NOTHING was dispatched`,
    );
    this.store.sendToast(
      "warning",
      vscode.l10n.t("派发指令没有送达，未派出任何新任务"),
    );
    this.queueSuperToolCallCorrection(
      "the tool call completed without a usable payload — no tasks/actions ever reached the host, so nothing was dispatched",
    );
  }


  /**
   * 记一条结构化工具调用的终态（有界 Map，超了丢最早一条）。
   *
   * 与 {@link superToolCallWarned} / {@link superToolCallActionsDone} 同一套
   * 有界做法：工具帧数量本身不设界，账本必须有上限；换会话 / 恢复会话 /
   * 热重认证时由 {@link resetSuperDirectiveScans} 清空。
   */
  recordSuperToolCallOutcome(
    toolCallId: string,
    outcome: SuperToolCallOutcome,
  ): void {
    if (!toolCallId) return;
    if (this.superToolCallOutcomes.size >= SuperAgentHost.SUPER_TOOL_CALL_OUTCOME_CAP) {
      const oldest = this.superToolCallOutcomes.keys().next().value;
      if (oldest !== undefined) this.superToolCallOutcomes.delete(oldest);
    }
    this.superToolCallOutcomes.set(toolCallId, outcome);
  }

  /** 记住一条已执行的动作工具调用（有界 Set，超了丢最早一条）。 */

  rememberSuperToolCallActions(key: string): void {
    if (this.superToolCallActionsDone.size >= SuperAgentHost.SUPER_TOOL_CALL_ACTIONS_CAP) {
      const oldest = this.superToolCallActionsDone.values().next().value;
      if (oldest !== undefined) this.superToolCallActionsDone.delete(oldest);
    }
    this.superToolCallActionsDone.add(key);
  }


  /**
   * 委派载荷指纹：账本只存 SHA-256 摘要，不存整份载荷键。
   *
   * `superDirectiveDedupeKey` 会把附件的内联数据（base64 图片/文件，可达
   * MB 级）一起序列化进键 —— 直接把键存进集合等于把附件内容在内存里再留
   * 一份。摘要后每条账目只有 32 个 hex 字符（16 字节摘要），两条不同载荷
   * 撞车的概率 ~2⁻¹²⁸，可以当作「同键即同载荷」。
   */
  static superDirectiveFingerprint(dedupeKey: string): string {
    return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  }


  /**
   * 记住一条已派发的委派载荷（有界 FIFO 账本，超了丢最早一条）。
   *
   * 与 {@link superToolCallActionsDone} / {@link superToolCallWarned} 同一套
   * 有界集合做法：载荷数量不设界，账本必须有上限，否则长时间运行的会话会
   * 一直涨。
   *
   * 淘汰的代价（诚实说明）：被淘汰的载荷若再次出现在正文里，会被当成新
   * 载荷**再派发一次**（多开一个子会话）。触发条件很窄 —— 先有 100 条不同
   * 载荷被派发过，模型再逐字重写其中一条；那时会话早已有上百个子会话，
   * 多开一个的代价比账本无限增长小。跨通道去重（思考里写一遍、正文里再写
   * 一遍）的真实场景发生在同一轮内，落在窗口之内，不受影响。
   */
  rememberDispatchedDirective(fingerprint: string): void {
    if (this.superDispatchedDirectives.size >= SuperAgentHost.SUPER_DISPATCHED_DIRECTIVES_CAP) {
      const oldest = this.superDispatchedDirectives.values().next().value;
      if (oldest !== undefined) this.superDispatchedDirectives.delete(oldest);
    }
    this.superDispatchedDirectives.add(fingerprint);
  }


  /**
   * 名字命中但载荷不可用：日志 + 一次性 toast。
   *
   * 同一条工具帧会在 pending / in_progress / completed 之间反复推送，按
   * toolCallId 去重（没有 id 时退化为「名字 + 状态」）。集合有上限：工具帧
   * 数量本身不设界，不能让它无限增长；换会话时由
   * {@link resetSuperDirectiveScans} 清空。
   */
  warnUnsupportedSuperToolCall(
    update: ToolCallBase,
    name: string,
    reason: string,
    issues: readonly string[] = [],
  ): void {
    const key = update.toolCallId || `${name}#${update.status ?? ""}`;
    if (this.superToolCallWarned.has(key)) return;
    if (this.superToolCallWarned.size >= SuperAgentHost.SUPER_TOOL_CALL_WARN_CAP) {
      const oldest = this.superToolCallWarned.values().next().value;
      if (oldest !== undefined) this.superToolCallWarned.delete(oldest);
    }
    this.superToolCallWarned.add(key);
    this.log.warn(
      `super agent: tool call 「${name}」 (${update.toolCallId || "no-id"}) yielded no usable payload: ${reason}`,
    );
    this.store.sendToast(
      "warning",
      vscode.l10n.t("派发指令格式有误（{0}），未派出任何新任务", reason),
    );
    // 宿主能看见「这次没派出去」，模型却只收到一个 failed 工具帧 —— 补一条
    // hidden prompt 把原因和正确格式送回主会话上下文，让它在同一轮里自行修正。
    this.queueSuperToolCallCorrection(issues[0] ?? reason);
  }


  /**
   * 入队一条「super-agent 参数不合法」的纠错提示（hidden prompt）。
   *
   * 限次是硬约束：同一主会话同一轮最多 {@link SUPER_TOOL_CALL_CORRECTION_CAP}
   * 次，超出只留 toast 与日志 —— 工具层已经会让这次调用 failed，模型若坚持
   * 写同样的错误参数，宿主不能无限给自己喂回合。
   *
   * 提示词只带**原因**与**正确格式示例**，绝不回贴畸形原文：原文可能就是
   * 一大段错位 JSON，贴回上下文既浪费 token，又可能诱导模型照抄。
   */
  queueSuperToolCallCorrection(detail: string): void {
    const owner = this.currentMainSessionId();
    const key = owner ?? "";
    const used = this.superToolCallCorrections.get(key) ?? 0;
    if (used >= SuperAgentHost.SUPER_TOOL_CALL_CORRECTION_CAP) {
      // 配额压制只压 hidden prompt，不压「这次错了」的事实：调用方已经弹过
      // toast，这里再用 warn 把原因（截断）留在日志里，避免缺 title 这类
      // 结构性错误只剩队列里一条永远投不出去的提示。
      this.log.warn(
        `super agent: parameter-correction prompt suppressed (${used}/${SuperAgentHost.SUPER_TOOL_CALL_CORRECTION_CAP} used this round); the malformed payload was already surfaced via toast/log: ${detail.slice(0, 160)}`,
      );
      return;
    }
    this.superToolCallCorrections.set(key, used + 1);
    const text = [
      "[super-agent tool call rejected]",
      `Reason: ${detail}`,
      "Required format:",
      '{"tasks":[{"title":"short title","task":"self-contained brief"}]}',
      "请修正后重新调用 super-agent（不要重复提交同样的参数）。",
    ].join("\n");
    this.pendingSuperToolCallCorrections.push({ mainSessionId: owner, text });
    this.log.info("super agent: queued a parameter-correction prompt for the main session");
    // 工具调用必然发生在主会话生成中，几乎一定等不到空闲 —— 点着心跳，
    // 回合结束后由统一仲裁补投；心跳也会在没有其它待办时自行停表。
    this.ensureSuperHeartbeat();
    void this.drainSuperAutoTurns();
  }


  /**
   * 把排队的纠错提示逐条投给主会话。
   *
   * 与子会话汇报 / 动作回执 / 合并请求共用同一条「主会话空闲」车道：同一时刻
   * 只能有一个回合跑在同一个 ACP 会话上。条件不满足就把提示留在队列里，
   * 由心跳重试 —— 丢了它模型就永远不知道自己错在哪。
   */
  async drainSuperToolCallCorrections(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    if (this.autoTurnsHeld()) return;
    // 与汇报 / 动作回执 / 改道消息补投共用 superReportRunning 这一条车道：
    // mainLane 的同步申领才是「同一时刻只有一个回合」的实际保证，四个 drain
    // 用同一把重入锁即可，不需要另立一把（那只会让注释与实现漂移）。
    this.superReportRunning = true;
    try {
      while (this.pendingSuperToolCallCorrections.length > 0) {
        if (this.disposed) return;
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 合并子会话在主仓工作区跑 git：主会话此时再跑回合会互相踩。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        // 只投当前主会话的提示：别的会话等用户切过去再投（串台）。
        const owner = this.currentMainSessionId();
        const index = this.pendingSuperToolCallCorrections.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingSuperToolCallCorrections[index]!;
        this.log.info("super agent: delivering the parameter-correction prompt as a hidden main-session turn");
        const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
          delegateOnBusy: false,
          hidden: true,
        });
        if (!started) break; // 主会话被占：留在队列里等心跳重投。
        const pos = this.pendingSuperToolCallCorrections.indexOf(item);
        if (pos !== -1) this.pendingSuperToolCallCorrections.splice(pos, 1);
        // 这一轮端点 / 内核报错：别在心跳里连续喂下一条，留给用户处理。
        if (this.store.getState().status === "error") break;
      }
    } catch (error) {
      this.log.warn(`super agent correction delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
  }


  /**
   * Scan the MAIN session's assistant text for child-session management
   * actions (`super-agent-actions` fenced blocks).
   *
   * Same channel and same guard as delegation scanning: only the main
   * agent's own text is read, so a child can never steer another child.
   * Actions execute as soon as the block closes — the main session can
   * retry / cancel / answer / merge / clean up mid-turn instead of waiting
   * for the user to click the board.
   */
  scanSuperActions(content: unknown): void {
    const text = this.chunkText(content);
    if (!text) return;
    this.superActionScanText += text;
    const scan = extractSuperActions(this.superActionScanText, this.superActionScanOffset);
    if (scan.end > this.superActionScanOffset) this.superActionScanOffset = scan.end;
    if (scan.invalidBlocks.length > 0) {
      this.store.sendToast("warning", vscode.l10n.t("超流体管理指令无法解析，已忽略"));
    }
    if (scan.actions.length > 0) {
      void this.runSuperActions(scan.actions);
    }
    // 围栏开了没收：记住它。流式期间这是正常中间态（载荷下一帧才到），不在
    // 每帧报警；但**回合都结束了还停在这里**，说明这个动作块永远不会被执行
    // —— 回合收尾时复核并留痕（见 `auditSuperActionsAtSettle`）。
    if (scan.pending) {
      this.superActionPending = true;
      this.superActionPendingBody = scan.pendingBody ?? "";
    } else if (this.superActionPending) {
      // 后来补齐了（或者被后面那个完整围栏顶掉了）—— 不是问题。
      this.superActionPending = false;
      this.superActionPendingBody = "";
    }
    // 静默失败变可见：围栏确实出现过、这一轮也扫完了（不是还在流式等收栏），
    // 却既没有动作也没有非法块 —— 主会话下过指令，宿主什么都没执行。旧实现
    // 在这里什么都不留，故障只能靠用户复述「我发过啊」。只记日志、不弹 toast：
    // 这条通道每来一段文本都会扫一次，弹窗会变成噪音。
    //
    // 去重：同一处「零动作」只记一次（每来一段文本都会扫一次，不去重就是刷屏）。
    const zeroFence =
      scan.sawFence && !scan.pending && scan.actions.length === 0 && scan.invalidBlocks.length === 0;
    if (zeroFence && !this.superActionZeroWarned) {
      this.superActionZeroWarned = true;
      this.log.warn(
        `super-agent-actions fence produced no actions (scan buffer ${this.superActionScanText.length} chars, consumed offset ${this.superActionScanOffset})`,
      );
    } else if (!zeroFence) {
      this.superActionZeroWarned = false;
    }
  }


  /**
   * 回合收尾时复核动作围栏：把「停在未闭合围栏上」变成一条**有内容**的日志。
   *
   * 流式期间 pending 是正常中间态（围栏还没写完），每帧都报警只会变成噪音；
   * 但回合都结束了还停在 pending，说明这个动作块**永远不会被执行** —— 旧实现
   * 对此完全静默（零日志、零 toast），主会话只能靠重发一次才发现动作没生效。
   *
   * 这里**再扫一次**再下结论：回合结束时缓冲里的文本是最终形态，重新扫能
   * 确认「确实没收栏」而不是「最后一帧恰好还没到」。
   */
  auditSuperActionsAtSettle(): void {
    if (!this.superActionPending) return;
    const body = this.superActionPendingBody;
    this.superActionPending = false;
    this.superActionPendingBody = "";
    try {
      const scan = extractSuperActions(this.superActionScanText, this.superActionScanOffset);
      // 后来补齐了 → 不是问题（动作已经执行或已被后面那个完整围栏顶掉）。
      if (!scan.pending) return;
      this.log.warn(
        `super-agent-actions fence never closed — the action block was NOT executed (unfinished payload: ${body || "(empty)"}; scan buffer ${this.superActionScanText.length} chars, consumed offset ${this.superActionScanOffset})`,
      );
    } catch (error) {
      this.log.warn(`super agent action audit failed: ${errorMessage(error)}`);
    }
  }


  /**
   * Execute parsed management actions in output order.
   *
   * Failures are never silent: an action aimed at a stale id or inapplicable
   * state is counted as ignored and reported once, so the main session can
   * correct itself on the next turn (the board snapshot shows the real state).
   *
   * **「未生效」的口径要诚实**：对一个**已经是终态**的子会话再发一次 cancel
   * 是幂等重复 —— 意图（「别再跑了」）已经达成，宿主什么都不用做。那不是
   * 「未生效」，报成未生效会让主会话以为动作失败并**重复发同一个动作**
   * （真实故障）。只有「目标根本不存在」或「状态不适用」才是真的没生效。
   *
   * 每个动作的结果汇成一份**回执**投回主会话（hidden prompt）：主会话的
   * 看板摘要是每轮开篇冻结的，同一轮里它看不到自己动作的效果 —— 没有回执它
   * 就会重复发同一个动作。
   */
  async runSuperActions(
    actions: readonly SuperAction[],
    toolCallId?: string,
  ): Promise<void> {
    const manager = this.deps.getSuperAgent();
    if (!manager) return;
    let applied = 0;
    let ignored = 0;
    const receipts: SuperActionReceipt[] = [];
    for (const action of actions) {
      try {
        let receipt: SuperActionReceipt | undefined;
        switch (action.action) {
          case "retry": {
            const ok = await manager.retry(action.sessionId);
            receipt = {
              action: "retry",
              sessionId: action.sessionId,
              ok,
              reason: ok ? "applied" : "not-applicable",
              ...(ok ? {} : { detail: "the child session is not in a retryable state" }),
            };
            break;
          }
          case "cancel": {
            // 方案 B 关联点：这条 cancel 一定会产生动作回执，先登记目标 id。
            // manager.cancel 内部同步 notifyReport → settleSuperReportsIfReady，
            // 它会据此把 dropped 上报暂存、稍后并入本回执，而不是另起一轮。
            this.agentCancelWithReceiptIds.add(action.sessionId);
            const outcome = await manager.cancel(action.sessionId, "agent");
            receipt = {
              action: "cancel",
              sessionId: action.sessionId,
              ok: outcome.ok,
              reason: outcome.reason === "cancelled" ? "applied" : outcome.reason,
              ...(outcome.reason === "already-terminal"
                ? { detail: `the child session was already ${outcome.status}` }
                : outcome.reason === "not-found"
                  ? { detail: "no such child session (it may have been cleaned up already)" }
                  : {}),
            };
            // hidden 回执只进主会话上下文，用户看不到。主 Agent 从每轮冻结的
            // 看板摘要里抄 id，抄错时 cancel 返回 not-found —— 这正是「中断没
            // 生效」的真实故障现场。这里额外给用户一条带 id 的明确提示。
            if (!outcome.ok && outcome.reason === "not-found") {
              this.store.sendToast(
                "warning",
                vscode.l10n.t(
                  "中断失败：找不到超流体 {0}，可能已被清理或编号有误",
                  action.sessionId,
                ),
              );
            }
            break;
          }
          case "answer": {
            const ok = manager.respond(action.sessionId, { answers: action.answers });
            receipt = {
              action: "answer",
              sessionId: action.sessionId,
              ok,
              reason: ok ? "applied" : "not-applicable",
              ...(ok ? {} : { detail: "the child session has no pending question" }),
            };
            break;
          }
          case "cleanup": {
            const result = await manager.cleanup(action.sessionId, { keepBranch: action.keepBranch });
            receipt = {
              action: "cleanup",
              sessionId: action.sessionId,
              ok: result.ok,
              reason: result.ok ? "applied" : "not-applicable",
              ...(result.ok
                ? {}
                : { detail: result.reason ?? "the child session could not be cleaned up" }),
            };
            break;
          }
        }
        if (!receipt) {
          receipt = {
            action: action.action,
            sessionId: action.sessionId,
            ok: false,
            reason: "not-applicable",
            detail: "unknown action",
          };
        }
        receipts.push(receipt);
        if (receipt.ok) applied++;
        else ignored++;
      } catch (error) {
        ignored++;
        receipts.push({
          action: action.action,
          sessionId: action.sessionId,
          ok: false,
          reason: "not-applicable",
          detail: `the host failed to run the action: ${errorMessage(error)}`,
        });
        this.log.warn(`super agent action ${action.action} failed: ${errorMessage(error)}`);
      }
    }
    if (applied > 0) {
      this.store.sendToast("info", vscode.l10n.t("已按主会话指令管理超流体：成功 {0} 个", applied));
    }
    if (ignored > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("{0} 个超流体管理动作未生效（目标不存在或状态不适用）", ignored),
      );
    }
    // 工具调用触发的动作：把真实结果回填到那张工具帧，动作卡据此显示
    // 「完成 / 未找到 / 失败」而不是把「工具调用完成」当成动作成功。
    // 同时把每条动作的目标子会话标题一并回填 —— 标题只存在于宿主的
    // super-session 记录里（webview 无权查表），带下去卡片才能显示
    // 「标题（id）」而不是裸 id。取不到标题（记录已清理）就留空，
    // 卡片优雅退回只显示 id。
    if (toolCallId) {
      const enriched: SuperDirectiveAction[] = actions.map((action) => {
        const title = manager.get?.(action.sessionId)?.title?.trim() || undefined;
        switch (action.action) {
          case "answer":
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
              answerCount: Object.keys(action.answers ?? {}).length,
            };
          case "cleanup":
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
              ...(action.keepBranch ? { keepBranch: true } : {}),
            };
          default:
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
            };
        }
      });
      this.store.superActionResult(toolCallId, receipts, enriched);
    }
    this.queueSuperActionReceipt(receipts);
  }


  /**
   * 把动作执行结果排进主会话的回执队列。
   *
   * 走的是与子会话汇报同一条通道：**主会话上的一次 hidden prompt**（转录里
   * 不出现用户气泡）。主会话正忙着时它留在队列里等空闲时重投 —— 回执绝不
   * 丢：丢了主会话就永远不知道自己刚发的动作到底生效没有（于是重复发）。
   */
  queueSuperActionReceipt(receipts: readonly SuperActionReceipt[]): void {
    if (receipts.length === 0 || this.disposed) return;
    const cancelIds = new Set(
      receipts.filter((receipt) => receipt.action === "cancel").map((receipt) => receipt.sessionId),
    );
    // 方案 B：把同一批 agent cancel 暂存的 dropped 汇报并入这条回执 —— 主会话
    // 只收到一轮 hidden prompt（回执文本里同时说明取消结果与停在哪里）。
    const merged = this.pendingAgentCancelMerges.filter((held) =>
      held.sessionIds.some((id) => cancelIds.has(id)),
    );
    const text = buildSuperActionReceiptPrompt(
      receipts,
      merged.flatMap((held) => held.entries),
    );
    // 无论合并命中与否都收口登记簿：命中的已消费，没命中的由 leftover 回退
    // 为普通汇报轮 —— 暂存汇报绝不永久卡在缓冲的 in-flight 标记上。
    const leftovers = this.pendingAgentCancelMerges.filter((held) => !merged.includes(held));
    this.pendingAgentCancelMerges.length = 0;
    this.agentCancelWithReceiptIds.clear();
    const flushLeftovers = (): void => {
      for (const held of leftovers) this.pendingSuperReportPrompts.push(held.item);
      if (leftovers.length > 0) {
        this.ensureSuperHeartbeat();
        void this.drainSuperAutoTurns();
      }
    };
    if (!text) {
      flushLeftovers();
      return;
    }
    // 同一份回执不重复排队（否则主会话会反复收到一模一样的「已生效」）。
    // 去重命中时把暂存汇报一并回退，杜绝「回执被吞掉、汇报也没了」。
    if (text === this.superActionReceiptLast) {
      flushLeftovers();
      return;
    }
    this.superActionReceiptLast = text;
    const reportKeys = merged.flatMap((held) => held.item.reportKeys ?? []);
    const fallbackText = merged
      .map((held) => held.item.fallbackText)
      .filter((value): value is string => !!value && value.length > 0)
      .join("\n");
    const final = merged.some((held) => held.item.final === true);
    this.pendingSuperActionReceipts.push({
      mainSessionId: this.currentMainSessionId(),
      text,
      ...(reportKeys.length > 0
        ? { reportKeys, fallbackText, final, cancelSessionIds: [...cancelIds] }
        : {}),
    });
    flushLeftovers();
    this.ensureSuperHeartbeat();
    void this.drainSuperAutoTurns();
  }


  /**
   * 投递一条动作回执（与子会话汇报共用同一条车道，互斥执行）。
   *
   * 只在主会话**空闲**时投：主会话正忙着的时候它只能排队（hidden 回合不能
   * 插进正在跑的回合 —— 同一条 ACP 会话上并发两个回合会乱序）。
   */
  async drainSuperActionReceipts(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    const owner = this.currentMainSessionId();
    const index = this.pendingSuperActionReceipts.findIndex(
      (item) => item.mainSessionId === owner,
    );
    if (index === -1) return;
    if (!this.mainSessionFree()) return;
    if (this.superMergeRunning || this.pendingSuperMerges.length > 0 || this.superMergeChildRunning()) {
      return;
    }
    const item = this.pendingSuperActionReceipts[index]!;
    // 方案 B：带 reportKeys 的回执同时是一条汇报轮 —— 它承载了同一次 cancel
    // 的 dropped 上报，因此必须保留汇报轮的 finalReport / QQ 兜底语义。
    const hasMergedReport = (item.reportKeys?.length ?? 0) > 0;
    let reportAnchorId: string | undefined;
    let reportAnchorLen = 0;
    let reportTextBefore = 0;
    if (hasMergedReport) {
      const visibleBefore = this.store.getState().blocks.filter(
        (block) => block.kind === "text" && !block.system,
      );
      const anchor = visibleBefore[visibleBefore.length - 1];
      reportAnchorId = anchor?.id;
      reportAnchorLen = anchor?.kind === "text" ? anchor.text.length : 0;
      reportTextBefore = visibleBefore.length;
      const cleanFallback = sanitizeQqReportFallback(item.fallbackText);
      if (cleanFallback && owner && this.qqHost.qqFinalRescueOwnerPending(owner)) {
        this.qqHost.qqFinalRescueText.set(owner, cleanFallback);
        this.qqHost.qqReportFallbackText.set(owner, cleanFallback);
      }
    }
    this.superReportRunning = true;
    try {
      this.clearSuperWaitHeartbeat();
      this.log.info("super agent: delivering the child-session action receipt as a fresh main-session turn");
      const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
        delegateOnBusy: false,
        hidden: true,
        ...(hasMergedReport
          ? {
              // 与汇报轮同款：不重复注入看板摘要；finalReport 让 QQ 最终
              // 答复仍能由这一轮（而不是被合并掉的那条汇报轮）投递。
              internal: true,
              reportTurn: true,
              finalReport: item.final === true,
              finalFallbackText: item.fallbackText,
            }
          : {}),
      });
      // 回合没跑起来（主会话被别的回合占着）：这条回执**留在队列里**，等空闲
      // 时重投 —— 回执丢了主会话就会重复发同一个动作。
      if (!started) return;
      // 等 sendPrompt 的这几分钟里 deleteSession / dispose 会并发改写队列，
      // 之前 findIndex 拿到的 index 可能已经指向别人。按对象身份重定位，
      // 与 drainSuperReports / drainDelegatedUserTurns 同一套出队纪律：
      // 宁可找不到（已被删除会话清掉）也不误删别的会话刚投出的回执。
      const pos = this.pendingSuperActionReceipts.indexOf(item);
      if (pos !== -1) this.pendingSuperActionReceipts.splice(pos, 1);
      if (hasMergedReport) {
        const reportTurnText = this.captureQqReportTurnText(
          reportAnchorId,
          reportTextBefore,
          reportAnchorLen,
        );
        // 与 drainSuperReports 同一口径：只有真正 settle（没被 Stop 压住、
        // 没落在 error）才 confirm 上报键；否则转入 delivered-unacked，由心跳
        // 把这条**回执**重投 —— 上报绝不因为回执轮被打断而丢失。
        const genuinelySettled =
          this.store.getState().status !== "error" && !this.autoTurnsHeld();
        if (genuinelySettled) {
          this.pendingSuperReports.get(item.mainSessionId ?? "")?.confirm(item.reportKeys ?? []);
        } else {
          this.markReportDelivered(item, reportTurnText, "receipt");
        }
        // R2 迟到补发缓存：与汇报轮同源，只缓存本轮新增正文。
        if (reportTurnText && owner && this.qqHost.qqFinalRescueOwnerPending(owner)) {
          this.qqHost.qqFinalRescueText.set(owner, reportTurnText);
        }
        // 与原 allDropped 汇报一致（suppressQqProgress:true）：这类纯 host-state
        // 确认不作为 QQ 中间正文转发，避免一次 cancel 在 QQ 上回两次。
      }
    } catch (error) {
      this.log.warn(`super agent action receipt delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
  }


  /**
   * 把 streaming 期间被改道给子会话的用户消息补投回主会话（hidden 回合）。
   *
   * 与子会话汇报 / 动作回执 / 合并请求共用同一条车道：`superReportRunning`
   * 是重入锁（这几个 drain 都在第一个 await 之前同步申领，谁先申领谁跑），
   * 主会话空闲（mainSessionFree，含 mainLane 空闲）才投，合并队列在跑时先
   * 让路。心跳会反复调用，所以「被占用 / 失败」的条目只是留在缓冲里等下一
   * 拍，绝不丢失、绝不重复派发。
   *
   * 补投走 `hidden:true + delegateOnBusy:false`：hidden 保证不伪造用户气泡、
   * 不改名、不拍 checkpoint；`delegateOnBusy:false` 保证它即便撞上 busy 窗口
   * 也只是被拒（留在缓冲里等下一拍），**不会二次派发子会话**。附件按原始
   * 形态重新附上（image 块 + AGENT_ATTACHMENT_HEADER 路径清单），文本由
   * buildDelegatedUserTurnPrompt 如实标注来源，不伪装成子会话汇报、不伪造
   * 附件内容（全部原件都带回，missingCount 因此恒为 0）。
   */
  async drainDelegatedUserTurns(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    // 用户按过停止：自动回合不许在这一轮结束后立刻接上（否则一次停止看起来
    // 毫无作用，用户只能反复点）。条目留在队列里，用户下次主动发消息即恢复。
    if (this.autoTurnsHeld()) return;
    if (this.pendingDelegatedUserTurns.length === 0) return;
    const owner = this.currentMainSessionId();
    if (!this.pendingDelegatedUserTurns.some((item) => item.mainSessionId === owner)) return;
    this.superReportRunning = true;
    try {
      while (true) {
        if (this.disposed) return;
        // 与 drainSuperReports 同因：drain 在跑的时候用户按了停止，循环不能
        // 立刻把下一条补投接上。
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 与汇报 turn 同款门控：一轮失败后别在心跳里连续喂下一条。
        if (this.store.getState().status === "error") break;
        // 合并子会话在主仓工作区里跑 git：与它互斥，等合并走完再投。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        const index = this.pendingDelegatedUserTurns.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingDelegatedUserTurns[index]!;
        const text = buildDelegatedUserTurnPrompt({
          text: item.text,
          images: item.images,
          imageCaptions: item.imageCaptions,
          files: item.files,
          droppedByChild: item.droppedByChild,
        });
        this.log.info(
          "super agent: backfilling a delegated user turn as a fresh main-session hidden turn",
        );
        const started = await this.sendPrompt(
          text,
          item.images.length > 0 ? item.images : undefined,
          item.files.length > 0 ? item.files : undefined,
          item.contexts,
          {
            delegateOnBusy: false,
            hidden: true,
            ...(item.imageCaptions.some((c) => c.trim() !== "") ? { imageCaptions: item.imageCaptions } : {}),
          },
        );
        // 没跑起来（主会话被别的回合占着 / 被拒）：留在缓冲里等下一拍重投，
        // 既不丢这条消息，也不会重复派发子会话。
        if (!started) break;
        const pos = this.pendingDelegatedUserTurns.indexOf(item);
        if (pos !== -1) this.pendingDelegatedUserTurns.splice(pos, 1);
      }
    } catch (error) {
      this.log.warn(`delegated user turn backfill failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
  }


  /**
   * Live child-session board injected into every main-session turn.
   *
   * Without it the main agent has no way to know a child's state — it would
   * dispatch and then be blind until the user narrates the board.
   *
   * Never empty: the system prompt tells the agent that a turn WITHOUT a
   * `[子会话看板]` section is a CHILD session, so an empty board on the first
   * turn would make the main agent classify itself as a child and do the work
   * itself instead of delegating. The board marker is the role signal.
   */
  superAgentsDigest(): string {
    const sessions = this.store.getState().superSessions;
    return buildSuperDigest(sessions ?? []);
  }


  /**
   * Buffer a child-session status update and hand it to the MAIN session as
   * soon as THAT child has settled.
   *
   * 逐个即时汇报（2026-11-12）：谁先结束谁先汇报，不必等同一批全部跑完 ——
   * 主会话不必守着最慢的那个孩子。Reports are accumulated (one latest
   * report per child) and the settled ones are handed over right away; the
   * children still running keep their entry in the buffer.
   *
   * Delivery is a **real prompt on the main ACP session** (`hidden`, so no
   * user bubble appears), NOT a side-channel completion appended as a muted
   * note. The main turn has usually already ended by then (delegation is
   * mid-turn, children outlive it), so that prompt is what restarts the
   * conversation: the agent reads the reports from its OWN context and can
   * take the next step. A side note would leave the agent blind to its own
   * children — exactly the "主会话停了 / 流程断了" symptom.
   *
   * The prompt is queued and drained when the main session is free; the
   * Super Agent heartbeat retries until it lands.
   */
  queueSuperReport(entries: SuperReportEntry[]): void {
    if (entries.length === 0 || this.disposed) return;
    // 这些子会话已经把汇报交上来了：终态不再等于「已完成」。
    for (const entry of entries) this.superReportedChildIds.add(entry.session.id);
    // 按**归属主会话**分桶：汇报是投给某个主会话的一次真实 prompt，B 的
    // 子会话收尾时它的汇报不能投进 A 的对话（串台）。
    for (const entry of entries) {
      const key = this.superReportOwnerKey(entry.session);
      let buffer = this.pendingSuperReports.get(key);
      if (!buffer) {
        buffer = new SuperReportBuffer();
        this.pendingSuperReports.set(key, buffer);
      }
      buffer.add([entry]);
    }
    // 收到汇报 = 关键事件 → 立即落盘。指纹已覆盖终态 / integration / lastError /
    // statusDetail，但 diagnostics 是刻意不进指纹的高频流；回报正文随下一次写落盘
    // 前若宿主重启就会丢，因此在汇报到达这一刻显式 force 一次（节流窗口仅 800ms）。
    this.persistSuperSessions({ force: true });
    this.settleSuperReportsIfReady();
    this.syncSuperWaitingState();
  }


  /**
   * 汇报缓冲的桶键 = 归属主会话 id。
   *
   * 子会话没有归属（派发时面板还没有主会话 id）时跟随当前会话 —— 否则它的
   * 汇报永远没人接。
   */
  superReportOwnerKey(session: SuperSessionUi): string {
    return session.mainSessionId ?? this.currentMainSessionId() ?? "";
  }


  /**
   * 子会话是否属于**当前**主会话。
   *
   * 汇报必须按归属投递：用户在会话 A 开着的时候，会话 B 的子会话收尾，它
   * 的汇报不能作为一次真实 prompt 投进 A —— 那会把别的会话的结果插进 A
   * 的上下文（模型读到自己没有的孩子，转录里也冒出别的会话的结论）。
   */
  superBelongsToCurrentMain(session: SuperSessionUi): boolean {
    const owner = session.mainSessionId;
    if (!owner) return true; // 没有归属：跟随当前会话
    return owner === this.currentMainSessionId();
  }


  /**
   * 取走缓冲里**已经终态**的子会话汇报并投递（逐个即时汇报）。
   *
   * 门槛是「来源子会话已终态」，不是「这一批全部结束」—— 一个子会话跑完
   * 就交一次，主会话可以立刻接着推进；还在跑的子会话的汇报继续留在缓冲里。
   *
   * 只取**当前主会话**的子会话：别的会话的孩子还在跑（或者刚跑完），它的
   * 汇报要等用户切到那个会话再投。
   *
   * 来源子会话已经被清理（用户点清理 / 合并完释放）时，它的汇报没法再作为
   * 一次「实时汇报」投进主会话 —— 但结论不静默丢失：以「已归档子会话的迟到
   * 结论」提示落到看板（见 {@link announceArchivedLateReports}），既不伪造活
   * 跃子会话的汇报，也让用户真正看到那个结论。面板不会卡在忙碌态。
   *
   * 心跳与看板变化时都补一次重算：子会话被清理之后可能再没有人来触发取件
   * （它的 onReport 不会再来第二次）。
   */
  settleSuperReportsIfReady(): void {
    // **刻意不检查 `superReportRunning`**：本方法不发送任何回合，只把「已终态」
    // 的缓冲条目搬进 `pendingSuperReportPrompts` 投递队列（幂等键是 drainSettled
    // 的 in-flight 标记，同一条汇报不会被取两次）。真正「同一时刻只有一个回合」
    // 由 drainSuperReports 的重入锁与 mainLane 保证。
    //
    // 旧实现在这里 `|| this.superReportRunning` 早退，于是「上一轮汇报还在飞时
    // 又有子会话结束」这条完成事件既不进队列也不标 in-flight —— 只能等下一拍
    // 心跳（1.5s）重算，多个子会话并发完成就被攒成一条合并汇报（实测：看板 2 个
    // completed，主会话只收到 1 条上报）。
    if (this.disposed) return;
    if (this.pendingSuperReports.size === 0) return;
    const live = this.superAgent?.list() ?? [];
    // 来源子会话已不存在：结论不能静默丢 —— 用**全部**活子会话判（别的会话
    // 的汇报也得保住，只是现在没人接），取回完整条目交给看板提示。
    for (const buffer of this.pendingSuperReports.values()) {
      const archived = buffer.takeMissing(live);
      if (archived.length > 0) {
        this.log.warn(
          `super agent: ${archived.length} child report(s) arrived after their session(s) were cleaned up; surfacing as archived late conclusion(s)`,
        );
        this.announceArchivedLateReports(archived);
      }
    }
    // 只取当前主会话那一桶：别的会话的汇报留在它自己的桶里等用户切过去。
    const buffer = this.pendingSuperReports.get(this.currentMainSessionId() ?? "");
    if (!buffer || buffer.size === 0) return;
    const mine = live.filter((session) => this.superBelongsToCurrentMain(session));
    // 非破坏性取件：条目留在缓冲并标记 in-flight，直到投递成功（sendPrompt 跑
    // 起来）才由 drainSuperReports 调 confirm 出队（G2 投递可靠性）。去重键 =
    // sessionId:attempt，与 QQ 兜底重投共用，防止同一汇报被两条链路各投一次。
    const batch = buffer.drainSettled(mine);
    if (!batch) return; // 全都还在跑（或已 in-flight）：继续积累。
    const reportKeys = batch.map((entry) => superReportKey(entry.session));
    const manager = this.superAgent;
    // 汇报归属会话：pendingCount 与 QQ awaiter 归属都用它，避免从 entries[0]
    // 推断时因异步归属回填而与 awaiter 漂移（R2）。
    const reportOwner = this.currentMainSessionId();
    // 迟到补发判定必须早于提示词生成：pendingCount>0 却被放宽为 final 的回合，
    // 提示词也要同步改成「本次给最终汇报」，否则模型照常压制最终正文，标记与
    // 提示词自相矛盾（2026-11-19 补发抢跑 bug）。
    let text = "";
    let pendingCount: number | undefined;
    let rescueDue = false;
    try {
      rescueDue = this.qqFinalRescueDue(reportOwner);
      if (manager && typeof manager.reportPromptWithPending === "function") {
        const prompt = manager.reportPromptWithPending(batch, {
          pendingOwner: reportOwner,
          finalOverride: rescueDue,
        });
        text = prompt.text;
        pendingCount = prompt.pendingCount;
      } else {
        // 兼容只提供 reportPrompt 的假实现（测试夹具）：文本逐字节照旧，
        // pendingCount 在下面按同一口径用 list() 重算。
        text = manager?.reportPrompt(batch) ?? "";
      }
    } catch (error) {
      this.log.warn(`super agent: report prompt build failed: ${errorMessage(error)}`);
      buffer.release(reportKeys);
      return;
    }
    if (!text) {
      buffer.release(reportKeys);
      return;
    }
    if (pendingCount === undefined) {
      const owner = batch[0]?.session.mainSessionId ?? this.currentMainSessionId() ?? null;
      pendingCount = (manager?.list() ?? []).filter(
        (session) =>
          !isTerminalSuperStatus(session.status) && (session.mainSessionId ?? owner) === owner,
      ).length;
    }
    this.log.info(`super agent: queued report for ${batch.length} settled child session(s)`);
    // pendingCount=0 即「所有子会话都已结束」的汇总轮 —— 主 Agent 在这一轮
    // 给出最终完整汇报，是 QQ 最终回执应当采用的那一轮文本。
    //
    // **等待过久 ≠ 可以定终局**（2026-11-19 修复）：旧实现在 rescueDue 时把
    // 这一轮也标成 final，于是「awaiter 等过了阈值」被直接等价成「可以定终局」
    // —— 子会话明明还在跑，QQ 却先收到一条空正文兜底（22 字占位），任务被写成
    // 终态、awaiter 被摘掉，随后迟到的真实长正文再也投不出去（用户实测：QQ
    // 端只收到 22 字占位）。
    //
    // 现在：rescueDue 只用来**放宽提示词**（finalOverride=true，让模型这一轮
    // 就给结论），final 仍严格由 pendingCount===0 决定。放宽后的这一轮按
    // 「进度轮」处理 —— 正文经 deliverQqMainIntermediateText 转发，不写终态、
    // 不摘 awaiter；真正的最终汇报轮（pendingCount=0）到达时，那一轮的完整正文
    // 才会作为最终答复投递（逐字送达）。
    const rescuedRound = rescueDue && pendingCount !== 0;
    if (rescuedRound) {
      const activeChildren = this.qqHost.qqActiveChildrenCount(reportOwner);
      const waited = this.qqHost.qqFinalRescueWaitedMs(reportOwner);
      const taskIds = [...this.qqHost.qqMainFinalAwaiters.entries()]
        .filter(([, owner]) => owner === reportOwner)
        .map(([taskId]) => taskId);
      this.log.warn(
        `QQ 迟到补发：汇报轮 pendingCount=${pendingCount} activeChildren=${activeChildren} —— 仅放宽提示词（要结论），不定终局、不摘 awaiter`,
      );
      // 逐 task 记一条让路事件：事后能查清「哪个 QQ 任务等太久被放宽了」。
      for (const taskId of taskIds) {
        void this.appendQqArchiveEvent("task_final_rescue_deferred", taskId, {
          owner: reportOwner,
          reason: "report-round-relaxed",
          waited,
          activeChildren,
          pendingCount,
          defers: 0,
        });
      }
    }
    // 子会话汇报正文：二次转述（主 Agent 汇总轮）确为空时，兜底回给用户看的是
    // 子会话实际做了什么，而不是一句占位文案。取本批终态汇报的 summary（失败 /
    // 中断的取 error 或「已中断」），清洗在消费端做（见 sanitizeQqReportFallback）。
    const fallbackText = batch
      .map((entry) => {
        const summary = entry.report?.summary ?? entry.session.summary ?? "";
        const error = entry.session.error ?? "";
        return summary.trim() || error.trim() || (entry.report?.state === "dropped" ? "已中断" : "");
      })
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();
    // QQ task 级归属：把本批每个子会话的汇报正文归到派生它的主任务（见
    // qqTaskBySuperSession）。deliverQqMainFinalAnswer 据此逐 task 投递各自的
    // 结论，同会话多条消息不再共用一份汇总文本（重复卡根因）。只记仍在等的
    // 任务，避免给已收尾的任务留陈旧缓存。
    for (const entry of batch) {
      const taskId = this.qqHost.qqTaskBySuperSession.get(entry.session.id);
      if (!taskId || !this.qqHost.qqMainFinalAwaiters.has(taskId)) continue;
      const own = sanitizeQqReportFallback(
        entry.report?.summary ||
          entry.session.summary ||
          entry.session.error ||
          (entry.report?.state === "dropped" ? "已中断" : ""),
      );
      if (!own) continue;
      const prev = this.qqHost.qqTaskFinalText.get(taskId);
      this.qqHost.qqTaskFinalText.set(taskId, prev ? `${prev}\n${own}` : own);
    }
    // 本批是否全是「被中断」的子会话（用户点取消 / 面板关闭）。这类通知是
    // 宿主注入的纯 host-state，不是新结论 —— 一次取消会连带状态上报 + 动作
    // 回执两条通知，各自的 assistant 转述若都转发到 QQ 就是重复投递。
    const allDropped = batch.length > 0 && batch.every((entry) => entry.report.state === "dropped");
    const reportItem: PendingSuperReportPrompt = {
      mainSessionId: reportOwner,
      text,
      // 只有「所有子会话都已结束」的汇总轮才是 final：迟到补发（rescueDue）
      // 只放宽提示词，绝不把这一轮变成定终局的最终回执（2026-11-19 修复）。
      final: pendingCount === 0,
      fallbackText,
      suppressQqProgress: allDropped,
      reportKeys,
    };
    // 方案 B：同一次 agent cancel 的 dropped 上报不单独成为一轮 —— 主会话此前
    // 已收到动作回执，再收一条状态上报就会对同一 cancel 回答两次（用户实测）。
    // 只拦「由 runSuperActions 产生（必带动作回执）」的整批 agent 取消；
    // QQ 指令侧 cancel（没有动作回执）与非 agent 取消照旧走汇报轮。
    const mergeIntoReceipt =
      allDropped &&
      batch.every(
        (entry) =>
          entry.session.interruptedBy === "agent" &&
          this.agentCancelWithReceiptIds.has(entry.session.id),
      );
    if (mergeIntoReceipt) {
      this.pendingAgentCancelMerges.push({
        item: reportItem,
        entries: batch,
        sessionIds: batch.map((entry) => entry.session.id),
        at: Date.now(),
      });
      this.log.info(
        `super agent: held ${batch.length} agent-cancel report(s) for merging into the action receipt`,
      );
    } else {
      this.pendingSuperReportPrompts.push(reportItem);
    }
    this.ensureSuperHeartbeat();
    // 用户按过停止时补一次常驻「继续处理」提示：此后才结束的子会话此前不会
    // 触发 announceDeferredAutoTurns（那时待处理数还是 0），于是恢复只剩「下
    // 条消息」这一个解除点。这里让新到的汇报也点亮那个可点动作。
    if (this.autoTurnsHeld()) this.announceDeferredAutoTurns();
    void this.drainSuperAutoTurns();
  }


  /**
   * 已归档（被清理 / 合并释放）子会话的迟到结论：以可关闭的 `sticky` 提示落到
   * 看板，明确标注来源已不存在，绝不伪装成活跃子会话的实时汇报或 hidden 回合
   * （那会伪造用户气泡 / 会话标题 / checkpoint）。
   *
   * 每条结论单独一条提示并截断到摘要长度，避免长 summary 把 toast 栈撑爆；
   * 文案只含本地标题与汇报正文，不含 id / 路径 / 凭据。
   */
  announceArchivedLateReports(entries: readonly SuperReportEntry[]): void {
    if (entries.length === 0 || this.disposed) return;
    for (const entry of entries) {
      const summary = entry.report.summary.trim() || vscode.l10n.t("（该汇报没有正文）");
      const clipped =
        summary.length > SUPER_ARCHIVED_REPORT_MAX_CHARS
          ? `${summary.slice(0, SUPER_ARCHIVED_REPORT_MAX_CHARS)}…`
          : summary;
      this.store.sendToast(
        "info",
        vscode.l10n.t("已归档超流体「{0}」的迟到结论（该超流体已被清理，主会话未能在当时收取）：{1}", entry.session.title, clipped),
        { sticky: true },
      );
    }
  }


  /**
   * Deliver queued child reports to the main session, one turn at a time.
   *
   * Only runs when the main session is free. The merge queue owns the same
   * single lane (a merge request is also a main-session turn), so the two are
   * mutually exclusive — otherwise two concurrent `sendPrompt` calls would
   * interleave on one ACP session.
   *
   * 逐个即时汇报：每个终态子会话各占一轮（不是一批合并成一轮）—— 后续
   * 子会话结束时会再排一轮。
   *
   * 只投**归属当前主会话**的汇报：排队期间用户可能切了会话，A 的汇报不能
   * 投进 B 的对话。
   */
  async drainSuperReports(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    // Stop means "stop": do not auto-start the next child-report turn the
    // instant the cancelled one settles (that is what made a single click look
    // ineffective and users click several times). Reports stay queued — the
    // user's next message releases the hold — so nothing is lost.
    if (this.autoTurnsHeld()) return;
    this.superReportRunning = true;
    try {
      while (this.pendingSuperReportPrompts.length > 0) {
        if (this.disposed) return;
        // The loop may already be running when the user presses Stop on the
        // report turn it just delivered — re-check every iteration, or the
        // next queued report would start the instant this one settles.
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 合并子会话在**主仓工作区**里跑 git merge：主会话这时若也去改主仓
        // 的文件，两边会互相踩（合并提交可能卷进主会话的半成品改动）。
        // 所以有合并子会话在跑（或还有排队的合并请求）时先让合并走完。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        // 只投当前主会话的汇报：别的会话的汇报等用户切过去再投（串台）。
        const owner = this.currentMainSessionId();
        const index = this.pendingSuperReportPrompts.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingSuperReportPrompts[index]!;
        this.clearSuperWaitHeartbeat();
        this.log.info("super agent: delivering the settled child report as a fresh main-session turn");
        // R2 迟到补发缓存：记下本轮开始前的可见文本锚点，回合结束后提取本轮
        // 新增的 assistant 文本。正常 final 投递不受影响；仅当 QQ  awaiter 迟到
        // 补发时才用到它（而没有真实正文时由兜底文案接管）。
        const visibleBefore = this.store.getState().blocks.filter(
          (block) => block.kind === "text" && !block.system,
        );
        const reportAnchor = visibleBefore[visibleBefore.length - 1];
        const reportAnchorId = reportAnchor?.id;
        const reportAnchorLen = reportAnchor?.kind === "text" ? reportAnchor.text.length : 0;
        const reportTextBefore = visibleBefore.length;
        // 子会话汇报正文（report.summary）作为「二次转述确实为空」时的兜底：
        // 先清洗（去协议标记 / 脱敏 / 截断），预置进 R2 缓存，并透传给 sendPrompt
        // 的最终回执收尾。宿主本就持有这段正文，绝不只发一句占位文案。
        const cleanFallback = sanitizeQqReportFallback(item.fallbackText);
        if (cleanFallback && owner && this.qqHost.qqFinalRescueOwnerPending(owner)) {
          this.qqHost.qqFinalRescueText.set(owner, cleanFallback);
          // 独立缓存：不会被下面非 final 进度轮的 reportTurnText 覆盖，硬上限
          // 补发时即使缓存正文为空也能回真实汇报正文（2026-11-19 补发抢跑 bug）。
          this.qqHost.qqReportFallbackText.set(owner, cleanFallback);
        }
        const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
          delegateOnBusy: false,
          hidden: true,
          // **internal：纯内部回灌，不附加看板摘要。**
          //
          // 汇报回合的正文已经自带这一批子会话的终态（[子会话状态上报] + 逐条
          // 汇报 + 「还有 N 个在跑」），而 sendPrompt 在每个主会话回合开头还会
          // 再注入一份**完整看板摘要**（id / 状态 / 分支 / 集成结果 / 派发
          // 提示 / 管理动作说明，约 1,000 tokens）。逐个即时汇报意味着子会话
          // 结束一个就回灌一次 —— 这份额外开销按回合数线性叠加，而主会话每
          // 一轮还要重付全部历史，正是 token 过度消耗的主要来源。
          //
          // internal 只影响「这一轮要不要额外挂看板摘要」以及会话改名 / 快照
          // （hidden 已经覆盖后两者），**不影响这一轮是不是真实的主会话回合**
          // —— 汇报仍然是主会话的一次真实 prompt（模型在自己的上下文里读到
          // 结果并接着推进）。
          internal: true,
          // 这一轮是「主会话汇报子会话结果」：收尾时用 superReport 事件 +
          // done 音（与单个子会话收尾的 childDone + child 音区分开）。
          reportTurn: true,
          // pendingCount=0 的汇总轮：收尾时把这一轮 assistant 文本作为 QQ
          // 任务的真正最终答复回传（中途进度汇报轮不带此标记）。
          finalReport: item.final === true,
          // 汇总轮二次转述为空时，用子会话真实汇报正文兜底（见 deliverQqMainFinalAnswer）。
          finalFallbackText: item.fallbackText,
        });
        if (!started) {
          // 回合没跑起来（主会话被别的回合占着）：这条汇报**留在队列里**，
          // 等空闲时重投 —— 汇报丢了主会话就永远读不到自己孩子的结果。
          break;
        }
        const pos = this.pendingSuperReportPrompts.indexOf(item);
        if (pos !== -1) this.pendingSuperReportPrompts.splice(pos, 1);
        // 本轮 assistant 正文：只含 agent 的 text 块（thought / tool / diff /
        // 子会话卡都不在其中），与最终结果取文本同口径。
        const reportTurnText = this.captureQqReportTurnText(
          reportAnchorId,
          reportTextBefore,
          reportAnchorLen,
        );
        // G2（回合真正 settle 后 confirm）：await sendPrompt 已等整轮结束，但
        // `stopReason==="cancelled"`（用户 Stop）也会返回 true —— 那轮主会话并
        // 没有真正转述子会话结果。只有「没被 Stop 压住 && 没在 error」才算真正
        // settle，立即 confirm；否则转入 delivered-unacked 账本，心跳复核重投，
        // 确保回合中途 Stop / 失败时汇报不丢。与 QQ 兜底缓存共用同一真实正文。
        const genuinelySettled =
          this.store.getState().status !== "error" && !this.autoTurnsHeld();
        if (genuinelySettled) {
          if (item.reportKeys?.length) {
            this.pendingSuperReports.get(item.mainSessionId ?? "")?.confirm(item.reportKeys);
          }
        } else {
          this.markReportDelivered(item, reportTurnText);
        }
        // R2：缓存本轮正文供迟到补发复用（只在该会话仍有 awaiter 时才有意义）。
        if (reportTurnText && owner && this.qqFinalRescueOwnerPending(owner)) {
          this.qqFinalRescueText.set(owner, reportTurnText);
        }
        // 中间正文轮同步：非汇总汇报轮的 assistant 正文作为进度转给该会话所有
        // 等最终答复的 QQ 任务。汇总轮（final=true）绝不在这里转发 —— 它的正文
        // 由 sendPrompt 收尾的 deliverQqMainFinalAnswer 作为最终结果投递。
        //
        // 来源判别（2026-11-19 重复转发修复）：本批若全是「被中断」的子会话
        // （用户点了取消 / 面板关闭），这条 [子会话状态上报] 是宿主注入的纯
        // host-state 通知，主 Agent 对它的确认 / 复述不是给用户的新结论 ——
        // 一次取消会连带 interrupted 状态上报 + cancel 动作回执两条通知，旧实现
        // 把每条的 assistant 正文都当进度转发，QQ 上连续收到多条相近回复。
        // 这类中断通知回合只缓存正文供迟到补发，不再直接投递；正常的「有子会话
        // 完成」进度汇报仍照常转发（不削弱被节流中间正文补发等既有修复）。
        if (!item.final && reportTurnText && item.suppressQqProgress !== true) {
          void this.deliverQqMainIntermediateText(owner, reportTurnText);
        }
        // 这一轮失败了（端点 / 内核报错）：别在心跳里连续喂下一批，留给用户
        // 处理错误后自然的下一轮。
        if (this.store.getState().status === "error") break;
      }
    } catch (error) {
      this.log.warn(`super agent report delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
      // 汇报已经投出去（或投失败）：重算忙碌标记 —— 还有子会话在跑时面板保持
      // 忙碌态，全部结束且汇报已投出时才回到 idle。
      this.syncSuperWaitingState();
    }
  }

  /**
   * G2 handoff：`sendPrompt` 起来了，但回合**还没确认真正 settle**。把汇报转入
   * delivered-unacked 账本 —— 缓冲键保持 in-flight（不 confirm），汇报正文与 QQ
   * 兜底缓存共用一份。回合中途 Stop / 失败时报告不会「投出去即丢」。
   */
  markReportDelivered(
    item: PendingSuperReportPrompt,
    _reportTurnText: string,
    kind: "report" | "receipt" = "report",
  ): void {
    const keys = item.reportKeys;
    if (!keys || keys.length === 0) {
      // 无去重键（测试桩 / 老调用）：没有可追踪的缓冲项，维持旧语义直接了结。
      return;
    }
    const key = keys.join(",");
    const prev = this.reportDeliveryUnacked.get(key);
    this.reportDeliveryUnacked.set(key, {
      kind,
      item,
      attempts: (prev?.attempts ?? 0) + 1,
      at: Date.now(),
    });
    // 兜底缓存与 :2317-2340 统一口径：真实汇报正文先落 QQ 缓存，确认 / 重投
    // 两条路径都不会丢内容。
    const owner = item.mainSessionId ?? "";
    const cleanFallback = sanitizeQqReportFallback(item.fallbackText);
    if (cleanFallback && owner && this.qqHost.qqFinalRescueOwnerPending(owner)) {
      this.qqHost.qqFinalRescueText.set(owner, cleanFallback);
      this.qqHost.qqReportFallbackText.set(owner, cleanFallback);
    }
  }

  /** delivered-unacked 汇报重投的 staleness 阈值（心跳复核，测试可注入小值）。 */
  reportRedeliveryMs = 6_000;

  /**
   * 心跳复核 delivered-unacked：这些汇报的上一轮 sendPrompt 被 Stop / error 打断，
   * 主会话并没有真正转述。主会话恢复（idle、未 Stop、非 replay、车道空闲）后
   * 重新入投递队列重投，避免汇报在中途失败时「投出去即丢」。
   *
   * - Stop 仍压住 → 留在账本与缓冲，等用户下一次消息解除压制；
   * - streaming / error → 留在账本，下一拍再看；
   * - idle 且未到重投阈值 → 保留 in-flight 标记、重新入队重投（同一份汇报
   *   仍然只会在队列里出现一次）；
   * - 达 maxReportDeliveryAttempts → 兜底 confirm（QQ 兜底正文已保留真实结论）。
   */
  reconcileReportDelivery(): void {
    if (this.disposed || this.reportDeliveryUnacked.size === 0) return;
    // Stop 仍压住：汇报留在账本与缓冲里，等用户下一次消息解除压制 —— 此刻既不
    // 重投（Stop 期间不该自动开新回合）也不 confirm（没真正送达）。
    if (this.autoTurnsHeld()) return;
    const state = this.store.getState();
    const canRedeliver =
      state.status === "idle" && !this.historySyncBusy && this.mainLane === null;
    if (!canRedeliver) return; // 回合还在 streaming / error：等下一拍
    const now = Date.now();
    let requeued = false;
    for (const [key, rec] of [...this.reportDeliveryUnacked]) {
      const buffer = this.pendingSuperReports.get(rec.item.mainSessionId ?? "");
      if (now - rec.at < this.reportRedeliveryMs) continue; // 宽限期内先等
      if (rec.attempts >= this.maxReportDeliveryAttempts) {
        // 兜底：畸形汇报不能永久卡住缓冲；QQ 兜底正文已保留真实结论。
        buffer?.confirm(rec.item.reportKeys ?? []);
        this.reportDeliveryUnacked.delete(key);
        this.log.warn(
          `super agent: 汇报重投 ${rec.attempts} 次仍未送达，确认出缓冲（QQ 兜底正文已保留）`,
        );
        continue;
      }
      // 回合已恢复：**保留 in-flight 标记**，重新入投递队列重投。
      //
      // 刻意**不** release：这条汇报此刻仍然「已交给投递队列」（下面就把同一个
      // item 重新 push 进 pendingSuperReportPrompts）。一旦 release，下一拍心跳
      // 里的 settleSuperReportsIfReady 会用 drainSettled 把缓冲里**同一条**
      // 汇报再取一次 → 队列里出现两条同一条汇报的条目 → 同一份汇报被当成两轮
      // hidden prompt 投进主会话（每轮一次主会话的完整预填充 + 历史）。
      // in-flight 标记就是这件事的幂等键（键 = 子会话 id : attempt，见
      // superReportKey）；真正投成功时由 confirm 一次性清掉。
      this.reportDeliveryUnacked.delete(key);
      // 方案 B：合并了上报的回执必须回到回执队列重投（文本里已含 dropped
      // 状态）；若错放回汇报队列，Stop 后再投就又变成两条独立消息。
      if (rec.kind === "receipt") {
        this.pendingSuperActionReceipts.push(rec.item as PendingSuperActionReceipt);
      } else {
        this.pendingSuperReportPrompts.push(rec.item);
      }
      requeued = true;
    }
    if (requeued) {
      this.ensureSuperHeartbeat();
      void this.drainSuperAutoTurns();
    }
  }


  /**
   * The main session can accept a host-driven turn right now.
   *
   * Mirrors the gate `sendPrompt` applies, evaluated BEFORE anything is
   * shifted off a queue so a rejected turn can never swallow a report.
   *
   * 车道也必须在空闲状态：用户回合还在准备阶段（状态还没翻成 streaming）
   * 时，汇报回合不能插进来 —— 那是同一时刻第二个回合跑在同一个 ACP 会话上。
   */
  mainSessionFree(): boolean {
    const state = this.store.getState();
    return (
      !!state.sessionId &&
      !state.initializing &&
      state.status !== "streaming" &&
      !state.replaying &&
      !this.historySyncBusy &&
      this.mainLane === null
    );
  }


  /**
   * 用户的停止是否还压着宿主自动回合（子会话汇报 / 被改道消息补投）。
   *
   * 只看**当前主会话**：A 会话被停止不该影响 B 会话的汇报投递。解除点是用户
   * 下一次主动发消息（sendPrompt / regenerate），此前排队内容一条不丢。
   */
  autoTurnsHeld(): boolean {
    return this.autoTurnsStoppedFor !== null && this.autoTurnsStoppedFor === this.currentMainSessionId();
  }


  /**
   * 当前主会话被压住 / 待投递的自动回合数（子会话汇报 + 被改道用户消息补投）。
   * `announceDeferredAutoTurns` 的提示数量、`syncSuperWaitingState` 写给 webview
   * 的 `superPendingCount` 与状态栏文案共用这一处口径 —— 分开数迟早会漂移。
   */
  pendingAutoTurnCount(): number {
    const owner = this.currentMainSessionId();
    return (
      this.pendingSuperReportPrompts.filter((item) => item.mainSessionId === owner).length +
      this.pendingDelegatedUserTurns.filter((item) => item.mainSessionId === owner).length
    );
  }


  /**
   * Keep the heartbeat alive while any Super Agent work is outstanding.
   *
   * Without it, a child finishing while the main session is replaying history
   * (or right after a failed turn) would leave its report stranded: nothing
   * else fires the delivery hook again.
   */
  ensureSuperHeartbeat(): void {
    if (this.disposed || this.superHeartbeatTimer) return;
    const timer = setInterval(() => this.superHeartbeatTick(), SUPER_HEARTBEAT_MS);
    // Never keep the extension host alive just for the heartbeat.
    if (typeof timer.unref === "function") timer.unref();
    this.superHeartbeatTimer = timer;
  }


  /**
   * 5 条宿主自动回合队列的**统一仲裁点**。
   *
   * 心跳 / 回合收尾 / 压制解除都只调它，不再各自按固定顺序 fire-and-forget 5
   * 个 drain：每一拍只仲裁**一条**队列并把轮转游标挪到下一位；被选中的队列
   * 仍沿用自己原有的顺序投递语义（一次可投完自己队列里当前可投的几条）。于是：
   *  - **明确优先级**：数组先后即投递先后（见 {@link SUPER_AUTO_TURN_PRIORITY}）；
   *  - **不饿死**：卡在 error / Stop / 主会话忙的高优先级队列只占一拍，下一拍
   *    轮到别人 —— 不再把「用户下次发消息」当成唯一恢复点；
   *  - **不破坏单回合不变量**：每个 drain 内部照旧同步申领 `superReportRunning`，
   *    `mainLane` 仍是「同一 ACP 会话同时只有一个回合」的唯一保证；这里只决定
   *    「先叫谁」，一条回合在飞时其余 drain 仍被重入锁挡在门外。
   *
   * 合并队列不带主会话归属、用独立的 `superMergeRunning` 锁，因此同样由它仲裁
   * （选中时让它的既有互斥门控生效），但不改变合并串行执行、主工作区单一窗口
   * 的纪律。
   */
  async drainSuperAutoTurns(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    const order = SuperAgentHost.SUPER_AUTO_TURN_PRIORITY;
    const owner = this.currentMainSessionId();
    for (let i = 0; i < order.length; i++) {
      if (this.disposed || this.superReportRunning) return;
      const slot = (this.superAutoTurnCursor + i) % order.length;
      const kind = order[slot]!;
      if (!this.superAutoTurnHasWork(kind, owner)) continue;
      // 给过机会就往后挪：卡住的队列（error / Stop 压住 / 主会话忙 / 合并
      // 互斥）下一拍不再排在最前，其余队列因此有稳定的唤醒机会。
      this.superAutoTurnCursor = (slot + 1) % order.length;
      // 派发入口从统一映射表取；与 superAutoTurnHasWork 同一份 kind → 行为绑定。
      const handler = SuperAgentHost.SUPER_AUTO_TURN_HANDLERS[kind];
      await handler.drain(this);
      return; // 一条队列一拍：其余队列交给下一拍 / 回合收尾的再次仲裁。
    }
  }


  /**
   * 某条自动回合队列此刻是否有「属于当前主会话」的待投递项。
   *
   * 只做轻量非空判断（真正的门控 —— mainSessionFree / error / Stop / 合并互斥
   * —— 仍留在各 drain 里）。判空规则与派发入口共用 SUPER_AUTO_TURN_HANDLERS，
   * 不再各写一份 switch；合并队列不带主会话归属，只看非空。
   */
  superAutoTurnHasWork(kind: SuperAutoTurnKind, owner: string | null): boolean {
    // 脏 kind（越过类型约束的调用方）按原来的无 default switch 处理：无工作。
    const handler: SuperAutoTurnHandler | undefined = SuperAgentHost.SUPER_AUTO_TURN_HANDLERS[kind];
    return handler ? handler.hasWork(this, owner) : false;
  }


  superHeartbeatTick(): void {
    if (this.disposed) {
      this.stopSuperHeartbeat();
      return;
    }
    // 心跳是 fire-and-forget 的 interval 回调：任何一步同步抛错都必须吞掉，
    // 否则下面的 auto-stop 判断不执行，interval 会永久存活（且错误只在
    // console 里一闪而过）。drain 自身都有 catch，这里主要护住
    // refreshSuperWaitHeartbeat / syncSuperWaitingState 这类同步 UI 刷新。
    try {
      this.deps.refreshSuperWaitHeartbeat();
      // 活性采集（批次2A 项3）：每拍从管理器只读快照刷新「最近活动」时间戳投影。
      // 真正在动的证据只来自 session/update（manager.touchWatchdog），心跳这里
      // 只搬运，不伪造时间戳。
      const manager = this.superAgent;
      if (manager && typeof manager.activitySnapshot === "function") {
        const live = new Set<string>();
        for (const snap of manager.activitySnapshot()) {
          this.superLastActivity.set(snap.id, snap.lastActivityAt);
          live.add(snap.id);
        }
        for (const id of this.superLastActivity.keys()) {
          if (!live.has(id)) this.superLastActivity.delete(id);
        }
      }
      // G2：每拍复核 delivered-unacked —— 回合 settle 才 confirm，中途 Stop /
      // 失败则重投，避免汇报在「sendPrompt 起来了但回合没跑完」的窗口里丢失。
      this.reconcileReportDelivery();
      void this.drainSuperAutoTurns();
    } catch (error) {
      this.log.warn(`super agent heartbeat tick failed: ${errorMessage(error)}`);
    }
    if (!this.hasSuperWork()) this.stopSuperHeartbeat();
  }

  /** Outstanding Super Agent work (queued turns, or children still running). */

  hasSuperWork(): boolean {
    if (this.disposed) return false;
    if (this.pendingSuperReportPrompts.length > 0) return true;
    // delivered-unacked：汇报还在等回合真正 settle / 重投，心跳必须继续。
    if (this.reportDeliveryUnacked.size > 0) return true;
    // 待投递的动作回执也算「还有活儿」：心跳停了回执就永远投不出去，主会话
    // 于是不知道自己刚发的动作生效没有（→ 重复发同一个动作）。
    if (this.pendingSuperActionReceipts.length > 0) return true;
    // 暂存的 agent-cancel 上报在等同批回执入队：缓冲里虽是 in-flight，也必须
    // 续命到回执把它 confirm（或被 Stop 打断后走 unacked 重投）。
    if (this.pendingAgentCancelMerges.length > 0) return true;
    // 待补投的「被改道用户消息」同样是欠着主会话的一轮：心跳停了它就永远
    // 投不出去，那条消息又会像修复前一样在主会话里丢失。
    if (this.pendingDelegatedUserTurns.length > 0) return true;
    // 排队的参数纠错提示也是一轮欠账：模型不知道自己的调用为何失败，就会
    // 在下一轮继续重复同一份错误载荷。
    if (this.pendingSuperToolCallCorrections.length > 0) return true;
    if (this.pendingSuperMerges.length > 0) return true;
    // 汇报已交上来但来源子会话还没终态：它的汇报还欠着主会话，心跳必须
    // 继续跑，否则既没有汇报也没有忙碌态刷新。
    // 缓冲按归属分桶，**任何**桶有欠账都要续命（用户随时可能切到那个
    // 会话，汇报得能投出去）。
    for (const buffer of this.pendingSuperReports.values()) {
      if (buffer.size > 0) return true;
    }
    return (this.store.getState().superSessions ?? []).some(
      (session) => !isTerminalSuperStatus(session.status),
    );
  }


  /**
   * 是否还有子会话没进入终态。
   *
   * 主会话回合先结束而子会话仍在跑时，对话里没有它们的结果，此时提炼
   * 「下一步建议」/「自动记忆」只能基于残缺内容；子会话全部结束后宿主会以
   * hidden 汇报 prompt 重新唤醒主会话，那一轮自然补上。因此 runTurnFollowup
   * 用这里跳过 conversation-derived 的两项（标题不受影响）。
   */
  hasRunningSuperSessions(): boolean {
    return (this.store.getState().superSessions ?? []).some(
      (session) => !isTerminalSuperStatus(session.status),
    );
  }


  stopSuperHeartbeat(): void {
    if (this.superHeartbeatTimer) {
      clearInterval(this.superHeartbeatTimer);
      this.superHeartbeatTimer = null;
    }
    this.clearSuperWaitHeartbeat();
  }


  /**
   * 主会话此刻是否还在等子会话的结果。
   *
   * 五种「还在等」：
   *  ①还有子会话没进终态；
   *  ②子会话已终态但还没把汇报交给宿主（终态与汇报交接之间隔着代提交与
   *    自动合并的 git 操作，可能好几秒）；
   *  ③汇报缓冲里还有欠账（有汇报，但来源子会话还没终态 —— 它一结束就会
   *    被交回主会话）；
   *  ④汇报提示词已备好、还在队列里等主会话空闲；
   *  ⑤汇报正在投进主会话（那一轮是 hidden prompt，status 会变 streaming）。
   *
   * 只看子会话状态是不够的：汇报真正投出去之前，「新会话」都该锁住 ——
   * 否则用户会在这个窗口点它，把排队里的汇报落到已被替换的会话上（面板上
   * 此时只有看板计数能看出还在等，顶栏不再有忙碌 chip）。
   *
   * **只看当前主会话的子会话**：别的会话的子会话在跑（或者它的汇报还欠着）
   * 不该让当前会话显示忙碌 —— 当前会话并不在等它们，它们的汇报会等用户
   * 切过去再投。
   */
  superWaitingForReports(liveChildren?: SuperSessionUi[]): boolean {
    const owner = this.currentMainSessionId();
    if (this.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner)) return true;
    if (this.superReportRunning) return true;
    const buffer = this.pendingSuperReports.get(owner ?? "");
    if (buffer && buffer.size > 0) return true;
    // 只看**活着的**子会话：归档里的历史子会话早就终态，也永远不会再汇报，
    // 算进来会让忙碌态永远关不掉。
    const live = liveChildren ?? this.superAgent?.list() ?? [];
    for (const session of live) {
      if (!this.superBelongsToCurrentMain(session)) continue;
      if (!isTerminalSuperStatus(session.status)) return true;
      if (!this.superReportedChildIds.has(session.id)) return true;
    }
    return false;
  }


  /**
   * 把「正在等子会话」这个忙碌标记同步给 webview。
   *
   * 等待期主会话的 `status` 仍然是 "idle" —— 用户还要能发消息并由主会话响应，
   * 所以不能借用 "streaming"（那会把用户消息派发成子会话）。但面板必须把
   * 「新会话」锁住：等待期新建会话会让排队里的汇报落到已被替换的会话上。
   * 顶栏不再为它渲染忙碌 chip（忙碌信号由转录底部浮动 pill 与子会话看板计数
   * 承担）。
   *
   * 例外：用户按了「停止」压住汇报时（`superHeld`），「新会话」必须放行 ——
   * 否则用户点完停止就再无出路（唯一的解锁是发下一条消息，而那条一次性 toast
   * 转瞬即逝），面板看起来就是永久卡住。状态栏也不再把压住态谎报成「生成中」。
   */
  syncSuperWaitingState(): void {
    // 子会话被清理后它的 id 不再有意义 —— 顺手剪掉，别让集合无限增长。
    // 剪的时候看**全部**活子会话：别的会话的孩子也在这集合里（汇报是按
    // 归属记的），按当前会话剪会把它们的「已汇报」标记误删。
    const live = this.superAgent?.list() ?? [];
    const liveIds = new Set(live.map((session) => session.id));
    for (const id of [...this.superReportedChildIds]) {
      if (!liveIds.has(id)) this.superReportedChildIds.delete(id);
    }
    this.store.setSuperWaiting(
      this.superWaitingForReports(live),
      this.autoTurnsHeld(),
      this.pendingAutoTurnCount(),
    );
    this.syncChildSettledAnnouncements(live);
  }


  /**
   * 子会话逐个完成提示：每个子会话**各自**从非终态迁移到终态
   * （completed / failed / cancelled）时提示一次。
   *
   * 为什么放弃聚合判定（旧的「非终态数 >0 掉到 0 → 子会话已全部结束」）：
   *  ①聚合把多个子会话的收尾混成一次 —— 用户要的是「每个子会话各提示一次」，
   *    两个子会话先后完成应各响一声，而不是等到最后一个才响。
   *  ②聚合无法区分「刚刚结束」与「早就结束」：恢复归档、刚打开看板时非终态数
   *    本来就是 0，任何额外一次 sync 都可能误报一个过期事实。
   *  ③「全部结束」的文案与用户回合完成共用 turnDone 事件和 done 音，导致
   *    「子会话干完」与「主会话干完」在通知通道上无法区分（2026-11-16 需求）。
   *
   * 判据用**全部活子会话**（不分主会话）：看板对活着的子会话一律可见，提示
   * 与用户能看到的内容保持一致。状态记录按 childId 保存，子会话被清理后
   * 顺手剪掉，避免集合无限增长。
   */
  syncChildSettledAnnouncements(live: SuperSessionUi[]): void {
    if (this.disposed) return;
    const liveIds = new Set(live.map((session) => session.id));
    for (const id of [...this.superLastStatus.keys()]) {
      if (!liveIds.has(id)) this.superLastStatus.delete(id);
    }
    for (const session of live) {
      const previous = this.superLastStatus.get(session.id);
      this.superLastStatus.set(session.id, session.status);
      // 首次看到它（恢复归档 / 刚打开看板）：这不是「刚刚结束」，是过期事实。
      if (previous === undefined) continue;
      // 上次就已经终态：重复 sync（心跳每 1.5s 一次）不能重复提示。
      if (isTerminalSuperStatus(previous)) continue;
      // preparing / running / awaiting_input 都还不是完成。
      if (!isTerminalSuperStatus(session.status)) continue;
      this.announceChildSettled(session);
    }
  }

  /** 一个子会话刚刚收尾：按终态分别给文案（事件与音色由 announceChildDone 统一）。 */

  announceChildSettled(session: SuperSessionUi): void {
    const title = session.title;
    if (session.status === "completed") {
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已完成", title));
    } else if (session.status === "failed") {
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已失败", title));
    } else {
      // 终态只剩 cancelled（isTerminalSuperStatus 已过滤）。
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已中断", title));
    }
  }


  /**
   * The 「waiting for children」 pill.
   *
   * The main turn is over while children still run, so the panel would look
   * idle/stopped even though work continues. A persistent, display-only toast
   * states that the host is waiting and will continue on its own. Refreshed by
   * the heartbeat; re-sent only when the live/awaiting counts change (progress
   * frames arrive continuously and must not churn the toast stack).
   *
   * 计数只算**当前主会话**的子会话：别的会话的孩子在跑，当前会话并不在等
   * 它们（它们的汇报会等用户切过去再投）—— 混在一起数会让提示与提示词里的
   * pendingCount 对不上当前会话。
   */
  refreshSuperWaitHeartbeat(): void {
    if (this.disposed) return;
    // 子会话被清理后「所有子会话都终态」可能已经成立、却再没有人来触发取
    // 批次（它的 onReport 不会再来）—— 心跳与看板变化时补一次重算。
    this.settleSuperReportsIfReady();
    // 忙碌标记跟常驻提示同源：心跳每 1.5s 刷一次，等待期面板一直是忙碌态。
    this.syncSuperWaitingState();
    const sessions = this.store.getState().superSessions ?? [];
    const live = sessions
      .filter((session) => this.superBelongsToCurrentMain(session))
      .filter((session) => !isTerminalSuperStatus(session.status));
    const awaiting = live.filter((session) => session.status === "awaiting_input").length;
    if (live.length === 0 || !this.mainSessionFree()) {
      this.clearSuperWaitHeartbeat();
      return;
    }
    // 用户按过停止：自动投递被压住，提示必须如实改写 —— 此时还写「会自动
    // 继续」就是在骗人（用户会盯着面板等一个永远不会来的自动回合）。
    const held = this.autoTurnsHeld();
    const key = `${live.length}:${awaiting}:${held ? "held" : "auto"}`;
    if (key === this.superWaitToastKey && this.superWaitToastId !== null) return;
    this.clearSuperWaitHeartbeat();
    const message = held
      ? awaiting > 0
        ? vscode.l10n.t(
            "已停止；{0} 个超流体仍在运行（其中 {1} 个等待你的回答），发送下一条消息后继续收取汇报",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "已停止；{0} 个超流体仍在运行，发送下一条消息后继续收取汇报",
            live.length,
          )
      : awaiting > 0
        ? vscode.l10n.t(
            "正在等待 {0} 个超流体汇报（其中 {1} 个等待你的回答），完成一个即汇报一个，会自动继续",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "正在等待 {0} 个超流体汇报（完成一个即汇报一个，会自动继续）",
            live.length,
          );
    this.superWaitToastKey = key;
    this.superWaitToastId = this.store.sendToast("info", message, {
      persistent: true,
      displayOnly: true,
    });
  }


  clearSuperWaitHeartbeat(): void {
    if (this.superWaitToastId !== null) {
      this.store.dismissToast(this.superWaitToastId);
      this.superWaitToastId = null;
    }
    this.superWaitToastKey = null;
  }

  /** Route a Super Agent action from the board. */

  async handleSuperAgentAction(msg: Extract<WebviewToHost, { type: "superAgent" }>): Promise<void> {
    // "stuck"（判定卡死）已正式进入共享 superAgent.action 联合，和 cancel /
    // retry 等动作一样由 shared/ 契约覆盖，宿主侧不再做任何类型扩展。
    // 接管期间本机侧不执行任何看板动作。webview 已把看板与待答条整体 inert，
    // 但那是 UI 层的门 —— portal 出来的浮层、旧快照里残留的按钮、以及任何
    // 绕开 UI 的通道都能把消息发到这里。远端正在推进的流程不能被本机的
    // 中断 / 合并 / 清理打断，所以宿主侧必须有这道硬门；拒绝时如实提示原因
    // （不是静默丢弃，否则用户会以为点了没反应）。
    if (this.qqHost.qqTakeoverActive) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("远程接管中，本机的超流体操作已冻结"),
      );
      return;
    }
    const manager = this.deps.getSuperAgent();
    if (!manager) return;
    const action = msg.action;
    switch (action) {
      case "transcript": {
        if (!msg.sessionId) return;
        this.postToWebview({
          type: "superTranscript",
          sessionId: msg.sessionId,
          from: 0,
          blocks: manager.transcriptBlocks(msg.sessionId),
        });
        break;
      }
      case "stuck": {
        // 用户主动判定卡死：先记 timeout 诊断（用户判定），再按 user 来源中断。
        if (!msg.sessionId) return;
        await this.judgeSuperStuck(msg.sessionId);
        break;
      }
      case "cancel": {
        if (!msg.sessionId) return;
        const outcome = await manager.cancel(msg.sessionId, "user");
        // 与 cancelAll / cleanup / retry 一致，单个中断也要有可见回执。
        // 按 SuperCancelOutcome 的真实 reason 区分文案：幂等重复（已终态）
        // 不是失败，但要如实告诉用户「无需中断」，避免以为刚才那下没生效。
        if (outcome.reason === "cancelled") {
          this.store.sendToast("info", vscode.l10n.t("已中断超流体"));
        } else if (outcome.reason === "already-terminal") {
          this.store.sendToast("info", vscode.l10n.t("这个超流体已经结束了，不用再中断"));
        } else {
          this.store.sendToast("warning", vscode.l10n.t("该超流体不存在或已被清理"));
        }
        break;
      }
      case "cancelAll": {
        const count = await manager.cancelAll("user");
        this.store.sendToast("info", vscode.l10n.t("已中断 {0} 个超流体", count));
        break;
      }
      case "respond": {
        if (!msg.sessionId) return;
        const ok = manager.respond(msg.sessionId, { answers: msg.answers });
        if (!ok) this.store.sendToast("warning", vscode.l10n.t("该超流体没有待处理的请求"));
        break;
      }
      case "cleanup": {
        if (!msg.sessionId) return;
        const result = await manager.cleanup(msg.sessionId, { keepBranch: msg.keepBranch });
        if (!result.ok) {
          // 拒绝清理（还在跑 / 工作目录有未提交改动）时目录其实还在磁盘上，
          // 谎报「已清理」会让用户以为工作已经被回收。
          this.store.sendToast(
            "warning",
            vscode.l10n.t("未能清理：{0}", result.reason ?? "未知原因"),
          );
        } else if (result.branchKept) {
          this.store.sendToast(
            "info",
            vscode.l10n.t("已清理工作目录，分支已保留：{0}", result.reason ?? ""),
          );
        } else {
          this.store.sendToast("info", vscode.l10n.t("已清理超流体"));
        }
        break;
      }
      case "cleanupBatch": {
        const ids = msg.sessionIds ?? [];
        if (ids.length === 0) return;
        // 串行清理：每个目标都要删 worktree / 跑 git 探测，并发只会互相抢锁。
        // 逐条 toast 会把转录刷满（N 条重复），因此这里只聚合结果、发**一条**
        // 汇总回执；单个清理仍走上面的 `cleanup` 分支，回执保持原样。
        let cleaned = 0;
        let branchesKept = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const result = await manager.cleanup(id, { keepBranch: msg.keepBranch });
            if (result.ok) {
              cleaned += 1;
              if (result.branchKept) branchesKept += 1;
            } else {
              failed += 1;
              this.log.warn(
                `super agent: 批量清理未能完成 ${id}：${result.reason ?? "未知原因"}`,
              );
            }
          } catch (error) {
            failed += 1;
            this.log.warn(`super agent: 批量清理 ${id} 失败：${errorMessage(error)}`);
          }
        }
        this.reportSuperCleanupBatch(cleaned, failed, branchesKept);
        break;
      }
      case "merge": {
        if (!msg.sessionId) return;
        await this.requestSuperMerge(msg.sessionId);
        break;
      }
      case "retry": {
        if (!msg.sessionId) return;
        const ok = await manager.retry(msg.sessionId);
        if (ok) {
          this.store.sendToast("info", vscode.l10n.t("已重新派发超流体（沿用原工作目录）"));
        } else {
          this.store.sendToast(
          "warning",
          vscode.l10n.t("该超流体现在无法重试（可能已完成或已被清理），请刷新看板后重试。"),
        );
        }
        break;
      }
    }
  }

  // --- QQ thin delegates (阶段 5) -------------------------------------------
  // Signature is preserved: parameter/return types are derived from QqHost,
  // so the webview-message switch, extension.ts and tests keep their contract.

  /**
   * 批量清理的**唯一一条**回执。
   *
   * 看板的「清理已结束」一次清一整批；旧实现让 host 逐个 `cleanup`，于是
   * 用户看到 N 条一模一样的「已清理子会话」，既不知道整批到哪了、也不知道
   * 有没有失败。这里按真实聚合结果措辞：全部成功才说「已清理 N 个」，
   * 有失败一律 warning 级并给出未能清理的数量，分支被保留时如实补一句 ——
   * **绝不谎报全部成功**。
   */
  reportSuperCleanupBatch(cleaned: number, failed: number, branchesKept: number): void {
    if (cleaned === 0 && failed === 0) return;
    if (failed === 0) {
      if (branchesKept === 0) {
        this.store.sendToast("info", vscode.l10n.t("已清理 {0} 个超流体", cleaned));
      } else {
        this.store.sendToast(
          "info",
          vscode.l10n.t("已清理 {0} 个超流体，{1} 个分支已保留", cleaned, branchesKept),
        );
      }
      return;
    }
    if (cleaned === 0) {
      this.store.sendToast("warning", vscode.l10n.t("未能清理这 {0} 个超流体", failed));
      return;
    }
    if (branchesKept === 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已清理 {0} 个超流体，{1} 个未能清理", cleaned, failed),
      );
    } else {
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "已清理 {0} 个超流体，{1} 个未能清理，{2} 个分支已保留",
          cleaned,
          failed,
          branchesKept,
        ),
      );
    }
  }


  /**
   * The board's merge button asks the AGENT to merge.
   *
   * The merge is done by a **dedicated child session that runs in the main
   * repository workspace** (isolation kind `repo`): the host no longer runs
   * `git merge` itself (a conflict needs someone to read the code), and the
   * main session no longer merges either (it only delegates, plans and
   * reports — it must not touch git).
   *
   * A merge child has no worktree and no branch of its own: merging has to
   * happen in the workspace that holds the target branch, and its product IS
   * the merge commit on the main branch. When it finishes, the host verifies
   * with a read-only `git merge-base --is-ancestor` that the branch actually
   * landed and records the integration — reporting the truth either way
   * instead of assuming success.
   */
  async requestSuperMerge(
    id: string,
    options?: { auto?: boolean; reason?: string },
  ): Promise<SuperMergeDispatchResult> {
    const manager = this.deps.getSuperAgent();
    if (!manager) {
      return {
        dispatched: false,
        queued: false,
        reason: "超流不可用（未打开工作区）",
      };
    }
    const session = manager.get(id);
    if (!session) {
      this.store.sendToast("warning", vscode.l10n.t("该超流体不存在或已被清理"));
      return { dispatched: false, queued: false, reason: "该超流体不存在或已被清理" };
    }
    if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
      this.store.sendToast("warning", vscode.l10n.t("该超流体没有可合并的分支（仅目录隔离）"));
      return {
        dispatched: false,
        queued: false,
        reason: "该超流体没有可合并的分支（仅目录隔离）",
      };
    }
    if (session.integration?.state === "merged") {
      this.store.sendToast("info", vscode.l10n.t("该超流体的改动已经合并"));
      return { dispatched: false, queued: false, reason: "该超流体的改动已经合并" };
    }
    if (!isTerminalSuperStatus(session.status)) {
      this.store.sendToast("warning", vscode.l10n.t("超流体还没结束，完成后再让智能体合并"));
      return {
        dispatched: false,
        queued: false,
        reason: "超流体还没结束，完成后再让智能体合并",
      };
    }
    const state = this.store.getState();
    if (
      state.initializing ||
      state.status === "streaming" ||
      state.replaying ||
      this.historySyncBusy
    ) {
      if (options?.auto) {
        // 主会话正忙着：留在队列里等它空闲。自动路径不能就此丢掉 —— 丢掉就
        // 等于把这件事又推回给用户手动点按钮，那正是这次要改掉的行为。
        this.scheduleSuperMerge(id, options.reason ?? "");
        return {
          dispatched: false,
          queued: true,
          reason: "主会话正忙，合并请求已排队，空闲后自动派发",
        };
      }
      const reason = "主会话正在生成，未派出合并超流体，请等本轮结束后重试";
      this.store.sendToast(
        "warning",
        vscode.l10n.t("主会话正在生成，未派出合并超流体，请等本轮结束后重试"),
      );
      return { dispatched: false, queued: false, reason };
    }
    if (!state.sessionId) {
      if (options?.auto) {
        this.scheduleSuperMerge(id, options.reason ?? "");
        return {
          dispatched: false,
          queued: true,
          reason: "会话未就绪，合并请求已排队，就绪后自动派发",
        };
      }
      this.store.sendToast("warning", vscode.l10n.t("会话未就绪，无法让智能体合并"));
      return { dispatched: false, queued: false, reason: "会话未就绪，无法让智能体合并" };
    }
    // 派一个跑在主仓工作区的合并子会话：任务书就是合并任务书本身。
    const branch = session.isolation.branch;
    const child = await manager.spawnMerge({
      source: session,
      task: buildSuperMergeRequestPrompt(session, {
        auto: options?.auto === true,
        reason: options?.reason,
      }),
      title: vscode.l10n.t("合并分支 {0}", branch),
    });
    if (!child) {
      if (options?.auto) {
        // 已有合并子会话在跑（主仓工作区没有版本隔离）：自动路径不能就此丢掉
        // —— 重新排队，等前一个合并子会话跑完再派。
        this.scheduleSuperMerge(id, options.reason ?? "");
        return {
          dispatched: false,
          queued: true,
          reason: "已有合并超流体在跑，合并请求已排队，等它结束后派发",
        };
      }
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已有合并超流体在跑，等它结束后再合并：{0}", branch),
      );
      return {
        dispatched: false,
        queued: false,
        reason: `已有合并超流体在跑，未派出新的合并超流体（分支 ${branch}），请稍后重试`,
      };
    }
    this.store.sendToast(
      "info",
      options?.auto
        ? vscode.l10n.t("超流体「{0}」的改动没能自动合并，已派出合并超流体", session.title)
        : vscode.l10n.t("已派出合并超流体，合并超流体「{0}」的分支", session.title),
    );
    return { dispatched: true, mergeSessionId: child.id };
  }


  /**
   * 排入「让智能体合并」队列并立刻尝试发起。
   *
   * 队列按子会话去重：同一个子会话只排一次（自动触发与手动点击可能撞车）。
   * 队列里排的是**待派发的合并子会话**，不是发给主会话的提示词。
   */
  scheduleSuperMerge(id: string, reason: string): void {
    if (!this.pendingSuperMerges.some((item) => item.id === id)) {
      this.pendingSuperMerges.push({ id, reason });
    }
    void this.drainSuperMerges();
  }


  /**
   * 串行派发待合并的子会话。
   *
   * 合并必须发生在主工作区里，并发合并同一个仓库会把状态搅乱，所以一次只
   * 跑一个。主会话正忙 / 正在恢复历史时留在队列里，等空闲后由回合结束钩子
   * 再叫一次。
   *
   * 合并子会话是**异步**的（它有自己的 CLI 进程）：派出去之后本轮就结束，
   * 下一个排队的合并等它跑完（`onMergeResult` 回调）再派。
   */
  async drainSuperMerges(): Promise<void> {
    if (this.superMergeRunning) return;
    this.superMergeRunning = true;
    try {
      while (this.pendingSuperMerges.length > 0) {
        const state = this.store.getState();
        if (
          state.status === "streaming" ||
          state.initializing ||
          state.replaying ||
          this.historySyncBusy
        ) {
          break;
        }
        // 合并子会话跑在**主仓工作区**里：主会话正忙着（哪怕还在准备阶段）
        // 时先让它走完 —— 两边同时改主仓会互相踩。
        if (this.mainLane !== null) break;
        // 汇报 turn 也占用主会话这同一条车道，等它结束（心跳会再叫我们）。
        if (this.superReportRunning) break;
        // 主仓工作区没有版本隔离：同一时刻只能有一个合并子会话在跑。
        if (this.superMergeChildRunning()) break;
        // 先把队首**取下**再 request：派发失败时 requestSuperMerge 的 auto
        // 路径会用 scheduleSuperMerge 把 id 重新排到**队尾**（按 id 去重），
        // 绝不再把同一个 id 塞回队首反复挡住后面的合并请求。
        const next = this.pendingSuperMerges.shift();
        if (!next) break;
        const result = await this.requestSuperMerge(next.id, { auto: true, reason: next.reason });
        if (!result.dispatched && this.pendingSuperMerges.length > 0) {
          // 没派出去：合并子会话可能压根没起，onMergeResult 永远不会来 ——
          // 只靠外部回调会卡住整条队列。登记一次性唤醒，下一拍自己再试。
          this.scheduleSuperMergeWakeup();
        }
        // 合并子会话跑完才派下一个（onMergeResult 会再叫一次 drain）。
        break;
      }
    } finally {
      this.superMergeRunning = false;
    }
  }


  /**
   * 合并队列的一次性唤醒（与心跳并行的一道保险，见 superMergeWakeupTimer）。
   *
   * 有定时器在就不再叠加新的：多次失败重投只留一拍，避免定时器风暴。
   */
  scheduleSuperMergeWakeup(): void {
    if (this.disposed || this.superMergeWakeupTimer) return;
    this.superMergeWakeupTimer = setTimeout(() => {
      this.superMergeWakeupTimer = null;
      if (this.disposed) return;
      void this.drainSuperMerges();
    }, SUPER_HEARTBEAT_MS);
    // 与心跳同理：别为一个唤醒把扩展宿主钉在内存里。
    if (typeof this.superMergeWakeupTimer.unref === "function") {
      this.superMergeWakeupTimer.unref();
    }
  }


  /**
   * 是否已有一个**真合并子会话**在跑。
   *
   * 合并子会话跑在**主仓工作区**里（没有版本隔离）：两个合并同时改同一个
   * 工作区会把仓库状态搅乱，所以同一时刻只能有一个。
   *
   * 判据必须来自管理器的合并目标表（`spawnMerge` 登记），**不能**按
   * `isolation.kind === "repo"` 扫会话列表：完全信任子会话共用这一档（主仓
   * 工作区），但它既不执行合并，也不占用主会话的汇报车道 —— 把它算成合并
   * 子会话会挡住真正的合并派发与主会话汇报。部分测试替身只实现 list /
   * spawnMerge，缺这个查询时按「没有合并子会话」处理，绝不回退到旧口径。
   */
  superMergeChildRunning(): boolean {
    const manager = this.superAgent;
    if (!manager) return false;
    if (typeof manager.hasRunningMergeChild !== "function") return false;
    return manager.hasRunningMergeChild();
  }

  /** Text of an agent message chunk (the wire carries a single ContentBlock). */

}
