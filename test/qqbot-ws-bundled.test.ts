/**
 * 回归守卫：QQBot 的 `ws` 必须随 host bundle 静态打进 `dist/extension.cjs`。
 *
 * 背景（用户真机 P0）：VSIX 用 `vsce package --no-dependencies` + `.vscodeignore`
 * 排除 `node_modules/**`（只有 vendor/iflow-cli 例外），因此用户机器上没有
 * `node_modules/ws`。旧版 ws-transport.ts 用 `createRequire(...)("ws")` 运行期
 * 动态加载，esbuild 不会把它当静态依赖 bundle，安装到干净环境即
 * `Cannot find module 'ws'`（Require stack → dist/extension.cjs）。
 *
 * 本测试用仓库自带 esbuild 现场 bundle `ws-transport.ts`，选项逐字复刻
 * esbuild.mjs 的 host 入口（bundle + cjs + node + 只把 vscode 标 external），
 * 断言产物里含 ws 的模块实现、且没有运行期 `createRequire("ws")`。这样
 * 「ws 是否真的进了产物」成为可重复运行的测试不变量，而不是一次性的手工
 * findstr。现场构建失败直接让用例失败，没有 skip 分支；不连网关、不碰凭据。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
/** 与 esbuild.mjs host 入口一致：只把 vscode 标 external。 */
const HOST_EXTERNAL = ["vscode"];

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "iflow-ws-bundle-"));
const outfile = path.join(tmpDir, "extension.cjs");

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 现场构建：选项与 esbuild.mjs 的 host 入口对 ws 依赖的处理保持一致。 */
async function buildHostLike(): Promise<string> {
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "src", "qq", "qqbot", "ws-transport.ts")],
    bundle: true,
    outfile,
    external: HOST_EXTERNAL,
    format: "cjs",
    platform: "node",
    target: "node20",
    minify: true,
    keepNames: true,
    logLevel: "silent",
  });
  if (!existsSync(outfile) || statSync(outfile).size === 0) {
    throw new Error("esbuild reported success but host-like bundle is missing/empty");
  }
  return readFileSync(outfile, "utf8");
}

describe("QQBot ws 静态打包（打包后 Cannot find module 'ws' 回归守卫）", () => {
  it("host bundle 内含 ws 的模块实现，且无运行期 createRequire('ws') 动态加载", async () => {
    const code = await buildHostLike();

    // ws 的实现被静态内联：这些字符串常量只来自 ws 包本身的协议实现，
    // 不是我们源码里的字面量（minify 不改写字符串内容，keepNames 与
    // esbuild.mjs host 入口一致，类名同样保留，断言稳定）。
    expect(code).toContain("PerMessageDeflate");
    expect(code).toContain("Sec-WebSocket-Key");
    expect(code).toContain("websocketMask");

    // 关键回归点：不能再有运行期动态加载 ws（esbuild 不会 bundle 它）。
    expect(code).not.toContain("createRequire");
    expect(code).not.toMatch(/require\(["']ws["']\)/);
  });

  it("源码层面：ws 是顶层静态 import，不再惰性 createRequire", () => {
    const source = readFileSync(
      path.join(repoRoot, "src", "qq", "qqbot", "ws-transport.ts"),
      "utf8",
    );
    expect(source).toMatch(/import\s+WebSocket\s+from\s+["']ws["']/);
    expect(source).not.toMatch(/createRequire\(/);
    // 注入口仍在，供单测用假实现驱动。
    expect(source).toContain("WebSocketImpl");
  });
});
