/**
 * Super Agent 子会话归档（Extension Host only；零 vscode 依赖，便于单测）。
 *
 * **为什么需要它**：子会话的进程（各自一个 CLI）随扩展宿主一起退出 —— 扩展
 * 重启后它们全部消失，只剩「worktree 与分支还在磁盘上」这一件事实。此前
 * 这条记录只活在内存里（`SuperAgentManager.sessions`），所以：
 *
 *  1. 重启恢复历史会话时，看板上一个子会话都没有，用户完全不知道自己
 *     曾经派发过什么、哪些分支还没合并；
 *  2. `dispose()` 刻意保留的 worktree 变成了无人认领的孤儿目录 —— 分支里的
 *     改动还在，但没有任何界面能指向它。
 *
 * 归档按**主会话**分文件：一个主会话一个 JSON，写在扩展自己的存储目录
 * （不是仓库里 —— 归档是本机状态，不该污染用户的 git 工作区）。
 *
 * 写入用「唯一临时文件 + rename」的原子替换：进程在写到一半被杀时，磁盘上
 * 要么是旧内容，要么是新内容，不会留下半截 JSON（与转录文件的写法一致）。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block } from "../../shared/messages.js";
import type { PersistedSuperSession } from "../../shared/super-agent.js";

/** 归档文件格式版本。读到的版本不认识就当没有归档（宁可少显示，不显示坏的）。 */
const ARCHIVE_VERSION = 1;

interface ArchiveFile {
  version: number;
  sessions: PersistedSuperSession[];
}

/**
 * 归档读不出来的原因。
 *
 * 「读不出来」与「本来就没有子会话」是两件完全不同的事：后者是正常的空
 * 归档，前者是**故障**。旧实现把两者都返回成空数组，于是损坏的归档会被
 * 静默当成「这个会话从没派发过子会话」—— 用户重启后面板空空，且完全看不出
 * 发生过什么。现在读侧如实区分，并把损坏的原件留底。
 */
export type SuperArchiveDamage =
  /** JSON 解析失败（写到一半被 kill / 并发写交错）。 */
  | "corrupt-json"
  /** 结构不对（不是归档文件的形状）。 */
  | "bad-shape"
  /** 版本号不认识（多半来自更高版本的扩展）。 */
  | "unknown-version";

/** 一次归档读取的结果。 */
export interface SuperSessionArchiveRead {
  /** 能读出来的子会话记录（损坏时为空 —— 但 `damaged` 为 true）。 */
  sessions: PersistedSuperSession[];
  /** 归档是否**读不出来**（false = 真的没有子会话）。 */
  damaged: boolean;
  /** 读不出来的原因（damaged 为 true 时有值）。 */
  damage?: SuperArchiveDamage;
  /** 损坏原件的备份路径（原件仍在原处，备份是它的一份副本）。 */
  backupPath?: string;
}

/** 归档目录（扩展存储下的 `super-sessions`）。 */
export function superSessionsDir(baseDir: string): string {
  return path.join(baseDir, "super-sessions");
}

/**
 * 归档文件名。
 *
 * 会话 id 来自 CLI 与 webview 消息 —— 限制成文件系统安全的字符集，恶意 id
 * 不能借此逃出目录（与转录文件的 `ownTranscriptFileName` 同一纪律）。
 *
 * **单射性**：旧实现把所有非 `[A-Za-z0-9_-]` 字符折叠成 `-`，`a.b`、`a-b`、
 * `a/b` 会撞到同一个 `a-b.json`（远程 / QQ 来源的 id 含特殊字符时尤其容易），
 * 跨会话覆盖或误删。现在：
 *  - 本身就落在安全字符集里的 id：**保持原文件名**（映射本来就是单射，且旧
 *    归档照常可读，零迁移成本）；
 *  - 需要折叠的 id：追加 id 的短 hash 后缀，保证映射是单射。
 */
export function superSessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (safe === sessionId) return `${safe}.json`;
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `${safe}-${hash}.json`;
}

/**
 * 旧版本（无 hash）的归档文件名，仅供读取兼容 —— 不用于写入 / 删除，避免
 * 误删「恰好与某个折叠名同形」的另一个安全 id 的归档。
 */
function legacySuperSessionFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}.json`;
}

function archivePath(baseDir: string, sessionId: string): string {
  return path.join(superSessionsDir(baseDir), superSessionFileName(sessionId));
}

/**
 * 每个归档文件的**串行写链**。
 *
 * 同一个主会话的多次写必须排队：并发写同一个目标文件时，即使每次都用
 * 「临时文件 + rename」，两次 rename 之间的顺序也不受保证 —— 后写的可能
 * 先落地，写出的内容就是**上一次**的（丢更新）；而共享固定临时文件名时更
 * 糟：两次写共用一个临时文件，A 写一半 B 覆写，A 再 rename → 落盘的是
 * 交错出来的半截 JSON。
 *
 * 按目标路径排队是最小的粒度：不同主会话的归档互不相干，可以并行写。
 */
const pendingWrites = new Map<string, Promise<void>>();

/**
 * 每个归档文件**最后一次成功写入**的内容。
 *
 * 归档的写放大主要来自高频事件：看板每变一次（进度帧每秒几次）就整份重写
 * 一次，而进度字段根本不在归档里。逐字比对内容，没变就不写 —— 省掉的是
 * 纯粹的磁盘 IO，不影响任何语义。
 */
const lastWritten = new Map<string, string>();

/** 临时文件名的进程内序号（与 pid 一起保证唯一）。 */
let tmpSeq = 0;

/**
 * 读一个主会话的子会话归档。
 *
 * 文件不存在（从未派发过子会话）返回「没有子会话」—— 这不是故障。
 *
 * 文件读不出来（JSON 损坏 / 结构不对 / 版本不认识）时**如实返回损坏状态**：
 * 会话列表为空，但 `damaged` 为 true，调用方必须把它当故障提示用户，绝不能
 * 伪装成「这个会话没有子会话」。损坏的原件会被复制一份 `.corrupt` 留底
 * （**固定单份**，覆盖上一次的备份，不再每次读取新增一份带时间戳的副本；
 * 原文件保持在原处，这样下一次读取仍然能报出「损坏」）。
 *
 * 新文件名不存在时会回退读一次旧文件名：远程 / QQ 来源的 id 含特殊字符时，
 * 旧版本写出的文件没有 hash 后缀，升级后不能凭空消失。
 */
export async function readSuperSessionArchive(
  baseDir: string,
  sessionId: string,
): Promise<SuperSessionArchiveRead> {
  const target = archivePath(baseDir, sessionId);
  let actualTarget = target;
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    // ENOENT：先试旧文件名（只对确实被折叠过的 id 有意义）。
    const legacy = path.join(superSessionsDir(baseDir), legacySuperSessionFileName(sessionId));
    if (legacy === target) return { sessions: [], damaged: false };
    try {
      raw = await readFile(legacy, "utf8");
      actualTarget = legacy;
    } catch {
      return { sessions: [], damaged: false }; // 真的还没归档过
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return await damaged(actualTarget, "corrupt-json");
  }
  const file = parsed as Partial<ArchiveFile> | null;
  if (!file || typeof file !== "object") {
    return await damaged(actualTarget, "bad-shape");
  }
  if (file.version !== ARCHIVE_VERSION) {
    // 版本不认识多半来自更高版本的扩展：文件本身没坏，别把它当损坏留底，
    // 但仍然要如实告诉上层「这份归档没读出来」。
    return { sessions: [], damaged: true, damage: "unknown-version" };
  }
  if (!Array.isArray(file.sessions)) {
    return await damaged(actualTarget, "bad-shape");
  }
  return {
    sessions: file.sessions.filter((s): s is PersistedSuperSession => !!s && typeof s.id === "string"),
    damaged: false,
  };
}

/** 读不出来时的统一返回：留底损坏原件 + 如实标记损坏（备份固定单份）。 */
async function damaged(target: string, damage: SuperArchiveDamage): Promise<SuperSessionArchiveRead> {
  const backupPath = `${target}.corrupt`;
  try {
    await copyFile(target, backupPath);
  } catch {
    // 留底失败不掩盖损坏本身 —— 如实报告损坏，备份路径就不给。
    return { sessions: [], damaged: true, damage };
  }
  return { sessions: [], damaged: true, damage, backupPath };
}

/**
 * 原子写一个主会话的子会话归档。
 *
 * 三道保障：
 *  1. 临时文件名**唯一**（pid + 序号）：并发写不会互相踩临时文件；
 *  2. 同一个目标的写**串行**排队（见 `pendingWrites`）；
 *  3. 内容与上次成功写入**逐字相同**时直接跳过（见 `lastWritten`）。
 *
 * 写完之后 rename 覆盖目标文件 —— 读者要么看到旧内容，要么看到新内容。
 */
export async function writeSuperSessionArchive(
  baseDir: string,
  sessionId: string,
  sessions: PersistedSuperSession[],
): Promise<void> {
  const target = archivePath(baseDir, sessionId);
  const payload = JSON.stringify({ version: ARCHIVE_VERSION, sessions } satisfies ArchiveFile);
  // 内容没变就不写 —— 但要先确认文件还在：文件可能已被会话删除 / 孤儿清扫
  // 删掉，这时「跳过」会让归档再也回不来。
  if (lastWritten.get(target) === payload && existsSync(target)) return;
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const next = previous.then(() => writeArchiveFile(target, payload));
  // 存进链里的是「吞掉错误」的版本：一次写失败不能让后续的写全部卡死。
  pendingWrites.set(target, next.then(() => undefined, () => undefined));
  await next;
  // 只有真的写成功才记账 —— 写失败不能被当成「已经落盘」。
  lastWritten.set(target, payload);
}

/** 一次原子写：唯一临时文件 → rename 覆盖。 */
async function writeArchiveFile(target: string, payload: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid.toString(36)}-${(tmpSeq++).toString(36)}.tmp`;
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 删除一个主会话的子会话归档（会话被删除时用）。 */
export async function deleteSuperSessionArchive(baseDir: string, sessionId: string): Promise<void> {
  const target = archivePath(baseDir, sessionId);
  await rm(target, { force: true });
  lastWritten.delete(target);
}

/**
 * 等这个归档**已经排队的写**全部落定（会话删除前的收尾）。
 *
 * `writeSuperSessionArchive` 的写链是串行的：删除会话时如果直接 `rm`，
 * 一个早已排队的写会在 rm 之后才 rename —— 文件被「复活」，而那个会话已经
 * 不存在了。先等链尾（吞掉错误，与写入侧一致），再删才确定。
 *
 * 转录快照走同一套写链，所以删除会话时也要把它的子会话转录写一并收尾
 * （`transcriptChildIds`），否则终态写会在转录被删之后 rename 复活它。
 */
export async function awaitSuperSessionArchiveWrite(
  baseDir: string,
  sessionId: string,
  /** 该会话下要一并收尾转录写的子会话 id（删除会话时传入）。 */
  transcriptChildIds: string[] = [],
): Promise<void> {
  const targets = [
    archivePath(baseDir, sessionId),
    ...transcriptChildIds.map((id) => transcriptPath(baseDir, id)),
  ];
  await Promise.all(
    targets.map(async (target) => {
      const pending = pendingWrites.get(target);
      if (pending) await pending.catch(() => undefined);
    }),
  );
}

/** 归档目录里的文件名列表（清理孤儿归档用）。 */
export async function listSuperSessionArchiveFiles(baseDir: string): Promise<string[]> {
  try {
    return await readdir(superSessionsDir(baseDir));
  } catch {
    return []; // 目录还没建
  }
}

// --- 子会话转录快照（旁路展示数据，与归档记录生命周期不同） ----------------
//
// 为什么**不**把转录嵌进 `<mainSessionId>.json` 归档：
//  - 归档是整份重写 + 800ms 节流，转录大且高频（流式块），塞进去会把每次
//    归档写都变成一次大 payload 重写；
//  - 生命周期不同：归档记的是「重启后仍成立的事实」，转录只是详情面板的
//    展示缓存，会话被删 / 清理时两者可以各自独立回收；
//  - 因此它是独立旁路文件，不参与 ARCHIVE_VERSION，归档「只存记录」的纪律
//    不被破坏。
//
// **落盘口径**：写的是宿主侧 `evictBlockPayloads` 已经裁剪过的块窗口（200 块
// / 4M 字符 / minKeep 20），不是为磁盘保真再造一套全量历史。超长子会话的旧
// 载荷不可恢复 —— 详情面板上这些块带 `evicted` 标记，如实呈现为「已裁剪历史
// 转录」，绝不假装它们还在。

/** 转录快照目录名（`super-sessions/transcripts/`）。 */
const TRANSCRIPTS_SUBDIR = "transcripts";

/** 转录快照文件名（按 childId，单射映射与归档同一纪律）。 */
export function superTranscriptFileName(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9_-]/g, "-");
  if (safe === childId) return `${safe}-transcript.json`;
  const hash = createHash("sha256").update(childId).digest("hex").slice(0, 8);
  return `${safe}-${hash}-transcript.json`;
}

function transcriptPath(baseDir: string, childId: string): string {
  return path.join(superSessionsDir(baseDir), TRANSCRIPTS_SUBDIR, superTranscriptFileName(childId));
}

/** 转录快照文件的最小合法形状。 */
interface TranscriptSnapshotFile {
  blocks: Block[];
}

/**
 * 原子写一个子会话的终态转录快照。
 *
 * 复用归档的三道保障：唯一临时文件名、按目标路径串行的写链、内容逐字相同
 * 就跳过（见 `pendingWrites` / `lastWritten`）。只在终态写一次，不做运行中
 * 节流写 —— 那会把高频流式块变成持续磁盘 IO，超出本功能范围。
 */
export async function writeSuperTranscriptSnapshot(
  baseDir: string,
  childId: string,
  blocks: Block[],
): Promise<void> {
  const target = transcriptPath(baseDir, childId);
  const payload = JSON.stringify({ blocks } satisfies TranscriptSnapshotFile);
  // 内容没变就不写 —— 但要先确认文件还在（可能已被删除 / GC）。
  if (lastWritten.get(target) === payload && existsSync(target)) return;
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const next = previous.then(() => writeArchiveFile(target, payload));
  // 链里存吞掉错误的版本：一次写失败不能卡死后续写。
  pendingWrites.set(target, next.then(() => undefined, () => undefined));
  await next;
  // 只有真的写成功才记账。
  lastWritten.set(target, payload);
}

/**
 * 读一个子会话的终态转录快照。
 *
 * **绝不抛**：转录是旁路展示数据，读不出来（不存在 / JSON 损坏 / 形状不对 /
 * 权限问题）就是「没有可恢复的转录」，看板照常恢复。损坏的快照不备份、不
 * 提示 —— 与归档不同，它不是必须如实告知用户的关键事实。
 */
export async function readSuperTranscriptSnapshot(baseDir: string, childId: string): Promise<Block[]> {
  try {
    const raw = await readFile(transcriptPath(baseDir, childId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as TranscriptSnapshotFile).blocks)) {
      return [];
    }
    return (parsed as TranscriptSnapshotFile).blocks;
  } catch {
    return [];
  }
}

/**
 * 删除一个子会话的转录快照。
 *
 * 先等这个目标已排队的写落定再 `rm` —— 否则一个终态写会在删除之后 rename，
 * 把刚删掉的转录「复活」（与归档删除同一纪律）。
 */
export async function deleteSuperTranscriptSnapshot(baseDir: string, childId: string): Promise<void> {
  const target = transcriptPath(baseDir, childId);
  const pending = pendingWrites.get(target);
  if (pending) await pending.catch(() => undefined);
  await rm(target, { force: true });
  lastWritten.delete(target);
}

/** 转录快照目录里的文件名列表（清理孤儿快照用）。 */
export async function listSuperTranscriptFiles(baseDir: string): Promise<string[]> {
  try {
    return await readdir(path.join(superSessionsDir(baseDir), TRANSCRIPTS_SUBDIR));
  } catch {
    return []; // 目录还没建
  }
}
