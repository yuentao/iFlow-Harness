/**
 * QQ 授权模型的「待审核用户」持久层（2026-11-17，Extension Host only）。
 *
 * 背景：官方 QQBot 接口只给 openid（私聊 `author.id` / 群聊 `member_openid`），
 * 不提供 QQ 号；扫码绑定返回的 `creds.userOpenid` 就是「扫码者本人」的唯一
 * 标识。新的授权模型因此是：
 *
 *  - **扫码者自动入白名单**（panel 在扫码成功时写入 `allowedUsers`）；
 *  - **其他人首次消息进审核队列**（这里）：不执行任务、不回执，只在面板里
 *    留下一条待审核记录，由用户放行或拒绝；
 *  - **放行** → 写进 `allowedUsers`；**拒绝** → 记入 rejected 集合，同一个
 *    openid 不会再冒出来骚扰。
 *
 * 目录布局：`<root>/pending-users.json`（root 由调用方传入，与任务存储共用
 * `<storage>/qq`）。写入纪律与 `src/qq/store.ts` 相同：唯一临时文件 + rename
 * 原子替换，进程内按路径串行化。
 *
 * 脱敏纪律：**存储保留原值**（openid 是写回白名单的唯一依据），脱敏只在 UI
 * 层做、日志里不写 openid。本模块只在「时间清退」与「满队丢弃」这两类需要
 * 人注意的事件上打一行日志（可注入 logger 替换），不 import vscode。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 待审核记录的存活时长：超过这么多天**没有被再看到**（`lastSeenAt` 过旧）的
 * 记录自动清退。
 *
 * 为什么要清退：队列按 `firstSeenAt` 保留最早出现的记录、且没有任何时间
 * 衰减，50 条长期无人处理的旧记录会把队列彻底堵死——之后所有合法新用户都
 * 进不来，而且旧实现对此完全静默。7 天是保守取值：真正需要放行的人通常
 * 会在这段时间内被处理或被再次看到（重复消息会刷新 `lastSeenAt`）。
 */
export const QQ_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 待审核队列上限：超出时按 `firstSeenAt` **保留最早出现的**记录、丢掉最新
 * 出现的——排队越久越可能是真正需要处理的人。淘汰只看首次出现时间，同一
 * 发送者的重复消息（只刷新 `lastSeenAt` / count）不会改变优先级，因此刷消息
 * 挤不掉别人的记录。满队丢弃必须可观测（见 {@link QqPendingAddOutcome}），
 * 绝不静默吞掉。
 */
export const QQ_PENDING_MAX_USERS = 50;
/** 拒绝集合上限：只保留最近 100 个，防止文件无限增长。 */
export const QQ_PENDING_MAX_REJECTED = 100;
/** 消息预览字符上限（按码点截断，不会切碎代理对）。 */
export const QQ_PENDING_PREVIEW_CHARS = 80;

/** 一条待审核记录（与 `shared/messages.ts` 的 `QqPendingUserUi` 同形）。 */
export interface QqPendingUser {
  openid: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  preview: string;
  chatType: "private" | "group";
  groupId?: string;
}

/** 服务侧上报的原始事件（预览未截断，由本模块统一收敛）。 */
export interface QqPendingUserInput {
  openid: string;
  chatType: "private" | "group";
  groupId?: string;
  preview: string;
  at: number;
}

/** 存储构造选项（全部可注入，便于测试与上层装配日志）。 */
export interface QqPendingUserStoreOptions {
  /** 注入时钟（毫秒）；缺省 `Date.now`。 */
  now?: () => number;
  /** 过期阈值（毫秒）；缺省 {@link QQ_PENDING_TTL_MS}，`<=0` 关闭时间清退。 */
  ttlMs?: number;
  /** 诊断日志（不写 openid）；缺省落到 `console.warn`。 */
  log?: (line: string) => void;
}

/**
 * 「记录一条待审核消息」的可观测结果。
 *
 * 旧实现的 `addOrUpdate` 只返回列表：队列满时新用户被丢掉、调用方完全看不
 * 出来。现在每个变更都带上丢弃标志与原因，并把清退 / 丢弃计数一并回传，
 * 上层（面板 / 服务）可以据此提示用户，而不是让人永远等不到审核。
 */
export interface QqPendingAddOutcome {
  /** 变更后的全量列表（按 `lastSeenAt` 倒序）。 */
  users: QqPendingUser[];
  /** 本次调用是否因队列已满而丢弃了新用户。 */
  dropped: boolean;
  /** 结果原因：满队丢弃 / 已在拒绝集合 / 缺 openid。 */
  reason?: "queue_full" | "rejected" | "invalid";
  /** 本条消息的 openid（缺 openid 时为空串）。 */
  openid: string;
  /** 本次调用清退的过期记录数。 */
  pruned: number;
  /** 进程内累计清退条数。 */
  prunedTotal: number;
  /** 进程内累计满队丢弃条数。 */
  droppedTotal: number;
}

interface PendingFile {
  version: 1;
  users: QqPendingUser[];
  rejected: string[];
}

const FILE_VERSION = 1;
let tmpSeq = 0;

function tmpSuffix(): string {
  return `${process.pid.toString(36)}-${(tmpSeq++).toString(36)}-${randomBytes(4).toString("hex")}`;
}

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

/**
 * 预览文本归一：折叠空白（换行 / 制表符会破坏列表行布局）后按码点截断。
 *
 * 按码点而不是 `String#slice` 截断：emoji 与部分中文扩展字符是代理对，
 * 按 UTF-16 单元切会留下半个字符（UI 里显示成方块）。
 */
export function truncateQqPreview(
  text: unknown,
  limit: number = QQ_PENDING_PREVIEW_CHARS,
): string {
  const flat = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  if (flat.length === 0) return "";
  const chars = Array.from(flat);
  const bounded = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : QQ_PENDING_PREVIEW_CHARS;
  return chars.length > bounded ? chars.slice(0, bounded).join("") : flat;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读回时的归一：坏项直接丢弃（绝不把半截记录塞进 UI）。 */
function normalizeUser(raw: unknown): QqPendingUser | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const openid = strOr(record.openid, "").trim();
  if (openid.length === 0) return null;
  const chatType = record.chatType === "group" ? "group" : "private";
  const firstSeenAt = numOr(record.firstSeenAt, 0);
  const user: QqPendingUser = {
    openid,
    firstSeenAt,
    lastSeenAt: numOr(record.lastSeenAt, firstSeenAt),
    count: Math.max(1, Math.floor(numOr(record.count, 1))),
    preview: truncateQqPreview(record.preview),
    chatType,
  };
  if (chatType === "group") {
    const groupId = strOr(record.groupId, "").trim();
    if (groupId.length > 0) user.groupId = groupId;
  }
  return user;
}

function normalizeUsers(value: unknown): QqPendingUser[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: QqPendingUser[] = [];
  for (const item of value) {
    const user = normalizeUser(item);
    if (!user || seen.has(user.openid)) continue;
    seen.add(user.openid);
    out.push(user);
  }
  return out;
}

function normalizeRejected(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= QQ_PENDING_MAX_REJECTED) break;
  }
  return out;
}

/**
 * 待审核用户存储。
 *
 * 读一次、之后走内存：面板只有一个实例，磁盘只是重启后的恢复来源。
 * `record` 返回可观测结果（含丢弃原因与计数）；`addOrUpdate` / `approve` /
 * `reject` 仍返回**最新全量列表**，调用方直接拿去推 webview，不必再查一次。
 */
export class QqPendingUserStore {
  /** 落盘文件（测试与调用方都要能定位它）。 */
  readonly filePath: string;

  private users: QqPendingUser[] = [];
  private rejected: string[] = [];
  private loaded: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** 注入时钟（过期判定与时间戳兜底）。 */
  private readonly nowFn: () => number;
  /** 过期阈值；`<=0` 关闭时间清退。 */
  private readonly ttlMs: number;
  private readonly logFn: (line: string) => void;
  /** 进程内累计清退条数（可观测）。 */
  private prunedTotal = 0;
  /** 进程内累计满队丢弃条数（可观测）。 */
  private droppedTotal = 0;

  constructor(rootDir: string, options: QqPendingUserStoreOptions = {}) {
    this.filePath = path.join(rootDir, "pending-users.json");
    this.nowFn = options.now ?? Date.now;
    this.ttlMs =
      typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs)
        ? options.ttlMs
        : QQ_PENDING_TTL_MS;
    this.logFn = options.log ?? ((line) => console.warn(line));
  }

  /** 读取并缓存磁盘内容（幂等；坏文件按空处理，绝不抛崩调用方）。 */
  private load(): Promise<void> {
    if (!this.loaded) this.loaded = this.readFromDisk();
    return this.loaded;
  }

  private async readFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      this.users = [];
      this.rejected = [];
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.users = [];
      this.rejected = [];
      return;
    }
    const source =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    this.users = normalizeUsers(source.users).slice(0, QQ_PENDING_MAX_USERS);
    this.rejected = normalizeRejected(source.rejected);
    // 读回即清退：磁盘上可能留着很久以前的记录。只改内存，下一次写入
    // （add/approve/reject）时自然落盘。
    this.pruneExpired(this.nowFn());
  }

  /** 全量列表（按 `lastSeenAt` 倒序；返回副本，调用方改不坏内部状态）。 */
  async list(): Promise<QqPendingUser[]> {
    await this.load();
    // 读路径也清退（不落盘）：面板可能长时间开着，不能让过期记录继续显示。
    this.pruneExpired(this.nowFn());
    return [...this.users]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((user) => ({ ...user }));
  }

  /**
   * 时间清退：`lastSeenAt` 早于 `now - ttlMs` 的记录自动移除。
   *
   * 返回被清退的 openid（调用方/测试可观测）。`ttlMs <= 0` 时完全关闭。
   * 只看**最后一次出现**：还在活动的人（重复消息会刷新 lastSeenAt）不会
   * 因为排队久而消失；真正长期无人处理、也再没出现的记录才会被清掉。
   */
  private pruneExpired(now: number): string[] {
    if (!(this.ttlMs > 0)) return [];
    const cutoff = now - this.ttlMs;
    const expired = this.users.filter((user) => user.lastSeenAt < cutoff);
    if (expired.length === 0) return [];
    const expiredIds = new Set(expired.map((user) => user.openid));
    this.users = this.users.filter((user) => !expiredIds.has(user.openid));
    this.prunedTotal += expired.length;
    const days = Math.max(1, Math.round(this.ttlMs / (24 * 60 * 60 * 1000)));
    this.logFn(
      `QQ 待审核队列：清退 ${expired.length} 条超过 ${days} 天未再出现的记录（累计 ${this.prunedTotal}）`,
    );
    return expired.map((user) => user.openid);
  }

  /** 该 openid 是否已被拒绝（被拒绝的人不会再次进入待审核）。 */
  async isRejected(openid: string): Promise<boolean> {
    await this.load();
    const id = typeof openid === "string" ? openid.trim() : "";
    return id.length > 0 && this.rejected.includes(id);
  }

  /**
   * 记录一条待审核消息并回传可观测结果：
   * 同一 openid 累加次数、刷新 `lastSeenAt` 与预览。
   *
   * 行为：
   *  - 先做一次时间清退（超过 TTL 未再出现的记录自动移除，计数回传）；
   *  - 已在拒绝集合里的人直接忽略（`reason: "rejected"`）；
   *  - 队列超过上限时按 `firstSeenAt` **升序保留**（最早出现的优先）——
   *    重复消息不会刷新这个时间，所以刷消息无法把别人的记录挤出去；
   *  - 若被丢弃的正是这条新消息（或更晚出现的），结果里 `dropped: true`、
   *    `reason: "queue_full"` 且 `droppedTotal` 递增，调用方据此提示，
   *    **绝不静默丢弃**。
   */
  async record(input: QqPendingUserInput): Promise<QqPendingAddOutcome> {
    await this.load();
    const pruned = this.pruneExpired(this.nowFn()).length;
    const openid = typeof input?.openid === "string" ? input.openid.trim() : "";
    if (openid.length === 0) {
      return {
        users: await this.list(),
        dropped: false,
        reason: "invalid",
        openid: "",
        pruned,
        prunedTotal: this.prunedTotal,
        droppedTotal: this.droppedTotal,
      };
    }
    if (this.rejected.includes(openid)) {
      return {
        users: await this.list(),
        dropped: false,
        reason: "rejected",
        openid,
        pruned,
        prunedTotal: this.prunedTotal,
        droppedTotal: this.droppedTotal,
      };
    }

    const at = numOr(input.at, this.nowFn());
    const preview = truncateQqPreview(input.preview);
    const chatType: "private" | "group" = input.chatType === "group" ? "group" : "private";
    const groupId =
      chatType === "group" && typeof input.groupId === "string" ? input.groupId.trim() : "";

    const existing = this.users.find((user) => user.openid === openid);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = Math.max(existing.lastSeenAt, at);
      existing.firstSeenAt = Math.min(existing.firstSeenAt, at);
      if (preview.length > 0) existing.preview = preview;
      existing.chatType = chatType;
      if (groupId.length > 0) existing.groupId = groupId;
      else delete existing.groupId;
    } else {
      const created: QqPendingUser = {
        openid,
        firstSeenAt: at,
        lastSeenAt: at,
        count: 1,
        preview,
        chatType,
      };
      if (groupId.length > 0) created.groupId = groupId;
      this.users.push(created);
    }

    let dropped = false;
    if (this.users.length > QQ_PENDING_MAX_USERS) {
      // 只按 firstSeenAt 排序（稳定排序保证同时间戳时先入队的在前）：
      // 保留先出现的人，丢掉刚冒出来的那批。lastSeenAt 不参与淘汰。
      this.users.sort((left, right) => left.firstSeenAt - right.firstSeenAt);
      const kept = this.users.slice(0, QQ_PENDING_MAX_USERS);
      const keptIds = new Set(kept.map((user) => user.openid));
      dropped = !keptIds.has(openid);
      this.users = kept;
      if (dropped) {
        this.droppedTotal += 1;
        // 只记条数与原因，不写 openid（与 UI 层脱敏纪律一致）。
        this.logFn(
          `QQ 待审核队列已满（上限 ${QQ_PENDING_MAX_USERS}），丢弃 1 条新待审核记录（累计 ${this.droppedTotal}）`,
        );
      }
    }

    await this.persist();
    return {
      users: await this.list(),
      dropped,
      ...(dropped ? { reason: "queue_full" as const } : {}),
      openid,
      pruned,
      prunedTotal: this.prunedTotal,
      droppedTotal: this.droppedTotal,
    };
  }

  /**
   * 记录一条待审核消息，返回最新全量列表。
   *
   * 兼容既有调用方（面板只需要列表）；需要知道「有没有人被丢弃」的调用方
   * 应改用 {@link record}。
   */
  async addOrUpdate(input: QqPendingUserInput): Promise<QqPendingUser[]> {
    return (await this.record(input)).users;
  }

  /** 放行：移出待审核（同时清掉拒绝标记，避免历史拒绝挡住人工放行）。 */
  async approve(openid: string): Promise<QqPendingUser[]> {
    await this.load();
    const id = typeof openid === "string" ? openid.trim() : "";
    if (id.length === 0) return this.list();
    const before = this.users.length;
    const rejectedBefore = this.rejected.length;
    this.users = this.users.filter((user) => user.openid !== id);
    this.rejected = this.rejected.filter((item) => item !== id);
    if (this.users.length !== before || this.rejected.length !== rejectedBefore) {
      await this.persist();
    }
    return this.list();
  }

  /** 拒绝：移出待审核并记入拒绝集合（最新在前，只保留最近 100 个）。 */
  async reject(openid: string): Promise<QqPendingUser[]> {
    await this.load();
    const id = typeof openid === "string" ? openid.trim() : "";
    if (id.length === 0) return this.list();
    this.users = this.users.filter((user) => user.openid !== id);
    this.rejected = [id, ...this.rejected.filter((item) => item !== id)].slice(
      0,
      QQ_PENDING_MAX_REJECTED,
    );
    await this.persist();
    return this.list();
  }

  /** 原子落盘；写链保证「后写的先落地」不会发生。 */
  private persist(): Promise<void> {
    const payload: PendingFile = {
      version: FILE_VERSION,
      users: this.users,
      rejected: this.rejected,
    };
    const text = JSON.stringify(payload, null, 2);
    const target = this.filePath;
    const run = () => writeJsonAtomic(target, text);
    // `then(run, run)`：上一次写失败也不能卡死后续写入。
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
