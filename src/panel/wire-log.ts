/**
 * M1 P1-4 — ACP wire-log ring buffer + export redaction.
 *
 * `JsonRpcPeer` already exposes a `wireTap` hook at every in/out frame
 * (src/acp/jsonrpc.ts); the panel injects one instance of this buffer at CLI
 * spawn. The buffer is capped so an always-on tap can never grow memory with
 * the session. Export runs a credential redaction pass before the file
 * touches disk — the wire carries `authenticate` params with raw API keys,
 * so an unredacted dump would violate the credentials discipline
 * (SecretStorage-only).
 *
 * Zero VSCode dependency: the panel owns the save dialog, this module only
 * produces strings.
 */

import type { WireTap } from "../acp/jsonrpc.js";

export interface WireFrame {
  ts: number;
  direction: "in" | "out";
  line: string;
}

/** Keys whose VALUES are credential material at any nesting depth. Matched
 * case-insensitively against the lower-cased key name. */
const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "password",
  "secret",
  "x-api-key",
]);

/** Value-shaped credential (sk-… style) inside an otherwise innocuous string. */
const SECRET_VALUE_RE = /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})\b/g;

/** Recursively replace credential values with `«redacted»`. */
export function redactWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactWireValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "«redacted»" : redactWireValue(v);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE_RE, "«redacted»");
  return value;
}

/** NDJSON line for one frame: `{ts, dir, msg}` with secrets redacted. */
export function wireFrameLine(frame: WireFrame): string {
  let msg: unknown;
  try {
    msg = redactWireValue(JSON.parse(frame.line));
  } catch {
    // Unparseable payloads (shouldn't happen — the tap sees parsed frames)
    // still get the value-shaped pass.
    msg = frame.line.replace(SECRET_VALUE_RE, "«redacted»");
  }
  return JSON.stringify({ ts: frame.ts, dir: frame.direction, msg });
}

/**
 * Bounded ring buffer of wire frames. `push` runs on every JSON-RPC frame
 * (hot path): it stringifies once and drops the oldest entry beyond the cap.
 * `dump()` produces the redacted NDJSON export.
 *
 * Two caps, whichever binds first: frame COUNT and a char BUDGET. The count
 * cap alone is not a memory bound — one raw frame carries whatever the wire
 * carried (a full tool output or structured diff can be hundreds of KB), so
 * 2000 such frames pin hundreds of MB in the Extension Host for the whole
 * session (long-session bloat, 2026-10). The budget is measured in
 * `line.length` (UTF-16 code units ≈ the JS heap cost of the retained
 * string), which bounds retention regardless of frame shape.
 */
export class WireRingBuffer {
  private readonly frames: WireFrame[] = [];
  /** Sum of `line.length` over `frames` — maintained on push/evict. */
  private chars = 0;

  constructor(
    private readonly capacity = 2000,
    private readonly maxChars = 8 * 1024 * 1024,
  ) {}

  /** A `WireTap`-compatible sink for `JsonRpcPeer` / `AcpClient`. */
  readonly tap: WireTap = (direction, message) => {
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch {
      line = String(message);
    }
    this.frames.push({ ts: Date.now(), direction, line });
    this.chars += line.length;
    // Evict oldest-first until BOTH caps hold. Batched: a single oversized
    // frame can breach the budget by many frames' worth at once. The newest
    // frame always survives (a one-frame-over-budget wire frame — up to the
    // 8MB NDJSON cap — would otherwise empty the buffer and leave exports
    // with nothing); worst-case retention is maxChars + one oversized frame.
    let drop = 0;
    while (
      drop < this.frames.length - 1 &&
      (this.frames.length - drop > this.capacity || this.chars > this.maxChars)
    ) {
      this.chars -= this.frames[drop]!.line.length;
      drop++;
    }
    if (drop > 0) this.frames.splice(0, drop);
  };

  get size(): number {
    return this.frames.length;
  }

  /** Redacted NDJSON of everything buffered (oldest first). */
  dump(): string {
    return this.frames.map(wireFrameLine).join("\n") + (this.frames.length > 0 ? "\n" : "");
  }
}
