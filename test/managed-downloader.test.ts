import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadManagedBinary,
  extractArchive,
  type ExtractRun,
  type FetchImpl,
} from "../src/qq/managed/downloader.js";

const BODY = "hello-archive";

let server: http.Server;
let baseUrl: string;
const dirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(BODY);
        return;
      case "/redirect":
        res.writeHead(302, { location: "/ok" });
        res.end();
        return;
      case "/file-redirect":
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      case "/notfound":
        res.writeHead(404);
        res.end("nope");
        return;
      case "/biglen":
        // 声明 200MB 但只写 1 字节；下载器应在读 body 前就按 Content-Length 拒绝。
        res.writeHead(200, { "content-length": String(200 * 1024 * 1024) });
        res.write("x");
        return;
      case "/slow":
        // 永不响应：用于验证连接超时。
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "managed-downloader-"));
  dirs.push(dir);
  return dir;
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("downloadManagedBinary（本地 http server）", () => {
  it("200：写入目标文件且无 .tmp 残留", async () => {
    const dir = tempDir();
    const destPath = join(dir, "go-cqhttp");
    const result = await downloadManagedBinary({ url: `${baseUrl}/ok`, destPath });
    expect(result.bytes).toBe(Buffer.byteLength(BODY));
    expect(readFileSync(destPath, "utf8")).toBe(BODY);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("302：跟随重定向后落盘", async () => {
    const dir = tempDir();
    const destPath = join(dir, "bin");
    const result = await downloadManagedBinary({ url: `${baseUrl}/redirect`, destPath });
    expect(result.bytes).toBe(Buffer.byteLength(BODY));
    expect(readFileSync(destPath, "utf8")).toBe(BODY);
  });

  it("重定向协议白名单：file: 被拒，不留文件", async () => {
    const dir = tempDir();
    const destPath = join(dir, "bin");
    await expect(
      downloadManagedBinary({ url: `${baseUrl}/file-redirect`, destPath }),
    ).rejects.toThrow(/协议/);
    expect(existsSync(destPath)).toBe(false);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("初始 URL 协议白名单：file: 直接拒", async () => {
    const dir = tempDir();
    await expect(
      downloadManagedBinary({ url: "file:///etc/passwd", destPath: join(dir, "bin") }),
    ).rejects.toThrow(/协议/);
  });

  it("重定向超过 5 次抛错", async () => {
    const dir = tempDir();
    await expect(
      downloadManagedBinary({ url: `${baseUrl}/loop`, destPath: join(dir, "bin") }),
    ).rejects.toThrow(/上限/);
  });

  it("404 抛可读错误", async () => {
    const dir = tempDir();
    await expect(
      downloadManagedBinary({ url: `${baseUrl}/notfound`, destPath: join(dir, "bin") }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("超大 Content-Length 抛错且不写文件", async () => {
    const dir = tempDir();
    const destPath = join(dir, "bin");
    await expect(
      downloadManagedBinary({ url: `${baseUrl}/biglen`, destPath, maxBytes: 1024 }),
    ).rejects.toThrow(/上限/);
    expect(existsSync(destPath)).toBe(false);
  });

  it("服务器无响应时按 timeoutMs 超时", async () => {
    const dir = tempDir();
    await expect(
      downloadManagedBinary({
        url: `${baseUrl}/slow`,
        destPath: join(dir, "bin"),
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/超时/);
  });

  it("注入 fetch：body 中途失败时清理临时文件", async () => {
    const dir = tempDir();
    const destPath = join(dir, "bin");
    const body = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") queueMicrotask(() => listener(Buffer.from("partial")));
        if (event === "error") queueMicrotask(() => listener(new Error("stream broke")));
        return body;
      },
    } as unknown as NodeJS.ReadableStream;
    const fetchImpl: FetchImpl = async () => ({
      statusCode: 200,
      headers: {},
      body,
      destroy() {
        /* noop */
      },
    });

    await expect(
      downloadManagedBinary({
        url: `${baseUrl}/ok`,
        destPath,
        fetchImpl,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/读取失败/);
    expect(existsSync(destPath)).toBe(false);
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});

describe("extractArchive", () => {
  it("正常解压：注入 run 落文件后返回相对路径列表", async () => {
    const destDir = join(tempDir(), "unpacked");
    const run: ExtractRun = async (cmd, args, opts) => {
      expect(cmd).toBe("tar");
      expect(args).toEqual(["-xf", "archive.tar.gz", "-C", destDir]);
      expect(opts.cwd).toBe(destDir);
      writeFileSync(join(destDir, "go-cqhttp"), "binary");
    };

    const result = await extractArchive({ archivePath: "archive.tar.gz", destDir, run });
    expect(result).toContain("go-cqhttp");
  });

  it("逃逸路径：指向目录外的 junction/symlink 被删除并抛错", async () => {
    const parent = tempDir();
    const destDir = join(parent, "unpacked");
    const outside = join(parent, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "keep-me", "utf8");

    const run: ExtractRun = async () => {
      try {
        symlinkSync(outside, join(destDir, "escape"), "junction");
      } catch {
        symlinkSync(outside, join(destDir, "escape"), "dir");
      }
    };

    await expect(extractArchive({ archivePath: "x.tar.gz", destDir, run })).rejects.toThrow(
      /逃逸/,
    );
    expect(existsSync(join(destDir, "escape"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep-me");
  });
});
