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
import { isTerminalSuperStatus } from "../../shared/super-agent.js";
import type { PersistedSuperSession } from "../../shared/super-agent.js";
import type { SuperActivityDetail, SuperToolCallDetail } from "../../shared/super-agent.js";

/**
 * 归档文件格式版本。读到的版本不认识就当没有归档（宁可少显示，不显示坏的）。
 *
 * **v2 的新字段一律可选，所以版本号仍然是 1**：老归档（没有 runId / wave /
 * diagnostics 等字段）必须能原样读回 —— 升版本会把所有老归档变成
 * 「unknown-version」损坏态，用户重启后一屏子会话全没了。版本号只在**形状
 * 本身**不兼容时才动。
 */
const ARCHIVE_VERSION = 1;

interface ArchiveFile {
  version: number;
  sessions: SuperArchiveRecord[];
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
  sessions: SuperArchiveRecord[];
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

/**
 * `lastWritten` 最多保留多少个目标。
 *
 * 它是写放大控制的内存记账，不是归档本身。不设上限的话，每个「写过但从没
 * 走显式删除」的主会话 / 子会话都会永久占住一份完整 payload —— 在长期运行
 * 的扩展宿主里这是无界增长。超出上限淘汰最久没写的目标：热目标（正被进度帧
 * 反复触发的那个）永远留在缓存里，冷目标被淘汰后最多多写一次盘。
 */
const MAX_LAST_WRITTEN = 64;

/**
 * 写入追踪映射的当前规模（仅供测试断言回收，生产代码不调用）。
 *
 * `pendingWrites` 在写链收尾后必须归零、`lastWritten` 必须始终有界，这两条
 * 不变量无法从模块外部观察，因此显式暴露计数，避免测试去戳模块私有状态。
 */
export function superStoreWriteTrackingSizes(): { pending: number; lastWritten: number } {
  return { pending: pendingWrites.size, lastWritten: lastWritten.size };
}

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
    sessions: file.sessions
      .filter((s): s is SuperArchiveRecord => !!s && typeof s.id === "string")
      // 读侧也裁一次：归档可能来自更高版本，或被手工改过 —— 进内存的记录
      // 必须始终满足「诊断 ≤200 条、单条文本 ≤500 字」这条不变量。
      .map((s) => sanitizeSuperArchiveRecord(s)),
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
  sessions: readonly SuperArchiveRecord[],
): Promise<void> {
  const target = archivePath(baseDir, sessionId);
  // 落盘前裁剪（v2）：诊断事件流是高频 + 可能很长的东西，不能让它把归档撑大。
  // 裁剪只动 v2 的新字段，v1 字段逐字保留 —— 归档是「那次运行发生过什么」的
  // 记录，不是缓存。
  const payload = JSON.stringify({
    version: ARCHIVE_VERSION,
    sessions: sessions.map((s) => sanitizeSuperArchiveRecord(s)),
  } satisfies ArchiveFile);
  // 内容没变就不写 —— 但要先确认文件还在：文件可能已被会话删除 / 孤儿清扫
  // 删掉，这时「跳过」会让归档再也回不来。
  if (lastWritten.get(target) === payload && existsSync(target)) return;
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const next = previous.then(() => writeArchiveFile(target, payload));
  // 存进链里的是「吞掉错误」的版本：一次写失败不能让后续的写全部卡死。
  const settled = next.then(() => undefined, () => undefined);
  pendingWrites.set(target, settled);
  try {
    await next;
    // 只有真的写成功才记账 —— 写失败不能被当成「已经落盘」。
    noteLastWritten(target, payload);
  } finally {
    releaseWriteTarget(target, settled);
  }
}

/**
 * 写链收尾后回收 `pendingWrites` 条目。
 *
 * 只能回收「当前链尾仍是我们自己」的那一条：并发写会把它换成后一次写的
 * 链尾，无条件 delete 会让更晚的写绕过排队，破坏按 target 串行的语义。
 */
function releaseWriteTarget(target: string, settled: Promise<void>): void {
  if (pendingWrites.get(target) === settled) pendingWrites.delete(target);
}

/** 记账一次成功写入，并把 `lastWritten` 限制在 {@link MAX_LAST_WRITTEN} 条内。 */
function noteLastWritten(target: string, payload: string): void {
  // 命中时先删后插，让 Map 的迭代顺序反映「最近写入」，淘汰时丢掉最老的。
  if (lastWritten.has(target)) lastWritten.delete(target);
  lastWritten.set(target, payload);
  while (lastWritten.size > MAX_LAST_WRITTEN) {
    const oldest = lastWritten.keys().next().value;
    if (oldest === undefined) break;
    lastWritten.delete(oldest);
  }
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

// ---------------------------------------------------------------------------
// 归档持久化 v2：波次 / 依赖 / 尝试 / 失败分类 / 诊断事件流 / 恢复分类
// ---------------------------------------------------------------------------
//
// **为什么要有 v2**：v1 归档只记「这个子会话存在过、在哪个分支上、结束状态是
// 什么」。一旦引入多波次调度 + 依赖 + 重试，就缺三样东西：
//
//  1. **它在第几波、依赖谁** —— 恢复后要能重建「谁挡着谁」的关系，否则用户
//     只看到一排孤立的卡片，不知道该先处理哪个；
//  2. **它是第几次尝试、上次为什么挂** —— 没有失败分类，重试只能盲试；
//  3. **磁盘上还剩什么** —— 归档写「已完成」但 worktree 已被清理时，用户
//     无从判断这份改动还在不在（见 {@link classifySuperRecovery}）。
//
// **持久化记录类型定义在哪**：`PersistedSuperSession` 仍定义在
// `shared/super-agent.ts`（本文件只 import，**不改 shared**）。v2 的新字段在
// 这里由 {@link SuperArchiveRecord}（= v1 记录 + 一组**可选**新字段）承载；
// shared 层一旦导出等价的 `SuperFailureInfo` / `SuperDiagnosticEvent`，两者
// 结构兼容，可直接换用（换用清单见任务报告的「接线说明」）。
//
// **老归档零迁移**：新字段全部可选，版本号不动 —— 老记录照常读回，指纹对缺失
// 字段按默认值处理，绝不报错。

/**
 * 失败分类（v2）。
 *
 * v1 只有一句 `error?: string`（人类可读文本），机器分不出「重试有意义」与
 * 「重试也是白试」—— 重试策略只能靠人读文本猜。v2 把失败拆成结构化分类：
 *
 *  - `retryable`：环境类失败（超时、限流、临时不可用）→ 重试有意义；
 *  - `terminal`：任务本身失败（需求不成立、断言不通过）→ 重试只会再失败一次；
 *  - `blocked`：需要人先做点什么（等凭据、等上游产物）→ 重试前要先解阻塞；
 *  - `interrupted`：被中断（用户停的 / 面板关了）→ 通常可原地重试。
 */
export type SuperArchiveFailureKind = "retryable" | "terminal" | "blocked" | "interrupted";

/** 一次失败的分类化描述（落盘用）。 */
export interface SuperArchiveFailureInfo {
  /** 失败分类。 */
  kind: SuperArchiveFailureKind;
  /** 人类可读的失败说明。 */
  message: string;
  /** 发生时刻（epoch ms）。 */
  at: number;
}

/** 诊断事件的类别（v2）。 */
export type SuperArchiveDiagnosticKind =
  /** 子会话进程拉起。 */
  | "spawn"
  /** ACP 会话建立 / 恢复。 */
  | "session"
  /** 汇报流转。 */
  | "report"
  /** 合并 / 集成。 */
  | "merge"
  /** 重试。 */
  | "retry"
  /** 一般错误。 */
  | "error"
  /** 超时。 */
  | "timeout"
  /** 归档恢复。 */
  | "restore"
  /** 被阻塞。 */
  | "blocked"
  /** 最近一次可见活动（工具结果 / 状态推进）。 */
  | "activity"
  /** 一次工具调用。 */
  | "tool_call";

/** 诊断事件的严重级别（v2）。 */
export type SuperArchiveDiagnosticLevel = "info" | "warn" | "error";

/**
 * 一条诊断事件（v2）。
 *
 * 定位是「排查用的事件流」，不是面向用户的文案：它回答「这个子会话在重启
 * 之前到底经历了什么」，让恢复后的看板与汇报能说清失败链路。
 */
export interface SuperArchiveDiagnosticEvent {
  /** 发生时刻（epoch ms）。 */
  at: number;
  /** 事件类别。 */
  kind: SuperArchiveDiagnosticKind;
  /** 严重级别。 */
  level: SuperArchiveDiagnosticLevel;
  /** 一句话说明。 */
  message: string;
  /** 可选细节（堆栈片段、原始错误文本等）。 */
  detail?: string;
  /** `kind === "activity"` 的结构化细节（类型与 shared 同源）。 */
  activityDetail?: SuperActivityDetail;
  /** `kind === "tool_call"` 的结构化细节（类型与 shared 同源）。 */
  toolCallDetail?: SuperToolCallDetail;
}

/**
 * v2 归档记录 = v1 记录 + 一组**可选**新字段。
 *
 * 全部可选是硬要求：老归档（v1 写出的记录）必须能原样读回，不需要迁移脚本。
 */
export interface SuperArchiveRecord extends PersistedSuperSession {
  /** 运行组标识（一次委派块 = 一个运行组）。 */
  runId?: string;
  /** 所属波次序号（0 基）。 */
  wave?: number;
  /** 声明的批次号（1 基）。 */
  batch?: number;
  /** 依赖的任务标识（依赖谁先做完）。 */
  dependsOn?: string[];
  /** 已尝试次数（继承自 v1，这里只是显式声明契约）。 */
  attempts?: number;
  /** 最大尝试次数上限（超过即不再自动重试）。 */
  maxAttempts?: number;
  /** 最近一次失败的分类化描述。 */
  lastError?: SuperArchiveFailureInfo;
  /** 诊断事件流（落盘前裁剪，见 {@link MAX_SUPER_ARCHIVE_DIAGNOSTICS}）。 */
  diagnostics?: SuperArchiveDiagnosticEvent[];
  /** 面向人的状态说明（如「上游任务失败，已跳过」）。 */
  statusDetail?: string;
}

/**
 * 诊断事件最多保留多少条（落盘裁剪，保留**最近**的这些条）。
 *
 * **与 shared 层常量保持一致** —— shared 层落地 `MAX_SUPER_DIAGNOSTICS` 后
 * 统一到同一处；在此之前由本文件独立兜底（宁可这里多裁一点，也不能让归档
 * 无限膨胀）。
 */
export const MAX_SUPER_ARCHIVE_DIAGNOSTICS = 200;

/**
 * 单条诊断的 `message` / `detail` 长度上限（字符）。
 *
 * 诊断里常会塞进原始错误文本 / 堆栈片段，不设上限的话**一条**诊断就能把整
 * 份归档撑到几十 MB。
 */
export const MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT = 500;

/** 截断文本到上限长度（末尾补一个省略号，总长不超过 max）。 */
function truncateArchiveText(text: string, max: number): string {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 把一条归档记录裁剪到「可安全落盘」的形状（纯函数，不改入参）。
 *
 * 只动 v2 的新字段：
 *  - `diagnostics`：只保留最近 {@link MAX_SUPER_ARCHIVE_DIAGNOSTICS} 条，单条
 *    `message` / `detail` 截到 {@link MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT} 字；
 *  - `lastError.message`：同样截断；
 *  - `dependsOn`：只保留字符串项。
 *
 * v1 字段逐字保留 —— 归档是「那次运行发生过什么」的记录，不是缓存。
 */
export function sanitizeSuperArchiveRecord(record: SuperArchiveRecord): SuperArchiveRecord {
  const next: SuperArchiveRecord = { ...record };
  if (record.dependsOn !== undefined) {
    next.dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.filter((dep): dep is string => typeof dep === "string")
      : [];
  }
  if (record.lastError !== undefined && record.lastError && typeof record.lastError === "object") {
    next.lastError = {
      kind: record.lastError.kind,
      message: truncateArchiveText(record.lastError.message, MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT),
      at: typeof record.lastError.at === "number" ? record.lastError.at : 0,
    };
  }
  if (record.diagnostics !== undefined) {
    next.diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics
          .filter((d): d is SuperArchiveDiagnosticEvent => !!d && typeof d === "object")
          .slice(-MAX_SUPER_ARCHIVE_DIAGNOSTICS)
          .map((d) => ({
            at: typeof d.at === "number" ? d.at : 0,
            kind: d.kind,
            level: d.level,
            message: truncateArchiveText(d.message, MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT),
            ...(typeof d.detail === "string"
              ? { detail: truncateArchiveText(d.detail, MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT) }
              : {}),
            ...(d.activityDetail && typeof d.activityDetail === "object"
              ? {
                  activityDetail: {
                    source:
                      d.activityDetail.source === "assistant" ||
                      d.activityDetail.source === "tool_result" ||
                      d.activityDetail.source === "status"
                        ? d.activityDetail.source
                        : "status",
                    excerpt: truncateArchiveText(
                      String(d.activityDetail.excerpt ?? ""),
                      MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
                    ),
                    at: typeof d.activityDetail.at === "number" ? d.activityDetail.at : 0,
                  },
                }
              : {}),
            ...(d.toolCallDetail && typeof d.toolCallDetail === "object"
              ? {
                  toolCallDetail: {
                    name: truncateArchiveText(
                      String(d.toolCallDetail.name ?? ""),
                      MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
                    ),
                    ...(typeof d.toolCallDetail.toolCallId === "string"
                      ? {
                          toolCallId: truncateArchiveText(
                            d.toolCallDetail.toolCallId,
                            MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
                          ),
                        }
                      : {}),
                    state:
                      d.toolCallDetail.state === "pending" ||
                      d.toolCallDetail.state === "in_progress" ||
                      d.toolCallDetail.state === "completed" ||
                      d.toolCallDetail.state === "failed"
                        ? d.toolCallDetail.state
                        : "pending",
                    ...(typeof d.toolCallDetail.excerpt === "string"
                      ? {
                          excerpt: truncateArchiveText(
                            d.toolCallDetail.excerpt,
                            MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          }))
      : [];
  }
  return next;
}

/**
 * 单条记录的「关键内容」指纹（v2 规则）。
 *
 * **参与指纹**（变了就必须更新归档）：状态、集成结果、归属、尝试次数、运行
 * 组、波次、批次、依赖、失败说明（`error` 与结构化 `lastError`）、状态说明。
 *
 * **刻意不参与**：诊断事件流（高频，进指纹会把节流写盘打爆）、汇报历史、
 * 摘要、更新时间戳（每帧都在变，进了等于节流失效）。
 *
 * 算法是**稳定**的：同样的内容永远算出同样的字符串，不掺时间戳 / 随机值。
 * 依赖集合按字典序排序后再拼 —— 依赖是集合语义，顺序不同不该算变化。
 */
export function superArchiveRecordFingerprint(record: SuperArchiveRecord): string {
  return [
    record.id,
    record.status,
    record.mainSessionId ?? "",
    record.isolation.kind,
    record.isolation.branch ?? "",
    record.integration?.state ?? "",
    record.integration?.needsAction ? "1" : "0",
    record.attempts ?? "",
    record.maxAttempts ?? "",
    record.runId ?? "",
    record.wave ?? "",
    record.batch ?? "",
    [...(record.dependsOn ?? [])].sort().join(","),
    record.error ?? "",
    record.lastError
      ? `${record.lastError.kind}@${record.lastError.at}:${record.lastError.message}`
      : "",
    record.statusDetail ?? "",
    record.endedAt ?? "",
  ].join("|");
}

/**
 * 一批归档的「关键内容」指纹（v2 规则）。
 *
 * 与 shared 层的 `superArchiveFingerprint` 同一职责（判定「有没有必须立刻
 * 落盘的变化」），但**多算**了波次 / 尝试上限 / 失败分类 / 状态说明这些 v2
 * 字段。shared 层的版本仍在用（宿主 `super-agent-host.ts`），等 shared 层把
 * 同样规则并进去之后，两边应当合并为一份 —— 在此之前宿主要用新规则就调这里。
 */
export function superArchiveStoreFingerprint(
  archives: readonly { mainSessionId: string; sessions: readonly SuperArchiveRecord[] }[],
): string {
  const parts: string[] = [];
  for (const archive of archives) {
    parts.push(`owner:${archive.mainSessionId}`);
    for (const session of archive.sessions) {
      parts.push(superArchiveRecordFingerprint(session));
    }
  }
  return parts.join("\n");
}

/** 恢复分类：这份记录还剩多少「可恢复的东西」。 */
export type SuperRecoveryState =
  /** 没有可恢复的内容（已终态且磁盘上也没留下工作目录 / 分支）。 */
  | "none"
  /** 工作目录与分支都在 → 可以原地重试（半成品保留）。 */
  | "recoverable"
  /** 缺了工作目录或分支 → 只剩记录，重试要重建。 */
  | "lost";

/** 磁盘事实（由宿主探测后传入 —— 本函数不碰磁盘）。 */
export interface SuperRecoveryFacts {
  /** 归档里的工作目录此刻是否还在磁盘上。 */
  worktreeExists: boolean;
  /** 归档里的 git 分支此刻是否还存在。 */
  branchExists: boolean;
}

/** 恢复分类的结果。 */
export interface SuperRecoveryClassification {
  /** 分类。 */
  state: SuperRecoveryState;
  /** 人类可读的原因（面向用户 / 汇报文案）。 */
  reason?: string;
}

/**
 * 判断一份归档记录**还能恢复多少**（纯函数，不碰磁盘）。
 *
 * 判定表：
 *
 * | 工作目录 | 分支 | 记录状态 | 分类 | 含义 |
 * | --- | --- | --- | --- | --- |
 * | 在 | 在 | 任意 | `recoverable` | 实物齐全，可原地重试 / 合并 |
 * | 无 | 无 | 终态 | `none` | 已结束且什么都没留下，没有可恢复的内容 |
 * | 无 | 无 | 非终态 | `lost` | 实物没了，只剩记录，重试要重建 |
 * | 无 | 在 | 任意 | `lost` | 工作目录已不存在，仅保留分支 |
 * | 在 | 无 | 任意 | `lost` | 分支已不存在，仅保留记录 |
 *
 * **不改变现有恢复语义**：非终态记录恢复时仍一律归一为「已中断」（归一化在
 * shared 层的 `fromPersistedSuperSession` 里，**本任务不动它**）；本函数只
 * 负责回答「归一之后，这份记录还剩多少可恢复的东西」，供宿主把结论挂到
 * 看板 / 汇报上。
 *
 * **`repo` 档注意**：合并子会话走 `isolation.kind === "repo"`（没有自己的
 * worktree，也没有自己的分支），宿主应当把「主仓存在 / 当前分支存在」映射成
 * 这两个事实再传入。
 */
export function classifySuperRecovery(
  record: SuperArchiveRecord,
  facts: SuperRecoveryFacts,
): SuperRecoveryClassification {
  const terminal = isTerminalSuperStatus(record.status);
  if (facts.worktreeExists && facts.branchExists) {
    return { state: "recoverable", reason: "工作目录与分支均仍在，可原地恢复" };
  }
  if (!facts.worktreeExists && !facts.branchExists) {
    if (terminal) {
      return { state: "none", reason: "已终态且工作目录与分支均已不存在，没有可恢复的内容" };
    }
    return { state: "lost", reason: "工作目录与分支均已不存在，仅保留记录" };
  }
  if (!facts.worktreeExists) {
    return { state: "lost", reason: "工作目录已不存在，仅保留分支" };
  }
  return { state: "lost", reason: "分支已不存在，仅保留记录" };
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
  const settled = next.then(() => undefined, () => undefined);
  pendingWrites.set(target, settled);
  try {
    await next;
    // 只有真的写成功才记账。
    noteLastWritten(target, payload);
  } finally {
    releaseWriteTarget(target, settled);
  }
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
