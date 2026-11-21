/**
 * Super Agent 看板的波次聚合纯逻辑（零 VSCode / 零 React 依赖）。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────────
 * 看板从「单子会话平铺」升级为「运行组 / 波次 / 诊断」聚合视图后，需要一层
 * 不依赖 UI 的视图模型：把宿主推送的扁平 SuperSessionUi 列表整理成
 *  runId → wave → session 的三层结构，并在每层算出同口径的统计。
 * 这一层必须与 React 无关，才能在 node 测试里直接断言统计口径与纯度。
 *
 * ── 向前兼容（重要） ──────────────────────────────────────────────────────
 * `SuperSessionUi` 的新字段（runId / wave / batch / dependsOn / maxAttempts /
 * lastError / diagnostics / statusDetail）由另一条并行改造线加入 shared 层。
 * 本模块**不 import**这些尚不存在的导出，而是用结构兼容的本地视图模型
 * `SuperBoardSession = SuperSessionUi & { 全部可选字段 }`：
 *   · 旧的 SuperSessionUi 天然可赋值（可选字段缺失 → 当成「无分组信息」）；
 *   · 改造落地后同名字段直接对上，无需改动本模块。
 * 所有缺失字段都有明确降级，绝不出现 undefined 文案、NaN 或白屏。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * 纯函数、无副作用、不改入参；每次调用返回全新的对象与数组（不返回模块级
 * 可变单例）。统计口径刻意复用 shared/super-agent.ts 的 sumSuperUsage /
 * summarizeSuperSessions（cancelled 单独计、不计入 failed），只在它们之上
 * 增加「重试中 / 阻塞」两个更细的维度。
 */
import type { SuperSessionUi } from "./super-agent.js";
import { sumSuperUsage, summarizeSuperSessions } from "./super-agent.js";

/** 诊断事件（结构兼容 shared 层将新增的 SuperDiagnosticEvent，字段全可选消费）。 */
export interface SuperBoardDiagnosticEvent {
  at: number;
  kind: string;
  level: string;
  message: string;
  detail?: string;
}

/** 看板聚合用的子会话视图模型：全部扩展字段可选，旧数据天然可赋值。 */
export type SuperBoardSession = SuperSessionUi & {
  runId?: string;
  wave?: number;
  batch?: number;
  dependsOn?: string[];
  attempts?: number;
  maxAttempts?: number;
  lastError?: { kind: string; message: string; at: number };
  diagnostics?: SuperBoardDiagnosticEvent[];
  statusDetail?: string;
};

/** 没有 runId 的子会话归入这个默认运行组（UI 侧翻成「默认运行组」文案）。 */
export const SUPER_BOARD_DEFAULT_RUN_ID = "default";

/** 没有 wave 的子会话归入波次 0（UI 侧不显示波次标记，退化成旧视图）。 */
export const SUPER_BOARD_DEFAULT_WAVE = 0;

/** 失败分类（交给 UI 翻成中文；shared 只给稳定的英文 enum，绝不过 t() 字典）。 */
export type SuperBoardFailureKind = "retryable" | "terminal" | "blocked" | "interrupted";

/** 各层的状态统计。running 含 retrying（重试中是运行中的子集），blocked 独立计。 */
export interface SuperBoardCounts {
  total: number;
  done: number;
  failed: number;
  retrying: number;
  blocked: number;
  running: number;
  cancelled: number;
}

/** token 口径与 sumSuperUsage 完全一致。 */
export interface SuperBoardUsage {
  input: number;
  output: number;
  estimatedCost: number | null;
}

/** 单个波次（同一 runId 下 wave 相同的一组子会话）。 */
export interface SuperBoardWave {
  /** 波次号；缺省为 0。 */
  wave: number;
  sessions: SuperBoardSession[];
  counts: SuperBoardCounts;
  usage: SuperBoardUsage;
  /** 最早开始时间 = min(startedAt ?? createdAt)；没有会话时为 undefined。 */
  startedAt?: number;
  /** 最晚结束时间 = max(endedAt)，只统计真的结束过的会话。 */
  endedAt?: number;
}

/** 单个运行组（同一 runId 的一组子会话）。 */
export interface SuperBoardGroup {
  runId: string;
  /** 是否是无 runId 的默认组（UI 据此显示「默认运行组」）。 */
  isDefault: boolean;
  sessions: SuperBoardSession[];
  counts: SuperBoardCounts;
  usage: SuperBoardUsage;
  waves: SuperBoardWave[];
  startedAt?: number;
  endedAt?: number;
}

/** 诊断事件的 kind 计数（按数量降序、kind 升序，稳定）。 */
export interface SuperBoardDiagnosticKindCount {
  kind: string;
  count: number;
}

/** 跨子会话最近一条错误信息。 */
export interface SuperBoardLastError {
  sessionId: string;
  sessionTitle: string;
  at: number;
  message: string;
}

/** 诊断汇总。 */
export interface SuperBoardDiagnosticSummary {
  total: number;
  byKind: SuperBoardDiagnosticKindCount[];
  lastError?: SuperBoardLastError;
}

/** 带来源的诊断时间线条目。 */
export interface SuperBoardDiagnosticTimelineEntry extends SuperBoardDiagnosticEvent {
  sessionId: string;
  sessionTitle: string;
}

/** 整块看板的聚合结果。 */
export interface SuperBoardAggregate {
  groups: SuperBoardGroup[];
  counts: SuperBoardCounts;
  usage: SuperBoardUsage;
  diagnostics: SuperBoardDiagnosticSummary;
}

// ── 单一会话的判定 ────────────────────────────────────────────────────────

/** 运行中（含准备中；排队中的 preparing 也算，与 summarizeSuperSessions 同口径）。 */
export function isSuperBoardRunning(session: SuperBoardSession): boolean {
  return session.status === "preparing" || session.status === "running";
}

/** 正在重试：运行中的会话且 attempts > 1（缺省按 1 次处理）。 */
export function isSuperBoardRetrying(session: SuperBoardSession): boolean {
  return isSuperBoardRunning(session) && (session.attempts ?? 1) > 1;
}

/** 阻塞：等你回答，或最近一次错误被归类为 blocked。 */
export function isSuperBoardBlocked(session: SuperBoardSession): boolean {
  return session.status === "awaiting_input" || session.lastError?.kind === "blocked";
}

/** 失败分类。旧数据按状态兜底：failed→可重试、awaiting_input→阻塞、cancelled→已中断。 */
export function superBoardFailureKind(session: SuperBoardSession): SuperBoardFailureKind | null {
  const raw = session.lastError?.kind;
  if (raw === "retryable" || raw === "terminal" || raw === "blocked" || raw === "interrupted") {
    return raw;
  }
  if (session.status === "cancelled") return "interrupted";
  if (session.status === "failed") return "retryable";
  if (isSuperBoardBlocked(session)) return "blocked";
  return null;
}

/** 会话的开始时间（startedAt 优先，缺则退 createdAt；两者都缺给 0 保底）。 */
export function superBoardStartAt(session: SuperBoardSession): number {
  return session.startedAt ?? session.createdAt ?? 0;
}

// ── 统计 ──────────────────────────────────────────────────────────────────

/** 一层（组 / 波次 / 全量）的状态统计。done/failed/cancelled 直接复用 shared 口径。 */
export function countSuperBoardSessions(sessions: readonly SuperBoardSession[]): SuperBoardCounts {
  const base = summarizeSuperSessions(sessions);
  let retrying = 0;
  let blocked = 0;
  for (const session of sessions) {
    if (isSuperBoardRetrying(session)) retrying++;
    if (isSuperBoardBlocked(session)) blocked++;
  }
  return {
    total: base.total,
    done: base.done,
    failed: base.failed,
    retrying,
    blocked,
    running: base.running,
    cancelled: base.cancelled,
  };
}

/** token 合计（直接复用 sumSuperUsage，口径一致：成本不全则不显示）。 */
export function sumSuperBoardUsage(sessions: readonly SuperBoardSession[]): SuperBoardUsage {
  const usage = sumSuperUsage(sessions);
  return {
    input: usage.input,
    output: usage.output,
    estimatedCost: usage.estimatedCost,
  };
}

/** 一层的时间区间。startedAt 取 min(start ?? created)，endedAt 只取真的结束过的。 */
function timeRange(sessions: readonly SuperBoardSession[]): {
  startedAt?: number;
  endedAt?: number;
} {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const session of sessions) {
    const start = superBoardStartAt(session);
    if (startedAt === undefined || start < startedAt) startedAt = start;
    if (session.endedAt !== undefined && (endedAt === undefined || session.endedAt > endedAt)) {
      endedAt = session.endedAt;
    }
  }
  return { startedAt, endedAt };
}

// ── 诊断 ──────────────────────────────────────────────────────────────────

function isErrorLevel(level: string): boolean {
  const lowered = level.toLowerCase();
  return lowered === "error" || lowered === "fatal" || lowered === "critical";
}

/** 按 kind 聚合并找最近一条错误（同时看 diagnostics 与 lastError）。 */
export function summarizeSuperBoardDiagnostics(
  sessions: readonly SuperBoardSession[],
): SuperBoardDiagnosticSummary {
  const byKind = new Map<string, number>();
  let total = 0;
  let lastError: SuperBoardLastError | undefined;

  const considerError = (session: SuperBoardSession, at: number, message: string) => {
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (lastError === undefined || at > lastError.at) {
      lastError = {
        sessionId: session.id,
        sessionTitle: session.title,
        at,
        message,
      };
    }
  };

  for (const session of sessions) {
    const events = session.diagnostics;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (!event || typeof event.kind !== "string") continue;
        total += 1;
        byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
        if (isErrorLevel(String(event.level ?? ""))) {
          considerError(session, event.at, event.message ?? "");
        }
      }
    }
    const last = session.lastError;
    if (last && typeof last.message === "string") {
      considerError(session, last.at, last.message);
    }
  }

  const sortedKinds = [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  return {
    total,
    byKind: sortedKinds,
    ...(lastError ? { lastError } : {}),
  };
}

/**
 * 跨子会话的诊断时间线：事件按 at 降序（同一时刻按 sessionId / 原文稳定排序）。
 * 每条都带来源子会话信息，返回全新对象，不改入参。
 */
export function collectSuperBoardDiagnosticTimeline(
  sessions: readonly SuperBoardSession[],
): SuperBoardDiagnosticTimelineEntry[] {
  const out: SuperBoardDiagnosticTimelineEntry[] = [];
  for (const session of sessions) {
    const events = session.diagnostics;
    if (!Array.isArray(events)) continue;
    events.forEach((event) => {
      if (!event || typeof event.kind !== "string") return;
      out.push({
        at: typeof event.at === "number" && Number.isFinite(event.at) ? event.at : 0,
        kind: event.kind,
        level: String(event.level ?? "info"),
        message: String(event.message ?? ""),
        ...(event.detail !== undefined ? { detail: String(event.detail) } : {}),
        sessionId: session.id,
        sessionTitle: session.title,
      });
    });
  }
  out.sort(
    (a, b) =>
      b.at - a.at ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
  return out;
}

/** 单个子会话的诊断时间线（复用跨会话版本，按 id 过滤）。 */
export function collectSuperSessionDiagnostics(
  session: SuperBoardSession,
): SuperBoardDiagnosticTimelineEntry[] {
  return collectSuperBoardDiagnosticTimeline([session]);
}

// ── 分组 / 聚合 ───────────────────────────────────────────────────────────

function compareSessions(a: SuperBoardSession, b: SuperBoardSession): number {
  return (
    (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** 组内按 wave 分层（wave 升序，缺省归 0；每层都是新数组）。 */
export function aggregateSuperBoardWaves(
  sessions: readonly SuperBoardSession[],
): SuperBoardWave[] {
  const buckets = new Map<number, SuperBoardSession[]>();
  for (const session of sessions) {
    const raw = session.wave;
    const wave =
      typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : SUPER_BOARD_DEFAULT_WAVE;
    const bucket = buckets.get(wave);
    if (bucket) bucket.push(session);
    else buckets.set(wave, [session]);
  }
  const waves: SuperBoardWave[] = [];
  for (const [wave, bucket] of buckets) {
    const ordered = [...bucket].sort(compareSessions);
    const range = timeRange(ordered);
    waves.push({
      wave,
      sessions: ordered,
      counts: countSuperBoardSessions(ordered),
      usage: sumSuperBoardUsage(ordered),
      ...(range.startedAt !== undefined ? { startedAt: range.startedAt } : {}),
      ...(range.endedAt !== undefined ? { endedAt: range.endedAt } : {}),
    });
  }
  waves.sort((a, b) => a.wave - b.wave);
  return waves;
}

/** 按 runId 分组（无 runId 归默认组），组内再按 wave 分层。组按最早创建时间排序。 */
export function groupSuperBoardSessions(
  sessions: readonly SuperBoardSession[],
): SuperBoardGroup[] {
  const buckets = new Map<string, SuperBoardSession[]>();
  for (const session of sessions) {
    const raw = session.runId;
    const runId =
      typeof raw === "string" && raw.trim().length > 0 ? raw : SUPER_BOARD_DEFAULT_RUN_ID;
    const bucket = buckets.get(runId);
    if (bucket) bucket.push(session);
    else buckets.set(runId, [session]);
  }
  const groups: SuperBoardGroup[] = [];
  for (const [runId, bucket] of buckets) {
    const ordered = [...bucket].sort(compareSessions);
    const range = timeRange(ordered);
    groups.push({
      runId,
      isDefault: runId === SUPER_BOARD_DEFAULT_RUN_ID,
      sessions: ordered,
      counts: countSuperBoardSessions(ordered),
      usage: sumSuperBoardUsage(ordered),
      waves: aggregateSuperBoardWaves(ordered),
      ...(range.startedAt !== undefined ? { startedAt: range.startedAt } : {}),
      ...(range.endedAt !== undefined ? { endedAt: range.endedAt } : {}),
    });
  }
  groups.sort((a, b) => {
    const sa = a.startedAt ?? 0;
    const sb = b.startedAt ?? 0;
    return sa - sb || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  });
  return groups;
}

/** 一次算出整块看板的聚合结果（组 / 波次 / 全量统计 / 诊断汇总）。 */
export function buildSuperBoardAggregate(
  sessions: readonly SuperBoardSession[],
): SuperBoardAggregate {
  return {
    groups: groupSuperBoardSessions(sessions),
    counts: countSuperBoardSessions(sessions),
    usage: sumSuperBoardUsage(sessions),
    diagnostics: summarizeSuperBoardDiagnostics(sessions),
  };
}
