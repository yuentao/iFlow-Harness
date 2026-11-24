import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 发布流程守卫：`package.json.version` 必须等于 `CHANGELOG.md` 顶部版本。
 *
 * 本地 `*.vsix` 是构建产物：内容已经是新代码、manifest 却还带着旧版本号时，
 * `code --install-extension` 对同版本会直接跳过安装 —— 用户以为「已升级到最新版」，
 * 实际扩展宿主加载的仍是旧 manifest，于是又复现「设置键未注册」那条错误。
 * 版本号一致是这条流程能被信任的前提。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Topmost `## [x.y.z]` heading — same shape `scripts/read-changelog.mjs` parses. */
function readChangelogTopVersion(): string {
  const text = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const heading = /^##\s+\[?(\d+\.\d+\.\d+)\]?[^\n]*$/m.exec(text);
  if (!heading?.[1]) throw new Error("CHANGELOG.md 顶部没有 '## [x.y.z]' 版本条目");
  return heading[1];
}

describe("发布版本一致性", () => {
  it("package.json.version 等于 CHANGELOG.md 顶部版本", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
    expect(pkg.version).toBe(readChangelogTopVersion());
  });
});
