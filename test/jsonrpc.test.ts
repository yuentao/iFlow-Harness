import { describe, it, expect } from "vitest";
import { NdjsonParser, JsonRpcPeer, JsonRpcErrorCode, errorMessage, isContextOverflowError, isRateLimitError } from "../src/acp/jsonrpc.js";

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

  it("repairs an Error whose message is literally [object Object]", () => {
    // Upstream wrapped a non-Error value: new Error(someObj). The message is
    // beyond repair — surface the construction-site frames instead.
    const err = new Error("[object Object]");
    const out = errorMessage(err);
    expect(out).not.toBe("[object Object]");
    expect(out).toContain("no message");
    expect(out).toContain("at ");
  });

  it("repairs an Error with an empty message", () => {
    const err = new Error("");
    const out = errorMessage(err);
    expect(out).toContain("no message");
  });

  it("renders the full envelope when the CLI-side message is [object Object]", () => {
    // The CLI stringified an object into its own error message — treat the
    // message as absent and show code+data instead.
    const out = errorMessage({ code: -32000, message: "[object Object]", data: { detail: "真实原因" } });
    expect(out).not.toBe("[object Object]");
    expect(out).toContain("-32000");
    expect(out).toContain("真实原因");
  });

  it("appends data as a capped suffix after a usable message", () => {
    const out = errorMessage({ code: -32000, message: "请求失败", data: "堆栈细节" });
    expect(out).toBe("请求失败 · 堆栈细节");
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { code: 1 };
    a.self = a;
    const out = errorMessage(a);
    expect(out).not.toContain("[object");
    expect(out).toContain("code");
  });

  it("inspects nested shapes with field names visible", () => {
    const out = errorMessage({ wrapper: { innerCode: 7 } });
    expect(out).toContain("wrapper");
    expect(out).toContain("innerCode");
  });
});

describe("isContextOverflowError", () => {
  it("matches the iFlow openai-adapter overflow message (HTTP 511 wording)", () => {
    // Wire behavior (probed, CLI 0.5.19 bundle): literal i18n message thrown
    // for HTTP 511 and response error_code 511/413.
    const err = { code: -32000, message: "Content length exceed LLM Limit. TraceID: abc123" };
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches overflow detail hidden in the JSON-RPC data suffix", () => {
    const err = { code: -32000, message: "请求失败", data: "Error: maximum context length is 128000 tokens" };
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches common third-party gateway phrasings", () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 200000 tokens"))).toBe(true);
    expect(isContextOverflowError(new Error("Your prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextOverflowError(new Error("POST failed: HTTP 413, status: 413"))).toBe(true);
    expect(isContextOverflowError(new Error("上下文长度超出模型限制"))).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isContextOverflowError(new Error("Rate limit exceeded. Try again later."))).toBe(false);
    expect(isContextOverflowError(new Error("Invalid API key provided"))).toBe(false);
    expect(isContextOverflowError({ code: -32602, message: "Session not found: s1" })).toBe(false);
    expect(isContextOverflowError("connection closed")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("matches the observed gateway rate-limit message in both wire shapes", () => {
    // Wire behavior (probed, CLI 0.5.19 + api.buzzgw.com): the gateway's
    // mid-stream rejection surfaces as JSON-RPC InternalError (-32603) whose
    // message and data.details carry the provider text; errorMessage()
    // concatenates both, so either alone must match.
    const details = "生成内容流失败：当前模型已达到平台速率限制，系统将重试请求，如果频繁报错请切换其他模型使用";
    expect(isRateLimitError({ code: -32603, message: `Internal Error: ${details}` })).toBe(true);
    expect(
      isRateLimitError({ code: -32603, message: `Internal Error: ${details}`, data: { details } }),
    ).toBe(true);
    expect(isRateLimitError(new Error(details))).toBe(true);
  });

  it("matches English and transport-level phrasings", () => {
    expect(isRateLimitError(new Error("Rate limit exceeded. Try again later."))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("Request failed with status: 429"))).toBe(true);
    expect(isRateLimitError(new Error("quota exhausted for this project"))).toBe(true);
    expect(isRateLimitError(new Error("触发限流，请稍后再试"))).toBe(true);
  });

  it("does not match unrelated failures (overflow, auth, transport)", () => {
    expect(isRateLimitError(new Error("Content length exceed LLM Limit. TraceID: abc123"))).toBe(false);
    expect(isRateLimitError(new Error("Invalid API key provided"))).toBe(false);
    expect(isRateLimitError({ code: -32602, message: "Session not found: s1" })).toBe(false);
    expect(isRateLimitError("connection closed")).toBe(false);
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

  // Buffer safety (review finding S2): a CLI flooding stdout with one giant
  // line (runaway output / crash dump without a newline) must not pin the
  // host's memory — the partial frame is dropped and parsing resumes.
  it("drops an oversized partial frame (no newline) via onError", () => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const parser = new NdjsonParser(
      (v) => messages.push(v),
      (e, raw) => errors.push(`${e.message}|${raw}`),
    );
    parser.feed("x".repeat(8 * 1024 * 1024 + 1));
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    const [entry] = errors;
    expect(entry).toContain("exceeds");
    expect(entry!.length).toBeLessThanOrEqual(200 + "ndjson frame exceeds 8388608 bytes — dropped|".length);
  });

  it("recovers parsing after dropping an oversized partial frame", () => {
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed("x".repeat(8 * 1024 * 1024 + 1));
    parser.feed('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("does not drop a complete line that happens to be large", () => {
    // The guard only covers unterminated frames: a valid (if huge) NDJSON
    // line with a trailing newline is still parsed.
    const big = JSON.stringify({ a: "y".repeat(8 * 1024 * 1024 + 1) });
    const messages: unknown[] = [];
    const parser = new NdjsonParser((v) => messages.push(v));
    parser.feed(`${big}\n{"b":2}\n`);
    expect(messages).toEqual([JSON.parse(big), { b: 2 }]);
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
