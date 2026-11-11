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
 * 写入用「临时文件 + rename」的原子替换：进程在写到一半被杀时，磁盘上要么是
 * 旧内容，要么是新内容，不会留下半截 JSON（与转录文件的写法一致）。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSuperSession } from "../../shared/super-agent.js";

/** 归档文件格式版本。读到的版本不认识就当没有归档（宁可少显示，不显示坏的）。 */
const ARCHIVE_VERSION = 1;

interface ArchiveFile {
  version: number;
  sessions: PersistedSuperSession[];
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
 */
export function superSessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${safe}.json`;
}

function archivePath(baseDir: string, sessionId: string): string {
  return path.join(superSessionsDir(baseDir), superSessionFileName(sessionId));
}

/**
 * 读一个主会话的子会话归档。
 *
 * 文件不存在（从未派发过子会话）返回空数组；文件损坏（写到一半被 kill）
 * 同样返回空数组 —— 归档是辅助信息，读不出来不该拖垮整个恢复流程。
 */
export async function readSuperSessionArchive(
  baseDir: string,
  sessionId: string,
): Promise<PersistedSuperSession[]> {
  try {
    const raw = await readFile(archivePath(baseDir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as ArchiveFile;
    if (parsed?.version !== ARCHIVE_VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter((s): s is PersistedSuperSession => !!s && typeof s.id === "string");
  } catch {
    return []; // ENOENT（还没归档过）或损坏
  }
}

/** 原子写一个主会话的子会话归档。 */
export async function writeSuperSessionArchive(
  baseDir: string,
  sessionId: string,
  sessions: PersistedSuperSession[],
): Promise<void> {
  const dir = superSessionsDir(baseDir);
  const target = path.join(dir, superSessionFileName(sessionId));
  const tmp = `${target}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify({ version: ARCHIVE_VERSION, sessions } satisfies ArchiveFile), "utf8");
  await rename(tmp, target);
}

/** 删除一个主会话的子会话归档（会话被删除时用）。 */
export async function deleteSuperSessionArchive(baseDir: string, sessionId: string): Promise<void> {
  await rm(archivePath(baseDir, sessionId), { force: true });
}

/** 归档目录里的文件名列表（清理孤儿归档用）。 */
export async function listSuperSessionArchiveFiles(baseDir: string): Promise<string[]> {
  try {
    return await readdir(superSessionsDir(baseDir));
  } catch {
    return []; // 目录还没建
  }
}
