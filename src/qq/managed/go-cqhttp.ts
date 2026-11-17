/**
 * go-cqhttp 托管 provider（Wave5-A）。
 *
 * 只生成「下载什么 / 二进制在哪 / 怎么起 / 配置写什么」，不负责 spawn 进程
 * （进程管理留给后续 wave）。全部基于 node 内置模块，不 import vscode。
 *
 * 安全纪律：access token 只出现在本文件生成的 config.yml 内容里；不进日志、
 * 不进 `writeConfig` 的返回值（只有 configPath / written）、不进错误信息。
 * 已存在的 config.yml **一律不覆盖**（`flag: "wx"` 原子创建），避免吞掉用户
 * 手写配置。
 *
 * 支持矩阵：win32/x64、linux/x64、darwin/arm64。其它组合 `isSupported=false`
 * 且 `downloadUrl` / `binaryRelativePath` 抛错——UI 文案须如实说明不支持。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedOneBotConfig, ManagedOneBotProvider } from "./provider.js";

/**
 * 固定的 go-cqhttp 发行版本（便于复现；升级时只改这里 + 重新核对资产名）。
 * 取上游 Mrs4s/go-cqhttp 的正式 release 版本号（不带 `v` 前缀）。
 */
export const GO_CQHTTP_VERSION = "1.2.0";

/**
 * 下载地址模板。占位符 `{version}` / `{os}` / `{arch}` / `{ext}`。
 *
 * 「以实际 release 为准，需后续核对」：本波未联网实测 GitHub release 资产名，
 * 这里按上游惯例拼（`go-cqhttp_<version>_<os>_<arch>.<ext>`，Go 的 amd64 对应
 * Node 的 x64）；接入真实下载前必须用 `npm run harness` 或 curl.exe 核一次，
 * 资产名/标签前缀随发行版变化就改这里。
 */
const DOWNLOAD_URL_TEMPLATE =
  "https://github.com/Mrs4s/go-cqhttp/releases/download/v{version}/go-cqhttp_{version}_{os}_{arch}.{ext}";

/** Node 平台/架构 → go-cqhttp release 资产字段。仅列真正支持的组合。 */
interface AssetTarget {
  os: string;
  goArch: string;
  ext: "zip" | "tar.gz";
  binary: string;
}

function assetTarget(platform: NodeJS.Platform, arch: string): AssetTarget | undefined {
  const normalizedArch = arch.toLowerCase();
  if (platform === "win32" && normalizedArch === "x64") {
    return { os: "windows", goArch: "amd64", ext: "zip", binary: "go-cqhttp.exe" };
  }
  if (platform === "linux" && normalizedArch === "x64") {
    return { os: "linux", goArch: "amd64", ext: "tar.gz", binary: "go-cqhttp" };
  }
  if (platform === "darwin" && normalizedArch === "arm64") {
    return { os: "darwin", goArch: "arm64", ext: "tar.gz", binary: "go-cqhttp" };
  }
  return undefined;
}

function requireTarget(config: ManagedOneBotConfig): AssetTarget {
  const target = assetTarget(config.platform, config.arch);
  if (!target) {
    throw new Error(
      `go-cqhttp 一键托管不支持 ${config.platform}/${config.arch}（仅支持 win32/x64、linux/x64、darwin/arm64）`,
    );
  }
  return target;
}

/** YAML 双引号标量：JSON 字符串本身是合法的 YAML 双引号标量，转义最稳。 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** 生成最小可用 config.yml：二维码登录 + HTTP API + 反向上报 + 心跳。 */
function buildYaml(config: ManagedOneBotConfig): string {
  return [
    "# 由 iFlow Harness 一键托管生成（Wave5-A）。",
    "# 已有 config.yml 不会被覆盖；修改前请先停止托管实例。",
    "account:",
    "  uin: 0", // 0 = 二维码登录，首次启动需扫码
    '  password: ""',
    "  status: 0",
    "  relogin:",
    "    delay: 3",
    "    interval: 3",
    "    times: -1",
    "http:",
    "  host: 127.0.0.1",
    `  port: ${config.port}`,
    "  timeout: 5",
    "  post:",
    `    - url: ${yamlScalar(config.reversePostUrl)}`,
    "      type: string",
    "heartbeat:",
    "  interval: 5",
    "  disabled: false",
    "  image: false",
    `access-token: ${yamlScalar(config.accessToken)}`,
    "",
  ].join("\n");
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EEXIST";
}

export const goCqhttpProvider: ManagedOneBotProvider = {
  id: "go-cqhttp",
  displayName: "go-cqhttp",

  isSupported(platform, arch) {
    return assetTarget(platform, arch) !== undefined;
  },

  binaryRelativePath(config) {
    return requireTarget(config).binary;
  },

  downloadUrl(config) {
    const target = requireTarget(config);
    return DOWNLOAD_URL_TEMPLATE.replaceAll("{version}", GO_CQHTTP_VERSION)
      .replace("{os}", target.os)
      .replace("{arch}", target.goArch)
      .replace("{ext}", target.ext);
  },

  buildArgs() {
    // go-cqhttp 默认读取 cwd 下的 config.yml；调用方把 cwd 设为 installDir，
    // 因此这里返回空参数即可（不要传 -fast：二维码登录没有可复用的 session）。
    return [];
  },

  async writeConfig(config) {
    const configPath = join(config.installDir, "config.yml");
    await mkdir(config.installDir, { recursive: true });
    let written: string[];
    try {
      // "wx"：仅在文件不存在时创建，已存在则抛 EEXIST —— 天然防覆盖 / 防 TOCTOU。
      await writeFile(configPath, buildYaml(config), { encoding: "utf8", flag: "wx" });
      written = [configPath];
    } catch (err) {
      if (!isEexist(err)) throw err;
      // 已存在同名文件：保留用户配置，written 为空；不读取、不回显其中任何内容。
      written = [];
    }
    return { configPath, written };
  },

  loginProbeUrl(config) {
    return `http://127.0.0.1:${config.port}/get_login_info`;
  },
};
