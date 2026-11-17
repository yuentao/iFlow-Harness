import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QrBridge,
  type QrBridgeDeps,
  type QrBridgeMessage,
} from "../src/qq/managed/qr-bridge.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";

const QR_PATH = "C:/tmp/go-cqhttp/qrcode.png";
const START_NOW = 1_700_000_000_000;

function enoent(): Error & { code: string } {
  const e = new Error("ENOENT") as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

/** 内存文件系统：可控 mtime / size，可注入 stat / readFile 错误。 */
class FakeFs implements NonNullable<QrBridgeDeps["fs"]> {
  file: { buffer: Buffer; mtimeMs: number; size: number } | null = null;
  statError: Error | null = null;
  readError: Error | null = null;
  readCalls = 0;

  async stat(_path: string): Promise<{ mtimeMs: number; size: number }> {
    if (this.statError) throw this.statError;
    if (!this.file) throw enoent();
    return { mtimeMs: this.file.mtimeMs, size: this.file.size };
  }

  async readFile(_path: string): Promise<Buffer> {
    this.readCalls += 1;
    if (this.readError) throw this.readError;
    if (!this.file) throw enoent();
    return this.file.buffer;
  }

  put(label: string, mtimeMs: number, size?: number): void {
    const buffer = Buffer.from(label, "utf8");
    this.file = { buffer, mtimeMs, size: size ?? buffer.length };
  }
}

function setup(pollMs = 1000) {
  const fs = new FakeFs();
  const pushed: QrBridgeMessage[] = [];
  const logs: string[] = [];
  let clock = START_NOW;
  const bridge = new QrBridge({
    qrPath: QR_PATH,
    fs,
    now: () => clock,
    log: (line) => logs.push(line),
  });
  bridge.start((m) => pushed.push(m), pollMs);
  return {
    fs,
    bridge,
    pushed,
    logs,
    now: () => clock,
    setNow: (n: number) => {
      clock = n;
    },
    tick: () => vi.advanceTimersByTimeAsync(pollMs),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("QrBridge 构造与绝对路经护栏", () => {
  it("拒绝相对路径，只接受宿主传入的绝对路径", () => {
    expect(() => new QrBridge({ qrPath: "relative/qr.png" })).toThrow(/绝对路径/);
    expect(
      () => new QrBridge({ qrPath: QR_PATH, fs: new FakeFs() }),
    ).not.toThrow();
  });
});

describe("QrBridge 轮询", () => {
  it("文件变化才推：首帧 + 指纹变化才产生新帧，expiresAt 用注入 now", async () => {
    const { fs, pushed, now } = setup();
    fs.put("qr-A", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ type: "qqLoginQr", phase: "waiting_scan" });
    expect(pushed[0]!.dataUrl).toBe(
      QR_DATA_URL_PREFIX + Buffer.from("qr-A").toString("base64"),
    );
    expect(pushed[0]!.expiresAt).toBe(now() + 3 * 60_000);

    fs.put("qr-B", 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]!.dataUrl).toBe(
      QR_DATA_URL_PREFIX + Buffer.from("qr-B").toString("base64"),
    );
  });

  it("首次文件不存在时不推空图，只等下一次", async () => {
    const { pushed } = setup();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pushed).toHaveLength(0);
  });

  it("文件消失时推一次 expired 清空 UI，且不重复推", async () => {
    const { fs, pushed } = setup();
    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);

    fs.file = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toMatchObject({ type: "qqLoginQr", phase: "expired", dataUrl: "" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(2);
  });

  it("非法内容（非 png base64）不推但记日志，后续合法内容仍可推", async () => {
    const { fs, pushed, logs } = setup();
    // 空 Buffer → base64 为空串 → isQrDataUrl 判假。
    fs.file = { buffer: Buffer.alloc(0), mtimeMs: 1000, size: 0 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(0);
    expect(logs.some((line) => line.includes("非法"))).toBe(true);

    fs.put("valid", 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);
  });

  it("同一指纹不重复读 / 不重复推", async () => {
    const { fs, pushed } = setup();
    fs.put("qr", 1000, 42);
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);
    expect(fs.readCalls).toBe(1);
  });

  it("refresh 强制清指纹，即使文件未变也重推", async () => {
    const { fs, bridge, pushed } = setup();
    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);

    bridge.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]!.dataUrl).toBe(pushed[0]!.dataUrl);
  });

  it("连续读错误满 3 次只推一次 error detail，且不含底层错误内容", async () => {
    const { fs, pushed } = setup();
    fs.statError = new Error("boom-secret");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    const errors = pushed.filter((m) => !!m.detail);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.detail).toContain(QR_PATH);
    expect(errors[0]!.detail).not.toContain("boom-secret");
  });

  it("stop 后不再推，且可重复调用", async () => {
    const { fs, bridge, pushed } = setup();
    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);

    bridge.stop();
    bridge.stop();
    fs.put("qr-new", 2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pushed).toHaveLength(1);
  });
});

describe("QrBridge 阶段重推与 current()", () => {
  it("markScanned / markConfirmed 复用最近成功帧的 dataUrl/expiresAt，不重新读文件", async () => {
    const { fs, bridge, pushed } = setup();
    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const first = pushed[0]!;
    const readsBefore = fs.readCalls;

    bridge.markScanned();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toMatchObject({
      phase: "scanned",
      dataUrl: first.dataUrl,
      expiresAt: first.expiresAt,
    });

    bridge.markConfirmed();
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toMatchObject({
      phase: "confirmed",
      dataUrl: first.dataUrl,
      expiresAt: first.expiresAt,
    });
    expect(fs.readCalls).toBe(readsBefore);
  });

  it("expired 帧（空 dataUrl）不会被 markScanned 误重推", async () => {
    const { fs, bridge, pushed } = setup();
    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    fs.file = null;
    await vi.advanceTimersByTimeAsync(1000);
    const count = pushed.length;
    bridge.markScanned();
    expect(pushed).toHaveLength(count);
  });

  it("current() 返回最近有效帧，非法内容不覆盖它", async () => {
    const { fs, bridge, pushed } = setup();
    expect(bridge.current()).toBeNull();

    fs.put("qr", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.current()).toEqual(pushed[0]);

    fs.file = { buffer: Buffer.alloc(0), mtimeMs: 2000, size: 0 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(1);
    expect(bridge.current()).toEqual(pushed[0]);
  });

  it("expiresAt 与 ttlMs 跟随注入值", async () => {
    const fs = new FakeFs();
    fs.put("qr", 1000);
    const pushed: QrBridgeMessage[] = [];
    const bridge = new QrBridge({
      qrPath: QR_PATH,
      fs,
      now: () => 500,
      ttlMs: 1234,
    });
    bridge.start((m) => pushed.push(m), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed[0]!.expiresAt).toBe(500 + 1234);
    bridge.stop();
  });
});
