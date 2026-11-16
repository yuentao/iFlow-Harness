/**
 * QQ 任务的本地持久层（Extension Host only；零 vscode 依赖，便于单测）。
 *
 * 目录布局（根目录由构造函数传入，模块不自行计算 homedir）：
 *
 *   <root>/tasks/<taskId>.json   每个任务一份完整记录
 *   <root>/tasks/index.json      轻量索引（列表页只读它，不扫全量文件）
 *   <root>/events.ndjson         追加式事件日志（一行一个 JSON）
 *   <root>/bindings.json         允许使用通道的用户 / 群白名单
 *
 * 写入纪律（与 `src/panel/super-store.ts` 同一套做法）：
 *  1. 每个目标文件先写 `<file>.tmp-<random>` 再 `rename` —— 进程被杀时磁盘上
 *     要么是旧内容要么是新内容，不会留下半截 JSON；
 *  2. 同一路径的写操作在进程内用 promise 链串行化，两个写不会共用临时文件，
 *     也不会出现「后写的先落地」的丢更新；
 *  3. 索引是读-改-写，必须整段串行（`indexChain`），否则并发 saveTask 会
 *     各自读到旧索引、各自写回，先写的条目被后写的覆盖掉。
 *
 * 容错纪律：坏 JSON **绝不** 抛崩调用方 —— 单条任务文件读不出来就按不存在
 * 处理，扫描类 API（rebuildIndex / pruneTasks）在返回值里如实列出 `skipped`。
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 任务记录的最小形状（其余字段原样序列化，不做改写）。 */
export interface QqTaskRecord {
  taskId: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  chatId?: string;
  senderId?: string;
  [key: string]: unknown;
}

/** 索引条目。字段固定为这几项，读取时缺失字段会补默认值。 */
export interface QqTaskIndexEntry {
  taskId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  chatId: string;
  senderId: string;
}

export interface QqTaskListOptions {
  /** 最多返回多少条（按 updatedAt 倒序后截断）。 */
  limit?: number;
  /** 只返回该状态的任务（精确匹配）。 */
  status?: string;
  /** 只返回 updatedAt >= since 的任务（毫秒时间戳）。 */
  since?: number;
}

/** 追加事件日志的一行。detail 由调用方自定，**不得**放凭据等敏感信息。 */
export interface QqTaskEvent {
  type: string;
  /** 毫秒时间戳；缺省用当前时间。 */
  ts?: number;
  taskId?: string;
  detail?: unknown;
}

/** 通道绑定白名单。 */
export interface QqBindings {
  users: string[];
  groups: string[];
}

export interface QqRebuildIndexResult {
  indexed: number;
  /** 读不出来而被跳过的任务文件名（basename）。 */
  skipped: string[];
}

export interface QqPruneResult {
  deleted: string[];
  /** 读不出来 / 删不掉而被跳过的任务文件名（basename）。 */
  skipped: string[];
}

/**
 * 默认的终态状态集。
 *
 * `shared/qq-task.ts` 由另一个子会话定义，本模块刻意不 import 它 —— 两处
 * 若要用同一套词表，由调用方通过构造参数 `terminalStatuses` 传入，避免
 * 在这里猜死对方的状态机。
 */
export const DEFAULT_TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "done",
  "error",
  "aborted",
  "interrupted",
];

const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

/** 进程内临时文件序号，配合 pid + 随机串保证唯一。 */
let tmpSeq = 0;

function tmpSuffix(): string {
  return `${process.pid.toString(36)}-${(tmpSeq++).toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** 一次原子写：唯一临时文件 → rename 覆盖。失败时清掉临时文件。 */
async function writeJsonAtomic(target: string, payload: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${tmpSuffix()}`;
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 任务 id → 文件名。
 *
 * 任务 id 来自上层的协议，可能带路径分隔符或非 ASCII 字符，**不能**直接拼进
 * 文件路径（否则可以逃出 tasks/）。安全字符直接保留；一旦发生替换，就追加
 * 原 id 的短哈希，避免「任务A」与「任务B」都被压成同一个 `-.json` 互相覆盖。
 */
export function qqTaskFileName(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (safe === taskId) return `${safe}.json`;
  const hash = createHash("sha1").update(taskId, "utf8").digest("hex").slice(0, 8);
  return `${safe.slice(0, 64)}-${hash}.json`;
}

/** 从任意对象里抽取索引条目；没有可用 taskId 时返回 null。 */
function entryFromRecord(raw: unknown, fallback?: QqTaskIndexEntry): QqTaskIndexEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const taskId =
    typeof record.taskId === "string" && record.taskId.length > 0
      ? record.taskId
      : fallback?.taskId;
  if (!taskId) return null;
  const createdAt = numOr(record.createdAt, fallback?.createdAt ?? 0);
  return {
    taskId,
    status: strOr(record.status, fallback?.status ?? "unknown"),
    createdAt,
    updatedAt: numOr(record.updatedAt, fallback?.updatedAt ?? createdAt),
    chatId: strOr(record.chatId, fallback?.chatId ?? ""),
    senderId: strOr(record.senderId, fallback?.senderId ?? ""),
  };
}

/** 字符串 id 列表归一：去空白、去空值、去重（保持首次出现顺序）。 */
function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export class QqTaskStore {
  /** 存储根目录（测试与调用方都要能拿到它定位文件）。 */
  readonly rootDir: string;

  private readonly tasksDir: string;
  private readonly indexPath: string;
  private readonly eventsPath: string;
  private readonly bindingsPath: string;
  private readonly terminalStatuses: ReadonlySet<string>;

  /** 每个目标路径的写链（同一路径的写串行）。 */
  private readonly writeChains = new Map<string, Promise<unknown>>();
  /** 索引的读-改-写链（整段串行，避免丢更新）。 */
  private indexChain: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string, options: { terminalStatuses?: readonly string[] } = {}) {
    this.rootDir = rootDir;
    this.tasksDir = path.join(rootDir, "tasks");
    this.indexPath = path.join(this.tasksDir, INDEX_FILE);
    this.eventsPath = path.join(rootDir, "events.ndjson");
    this.bindingsPath = path.join(rootDir, "bindings.json");
    const statuses = options.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES;
    this.terminalStatuses = new Set(statuses.map((status) => status.toLowerCase()));
  }

  /** 状态是否属于终态（大小写不敏感）。 */
  isTerminalStatus(status: string): boolean {
    return this.terminalStatuses.has(status.trim().toLowerCase());
  }

  /**
   * 保存（或整体覆盖）一个任务，并同步索引。
   *
   * 传入对象原样序列化（不裁剪字段）；索引只抽取固定几项，调用方没给
   * `createdAt` 时沿用索引里的旧值，`updatedAt` 缺省视为「现在」。
   */
  async saveTask(task: QqTaskRecord): Promise<void> {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new TypeError("QqTaskStore.saveTask: task must be an object");
    }
    const record = task as unknown as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
    if (!taskId) {
      throw new TypeError("QqTaskStore.saveTask: task.taskId is required");
    }

    const payload = JSON.stringify({ ...record, taskId }, null, 2);
    const target = this.taskPath(taskId);
    await this.enqueueWrite(target, () => writeJsonAtomic(target, payload));

    await this.enqueueIndex(async () => {
      const { entries } = await this.readIndex();
      const previous = entries.find((entry) => entry.taskId === taskId);
      const now = Date.now();
      const next = entries.filter((entry) => entry.taskId !== taskId);
      next.push({
        taskId,
        status: strOr(record.status, previous?.status ?? "unknown"),
        createdAt: numOr(record.createdAt, previous?.createdAt ?? now),
        // 一次保存就是一次更新：调用方没显式给 updatedAt 时推进到当前时间。
        updatedAt: numOr(record.updatedAt, now),
        chatId: strOr(record.chatId, previous?.chatId ?? ""),
        senderId: strOr(record.senderId, previous?.senderId ?? ""),
      });
      await this.writeIndex(next);
    });
  }

  /** 读取一个任务；文件不存在或内容损坏一律返回 null（绝不抛错）。 */
  async loadTask(taskId: string): Promise<unknown | null> {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) return null;
    let raw: string;
    try {
      raw = await readFile(this.taskPath(id), "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * 列出任务（只读索引，不逐条打开任务文件）。
   *
   * 索引损坏时自动 `rebuildIndex()` 重建一次再返回 —— 这是唯一的扫描回退，
   * 正常路径不会碰全量文件。
   */
  async listTasks(options: QqTaskListOptions = {}): Promise<QqTaskIndexEntry[]> {
    let { entries, damaged } = await this.readIndex();
    if (damaged) {
      try {
        await this.rebuildIndex();
        ({ entries } = await this.readIndex());
      } catch {
        entries = [];
      }
    }

    const { status, since, limit } = options;
    let result = entries;
    if (typeof status === "string" && status.length > 0) {
      result = result.filter((entry) => entry.status === status);
    }
    if (typeof since === "number" && Number.isFinite(since)) {
      result = result.filter((entry) => entry.updatedAt >= since);
    }
    result = [...result].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId),
    );
    if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
      result = result.slice(0, Math.floor(limit));
    }
    return result;
  }

  /** 追加一行事件日志（NDJSON；字符串里的换行会被 JSON 转义，不会破行）。 */
  async appendEvent(event: QqTaskEvent): Promise<void> {
    if (!event || typeof event !== "object") {
      throw new TypeError("QqTaskStore.appendEvent: event must be an object");
    }
    const ts =
      typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : Date.now();
    const record: Record<string, unknown> = {
      ts,
      type: strOr(event.type, "unknown"),
    };
    if (typeof event.taskId === "string" && event.taskId.length > 0) {
      record.taskId = event.taskId;
    }
    if (event.detail !== undefined) record.detail = event.detail;
    const line = `${JSON.stringify(record)}\n`;

    await this.enqueueWrite(this.eventsPath, async () => {
      await mkdir(this.rootDir, { recursive: true });
      await appendFile(this.eventsPath, line, "utf8");
    });
  }

  /** 读绑定白名单；文件缺失或损坏时返回空列表（不抛错）。 */
  async loadBindings(): Promise<QqBindings> {
    let raw: string;
    try {
      raw = await readFile(this.bindingsPath, "utf8");
    } catch {
      return { users: [], groups: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { users: [], groups: [] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { users: [], groups: [] };
    }
    const source = parsed as Record<string, unknown>;
    return {
      users: normalizeIdList(source.users),
      groups: normalizeIdList(source.groups),
    };
  }

  /** 写绑定白名单（归一化后原子落盘），返回实际写入的内容。 */
  async saveBindings(bindings: QqBindings): Promise<QqBindings> {
    const normalized: QqBindings = {
      users: normalizeIdList(bindings?.users),
      groups: normalizeIdList(bindings?.groups),
    };
    const payload = JSON.stringify(normalized, null, 2);
    await this.enqueueWrite(this.bindingsPath, () =>
      writeJsonAtomic(this.bindingsPath, payload),
    );
    return normalized;
  }

  /**
   * 清理终态且超期的任务。
   *
   * 只按索引挑候选，但删除前**必须**再读一次任务文件核对状态与更新时间：
   * 索引可能陈旧，凭陈旧索引删掉一个还在跑的任务是不可接受的。核对不上
   * （文件说非终态 / 更新时间其实很新）时以文件为准，顺手修正索引条目。
   *
   * 文件已经不在（索引陈旧）时直接丢掉该索引项，计为 deleted。
   */
  async pruneTasks(olderThanDays: number): Promise<QqPruneResult> {
    const days =
      typeof olderThanDays === "number" && Number.isFinite(olderThanDays) && olderThanDays > 0
        ? olderThanDays
        : 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    return this.enqueueIndex(async () => {
      const { entries, damaged } = await this.readIndex();
      const result: QqPruneResult = { deleted: [], skipped: [] };
      if (damaged) {
        // 索引读不出来时一条都不删：宁可留着任务，也不在看不见全貌时误删。
        result.skipped.push(INDEX_FILE);
        return result;
      }

      const keep: QqTaskIndexEntry[] = [];
      for (const entry of entries) {
        if (!this.isTerminalStatus(entry.status) || entry.updatedAt >= cutoff) {
          keep.push(entry);
          continue;
        }

        const file = this.taskPath(entry.taskId);
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch {
          // 任务文件已不在：索引项是陈旧的，直接丢掉。
          result.deleted.push(entry.taskId);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          result.skipped.push(path.basename(file));
          keep.push(entry);
          continue;
        }
        const record =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        if (!record) {
          result.skipped.push(path.basename(file));
          keep.push(entry);
          continue;
        }

        const status = strOr(record.status, entry.status);
        const updatedAt = numOr(record.updatedAt, entry.updatedAt);
        if (!this.isTerminalStatus(status) || updatedAt >= cutoff) {
          keep.push(entryFromRecord(record, entry) ?? entry);
          continue;
        }

        try {
          await rm(file, { force: true });
          result.deleted.push(entry.taskId);
        } catch {
          result.skipped.push(path.basename(file));
          keep.push(entry);
        }
      }

      await this.writeIndex(keep);
      return result;
    });
  }

  /** 以磁盘上的任务文件为准重建索引；坏文件跳过并如实报告。 */
  async rebuildIndex(): Promise<QqRebuildIndexResult> {
    return this.enqueueIndex(async () => {
      let names: string[];
      try {
        names = await readdir(this.tasksDir);
      } catch {
        names = [];
      }

      const byId = new Map<string, QqTaskIndexEntry>();
      const skipped: string[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json") || name === INDEX_FILE || name.includes(".tmp-")) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path.join(this.tasksDir, name), "utf8"));
        } catch {
          skipped.push(name);
          continue;
        }
        const entry = entryFromRecord(parsed);
        if (!entry) {
          skipped.push(name);
          continue;
        }
        byId.set(entry.taskId, entry);
      }

      const entries = [...byId.values()];
      await this.writeIndex(entries);
      return { indexed: entries.length, skipped };
    });
  }

  private taskPath(taskId: string): string {
    return path.join(this.tasksDir, qqTaskFileName(taskId));
  }

  /** 索引读取：缺失＝空（正常）；损坏＝damaged（调用方可重建）。 */
  private async readIndex(): Promise<{ entries: QqTaskIndexEntry[]; damaged: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch {
      return { entries: [], damaged: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { entries: [], damaged: true };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { entries: [], damaged: true };
    }
    const tasksRaw = (parsed as Record<string, unknown>).tasks;
    if (!Array.isArray(tasksRaw)) {
      return { entries: [], damaged: true };
    }

    const entries: QqTaskIndexEntry[] = [];
    for (const item of tasksRaw) {
      const entry = entryFromRecord(item);
      // 单条条目坏掉不构成「索引损坏」——跳过它，其余照读。
      if (entry) entries.push(entry);
    }
    return { entries, damaged: false };
  }

  /** 索引写入（调用方必须已持有 `indexChain`）。 */
  private async writeIndex(entries: QqTaskIndexEntry[]): Promise<void> {
    const payload = JSON.stringify({ version: INDEX_VERSION, tasks: entries }, null, 2);
    await writeJsonAtomic(this.indexPath, payload);
  }

  /**
   * 同一路径的写串行排队。
   *
   * 注意：这里只接受独立的写操作；带索引的读-改-写（saveTask / prune /
   * rebuild）都在拿到此链之后再取索引锁，顺序恒为「写链 → 索引锁」，不会
   * 出现反向嵌套而死锁。
   */
  private enqueueWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    // 链里存「吞掉错误」的版本：一次写失败不能把后续写全部卡死。
    this.writeChains.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  /** 索引的整段读-改-写串行排队。 */
  private enqueueIndex<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.indexChain.catch(() => undefined).then(operation);
    this.indexChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
