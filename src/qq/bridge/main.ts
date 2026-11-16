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

import { chunkQqText } from "../../../shared/qq-task.js";
import { buildReplyPayload, buildSendGroupMsg, buildSendPrivateMsg } from "../adapter/onebot.js";
import type { ChatType } from "../adapter/types.js";
import { HttpOneBotTransport } from "../adapter/http-transport.js";
import { createDeliveryServer, type DeliveryMessage, type DeliveryServer } from "./delivery-server.js";
import { createHostClient } from "./host-client.js";
import { DEFAULT_ONEBOT_PATH, createOneBotSink, type OneBotSink } from "./onebot-sink.js";

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

interface BridgeConfig {
  hostPort: number;
  bridgeToken: string;
  hmacSecret: string;
  incomingPort: number;
  incomingToken: string;
  onebotUrl?: string;
  onebotToken?: string;
  selfId: string;
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
    selfId: readEnv("IFLOW_QQ_SELF_ID") ?? "",
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

    sink = await createOneBotSink({
      port: config.incomingPort,
      path: DEFAULT_ONEBOT_PATH,
      token: config.incomingToken,
      selfId: config.selfId,
      onEvent: (inbound) => {
        // 立刻回 204 给 QQ 后端（10s 上行超时不应拖慢事件入口），失败只记 stderr。
        void hostClient.postEvents({ type: "inbound_message", message: inbound }).then((result) => {
          if (!result.ok) {
            log(`failed to forward inbound_message to host (status ${result.status})`);
          }
        });
      },
    });
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

  const ready = await hostClient.postEvents({
    type: "bridge_ready",
    incomingPort: sink.port,
    pid: process.pid,
    startedAt,
  });
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

void main().catch((error: unknown) => {
  log(`fatal: ${errorMessage(error)}`);
  process.exit(1);
});
