/**
 * QQ bridge 跨进程端到端（Wave4 验收）。
 *
 * 验证的是**真实进程**：spawn 构建产物，让它对着一台假 OneBot 后端与一台假
 * 宿主 IPC 跑完整个回路：
 *
 *   假 OneBot（get_login_info / send_private_msg）
 *      ↑ get_login_info            ↓ send_private_msg（投递）
 *   bridge 进程 ── inbound POST /onebot/event ──┐
 *      └── POST /v1/events（签名）──→ 假宿主 IPC（用真实的 createQqIpcServer 验签）
 *
 * 不连真 QQ、不碰 SecretStorage：token / HMAC 都是本文件里的常量。
 *
 * 关于假 OneBot 的请求形态：`src/qq/adapter/http-transport.ts` 把 action 放在
 * **请求体**（`{ action, params }`）里、POST 到 baseUrl 的根路径，这是 OneBot v11
 * 的通用 HTTP 形态。因此假后端按 body.action 分发（同时兼容把 action 写在路径上
 * 的后端），而不是按 `/get_login_info` 这种路径分发。
 *
 * 构建纪律：dist/ 被 gitignore，全新 checkout 里没有 `dist/qq-bridge.cjs`。
 * 本文件在 beforeAll 里用仓库自带的 esbuild（devDependency）现场构建，
 * **选项逐字复刻 esbuild.mjs 的 qq-bridge 入口**（含 `import.meta.url` 的
 * define + banner）——e2e 要验的就是随 VSIX 发布、面板 spawn 的那份产物，
 * 用不同选项构建等于验另一个东西。构建失败直接让用例失败，**没有 skip 分支**。
 *
 * 三个用例的分工（见各自注释）：
 *  1. `dist/qq-bridge.cjs` —— **真正随 VSIX 发布、面板 spawn 的那个产物**；
 *     完整回路必须通过（历史 P0：CJS 里 import.meta 被编译成 {}，入口自识别
 *     恒为 false，进程静默退出 0）；
 *  2. 回归探针：同一产物在**没有任何 IFLOW_QQ_*** 的环境下必须 exit 1 且
 *     stderr 报 `missing required environment variable` —— 静默退出 0 即回归；
 *  3. `dist/qq-bridge.esm.mjs`（esbuild 的 ESM 产物）—— 仅作对照：同一份源码
 *     换一种模块格式编译，覆盖 `import.meta.url` 判定分支，用来把「逻辑坏了」
 *     与「打包坏了」区分开。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridgeDeliveryClient, type BridgeDeliveryClient } from "../src/qq/bridge-client.js";
import { createQqIpcServer, type QqIpcServer } from "../src/qq/ipc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
/** 随 VSIX 发布的 bridge 产物（panel 实际 spawn 的路径）。 */
const bridgeBundle = path.join(repoRoot, "dist", "qq-bridge.cjs");
/** 同源码的 ESM 产物（esbuild 现场构建）；仅作对照。 */
const bridgeEsmEntry = path.join(repoRoot, "dist", "qq-bridge.esm.mjs");

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 机器人自身 QQ 号：假 OneBot 的 get_login_info 返回它，bridge 用它判定 @。 */
const BOT_ID = "12345";
/** 群消息的发送者 / 群号。 */
const SENDER_ID = "66666";
const GROUP_ID = "88888";

const BRIDGE_TOKEN = "e2e-bridge-token";
const HMAC_SECRET = "e2e-hmac-secret";
const INCOMING_TOKEN = "e2e-incoming-token";
const ONEBOT_TOKEN = "e2e-onebot-token";

const E2E_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 现场构建产物（选项与 esbuild.mjs 的 qq-bridge 入口保持一致）
// ---------------------------------------------------------------------------

/**
 * 构建 bridge 产物。
 *
 * 选项必须与 `esbuild.mjs` 里 qq-bridge 的构建逐字一致：CJS 产物要靠
 * `import.meta.url` 的 define + banner 才能自识别为入口（否则 P0 复发）。
 * esbuild 0.28 不接受调用表达式作 define 值，所以 define 指向一个全局标识符、
 * banner 给它赋真实 URL——这与 esbuild.mjs 是同一套写法，改一处必须同步另一处。
 */
async function buildBridge(outfile: string, format: "cjs" | "esm"): Promise<void> {
  const isCjs = format === "cjs";
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "src", "qq", "bridge", "main.ts")],
    bundle: true,
    outfile,
    format,
    platform: "node",
    target: "node20",
    minify: true,
    keepNames: true,
    sourcemap: true,
    ...(isCjs
      ? {
          define: { "import.meta.url": "globalThis.__iflowBridgeEntryUrl" },
          banner: {
            js: 'globalThis.__iflowBridgeEntryUrl = require("url").pathToFileURL(__filename).href;',
          },
        }
      : {}),
    logLevel: "silent",
  });
  if (!existsSync(outfile) || statSync(outfile).size === 0) {
    throw new Error(`esbuild reported success but ${outfile} is missing/empty`);
  }
}

// ---------------------------------------------------------------------------
// 假 OneBot 后端（HTTP API 侧）
// ---------------------------------------------------------------------------

interface RecordedAction {
  action: string;
  params: Record<string, unknown>;
}

interface FakeOneBot {
  port: number;
  actions: RecordedAction[];
  close(): Promise<void>;
}

function startFakeOneBot(): Promise<FakeOneBot> {
  const actions: RecordedAction[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(text),
        });
        res.end(text);
      };

      if (req.method !== "POST") {
        send(404, { status: "failed", retcode: 1404, data: null });
        return;
      }

      let body: unknown = null;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw.trim().length > 0 ? (JSON.parse(raw) as unknown) : null;
      } catch {
        send(400, { status: "failed", retcode: 1400, data: null });
        return;
      }

      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const urlPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const fromPath = urlPath.replace(/^\//u, "");
      const action =
        typeof record["action"] === "string" && record["action"].length > 0
          ? (record["action"] as string)
          : fromPath;

      if (action === "get_login_info") {
        send(200, {
          status: "ok",
          retcode: 0,
          data: { user_id: Number(BOT_ID), nickname: "e2e-bot" },
        });
        return;
      }
      if (action === "send_private_msg" || action === "send_group_msg") {
        const params =
          record["params"] && typeof record["params"] === "object"
            ? (record["params"] as Record<string, unknown>)
            : {};
        actions.push({ action, params });
        send(200, { status: "ok", retcode: 0, data: { message_id: 1 } });
        return;
      }

      // 其余 action / 路径一律 404（与任务约定的「其余路径 404」一致）。
      send(404, { status: "failed", retcode: 1404, data: null });
    });
    req.on("error", () => {
      try {
        res.destroy();
      } catch {
        // 连接已断，忽略。
      }
    });
  });

  return new Promise<FakeOneBot>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        actions,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface PostResult {
  status: number;
  body: string;
}

/** 向 bridge 的 OneBot 事件入口 POST 一条事件。 */
function postEvent(port: number, token: string, payload: unknown): Promise<PostResult> {
  const body = JSON.stringify(payload);
  return new Promise<PostResult>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/onebot/event",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// 组内共享状态
// ---------------------------------------------------------------------------

let fakeOneBot: FakeOneBot | undefined;
let host: QqIpcServer | undefined;
const hostEvents: unknown[] = [];

interface BridgeReadyEvent {
  type: "bridge_ready";
  incomingPort: number;
  deliveryPort: number;
  pid: number;
  startedAt: number;
}

function findReady(): BridgeReadyEvent | undefined {
  for (const event of hostEvents) {
    if (isRecord(event) && event["type"] === "bridge_ready") {
      return event as unknown as BridgeReadyEvent;
    }
  }
  return undefined;
}

interface RunningBridge {
  child: ChildProcess;
  readonly exited: boolean;
  stderr(): string;
  stop(): Promise<void>;
}

/** spawn 一个 bridge 入口，stderr 收集到字符串里（失败时输出）。 */
function startBridge(entry: string): RunningBridge {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 让 bridge 走 get_login_info（而不是 env 快路径），这样才能覆盖假 OneBot 的
  // 登录信息查询；残留的父进程值会让本用例悄悄变成「不查后端」。
  delete env["IFLOW_QQ_SELF_ID"];
  Object.assign(env, {
    IFLOW_QQ_HOST_PORT: String(host!.port),
    IFLOW_QQ_BRIDGE_TOKEN: BRIDGE_TOKEN,
    IFLOW_QQ_HMAC_SECRET: HMAC_SECRET,
    IFLOW_QQ_INCOMING_PORT: "0",
    IFLOW_QQ_INCOMING_TOKEN: INCOMING_TOKEN,
    IFLOW_QQ_ONEBOT_URL: `http://127.0.0.1:${fakeOneBot!.port}`,
    IFLOW_QQ_ONEBOT_TOKEN: ONEBOT_TOKEN,
  });

  const child = spawn(process.execPath, [entry], {
    env,
    windowsHide: true,
    // stdin 必须保持为打开的 pipe：bridge 把 EOF 当作「上层进程结束」的退出信号。
    stdio: ["pipe", "ignore", "pipe"],
  });

  let stderrText = "";
  let exited = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  child.on("exit", () => {
    exited = true;
  });
  // 未消费的 stdin 不写也不关；显式保留错误处理避免未捕获的 EPIPE。
  child.stdin?.on("error", () => undefined);

  return {
    child,
    get exited() {
      return exited || child.exitCode !== null;
    },
    stderr: () => stderrText,
    async stop() {
      if (child.exitCode !== null) return;
      const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        child.kill();
      } catch {
        // 可能已经退出。
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 忽略。
        }
      }, 3_000);
      await Promise.race([done, sleep(5_000)]);
      clearTimeout(timer);
    },
  };
}

/** 应用到两个用例的完整断言流程；返回 void，失败即抛。 */
async function runRoundTrip(entry: string): Promise<void> {
  hostEvents.length = 0;
  fakeOneBot!.actions.length = 0;

  const bridge = startBridge(entry);
  let delivery: BridgeDeliveryClient | undefined;
  try {
    // 5) bridge_ready：端口必须来自 listen 之后的真实值。
    const ready = await waitForReady(bridge);
    expect(Number.isInteger(ready.incomingPort)).toBe(true);
    expect(Number.isInteger(ready.deliveryPort)).toBe(true);
    expect(ready.incomingPort).toBeGreaterThan(0);
    expect(ready.deliveryPort).toBeGreaterThan(0);

    // 6) 入站群消息（CQ 字符串 + @机器人）→ 假宿主收到 inbound_message
    const inbound = {
      post_type: "message",
      message_type: "group",
      group_id: Number(GROUP_ID),
      user_id: Number(SENDER_ID),
      message_id: 4242,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: Number(SENDER_ID) },
      message: `[CQ:at,qq=${BOT_ID}] 检查一下构建产物`,
    };
    const posted = await postEvent(ready.incomingPort, INCOMING_TOKEN, inbound);
    expect(posted.status).toBe(204);

    await waitFor(
      () =>
        hostEvents.some((event) => isRecord(event) && event["type"] === "inbound_message"),
      "inbound_message",
      bridge,
    );

    const forwarded = hostEvents.find(
      (event) => isRecord(event) && event["type"] === "inbound_message",
    ) as { message: Record<string, unknown> };
    expect(forwarded.message["chatType"]).toBe("group");
    expect(forwarded.message["chatId"]).toBe(GROUP_ID);
    expect(forwarded.message["senderId"]).toBe(SENDER_ID);
    // selfId 来自假 OneBot 的 get_login_info，所以 @ 必须命中。
    expect(forwarded.message["mentionsBot"]).toBe(true);
    // CQ 码被剥离后的正文；不剥也算可接受，只要能读到原文即可。
    expect(String(forwarded.message["text"] ?? "")).toContain("检查一下构建产物");

    // 7) 宿主 → bridge 投递 → 假 OneBot 收到 send_private_msg
    delivery = createBridgeDeliveryClient({
      port: ready.deliveryPort,
      token: BRIDGE_TOKEN,
      hmacSecret: HMAC_SECRET,
    });
    const outboundText = `e2e 投递回执 ${Date.now()}`;
    const result = await delivery.deliver({
      chatType: "private",
      chatId: SENDER_ID,
      text: outboundText,
    });
    expect(result).toEqual({ ok: true, status: 204 });

    await waitFor(
      () =>
        fakeOneBot!.actions.some(
          (action) =>
            action.action === "send_private_msg" &&
            typeof action.params["message"] === "string" &&
            String(action.params["message"]).includes(outboundText),
        ),
      "send_private_msg",
      bridge,
    );

    const sent = fakeOneBot!.actions.find((action) => action.action === "send_private_msg")!;
    expect(String(sent.params["user_id"])).toBe(SENDER_ID);
    expect(String(sent.params["message"])).toContain(outboundText);
  } finally {
    delivery?.close();
    await bridge.stop();
  }
}

async function waitForReady(bridge: RunningBridge): Promise<BridgeReadyEvent> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = findReady();
    if (ready) return ready;
    if (bridge.exited) {
      throw new Error(
        `bridge 在上报 bridge_ready 之前就退出了（code=${String(bridge.child.exitCode)}）` +
          stderrSection(bridge),
      );
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${READY_TIMEOUT_MS}ms waiting for bridge_ready${stderrSection(bridge)}`);
}

async function waitFor(predicate: () => boolean, label: string, bridge: RunningBridge): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (bridge.exited) {
      throw new Error(
        `bridge 在 ${label} 到达前退出（code=${String(bridge.child.exitCode)}）${stderrSection(bridge)}`,
      );
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${READY_TIMEOUT_MS}ms waiting for ${label}${stderrSection(bridge)}`);
}

function stderrSection(bridge: RunningBridge): string {
  const detail = bridge.stderr().trim();
  return detail ? `\n--- bridge stderr ---\n${detail}` : "\n--- bridge stderr: (empty) ---";
}

// ---------------------------------------------------------------------------
// 入口自识别探针：CJS bundle 是否认得「我就是入口」
// ---------------------------------------------------------------------------

interface EntryProbe {
  /** 进程退出码；被超时强杀时为 null。 */
  code: number | null;
  stderr: string;
}

/**
 * 用一个「缺必需 env」的进程探 bridge 的 direct-entry 分支。
 *
 * `src/qq/bridge/main.ts` 的 `isDirectEntry()` 识别成功时 `readConfig()` 立即抛
 * `missing required environment variable IFLOW_QQ_HOST_PORT`（stderr + 退出码 1）；
 * 识别失败时整个 main() 不执行，进程静默退出 0、stderr 为空。于是这条探针能
 * 确定地判断产物是否可运行，且不受 minify 改名影响。
 */
function probeEntry(entry: string): Promise<EntryProbe> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("IFLOW_QQ_")) delete env[key];
  }

  return new Promise<EntryProbe>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 忽略。
      }
    }, 5_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 构建失败即抛：本组是硬性验收，没有 skip 分支。
  await buildBridge(bridgeBundle, "cjs");
  await buildBridge(bridgeEsmEntry, "esm");

  fakeOneBot = await startFakeOneBot();
  host = await createQqIpcServer({
    port: 0,
    token: BRIDGE_TOKEN,
    hmacSecret: HMAC_SECRET,
    handlers: {
      onEvents: async (body) => {
        hostEvents.push(body);
        return { ok: true };
      },
      onDeliver: async () => ({ ok: true }),
      onTaskAction: async () => ({ ok: true }),
      onHealth: async () => ({ ok: true }),
    },
  });
}, E2E_TIMEOUT_MS);

afterAll(async () => {
  if (host) {
    await host.close().catch(() => undefined);
    host = undefined;
  }
  if (fakeOneBot) {
    await fakeOneBot.close().catch(() => undefined);
    fakeOneBot = undefined;
  }
}, 15_000);

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("QQ bridge 跨进程 e2e", () => {
  it(
    "dist/qq-bridge.cjs（随 VSIX 发布的面板 spawn 产物）：启动上报端口 → 入站上行 → 投递发出",
    async () => {
      await runRoundTrip(bridgeBundle);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "回归：dist/qq-bridge.cjs 在没有任何 IFLOW_QQ_* 的环境下必须报错退出，而不是静默退出 0",
    async () => {
      const probe = await probeEntry(bridgeBundle);
      // 历史 P0：CJS 产物里 import.meta 被 esbuild 编译成 {}，入口自识别恒为
      // false，main() 不执行 → 退出码 0 且 stderr 为空。这里把那条症状钉死。
      expect(
        probe.code,
        `dist/qq-bridge.cjs 静默退出（code=${String(probe.code)}，stderr=${JSON.stringify(probe.stderr.trim().slice(0, 400))}）：isDirectEntry() 未能识别入口`,
      ).toBe(1);
      expect(probe.stderr).toContain("missing required environment variable");
    },
    15_000,
  );

  it(
    "对照组：同一份源码的 ESM 产物（import.meta 判定分支）走同一回路",
    async () => {
      await runRoundTrip(bridgeEsmEntry);
    },
    E2E_TIMEOUT_MS,
  );
});