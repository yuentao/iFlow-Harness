/**
 * OneBot v11 HTTP API transport.
 *
 * Transport is raw `node:http(s)`, exactly like `src/acp/web-search.ts` and
 * `models-query.ts`: the VSCode extension host patches global `fetch` with a
 * proxy agent that throws `Invalid URL protocol` when the system proxy is SOCKS
 * or scheme-less (pitfall #2 in AGENTS.md). `fetch` is therefore banned here.
 *
 * Scope: one-shot request/response only. The WebSocket reverse connection
 * (inbound events) is a later milestone — no reconnect logic lives here.
 *
 * Error mapping (per the task contract):
 *   - 2xx                       -> resolved with the parsed body
 *   - 4xx                       -> OneBotHttpError, retryable: false
 *   - 5xx                       -> OneBotHttpError, retryable: true
 *   - timeout / socket failure  -> OneBotHttpError, retryable: true
 *
 * Action-level rejections (`status: "failed"`, `retcode != 0`) are returned as
 * data, not thrown: deciding what they mean for a chat belongs to the caller.
 */

import * as http from "node:http";
import * as https from "node:https";

/** Minimal contract the adapter needs from any OneBot HTTP implementation. */
export interface OneBotTransport {
  post(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface HttpOneBotTransportOptions {
  /** Full endpoint URL, e.g. `http://127.0.0.1:3000/`. Path is preserved. */
  baseUrl: string;
  /** OneBot access token; sent as `Authorization: Bearer <token>`. */
  accessToken?: string;
  /** Per-request ceiling. Default 10s. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** OneBot replies are small; anything past this is a misrouted endpoint. */
const MAX_RESPONSE_BYTES = 2_000_000;

export class OneBotHttpError extends Error {
  /** HTTP status when the failure came from a response. */
  readonly status?: number;
  /** True when re-queueing the same action has a chance to succeed. */
  readonly retryable: boolean;
  /** Raw response body (truncated) for diagnostics. */
  readonly responseBody?: string;

  constructor(message: string, options: { retryable: boolean; status?: number; responseBody?: string }) {
    super(message);
    this.name = "OneBotHttpError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

function bodySnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

export class HttpOneBotTransport implements OneBotTransport {
  private readonly url: URL;
  private readonly accessToken: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: HttpOneBotTransportOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error(`Invalid OneBot baseUrl: ${options.baseUrl}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported OneBot baseUrl protocol: ${url.protocol}`);
    }
    this.url = url;
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async post(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const body = JSON.stringify({ action, params });
    const text = await this.request(body);
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A few backends answer plain text on errors; hand it back rather than
      // turning a usable answer into a transport failure.
      return text;
    }
  }

  /** POST one JSON body and resolve with the raw response text. */
  private request(body: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const fail = (error: OneBotHttpError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const succeed = (value: string): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": String(Buffer.byteLength(body)),
      };
      if (this.accessToken) headers["authorization"] = `Bearer ${this.accessToken}`;

      const transport = this.url.protocol === "https:" ? https : http;
      const req = transport.request(this.url, { method: "POST", headers }, (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let bytes = 0;

        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            fail(
              new OneBotHttpError("OneBot response exceeded the 2MB limit", {
                retryable: false,
                status,
              }),
            );
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (status >= 200 && status < 300) {
            succeed(text);
            return;
          }
          fail(
            new OneBotHttpError(`OneBot HTTP ${status}: ${bodySnippet(text)}`, {
              // 4xx is a caller/credential problem; only 5xx is worth retrying.
              retryable: status >= 500,
              status,
              responseBody: text,
            }),
          );
        });

        res.on("error", (error: Error) => {
          fail(
            new OneBotHttpError(`OneBot response failed: ${error.message}`, {
              retryable: true,
              status,
            }),
          );
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        timedOut = true;
        req.destroy();
      });

      req.on("error", (error: Error) => {
        const message = timedOut
          ? `OneBot request timed out after ${this.timeoutMs}ms`
          : `OneBot request failed: ${error.message}`;
        fail(new OneBotHttpError(message, { retryable: true }));
      });

      req.end(body);
    });
  }
}
