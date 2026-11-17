/**
 * 应用内一键托管 OneBot 的 provider 抽象（Wave5-A）。
 *
 * 职责边界：本目录只做「下载 / 配置 / 生成启动参数」这些底层件，不碰 panel、
 * 不做进程管理、不触碰 webview 消息协议——那些留给后续 wave 的 wiring。
 *
 * 分层纪律：这里全是纯逻辑 + node 内置模块（http/https/fs/child_process），
 * 不 import vscode、不引入新依赖，可直接单测。
 *
 * 安全纪律：`ManagedOneBotConfig.accessToken` 只允许被写进 provider 生成的
 * 配置文件；本模块所有返回值 / 错误信息都不携带它，也不打印日志。
 *
 * 支持矩阵纪律：只有真正实现并验证过的 provider / 平台组合才返回 true。
 * `napcat` 目前是占位实现，`isSupported` 恒为 false、其余方法直接抛错——
 * 绝不假装可用，避免上层据此拉起一个根本跑不起来的实例。
 */

import { goCqhttpProvider } from "./go-cqhttp.js";

/** 托管 OneBot 的实现种类。 */
export type ManagedProviderId = "go-cqhttp" | "napcat";

/** 生成 / 下载 / 启动一个托管实例所需的全部输入。 */
export interface ManagedOneBotConfig {
  /** 安装目录（二进制与 config.yml 的落点）。 */
  installDir: string;
  /** 目标平台（通常是 `process.platform`，测试可注入）。 */
  platform: NodeJS.Platform;
  /** 目标架构（通常是 `process.arch`，测试可注入）：`x64` / `arm64` 等。 */
  arch: string;
  /** OneBot HTTP API 监听端口。 */
  port: number;
  /** HTTP API 的 access token，只写进配置文件。 */
  accessToken: string;
  /** 事件反向上报的完整地址，例如 `http://127.0.0.1:3000/onebot`。 */
  reversePostUrl: string;
}

/** 一个托管实现的统一契约。 */
export interface ManagedOneBotProvider {
  id: ManagedProviderId;
  displayName: string;
  /** 该平台 / 架构组合是否真的可用（未实现的一律 false）。 */
  isSupported(platform: NodeJS.Platform, arch: string): boolean;
  /** 解压后二进制相对 `installDir` 的路径。 */
  binaryRelativePath(config: ManagedOneBotConfig): string;
  /** 正式发行包的下载地址。 */
  downloadUrl(config: ManagedOneBotConfig): string;
  /** 启动参数（相对二进制所在目录，cwd 由调用方设为 installDir）。 */
  buildArgs(config: ManagedOneBotConfig): string[];
  /**
   * 落配置文件。**已存在同名文件时不覆盖**，返回 `written: []`。
   * 返回值只有 configPath / written 两个字段，绝不含 secret。
   */
  writeConfig(config: ManagedOneBotConfig): Promise<{ configPath: string; written: string[] }>;
  /** 登录完成探针地址（200 即视为可登录）。 */
  loginProbeUrl(config: ManagedOneBotConfig): string;
}

/** NapCat 尚未实现：占位但绝不假装可用。 */
const notImplemented = (): never => {
  throw new Error("NapCat 一键托管尚未实现，请选择 go-cqhttp");
};

const napcatProvider: ManagedOneBotProvider = {
  id: "napcat",
  displayName: "NapCat（尚未实现）",
  isSupported: () => false,
  binaryRelativePath: notImplemented,
  downloadUrl: notImplemented,
  buildArgs: notImplemented,
  writeConfig: () => Promise.reject(new Error("NapCat 一键托管尚未实现，请选择 go-cqhttp")),
  loginProbeUrl: notImplemented,
};

const PROVIDERS: Record<ManagedProviderId, ManagedOneBotProvider> = {
  "go-cqhttp": goCqhttpProvider,
  napcat: napcatProvider,
};

/** 按 id 取 provider；未知 id 抛错（不返回 undefined，避免上层静默误用）。 */
export function getProvider(id: ManagedProviderId): ManagedOneBotProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`未知的托管 OneBot provider: ${String(id)}`);
  return provider;
}