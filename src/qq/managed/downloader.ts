/**
 * 托管 OneBot 二进制的安全下载 / 解压底层件（Wave5-A）。
 *
 * 传输纪律：走 node:http(s) 直连，**不用全局 fetch**——VSCode 扩展宿主用代理
 * agent patch 了 fetch，SOCKS / 无 scheme 的系统代理会抛 "Invalid URL protocol"
 * （项目陷阱 #2，models-query.ts / web-search.ts 同纪律）。
 *
 * 安全纪律：
 *  - URL 协议白名单只认 http/https（初始 URL 与每一次 redirect 都查，file: 直接拒）；
 *  - redirect 最多 5 次；非 2xx、超 Content-Length、超时一律抛带可读 message 的错误；
 *  - 写盘用 `<dest>.tmp-<random>` + rename 原子替换，任何失败都删临时文件；
 *  - 解压只落 destDir，解压后逐个 realpath 校验，逃逸的产物删除并抛错；
 *  - 所有错误信息都不含 token（本模块根本不知道 token 的存在）。
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, lstat, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { dirname, isAbsolute, join, relative } from "node:path";

/** 可注入的响应形状，默认实现由 node:https 包装。 */
export interface FetchResponseLike {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
  /** 中止连接（重定向 / 错误 / 超时时用）。 */
  destroy(): void;
}

/** 可注入的 fetch 签名（测试用本地 http server 或桩替代）。 */
export type FetchImpl = (
  url: string,
  opts: { timeoutMs: number },
) => Promise<FetchResponseLike>;

export interface DownloadManagedBinaryOptions {
  url: string;
  destPath: string;
  /** 默认 150MB。 */
  maxBytes?: number;
  /** 默认 120s。 */
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

export type ExtractRun = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; windowsHide?: boolean },
) => Promise<void>;

export interface ExtractArchiveOptions {
  archivePath: string;
  destDir: string;
  /** 可注入运行器；默认用系统 tar（Windows 10 自带 bsdtar）。 */
  run?: ExtractRun;
}

const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "iFlow-Harness/OneBot-Managed";

function assertHttpUrl(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("下载 URL 无效");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`下载 URL 协议不被允许：${target.protocol}`);
  }
  return target;
}

function headerValue(headers: FetchResponseLike["headers"], name: string): string | undefined {
  const key = name.toLowerCase();
  for (const [nameKey, value] of Object.entries(headers)) {
    if (nameKey.toLowerCase() !== key) continue;
    if (Array.isArray(value)) return value[0];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** 默认 fetch：node:http(s) 直连，连接阶段超时即 reject（不碰全局 fetch）。 */
const defaultFetch: FetchImpl = (url, opts) =>
  new Promise<FetchResponseLike>((resolve, reject) => {
    let target: URL;
    try {
      target = assertHttpUrl(url);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = target.protocol === "http:" ? http : https;
    const req = transport.request(
      target,
      { method: "GET", headers: { "user-agent": USER_AGENT, "accept-encoding": "identity" } },
      (res) => {
        // 响应到达后 Promise 已 settle；之后的 req error 只会走已注册的监听器，
        // 不会变成未处理的 rejection。body 阶段的超时由 collectBody 负责。
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as FetchResponseLike["headers"],
          body: res,
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`下载连接超时（${opts.timeoutMs}ms）`));
    });
    req.on("error", reject);
    req.end();
  });

/** 读取响应体，带字节上限与总超时；任一失败都先 destroy 连接。 */
function collectBody(
  response: FetchResponseLike,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };
    const succeed = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      response.destroy();
      reject(err);
    };

    timer = setTimeout(() => fail(new Error(`下载超时（${timeoutMs}ms）`)), timeoutMs);

    const chunks: Buffer[] = [];
    let size = 0;
    response.body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error(`下载内容超过上限（${maxBytes} 字节）`));
        return;
      }
      chunks.push(chunk);
    });
    response.body.on("end", () => succeed(Buffer.concat(chunks)));
    response.body.on("error", (err: Error) => fail(new Error(`下载读取失败：${err.message}`)));
    response.body.on("aborted", () => fail(new Error("下载连接被中断")));
  });
}

/** 下载到 `destPath`：原子写、超限/非 2xx/超时抛错，失败不留 .tmp 文件。 */
export async function downloadManagedBinary(
  opts: DownloadManagedBinaryOptions,
): Promise<{ bytes: number }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;

  assertHttpUrl(opts.url); // 初始 URL 就做协议白名单，file: / data: 直接拒。
  let currentUrl = opts.url;

  for (let redirects = 0; ; ) {
    const response = await fetchImpl(currentUrl, { timeoutMs });

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = headerValue(response.headers, "location");
      response.destroy();
      if (!location) throw new Error(`下载重定向缺少 Location（HTTP ${response.statusCode}）`);
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`下载重定向次数超过上限（${MAX_REDIRECTS} 次）`);
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new Error("下载重定向地址无效");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`下载重定向协议不被允许：${next.protocol}`);
      }
      currentUrl = next.toString();
      redirects += 1;
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw new Error(`下载失败：HTTP ${response.statusCode}`);
    }

    const declared = headerValue(response.headers, "content-length");
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy();
        throw new Error(`下载内容超过上限（${maxBytes} 字节）`);
      }
    }

    const bytes = await collectBody(response, maxBytes, timeoutMs);
    const tmpPath = `${opts.destPath}.tmp-${randomBytes(6).toString("hex")}`;
    await mkdir(dirname(opts.destPath), { recursive: true });
    try {
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, opts.destPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    return { bytes: bytes.length };
  }
}

function isWithin(child: string, root: string): boolean {
  const rel = relative(root, child);
  if (rel.length === 0) return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

interface WalkEntry {
  abs: string;
  rel: string;
}

async function walk(
  dir: string,
  rootAbs: string,
  rootReal: string,
  out: WalkEntry[],
  escaped: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      // 悬空链接 / 无法解析的产物一律视作不安全。
      escaped.push(abs);
      continue;
    }
    if (!isWithin(real, rootReal)) {
      escaped.push(abs);
      continue;
    }
    out.push({ abs, rel: relative(rootAbs, abs) });
    if (entry.isDirectory()) {
      await walk(real, rootAbs, rootReal, out, escaped);
    }
  }
}

/** 默认解压运行器：系统 tar（Windows 10+ 自带 bsdtar，vendor-cli 同款做法）。 */
const defaultRun: ExtractRun = (cmd, args, runOpts) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: runOpts.cwd, windowsHide: runOpts.windowsHide, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err) => {
        if (err) reject(new Error(`解压失败：${err.message}`));
        else resolve();
      },
    );
  });

/**
 * 解压归档到 destDir，返回相对路径列表。
 * 解压后逐个 realpath 校验；逃逸（软链 / 越界目录）产物立即删除并抛错。
 */
export async function extractArchive(opts: ExtractArchiveOptions): Promise<string[]> {
  const run = opts.run ?? defaultRun;
  await mkdir(opts.destDir, { recursive: true });
  await run("tar", ["-xf", opts.archivePath, "-C", opts.destDir], {
    cwd: opts.destDir,
    windowsHide: true,
  });

  const rootReal = await realpath(opts.destDir);
  const entries: WalkEntry[] = [];
  const escaped: string[] = [];
  await walk(opts.destDir, opts.destDir, rootReal, entries, escaped);

  if (escaped.length > 0) {
    for (const abs of escaped) {
      try {
        const stat = await lstat(abs);
        if (stat.isSymbolicLink()) await unlink(abs);
        else await rm(abs, { recursive: true, force: true });
      } catch {
        // 清理是尽力而为：即使删不掉也要抛错让上层知道有逃逸产物。
      }
    }
    throw new Error(`解压产物逃逸目标目录，已清理 ${escaped.length} 项`);
  }

  return entries.map((entry) => entry.rel);
}
