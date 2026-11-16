/**
 * QQ bridge 进程入口（独立 Node 进程，零 vscode 依赖）。
 *
 * 职责边界：
 *  - 监听 OneBot 反向 HTTP 事件 → 归一化 → 上行给扩展宿主（`/v1/events`）；
 *  - 监听宿主的投递请求（`/v1/deliver`）→ 经 OneBot HTTP API 发送到 QQ；
 *  - 启动、单实例失败、退出信号与 stdin 关闭的清理都在这里。
 *
 * 它**不做**任何授权 / 白名单 / 命令解析：那些属于宿主（见 onebot-sink.ts）。
 * 日志一律走 stderr——stdout 可能被上一层当作协议管道，污染它会打断解析。
 */

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkQqText } from "../../../shared/qq-task.js";
import { buildReplyPayload, buildSendGroupMsg, buildSendPrivateMsg } from "../adapter/onebot.js";
import type { ChatType } from "../adapter/types.js";
import { HttpOneBotTransport } from "../adapter/http-transport.js";
import { createDeliveryServer, type DeliveryMessage, type DeliveryServer } from "./delivery-server.js";
import { createHostClient } from "./host-client.js";
import { DEFAULT_ONEBOT_PATH, createOneBotSink, type OneBotSink } from "./onebot-sink.js";
import { resolveSelfId } from "./self-id.js";

/** 单条 QQ 文本消息的字符预算；超长时按行 / 围栏切分。 */
const OUTBOUND_CHUNK_CHARS = 3000;
/** 分片之间的间隔，避免触发平台侧频率限制。 */
const CHUNK_INTERVAL_MS = 300;

function log(message: string): void {
  console.error(`[qq-bridge] ${message}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function parsePort(raw: string | undefined, name: string, allowZero: boolean): number {
  if (raw === undefined) {
    if (allowZero) return 0;
    throw new Error(`missing required environment variable ${name}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) {
    throw new Error(`${name} must be a port number${allowZero ? " (0 = auto)" : ""}, got "${raw}"`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已绑定的端口是否可用（取值 1–65535；0 表示尚未 listen，不能上报给宿主）。 */
function isListeningPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** 上报给宿主的启动握手载荷。 */
export interface BridgeReadyPayload {
  type: "bridge_ready";
  /** OneBot 反向 HTTP 事件入口端口（QQ 后端往这里推事件）。 */
  incomingPort: number;
  /** 宿主投递入口端口（宿主往这里 POST `/v1/deliver`）。 */
  deliveryPort: number;
  pid: number;
  startedAt: number;
}

/**
 * 构造 `bridge_ready` 载荷。
 *
 * 端口必须来自两个 server **listen 完成后的** `server.address()`，绝不能用
 * 传入 `listen(0)` 的自动分配值 0——宿主拿 0 无处可投递，整条回传链路断掉。
 */
export function buildReadyPayload(input: {
  incomingPort: number;
  deliveryPort: number;
  pid: number;
  startedAt: number;
}): BridgeReadyPayload {
  return {
    type: "bridge_ready",
    incomingPort: input.incomingPort,
    deliveryPort: input.deliveryPort,
    pid: input.pid,
    startedAt: input.startedAt,
  };
}

/**
 * 本模块是否被直接执行（而不是被 import，例如单元测试）。
 *
 * 入口是独立 Node 进程（`node dist/qq-bridge.cjs` 或 tsc 产出的
 * `dist/src/qq/bridge/main.js`）；被 import 时不应产生「读环境变量 / 起监听 /
 * 退出进程」这类副作用。
 *
 * 判定分两条通道，都必须是**防御式**的：
 *  1. CJS 产物（`dist/qq-bridge.cjs`，panel 实际 spawn 的路径）走
 *     `require.main === module` —— 不依赖 `import.meta`。esbuild 的
 *     `--format=cjs` 会把 `import.meta` 编译成空对象，早先只做路径比较时
 *     `fileURLToPath(undefined)` 抛错被 catch 吞成 false，整个 main() 不执行，
 *     进程静默退出 0（P0）。esbuild.mjs 现在也 define 了 `import.meta.url`，
 *     但这里不把可运行性押在打包器配置上。
 *  2. ESM 产物（tsc 输出 / 测试 import）没有 `require`，退回 `import.meta.url`
 *     与 `process.argv[1]` 的路径比较。
 *
 * 任何异常都不能静默吞成 false：两种判定都不可用时**默认按入口执行**（宁可
 * 误启动也不能静默退出），并在 stderr 打一行说明——静默退出会让面板无从诊断。
 */
function isDirectEntry(): boolean {
  if (typeof require !== "undefined" && typeof module !== "undefined") {
    try {
      return require.main === module;
    } catch {
      // 非常规 CJS 宿主（require 被替换等）：落到下面的路径比较。
    }
  }

  const entry = process.argv[1];
  if (!entry) {
    log("cannot determine entry mode (no process.argv[1]); assuming direct execution");
    return true;
  }
  try {
    const self = normalizeEntryPath(fileURLToPath(import.meta.url));
    const target = normalizeEntryPath(entry);
    // Windows 路径大小写不敏感（盘符/目录大小写常与 import.meta.url 不一致）。
    return process.platform === "win32"
      ? self.toLowerCase() === target.toLowerCase()
      : self === target;
  } catch (error) {
    log(
      `cannot determine entry mode (${errorMessage(error)}); assuming direct execution`,
    );
    return true;
  }
}

/** 符号链接/相对路径归一；路径不存在时退回词法形式（Node 可能已解析真实路径）。 */
function normalizeEntryPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

interface BridgeConfig {
  hostPort: number;
  bridgeToken: string;
  hmacSecret: string;
  incomingPort: number;
  incomingToken: string;
  onebotUrl?: string;
  onebotToken?: string;
  /** env `IFLOW_QQ_SELF_ID`（宿主可能不传）；真实 selfId 由 `resolveSelfId` 解析。 */
  envSelfId?: string;
}

function readConfig(): BridgeConfig {
  return {
    hostPort: parsePort(process.env["IFLOW_QQ_HOST_PORT"], "IFLOW_QQ_HOST_PORT", false),
    bridgeToken: requireEnv("IFLOW_QQ_BRIDGE_TOKEN"),
    hmacSecret: requireEnv("IFLOW_QQ_HMAC_SECRET"),
    incomingPort: parsePort(process.env["IFLOW_QQ_INCOMING_PORT"], "IFLOW_QQ_INCOMING_PORT", true),
    incomingToken: requireEnv("IFLOW_QQ_INCOMING_TOKEN"),
    onebotUrl: readEnv("IFLOW_QQ_ONEBOT_URL"),
    onebotToken: readEnv("IFLOW_QQ_ONEBOT_TOKEN"),
    envSelfId: readEnv("IFLOW_QQ_SELF_ID"),
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const startedAt = Date.now();
  const hostClient = createHostClient({
    hostPort: config.hostPort,
    bridgeToken: config.bridgeToken,
    hmacSecret: config.hmacSecret,
  });

  const transport = config.onebotUrl
    ? new HttpOneBotTransport({ baseUrl: config.onebotUrl, accessToken: config.onebotToken })
    : undefined;

  /** 串行发送分片：失败即停止（后一片依赖前一片先到，乱序没有意义）。 */
  const deliver = async (message: DeliveryMessage): Promise<void> => {
    const chatType: ChatType = message.chatType;
    const text = message.text;

    if (!transport) {
      log("deliver failed: IFLOW_QQ_ONEBOT_URL is not configured");
      return;
    }
    if (message.filePath) {
      // OneBot HTTP transport 尚未实现文件上传；如实报告，不假装已发送。
      log(`deliver file skipped (unsupported by OneBot HTTP transport): ${message.filePath}`);
    }
    if (text.trim().length === 0) {
      if (!message.filePath) log("deliver skipped: empty text");
      return;
    }

    const chunks = chunkQqText(text, OUTBOUND_CHUNK_CHARS);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const action =
        index === 0 && message.replyToMsgId
          ? buildReplyPayload(message.chatId, chunk, message.replyToMsgId, chatType)
          : chatType === "group"
            ? buildSendGroupMsg(message.chatId, chunk)
            : buildSendPrivateMsg(message.chatId, chunk);
      try {
        await transport.post(action.action, action.params);
      } catch (error) {
        log(`deliver failed (chunk ${index + 1}/${chunks.length}): ${errorMessage(error)}`);
        return;
      }
      if (index < chunks.length - 1) await sleep(CHUNK_INTERVAL_MS);
    }
  };

  let delivery: DeliveryServer | undefined;
  let sink: OneBotSink | undefined;
  try {
    delivery = await createDeliveryServer({
      port: 0,
      token: config.bridgeToken,
      hmacSecret: config.hmacSecret,
      onDeliver: deliver,
    });

    // selfId 决定群聊 @机器人 能否被识别（mentionsBot）：env 优先，否则问一次
    // OneBot 后端的 get_login_info。取不到只打 stderr 警告，不阻塞启动。
    const selfId = await resolveSelfId({
      transport,
      envSelfId: config.envSelfId,
      log,
    });

    sink = await createOneBotSink({
      port: config.incomingPort,
      path: DEFAULT_ONEBOT_PATH,
      token: config.incomingToken,
      selfId,
      onEvent: (inbound) => {
        // 立刻回 204 给 QQ 后端（10s 上行超时不应拖慢事件入口），失败只记 stderr。
        void hostClient.postEvents({ type: "inbound_message", message: inbound }).then((result) => {
          if (!result.ok) {
            log(`failed to forward inbound_message to host (status ${result.status})`);
          }
        });
      },
    });

    // 端口必须在两个 server 都 listen 完成后才读取（create*Server 内部已 await
    // listening 并回读 server.address()）。任一端口拿不到真实值就当场失败：
    // 上报 0 会让宿主不知道该往哪投递，整条回传链路静默断掉。
    if (!isListeningPort(sink.port) || !isListeningPort(delivery.port)) {
      throw new Error(
        `bridge failed to bind listening ports (incoming=${sink.port}, delivery=${delivery.port})`,
      );
    }
  } catch (error) {
    // 单实例契约：incoming 端口被占用即是「另一个 bridge 已在跑」，可识别地退出。
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE" && config.incomingPort !== 0) {
      log(
        `incoming port ${config.incomingPort} is already in use — another qq-bridge may be running (${errorMessage(error)})`,
      );
    } else {
      log(`startup failed: ${errorMessage(error)}`);
    }
    await sink?.close().catch(() => undefined);
    await delivery?.close().catch(() => undefined);
    process.exit(1);
  }

  const ready = await hostClient.postEvents(
    buildReadyPayload({
      incomingPort: sink.port,
      deliveryPort: delivery.port,
      pid: process.pid,
      startedAt,
    }),
  );
  if (!ready.ok) log(`failed to report bridge_ready to host (status ${ready.status})`);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    void Promise.all([
      sink.close().catch(() => undefined),
      delivery.close().catch(() => undefined),
    ]).then(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // stdin 关闭 = 上层管道结束（宿主关闭面板 / 进程被回收），立即收拾退出。
  // resume() 让 'end' 事件真的会被触发（只挂监听而不消费流不会收到 EOF）。
  try {
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));
    process.stdin.on("error", () => shutdown("stdin error"));
    process.stdin.resume();
  } catch {
    // stdin 不可用（例如被宿主接成 closed fd）时不阻塞启动。
  }
}

if (isDirectEntry()) {
  void main().catch((error: unknown) => {
    log(`fatal: ${errorMessage(error)}`);
    process.exit(1);
  });
}
