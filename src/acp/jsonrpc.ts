/**
 * NDJSON framing + JSON-RPC 2.0 message routing.
 * Pure logic layer with zero VSCode dependencies, so it is unit-testable
 * and reusable by any IDE integration (see docs/iflow-vscode-extension-plan.md M0).
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Incremental NDJSON parser: accepts arbitrary chunk boundaries, emits one
 * parsed JSON value per non-empty line.
 */
export class NdjsonParser {
  private buffer = "";

  constructor(
    private readonly onMessage: (value: unknown) => void,
    private readonly onError?: (error: Error, rawLine: string) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch (error) {
        this.onError?.(error as Error, line);
      }
    }
  }
}

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: JsonRpcError) => void;
  timer: NodeJS.Timeout | null;
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;
export type WireTap = (direction: "out" | "in", message: Record<string, unknown>) => void;

/**
 * A single JSON-RPC peer. Direction is defined by construction:
 * `send` writes to the other side; incoming traffic is fed via `handleData`.
 * Requests may flow in both directions (agent calls client methods such as
 * `session/request_permission`), which the dual handler maps support.
 */
export class JsonRpcPeer {
  private nextId = 0;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly parser: NdjsonParser;
  private closed = false;

  constructor(
    private readonly send: (line: string) => void,
    private readonly wireTap?: WireTap,
  ) {
    this.parser = new NdjsonParser(
      (value) => this.handleMessage(value),
      this.onUnparseableLine?.bind(this),
    );
  }

  /**
   * Default: drop unparseable lines silently. Real CLIs occasionally print
   * banners on stdout; replying with a parse error would corrupt the stream.
   * Override via subclass if strict behavior is needed.
   */
  protected onUnparseableLine(_error: Error, _rawLine: string): void {}

  /** Feed raw text (any chunk boundary). */
  handleData(chunk: string): void {
    this.parser.feed(chunk);
  }

  handleMessage(value: unknown): void {
    const msg = value as JsonRpcMessage;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    this.wireTap?.("in", msg as unknown as Record<string, unknown>);

    const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
    const hasMethod = "method" in msg && typeof msg.method === "string";

    if (hasMethod && hasId) {
      // Incoming request from the peer (e.g. requestPermission).
      const request = msg as JsonRpcRequest;
      const handler = this.requestHandlers.get(request.method);
      if (!handler) {
        this.reply({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: JsonRpcErrorCode.MethodNotFound, message: `Method not supported: ${request.method}` },
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(request.params))
        .then(
          (result) => this.reply({ jsonrpc: "2.0", id: request.id, result: result ?? {} }),
          (error: unknown) =>
            this.reply({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: JsonRpcErrorCode.InternalError,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      return;
    }

    if (hasMethod && !hasId) {
      const notification = msg as JsonRpcNotification;
      this.notificationHandlers.get(notification.method)?.(notification.params);
      return;
    }

    if (!hasMethod && hasId) {
      // Response to one of our outgoing requests.
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.clearPendingTimer(pending);
      this.pending.delete(response.id);
      if (response.error) pending.reject(response.error);
      else pending.resolve(response.result);
    }
  }

  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject({ code: JsonRpcErrorCode.InternalError, message: "Connection is closed" });
    }
    const id = ++this.nextId;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.wireTap?.("out", message as unknown as Record<string, unknown>);

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject({ code: JsonRpcErrorCode.InternalError, message: `Request timed out after ${timeoutMs}ms: ${method}` });
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.send(JSON.stringify(message));
    });
  }

  notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.wireTap?.("out", message as unknown as Record<string, unknown>);
    this.send(JSON.stringify(message));
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Reject all pending requests (process exited / peer stopped). */
  rejectAll(message: string): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      this.clearPendingTimer(pending);
      pending.reject({ code: JsonRpcErrorCode.InternalError, message });
    }
    this.pending.clear();
  }

  private reply(message: JsonRpcResponse): void {
    this.wireTap?.("out", message as unknown as Record<string, unknown>);
    this.send(JSON.stringify(message));
  }

  private clearPendingTimer(pending: PendingRequest): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }
}
