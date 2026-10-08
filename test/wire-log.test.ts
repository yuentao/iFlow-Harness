import { describe, it, expect } from "vitest";
import { WireRingBuffer, redactWireValue, wireFrameLine } from "../src/panel/wire-log.js";

describe("redactWireValue", () => {
  it("redacts credential-shaped keys at any nesting depth", () => {
    const out = redactWireValue({
      method: "authenticate",
      params: {
        methodId: "openai",
        apiKey: "sk-abcdefghij1234567890",
        nested: { Authorization: "Bearer abc", "x-api-key": "raw" },
      },
    });
    expect(out).toEqual({
      method: "authenticate",
      params: {
        methodId: "openai",
        apiKey: "«redacted»",
        nested: { Authorization: "«redacted»", "x-api-key": "«redacted»" },
      },
    });
  });

  it("redacts value-shaped secrets inside ordinary strings", () => {
    expect(redactWireValue("key is sk-abcdefghij1234567890 here")).toBe("key is «redacted» here");
  });

  it("leaves non-secret strings, numbers and arrays intact", () => {
    expect(redactWireValue({ n: 1, s: "hello", list: [1, "two", { k: "v" }] })).toEqual({
      n: 1,
      s: "hello",
      list: [1, "two", { k: "v" }],
    });
  });

  it("does not touch the original object (no in-place mutation)", () => {
    const src = { apiKey: "sk-abcdefghij1234567890" };
    redactWireValue(src);
    expect(src).toEqual({ apiKey: "sk-abcdefghij1234567890" });
  });
});

describe("wireFrameLine", () => {
  it("wraps a parsed frame as {ts, dir, msg} with secrets redacted", () => {
    const line = wireFrameLine({ ts: 42, direction: "out", line: JSON.stringify({ apiKey: "sk-abcdefghij1234567890" }) });
    expect(JSON.parse(line)).toEqual({ ts: 42, dir: "out", msg: { apiKey: "«redacted»" } });
  });

  it("falls back to a string pass for unparseable payloads", () => {
    const line = wireFrameLine({ ts: 1, direction: "in", line: "not json sk-abcdefghij1234567890" });
    expect(JSON.parse(line)).toEqual({ ts: 1, dir: "in", msg: "not json «redacted»" });
  });
});

describe("WireRingBuffer", () => {
  it("buffers frames and dumps redacted NDJSON oldest-first", () => {
    const buf = new WireRingBuffer(10);
    buf.tap("out", { method: "session/new" });
    buf.tap("in", { jsonrpc: "2.0", id: 1, result: { apiKey: "sk-abcdefghij1234567890" } });
    expect(buf.size).toBe(2);
    const lines = buf.dump().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).msg).toEqual({ method: "session/new" });
    expect(JSON.parse(lines[1]!).dir).toBe("in");
    expect(JSON.parse(lines[1]!).msg.result).toEqual({ apiKey: "«redacted»" });
  });

  it("caps the buffer at capacity, dropping the oldest frames", () => {
    const buf = new WireRingBuffer(3);
    for (let i = 0; i < 5; i++) buf.tap("out", { i });
    expect(buf.size).toBe(3);
    const lines = buf.dump().trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).msg.i)).toEqual([2, 3, 4]);
  });

  it("survives a non-serializable frame without throwing", () => {
    const buf = new WireRingBuffer(3);
    let cyclic: unknown;
    cyclic = { self: null };
    (cyclic as { self: unknown }).self = cyclic;
    expect(() => buf.tap("out", cyclic)).not.toThrow();
    expect(buf.size).toBe(1);
    expect(() => buf.dump()).not.toThrow();
  });

  it("returns an empty string for an empty buffer", () => {
    expect(new WireRingBuffer(1).dump()).toBe("");
  });
});
