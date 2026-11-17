/**
 * 一键托管 OneBot + 窗口内扫码的宿主侧**纯逻辑**辅助（Wave5-C）。
 *
 * 职责边界：只放可单测的纯函数（URL/设置补丁构造、阶段/二维码映射、脱敏）
 * 与端口占用探测（TCP/HTTP 两端都注入）。不 import vscode、不碰 panel 的
 * 私有状态、不做任何进程管理 —— 编排留在 panel.ts，本模块只被它调用。
 *
 * 安全纪律：
 *  - accessToken / botToken 只允许出现在 `buildManagedSettingsUpdate` 的
 *    `secrets` 返回值（给宿主写 SecretStorage）与探测请求头里；
 *    `toManagedStatusMessage` 会再过一遍 `redactManagedToken`，杜绝 token
 *    经 qqManagedStatus.message 泄漏。
 *  - 端口探测走 node:net / node:http 直连（不用全局 fetch，项目陷阱 #2），
 *    两端都可注入，测试无需真的占端口。
 */

import * as http from "node:http";
import * as net from "node:net";
import path from "node:path";
import { isQrDataUrl, type HostToWebview } from "../../shared/messages.js";
import type { ManagedPhase } from "../qq/managed/manager.js";

/** OneBot HTTP API 默认端口（go-cqhttp 默认），托管实例固定用它。 */
export const QQ_MANAGED_ONEBOT_PORT = 5700;

/** OneBot 反向 HTTP 事件路径，与 onebot-sink 的 DEFAULT_ONEBOT_PATH 一致。 */
export const ONEBOT_POST_PATH = "/onebot/event";

/** HostToWebview 的托管进度消息形状（从协议取，避免两侧漂移）。 */
export type ManagedStatusMessage = Extract<HostToWebview, { type: "qqManagedStatus" }>;
/** HostToWebview 的扫码消息形状。 */
export type QrLoginMessage = Extract<HostToWebview, { type: "qqLoginQr" }>;

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/**
 * 托管安装目录：`globalStorageUri.fsPath/qq/managed`。
 * 纯拼路径，不创建目录（建目录是 manager/provider 的事）。
 */
export function managedInstallDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, "qq", "managed");
}

/**
 * 构造 OneBot → bridge 的反向上报地址：`http://127.0.0.1:<incomingPort>/onebot/event`。
 * incomingPort 来自 bridge_ready（已 listen 的实际端口），非法值直接抛错，
 * 避免把一个连不上 sink 的地址写进 config.yml。
 */
export function buildReversePostUrl(incomingPort: number): string {
  if (!isPort(incomingPort)) {
    throw new Error(`无效的 bridge 入站端口：${String(incomingPort)}`);
  }
  return `http://127.0.0.1:${incomingPort}${ONEBOT_POST_PATH}`;
}

/** 由 OneBot 端口构造 bridge/服务要连的 HTTP API 基地址。 */
export function buildManagedEndpoint(port: number): string {
  if (!isPort(port)) throw new Error(`无效的 OneBot 端口：${String(port)}`);
  return `http://127.0.0.1:${port}`;
}

/** 去掉文本里所有 token 出现（manager 已脱敏，这里再兜一层）。 */
export function redactManagedToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

/**
 * manager 阶段快照 → qqManagedStatus 消息。
 * phase 直接透传（两侧枚举逐字一致）；message 过 token 脱敏；progress 仅在
 * 数值时携带（下载等可度量阶段）。
 */
export function toManagedStatusMessage(
  status: { phase: ManagedPhase; message: string; progress?: number },
  token?: string,
): ManagedStatusMessage {
  const out: ManagedStatusMessage = {
    type: "qqManagedStatus",
    phase: status.phase,
    message: redactManagedToken(status.message, token),
  };
  if (typeof status.progress === "number") out.progress = status.progress;
  return out;
}

/** 只有 waiting_login 阶段才需要显示二维码；其余阶段二维码桥应停掉。 */
export function qrBridgeActiveForPhase(phase: ManagedPhase): boolean {
  return phase === "waiting_login";
}

/** 取消扫码 / 登录结束后的清屏帧（dataUrl 空、phase=expired）。 */
export function buildClearedQrMessage(now: number): QrLoginMessage {
  return { type: "qqLoginQr", dataUrl: "", expiresAt: now, phase: "expired" };
}

/**
 * QrBridge 消息过护栏后再推 webview：dataUrl 必须是严格 PNG data URL，
 * 否则退化成清屏帧，绝不把任意内容塞进 `<img src>`。
 */
export function sanitizeQrMessage(msg: QrLoginMessage): QrLoginMessage {
  if (isQrDataUrl(msg.dataUrl)) return msg;
  return { ...msg, dataUrl: "", phase: "expired" };
}

/**
 * 成功后的设置补丁：写入 endpoint / enabled，accessToken 作为 botToken 走
 * SecretStorage（两者必须同一个值，否则 OneBot 反向上报的 Bearer 与 bridge
 * 校验对不上）。panel 拿到返回值后分别调用 applyQqSettingsPatch / writeQqSecrets。
 */
export function buildManagedSettingsUpdate(
  endpointPort: number,
  accessToken: string,
): { patch: { enabled: true; endpoint: string }; secrets: { botToken: string } } {
  return {
    patch: { enabled: true, endpoint: buildManagedEndpoint(endpointPort) },
    secrets: { botToken: accessToken },
  };
}

// ---------------------------------------------------------------------------
// 端口占用探测（manager 之外，注入式）
// ---------------------------------------------------------------------------

/** 5700 端口的探测结论。 */
export type ManagedPortProbe =
  /** 没有进程监听，托管可以安全 spawn 自己的实例。 */
  | { kind: "free" }
  /** 已有一个能正确应答 get_login_info 的 OneBot —— 交给 manager 复用/轮询。 */
  | { kind: "onebot" }
  /** 有进程监听但不是可用的 OneBot —— 拒绝启动，绝不拿别人的实例。 */
  | { kind: "occupied" };

/** 端口探测的全部 IO 端点，测试可注入假实现。 */
export interface ManagedPortProbeDeps {
  /** TCP 连接是否成功（连接被拒 / 超时返回 false）。默认 node:net。 */
  connectTcp?: (port: number, host: string, timeoutMs: number) => Promise<boolean>;
  /** get_login_info 是否应答出可识别的 OneBot 形状（带 status 键）。默认 node:http。 */
  getLoginInfo?: (port: number, accessToken: string, timeoutMs: number) => Promise<boolean>;
  /** TCP 连接超时，默认 1500ms（本机端口，未监听应快速失败）。 */
  connectTimeoutMs?: number;
  /** get_login_info 超时，默认 2000ms。 */
  loginTimeoutMs?: number;
}

const PROBE_HOST = "127.0.0.1";

/** 默认 TCP 探测：连上即 true，连接拒绝/超时/错误都当 false（端口空闲）。 */
const defaultConnectTcp = (
  port: number,
  host: string,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

/** 默认 get_login_info：HTTP 200 且 JSON 带 `status` 键才算可识别的 OneBot。 */
const defaultGetLoginInfo = (
  port: number,
  accessToken: string,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      {
        host: PROBE_HOST,
        port,
        path: "/get_login_info",
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            finish(false);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(
              typeof parsed === "object" &&
                parsed !== null &&
                "status" in (parsed as Record<string, unknown>),
            );
          } catch {
            finish(false);
          }
        });
        res.on("error", () => finish(false));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
    req.end();
  });

/**
 * 探测 OneBot 端口占用情况。
 *
 * 先 TCP 连接：连不上 = 端口空闲；连上后用 get_login_info 判断对面是不是
 * 可用的 OneBot —— 是则交给 manager 复用，否则报「端口被占用」并停止，
 * 防止 manager 的首次探测连到别人的实例上。
 */
export async function probeManagedPort(
  port: number,
  accessToken: string,
  deps: ManagedPortProbeDeps = {},
): Promise<ManagedPortProbe> {
  const connect = deps.connectTcp ?? defaultConnectTcp;
  const reachable = await connect(port, PROBE_HOST, deps.connectTimeoutMs ?? 1_500);
  if (!reachable) return { kind: "free" };
  const getLogin = deps.getLoginInfo ?? defaultGetLoginInfo;
  const onebot = await getLogin(port, accessToken, deps.loginTimeoutMs ?? 2_000);
  return onebot ? { kind: "onebot" } : { kind: "occupied" };
}
