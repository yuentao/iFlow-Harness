import { describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes as nodeRandomBytes } from "node:crypto";
import { QqBotBindSession } from "../src/qq/qqbot/bind.js";
import {
  BIND_STATUS_COMPLETED,
  BIND_STATUS_EXPIRED,
  CONNECT_URL_BASE,
  CREATE_BIND_TASK_URL,
  POLL_BIND_RESULT_URL,
  QqBotQrProtocol,
  buildConnectUrl,
  createBindTask,
  createNodeCrypto,
  decryptBotSecret,
  generateBindKey,
  pollBindResult,
  redactSecrets,
  type QqBotCrypto,
  type QqBotHttp,
  type QqBotQrProtocolOptions,
} from "../src/qq/qqbot/protocol-client.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";

const VALID_PNG = QR_DATA_URL_PREFIX + "iVBORw0KGgo=";
const NOW = 1_700_000_000_000;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type PostCall = { url: string; body: unknown; timeoutMs: number };

function makeHttp(handler: (url: string, body: any) => unknown): {
  http: QqBotHttp;
  calls: PostCall[];
} {
  const calls: PostCall[] = [];
  const http: QqBotHttp = {
    async post(url, body, timeoutMs) {
      calls.push({ url, body, timeoutMs });
      return handler(url, body);
    },
  };
  return { http, calls };
}

/** 用已知 key 造一段 AES-256-GCM 的 IV12|CT|TAG16 密文（base64）。 */
function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = Buffer.alloc(12, 0x11);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

/** 真 crypto 但记录每次生成的 key（过期刷新会生成第 2 把）。 */
function makeCapturingCrypto(): { crypto: QqBotCrypto; keys: Buffer[] } {
  const keys: Buffer[] = [];
  const node = createNodeCrypto();
  const crypto: QqBotCrypto = {
    randomBytes: (n) => {
      const buf = nodeRandomBytes(n);
      keys.push(Buffer.from(buf));
      return buf;
    },
    decipherGcm: node.decipherGcm,
  };
  return { crypto, keys };
}

function makeCallbacks() {
  return { onQr: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() };
}

function makeOptions(over: Partial<QqBotQrProtocolOptions> & Pick<QqBotQrProtocolOptions, "http" | "crypto" | "renderQr">): QqBotQrProtocolOptions {
  return {
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => NOW,
    qrTtlMs: 60_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 纯函数 / 载荷
// ---------------------------------------------------------------------------

describe("QQBot 扫码协议 / createBindTask", () => {
  it("向 create_bind_task 发送 {key} 并解析 task_id", async () => {
    const { http, calls } = makeHttp((url) => {
      expect(url).toBe(CREATE_BIND_TASK_URL);
      return { retcode: 0, data: { task_id: "task-abc" } };
    });
    await expect(createBindTask(http, "key-xyz")).resolves.toEqual({ taskId: "task-abc" });
    expect(calls[0]!.body).toEqual({ key: "key-xyz" });
    expect(calls[0]!.timeoutMs).toBe(10_000);
  });

  it("retcode 非 0 抛带 msg 的错", async () => {
    const { http } = makeHttp(() => ({ retcode: 12345, msg: "invalid key" }));
    await expect(createBindTask(http, "k")).rejects.toThrow("invalid key");
  });

  it("缺 task_id 抛错", async () => {
    const { http } = makeHttp(() => ({ retcode: 0, data: {} }));
    await expect(createBindTask(http, "k")).rejects.toThrow("task_id");
  });
});

describe("QQBot 扫码协议 / pollBindResult", () => {
  it("向 poll_bind_result 发送 {task_id} 并解析全部字段", async () => {
    const { http, calls } = makeHttp((url) => {
      expect(url).toBe(POLL_BIND_RESULT_URL);
      return {
        retcode: 0,
        data: {
          status: BIND_STATUS_COMPLETED,
          bot_appid: 123456,
          bot_encrypt_secret: "enc-secret",
          user_openid: "open-1",
        },
      };
    });
    await expect(pollBindResult(http, "task-1")).resolves.toEqual({
      status: BIND_STATUS_COMPLETED,
      botAppId: "123456",
      botEncryptSecret: "enc-secret",
      userOpenid: "open-1",
    });
    expect(calls[0]!.body).toEqual({ task_id: "task-1" });
  });

  it("retcode 非 0 抛带 msg 的错；缺 status 抛错", async () => {
    const bad = makeHttp(() => ({ retcode: 9, message: "expired session" }));
    await expect(pollBindResult(bad.http, "t")).rejects.toThrow("expired session");

    const missing = makeHttp(() => ({ retcode: 0, data: {} }));
    await expect(pollBindResult(missing.http, "t")).rejects.toThrow("status");
  });
});

describe("QQBot 扫码协议 / 加解密与 URL", () => {
  it("generateBindKey 生成 32 字节 base64", () => {
    const crypto: QqBotCrypto = {
      randomBytes: vi.fn((n: number) => Buffer.alloc(n, 7)),
      decipherGcm: vi.fn(),
    };
    expect(generateBindKey(crypto)).toBe(Buffer.alloc(32, 7).toString("base64"));
    expect(crypto.randomBytes).toHaveBeenCalledWith(32);
  });

  it("decryptBotSecret 用已知向量还原 IV12|CT|TAG16 密文", () => {
    const key = Buffer.alloc(32, 0x2a);
    const plaintext = "super-secret-app-key";
    const blob = encryptSecret(plaintext, key);
    expect(decryptBotSecret(createNodeCrypto(), blob, key.toString("base64"))).toBe(plaintext);
  });

  it("decryptBotSecret 用注入 crypto 也能还原（走同一 IV|CT|TAG 布局）", () => {
    const key = Buffer.alloc(32, 5);
    const blob = encryptSecret("injected-secret", key);
    const crypto = createNodeCrypto();
    const decipherGcm = vi.fn(crypto.decipherGcm);
    expect(decryptBotSecret({ randomBytes: nodeRandomBytes, decipherGcm }, blob, key.toString("base64"))).toBe(
      "injected-secret",
    );
    const blobBuf = Buffer.from(blob, "base64");
    expect(decipherGcm).toHaveBeenCalledWith(key, blobBuf);
  });

  it("buildConnectUrl 对 task_id / source 做 URL 编码并带 _wv=2", () => {
    expect(buildConnectUrl("a b/c", "src&x")).toBe(
      `${CONNECT_URL_BASE}?task_id=a%20b%2Fc&source=src%26x&_wv=2`,
    );
    expect(buildConnectUrl("t-1")).toContain("source=iflow-harness");
  });

  it("retcode 错误文案里的 secret 被脱敏", async () => {
    const { http } = makeHttp(() => ({ retcode: 500, msg: "appSecret=SHOULD_REDACT_123" }));
    try {
      await createBindTask(http, "k");
      throw new Error("should have thrown");
    } catch (err) {
      const text = String(err);
      expect(text).toContain("<redacted>");
      expect(text).not.toContain("SHOULD_REDACT_123");
    }
    expect(redactSecrets('{"app_secret":"JSON_SECRET_456"}')).not.toContain("JSON_SECRET_456");
  });
});

// ---------------------------------------------------------------------------
// 编排器全流程
// ---------------------------------------------------------------------------

describe("QqBotQrProtocol / 全流程", () => {
  it("create → onQr → PENDING → COMPLETED → onSuccess", async () => {
    const { crypto, keys } = makeCapturingCrypto();
    let pollCount = 0;
    const { http, calls } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) return { retcode: 0, data: { task_id: "t-1" } };
      pollCount += 1;
      if (pollCount === 1) return { retcode: 0, data: { status: 0 } };
      return {
        retcode: 0,
        data: {
          status: BIND_STATUS_COMPLETED,
          bot_appid: "app-1",
          bot_encrypt_secret: encryptSecret("APP_SECRET_1", keys[keys.length - 1]!),
          user_openid: "open-1",
        },
      };
    });
    const renderQr = vi.fn(async (url: string) => {
      expect(url).toContain("task_id=t-1");
      return VALID_PNG;
    });
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr, source: "test-source" }),
    );
    const cbs = makeCallbacks();

    await protocol.start(cbs);
    await flush();
    await flush();

    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, NOW + 60_000);
    expect(cbs.onSuccess).toHaveBeenCalledWith({
      appId: "app-1",
      appSecret: "APP_SECRET_1",
      userOpenid: "open-1",
    });
    expect(cbs.onFailure).not.toHaveBeenCalled();
    expect(renderQr).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === CREATE_BIND_TASK_URL)).toHaveLength(1);
  });

  it("status 3 过期后用新 key 重建任务并刷新二维码，凭据用新 key 解密", async () => {
    const { crypto, keys } = makeCapturingCrypto();
    let createCount = 0;
    let pollCount = 0;
    const { http } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) {
        createCount += 1;
        return { retcode: 0, data: { task_id: `t-${createCount}` } };
      }
      pollCount += 1;
      if (pollCount === 1) return { retcode: 0, data: { status: BIND_STATUS_EXPIRED } };
      return {
        retcode: 0,
        data: {
          status: BIND_STATUS_COMPLETED,
          bot_appid: "app-2",
          bot_encrypt_secret: encryptSecret("APP_SECRET_2", keys[keys.length - 1]!),
        },
      };
    });
    const renderQr = vi.fn(async () => VALID_PNG);
    const protocol = new QqBotQrProtocol(makeOptions({ http, crypto, renderQr }));
    const cbs = makeCallbacks();

    await protocol.start(cbs);
    await flush();
    await flush();

    expect(createCount).toBe(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(cbs.onQr).toHaveBeenCalledTimes(2);
    // 若刷新后仍用旧 key 解密会抛错 → 走 onFailure；这里应成功，证明用了新 key。
    expect(cbs.onSuccess).toHaveBeenCalledWith({ appId: "app-2", appSecret: "APP_SECRET_2" });
    expect(cbs.onFailure).not.toHaveBeenCalled();
  });

  it("连续失败达到上限后 onFailure 并停止", async () => {
    const { crypto } = makeCapturingCrypto();
    const { http } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) return { retcode: 0, data: { task_id: "t" } };
      throw new Error("poll exploded");
    });
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr: async () => VALID_PNG, maxFailures: 3 }),
    );
    const cbs = makeCallbacks();

    await protocol.start(cbs);
    await flush();

    expect(cbs.onFailure).toHaveBeenCalledTimes(1);
    expect(cbs.onFailure).toHaveBeenCalledWith("poll exploded");
    expect(cbs.onSuccess).not.toHaveBeenCalled();
  });

  it("stop 幂等：多次调用只记一次 stop，且不再轮询 / 不再回调", async () => {
    const { crypto } = makeCapturingCrypto();
    let pollCount = 0;
    const { http } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) return { retcode: 0, data: { task_id: "t" } };
      pollCount += 1;
      return { retcode: 0, data: { status: 0 } };
    });
    const log = vi.fn();
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr: async () => VALID_PNG, log }),
    );
    const cbs = makeCallbacks();

    const stop = await protocol.start(cbs);
    stop();
    stop();
    protocol.stop();
    await flush();
    const before = pollCount;
    await flush();
    await flush();

    expect(pollCount).toBe(before);
    expect(cbs.onFailure).not.toHaveBeenCalled();
    expect(cbs.onSuccess).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => c[0] === "stop")).toHaveLength(1);
  });

  it("renderQr 返回非法 dataUrl 时不回调 onQr，仅记录 qrInvalid", async () => {
    const { crypto } = makeCapturingCrypto();
    const { http } = makeHttp((url) =>
      url === CREATE_BIND_TASK_URL
        ? { retcode: 0, data: { task_id: "t" } }
        : { retcode: 0, data: { status: 0 } },
    );
    const log = vi.fn();
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr: async () => "javascript:alert(1)", log }),
    );
    const cbs = makeCallbacks();

    const stop = await protocol.start(cbs);
    expect(cbs.onQr).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("qrInvalid");
    stop();
  });

  it("appSecret 不进日志，失败文案也不泄漏 secret", async () => {
    const { crypto, keys } = makeCapturingCrypto();
    const SECRET = "TOP_SECRET_VALUE_999";
    const { http } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) return { retcode: 0, data: { task_id: "t" } };
      return {
        retcode: 0,
        data: {
          status: BIND_STATUS_COMPLETED,
          bot_appid: "app",
          bot_encrypt_secret: encryptSecret(SECRET, keys[keys.length - 1]!),
        },
      };
    });
    const log = vi.fn();
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr: async () => VALID_PNG, log }),
    );
    const cbs = makeCallbacks();

    await protocol.start(cbs);
    await flush();

    expect(cbs.onSuccess).toHaveBeenCalled();
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
    expect(JSON.stringify(cbs.onSuccess.mock.calls)).toContain(SECRET); // 只经 onSuccess 传出
  });

  it("create 阶段失败时 onFailure 且不启动轮询", async () => {
    const { crypto } = makeCapturingCrypto();
    const { http } = makeHttp((url) => {
      if (url === CREATE_BIND_TASK_URL) return { retcode: 400, msg: "bad request" };
      return { retcode: 0, data: { status: 0 } };
    });
    const protocol = new QqBotQrProtocol(
      makeOptions({ http, crypto, renderQr: async () => VALID_PNG }),
    );
    const cbs = makeCallbacks();

    await protocol.start(cbs);
    await flush();

    expect(cbs.onQr).not.toHaveBeenCalled();
    expect(cbs.onFailure).toHaveBeenCalledWith(expect.stringContaining("bad request"));
    expect(cbs.onSuccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bind.ts 接线（M3-A 协议优先，M1 startQrConnect 兼容）
// ---------------------------------------------------------------------------

type BindProtoCbs = Parameters<
  NonNullable<ConstructorParameters<typeof QqBotBindSession>[0]["protocol"]>["start"]
>[0];

function makeBindCallbacks() {
  return { onQr: vi.fn(), onProgress: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() };
}

function makeFakeProtocol() {
  const stop = vi.fn();
  const holder: { cbs?: BindProtoCbs } = {};
  const start = vi.fn(async (cbs: BindProtoCbs) => {
    holder.cbs = cbs;
    return stop;
  });
  return { protocol: { start }, stop, start, holder };
}

describe("QqBotBindSession / M3-A 协议接线", () => {
  it("注入 protocol 时优先走协议，startQrConnect 不被调用，回调正确转发", async () => {
    const fake = makeFakeProtocol();
    const startQrConnect = vi.fn();
    const session = new QqBotBindSession({
      startQrConnect,
      renderQr: async () => VALID_PNG,
      protocol: fake.protocol,
    });
    const cbs = makeBindCallbacks();

    await session.start(cbs);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(startQrConnect).not.toHaveBeenCalled();

    fake.holder.cbs!.onQr(VALID_PNG, NOW + 123);
    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, NOW + 123);
    expect(cbs.onProgress).toHaveBeenCalledWith("waiting_scan");

    fake.holder.cbs!.onSuccess({ appId: "a", appSecret: "s" });
    expect(cbs.onSuccess).toHaveBeenCalledWith({ appId: "a", appSecret: "s" });
  });

  it("protocol 路径的失败文案脱敏，stop 幂等并传播到协议", async () => {
    const fake = makeFakeProtocol();
    const log = vi.fn();
    const session = new QqBotBindSession({
      startQrConnect: vi.fn(),
      renderQr: async () => VALID_PNG,
      protocol: fake.protocol,
      log,
    });
    const cbs = makeBindCallbacks();

    await session.start(cbs);
    fake.holder.cbs!.onFailure("appSecret=LEAK_ME bad");
    const failure = vi.mocked(cbs.onFailure).mock.calls[0]![0];
    expect(failure).toContain("<redacted>");
    expect(failure).not.toContain("LEAK_ME");

    session.stop();
    session.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter((c) => c[0] === "stop")).toHaveLength(1);
  });
});
