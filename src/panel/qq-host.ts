/**
 * QqHost — QQ 渠道宿主逻辑，从 `panel.ts` 下沉（panel 拆分阶段 5；等价重构）。
 *
 * Owns the whole QQ runtime: the channel lifecycle (start / stop / restart /
 * bind), the pending-user queue, the settings projection, and — critically —
 * the *entire* "wait for final answer" state machine (awaiters, rescue timers,
 * dedup caches, question ownership and child-session attribution). The ~30
 * `qq*` state fields move here **as one group**: splitting them between panel
 * and host would break the pending / dedup / rescue state machine.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. Everything it needs
 * from the panel arrives through {@link QqHostCallbacks}; the panel constructs
 * those callbacks with arrow wrappers so `this` stays bound to the panel at
 * call time (the same pattern used by ToolDiffService / SessionRestoreService).
 *
 * Panel methods in the QQ section are thin delegates of the same name, so the
 * webview-message switch, extension.ts contract and all existing tests keep
 * their shape. New wire message types: zero.
 */

import * as vscode from "vscode";
import path from "node:path";
import { errorMessage } from "../acp/jsonrpc.js";
import type { AcpClient } from "../acp/client.js";
import type {
  ContextRefUi,
  QqSettingsPatch,
  QqTaskUi,
  UserQuestion,
} from "../../shared/messages.js";
import type { UserQuestionsResponse } from "../acp/protocol.js";
import { isTerminalSuperStatus, type SuperSessionUi } from "../../shared/super-agent.js";
import type { SessionStore } from "./store.js";
import type { SuperAgentManager } from "./super-agent.js";
import {
  QqService,
  qqSpawnPolicyFor,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqTaskAction,
} from "../qq/service.js";
import { QqTaskStore } from "../qq/store.js";
import {
  createQqServiceHost,
  QQ_DEFAULT_SETTLE_TIMEOUT_MS,
  QqSettleTimeoutError,
  type QqHostPorts,
  type QqHostSuperSnapshot,
} from "../qq/panel-host.js";
import {
  applyQqSettingsPatch,
  createVscodeQqSettingsIo,
  readQqSettings,
  type QqSettingsIo,
} from "../qq/settings-host.js";
import {
  checkQqStartupGate,
  normalizeQqConfig,
  QQ_SECRET_KEYS,
  validateQqConfig,
  type QqConfig,
} from "../qq/config.js";
import {
  isTerminalSuperStatus as isQqTerminalSuperStatus,
  QQ_SETTLE_POLL_MS,
  shouldRestartOnPatch,
} from "../qq/wiring.js";
import {
  QqPendingUserStore,
  QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS,
  QQ_PENDING_MAX_USERS,
  type QqPendingUser,
  type QqPendingUserInput,
} from "../qq/pending-users.js";
import { maskQqOpenId } from "../../shared/qq-access.js";
import type { InboundMessage } from "../qq/adapter/types.js";
import { setQqTasks } from "../../shared/session-state.js";
import {
  buildClearedQrMessage,
  buildConfirmedQrMessage,
  createQqBotBindRuntime,
  createQqChannelDispatch,
  deliverViaQqBotAdapter,
  QQBOT_APP_ID_SECRET_KEY,
  qrFailureMessage,
  qrProgressMessage,
  qrReadyMessage,
  readQqBotCredentials,
  sanitizeQrLoginMessage,
  storeQqBotCredentials,
  toManagedStatusMessage,
  type QqBotAdapterLike,
  type QqBotBindRuntimeDeps,
  type QqChannelDispatchDeps,
} from "./qqbot-host.js";


/**
 * QQ 通道单项收尾上限：关面板不能被一个卡住的 adapter/socket 拖死。
 * （通道重启上限与退避阶梯已随收敛移除。）
 */
const QQ_BRIDGE_STOP_TIMEOUT_MS = 2_000;
/** 设置改动 → 重启 QQ 服务的防抖窗口（settings.json 一次编辑会触发多帧）。 */
const QQ_SETTINGS_RESTART_DEBOUNCE_MS = 500;
/**
 * 设置事件合并窗口：一次补丁会逐键写多条配置，`onDidChangeConfiguration`
 * 因此连发多轮。50ms 内的事件合并成一轮完整同步，避免一次编辑触发 N 次。
 */
const QQ_SETTINGS_SYNC_DEBOUNCE_MS = 50;
/** 单次「失活 → 自动重启」的硬上限：绝不允许无限重启（重扫是人工兜底）。 */
const QQ_HEALTH_RESTART_LIMIT = 1;
/**
 * 任务看板投影上限。
 *
 * 任务记录本身由 `QqTaskStore` 落盘管理，这里限的是**投影到 webview 的行数**
 * ——长跑通道会把几百条终态任务一起塞进每一帧快照。活跃（非终态）任务全
 * 保留（用户要能看到正在跑的任务并停止它），剩余名额给最近的终态任务。
 */
export const QQ_TASK_PROJECTION_LIMIT = 100;
/** `QqTaskUi.status` 中的终态集合（与 `src/qq/service.ts` 的状态机一致）。 */
const QQ_TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "timeout",
  "needs_review",
]);
/**
 * 健康 detail 里出现这些片段即视为「失活 / 出错」，不能继续显示「正常」。
 *
 * 只匹配明确表示链路不可用的措辞：`op=9 invalid session` 由 adapter 记录成
 * 「会话已失效（op=9 invalid session）」，断线与重连失败同理；**不**匹配
 * 「断线区间可能丢消息」这类「当前已连上、只是提示历史缺口」的 notice。
 */
const QQ_HEALTH_FAILURE_MARKERS = [
  "invalid session",
  "会话已失效",
  "连接断开",
  "已断开",
  "重连失败",
  "心跳发送失败",
  "发送失败",
  "disconnected",
] as const;

/** adapter 健康快照是否代表「可正常收发」。 */
export function isQqHealthHealthy(health: {
  connected: boolean;
  detail?: string | null;
}): boolean {
  if (!health.connected) return false;
  const detail = (health.detail ?? "").toLowerCase();
  if (detail.length === 0) return true;
  return !QQ_HEALTH_FAILURE_MARKERS.some((marker) => detail.includes(marker.toLowerCase()));
}

/**
 * 裁剪 QQ 任务投影：活跃任务永不丢弃，剩余名额按原顺序（service 已按
 * updatedAt 降序）补足终态任务；返回保持原行序（看板不回跳）。
 */
export function capQqTaskProjection(
  tasks: readonly QqTaskUi[],
  limit: number = QQ_TASK_PROJECTION_LIMIT,
): QqTaskUi[] {
  if (tasks.length <= limit) return [...tasks];
  const keep = new Set<string>();
  for (const task of tasks) {
    if (keep.size >= limit) break;
    if (!QQ_TERMINAL_TASK_STATUSES.has(task.status)) keep.add(task.taskId);
  }
  for (const task of tasks) {
    if (keep.size >= limit) break;
    keep.add(task.taskId);
  }
  return tasks.filter((task) => keep.has(task.taskId));
}


/** SuperMergeDispatchResult 由本模块定义（见下方 TYPES），panel 侧按结构复用。 */

/**
 * 主会话渠道等待「主会话空闲」的轮询间隔。
 *
 * 比子会话收尾轮询（1.5s）短得多：这里等的是本地回合结束，用户按下回车后
 * 往往几秒内就空闲，注入延迟必须可感知地小。
 */
const QQ_MAIN_IDLE_POLL_MS = 300;

/**
 * QQ 最终答复「迟到补发」阈值（R2）。
 *
 * **等待过久 ≠ 可以定终局**（2026-11-19 修复）：补发机制的目的是「别让 QQ
 * 永久停在已受理」，而不是「等够久就替主 Agent 把结论写死」。因此：
 *  - 软阈值（QQ_FINAL_RESCUE_MS）：awaiter 已等超过该阈值**且本会话已无活跃
 *    子会话** → 可以定终局（真的不会再有更正文了，走补发收尾）；
 *  - 硬上限（QQ_FINAL_HARD_RESCUE_MS）：到点时**若仍有活跃子会话**，绝不写
 *    终局、绝不写 resultDeliveredAt —— 只降级成一条「仍在进行中」的进度
 *    措辞，并保留 awaiter，让真正的最终汇报轮还有机会投递完整正文。
 * 汇报轮的 final 标记只由 pendingCount===0 决定：rescueDue 只用来放宽提示词
 * （让模型这一轮就给结论），不消费 awaiter、不定终局（见
 * QqHost#settleSuperReportsIfReady (panel callback)）。
 * 轮询间隔远小于阈值，仅为让补发在阈值到点后尽快发生。
 */
const QQ_FINAL_RESCUE_MS = 120_000;
const QQ_FINAL_HARD_RESCUE_MS = 600_000;
const QQ_FINAL_RESCUE_POLL_MS = 10_000;
/**
 * 硬上限降级成「仍在进行中」进度措辞时的最小间隔。
 *
 * 补发轮询每 10s 拍一次；进度措辞没有新信息量（子会话还在跑），连发只会
 * 刷屏并挤占 QQ 的被动回复窗口。同一任务在这个间隔内只提醒一次。
 */
const QQ_FINAL_RESCUE_PROGRESS_MIN_INTERVAL_MS = 120_000;
/**
 * 硬上限补发遇到「本会话汇报轮正在投递 / 排队」时最多让出的轮询拍数。
 *
 * 让真实最终汇报（finalReport 收尾投递）优先收尾：抢在它前面补发会把兜底
 * 文案当结论写死，并让随后迟到的真实正文被丢弃（2026-11-19 用户实测）。
 * 只让出有限拍数，超过仍未收尾就强制处理 —— 保留「真正卡死」时的兜底，
 * 绝不永久推迟。强制处理同样受「子会话仍在跑就不定终局」约束。
 */
const QQ_FINAL_RESCUE_MAX_DEFERS = 6;

/**
 * 注入轮结束时判定 delegated 的宽限期（R3）：子会话登记可能与回合收尾差错一拍，
 * 留一个很短的窗口再核对子会话列表，避免把「已派子会话」误判成直答而提前撤销
 * 等最终答复的记账。测试可注入更小值。
 */
const QQ_DELEGATION_GRACE_MS = 120;

/**
 * QQ 最终答复兜底用的子会话汇报正文上限。QQ 单条消息有字符预算（见
 * `src/qq/service.ts` 的 `QQ_CHUNK_MAX_CHARS`），这里先截到远小于它的长度，
 * 既保留结论又不会把整段子会话转录灌给外部渠道。
 */
const QQ_REPORT_FALLBACK_MAX_CHARS = 1_500;

/**
 * 一次 QQ 正文投递的**来源**（归档事件 `task_answer_delivered` 的 source）。
 *
 *  - `final-report`：pendingCount=0 的汇报汇总轮产出的最终正文（真·最终答复）；
 *  - `rescue`：迟到补发（等太久且已无活跃子会话）投递的收尾正文；
 *  - `intermediate`：中间正文 / 降级进度措辞（任务**没有**被定终局）。
 *
 * 有了它，事后能查清「QQ 收到的是哪一段、当时走的是哪条通道」。
 */
export type QqAnswerDeliverySource = "final-report" | "rescue" | "intermediate";

/**
 * 正文指纹（FNV-1a 32bit，十六进制）：归档事件里记一段正文的指纹，
 * 便于事后核对「QQ 收到的就是这一段」，又不把整段正文写进事件日志。
 */
function qqTextFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 把子会话汇报正文（`report.summary`）清洗成可安全转发给 QQ 的纯文本。
 *
 * 汇报是子会话自己写的自由文本，可能带 super-agent 委派围栏 / ACP 工具与角色
 * 标签（协议标记）、本机绝对路径、token/密钥与长 id。发到外部渠道前一律去掉：
 *  - 保留项目相对路径（用户要知道「改了哪些文件、验证了什么」），只抹本机绝对路径；
 *  - 凭据与 id 用占位替代，避免把本机信息泄漏到聊天记录；
 *  - 折叠空白并按上限截断。
 * 空串代表这条正文不可用，调用方据此再退到如实占位文案。
 */
export function sanitizeQqReportFallback(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "";
  let text = raw;
  // 协议标记：super-agent 委派围栏 / ACP 工具与角色标签 / 纯 JSON 信封行。
  text = text.replace(/```(?:super-agent|json)\b[\s\S]*?```/gi, "");
  text = text.replace(
    /<\/?(?:tool_call|function_call|function|thinking|system|user|assistant)\b[^>]*>/gi,
    "",
  );
  text = text.replace(/^\s*\{[^\n]*"(?:type|tool_call_id)"\s*:[^\n]*\}\s*$/gm, "");
  // 凭据：常见 token 前缀直写，以及 key=value 形式。
  text = text.replace(/\b(?:sk|gho|ghs|ghp|github_pat)-[A-Za-z0-9_-]{8,}/gi, "[已隐藏]");
  text = text.replace(
    /(["']?(?:api[_-]?key|app[_-]?secret|password|token|access[_-]?key)["']?\s*[:=]\s*)(["']?)([^"'\s,;&})]+)\2/gi,
    "$1$2[已隐藏]$2",
  );
  // 本机绝对路径（Windows 盘符 / UNC / POSIX home/tmp），保留项目相对路径。
  text = text.replace(/\b[A-Za-z]:[\\/][^\s,;)\]"']*/g, "[路径]");
  text = text.replace(/\\\\[^\s\\/]+\\[^\s,;)\]"']*/g, "[路径]");
  text = text.replace(/(?:^|[\s(])\/(?:home|Users|root|tmp|var)\/[^\s,;)\]"']*/g, " [路径]");
  // 长 id / UUID（openid、session id、随机串）。
  text = text.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi,
    "[ID]",
  );
  text = text.replace(/\b[0-9a-fA-F]{16,}\b/g, "[ID]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > QQ_REPORT_FALLBACK_MAX_CHARS
    ? `${text.slice(0, QQ_REPORT_FALLBACK_MAX_CHARS - 1)}…`
    : text;
}

/**
 * 远程接管提示的单条正文截断：复用 QQ 汇报兜底的字符预算，保留结论前缀，
 * 超长时省略尾部并在调用处补「完整结果请在面板查看」。不新增任意数值。
 */
export function clipQqTakeoverReport(text: string): string {
  return text.length > QQ_REPORT_FALLBACK_MAX_CHARS
    ? `${text.slice(0, QQ_REPORT_FALLBACK_MAX_CHARS - 1)}…`
    : text;
}


/**
 * Narrow view of the panel state the QQ host reads/writes. Each member is a
 * callback (arrow-wrapped by the panel) so no import of `panel.ts` is needed.
 */
export interface QqHostCallbacks {
  readonly log: { info(message: string): void; warn(message: string): void };
  getContext(): vscode.ExtensionContext;
  getServices(): {
    qqSettingsIo?: QqSettingsIo;
    qqbotDeps?: {
      bind?: QqBotBindRuntimeDeps;
      transport?: QqChannelDispatchDeps["transport"];
      adapterFactory?: QqChannelDispatchDeps["adapterFactory"];
      gatewayUrl?: string;
    };
  };
  getStore(): SessionStore;
  isDisposed(): boolean;
  getClient(): AcpClient | null;
  getPendingQuestions(): Map<string, { timer: NodeJS.Timeout; resolve: (value: UserQuestionsResponse) => void }>;
  getPendingSuperReportPrompts(): readonly { mainSessionId: string | null }[];
  isSuperReportRunning(): boolean;
  getSuperRepoRoot(): string | null;
  postToWebview(message: unknown): void;
  getSuperAgent(): SuperAgentManager | null;
  requestSuperMerge(id: string, options?: { auto?: boolean; reason?: string }): Promise<SuperMergeDispatchResult>;
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
      origin?: "qq";
      displayText?: string;
      quietBusy?: boolean;
      onTurnStarted?: () => void | Promise<void>;
    },
  ): Promise<boolean>;
  sendTurnCancel(sessionId: string, client: AcpClient | null): void;
  mainSessionFree(): boolean;
  getCancelSeen(): boolean;
  setCancelSeen(value: boolean): void;
  // Self-calls that existing tests spy on through the panel delegate. The
  // panel's callback invokes its own thin delegate, so a vi.spyOn(p, "...")
  // still observes the call even though the body now lives here. These are
  // one-way: the delegate calls straight back into QqHost, no recursion.
  pushQqSettings(): Promise<void>;
  onQqSettingsChanged(): Promise<void>;
  cancelAllQqMainInjections(): void;
  waitForQqMainFree(signal: AbortSignal, deadline: number): Promise<"free" | "canceled" | "timeout">;
}

/** Structural mirror of the panel's SuperMergeDispatchResult (no panel import). */
export type SuperMergeDispatchResult =
  | { dispatched: true; mergeSessionId: string }
  | { dispatched: false; queued: boolean; reason: string };

/** Runtime channel scene — the old NonNullable<ChatPanel["qq"]>. */
export interface QqRuntime {
  service: QqService;
  store: QqTaskStore;
  config: QqConfig;
  io: QqSettingsIo;
  qqbot: {
    adapter: QqBotAdapterLike;
    bindSession?: { stop(): void };
  };
}


export class QqHost {
  constructor(private readonly deps: QqHostCallbacks) {}


  // --- QQ state (整组迁移；panel 仅保留兼容访问器) -------------------------

  /**
   * QQ 远程任务通道的运行期现场（QQBot 单一路径）。
   *
   * 现场 = QqService + 任务落盘 + 启动时的配置快照 + 设置 IO + 官方 adapter。
   * 它是**唯一**的「通道是否在跑」判据 —— 所有入口都以 `this.qq` 是否存在
   * 为闸门，没有任何入口能在半初始化状态下继续。
   *
   * `config` 与 QqService 内部持有的是**同一个对象**：非连接类字段（白名单 /
   * 策略 / 并发 / 限流 / 详略 / 自动合并）由面板就地热更新，改完即时生效。
   * 历史遗留的 IPC / bridge / 托管 manager / 二维码轮询桥字段已随收敛移除。
   */
  qq?: {
    service: QqService;
    store: QqTaskStore;
    config: QqConfig;
    io: QqSettingsIo;
    /** QQBot 官方路线：不 spawn bridge，直接持有 adapter + 扫码会话。 */
    qqbot: {
      adapter: QqBotAdapterLike;
      /** 扫码会话在绑定成功后即停并清空，只在绑定进行中短驻留。 */
      bindSession?: { stop(): void };
    };
  };
  /**
   * 主会话渠道（QQ 消息固定去向）的注入控制面。
   *
   * `qqInjectAborts` 按 taskId 保存「放弃等待空闲」的取消信号（`/qq stop`
   * 与通道停止都要能立刻放手）；`qqInjectedTaskId` 是当前真正跑在主会话上的
   * 那一轮属于哪个任务 —— 停止时要打断的是**这一轮**，不能误伤本地回合。
   */
  readonly qqInjectAborts = new Map<string, AbortController>();
  qqInjectedTaskId: string | null = null;
  /**
   * 远程接续开关（纯内存态，不持久化）：开启 = 远程继续干活 —— QQ 消息照常
   * 注入主会话、agent 继续执行，只冻结本地干预入口（转录保持只读可观察），
   * 防止两边同时操作造成混淆；关闭 = 本地恢复 + 断开远程 —— 在本次接管的
   * sessionId 上设「不再接收 QQ 注入」的门，并取消在跑的注入回合。
   *
   * `qqTakeoverActive` / `qqTakeoverSessionId` 是本地冻结态；
   * `qqRemoteDetachedSessions` 是「已断开远程接管的会话集合」，只有它命中才
   * 拦截 QQ 注入（start / 默认状态一律放行）。冻结态在 stop / 会话切换 /
   * webview 重连 / dispose 时清；断开门不因 webview 重连而清（同一 panel
   * 进程里远程关系仍在，清了会让已断开的会话意外恢复注入），只在会话切换
   * / 重建（newSession / restore / dispose）时清。toastId 只是 toast 的 host
   * id，不是凭据。
   */
  qqTakeoverActive = false;
  qqTakeoverSessionId: string | null = null;
  qqTakeoverToastId: number | null = null;
  /** 已断开远程接管的会话集合：命中即拒绝 QQ 主会话注入；不持久化。 */
  readonly qqRemoteDetachedSessions = new Set<string>();
  /**
   * QQ 主渠道「等最终答复」记账：注入轮已把任务派给子会话的任务 id → 归属
   * 主会话 id。
   *
   * 主会话只委派不执行：注入轮的 assistant 文本只是「已安排」的占位，真正
   * 答复在子会话汇报汇总轮（hidden/reportTurn、pendingCount=0）产生。该轮
   * 结束时按归属会话找到这里的任务，把那一轮文本作为最终答复回传 QQ。停止
   * / 会话切换时摘除，避免迟到的汇报回错任务。
   */
  readonly qqMainFinalAwaiters = new Map<string, string>();
  /**
   * 每个 awaiter 的登记时刻（taskId → Date.now()）：迟到补发（R2）按等待时长判定。
   * 与 qqMainFinalAwaiters 同生命周期，同增同删；缺省视为「刚登记」（不触发补发）。
   */
  readonly qqMainFinalAwaiterSince = new Map<string, number>();
  /**
   * 每个归属主会话最近一次汇报回合产出的 assistant 文本（sessionId → text）。
   * 补发时优先用它（保留真实结论），没有才退回如实兜底文案。仅作补发缓存，
   * 不参与正常 final 回执；awaiter 清空时一并清理。
   */
  readonly qqFinalRescueText = new Map<string, string>();
  /**
   * 每个归属主会话最近一次子会话汇报正文（report.summary 清洗后）作为补发兜底。
   *
   * 与 `qqFinalRescueText` 分离：后者会被非 final 的进度汇报轮正文覆盖，硬上限
   * 补发时可能为空；这条只在汇报入队时写入，保证补发即便缓存正文为空也能回
   * 真实汇报正文而不是一句占位文案（2026-11-19 补发抢跑 bug）。
   */
  readonly qqReportFallbackText = new Map<string, string>();
  /**
   * 每个 awaiter 因「在途汇报轮」让出的补发拍数（taskId → 次数）。达到
   * `QQ_FINAL_RESCUE_MAX_DEFERS` 后强制处理，避免真正卡死时永久等待。
   */
  readonly qqFinalRescueDefers = new Map<string, number>();
  /**
   * 每个 awaiter 最近一次「仍在进行中」进度措辞的发送时刻（taskId → ts）。
   *
   * 硬上限到点但子会话仍在跑时，补发降级成进度提醒而不是定终局；轮询每 10s
   * 一次，没有新信息量的提醒要节流，否则会刷屏并挤占 QQ 的被动回复窗口。
   * 与 awaiter 同生命周期：投递 / 撤销 / 停通道时清理。
   */
  readonly qqFinalRescueProgressAt = new Map<string, number>();
  /** 迟到补发的轮询定时器（仅在有 awaiter 时存活）。 */
  qqFinalRescueTimer: ReturnType<typeof setInterval> | null = null;
  /** 注入轮 delegated 判定的宽限期；测试可注入更小值。 */
  qqDelegationGraceMs = QQ_DELEGATION_GRACE_MS;
  /** 迟到补发的软 / 硬阈值；测试可注入更小值。 */
  qqFinalRescueMs = QQ_FINAL_RESCUE_MS;
  qqFinalHardRescueMs = QQ_FINAL_HARD_RESCUE_MS;
  /**
   * 属于 QQ 主渠道对话的本地提问卡（卡片 id → 归属 QQ 任务 id）。
   *
   * 主会话/子会话的 `_iflow/user/questions` 与本地回合共用同一个单数提问卡槽位，
   * 这里单独记账：QQ 用户的 `/qq answer` 只回灌这里登记的卡，绝不误答本地提问；
   * 本地用户先作答时也从这里摘除，避免同一问题被 QQ 再答一次（双重应答）。
   * 记 taskId 而非只用 Set，是为了回灌时不依赖「当前回合」这个易变状态 ——
   * 回合结束后 qqInjectedTaskId 会清空，但那张卡仍属于诞生它的那个任务。
   */
  readonly qqMainQuestionIds = new Map<string, string>();
  /**
   * QQ 主渠道任务派生的子会话 → 发起它的 QQ 主任务 id。
   *
   * main 渠道任务没有 `correlation.superSessionId`（那是 child 渠道专属），子会话
   * 的提问因此无法按旧路径匹配到 QQ 任务。这里在派发子会话的当场打上归属标签，
   * `onNeedInput` 据此把提问提醒回灌到正确的 QQ 任务。
   */
  readonly qqTaskBySuperSession = new Map<string, string>();
  /**
   * QQ 主任务「自己那一轮」的汇报正文（taskId → 清洗后的子会话汇报）。
   *
   * 同一主会话里连发多条 QQ 消息时，各任务派生各自的超流体子会话；一轮汇总
   * 结论若广播给该会话所有 awaiter，就会出现「摘要相同、taskId 不同」的重复
   * 卡。这里在汇报入队时按 {@link qqTaskBySuperSession} 把每个子会话的汇报归
   * 到它的主任务，最终回执时逐 task 取回自己那份，绝不共享别人的结论。
   * 与 awaiter 同生命周期：投递 / 撤销 / 停通道时清理。
   */
  readonly qqTaskFinalText = new Map<string, string>();
  /** 主动停止中：防止与在飞的启停重叠。 */
  qqStopping = false;
  /** 最近一次推给 webview 的连接状态（用于「面板重新打开时」的立即回显）。 */
  qqConnected = false;
  qqLastDetail: string | null = null;
  /** 设置变更 → 重启服务的防抖定时器。 */
  qqRestartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 进行中的启动（并发调用 startQqIfEnabled 时共享同一份工作）。 */
  qqStarting: Promise<void> | null = null;
  /**
   * 进行中的「建通道」占位。
   *
   * `startQqBotChannel` 既有 `doStartQq`（配置事件路径）也有扫码成功
   * （绑定路径）两个调用方；两条路径若各建一套 owner，会互相覆盖/反杀。
   * 这里在**任何 await 之前同步占位**，后来者直接复用同一份启动。
   */
  qqChannelStarting: Promise<void> | null = null;
  /** 健康检查驱动的自动重启次数（上限 {@link QQ_HEALTH_RESTART_LIMIT}）。 */
  qqHealthRestarts = 0;
  /** 设置事件合并定时器（一次补丁逐键写配置会连发多轮事件）。 */
  qqSettingsSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * QQBot 官方扫码会话：绑定进行中短驻留，成功/失败/stop 后立即清空。
   * 独立于 `this.qq`（扫码时尚无服务现场），避免把半绑定现场塞进主通道。
   */
  qqbotBinding: { stop(): void } | null = null;
  /**
   * QQ 待审核用户（授权模型 2026-11-17）：白名单外的人发来消息时落一条记录，
   * 面板审核后决定放行（写进 `allowedUsers`）或拒绝。
   *
   * 独立于 `this.qq`：通道没启动 / 没绑定时也要能展示历史记录，因此存储由
   * 面板懒建、与通道生命周期无关。
   */
  qqPendingUsers: QqPendingUserStore | null = null;
  /**
   * 队列满丢弃提示的冷却记账（openid → 上次 warning toast 时刻）。
   *
   * 满队时外部每条消息都会触发一次丢弃事件，同一 openid 连续刷消息会把
   * 面板刷满屏；按 {@link QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS} 冷却，
   * 每 10 分钟最多一条。不同 openid 的首次丢弃仍各自提示。
   */
  readonly qqPendingDropToastAt = new Map<string, number>();
  /**
   * 启动代次：`stopQq` 每次递增。异步启动在关键节点复核它 —— 启动途中被
   * 停用 / 重启时，慢半拍的那个启动必须把自己造出来的现场拆掉，而不是把
   * 一份陈旧通道装回 `this.qq`。
   */
  qqGeneration = 0;


  // --- Panel proxies -------------------------------------------------------
  // These accessors keep the migrated method bodies byte-for-byte identical:
  // every former `this.<panelMember>` resolves here, and each getter/call
  // forwards through the callbacks (arrow-wrapped in the panel, so binding is
  // preserved). No state lives in these proxies — it all lives in QqHost above.

  private get log(): QqHostCallbacks["log"] { return this.deps.log; }
  private get context(): vscode.ExtensionContext { return this.deps.getContext(); }
  private get services(): ReturnType<QqHostCallbacks["getServices"]> { return this.deps.getServices(); }
  private get store(): SessionStore { return this.deps.getStore(); }
  private get disposed(): boolean { return this.deps.isDisposed(); }
  private get client(): AcpClient | null { return this.deps.getClient(); }
  private get pendingQuestions(): Map<string, { timer: NodeJS.Timeout; resolve: (value: UserQuestionsResponse) => void }> {
    return this.deps.getPendingQuestions();
  }
  private get pendingSuperReportPrompts(): readonly { mainSessionId: string | null }[] {
    return this.deps.getPendingSuperReportPrompts();
  }
  private get superReportRunning(): boolean { return this.deps.isSuperReportRunning(); }
  private get cancelSeen(): boolean { return this.deps.getCancelSeen(); }
  private set cancelSeen(value: boolean) { this.deps.setCancelSeen(value); }

  private postToWebview(message: unknown): void { this.deps.postToWebview(message); }
  private superRepoRoot(): string | null { return this.deps.getSuperRepoRoot(); }
  private getSuperAgent(): SuperAgentManager | null { return this.deps.getSuperAgent(); }
  private requestSuperMerge(id: string, options?: { auto?: boolean; reason?: string }): Promise<SuperMergeDispatchResult> {
    return this.deps.requestSuperMerge(id, options);
  }
  private sendPrompt(...args: Parameters<QqHostCallbacks["sendPrompt"]>): ReturnType<QqHostCallbacks["sendPrompt"]> {
    return this.deps.sendPrompt(...args);
  }
  private sendTurnCancel(sessionId: string, client: AcpClient | null): void {
    this.deps.sendTurnCancel(sessionId, client);
  }
  private mainSessionFree(): boolean { return this.deps.mainSessionFree(); }


  /**
   * 远程派发的子会话提问 → 转发给 QQ 发起者。
   *
   * 服务侧会按 `QqTask.correlation.superSessionId` 判定任务是否真的来自 QQ，
   * 本地子会话在这里就会被忽略，因此无需重复判断任务来源。转发是异步的，
   * 不阻塞子会话的提问挂起；接线层异常只记日志，不打断看板作答通道。
   */
  forwardQqTaskQuestion(superSessionId: string, questions: readonly UserQuestion[]): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardTaskQuestion({
          superSessionId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 主渠道注入回合里 agent 的提问 → 转发给发起者。
   *
   * 与 child 渠道复用服务的 `waiting_answer` / `pendingAnswers` / `/qq answer`
   * 状态机，只按 taskId 定位（main 任务没有子会话 id）。服务找不到对应 main
   * 任务（本地回合被误标）时会安静忽略，不会给无关的 QQ 用户发消息。
   */
  forwardQqMainTaskQuestion(taskId: string, questions: readonly UserQuestion[]): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardMainTaskQuestion({
          taskId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 主会话提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 主会话提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 主渠道任务派生的子会话提问 → 转发给发起者，答案回灌到该子会话。
   *
   * 主会话是纯委派者，真正干活的提问多来自子会话。旧路径 `forwardTaskQuestion`
   * 只认 `correlation.superSessionId && channel !== "main"` 的任务，而 main 渠道
   * QQ 任务两者都没有 —— 提问卡因此只在看板显示、QQ 永远收不到。这里按派生时
   * 记录的 QQ 主任务 id 定位任务（与 forwardMainTaskQuestion 同口径），但把应答
   * 端口指向 child：答案经 `answerRemoteQuestion(superSessionId)` 回到真正提问的
   * 子会话（`SuperAgentManager.respond`），不是主会话那张不存在的卡。
   */
  forwardQqMainTaskChildQuestion(
    taskId: string,
    superSessionId: string,
    questions: readonly UserQuestion[],
  ): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardMainTaskChildQuestion({
          taskId,
          superSessionId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 超流体提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 超流体提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 用户的 `/qq answer` 回灌：命中本回合的提问卡并 resolve，agent 继续。
   * 只认 `qqMainQuestionIds` 里的卡 —— 本地回合的提问绝不会被 QQ 回答误答。
   * 端口被服务超时 / 停止调用时 answers 是 `{}`（按未回答继续），语义一致。
   * 返回是否真的命中，供服务如实回执（绝不假装提交成功）。
   */
  answerQqMainQuestion(taskId: string, answers: Record<string, string | string[]>): boolean {
    // 只认「诞生时归属这个任务」的卡 —— 本地回合的提问绝不会被 QQ 回答误答。
    // 不读实时 qqInjectedTaskId：回合收尾后它会清空，迟到的合法回答应仍可命中。
    let answered = false;
    for (const [id, ownerTaskId] of [...this.qqMainQuestionIds]) {
      if (ownerTaskId !== taskId) continue;
      const pending = this.pendingQuestions.get(id);
      if (!pending) {
        this.qqMainQuestionIds.delete(id);
        continue;
      }
      this.pendingQuestions.delete(id);
      this.qqMainQuestionIds.delete(id);
      clearTimeout(pending.timer);
      this.store.clearQuestions(id);
      pending.resolve({ answers });
      answered = true;
    }
    if (answered) {
      this.store.appendNotice(
        Object.keys(answers).length > 0
          ? vscode.l10n.t("已通过 QQ 回答 {0} 个问题", Object.keys(answers).length)
          : vscode.l10n.t("QQ 提问已按未回答继续"),
      );
    }
    return answered;
  }


  // --- QQ 远程任务通道 -------------------------------------------------------
  //
  // 一条通道 = 一份 QqService + QQBot 官方 adapter（直连官方网关，无子进程）。
  // 面板只做编排：命令解析 / 白名单 / 审批桥 / 结果回传全在 QqService 里；本节
  // 负责把它们接起来、把生命周期管住、把状态投影给 UI。
  //
  // 纪律：
  //  - 所有入口先判 `this.qq` 是否存在 —— 半启动的现场绝不能被消息驱动；
  //  - 主动停止走 `qqStopping` 标记，防止与在飞的启停重叠；
  //  - 连接类设置改动重建服务，其余字段就地热更新（见 src/qq/wiring.ts）。

  /** 设置启用 → 启动通道；任何失败都把半启动现场收干净并如实提示。 */
  startQqIfEnabled(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // 待审核记录与通道是否启用无关：启动时先推一次，面板打开即可看到历史。
    void this.pushQqPendingUsers();
    if (this.qqStarting) return this.qqStarting;
    const task = this.doStartQq()
      .catch(async (error: unknown) => {
        const detail = errorMessage(error);
        if (!this.disposed) this.log.warn(`QQ 通道启动失败：${detail}`);
        if (!this.disposed) {
          this.store.sendToast("warning", vscode.l10n.t("QQ 通道启动失败：{0}", detail));
          this.pushQqStatus(false, detail);
        }
        // 半启动的现场必须收干净：不留 adapter 连接或扫码绑定残留。
        await this.stopQq().catch(() => undefined);
      })
      .finally(() => {
        this.qqStarting = null;
      });
    this.qqStarting = task;
    return task;
  }

  /**
   * 读设置 → 校验 → 建 IPC / 服务 / bridge。
   *
   * `enabled=false` 时只读一次配置就返回（不产生任何进程）；校验里有 error
   * 级问题时**一个零件都不启动**，只提示 —— 半启动的通道比不启动更难排查。
   */
  async doStartQq(): Promise<void> {
    if (this.qq) return;
    const generation = this.qqGeneration;
    const io = this.qqIo();
    const snapshot = await readQqSettings(io);
    const { config, warnings } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    for (const warning of warnings) this.log.warn(`QQ 设置：${warning}`);
    if (!config.enabled) {
      this.log.info("QQ 通道未启用，跳过启动");
      return;
    }

    const roots = this.qqWorkspaceRoots();
    const issues = validateQqConfig(config, roots);
    for (const issue of issues) {
      const line = `QQ 配置${issue.severity === "error" ? "错误" : "提示"}（${issue.code}）：${issue.message}`;
      if (issue.severity === "error") this.log.warn(line);
      else this.log.info(line);
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      const first = errors[0]!;
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动：{0}", first.message));
      this.pushQqStatus(false, first.message);
      return;
    }

    // 硬门控：workspace 必须落在当前工作区根（远程任务由主仓 worktree 执行）。
    const gateIssues = checkQqStartupGate(config, this.superRepoRoot());
    if (gateIssues.length > 0) {
      const first = gateIssues[0]!;
      this.log.warn(`QQ 配置错误（${first.code}）：${first.message}`);
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动：{0}", first.message));
      this.pushQqStatus(false, first.message);
      return;
    }

    await this.startQqBotChannel(config, io, generation);
  }

  // --- QQBot 官方路线（M3-C）-----------------------------------------------

  /**
   * QQBot 通道启动的**并发闸门**。
   *
   * 两个调用方（配置事件路径的 `doStartQq`、扫码成功路径的 `onQqBotBound`）
   * 都可能同时到达；同步占位保证只有一份启动在跑，后来者复用它。发现通道
   * 已经在跑时直接返回（配置事件路径在 enable 落盘后重入）。
   */
  startQqBotChannel(
    config: QqConfig,
    io: QqSettingsIo,
    generation: number,
  ): Promise<void> {
    if (this.qqChannelStarting) return this.qqChannelStarting;
    if (this.qq) return Promise.resolve();
    let task!: Promise<void>;
    task = this.doStartQqBotChannel(config, io, generation).finally(() => {
      if (this.qqChannelStarting === task) this.qqChannelStarting = null;
    });
    this.qqChannelStarting = task;
    return task;
  }

  /**
   * QQBot 官方通道的常规启动：不建 IPC、不 spawn bridge、不下载外部组件。
   *
   * 用 SecretStorage 里扫码写入的 appId/appSecret 建官方 adapter，入站事件
   * 经 `setEventCallback` 直接进 QqService，出站由 adapter.send 完成。没有
   * 凭据时如实提示先绑定，绝不退化成其它通道。
   */
  async doStartQqBotChannel(
    config: QqConfig,
    io: QqSettingsIo,
    generation: number,
  ): Promise<void> {
    const creds = await readQqBotCredentials(io);
    if (!creds) {
      const detail = "QQBot 尚未扫码绑定，请先在设置页完成扫码绑定";
      this.store.sendToast("warning", vscode.l10n.t(detail));
      this.pushQqStatus(false, detail);
      this.postToWebview(qrFailureMessage(detail));
      return;
    }

    const root = path.join(
      this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath,
      "qq",
    );
    const taskStore = new QqTaskStore(root);
    const service = new QqService({
      config,
      store: taskStore,
      host: createQqServiceHost(this.createQqHostPorts()),
      log: (line) => this.log.info(line),
      // 服务里每一次任务状态变化（派发 / 运行 / 终态 / 回包）都要回写到看板
      // 投影：否则卡片永远停在「已校验 · 耗时 0 秒 · 停止」。
      onChanged: () => this.refreshQqTaskProjection(),
    });
    const deps = this.services.qqbotDeps ?? {};
    const dispatch = createQqChannelDispatch(config, {
      appId: creds.appId,
      appSecret: creds.appSecret,
      onInbound: (msg) => {
        const live = this.qq?.service;
        // F3：服务 start() 尚未完成时（connect→start 窗口）不接消息 —— 否则
        // 建出的任务会被紧随其后的「非终态标 failed(host_restarted)」误杀，
        // 甚至派出孤儿子会话。窗口很短，丢弃优于错处理，QQ 侧会重发。
        if (!live?.isReady()) return;
        void live.handleInboundMessage(msg).catch((error: unknown) => {
          this.log.warn(`QQBot 入站处理失败：${errorMessage(error)}`);
        });
        this.refreshQqTasks();
      },
      log: (line) => this.log.info(line),
      ...(deps.transport ? { transport: deps.transport } : {}),
      ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.gatewayUrl ? { gatewayUrl: deps.gatewayUrl } : {}),
    });
    const owner: QqRuntime = {
      service,
      store: taskStore,
      config,
      io,
      qqbot: { adapter: dispatch.adapter },
    };
    this.qq = owner;
    // F3：现场在 connect 前发布（既有「配置事件不反杀半成品通道」的语义依赖
    // 这一点），但窗口期的入站消息由 QqService 的 ready 标志挡住 —— start()
    // 成功前 handleInboundMessage 一律丢弃，不会被「非终态标 failed」误杀、也
    // 不会派出孤儿子会话。
    try {
      await dispatch.adapter.connect();
      if (generation !== this.qqGeneration || this.disposed) {
        if (this.qq === owner) this.qq = undefined;
        await this.disposeQqOwner(owner);
        return;
      }
      await service.start();
    } catch (error) {
      if (this.qq === owner) this.qq = undefined;
      await this.disposeQqOwner(owner);
      throw error;
    }
    if (generation !== this.qqGeneration || this.disposed) {
      if (this.qq === owner) this.qq = undefined;
      await this.disposeQqOwner(owner);
      return;
    }
    this.pushQqStatus(true, "QQBot 官方网关已连接");
    this.refreshQqTasks();
    this.log.info("QQBot 官方通道已启动（无 bridge / 无外部托管进程）");
  }

  /** 当前 QQ 配置（测试 IO 优先，读失败回默认）。 */
  async currentQqConfig(): Promise<QqConfig> {
    const snapshot = await readQqSettings(this.qqIo());
    const { config } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    return config;
  }

  /** 停掉在飞的扫码会话（幂等；成功/失败/stop 都调用）。 */
  stopQqBotBinding(): void {
    const binding = this.qqbotBinding;
    this.qqbotBinding = null;
    if (this.qq?.qqbot?.bindSession) {
      this.qq.qqbot.bindSession.stop();
      this.qq.qqbot.bindSession = undefined;
    }
    binding?.stop();
  }

  /**
   * 官方扫码绑定：协议 → 会话 → webview 消息 / 凭据落盘 → 启动官方通道。
   * 这条路径完全不碰外部托管进程的下载、端口探测与 manager。
   */
  async startQqBotBind(config: QqConfig): Promise<void> {
    if (this.disposed) return;
    this.stopQqBotBinding();
    const runtime = createQqBotBindRuntime(this.services.qqbotDeps?.bind ?? {});
    this.qqbotBinding = runtime.session;
    this.postManagedStatus({ phase: "checking", message: "正在获取 QQBot 登录二维码" });
    try {
      await runtime.session.start({
        onQr: (dataUrl, expiresAt) => {
          if (this.disposed) return;
          this.postToWebview(sanitizeQrLoginMessage(qrReadyMessage(dataUrl, expiresAt)));
          this.postManagedStatus({ phase: "waiting_login", message: "请用 QQ 扫码绑定机器人" });
        },
        onProgress: (phase) => {
          if (this.disposed) return;
          this.postToWebview(qrProgressMessage(phase));
        },
        onSuccess: (creds) => {
          if (this.disposed) return;
          void this.onQqBotBound(creds, config);
        },
        onFailure: (message) => {
          if (this.disposed) return;
          this.stopQqBotBinding();
          this.postToWebview(qrFailureMessage(message));
        },
      });
    } catch (error) {
      this.stopQqBotBinding();
      this.postToWebview(qrFailureMessage(errorMessage(error)));
    }
  }

  /**
   * 扫码成功：凭据写 SecretStorage → **扫码者 openid 去重写入白名单**（以磁盘
   * 最新值为基准合并，另一个窗口新增的条目与备注不会被内存快照覆盖）→
   * 内存置 enabled → 停扫码 → 重建官方通道 → 首次绑定把 enabled 落盘 →
   * 推已连接回执。
   *
   * **顺序是刻意的**：`writeAll` 走 Workspace 作用域，会触发
   * `onDidChangeConfiguration` 的 QQ 监听；若先落盘再启动，监听会在
   * `this.qq` 还没赋值时并发发起一次启动，而首次绑定时白名单通常还是空的，
   * 那一次启动会被 `allowlist_empty` 拦下（现在降为 warning，但并发启动
   * 本身仍会制造两套现场）。先启动则监听看到的是同一份运行中的配置，
   * `shouldRestartOnPatch` 判定无需重启。
   */
  async onQqBotBound(creds: Parameters<typeof storeQqBotCredentials>[1], config: QqConfig): Promise<void> {
    try {
      const io = this.qqIo();
      const wasEnabled = config.enabled === true;
      await storeQqBotCredentials(io, creds);
      // 扫码者自动入白名单（授权模型 2026-11-17）：官方接口只给 openid，
      // 扫码结果里的 `userOpenid` 就是扫码者本人。不写进去，扫码完仍然谁也
      // 派不了任务。写入刻意在启动通道之前——QqService 持有的就是这份
      // config 对象，通道一起来就能命中。落盘失败不静默：内存里照常放行
      // （本次可用），但如实说明重启后会丢。
      const openid = typeof creds.userOpenid === "string" ? creds.userOpenid.trim() : "";
      if (openid.length > 0) {
        // 与「放行待审核」（handleQqUserAction）同构：以**磁盘最新值**为基准
        // 合并，绝不用内存快照整体覆盖 —— `allowedUsers` 是整体替换语义，
        // 另一个 VSCode 窗口在磁盘上加过的用户（含备注）必须原样保住。
        // 本窗口内存里的条目一并并进去（它们可能来自尚未落盘的放行），但交给
        // `applyQqSettingsPatch` 的只有裸 openid：coerceAllowList 会保留磁盘上
        // 同名条目的 note，内存里从未有过备注意图，不能替用户清空它。
        let users: string[];
        try {
          const fresh = await readQqSettings(io);
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const entry of fresh.allowedUsers) {
            if (seen.has(entry.openid)) continue;
            seen.add(entry.openid);
            merged.push(entry.openid);
          }
          for (const entry of config.allowedUsers) {
            const id = entry.trim();
            if (id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            merged.push(id);
          }
          if (!seen.has(openid)) merged.push(openid);
          users = merged;
        } catch (error) {
          // 读盘失败时**不能**改回「凭内存覆盖磁盘」的旧行为（那正是丢数据的
          // 路径），只在内存态上追加扫码者并如实记录。
          this.log.warn(`QQ 白名单读取失败，仅更新内存白名单：${errorMessage(error)}`);
          users = config.allowedUsers.includes(openid)
            ? config.allowedUsers
            : [...config.allowedUsers, openid];
        }
        config.allowedUsers = users;
        try {
          await applyQqSettingsPatch(io, { allowedUsers: users });
        } catch (error) {
          this.log.warn(`QQ 白名单写入失败：${errorMessage(error)}`);
          this.store.sendToast(
            "warning",
            vscode.l10n.t("扫码者未能写入白名单（重启后会丢失）：{0}", errorMessage(error)),
          );
        }
      } else {
        // 没有 openid 就无法自动授权：如实记日志，绝不假装已授权。
        this.log.warn("扫码结果没有 userOpenid，未自动加入白名单");
      }
      // 内存里先置启用：QqService 读的就是这个对象（私聊自由文本任务要求
      // enabled），落盘刻意放在启动之后。
      config.enabled = true;
      // 新凭据建立的新通道拥有完整的失败预算。
      this.qqHealthRestarts = 0;
      this.stopQqBotBinding();
      // 成功即清掉 webview 里的二维码旧帧。`qqLoginQr` 是独立于快照的通道，
      // 宿主不覆盖的话，上一帧 waiting_scan 会连同倒计时一直挂着（用户实测：
      // 底部已显示「已连接 QQBot 官方网关」，中间仍是大二维码 +「剩余 40s」）。
      // 空 dataUrl 过不了 isQrDataUrl，因此 webview 侧也不会把它送进 <img>。
      this.postToWebview(buildConfirmedQrMessage());
      if (this.qq) await this.stopQq();
      await this.startQqBotChannel(config, io, this.qqGeneration);
      if (!wasEnabled) {
        // 首次绑定自动开启远程任务。写失败不能谎报成功：通道已经连上，
        // 只是开关没落盘，明确让用户手动打开。
        try {
          await applyQqSettingsPatch(io, { enabled: true });
        } catch (error) {
          this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
          this.store.sendToast(
            "warning",
            vscode.l10n.t("已连接，但无法自动开启远程任务，请手动打开开关"),
          );
        }
      }
      this.postManagedStatus({ phase: "logged_in", message: "QQBot 绑定成功，官方网关已连接" });
      // 连接状态显式再推一次：startQqBotChannel 成功路径已推过，这里保证即便
      // 该路径因代际变化提前返回、只要本面板仍持有通道，webview 也拿到已连接。
      if (this.qq) this.pushQqStatus(true, "QQBot 官方网关已连接");
      await this.deps.pushQqSettings();
    } catch (error) {
      this.stopQqBotBinding();
      this.postToWebview(qrFailureMessage(errorMessage(error)));
    }
  }

  // --- 一键托管 / 窗口内扫码（Wave5-C）------------------------------------

  /** QQ 设置 IO：测试注入优先，否则用真实 vscode 实现。 */
  qqIo(): QqSettingsIo {
    return this.services.qqSettingsIo ?? createVscodeQqSettingsIo(this.context.secrets);
  }

  /** 扫码阶段 → qqManagedStatus（message 过 token 脱敏）。 */
  postManagedStatus(status: Parameters<typeof toManagedStatusMessage>[0], token?: string): void {
    if (this.disposed) return;
    this.postToWebview(toManagedStatusMessage(status, token));
  }

  /** qqManagedSetup 消息入口：QQBot 单一路径，start 走官方扫码、stop 停扫码会话。 */
  async handleQqManagedSetup(action: "start" | "stop"): Promise<void> {
    if (action === "stop") {
      this.stopQqBotBinding();
      if (!this.disposed) {
        this.postToWebview({ type: "qqManagedStatus", phase: "idle", message: "QQBot 扫码已停止" });
      }
      return;
    }
    const config = await this.currentQqConfig();
    await this.startQqBotBind(config);
  }

  /** 停掉整条通道（QQBot adapter → 服务），每一项都有 2s 上限。 */
  async stopQq(): Promise<void> {
    // 任何停止意图都必须让在飞的启动失效 —— 哪怕这次因为已有停止在进行而
    // 直接返回：那个慢启动不能在 stop 之后把一份陈旧通道装回 this.qq。
    const generation = ++this.qqGeneration;
    // F6：停通道 = 立刻放手主会话注入。只 abort 服务信号不够 —— 已经开始的
    // ACP 回合不会被它打断，会继续流式跑完且 QQ 早已停止、收不到结果。这里
    // 对「当前真正跑在主会话上的那一轮」发 session/cancel，并撤掉所有等待者。
    this.deps.cancelAllQqMainInjections();
    this.stopQqBotBinding();
    if (this.qqStopping) return;
    this.qqStopping = true;
    try {
      if (this.qqRestartTimer) {
        clearTimeout(this.qqRestartTimer);
        this.qqRestartTimer = null;
      }
      const owner = this.qq;
      this.qq = undefined;
      if (!owner) return;
      await this.disposeQqOwner(owner);
      // 拆旧 owner 是异步的（socket 关闭 + 服务停止），期间可能有一条新通道
      // 已经装回 this.qq，或又有一次 stop 把 generation 推进。那一刻再清空
      // 看板/推「已停止」，就会把**新通道**的看板抹掉。
      if (
        this.disposed ||
        generation !== this.qqGeneration ||
        this.qq !== undefined
      ) {
        return;
      }
      // 显式停用：清空看板投影并推一次（不留幽灵条目）。被动刷新
      // （refreshQqTaskProjection 的 onChanged 竞态）不经过这里、也不会清空。
      setQqTasks(this.store.getState(), []);
      this.store.pushSnapshot();
      this.pushQqStatus(false, "QQ 通道已停止");
    } finally {
      this.qqStopping = false;
    }
  }

  /**
   * 只拆**这一份** owner（QQBot adapter → 服务）。
   *
   * 与 stopQq 分开是为了「启动途中被停用」那条路径：那时 `this.qq` 可能已经
   * 属于另一份现场（或已被 stopQq 清空），我们不能用 stopQq 去动它，只能把
   * 自己造出来的这份拆干净。
   */
  async disposeQqOwner(owner: QqRuntime): Promise<void> {
    // 关 adapter（socket + 心跳）；扫码会话由 stopQqBotBinding 负责停。
    this.stopQqBotBinding();
    await this.raceQqTeardown(owner.qqbot.adapter.close());
    await this.raceQqTeardown(owner.service.stop());
  }

  /** 单项收尾的硬上限：一个卡住的 socket 不能拖住窗口关闭。 */
  async raceQqTeardown(work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, QQ_BRIDGE_STOP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async restartQq(): Promise<void> {
    // 先等在飞的启动落定：否则 startQqIfEnabled 会把它那个（即将被作废的）
    // promise 直接还给我们，重启就成了空转。
    const inFlight = this.qqStarting;
    if (inFlight) await inFlight.catch(() => undefined);
    await this.stopQq();
    await this.startQqIfEnabled();
  }

  /**
   * 面板重新可见时的一次静默健康检查。
   *
   * `op=9 invalid session` 之后 adapter 只是丢掉了会话，socket 可能仍显示
   * connected 且永远不会再收到事件 —— 只看 `connected` 会一直「正常」。
   * 这里按 health.detail 判定失活，并触发一次有限重启。
   */
  async checkQqChannelHealth(): Promise<void> {
    if (this.disposed) return;
    const adapter = this.qq?.qqbot?.adapter;
    if (!adapter) return;
    let health: { connected: boolean; detail?: string };
    try {
      health = await adapter.health();
    } catch (error) {
      this.log.warn(`QQ 通道健康检查失败：${errorMessage(error)}`);
      return;
    }
    if (this.disposed || this.qq?.qqbot?.adapter !== adapter) return;
    if (isQqHealthHealthy(health)) {
      this.qqHealthRestarts = 0;
      return;
    }
    const detail =
      typeof health.detail === "string" && health.detail.trim().length > 0
        ? health.detail.trim()
        : "unknown";
    this.pushQqStatus(false, detail);
    await this.recoverQqChannel(detail);
  }

  /**
   * 失活后的恢复：**有限次**自动重启（{@link QQ_HEALTH_RESTART_LIMIT}），
   * 用尽后如实要求重新扫码，绝不无限重启。
   *
   * 返回是否恢复出一条活着的通道。
   */
  async recoverQqChannel(detail: string): Promise<boolean> {
    if (this.disposed) return false;
    // 正在绑定 / 启动 / 停止：这些路径自己会收尾，别抢。
    if (this.qqbotBinding || this.qqChannelStarting || this.qqStopping) return false;
    if (this.qqHealthRestarts >= QQ_HEALTH_RESTART_LIMIT) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("QQ 通道已失活且自动重启次数已用尽，请重新扫码绑定"),
      );
      this.pushQqStatus(false, "QQ 通道已失活，请重新扫码绑定");
      return false;
    }
    this.qqHealthRestarts += 1;
    this.log.warn(
      `QQ 通道健康检查失活（${detail}），尝试自动重启（${this.qqHealthRestarts}/${QQ_HEALTH_RESTART_LIMIT}）`,
    );
    try {
      await this.restartQq();
    } catch (error) {
      this.log.warn(`QQ 通道自动重启失败：${errorMessage(error)}`);
    }
    const alive = !this.disposed && this.qq !== undefined;
    if (alive) {
      this.store.sendToast(
        "info",
        vscode.l10n.t("QQ 通道已失活，已自动重启一次；若仍无法收发消息，请重新扫码绑定"),
      );
      this.pushQqStatus(true, "QQ 通道已重启");
    } else {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("QQ 通道已失活且无法自动恢复，请重新扫码绑定"),
      );
      this.pushQqStatus(false, "QQ 通道已失活，请重新扫码绑定");
    }
    return alive;
  }

  /** 500ms 防抖的整服务重启（settings.json 一次编辑会触发多帧事件）。 */
  scheduleQqRestart(): void {
    if (this.qqRestartTimer) clearTimeout(this.qqRestartTimer);
    this.qqRestartTimer = setTimeout(() => {
      this.qqRestartTimer = null;
      if (this.disposed) return;
      void this.restartQq().catch((error: unknown) => {
        const detail = errorMessage(error);
        this.log.warn(`QQ 服务重启失败：${detail}`);
        this.store.sendToast("warning", vscode.l10n.t("QQ 服务重启失败：{0}", detail));
      });
    }, QQ_SETTINGS_RESTART_DEBOUNCE_MS);
    this.qqRestartTimer.unref?.();
  }

  // --- QQ 入口校验工具 -------------------------------------------------------
  //
  // 收敛到 QQBot 单一路径后，入站消息由 setEventCallback 直接给出已归一化的
  // InboundMessage，下面两个校验工具不再被 live 路径调用；保留为 public 供
  // 既有接线测试使用。

  isQqRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  isQqTaskAction(value: unknown): value is QqTaskAction {
    return (
      value === "approve" ||
      value === "deny" ||
      value === "answer" ||
      value === "stop" ||
      value === "merge" ||
      value === "discard" ||
      value === "refresh"
    );
  }

  /**
   * 把 wire 上的入站消息收敛成 `InboundMessage`。
   *
   * bridge 是另一个进程：坏帧不能用 `as` 硬转 —— 缺 `attachments` 会让服务
   * 在 `.map` 上直接抛错。这里逐字段兜底，`mentionsBot` 只在明确为 true 时算
   * true（无法证明被 @ 就不算，群聊会因此静默丢弃，这是安全的一侧）。
   */
  coerceQqInboundMessage(value: unknown): InboundMessage | null {
    if (!this.isQqRecord(value)) return null;
    const chatType = value["chatType"];
    if (chatType !== "private" && chatType !== "group") return null;
    const chatId = value["chatId"];
    const senderId = value["senderId"];
    const msgId = value["msgId"];
    const text = value["text"];
    if (
      typeof chatId !== "string" ||
      typeof senderId !== "string" ||
      typeof msgId !== "string" ||
      typeof text !== "string"
    ) {
      return null;
    }
    const rawAttachments = value["attachments"];
    const attachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter(
          (item): item is InboundMessage["attachments"][number] =>
            this.isQqRecord(item) &&
            (item["kind"] === "image" || item["kind"] === "file"),
        )
      : [];
    const timestamp = value["timestamp"];
    return {
      chatType,
      chatId,
      senderId,
      msgId,
      text,
      mentionsBot: value["mentionsBot"] === true,
      attachments,
      timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  }

  // --- QQ 宿主端口（QqServiceHost 的实现在这里） -----------------------------

  /**
   * 把面板能力映射成 `QqHostPorts`。
   *
   * 取消 / 合并 / 丢弃全部复用既有的 Super Agent 方法（`cancel` /
   * `requestSuperMerge` / `cleanup`），本模块**不写第二套 git 逻辑**。
   */
  createQqHostPorts(): QqHostPorts {
    return {
      workspaceRoots: () => this.qqWorkspaceRoots(),

      spawnTask: (spec, opts) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("超流不可用（未打开工作区）");
        const session = manager.spawn(
          { title: spec.title, task: spec.task },
          {
            policy: {
              approval: opts.approval,
              disallowedTools: opts.disallowedTools,
              onPermissionRequest: opts.onPermission,
            },
          },
        );
        // spawn 是同步登记：worktree 与分支在 prepare 里才落地，此刻可能还
        // 没有 branch / path —— 缺省即可，最终结果由 readSuper 里的快照补齐。
        const isolation = session.isolation;
        const branch = isolation.branch;
        const worktreePath =
          isolation.kind === "git_worktree" && isolation.path ? isolation.path : undefined;
        return {
          superSessionId: session.id,
          ...(branch ? { branch } : {}),
          ...(worktreePath ? { worktreePath } : {}),
        };
      },

      /**
       * 等子会话收尾。
       *
       * **为什么是轮询**：`SuperAgentManager` 只暴露一个 `onSessionsChanged`
       * 回调（面板已经用来把投影写进 store），没有按订阅者分发的事件面；
       * 为 QQ 通道去改它的公开接口会把「一次 emit → N 个监听」的生命周期
       * 复杂度带进管理层。轮询 store 里的投影是零侵入的那条路。
       *
       * 上限：调用方（适配器）本来就有 2h 兜底；这里再封一层，保证即便被
       * 单独调用也不会永远挂着。子会话曾被看到、之后又消失 = 被清理，直接
       * 返回；从未被任何一方看到 = id 无效，抛错让服务记 failed。
       */
      waitForSettle: async (superSessionId, timeoutMs) => {
        const cap =
          typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.min(timeoutMs, QQ_DEFAULT_SETTLE_TIMEOUT_MS)
            : QQ_DEFAULT_SETTLE_TIMEOUT_MS;
        const deadline = Date.now() + cap;
        let appeared = false;
        for (;;) {
          const session = this.findQqSuperSession(superSessionId);
          if (session) {
            appeared = true;
            if (isQqTerminalSuperStatus(session.status)) return;
          } else if (appeared) {
            return;
          } else if (!this.getSuperAgent()?.get(superSessionId)) {
            throw new Error(`QQ 任务指向的超流体不存在：${superSessionId}`);
          }
          const remain = deadline - Date.now();
          if (remain <= 0) throw new QqSettleTimeoutError(superSessionId, cap);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(QQ_SETTLE_POLL_MS, remain));
            timer.unref?.();
          });
        }
      },

      cancel: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("超流不可用（未打开工作区）");
        // 对已终态的子会话再取消是幂等重复，管理器自己会如实返回。
        await manager.cancel(superSessionId, "agent");
      },

      /**
       * 合并回当前分支。
       *
       * 合并由**专用合并子会话**在主仓工作区里执行（冲突需要有人读代码），
       * 因此这是一个异步动作：派发成功也只回报「已派出」，合并结果稍后写进
       * 看板的 integration。**绝不**在这里谎报 ok=true；`requestSuperMerge`
       * 没派出子会话时必须把真实原因回给 QQ（排队 / 主会话忙 / 已有合并在跑）。
       */
      merge: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) return { ok: false, detail: "超流不可用（未打开工作区）" };
        const session = manager.get(superSessionId);
        if (!session) return { ok: false, detail: "超流体不存在或已被清理" };
        if (session.integration?.state === "merged") {
          return { ok: true, detail: "改动已经在当前分支上" };
        }
        if (!isQqTerminalSuperStatus(session.status)) {
          return { ok: false, detail: "超流体还没结束，完成后再合并" };
        }
        if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
          return { ok: false, detail: "该超流体没有可合并的分支（仅目录隔离）" };
        }
        const outcome = await this.requestSuperMerge(superSessionId);
        if (outcome.dispatched) {
          return {
            ok: false,
            detail: "已派出合并超流体（异步执行），合并结果稍后在看板确认",
          };
        }
        if (outcome.queued) {
          return { ok: false, detail: `合并请求已排队，空闲后自动派发：${outcome.reason}` };
        }
        return { ok: false, detail: outcome.reason };
      },

      discard: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("超流不可用（未打开工作区）");
        // 如实回传 cleanup 的观测：分支还带未合并提交时 git 会保下分支
        // （只删工作目录），QQ 回执与看板都要把这件事说清楚。
        const result = await manager.cleanup(superSessionId, { keepBranch: false });
        return {
          ok: result.ok,
          ...(result.branchKept === true ? { branchKept: true } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        };
      },

      readSuper: (superSessionId) => {
        const session = this.findQqSuperSession(superSessionId);
        if (!session) return null;
        const snapshot: QqHostSuperSnapshot = { status: session.status };
        const lastReport =
          session.reports.length > 0 ? session.reports[session.reports.length - 1] : undefined;
        // 「最后一条汇报」优先；没有汇报时退回会话摘要。都取不到就不填 ——
        // 适配器会用占位文案，绝不编造内容。
        const summary = (lastReport?.summary ?? session.summary ?? "").trim();
        if (summary.length > 0) snapshot.summary = summary;
        const branch = session.isolation.branch;
        if (branch) snapshot.branch = branch;
        // worktree 路径同样只在「真的还有目录」时给：released / recycled 表示
        // 目录已经被清理，回传一个磁盘上不存在的路径只会误导合并/丢弃兜底。
        const isolation = session.isolation;
        if (
          isolation.kind === "git_worktree" &&
          isolation.path &&
          isolation.released !== true &&
          isolation.recycled !== true
        ) {
          snapshot.worktreePath = isolation.path;
        }
        if (session.integration) snapshot.merged = session.integration.state === "merged";
        return snapshot;
      },

      injectIntoMain: (input) => this.injectQqMainTurn(input),
      cancelMainInjection: (taskId) => this.cancelQqMainInjection(taskId),

      /**
       * 把 QQ 用户的回答送回远程子会话。`SuperAgentManager.respond` 会命中该
       * 子会话挂起的 `_iflow/user/questions` 并让 agent 继续；已超时 / 已回答
       * 时返回 false，服务侧据此如实回执。
       */
      answerRemoteQuestion: (superSessionId, answers) => {
        const manager = this.getSuperAgent();
        return manager ? manager.respond(superSessionId, { answers }) : false;
      },

      /**
       * main 渠道任务的回答回灌：按 taskId 命中本注入回合的提问卡。超时 / 停止
       * 时服务送来空答案（按未回答继续），语义与本地提问卡一致。
       */
      answerMainQuestion: (taskId, answers) => this.answerQqMainQuestion(taskId, answers),

      notify: (text) => {
        if (this.disposed) return;
        this.store.sendToast("info", text);
      },

      deliver: async (msg) => {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) return { ok: false }; // 入口防御：通道未起 / 未绑定
        return deliverViaQqBotAdapter(adapter, msg);
      },

      onPendingUser: (info) =>
        this.handleQqPendingUser(info).catch((error: unknown) => {
          this.log.warn(`QQ 待审核记录写入失败：${errorMessage(error)}`);
          // 写失败 = 未记入：如实回报 dropped，服务侧不得虚称「已记入」。
          return { dropped: true };
        }),
      unbindAccount: () => this.unbindQqAccount(),
    };
  }

  // --- QQ 主会话渠道（QQ 消息固定去向）---------------------------------------

  /**
   * 把一条 QQ 消息注入主会话，等那一轮结束，返回该轮 assistant 正文。
   *
   * 四条硬纪律：
   *  1. **remotePolicy 闸门**：与 child 渠道走同一个 `qqSpawnPolicyFor` 判定，
   *     readonly 策略下主会话渠道（无法保证只读）一律拒绝注入；
   *  2. **等空闲再投**：`mainSessionFree()` 是 sendPrompt 自己那道门的镜像
   *     （status / initializing / replaying / historySync / mainLane），所以
   *     不会与本地回合或宿主回合并发跑在同一 ACP 会话上；
   *  3. **转录可区分**：正常 user 气泡（`hidden:false`）+ `origin:"qq"` 徽标；
   *     模型看到的是带来源包裹的正文（服务生成），本机用户看到的是原文；
   *  4. **轮次锚定**：记下回合开始时的 sessionId 与末尾可见 text 块的稳定 id，
   *     结束时 sessionId 必须一致、锚块必须仍在，只取锚块之后的 assistant 文本
   *     —— 上一轮、后续轮次与「会话被替换后的无关文本」都不会被回给 QQ。
   *
   * 忙（撞上本地回合刚抢到车道）时不会失败：短暂等待后重试，直到超时上限。
   * 排队等空闲期间被 `/qq stop` 打断就返回 canceled，由服务侧收尾。
   */
  async injectQqMainTurn(input: QqMainInjectInput): Promise<QqMainInjectResult> {
    // 远程接续断开门：只有「已断开远程接管」的会话才拒绝 QQ 注入。接管期间
    // （start）QQ 消息照常进入会话、agent 继续执行；门是会话级的，机器人仍
    // 可把其它会话的任务注入它们自己的主会话。
    if (this.isQqRemoteDetachedFor(this.store.getState().sessionId)) {
      return {
        injected: false,
        reason: "当前会话已断开远程接续，QQ 消息不再注入本地。",
      };
    }
    const taskId = input.task.taskId;
    // F1：main 渠道跑在用户自己的主会话里，不能像 child 那样剔除写工具。
    // 与 child 走同源策略判定：readonly（deny）一律拒绝，绝不注入。
    if (qqSpawnPolicyFor(input.task.policy.remotePolicy).approval === "deny") {
      return {
        injected: false,
        reason: "当前远程策略为只读，主会话渠道无法保证只读约束，任务未注入。请改用 child 渠道或调整远程策略。",
      };
    }
    const controller = new AbortController();
    const onServiceAbort = (): void => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onServiceAbort, { once: true });
    this.qqInjectAborts.set(taskId, controller);

    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    // 本轮是否真的把任务派给了子会话：finally 也要据此决定是否撤销预登记的
    // 等最终答复记账，因此必须在 try 之外声明。
    let delegated = false;
    try {
      // 阶段一：等主会话空闲（被取消 / 超时都如实返回，绝不硬塞）。
      const free = await this.deps.waitForQqMainFree(controller.signal, deadline);
      if (free !== "free") {
        return free === "canceled"
          ? { injected: false, canceled: true }
          : {
              injected: false,
              reason: "主会话长时间未空闲，消息未注入（可在主会话空闲后重发）。",
            };
      }

      // 阶段二：发一轮。撞上忙窗口（本地回合先抢到车道）不算失败，等一拍
      // 再来；一旦这一轮真的开始（started），后续只收本轮文本、不再重试。
      while (true) {
        if (this.disposed || controller.signal.aborted) {
          return { injected: false, canceled: true };
        }
        // 等空闲期间会话被断开远程接管（用户关闭接续）：不再把这条 QQ 消息
        // 投进本地。接管中（start）不拦，QQ 照常驱动 agent 继续干活。
        if (this.isQqRemoteDetachedFor(this.store.getState().sessionId)) {
          return {
            injected: false,
            reason: "当前会话已断开远程接续，QQ 消息不再注入本地。",
          };
        }
        if (Date.now() > deadline) {
          return {
            injected: false,
            reason: "主会话长时间未空闲，消息未注入（可在主会话空闲后重发）。",
          };
        }

        // 轮次锚点：sessionId + 「基线末尾那一个可见 text 块的稳定 id」。
        // 基线口径与取结果口径一致（都排除 system 块），避免数量错位；块 id
        // 让「会话被替换后同样数量的文本」也能被识别成串包而非本轮结果。
        const before = this.store.getState();
        const sessionIdBefore = before.sessionId;
        const visibleTextBefore = before.blocks.filter(
          (block) => block.kind === "text" && !block.system,
        );
        const textCountBefore = visibleTextBefore.length;
        const anchorBlock = visibleTextBefore[visibleTextBefore.length - 1];
        const anchorId = anchorBlock?.id;
        const anchorLen = anchorBlock?.kind === "text" ? anchorBlock.text.length : 0;

        let started = false;
        // 子会话基线：这一轮开始时该主会话已有的子会话 id。轮末若出现新 id，
        // 说明主 Agent 把任务派了出去 —— 本轮文本只是「已安排」的占位，真正
        // 答复要等子会话汇报汇总轮（见 delegated / qqMainFinalAwaiters）。
        let superIdsBefore: ReadonlySet<string> = new Set();
        await this.sendPrompt(input.text, undefined, undefined, undefined, {
          // 宿主驱动回合：不改会话标题、不拍 checkpoint（QQ 正文不写进
          // 会话标签/工作区快照）；但**不 hidden** —— 转录里要有用户气泡。
          internal: true,
          delegateOnBusy: false,
          quietBusy: true,
          origin: "qq",
          displayText: input.displayText,
          onTurnStarted: async () => {
            started = true;
            this.qqInjectedTaskId = taskId;
            // 先登记再发：汇报轮可能在注入轮收尾的同一拍就被仲裁投递，记账
            // 必须在这之前存在。轮末若确认没派生子会话会撤销（见 finally）。
            if (sessionIdBefore) {
              this.qqMainFinalAwaiters.set(taskId, sessionIdBefore);
              this.qqMainFinalAwaiterSince.set(taskId, Date.now());
              // 新一轮开始：清掉上一轮遗留的补发缓存，避免迟到补发误用旧结论。
              this.qqFinalRescueText.delete(sessionIdBefore);
              this.qqReportFallbackText.delete(sessionIdBefore);
              this.qqFinalRescueDefers.delete(taskId);
              this.qqFinalRescueProgressAt.delete(taskId);
              this.qqTaskFinalText.delete(taskId);
              this.ensureQqFinalRescueTimer();
            }
            superIdsBefore = new Set(
              (this.getSuperAgent()?.list() ?? [])
                .filter((s) => (s.mainSessionId ?? sessionIdBefore) === sessionIdBefore)
                .map((s) => s.id),
            );
            await input.onInjected();
          },
        });

        if (!started) {
          // 车道被别的回合抢走（本地回合优先）：等下一拍重试。
          await this.waitForMainFreeTick(controller.signal, deadline);
        } else {
          // 这一轮真的跑过：无论成败，结果都属于它。
          const state = this.store.getState();
          // F5：会话在回合中被替换（切会话 / 新会话 / 恢复）时基线来自旧会话，
          // 结果读自新会话 —— 绝不把无关文本当成本轮结果回给 QQ。
          if (state.sessionId !== sessionIdBefore) {
            return {
              injected: true,
              text: "",
              failed: true,
              reason: "会话在本轮执行期间被切换，未能取回本轮结果。",
            };
          }
          const { text: resultText, anchorLost } = this.extractQqTurnTextFromAnchor(
            anchorId,
            anchorLen,
            textCountBefore,
          );
          if (anchorLost) {
            // 基线锚块消失（转录被清空/重排）：同样不能安全地按数量切片。
            return {
              injected: true,
              text: "",
              failed: true,
              reason: "本轮转录基线已失效，未能取回本轮结果。",
            };
          }
          const text = resultText;
          const failed = state.status === "error";
          // 本轮是否派生了子会话（相对轮初基线出现新 id）。派生了就把本任务
          // 登记为「等最终答复」：这一轮文本只是占位，真正的答复将在子会话
          // 汇报汇总轮结束时经 completeMainFinalAnswer 回传 QQ。
          if (!failed && sessionIdBefore) {
            // R3：子会话的登记（onSessionsChanged → list()）可能与回合收尾差错一拍，
            // 立刻判定会把「已派子会话」误判成直答、在 finally 里提前摘掉 awaiter。
            // 留一个很短的宽限期再核对一次（不阻塞主机、只延迟本轮结果一小段）。
            if (this.qqDelegationGraceMs > 0 && !controller.signal.aborted) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, this.qqDelegationGraceMs),
              );
            }
            delegated = (this.getSuperAgent()?.list() ?? []).some(
              (s) =>
                (s.mainSessionId ?? sessionIdBefore) === sessionIdBefore &&
                !superIdsBefore.has(s.id),
            );
            this.log.info(
              `QQ 注入轮 delegated 判定：task=${taskId} delegated=${delegated} baseline=${superIdsBefore.size} current=${this.getSuperAgent()?.list().length ?? 0}`,
            );
          }
          // 中间正文轮同步：派生子会话的注入轮，其 assistant 正文只是「已安排」
          // 的占位说明，永远不会被当成最终结果（真正答复在汇报汇总轮经
          // completeMainFinalAnswer 回传）。这里把这段正文作为进度文本转发一次，
          // 让 QQ 发起者看到主会话真实说了什么。直答轮（未派生）不转发 —— 那段
          // 正文马上由 finalizeMainTask 作为最终结果投递，再转一次就是重复。
          if (delegated && !failed) {
            void this.deliverQqMainIntermediateText(sessionIdBefore, text, [taskId]);
          }
          return {
            injected: true,
            text,
            ...(state.stopReason ? { stopReason: state.stopReason } : {}),
            ...(delegated ? { delegated: true } : {}),
            ...(failed
              ? { failed: true, reason: state.errorMessage ?? "主会话本轮执行失败。" }
              : {}),
          };
        }
      }
    } finally {
      // 只有确认派生了子会话才保留记账等最终答复；其余（未派生 / 失败 /
      // 会话切换 / 取消 / 注入未成功）一律撤销，避免迟到的汇报回错任务。
      if (!delegated) {
        this.qqMainFinalAwaiters.delete(taskId);
        this.qqMainFinalAwaiterSince.delete(taskId);
        this.qqFinalRescueDefers.delete(taskId);
        this.qqFinalRescueProgressAt.delete(taskId);
        this.qqTaskFinalText.delete(taskId);
      }
      if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
      this.qqInjectAborts.delete(taskId);
      if (this.qqInjectedTaskId === taskId) this.qqInjectedTaskId = null;
      input.signal.removeEventListener("abort", onServiceAbort);
    }
  }

  /**
   * 子会话汇报**汇总轮**（pendingCount=0）结束时，把结论回传给对应的 QQ 任务。
   *
   * 按 task 归属投递：同一主会话可叠加多条 QQ 消息、各自派生子会话，绝不能把
   * 一轮汇总结论广播给该会话所有 awaiter（那正是「摘要相同、taskId 不同」的
   * 重复卡根因）。每个任务取自己派生子会话的汇报正文（qqTaskFinalText），取
   * 不到且会话里还有别的 awaiter 时走如实兜底、绝不共享别人的结论；单任务
   * 或 R2 精确补发（onlyTaskIds）时沿用本轮文本 / `fallbackText` / 空文本兜底。
   * 无论哪条路径都摘除记账，不让 QQ 停在「已受理」（R1）。单次投递 / 幂等由
   * 服务的 resultDeliveredAt 保证；补发与汇总轮命中同一 task 时靠「删 awaiter
   * + resultDeliveredAt」双保险避免各投一次。
   */
  async deliverQqMainFinalAnswer(
    sessionId: string | null,
    rawText: string,
    stopReason: string,
    onlyTaskIds?: ReadonlySet<string>,
    fallbackText?: string,
    source: QqAnswerDeliverySource = "final-report",
  ): Promise<void> {
    if (this.disposed || !sessionId) return;
    const honestFallback = vscode.l10n.t(
      "超流体任务已完成，但未产生可转发的正文摘要。",
    );
    // R1：汇总轮可能只调了合并/复核动作而没有 assistant 正文。旧实现在这里
    // 静默 return 且不摘记账 —— QQ 永远停在「已受理」。改为如实兜底：摘除记账
    // 并回传一条明确文案（走 completeMainFinalAnswer 的 forceActive 主动消息，
    // 长任务下也真能发出），绝不伪造「已完成」之类内容。
    //
    // 2026-11-19：二次转述确为空时优先用宿主已持有的子会话汇报正文
    // （report.summary），让用户看到子会话实际做了什么；只有连汇报正文也为空
    // 才退回占位文案。清洗后文本必为非空，服务侧不会再追加一条占位通知。
    const cleanFallback = sanitizeQqReportFallback(fallbackText);
    const sessionTaskIds = [...this.qqMainFinalAwaiters.entries()]
      .filter(([, owner]) => owner === sessionId)
      .map(([taskId]) => taskId);
    const taskIds = sessionTaskIds.filter((taskId) =>
      onlyTaskIds ? onlyTaskIds.has(taskId) : true,
    );
    // 多任务叠加时禁止广播：只有「单任务（无歧义）」或「R2 精确补发」才可沿用
    // 本轮共享结论；其余每个 awaiter 只取自己那份归属正文，取不到就如实兜底，
    // 绝不把别人的汇总结论投给它（重复卡根因）。
    const shareable = onlyTaskIds !== undefined || sessionTaskIds.length <= 1;
    for (const taskId of taskIds) {
      const own = this.qqTaskFinalText.get(taskId)?.trim() ?? "";
      // 单任务：主 Agent 汇总正文 > 归属正文 > 汇报正文兜底 > 如实占位。
      // 多任务：只用自己那份归属正文，缺则如实占位（不共享汇总/兜底正文）。
      const answer = shareable
        ? rawText.trim() || own || cleanFallback || honestFallback
        : own || honestFallback;
      this.qqMainFinalAwaiters.delete(taskId);
      this.qqMainFinalAwaiterSince.delete(taskId);
      this.qqFinalRescueDefers.delete(taskId);
      this.qqFinalRescueProgressAt.delete(taskId);
      this.qqTaskFinalText.delete(taskId);
      try {
        await this.qq?.service.completeMainFinalAnswer({ taskId, text: answer, stopReason });
      } catch (error) {
        this.log.warn(`QQ 主会话最终答复回传失败：${errorMessage(error)}`);
        continue;
      }
      // 可观测：QQ 收到的到底是哪一段、走的哪条通道 —— 归档一条投递事件。
      void this.appendQqArchiveEvent("task_answer_delivered", taskId, {
        owner: sessionId,
        source,
        chars: answer.length,
        fingerprint: qqTextFingerprint(answer),
        stopReason,
      });
    }
    // 该会话已无 awaiter：清掉补发缓存，避免下一条任务误用上一轮的旧结论。
    if (![...this.qqMainFinalAwaiters.values()].includes(sessionId)) {
      this.qqFinalRescueText.delete(sessionId);
      this.qqReportFallbackText.delete(sessionId);
    }
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
  }

  /** 该归属会话是否还有 QQ awaiter（决定是否值得缓存汇报正文供补发）。 */
  qqFinalRescueOwnerPending(owner: string): boolean {
    return [...this.qqMainFinalAwaiters.values()].includes(owner);
  }

  /**
   * 该归属会话是否存在已等过软阈值的 QQ awaiter（R2 汇报轮**放宽提示词**的依据）。
   *
   * 注意口径：它只回答「这个会话的 QQ 发起者等太久了，该让模型这一轮就给结论」，
   * **不**回答「可以定终局了」—— 定终局只发生在真的没有活跃子会话时（见
   * {@link rescueStaleQqFinalAwaiters}）。等待过久绝不等价于定终局
   * （2026-11-19 修复）。
   */
  qqFinalRescueDue(owner: string | null): boolean {
    if (!owner) return false;
    const now = Date.now();
    for (const [taskId, taskOwner] of this.qqMainFinalAwaiters.entries()) {
      if (taskOwner !== owner) continue;
      const since = this.qqMainFinalAwaiterSince.get(taskId) ?? now;
      if (now - since >= this.qqFinalRescueMs) return true;
    }
    return false;
  }

  /**
   * 某个归属主会话当前**仍在跑**（非终态）的子会话数量。
   *
   * 补发判定与软阈值口径必须一致：只有「没有子会话在跑」才谈得上定终局；
   * 仍有子会话在跑时，任何补发都只能降级成进度措辞（2026-11-19 修复）。
   */
  qqActiveChildrenCount(owner: string | null): number {
    if (!owner) return 0;
    const live = this.getSuperAgent()?.list() ?? [];
    return live.filter(
      (session) =>
        (session.mainSessionId ?? owner) === owner && !isTerminalSuperStatus(session.status),
    ).length;
  }

  /** 某个归属会话的 QQ awaiter 已经等了多久（取最久的那一个）。 */
  qqFinalRescueWaitedMs(owner: string | null): number {
    if (!owner) return 0;
    const now = Date.now();
    let waited = 0;
    for (const [taskId, taskOwner] of this.qqMainFinalAwaiters.entries()) {
      if (taskOwner !== owner) continue;
      const since = this.qqMainFinalAwaiterSince.get(taskId) ?? now;
      waited = Math.max(waited, now - since);
    }
    return waited;
  }

  /**
   * 写一条 QQ 归档事件（events.ndjson）。
   *
   * 可观测性要求：「QQ 收到的是这一段」事后要能查出来 —— 谁在什么时候因为
   * 等太久而让路 / 降级成进度，最终那一段正文又是从哪条通道投出去的。
   * 事件类型：
   *  - `task_final_rescue_deferred`：补发被让路或降级（带 defers / waited /
   *    activeChildren / reason）；
   *  - `task_answer_delivered`：一次正文投递（带 source：final-report 汇报
   *    汇总轮 / rescue 迟到补发 / intermediate 中间正文，以及 chars /
   *    fingerprint 便于核对「就是这一段」）。
   *
   * 口径说明：`task_answer_delivered` 记的是**面板把这段正文交给了投递通道**
   * 这一事实；通道侧的真实投递失败由服务自己的归档事件记录
   * （`task_progress_undelivered` / `task_result_undelivered`），两者合起来
   * 才是完整链路。
   *
   * 归档失败绝不影响主链路：只记日志，不抛错。
   */
  async appendQqArchiveEvent(
    type: string,
    taskId?: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const store = this.qq?.store;
    if (!store || typeof store.appendEvent !== "function") return;
    try {
      await store.appendEvent({
        type,
        ts: Date.now(),
        ...(taskId ? { taskId } : {}),
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      this.log.warn(`QQ 归档事件写入失败（${type}）：${errorMessage(error)}`);
    }
  }

  /** 迟到补发定时器：仅在有 awaiter 时存活，避免无谓唤醒宿主。 */
  ensureQqFinalRescueTimer(): void {
    if (this.disposed || this.qqFinalRescueTimer) return;
    const timer = setInterval(() => this.rescueStaleQqFinalAwaiters(), QQ_FINAL_RESCUE_POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.qqFinalRescueTimer = timer;
  }

  stopQqFinalRescueTimer(): void {
    if (this.qqFinalRescueTimer) {
      clearInterval(this.qqFinalRescueTimer);
      this.qqFinalRescueTimer = null;
    }
  }

  /**
   * R2 迟到补发：等最终答复的 awaiter 若等得太久，别让 QQ 永久停在「已受理」。
   *
   * **等待过久 ≠ 可以定终局**（2026-11-19 修复）：
   *  - 软阈值：已超 qqFinalRescueMs **且本会话已无活跃子会话** → 真的不会再有
   *    更正文了，此时才以「最近一次汇报文本（或兜底）」收尾；
   *  - 硬上限：已超 qqFinalHardRescueMs 但**仍有活跃子会话** → 绝不写终局、
   *    绝不写 resultDeliveredAt，只降级成一条如实的「仍在进行中」进度措辞，
   *    awaiter 保留，等子会话终态后的真·最终汇报轮投递完整正文
   *    （旧实现在这里直接补发，把等太久当成了可以定终局：QQ 只收到 22 字
   *    占位，真实长正文再也投不出去）。
   * 只处理到点的那一个 taskId（onlyTaskIds 过滤），不误伤同会话刚开始的其它 awaiter。
   *
   * 2026-11-19 补发抢跑修复：到点时若本会话的汇报轮正在投递（`superReportRunning`）
   * 或还排在队列里，先让出有限拍数，让 finalReport 收尾投递真实最终正文；抢在它
   * 前面补发会把兜底文案写死、并让随后迟到的真实正文被丢弃。让路有上限（见
   * `QQ_FINAL_RESCUE_MAX_DEFERS`），真正卡死时仍强制处理，绝不永久推迟。
   * 让路与降级都写归档事件（`task_final_rescue_deferred`），事后可查。
   */
  rescueStaleQqFinalAwaiters(): void {
    if (this.disposed || this.qqMainFinalAwaiters.size === 0) return;
    const now = Date.now();
    for (const [taskId, owner] of [...this.qqMainFinalAwaiters.entries()]) {
      const since = this.qqMainFinalAwaiterSince.get(taskId) ?? now;
      const age = now - since;
      // 与软阈值、汇报轮放宽用的是同一口径（qqActiveChildrenCount）。
      const activeChildren = this.qqActiveChildrenCount(owner);
      // 软阈值：到点**且本会话已无活跃子会话** —— 真的不会再有更正文了，才谈得
      // 上定终局。硬上限：到点但子会话仍在跑 —— 只能降级成进度措辞（见下）。
      const softDue = age >= this.qqFinalRescueMs && activeChildren === 0;
      const hardDue = age >= this.qqFinalHardRescueMs;
      if (!softDue && !hardDue) continue;
      // 汇报轮在途 / 排队时先让路：真实最终汇报马上就会由 finalReport 收尾投递。
      const reportInFlight =
        this.superReportRunning ||
        this.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner);
      if (reportInFlight) {
        const defers = (this.qqFinalRescueDefers.get(taskId) ?? 0) + 1;
        if (defers <= QQ_FINAL_RESCUE_MAX_DEFERS) {
          this.qqFinalRescueDefers.set(taskId, defers);
          this.log.info(
            `QQ 最终答复补发让路：task=${taskId} waited=${age}ms activeChildren=${activeChildren} defers=${defers}`,
          );
          void this.appendQqArchiveEvent("task_final_rescue_deferred", taskId, {
            owner,
            reason: "report-in-flight",
            waited: age,
            activeChildren,
            defers,
          });
          continue;
        }
        this.log.warn(
          `QQ 主会话最终答复补发：task=${taskId} 已让出 ${defers - 1} 拍，汇报轮仍未收尾，强制处理`,
        );
      }
      const deferCount = this.qqFinalRescueDefers.get(taskId) ?? 0;
      this.qqFinalRescueDefers.delete(taskId);
      // **子会话仍在跑 → 绝不写终局**（2026-11-19 修复）：旧实现在硬上限这里
      // 直接补发，把「等太久」当成了「可以定终局」—— QQ 收到的是一条空正文
      // 兜底（22 字占位），任务被写成 succeeded、resultDeliveredAt 落盘，
      // awaiter 被摘掉，随后迟到的真实长正文再也投不出去。
      // 现在降级成「仍在进行中」的进度措辞：任务保持 injected，awaiter 保留，
      // 等子会话终态后的真·最终汇报轮投递完整正文。
      if (activeChildren > 0) {
        this.log.warn(
          `QQ 最终答复硬上限到点但仍有活跃子会话：task=${taskId} waited=${age}ms activeChildren=${activeChildren} —— 降级为进度措辞，不定终局`,
        );
        void this.appendQqArchiveEvent("task_final_rescue_deferred", taskId, {
          owner,
          reason: "children-running",
          waited: age,
          activeChildren,
          defers: deferCount,
        });
        void this.deliverQqMainRescueProgress(owner, taskId, activeChildren, age);
        continue;
      }
      this.log.warn(
        `QQ 主会话最终答复迟到补发：task=${taskId} waited=${age}ms activeChildren=${activeChildren}`,
      );
      void this.deliverQqMainFinalAnswer(
        owner,
        this.qqFinalRescueText.get(owner) ?? "",
        "end_turn",
        new Set([taskId]),
        this.qqReportFallbackText.get(owner),
        "rescue",
      );
    }
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
  }

  /**
   * 硬上限到点但子会话仍在跑时的**降级补发**：只发一条如实的「仍在进行中」
   * 进度措辞。
   *
   * 绝不写终局：任务保持 `injected`（服务侧 deliverMainTurnText 本身就只接
   * 非终态任务），不落 resultDeliveredAt，awaiter 保留 —— 子会话终态后的
   * 真·最终汇报轮仍能把完整正文投出去。
   *
   * 措辞必须如实：说清「还有几个子会话没结束、结论会在它们结束后送达」，
   * 绝不说「已完成」。同一任务在 `QQ_FINAL_RESCUE_PROGRESS_MIN_INTERVAL_MS`
   * 内只提醒一次（没有新信息量，连发只会刷屏）。
   */
  async deliverQqMainRescueProgress(
    owner: string | null,
    taskId: string,
    activeChildren: number,
    age: number,
  ): Promise<void> {
    if (this.disposed || !owner) return;
    const now = Date.now();
    const last = this.qqFinalRescueProgressAt.get(taskId);
    if (last !== undefined && now - last < QQ_FINAL_RESCUE_PROGRESS_MIN_INTERVAL_MS) return;
    this.qqFinalRescueProgressAt.set(taskId, now);
    const text = vscode.l10n.t(
      "任务仍在进行中：还有 {0} 个超流体未结束，最终结论会在它们全部完成后送达。",
      String(activeChildren),
    );
    await this.deliverQqMainIntermediateText(owner, text, [taskId]);
    this.log.info(
      `QQ 最终答复降级补发（进行中）：task=${taskId} waited=${age}ms activeChildren=${activeChildren}`,
    );
  }

  /**
   * 从「回合开始时末尾可见 text 块」（锚点）提取本轮新增的 assistant 正文。
   *
   * 流式 `appendTextToLast` 会把新 chunk 就地拼进最后一个 text 块并复用它的 id。
   * hidden 汇报回合没有 user 块做边界，新正文必然被并进锚块；只按 id
   * `slice(anchorIndex + 1)` 会整段丢掉，转发出空摘要（2026-11-19 回归）。因此
   * 锚点除 id 外必须记录回合开始时的块内文本长度：先取锚块 `slice(旧长度)`，
   * 再接锚块之后的新 text 块。system 状态行由 reducer 的合并边界挡开，不会混入。
   *
   * `anchorLost` 供调用方区分「本轮确实没有正文」（text=""）与「转录被清空/重排，
   * 按 id 切片不安全」（anchorLost=true）。此时返回的 text 是按 `fallbackCount`
   * （回合开始时的可见块数）切片的结果；配合汇报正文兜底（finalFallbackText）
   * 仍能给出真实结论，绝不再静默放弃（2026-11-19 补发抢跑 bug）。
   */
  extractQqTurnTextFromAnchor(
    anchorId: string | undefined,
    anchorLen: number,
    fallbackCount: number,
  ): { text: string; anchorLost: boolean } {
    const visible = this.store.getState().blocks.filter(
      (block) => block.kind === "text" && !block.system,
    );
    const countText = (): string =>
      visible
        .slice(fallbackCount)
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n")
        .trim();
    if (anchorId === undefined) return { text: countText(), anchorLost: false };
    const anchorIndex = visible.findIndex((block) => block.id === anchorId);
    if (anchorIndex < 0) return { text: countText(), anchorLost: true };
    const parts: string[] = [];
    const anchor = visible[anchorIndex]!;
    if (anchor.kind === "text") parts.push(anchor.text.slice(anchorLen));
    for (const block of visible.slice(anchorIndex + 1)) {
      if (block.kind === "text") parts.push(block.text);
    }
    return { text: parts.join("\n").trim(), anchorLost: false };
  }

  /** 汇报回合收尾后提取「本轮新增」的 assistant 文本，供迟到补发复用。 */
  captureQqReportTurnText(
    anchorId: string | undefined,
    beforeCount: number,
    anchorLen = 0,
  ): string {
    return this.extractQqTurnTextFromAnchor(anchorId, anchorLen, beforeCount).text;
  }

  /**
   * 把主会话某一轮的 assistant 正文经 QQ 进度通道转发一次。
   *
   * 只投给该归属会话里仍在等最终答复的 QQ 任务 —— `qqMainFinalAwaiters` 就是
   * 权威记账，任务取消 / 通道停止 / 会话切换 / dispose 都会清它，天然不串台；
   * 服务侧再以 status=injected + 独立分支节流 / 指纹去重 + 终态短路作二次防线。
   * 最终汇报轮的正文不走这里（由 {@link deliverQqMainFinalAnswer} 投递），
   * 因此同一段正文绝不会被当成中间正文再发一次。
   */
  async deliverQqMainIntermediateText(
    owner: string | null,
    text: string,
    taskIds?: readonly string[],
  ): Promise<void> {
    if (this.disposed || !owner || !text.trim()) return;
    const service = this.qq?.service;
    // 部分测试夹具只提供最终答复通道：没有中间正文通道就安静跳过，不误伤。
    if (!service || typeof service.deliverMainTurnText !== "function") return;
    const targets =
      taskIds ??
      [...this.qqMainFinalAwaiters.entries()]
        .filter(([, sessionId]) => sessionId === owner)
        .map(([taskId]) => taskId);
    for (const taskId of targets) {
      try {
        await service.deliverMainTurnText(taskId, text);
      } catch (error) {
        this.log.warn(`QQ 主会话中间正文回传失败：${errorMessage(error)}`);
        continue;
      }
      // 可观测：中间正文 / 降级进度措辞也走这条通道 —— 记 source=intermediate，
      // 事后能分辨「QQ 收到的这段是最终答复还是进度」。
      void this.appendQqArchiveEvent("task_answer_delivered", taskId, {
        owner,
        source: "intermediate",
        chars: text.trim().length,
        fingerprint: qqTextFingerprint(text.trim()),
      });
    }
  }

  /** 等主会话进入可注入状态。
   *
   * 判定口径与 `sendPrompt` 自己的门一致（`mainSessionFree`：会话就绪、非
   * streaming / initializing / replaying / historySync、且主会话车道空闲）。
   * 被取消或超过 deadline 就返回对应状态，由调用方如实收尾。
   */
  async waitForQqMainFree(
    signal: AbortSignal,
    deadline: number,
  ): Promise<"free" | "canceled" | "timeout"> {
    while (true) {
      if (this.disposed || signal.aborted) return "canceled";
      if (this.mainSessionFree()) return "free";
      if (Date.now() > deadline) return "timeout";
      await this.waitForMainFreeTick(signal, deadline);
    }
  }

  /** 等一拍再看主会话是否空闲；取消/销毁/超时立刻返回。 */
  async waitForMainFreeTick(signal: AbortSignal, deadline: number): Promise<void> {
    const remain = deadline - Date.now();
    if (remain <= 0) return;
    const ms = Math.min(QQ_MAIN_IDLE_POLL_MS, remain);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      const onAbort = (): void => finish();
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
  }

  /** 会话是否已断开远程接续（关闭接管后）：命中即拦截 QQ 注入。 */
  isQqRemoteDetachedFor(sessionId: string | null): boolean {
    return sessionId !== null && this.qqRemoteDetachedSessions.has(sessionId);
  }

  /**
   * 底部输入区「远程接续」开关（语义按用户澄清反转）：
   * - start：远程继续干活 —— QQ 消息照常注入主会话、agent 继续执行；只冻结
   *   本地干预入口（转录保持只读可观察），并把该会话从「已断开」集合移除
   *   （重新接上远程）。发常驻只读 toast + 回推 active=true。
   * - stop：本地恢复 + 断开远程 —— 在本次接管的 sessionId 上设「不再接收 QQ
   *   注入」的门、取消在跑的注入回合、撤掉 toast、回推 active=false。
   * 门是会话级的：机器人仍服务其它会话；断开态不持久化，只在会话切换 /
   * 重建（newSession / restore / dispose）时清，webview 重连不清。
   */
  handleQqTakeover(action: "start" | "stop"): void {
    if (this.disposed) return;
    if (action === "stop") {
      // 只有走到 stop 才断开远程：先记下本次接管的会话（清冻结态后会置空），
      // 设断开门 → 取消在跑的 QQ 主会话注入回合 → 清本地冻结态与 toast。
      const detachedSession = this.qqTakeoverSessionId;
      if (detachedSession !== null) this.qqRemoteDetachedSessions.add(detachedSession);
      this.deps.cancelAllQqMainInjections();
      this.clearQqTakeover();
      return;
    }
    // start 不设任何暂停门：重新接上远程 + 冻结本地干预，QQ 注入照常放行。
    const sessionId = this.store.getState().sessionId;
    this.qqTakeoverActive = true;
    this.qqTakeoverSessionId = sessionId;
    if (sessionId !== null) this.qqRemoteDetachedSessions.delete(sessionId);
    if (this.qqTakeoverToastId === null) {
      this.qqTakeoverToastId = this.store.sendToast("info", vscode.l10n.t("远程接管中…"), {
        persistent: true,
        displayOnly: true,
      });
    }
    this.postToWebview({ type: "qqTakeoverState", active: this.qqTakeoverActive });
  }

  /** 清掉本地冻结态与常驻 toast；不碰「已断开远程」的会话集合。 */
  clearQqTakeover(): void {
    this.qqTakeoverActive = false;
    this.qqTakeoverSessionId = null;
    if (this.qqTakeoverToastId !== null) {
      this.store.dismissToast(this.qqTakeoverToastId);
      this.qqTakeoverToastId = null;
    }
    this.postToWebview({ type: "qqTakeoverState", active: this.qqTakeoverActive });
  }

  /** 会话切换 / 重建时清掉「已断开远程」集合，避免旧会话永久收不到 QQ。 */
  clearQqRemoteDetachedSessions(): void {
    this.qqRemoteDetachedSessions.clear();
  }

  /**
   * 停止整条 QQ 通道时的一次性放手（F6）：撤掉所有「等空闲」的注入，并打断
   * 当前真正跑在主会话上的那一轮。与单任务 {@link cancelQqMainInjection} 同源
   * 的 session/cancel 语义 —— 只有 qqInjectedTaskId 命中才打，绝不误伤本地回合。
   */
  cancelAllQqMainInjections(): void {
    const activeTaskId = this.qqInjectedTaskId;
    for (const controller of this.qqInjectAborts.values()) controller.abort();
    this.qqInjectAborts.clear();
    // 只有「整条 QQ 通道停止」才会走到这里（stopQq）：撤销全部等最终答复的
    // 记账是正确语义。R3 不变量：普通任务收尾 / 汇报轮绝不调本方法，绝不因
    // 本地回合收尾而把 delegated=true 的 awaiter 误摘。
    this.qqMainFinalAwaiters.clear();
    this.qqMainFinalAwaiterSince.clear();
    this.qqFinalRescueText.clear();
    this.qqReportFallbackText.clear();
    this.qqFinalRescueDefers.clear();
    this.qqFinalRescueProgressAt.clear();
    this.qqTaskBySuperSession.clear();
    this.qqTaskFinalText.clear();
    this.stopQqFinalRescueTimer();
    if (activeTaskId !== null) {
      this.qqInjectedTaskId = null;
      this.cancelSeen = true;
      const sessionId = this.store.getState().sessionId;
      if (sessionId) this.sendTurnCancel(sessionId, this.client);
    }
  }

  /**
   * 停止某个主会话渠道任务：放弃等待空闲，必要时打断正在跑的那一轮。
   *
   * 只有当前注入的就是这个任务时才 `session/cancel` —— 绝不能因为 QQ 的任务
   * 被停，把用户本地正在跑的回合一起打掉。
   */
  cancelQqMainInjection(taskId: string): boolean {
    const controller = this.qqInjectAborts.get(taskId);
    const isActiveTurn = this.qqInjectedTaskId === taskId;
    const wasAwaitingFinal = this.qqMainFinalAwaiters.delete(taskId);
    if (wasAwaitingFinal) this.qqMainFinalAwaiterSince.delete(taskId);
    this.qqFinalRescueDefers.delete(taskId);
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
    if (!controller && !isActiveTurn && !wasAwaitingFinal) return false;
    controller?.abort();
    if (isActiveTurn) {
      this.cancelSeen = true;
      const sessionId = this.store.getState().sessionId;
      if (sessionId) this.sendTurnCancel(sessionId, this.client);
    }
    return true;
  }

  /** 子会话快照：优先 store 的投影（webview 看到的那份），再退回管理器。 */
  findQqSuperSession(id: string): SuperSessionUi | null {
    const projected = this.store.getState().superSessions;
    const fromState = projected?.find((session) => session.id === id);
    if (fromState) return fromState;
    return this.getSuperAgent()?.get(id) ?? null;
  }

  // --- QQ 待审核用户 / 账号授权 ---------------------------------------------

  /** 待审核用户存储（懒建；与通道生命周期无关，通道没起也能看历史记录）。 */
  qqPendingStore(): QqPendingUserStore {
    if (!this.qqPendingUsers) {
      const root = path.join(
        this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath,
        "qq",
      );
      this.qqPendingUsers = new QqPendingUserStore(root);
    }
    return this.qqPendingUsers;
  }

  /**
   * 服务上报一条白名单外消息：累加记录并推全量列表。
   *
   * 返回 `{dropped}`：队列满（{@link QQ_PENDING_MAX_USERS}）或写入失败时为
   * true，服务侧据此不虚称「已记入待审核」。丢弃提示里只出现脱敏 openid
   * （`maskQqOpenId`），完整值只留在存储里作为放行依据。
   *
   * 丢弃 warning 按 openid 冷却（{@link QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS}）：
   * 满队时外部每条消息都触发一次丢弃事件，没有冷却会把操作者的面板刷满屏；
   * 不同用户的首次丢弃仍各自提示，不吞真实信号。
   */
  async handleQqPendingUser(info: QqPendingUserInput): Promise<{ dropped: boolean }> {
    if (this.disposed) return { dropped: false };
    let outcome: { users: QqPendingUser[]; dropped: boolean; openid: string };
    try {
      outcome = await this.qqPendingStore().record(info);
    } catch (error) {
      this.log.warn(`QQ 待审核记录写入失败：${errorMessage(error)}`);
      // 写失败 = 未记入：如实回报 dropped，服务侧不得虚称「已记入」。
      return { dropped: true };
    }
    this.postQqPendingUsers(outcome.users);
    if (outcome.dropped) {
      const key = typeof info.openid === "string" ? info.openid.trim() : "";
      const at = Date.now();
      const last = this.qqPendingDropToastAt.get(key);
      if (last === undefined || at - last >= QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS) {
        this.qqPendingDropToastAt.set(key, at);
        const masked = maskQqOpenId(outcome.openid) || "（未知用户）";
        this.store.sendToast(
          "warning",
          vscode.l10n.t(
            "待审核队列已满（上限 {0} 条），已丢弃来自 {1} 的新请求；请先处理现有记录",
            QQ_PENDING_MAX_USERS,
            masked,
          ),
        );
      }
    }
    return { dropped: outcome.dropped };
  }

  /** 推待审核列表（每次全量，webview 直接替换）。 */
  postQqPendingUsers(users: QqPendingUser[]): void {
    if (this.disposed) return;
    this.postToWebview({ type: "qqPendingUsers", users });
  }

  /** 读存储后推一次（面板重开 / 通道启动时）。 */
  async pushQqPendingUsers(): Promise<void> {
    if (this.disposed) return;
    try {
      this.postQqPendingUsers(await this.qqPendingStore().list());
    } catch (error) {
      this.log.warn(`QQ 待审核列表读取失败：${errorMessage(error)}`);
    }
  }

  /**
   * 面板对一条待审核记录的处置。
   *
   * approve → 移出队列 + 去重追加进 `allowedUsers`（落盘 + 热更新运行中的
   * config）+ 推设置快照；reject → 移出队列并记入拒绝集合（同一 openid 不会
   * 再冒出来）。写盘失败时**不删记录**并如实提示 —— 否则用户点了「放行」
   * 记录就消失，而白名单里其实没有他。
   */
  async handleQqUserAction(
    openid: string,
    action: "approve" | "reject",
  ): Promise<void> {
    if (this.disposed) return;
    const id = typeof openid === "string" ? openid.trim() : "";
    if (id.length === 0) {
      this.store.sendToast("warning", vscode.l10n.t("待审核记录缺少用户标识"));
      return;
    }
    const pending = this.qqPendingStore();
    if (action === "reject") {
      this.postQqPendingUsers(await pending.reject(id));
      return;
    }

    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    try {
      const fresh = await readQqSettings(io);
      // 快照里是带备注的条目；匹配与下面同步给运行中 config 的必须是完整 openid。
      const users = fresh.allowedUsers.some((entry) => entry.openid === id)
        ? fresh.allowedUsers
        : [...fresh.allowedUsers, { openid: id }];
      await applyQqSettingsPatch(io, { allowedUsers: users });
      // 与服务共享同一个 config 对象：白名单立刻生效，不必等重启。
      if (this.qq) this.qq.config.allowedUsers = users.map((entry) => entry.openid);
      this.postQqPendingUsers(await pending.approve(id));
      await this.deps.pushQqSettings();
      this.log.info(`QQ 已放行用户 ${id}（当前 ${users.length} 个账号）`);
    } catch (error) {
      this.log.warn(`QQ 白名单写入失败：${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("无法写入 QQ 白名单：{0}", errorMessage(error)),
      );
    }
  }

  /**
   * 解除绑定并清除本地授权：删除扫码写入的 appId / appSecret、清空用户白名单
   * （群白名单不动）、把 enabled 落盘为 false，然后停掉通道。
   *
   * 手填凭据移除后这是唯一「忘掉机器人」的入口，所以必须连 SecretStorage
   * 里的凭据一起删 —— 只清白名单会让用户以为已经解绑，实际机器人凭据仍在。
   */
  async unbindQqAccount(): Promise<{ ok: boolean; message: string }> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    await io.deleteSecret(QQBOT_APP_ID_SECRET_KEY);
    await io.deleteSecret(QQ_SECRET_KEYS.appSecret);
    try {
      await applyQqSettingsPatch(io, { allowedUsers: [], enabled: false });
    } catch (error) {
      // writeAll 走 Workspace 作用域：没打开工作区时会抛错。凭据已经删除，
      // 这里只记日志 —— 不谎报设置已落盘。
      this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
    }
    if (this.qq) this.qq.config.allowedUsers = [];
    await this.stopQq();
    await this.deps.pushQqSettings();
    return { ok: true, message: "已解除绑定并清除本地授权" };
  }

  // --- QQ 设置 / 凭据 / 状态消息 --------------------------------------------

  /**
   * 设置区改动 → 落盘 + 推快照 + 同步运行中的服务。
   *
   * 落盘走 `applyQqSettingsPatch`（白名单键 + 拒绝脏值）；是否重启由
   * `syncQqServiceWithSettings` 按连接类字段判定。
   */
  async handleQqSettingsPatch(patch: QqSettingsPatch): Promise<void> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    let result: Awaited<ReturnType<typeof applyQqSettingsPatch>>;
    try {
      result = await applyQqSettingsPatch(io, patch);
    } catch (error) {
      // writeAll 走 Workspace 作用域：没打开工作区时会抛错。与
      // unbindQqAccount 一致如实提示，绝不让它冒泡出 handleWebviewMessage
      // 变成一次静默失败（用户以为设置生效了，实际一个字都没落盘）。
      this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("无法写入 QQ 设置：{0}（请在已打开的工作区中设置）", errorMessage(error)),
      );
      return;
    }
    if (result.ignored.length > 0) {
      this.log.warn(`QQ 设置补丁忽略了：${result.ignored.join(", ")}`);
    }
    // 落盘会触发 `onDidChangeConfiguration` → `scheduleQqSettingsChanged`，
    // 由它统一做一轮快照 + 重启/热更新。这里**不再**直接调
    // `onQqSettingsChanged`，否则一次补丁会同步两轮（直接调用 + 事件回显）。
    // 立即回推归一化快照只是让设置页马上看到裁剪后的值。
    await this.deps.pushQqSettings();
  }

  /** 设置页 QQ 卡片的动作。扫码登录三动作在 Wave5-C 落地：二维码桥随托管
   * 现场（this.qq）生灭，未启动时安静返回。 */
  async handleQqConfigAction(
    action: "testConnection" | "unbind" | "startQrLogin" | "refreshQr" | "cancelQrLogin",
  ): Promise<void> {
    switch (action) {
      case "testConnection": {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) {
          this.pushQqStatus(false, "QQBot 未连接");
          return;
        }
        const health = await adapter.health();
        if (isQqHealthHealthy(health)) {
          // 健康即清零：下一次失活仍有一次自动重启的机会。
          this.qqHealthRestarts = 0;
          this.pushQqStatus(true, vscode.l10n.t("QQBot 官方网关已连接"));
          return;
        }
        const detail =
          typeof health.detail === "string" && health.detail.trim().length > 0
            ? health.detail.trim()
            : vscode.l10n.t("QQBot 未连接");
        // 先如实显示失活状态（绝不显示「正常」），再尝试恢复。
        this.pushQqStatus(false, detail);
        await this.recoverQqChannel(detail);
        return;
      }
      case "unbind": {
        const result = await this.unbindQqAccount();
        this.store.sendToast(result.ok ? "info" : "warning", result.message);
        return;
      }
      case "startQrLogin": {
        const config = this.qq?.config ?? (await this.currentQqConfig());
        await this.startQqBotBind(config);
        return;
      }
      case "refreshQr": {
        // QQBot 扫码会话不可原地刷新：重新发起一次扫码绑定。
        const config = this.qq?.config ?? (await this.currentQqConfig());
        await this.startQqBotBind(config);
        return;
      }
      case "cancelQrLogin": {
        if (!this.qqbotBinding && !this.qq?.qqbot?.bindSession) return;
        this.stopQqBotBinding();
        this.postToWebview(buildClearedQrMessage(Date.now()));
        return;
      }
    }
  }

  /** 看板 / IPC 的任务操作：交给服务执行，然后刷新投影。 */
  async handleQqTaskAction(
    taskId: string,
    action: QqTaskAction,
    text?: string,
  ): Promise<void> {
    const service = this.qq?.service;
    if (!service) {
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动"));
      return;
    }
    await service.handleTaskAction(taskId, action, text);
    this.refreshQqTasks();
  }

  /**
   * 设置事件合并入口（`onDidChangeConfiguration` 的唯一调用点）。
   *
   * 一次补丁会逐键 `writeAll`，事件会连发多轮；每轮都做读设置 + 推送 +
   * 重启判定纯属浪费。窗口内的多轮合并成一次完整同步。
   */
  scheduleQqSettingsChanged(): void {
    if (this.disposed) return;
    if (this.qqSettingsSyncTimer) clearTimeout(this.qqSettingsSyncTimer);
    this.qqSettingsSyncTimer = setTimeout(() => {
      this.qqSettingsSyncTimer = null;
      if (this.disposed) return;
      void this.deps.onQqSettingsChanged().catch((error: unknown) => {
        this.log.warn(`QQ 设置变更处理失败：${errorMessage(error)}`);
      });
    }, QQ_SETTINGS_SYNC_DEBOUNCE_MS);
    this.qqSettingsSyncTimer.unref?.();
  }

  /**
   * 配置变更后的统一处理：推快照 → 按需重启或热更新。
   *
   * 非连接类字段（白名单 / 策略 / 并发 / 限流 / 详略 / 自动合并）直接写进
   * 运行中的 config 对象 —— QqService 在每次使用时读它，所以即时生效且不
   * 打断在跑的任务；连接类字段交给 500ms 防抖的重启。
   */
  async onQqSettingsChanged(): Promise<void> {
    if (this.disposed) return;
    await this.deps.pushQqSettings();
    await this.syncQqServiceWithSettings();
    this.refreshQqTasks();
  }

  async syncQqServiceWithSettings(): Promise<void> {
    if (this.disposed) return;
    // 扫码绑定进行中 / 通道正在启动：绑定路径与启动路径自己会收尾，此刻任何
    // 按磁盘配置做的停/起都会把刚建好的 owner 反杀（首绑 enable 尚未落盘，
    // 配置事件读到 false 就会 stopQq）。等它们结束后由事件/心跳补一次同步。
    if (this.qqbotBinding || this.qqChannelStarting || this.qqStopping) return;
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    const snapshot = await readQqSettings(io);
    const { config, warnings } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    for (const warning of warnings) this.log.warn(`QQ 设置：${warning}`);

    if (!config.enabled) {
      // 只停仍在跑的通道：内存里的 enabled 已经是 false（刚停过 / 从未起过）
      // 时再调 stopQq 会白白推进代次并打断正在收尾的启动。
      if (this.qq && this.qq.config.enabled !== false) await this.stopQq();
      this.pushQqStatus(false, "QQ 通道已停用");
      return;
    }
    if (!this.qq) {
      await this.startQqIfEnabled();
      return;
    }
    if (
      shouldRestartOnPatch(this.qq.config, {
        enabled: config.enabled,
      })
    ) {
      this.scheduleQqRestart();
      return;
    }
    // 热更新：QqService 持有的就是这个对象，改字段即改行为。
    const live = this.qq.config;
    live.allowedUsers = [...config.allowedUsers];
    live.allowedGroups = [...config.allowedGroups];
    live.workspace = config.workspace;
    live.remotePolicy = config.remotePolicy;
    live.maxConcurrentTasks = config.maxConcurrentTasks;
    live.rateLimitPerMin = config.rateLimitPerMin;
    live.resultDetail = config.resultDetail;
    live.autoMerge = config.autoMerge;
  }

  /**
   * 面板打开 / webview 重连 / 设置变更后的一次性全量推送。
   *
   * 二维码（`qqLoginQr`）是独立的一次性通道，**刻意不在这里补推**：宿主
   * 从不缓存二维码帧，补推只会把已经清屏的旧码重新塞回 webview。扫码状态
   * 由 `startQqBotBind` / `onQqBotBound` 主动推送。
   */
  pushQqState(): void {
    this.refreshQqTasks();
    void this.pushQqPendingUsers();
    // 面板打开/重新可见时检查一次通道健康：op=9 之后 socket 可能仍「看着
    // 活着」但永远不会再来事件，只在用户点「测试连接」时才检查就太晚了。
    void this.checkQqChannelHealth();
  }

  /** QQ 设置快照（无明文凭据，只有 hasAppSecret 布尔）。 */
  async pushQqSettings(): Promise<void> {
    if (this.disposed) return;
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    try {
      const values = await readQqSettings(io);
      this.postToWebview({ type: "qqSettings", values });
    } catch (error) {
      this.log.warn(`QQ 设置读取失败：${errorMessage(error)}`);
    }
  }

  /** 连接状态。`detail` 省略 = 沿用上一次的说明（不把它擦成空）。 */
  pushQqStatus(connected: boolean, detail?: string): void {
    if (this.disposed) return;
    this.qqConnected = connected;
    if (detail !== undefined) this.qqLastDetail = detail;
    const message: { type: "qqStatus"; connected: boolean; detail?: string } = {
      type: "qqStatus",
      connected,
    };
    if (this.qqLastDetail !== null) message.detail = this.qqLastDetail;
    this.postToWebview(message);
  }

  /**
   * 只刷新任务看板投影（服务状态一变就调用）。
   *
   * 任务从「已校验」走到终态期间会 persist 好几次，每次都连带读设置 / 推连接
   * 状态是纯浪费（还要碰 SecretStorage）；这里只做 `setQqTasks` + 快照。
   */
  refreshQqTaskProjection(): void {
    if (this.disposed) return;
    const service = this.qq?.service;
    // 通道为空（dispose / 重建竞态）时保持现状：清空看板会闪出一帧空列表，
    // 而显式停用路径（stopQq）不经过这里，不需要「空推送」。
    if (!service) return;
    setQqTasks(this.store.getState(), capQqTaskProjection(service.listTasks()));
    this.scheduleQqSnapshotFlush();
  }

  /**
   * 节流推送（而非立即 `pushSnapshot`）。
   *
   * 一个任务从 received 走到终态会 persist 多次，`onChanged` 每次都立即
   * push 会把整份快照风暴式推给 webview。`SessionStore` 的 `scheduleFlush`
   * 正是同一套节流器；它目前是私有方法（`store.ts` 不在本次改动边界内），
   * 这里用窄类型桥接，方法缺失时退回立即推送。
   */
  scheduleQqSnapshotFlush(): void {
    const store = this.store as unknown as { scheduleFlush?: () => void };
    if (typeof store.scheduleFlush === "function") store.scheduleFlush();
    else this.store.pushSnapshot();
  }

  /**
   * 任务看板投影：服务里的任务列表 → `SessionState.qqTasks`。
   *
   * 与 `superSessions` 一样是**非 blocks 元数据**，因此复用 store 既有的
   * 节流快照 / blockPatch 通道（`pushSnapshot`），不自建推送。
   */
  refreshQqTasks(): void {
    if (this.disposed) return;
    this.refreshQqTaskProjection();
    // 「一次刷新 = 三样都推」：看板条目变化往往伴随状态/设置变化（桥接上、
    // 任务新建），分开推只会让设置卡与看板短暂不同步。读设置是内存 + 一次
    // SecretStorage 探测，QQ 消息频率下这点开销可以忽略。
    void this.pushQqSettings();
    this.pushQqStatus(this.qqConnected);
  }

  qqWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

}
