import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, NdjsonParser } from "../src/acp/jsonrpc.js";

const FRAME_LIMIT = 8 * 1024 * 1024;

function inboundFrame(method: string, id: number, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("M4 - inbound reply write failure fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears inbound tracking after a successful reply", async () => {
    const lines: string[] = [];
    const peer = new JsonRpcPeer((line) => lines.push(line));
    peer.onRequest("request_permission", () => ({ outcome: "approved" }));
    expect(peer.pendingInboundCount).toBe(0);

    peer.handleData(inboundFrame("request_permission", 1));
    await tick();

    expect(peer.pendingInboundCount).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { outcome: "approved" } });
  });

  it("tracks the inbound request while the async handler is still pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const peer = new JsonRpcPeer(() => {});
    peer.onRequest("user_questions", () => gate);

    peer.handleData(inboundFrame("user_questions", 2));
    expect(peer.pendingInboundCount).toBe(1);

    release({ answers: {} });
    await tick();
    expect(peer.pendingInboundCount).toBe(0);
  });

  it("leaves no dangling inbound request and rejects pending outbound when the reply write throws", async () => {
    // Regression for the hang: host dismisses the approval card, reply never
    // reaches the CLI, and the in-flight prompt used to stay pending forever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failWrites = false;
    const peer = new JsonRpcPeer((line) => {
      if (failWrites) throw new Error("stdin destroyed");
      void line;
    });
    const prompt = peer.request("prompt", {}, 0); // prompt default: no timeout
    void prompt.catch(() => {}); // pre-attach so no unhandledRejection before assertion
    peer.onRequest("request_permission", () => ({ outcome: "approved" }));

    failWrites = true;
    peer.handleData(inboundFrame("request_permission", 3));
    await tick();

    expect(peer.pendingInboundCount).toBe(0);
    expect(peer.pendingRequestCount).toBe(0);
    await expect(prompt).rejects.toMatchObject({
      message: expect.stringContaining("Failed to reply"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reply to request request_permission"),
    );
  });

  it("applies the same fallback when a MethodNotFound reply cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const peer = new JsonRpcPeer(() => {
      throw new Error("stdin destroyed");
    });

    peer.handleData(inboundFrame("unknown_method", 4));
    await tick();

    expect(peer.pendingInboundCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reply to request unknown_method"),
    );
  });

  it("rejectAll clears inbound tracking too (process exit / teardown)", () => {
    const peer = new JsonRpcPeer(() => {});
    peer.onRequest("slow", () => new Promise(() => {}));
    peer.handleData(inboundFrame("slow", 5));
    expect(peer.pendingInboundCount).toBe(1);

    peer.rejectAll("closed");
    expect(peer.pendingInboundCount).toBe(0);
  });
});

describe("M7 - complete-line NDJSON frame ceiling", () => {
  it("drops a >8MB line that HAS a trailing newline, reports via onError, and keeps parsing", () => {
    const messages: unknown[] = [];
    const errors: Array<{ message: string; raw: string }> = [];
    const parser = new NdjsonParser(
      (value) => messages.push(value),
      (error, raw) => errors.push({ message: error.message, raw }),
    );
    const huge = JSON.stringify({ a: "y".repeat(FRAME_LIMIT + 1) });

    parser.feed(`${huge}\n{"ok":1}\n`);

    expect(messages).toEqual([{ ok: 1 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("exceeds");
    expect(errors[0]!.raw.length).toBeLessThanOrEqual(200);
  });

  it("still accepts a large complete line under the ceiling", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((value) => messages.push(value));
    const payload = { a: "z".repeat(FRAME_LIMIT - 64) };

    parser.feed(`${JSON.stringify(payload)}\n`);
    expect(messages).toEqual([payload]);
  });

  it("measures UTF-8 bytes, not UTF-16 code units", () => {
    // 5M two-byte chars ≈ 10MB on the wire: over the ceiling even though
    // line.length (~5M) would pass a naive character-count check.
    const messages: unknown[] = [];
    const errors: string[] = [];
    const parser = new NdjsonParser(
      (value) => messages.push(value),
      (error) => errors.push(error.message),
    );
    const huge = JSON.stringify({ a: "\u00e9".repeat(5 * 1024 * 1024) });

    parser.feed(`${huge}\n{"ok":1}\n`);

    expect(messages).toEqual([{ ok: 1 }]);
    expect(errors).toHaveLength(1);
  });
});

describe("L5 - synchronous send failure cleanup", () => {
  it("clears the pending entry when send throws with timeout 0 (prompt default)", async () => {
    const peer = new JsonRpcPeer(() => {
      throw new Error("stdin destroyed");
    });
    await expect(peer.request("prompt", {}, 0)).rejects.toThrow("stdin destroyed");
    expect(peer.pendingRequestCount).toBe(0);
  });

  it("clears the armed timer as well when send throws with a positive timeout", async () => {
    vi.useFakeTimers();
    try {
      const peer = new JsonRpcPeer(() => {
        throw new Error("stdin destroyed");
      });
      const request = peer.request("control", {}, 5000);
      void request.catch(() => {});
      await expect(request).rejects.toThrow("stdin destroyed");
      expect(peer.pendingRequestCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
