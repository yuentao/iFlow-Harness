/**
 * Super Agent — 子会话编排（Extension Host only，零 vscode 依赖）。
 *
 * 一个子会话 = 一个独立 CLI 进程 + 一个独立 ACP session + 一个独立工作目录
 * （git worktree）。子会话的转录**不进主会话的 blocks**（会污染主转录并破坏
 * blockPatch 锚），主会话只看到一份投影：`SuperSessionUi` 列表。
 *
 * 关键设计（取自 Orca / dsh / DeepSeek 的共同骨架）：
 *  - 并发上限 + FIFO 排队：超过上限的派发请求排队而不是被拒绝 —— 用户要求
 *    「主会话可以随时开启子会话」。
 *  - 终态粘性：`applySuperEvent` 让终态不可回退，迟到的进度帧不会把已完成的
 *    子会话改回运行中（Orca `worker_done`「恰好发一次」的宿主侧等价物）。
 *  - 内部进展不打扰主会话：只有 ready / blocked / failed / dropped 会上报，
 *    progress 只更新看板（dsh 的 `internal_only` vs `notify`）。
 *  - **子会话始终免确认**：内核被推到 `yolo` 模式，且宿主对任何
 *    `session/request_permission` / `_iflow/plan/exit` 直接放行（模式推送失败
 *    时的兜底）。因此审批不会产生待办、不会阻塞子会话。只有
 *    `_iflow/user/questions` 是真正的信息缺口 —— 那是只有人才能回答的，落到
 *    子会话自己的 pending 槽位由看板就地作答（主会话的 pending 是单数槽位，
 *    多子会话并发会互相覆盖）。
 *  - **完成后自动带回改动**：按 `iflow.superAgent.integration` 自动合并到主
 *    工作区的当前分支，或推送分支并创建 PR。合并**串行**执行，且只在主工作区
 *    干净、不在中间态时进行；冲突自动 `merge --abort`，绝不把仓库留在冲突态。
 *
 * 汇报的来源是宿主观察到的事件，不是内核的 report 工具 —— 内核的
 * agent→client 方法表是固定集合，新增原生工具必须改 fork bundle（v1 不做）。
 */

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { AcpClient, AcpClientCallbacks } from "../acp/client.js";
import type {
  ExitPlanModeResponse,
  RequestPermissionResponse,
  TurnUsageReport,
  UserQuestion,
  UserQuestionsResponse,
} from "../acp/protocol.js";
import { estimateTokens } from "../../shared/session-state.js";
import { estimateCost } from "../../shared/context-window.js";
import {
  applySuperEvent,
  buildSuperReportPrompt,
  isTerminalSuperStatus,
  MAX_CONCURRENT_SUPER_SESSIONS,
  reportForSession,
  superIntegrationLabel,
  withIntegration,
  withUsage,
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
  createPullRequest,
  createWorktree,
  currentBranch,
  ghAvailable,
  inspectWorkingTree,
  mergeBranch,
  probeGitRepo,
  pushBranch,
  remoteOriginUrl,
  removeWorktree,
  sanitizeWorktreeName,
  superBranchName,
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

/** 子会话创建子 CLI 客户端的工厂。由宿主（panel）实现，复用主会话的
 * entry / node / 凭据解析，但把 cwd 与 allowedRoots 收窄到 worktree。 */
export type SuperClientFactory = (params: {
  cwd: string;
  allowedRoots: string[];
  label: string;
  callbacks: AcpClientCallbacks;
}) => Promise<AcpClient>;

export interface SuperAgentDeps {
  /** 主仓根目录（worktree 的来源）；非 git 仓库时降级为目录隔离。 */
  repoRoot: string;
  /** worktree 落盘根目录（扩展 globalStorage）。 */
  storageRoot: string;
  createClient: SuperClientFactory;
  /** 子会话列表变化（宿主写进 store.superSessions）。 */
  onSessionsChanged: (sessions: SuperSessionUi[]) => void;
  /** 需要主会话知道的状态更新（宿主转成给主会话的提示词）。 */
  onReport: (entries: { session: SuperSessionUi; report: SuperReport }[]) => void;
  /** 子会话使用的模型；跟随主会话当前模型，null = 用 CLI 的默认值。 */
  currentModel: () => string | null;
  /** 模型单价（USD / 百万 token）；null = 无单价记录，不显示成本。 */
  priceFor?: (modelId: string | null) => { input: number; output: number } | null;
  /** 完成后如何把分支带回主工作区（`iflow.superAgent.integration`，每次实时读）。 */
  integrationMode: () => SuperIntegrationMode;
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

export class SuperAgentManager {
  private readonly sessions = new Map<string, SuperSessionUi>();
  private readonly clients = new Map<string, AcpClient>();
  private readonly resolvers = new Map<string, PendingResolver>();
  /** 每个子会话的助手文本 —— 汇报摘要与输出 token 估算的来源。 */
  private readonly lastText = new Map<string, string>();
  /** 每个子会话的思考文本 —— 只用于输出 token 估算（思考也算生成开销）。 */
  private readonly lastThought = new Map<string, string>();
  /** 交给子会话的任务提示 token 估算 —— 内核没上报输入时的兜底下界。 */
  private readonly promptTokens = new Map<string, number>();
  /** 实时进度的节流定时器（每个子会话最多一个在飞）。 */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /** 超过并发上限时排队的派发请求。 */
  private readonly queue: { spec: SuperTaskSpec; id: string }[] = [];
  /** 已开始准备（真正占用了并发槽位）的子会话 id。 */
  private readonly started = new Set<string>();
  /** 集成（merge / push + PR）的串行链 —— 并发合并同一个工作区会把仓库搅乱。 */
  private integrationChain: Promise<void> = Promise.resolve();
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: SuperAgentDeps) {}

  // --- 对外 API -------------------------------------------------------------

  list(): SuperSessionUi[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): SuperSessionUi | undefined {
    return this.sessions.get(id);
  }

  /**
   * 派发一个子会话。立即返回记录（status = preparing），准备工作异步进行 ——
   * 委派指令一次可能带多个任务，调用方不该被 worktree 创建 + CLI 握手阻塞。
   *
   * 超过并发上限时请求进 FIFO 排队，槽位一空就自动开跑（「随时开启」）。
   */
  spawn(spec: SuperTaskSpec): SuperSessionUi {
    const now = Date.now();
    const id = `super-${now.toString(36)}-${(this.seq++).toString(36)}`;
    const session: SuperSessionUi = {
      id,
      title: spec.title,
      task: spec.task,
      status: "preparing",
      queued: true,
      isolation: { kind: "directory", path: "", note: "正在准备隔离环境" },
      createdAt: now,
      updatedAt: now,
      reports: [],
    };
    this.sessions.set(id, session);
    this.queue.push({ spec, id });
    this.emit();
    this.pump();
    return session;
  }

  /** 中断一个子会话（终止其 CLI 进程与当前轮次）。 */
  async cancel(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || isTerminalSuperStatus(session.status)) return false;
    const client = this.clients.get(id);
    if (client && session.cliSessionId) {
      try {
        client.cancel(session.cliSessionId);
      } catch {
        // 进程可能已经死了 —— 下面的 dispose 会兜住。
      }
    }
    await this.disposeClient(id);
    this.apply(id, { type: "cancelled", at: Date.now() });
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
   */
  async cleanup(
    id: string,
    options: { keepBranch?: boolean } = {},
  ): Promise<{ ok: boolean; branchKept?: boolean; reason?: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false };
    await this.disposeClient(id);
    this.forgetChild(id);
    if (!session.isolation.path) {
      this.sessions.delete(id);
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
      this.sessions.delete(id);
      this.emit();
      return { ok: result.removed, branchKept: result.branchKept, reason: result.reason };
    }
    // 目录隔离：直接删掉那个独立目录。
    await rm(session.isolation.path, { recursive: true, force: true }).catch(() => undefined);
    this.sessions.delete(id);
    this.emit();
    return { ok: true };
  }

  /**
   * 手动把一个子会话的分支合并回当前分支。
   *
   * 自动合并（`iflow.superAgent.integration = "merge"`）跳过时（工作区脏 /
   * 冲突）用户可以在这里补一刀，而不是只能去终端。
   */
  async merge(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "子会话不存在" };
    if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
      return { ok: false, error: "该子会话没有可合并的分支（仅目录隔离）" };
    }
    const result = await mergeBranch({ repoRoot: this.deps.repoRoot, branch: session.isolation.branch });
    if (result.ok) {
      // 手动合并也要留痕：看板据此把「合并」按钮置灰，主会话也能看到改动去向。
      this.recordIntegration(id, {
        mode: session.integration?.mode ?? "manual",
        state: "merged",
        detail: `已手动合入 ${(await currentBranch(this.deps.repoRoot)) ?? "当前分支"}`,
        at: Date.now(),
      });
    }
    return result;
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
      await this.disposeClient(id);
      if (!isTerminalSuperStatus(session.status)) {
        this.apply(id, { type: "cancelled", at: Date.now() });
      }
      if (session.isolation.path) {
        kept.push({ id, path: session.isolation.path, branch: session.isolation.branch });
      }
    }
    for (const resolver of this.resolvers.values()) {
      if (resolver.timer) clearTimeout(resolver.timer);
    }
    this.resolvers.clear();
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
    this.lastText.clear();
    this.lastThought.clear();
    this.promptTokens.clear();
    this.queue.length = 0;
    return kept;
  }

  // --- 内部 -----------------------------------------------------------------

  /** 队列泵：并发有空位时把排队的派发请求放出去。 */
  private pump(): void {
    while (this.queue.length > 0 && this.activeCount() < MAX_CONCURRENT_SUPER_SESSIONS) {
      const next = this.queue.shift();
      if (!next) return;
      this.started.add(next.id);
      void this.prepare(next.id, next.spec);
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

  private async prepare(id: string, spec: SuperTaskSpec): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || this.disposed) return;

    const slug = sanitizeWorktreeName(spec.title);
    const unique = `${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const probe = await probeGitRepo(this.deps.repoRoot);

    let isolation: SuperSessionUi["isolation"];
    if (probe.isRepo && probe.head) {
      const branch = superBranchName(`${slug}-${unique}`);
      const target = worktreePathFor(this.deps.storageRoot, this.deps.repoRoot, slug, unique);
      try {
        await createWorktree({ repoRoot: this.deps.repoRoot, targetPath: target, branch, baseRef: probe.head });
        isolation = { kind: "git_worktree", path: target, branch, baseRef: probe.head };
      } catch (error) {
        // 建 worktree 失败不能让整个委派失败 —— 退回目录隔离并如实标注。
        this.deps.log.warn(`worktree 创建失败，退回目录隔离：${errorMessage(error)}`);
        const dir = path.join(this.deps.storageRoot, "super-dirs", `${slug}-${unique}`);
        await mkdir(dir, { recursive: true });
        isolation = { kind: "directory", path: dir, note: "worktree 创建失败，仅目录隔离" };
      }
    } else {
      const dir = path.join(this.deps.storageRoot, "super-dirs", `${slug}-${unique}`);
      await mkdir(dir, { recursive: true });
      isolation = {
        kind: "directory",
        path: dir,
        note: probe.isRepo ? "仓库还没有任何提交，仅目录隔离" : "当前目录不是 git 仓库，仅目录隔离",
      };
    }

    const current = this.sessions.get(id);
    if (!current || this.disposed) return;
    this.sessions.set(id, { ...current, isolation, queued: false, updatedAt: Date.now() });
    this.emit();

    let model: string | null = null;
    let usageReport: TurnUsageReport | undefined;
    try {
      const client = await this.deps.createClient({
        cwd: isolation.path,
        allowedRoots: [isolation.path],
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

      // 免确认：把内核自己推到 yolo 模式，这样连审批往返都不会发生。
      // 推送失败也无所谓 —— callbacksFor 的自动放行是兜底。
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

      const taskPrompt = buildTaskPrompt(current.title, current.task, isolation);
      this.promptTokens.set(id, estimateTokens(taskPrompt));
      const response = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: taskPrompt }],
      });
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
        // 自动合并 / PR 只依赖 worktree 里的提交，与子进程无关。
        await this.integrate(id);
        this.notifyReport(id);
      }
    } catch (error) {
      this.apply(id, { type: "failed", error: errorMessage(error), at: Date.now() });
      this.notifyReport(id);
    } finally {
      // 结算进度与 token 用量：取消/失败也要留下已经产生的开销。
      this.finalizeProgress(id);
      this.recordUsage(id, model, usageReport);
      // 子会话的进程在轮次结束后不再需要 —— 留着只会白占内存。
      await this.disposeClient(id);
      this.started.delete(id);
      this.pump();
    }
  }

  private callbacksFor(id: string): AcpClientCallbacks {
    return {
      onSessionUpdate: (notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = extractText(update.content);
          if (!text) return;
          this.lastText.set(id, (this.lastText.get(id) ?? "") + text);
          this.scheduleProgress(id);
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          const text = extractText(update.content);
          if (!text) return;
          this.lastThought.set(id, (this.lastThought.get(id) ?? "") + text);
        }
      },
      // 免确认：审批直接放行，不产生待办、不打扰主会话。
      onRequestPermission: async (request) => {
        const allow =
          request.options.find((option) => option.kind === "allow_always") ??
          request.options.find((option) => option.kind.startsWith("allow"));
        if (!allow) {
          // 没有任何可放行的选项 —— 只能说「取消」，绝不伪造批准。
          this.deps.log.warn(
            `[${id}] 审批请求没有允许选项，按取消处理：${request.toolCall.toolName ?? "tool"}`,
          );
          return { outcome: { outcome: "cancelled" } } as RequestPermissionResponse;
        }
        this.deps.log.debug?.(
          `[${id}] 自动放行 ${request.toolCall.toolName ?? "tool"}（免确认模式）`,
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

    const record = (integration: Omit<SuperIntegration, "mode" | "at">): void => {
      this.recordIntegration(id, { mode, at: Date.now(), ...integration });
    };

    if (
      !(await branchHasUnmergedCommits({
        repoRoot: this.deps.repoRoot,
        branch: isolation.branch,
        baseRef: isolation.baseRef,
      }))
    ) {
      record({ state: "skipped", detail: "子会话没有产生任何提交" });
      return;
    }

    if (mode === "merge") {
      const tree = await inspectWorkingTree(this.deps.repoRoot);
      if (!tree.clean) {
        record({
          state: "skipped",
          needsAction: true,
          detail: tree.inProgress
            ? `主工作区正处于 ${tree.inProgress} 中间态，分支已保留待你手动合并`
            : `主工作区有 ${tree.dirtyCount} 处未提交改动，分支已保留待你手动合并`,
        });
        return;
      }
      const result = await mergeBranch({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
      if (result.ok) {
        const target = (await currentBranch(this.deps.repoRoot)) ?? "当前分支";
        record({ state: "merged", detail: `已合入 ${target}` });
      } else {
        record({
          state: "conflict",
          needsAction: true,
          detail: `自动合并冲突，已撤销合并；分支 ${isolation.branch} 仍在：${result.error}`,
        });
      }
      return;
    }

    // mode === "pr"
    if (!(await remoteOriginUrl(this.deps.repoRoot))) {
      record({ state: "failed", needsAction: true, detail: "仓库没有配置 origin 远程，分支已保留" });
      return;
    }
    if (!(await ghAvailable())) {
      record({
        state: "failed",
        needsAction: true,
        detail: "未找到 gh CLI，分支已保留（可手动合并或自行推送）",
      });
      return;
    }
    const pushed = await pushBranch({ repoRoot: this.deps.repoRoot, branch: isolation.branch });
    if (!pushed.ok) {
      record({ state: "failed", needsAction: true, detail: `推送分支失败：${pushed.error}` });
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
      record({
        state: "pr_created",
        detail: `已推送到 origin，目标分支 ${base}`,
        url: pr.url || undefined,
      });
    } else {
      record({ state: "failed", needsAction: true, detail: `创建 PR 失败：${pr.error}` });
    }
  }

  /** 写入集成结果（元数据补记，不经过状态机 —— 终态会话的事件会被丢弃）。 */
  private recordIntegration(id: string, integration: SuperIntegration): void {
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.set(id, withIntegration(current, integration));
    this.emit();
    this.deps.log.info(
      `super agent: ${id} 集成 ${integration.state}${integration.detail ? ` — ${integration.detail}` : ""}`,
    );
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
   */
  private integrationReport(session: SuperSessionUi): SuperReport | null {
    const integration = session.integration;
    if (!integration || !integration.needsAction) return null;
    return {
      state: "blocked",
      summary: `${superIntegrationLabel(integration)}${integration.detail ? `：${integration.detail}` : ""}`,
      at: integration.at,
      humanAction: integration.detail ?? "子会话的改动没有自动带回主工作区",
    };
  }

  /** 汇报给主会话的提示词（宿主用它向主会话发一条 prompt）。 */
  reportPrompt(entries: { session: SuperSessionUi; report: SuperReport }[]): string {
    return buildSuperReportPrompt(entries);
  }

  private summarize(id: string): string {
    const text = (this.lastText.get(id) ?? "").trim();
    if (!text) return "（子会话没有留下文本摘要）";
    return text.length > 800 ? `${text.slice(0, 799)}…` : text;
  }

  /** 清理已删除子会话的附属状态（文本缓冲、节流定时器）。 */
  private forgetChild(id: string): void {
    const timer = this.progressTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(id);
    }
    this.lastText.delete(id);
    this.lastThought.delete(id);
    this.promptTokens.delete(id);
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

  private emit(): void {
    this.deps.onSessionsChanged(this.list());
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

export interface SuperAnswer {
  answers?: Record<string, string | string[]>;
}

/** 交给子会话的任务提示词。子会话看不到主会话的上下文，所以任务说明必须自包含。 */
export function buildTaskPrompt(
  title: string,
  task: string,
  isolation: SuperSessionUi["isolation"],
): string {
  const lines = [
    `你是一个子会话，负责完成下面这一项独立任务。`,
    ``,
    `任务标题：${title}`,
    ``,
    `任务说明：`,
    task.trim(),
    ``,
    `工作目录：${isolation.path}`,
  ];
  if (isolation.branch) {
    lines.push(`你的改动都在分支 ${isolation.branch} 上，不要切换分支，也不要动工作目录以外的文件。`);
  }
  lines.push(
    `不要动工作目录以外（尤其是主工作区）的文件。`,
    `你处于免确认模式：工具调用不会被审批。请自行判断风险，不要执行与任务无关的破坏性命令。`,
    `完成后由宿主负责把你的改动带回主工作区，你不需要自己合并、推送或创建 PR。`,
    ``,
    `完成后用一段话总结：做了什么、结论是什么、还剩什么没做。这段总结会被原样转达给主会话。`,
  );
  return lines.join("\n");
}

/** PR 正文：任务说明 + 来源标注（不编造测试结果或影响面）。 */
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
