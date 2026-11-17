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
 * 层做。本模块不打印任何东西、不 import vscode。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 待审核队列上限：超出时按 `firstSeenAt` **保留最早出现的**记录、丢掉最新
 * 出现的——排队越久越可能是真正需要处理的人。淘汰只看首次出现时间，同一
 * 发送者的重复消息（只刷新 `lastSeenAt` / count）不会改变优先级，因此刷消息
 * 挤不掉别人的记录。
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
 * 读一次、之后走内存：面板只有一个实例，磁盘只是重启后的恢复来源。所有变更
 * 方法都返回**最新全量列表**，调用方直接拿去推 webview，不必再查一次。
 */
export class QqPendingUserStore {
  /** 落盘文件（测试与调用方都要能定位它）。 */
  readonly filePath: string;

  private users: QqPendingUser[] = [];
  private rejected: string[] = [];
  private loaded: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, "pending-users.json");
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
  }

  /** 全量列表（按 `lastSeenAt` 倒序；返回副本，调用方改不坏内部状态）。 */
  async list(): Promise<QqPendingUser[]> {
    await this.load();
    return [...this.users]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((user) => ({ ...user }));
  }

  /** 该 openid 是否已被拒绝（被拒绝的人不会再次进入待审核）。 */
  async isRejected(openid: string): Promise<boolean> {
    await this.load();
    const id = typeof openid === "string" ? openid.trim() : "";
    return id.length > 0 && this.rejected.includes(id);
  }

  /**
   * 记录一条待审核消息：同一 openid 累加次数、刷新 `lastSeenAt` 与预览。
   *
   * 已在拒绝集合里的人直接忽略（返回当前列表）。队列超过上限时按
   * `firstSeenAt` **升序保留**（最早出现的优先）——重复消息不会刷新这个时间，
   * 所以刷消息无法把别人的记录挤出去；被丢弃的是最新出现的那批。
   */
  async addOrUpdate(input: QqPendingUserInput): Promise<QqPendingUser[]> {
    await this.load();
    const openid = typeof input?.openid === "string" ? input.openid.trim() : "";
    if (openid.length === 0) return this.list();
    if (this.rejected.includes(openid)) return this.list();

    const at = numOr(input.at, Date.now());
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

    if (this.users.length > QQ_PENDING_MAX_USERS) {
      // 只按 firstSeenAt 排序（稳定排序保证同时间戳时先入队的在前）：
      // 保留先出现的人，丢掉刚冒出来的那批。lastSeenAt 不参与淘汰。
      this.users.sort((left, right) => left.firstSeenAt - right.firstSeenAt);
      this.users = this.users.slice(0, QQ_PENDING_MAX_USERS);
    }

    await this.persist();
    return this.list();
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
