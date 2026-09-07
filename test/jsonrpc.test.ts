import { describe, it, expect } from "vitest";
import { NdjsonParser, JsonRpcPeer, JsonRpcErrorCode, errorMessage } from "../src/acp/jsonrpc.js";

describe("errorMessage", () => {
  it("prefers Error.message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message from JsonRpcError-shaped plain objects", () => {
    // Wire behavior (probed, CLI 0.5.19): peer rejects with {code, message, data},
    // NOT an Error — String(error) used to render "[object Object]".
    expect(errorMessage({ code: -32000, message: "会话不存在" })).toBe("会话不存在");
  });

  it("passes strings through", () => {
    expect(errorMessage("plain")).toBe("plain");
  });

  it("falls back to JSON for message-less objects", () => {
    expect(errorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it("never renders [object Object]", () => {
    expect(errorMessage({ nested: { deep: 1 } })).not.toContain("[object");
  });
});

describe("NdjsonParser", () => {
  it("emits one message per line", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles chunk boundaries across messages", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed('{"a":');
    parser.feed('1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles CRLF line endings", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed('{"a":1}\r\n');
    expect(messages).toEqual([{ a: 1 }]);
  });

  it("skips empty lines", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed("\n\n{\"a\":1}\n\n");
    expect(messages).toEqual([{ a: 1 }]);
  });

  it("reports unparseable lines via onError and keeps parsing", () => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const parser = new NdjsonParser(
      (v) => messages.push(v),
      (_e, raw) => errors.push(raw),
    );
    parser.feed("not json\n{\"a\":1}\n");
    expect(messages).toEqual([{ a: 1 }]);
    expect(errors).toEqual(["not json"]);
  });
});

describe("JsonRpcPeer", () => {
  function createLinkedPeers() {
    const wire: Array<{ dir: string; msg: Record<string, unknown> }> = [];
    const aOut: string[] = [];
    const bOut: string[] = [];
    const a = new JsonRpcPeer((line) => {
      aOut.push(line);
      b.handleData(line + "\n");
    });
    const b = new JsonRpcPeer((line) => {
      bOut.push(line);
      a.handleData(line + "\n");
    });
    return { a, b, wire, aOut, bOut };
  }

  it("round-trips a request/response", async () => {
    const { a, b } = createLinkedPeers();
    b.onRequest("ping", (params) => ({ pong: params }));
    const result = await a.request("ping", { n: 1 });
    expect(result).toEqual({ pong: { n: 1 } });
  });

  it("delivers notifications to registered handlers", () => {
    const { a, b } = createLinkedPeers();
    const received: unknown[] = [];
    b.onNotification("update", (p) => received.push(p));
    a.notify("update", { v: 42 });
    expect(received).toEqual([{ v: 42 }]);
  });

  it("rejects a request on error response", async () => {
    const { a, b } = createLinkedPeers();
    b.onRequest("boom", () => {
      throw new Error("kaboom");
    });
    await expect(a.request("boom")).rejects.toMatchObject({ message: "kaboom" });
  });

  it("times out a request that never gets a response", async () => {
    // Standalone peer: nothing ever responds.
    const a = new JsonRpcPeer(() => {});
    await expect(a.request("never", undefined, 20)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
  });

  it("rejects all pending requests on rejectAll", async () => {
    // Standalone peer: nothing ever responds.
    const a = new JsonRpcPeer(() => {});
    const p = a.request("slow", undefined, 0);
    a.rejectAll("closed");
    await expect(p).rejects.toMatchObject({ message: "closed" });
  });

  it("answers MethodNotFound for unknown incoming requests", async () => {
    const { a, b, bOut } = createLinkedPeers();
    b.handleData(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope", params: {} }) + "\n");
    // b sends back a MethodNotFound error response; a has no pending id=7, ignores it.
    expect(bOut).toHaveLength(1);
    expect(JSON.parse(bOut[0]!)).toMatchObject({ id: 7, error: { code: JsonRpcErrorCode.MethodNotFound } });
    void a;
  });

  it("invokes wireTap for both directions", async () => {
    const wire: Array<{ dir: string }> = [];
    const a = new JsonRpcPeer(
      (line) => b.handleData(line + "\n"),
      (dir) => wire.push({ dir }),
    );
    const b = new JsonRpcPeer(
      (line) => a.handleData(line + "\n"),
      (dir) => wire.push({ dir }),
    );
    b.onRequest("x", () => ({}));
    await a.request("x");
    expect(wire.map((w) => w.dir)).toEqual(["out", "in", "out", "in"]);
  });
});
