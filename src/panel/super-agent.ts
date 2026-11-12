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
 *  - **子会话始终免确认且完全自主**：内核被推到 `yolo` 模式 —— 这是刻意的产品
 *    语义，子会话必须完全自主、不因审批往返而停顿，也不该把审批变成人工负担。
 *    代价是 `yolo` 下内核通常**不发** `session/request_permission`，所以宿主在
 *    审批点上的依赖护栏（`shared/super-agent-guard.ts`，拦会破坏主工作区依赖的
 *    安装/联接命令）只是**兜底**而非主防线：万一某类工具仍然发审批，宿主就地
 *    自动放行（shell 用 allow_once，危险命令 deny），既不产生待办也不阻塞子会话。
 *    只有 `_iflow/user/questions` 是真正的信息缺口 —— 那是只有人才能回答的，
 *    落到子会话自己的 pending 槽位由看板就地作答（主会话的 pending 是单数槽位，
 *    多子会话并发会互相覆盖）。
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
import { existsSync, lstatSync } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AcpClient, AcpClientCallbacks } from "../acp/client.js";
import type {
  ContentBlock,
  ExitPlanModeResponse,
  RequestPermissionResponse,
  TurnUsageReport,
  UserQuestion,
  UserQuestionsResponse,
} from "../acp/protocol.js";
import { errorMessage } from "../acp/jsonrpc.js";
import { applySessionUpdate, estimateTokens } from "../../shared/session-state.js";
import {
  classifyChildShellCommand,
  extractShellCommand,
  isShellToolCall,
  pickChildPermissionOption,
} from "../../shared/super-agent-guard.js";
import { renderPrompt } from "../../prompts/index.js";
import { estimateCost } from "../../shared/context-window.js";
import { initialSessionState, type Block, type SessionState } from "../../shared/messages.js";
import {
  applySuperEvent,
  buildSuperReportPrompt,
  canRetrySuperSession,
  clampMaxConcurrentSuperSessions,
  isTerminalSuperStatus,
  reportForSession,
  retrySuperSession,
  toPersistedSuperSession,
  withIntegration,
  withUsage,
  type PersistedSuperSession,
  type SuperAttachment,
  type SuperEvent,
  type SuperIntegration,
  type SuperIntegrationMode,
  type SuperPending,
  type SuperReport,
  type SuperSessionUi,
  type SuperTaskSpec,
  type SuperTokenUsage,
} from "../../shared/super-agent.js";
import {
  branchHasUnmergedCommits,
  commitWorktree,
  createPullRequest,
  createWorktree,
  currentBranch,
  ensureSuperIsolationIgnored,
  ghAvailable,
  inspectWorkingTree,
  isBranchMerged,
  listWorktrees,
  mergeBranch,
  previewMerge,
  probeGitRepo,
  pushBranch,
  remoteOriginUrl,
  removeWorktree,
  sanitizeWorktreeName,
  SUPER_BRANCH_PREFIX,
  superBranchName,
  superIsolationDir,
  worktreeHasUncommittedChanges,
  worktreePathFor,
} from "./worktree.js";

/**
 * 提问的自动放行时限（与主会话的审批卡同一纪律：超时就放行/继续，避免 agent
 * 永久阻塞）。审批不走这里 —— 子会话免确认，审批由宿主立即放行。
 */
export const SUPER_PENDING_TIMEOUT_MS = 5 * 60_000;

/**
 * 实时进度的尾部上限。子会话的完整转录不进快照，看板只拿一段尾部文本做
 * 「进度详情」；不设上限的话长输出会随每次 flush 反复序列化。
 */
export const SUPER_PROGRESS_MAX_CHARS = 4_000;

/** 实时进度推送节流：流式 chunk 逐个推会让超快照变成噪音，700ms 足够让用户
 * 看到「它在动」，又不会压过主会话的渲染节流。 */
export const SUPER_PROGRESS_THROTTLE_MS = 700;

/** 作为视觉块直接送给子会话的图片上限（与主会话的图片附件上限同口径）。 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
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
  /** 需要主会话知道的状态更新（宿主转成给主会话的提示词）。 */
  onReport: (entries: { session: SuperSessionUi; report: SuperReport }[]) => void;
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
}

export class SuperAgentManager {
  private readonly sessions = new Map<string, SuperSessionUi>();
  private readonly clients = new Map<string, AcpClient>();
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
  /** 交给子会话的任务提示 token 估算 —— 内核没上报输入时的兜底下界。 */
  private readonly promptTokens = new Map<string, number>();
  /** 实时进度的节流定时器（每个子会话最多一个在飞）。 */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
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
    return [...live, ...history].sort((a, b) => a.createdAt - b.createdAt);
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
   * 派发一个子会话。立即返回记录（status = preparing），准备工作异步进行 ——
   * 委派指令一次可能带多个任务，调用方不该被 worktree 创建 + CLI 握手阻塞。
   *
   * 超过并发上限时请求进 FIFO 排队，槽位一空就自动开跑（「随时开启」）。
   *
   * `options.isolation = "repo"` 派的是**主仓工作区档**子会话：它没有
   * worktree、没有自己的分支，直接在主仓根目录里干活（合并子会话专用 ——
   * 合并只能在目标分支所在的工作区发生）。
   */
  spawn(spec: SuperTaskSpec, options?: { isolation?: "repo" }): SuperSessionUi {
    const now = Date.now();
    const id = `super-${now.toString(36)}-${(this.seq++).toString(36)}`;
    const repoIsolation = options?.isolation === "repo";
    const session: SuperSessionUi = {
      id,
      title: spec.title,
      task: spec.task,
      status: "preparing",
      queued: true,
      attempts: 1,
      isolation: repoIsolation
        ? { kind: "repo", path: this.deps.repoRoot }
        : { kind: "directory", path: "", note: "正在准备隔离环境" },
      // 归属主会话：归档按它分文件，恢复历史会话时按它取回。
      mainSessionId: this.deps.currentMainSessionId() ?? undefined,
      createdAt: now,
      updatedAt: now,
      reports: [],
    };
    this.sessions.set(id, session);
    if (session.mainSessionId) this.archiveOwners.add(session.mainSessionId);
    this.queue.push({ spec, id });
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
      this.deps.log.warn("super agent: 来源子会话没有分支，无法派合并子会话");
      return null;
    }
    if (this.repoMergeRunning()) {
      this.deps.log.warn("super agent: 已有一个合并子会话在跑（主仓工作区无版本隔离），本次不派发");
      return null;
    }
    const child = this.spawn(
      { title: options.title, task: options.task },
      { isolation: "repo" },
    );
    this.mergeTargets.set(child.id, {
      sourceId: options.source.id,
      branch,
      title: options.source.title,
    });
    this.deps.log.info(`super agent: 派出合并子会话 ${child.id}（合并 ${branch}）`);
    return child;
  }

  /** 是否已有一个合并子会话在跑（主仓工作区没有版本隔离）。 */
  private repoMergeRunning(): boolean {
    for (const session of this.sessions.values()) {
      if (session.isolation.kind !== "repo") continue;
      if (!isTerminalSuperStatus(session.status)) return true;
    }
    return false;
  }

  /** 中断一个子会话（终止其 CLI 进程与当前轮次）。 */
  async cancel(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return false;
    // 还在排队的话先撤掉 —— 否则槽位空出后 pump 会把它启动起来。
    this.dequeue(id);
    // 先落「已中断」再杀进程：终止进程会触发 AcpClient 的 onExit，而管理层把
    // 内核退出一律记成 failed —— 终态粘性会让随后的 cancelled 被丢弃，手动
    // 停止就显示成失败。先把终态占住，onExit 的失败事件会被幂等地忽略。
    this.apply(id, { type: "cancelled", at: Date.now() });
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
    return true;
  }

  /** 中断全部子会话，返回被中断的数量。 */
  async cancelAll(): Promise<number> {
    const ids = [...this.sessions.values()]
      .filter((s) => !isTerminalSuperStatus(s.status))
      .map((s) => s.id);
    for (const id of ids) await this.cancel(id);
    return ids.length;
  }

  /**
   * 重试一个「意外中断」的子会话（`failed` / `cancelled`）。
   *
   * 复用同一个记录与隔离目录：worktree 里可能有中断前没提交的改动，重试的
   * 提示词会告诉新进程「上一轮中断了、先检查现状再继续」，而不是假装从零
   * 开始。目录已被删掉 / 从未建好时退化为新建隔离环境。返回 false 表示该
   * 子会话当前不可重试。
   */
  async retry(id: string): Promise<boolean> {
    if (this.disposed) return false;
    const session = this.sessions.get(id);
    if (!session || !canRetrySuperSession(session)) return false;

    // 上一轮的进程本该在终态时回收；这里再做一次防御性回收（幂等），并把
    // 它从并发槽位摘掉 —— 否则重置后的会话会把自己算成「已占用」而永远
    // 排在自己前面。
    await this.disposeClient(id);
    this.started.delete(id);

    const retry: SuperRetryState = {
      attempt: (session.attempts ?? 1) + 1,
      error: session.error,
      summary: session.summary ?? (this.lastText.get(id)?.trim() || undefined),
      reuseIsolation: true,
    };
    this.sessions.set(id, retrySuperSession(session, Date.now()));
    this.lastText.delete(id);
    this.queue.push({ spec: { title: session.title, task: session.task }, id, retry });
    this.emit();
    this.pump();
    return true;
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

    if (resolver.timer) clearTimeout(resolver.timer);
    this.resolvers.delete(id);
    resolver.resolve({ answers: answer.answers ?? {} });
    this.apply(id, { type: "input_resolved", at: Date.now() });
    return true;
  }

  /**
   * 清理一个子会话：终止进程 + 移除 worktree。
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
    // 排队中的会话被清理后不能再被 pump 启动。
    this.dequeue(id);
    this.started.delete(id);
    this.lastText.delete(id);
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
      const result = await removeWorktree({
        repoRoot: this.deps.repoRoot,
        targetPath: session.isolation.path,
        branch: session.isolation.branch,
        baseRef: session.isolation.baseRef,
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
   * 幂等：可重复调用。只删隔离子树下的目录与 `iflow/super/` 分支，绝不碰
   * 主仓工作区，也绝不碰用户自己的分支。
   */
  async sweepStaleWorktrees(): Promise<SuperSweepResult> {
    const result: SuperSweepResult = { removed: 0, kept: 0, orphans: [] };
    if (this.disposed) return result;

    const root = superIsolationDir(this.deps.repoRoot, "worktrees");
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // 没有隔离子树 → 没有残留。
      return result;
    }

    const registered = await listWorktrees(this.deps.repoRoot);
    const registeredByPath = new Map<string, string | null>();
    for (const item of registered) {
      registeredByPath.set(normalizePathKey(item.path), item.branch);
    }

    // 活着的子会话正在用的工作目录：绝不能删（它还在跑）。
    const livePaths = new Set<string>();
    for (const session of this.sessions.values()) {
      if (isTerminalSuperStatus(session.status)) continue;
      if (!session.isolation.path) continue;
      livePaths.add(normalizePathKey(session.isolation.path));
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(root, entry.name);
      const key = normalizePathKey(target);
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
        this.deps.log.info(`super agent: 跳过残留目录 ${target}（仍是活着的子会话的工作目录）`);
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
    if (result.removed > 0) this.emit();
    return result;
  }

  /**
   * 把指向某个 worktree 目录的记录都标成「隔离已释放」。
   *
   * 清扫掉的可能是历史（archived）子会话的工作目录 —— 它们的记录留在归档里，
   * 不打 released 标记的话看板会一直显示「还有工作目录没清理」。
   */
  private markWorktreeReleased(targetPath: string): void {
    const key = normalizePathKey(targetPath);
    const matches = (session: SuperSessionUi): boolean =>
      Boolean(session.isolation.path) && normalizePathKey(session.isolation.path) === key;
    for (const [id, session] of [...this.sessions]) {
      if (!matches(session)) continue;
      this.sessions.set(id, { ...session, isolation: { ...session.isolation, released: true } });
    }
    for (const [owner, records] of [...this.archived]) {
      if (!records.some(matches)) continue;
      this.archived.set(
        owner,
        records.map((s) =>
          matches(s) ? { ...s, isolation: { ...s.isolation, released: true } } : s,
        ),
      );
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
    const kept: { id: string; path: string; branch?: string }[] = [];
    for (const [id, session] of this.sessions) {
      // 与 cancel 同理：先落「已中断」再杀进程，否则 onExit 会把这次终止记成
      // 内核异常退出（failed），且终态粘性让随后的 cancelled 无法覆盖。
      if (!isTerminalSuperStatus(session.status)) {
        this.apply(id, { type: "cancelled", at: Date.now() });
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

  /** 队列泵：并发有空位时把排队的派发请求放出去。 */
  private pump(): void {
    // 每次 pump 都重新读配置并归一化：上限是用户可调的，0 / Infinity 之类的
    // 脏值不能让池子卡死或无限放开。
    const limit = clampMaxConcurrentSuperSessions(this.deps.maxConcurrentSessions());
    while (this.queue.length > 0 && this.activeCount() < limit) {
      const next = this.queue.shift();
      if (!next) return;
      this.started.add(next.id);
      void this.prepare(next.id, next.spec, next.retry);
    }
  }

  /** 把一个会话的排队项移除（取消 / 清理 / 重试重新入队时用）。 */
  private dequeue(id: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.id === id) this.queue.splice(i, 1);
    }
  }

  /** 已启动且未结束的子会话数（排队中的不占槽位）。 */
  private activeCount(): number {
    let count = 0;
    for (const id of this.started) {
      const session = this.sessions.get(id);
      if (session && !isTerminalSuperStatus(session.status)) count++;
    }
    return count;
  }

  private async prepare(id: string, spec: SuperTaskSpec, retry?: SuperRetryState): Promise<void> {
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
      // 干活。合并只能在目标分支所在的工作区发生，这一档就是为此存在的。
      isolation = { kind: "repo", path: this.deps.repoRoot };
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
          const reason = truncateForPrompt(errorMessage(error).replace(/\s+/g, " "), 200);
          this.deps.log.warn(`worktree 创建失败，退回目录隔离：${reason}`);
          const dir = path.join(superIsolationDir(this.deps.repoRoot, "dirs"), `${slug}-${unique}`);
          await mkdir(dir, { recursive: true });
          isolation = {
            kind: "directory",
            path: dir,
            note: `worktree 创建失败（${reason}），仅目录隔离`,
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

    const current = this.sessions.get(id);
    if (!current || this.disposed || isTerminalSuperStatus(current.status)) {
      this.started.delete(id);
      return;
    }
    // 准备期间又发生了一次重试 —— 让新的一次执行接管。
    if ((current.attempts ?? 1) !== attempt) return;
    this.sessions.set(id, { ...current, isolation, queued: false, updatedAt: Date.now() });
    this.emit();

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
      this.clients.set(id, client);

      const { sessionId } = await client.newSession({ cwd: isolation.path, mcpServers: [] });
      this.apply(id, { type: "started", cliSessionId: sessionId, at: Date.now() });

      // 子会话推 `yolo` 是**刻意的**：子会话必须完全自主，不因审批往返而停顿，
      // 也不该把审批变成人工负担。代价是 `yolo` 下内核通常**不发**
      // `session/request_permission`，所以审批点上的依赖护栏（callbacksFor 里的
      // classifyChildShellCommand）只是**兜底** —— 万一某类工具仍然发审批，就仍然
      // 自动放行（shell 用 allow_once）+ 拦危险 shell；它不是主防线，不能依赖它。
      try {
        await client.setMode(sessionId, "yolo");
      } catch (error) {
        this.deps.log.warn(`子会话切换到免确认模式失败（改由宿主自动放行）：${errorMessage(error)}`);
      }

      model = this.deps.currentModel();
      if (model) {
        try {
          await client.setModel(sessionId, model);
        } catch (error) {
          this.deps.log.warn(`子会话设置模型失败（沿用内核默认）：${errorMessage(error)}`);
        }
        this.patchModel(id, model);
      }

      const taskPrompt = buildTaskPrompt(
        current.title,
        current.task,
        isolation,
        staged,
        retry ? { attempt: retry.attempt, error: retry.error, summary: retry.summary } : undefined,
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
      if (response.stopReason === "cancelled") {
        this.apply(id, { type: "cancelled", at });
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
        const commit = await this.commitChildWork(id, isolation);
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
              summary: `宿主已代子会话提交 ${commit.files} 个文件`,
              at: Date.now(),
            });
          }
          // 自动合并 / PR 只依赖 worktree 里的提交，与子进程无关。
          await this.integrate(id);
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
      this.recordUsage(id, model, usageReport);
      // Flush before the process goes away: the last text/tool chunks must
      // reach the webview even if the throttle timer has not fired yet.
      this.flushTranscripts();
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
      if (this.sessions.get(id)?.integration?.state === "merged") {
        await this.releaseIsolationWithRetry(id, "merged");
      }
      // 「没有产生任何提交」的子会话同样要释放隔离（目录与空分支都是残留）。
      // 已被一次重试取代时**绝不能删** —— 新的一轮还在用这个 worktree。
      const pendingEmpty = this.pendingEmptyRelease.delete(id);
      if (isCurrentAttempt && pendingEmpty) {
        await this.releaseIsolationWithRetry(id, "empty");
      }
      // 合并子会话收尾：用只读 git 检测目标分支是否真的并入了当前分支，
      // 再把结果写回来源子会话的 integration（失败/中断同样要如实记）。
      await this.finalizeMergeChild(id);
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
          detail: `合并子会话已把 ${target.branch} 合入 ${targetBranch}`,
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
      ? `合并子会话${child?.status === "cancelled" ? "被中断" : "失败"}，${target.branch} 仍保留${
          child?.error ? `：${child.error}` : ""
        }`
      : `合并子会话没有把 ${target.branch} 合入当前分支，${target.branch} 仍保留`;
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
        const update = notification.update;
        // Keep the summary source (the final assistant prose) and the live
        // progress tail.
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = extractText(update.content);
          if (text) {
            this.lastText.set(id, (this.lastText.get(id) ?? "") + text);
            this.scheduleProgress(id);
          }
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = extractText(update.content);
          if (text) this.lastThought.set(id, (this.lastThought.get(id) ?? "") + text);
        }
        // And feed EVERY update into the shared reducer so the detail pane
        // renders the same live transcript as the main session (tool cards,
        // thoughts, plans, nested sub-agents). Live `user_message_chunk`
        // echoes are ignored by the reducer; the task prompt is added by
        // `prepare` as the user turn.
        const transcript = this.transcriptFor(id);
        const index = applySessionUpdate(transcript.state, notification);
        if (index !== null) this.markTranscriptDirty(id, index);
      },
      // 兜底路径：审批自动放行，不产生待办、不打扰主会话。
      // 子会话推的是 yolo，内核通常根本不发 `session/request_permission`；这里
      // 只在万一某类工具仍然发审批时生效，所以下面的依赖护栏同样是兜底而非主防线。
      //
      // 「自动放行」之前仍过依赖护栏（2026-11-11 事故：子会话把主仓
      // node_modules 联接进 worktree 后跑 `npm ci`，顺着联接清空了用户依赖）。
      // 护栏是 `shared/super-agent-guard.ts` 的纯函数表，这里只负责给它喂
      // 命令文本与隔离上下文，命中即拒绝 —— 模型看到工具被拒后可自行换方案。
      onRequestPermission: async (request) => {
        const session = this.sessions.get(id);
        const shell = isShellToolCall(request.toolCall);
        if (shell && session) {
          const command = extractShellCommand(request.toolCall);
          if (command) {
            const verdict = classifyChildShellCommand(command, {
              cwd: session.isolation.path,
              repoRoot: this.deps.repoRoot,
              nodeModulesIsLink: isLinkedNodeModules(session.isolation.path),
            });
            if (verdict.decision === "deny") {
              this.deps.log.warn(
                `[${id}] 拒绝子会话命令（保护主工作区依赖）：${verdict.reason ?? ""}`,
              );
              const reject =
                request.options.find((option) => option.kind === "reject_once") ??
                request.options.find((option) => option.kind.startsWith("reject"));
              // 拒绝也只能用 agent 自己给出的选项 id（CLI 用原生枚举解析，
              // 伪造 id 会抛）；没有拒绝选项就按「取消」—— 与审批超时同一条路。
              if (reject) {
                return {
                  outcome: { outcome: "selected", optionId: reject.optionId },
                } as RequestPermissionResponse;
              }
              return { outcome: { outcome: "cancelled" } } as RequestPermissionResponse;
            }
          }
        }
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
      },
      onUserQuestions: async (request) =>
        (await this.awaitQuestion(id, request.questions)) as UserQuestionsResponse,
      // 免确认模式不该卡在计划审批上 —— 计划退出也自动批准。
      onExitPlanMode: async () => ({ approved: true }) as ExitPlanModeResponse,
      onExit: (code) => {
        const session = this.sessions.get(id);
        if (!session || isTerminalSuperStatus(session.status)) return;
        this.apply(id, { type: "failed", error: `子会话内核退出（code=${code ?? "null"}）`, at: Date.now() });
        this.notifyReport(id);
      },
      onStderr: (line) => this.deps.log.debug?.(`[${id}] ${line}`),
    };
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
        this.resolvers.delete(id);
        const session = this.sessions.get(id);
        if (session) {
          this.sessions.set(id, { ...session, pending: undefined, updatedAt: Date.now() });
          this.emit();
        }
        resolve({ answers: {} });
      }, SUPER_PENDING_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();

      this.resolvers.set(id, { resolve, timer });
      const pending: SuperPending = {
        kind: "question",
        requestId,
        questions,
        deadline: Date.now() + SUPER_PENDING_TIMEOUT_MS,
      };
      this.apply(id, { type: "needs_input", pending, at: Date.now() });
      this.notifyReport(id);
    });
  }

  // --- 集成（自动合并 / PR） -------------------------------------------------

  /** 串行执行集成：并发合并同一个工作区会把仓库搅乱。 */
  private async integrate(id: string): Promise<void> {
    this.integrationChain = this.integrationChain
      .then(() => this.runIntegration(id))
      .catch((error) => {
        this.deps.log.error(`子会话集成失败：${errorMessage(error)}`);
      });
    await this.integrationChain;
  }

  private async runIntegration(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || this.disposed) return;
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
        { state: "skipped", detail: "子会话没有产生任何提交" },
        "the child session produced no commits",
      );
      this.pendingEmptyRelease.add(id);
      return;
    }

    if (mode === "merge") {
      const tree = await inspectWorkingTree(this.deps.repoRoot);
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
              detail: `主工作区有未提交改动，其中 ${overlap.length} 个文件与子会话的改动重叠（${describePaths(overlap)}），分支已保留待你手动合并`,
            },
            `the main workspace has uncommitted changes in ${overlap.length} file(s) that overlap the child session's changes (${describePathsEn(overlap)})`,
          );
          return;
        }
      }
      const result = await mergeBranch({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
      if (result.ok) {
        const target = (await currentBranch(this.deps.repoRoot)) ?? "当前分支";
        record(
          {
            state: "merged",
            detail: tree.clean
              ? `已合入 ${target}`
              : `已合入 ${target}（你本地未提交的 ${tree.dirtyCount} 处改动原样保留）`,
          },
          tree.clean
            ? `merged into ${target}`
            : `merged into ${target} (the ${tree.dirtyCount} uncommitted local change(s) were kept as they were)`,
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
              detail: `git 拒绝合并，工作区未被改动（常见原因：未跟踪文件与子会话新增的文件同名，请先移走或提交它）；分支 ${isolation.branch} 已保留：${result.error}`,
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
   */
  private async commitChildWork(
    id: string,
    isolation: SuperSessionUi["isolation"],
  ): Promise<{ committed: boolean; files: number; error?: string }> {
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
      this.deps.log.warn(`子会话代提交失败：${result.error}`);
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
    mode: "merged" | "empty",
  ): Promise<void> {
    const outcome = await this.releaseIsolation(id, mode);
    if (!outcome.ok && outcome.retryable) {
      this.scheduleReleaseRetry(id, mode, outcome.reason);
    }
  }

  /**
   * 释放隔离：删掉 worktree 目录与本地分支，只保留看板记录。
   *
   * 两条路径共用一道闸门骨架，差别只在「分支能不能删」的判据：
   *  - `merged`：分支已并入 HEAD → 可以删分支（`isBranchMerged` 复核）；
   *  - `empty`：分支上没有任何独有提交 → 删分支不会丢东西
   *    （`branchHasUnmergedCommits` 复核，判据是 baseRef..branch 为空）。
   *
   * 幂等：已释放（`released` 为真）直接成功，可重复调用。
   *
   * 调用时机由调用方保证：必须在子会话 CLI 进程退出之后。Windows 上进程的
   * cwd 还停在 worktree 里时，目录是删不掉的。
   */
  private async releaseIsolation(
    id: string,
    mode: "merged" | "empty",
  ): Promise<ReleaseOutcome> {
    if (mode === "merged") return this.releaseMergedIsolation(id);
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
    // 数成「未合并」，分支反而被保留。合并已由上面的 isBranchMerged 确认。
    const result = await removeWorktree({
      repoRoot: this.deps.repoRoot,
      targetPath: isolation.path,
      branch: isolation.branch,
      keepBranch: false,
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
        "子会话没有产生任何提交，工作目录保留（还有未提交改动）",
        "the child session produced no commits and the working directory still has uncommitted changes",
      );
    }

    // 删分支前再核一次「确实没有独有提交」—— 状态可能在这期间变了
    // （比如子会话临收尾前才提交）。
    const baseRef = isolation.baseRef;
    if (!baseRef) {
      return keep(
        "子会话没有产生任何提交，工作目录保留（缺少分支起点，无法确认分支为空）",
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
        "子会话没有产生任何提交（分支上出现新提交），工作目录保留",
        "the child session produced no commits, but new commits appeared on the branch",
      );
    }

    const result = await removeWorktree({
      repoRoot: this.deps.repoRoot,
      targetPath: isolation.path,
      branch: isolation.branch,
      keepBranch: false,
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
          state: "skipped",
          detail: "子会话没有产生任何提交，工作目录清理未完成（稍后重试）",
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
        state: "skipped",
        detail: "子会话没有产生任何提交，工作目录已清理",
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
    mode: "merged" | "empty",
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
    mode: "merged" | "empty",
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

  private apply(id: string, event: SuperEvent): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const next = applySuperEvent(session, event);
    if (next === session) return;
    this.sessions.set(id, next);
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
    const pendingCount = this.list().filter(
      (session) => !isTerminalSuperStatus(session.status),
    ).length;
    return buildSuperReportPrompt(entries, { pendingCount });
  }

  /**
   * 子会话的文本摘要（模型面向：它会作为汇报正文回到主会话）。
   *
   * 没有正文时的兜底是英文：汇报提示词整体是英文的，兜底夹一句中文会让
   * 模型在对话中间翻语言（与 `shared/super-agent.ts` 的 `describePending`
   * 兜底同一纪律）。
   */
  private summarize(id: string): string {
    const text = (this.lastText.get(id) ?? "").trim();
    if (!text) return "(the child session left no text summary)";
    return text.length > 800 ? `${text.slice(0, 799)}…` : text;
  }

  /** 清理已删除子会话的附属状态（文本缓冲、节流定时器、实时转录）。 */
  private forgetChild(id: string): void {
    const timer = this.progressTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(id);
    }
    this.lastText.delete(id);
    this.lastThought.delete(id);
    this.promptTokens.delete(id);
    this.transcripts.delete(id);
    this.integrationReasonEn.delete(id);
  }

  /** 记录子会话实际使用的模型（看板详情要显示它，成本也按它查单价）。 */
  private patchModel(id: string, model: string): void {
    const session = this.sessions.get(id);
    if (!session || session.model === model) return;
    this.sessions.set(id, { ...session, model, updatedAt: Date.now() });
    this.emit();
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
    return text.length > SUPER_PROGRESS_MAX_CHARS
      ? `…${text.slice(-SUPER_PROGRESS_MAX_CHARS)}`
      : text;
  }

  /**
   * 结算子会话的 token 开销。
   *
   * 输入取内核上报的**末次请求上下文**（权威）；没上报时退回任务提示的 BPE
   * 估算并标记非权威 —— 绝不把估算值冒充成内核数据。输出取
   * `completionTokens` 与全部助手/思考文本估算的较大值（工具循环的多轮生成
   * wire 不带拆分，这是保守下界）。成本只在有单价时计算。
   */
  private recordUsage(
    id: string,
    model: string | null,
    report: TurnUsageReport | undefined,
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const text = (this.lastText.get(id) ?? "") + (this.lastThought.get(id) ?? "");
    const estimatedOutput = estimateTokens(text);
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
    this.clients.delete(id);
    try {
      await client.dispose();
    } catch (error) {
      this.deps.log.warn(`子会话进程回收失败：${errorMessage(error)}`);
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
  copies: { name: string; path: string }[];
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
      staged.copies.push({ name: path.basename(target), path: target });
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
      log.warn(`子会话附件复制失败（${label}）：${errorMessage(error)}`);
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
): string {
  return renderPrompt("super-agent-task", {
    title,
    task: task.trim(),
    attachments: describeAttachments(attachments),
    attachmentFailures: describeAttachmentFailures(attachments),
    isolation: describeIsolation(isolation),
    retry: retry ? describeRetry(retry) : "",
    submission: describeSubmission(isolation),
  });
}

/** 附件段落（无附件时返回空串，模板行整行折叠）。 */
function describeAttachments(attachments?: StagedSuperAttachments): string {
  if (!attachments || attachments.copies.length === 0) return "";
  return (
    "\n" +
    [
      "Files attached to this task (copied outside your working directory; read them as reference only and do not modify them):",
      ...attachments.copies.map((copy) => `- ${copy.name} → ${copy.path}`),
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
  if (isolation.kind === "repo") {
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
 * 主仓工作区档则明确「合并提交就是交付物，不许自己提交」。 */
function describeSubmission(isolation: SuperSessionUi["isolation"]): string {
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
        "- Do not switch, rename or delete branches, and do not push, create a pull request or merge. The host brings the branch back into the main workspace after you finish, and commits any changes you leave uncommitted.",
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
  return [session.task.trim(), "", `_由 iFlow Harness 子会话 \`${session.id}\` 自动创建。_`].join("\n");
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

/** 重试提示词里的截断：上一次的错误/摘要可能很长，别把它们整段塞进提示词。 */
function truncateForPrompt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
