/**
 * Host-side MCP broker: ONE process per configured MCP server, shared by every
 * Super Agent child session.
 *
 * Why this exists (2026-11-18): each child session runs its own CLI process
 * (that is the isolation model — own worktree, own ACP session). The CLI
 * spawns one process chain per configured MCP server for every session it
 * creates, so N concurrent children used to mean N copies of every MCP server
 * (and, before this module, the children had MCP switched off entirely because
 * of that cost). The host now owns the servers:
 *
 *   child CLI ──HTTP (streamable)──▶ host broker ──stdio/http/sse──▶ real server
 *
 * The broker speaks the MCP protocol on both sides. Downstream it is a
 * stateless streamable-HTTP MCP server (the CLI's `type: "http"` transport
 * accepts plain `application/json` responses — probed in the vendored bundle:
 * `StreamableHTTPClientTransport.send()` parses `application/json` and
 * `text/event-stream`, and its `start()` only allocates an AbortController, so
 * no SSE GET is required; a 405 on GET is explicitly tolerated). Upstream it
 * is an MCP client for the transports the CLI itself supports:
 *
 *  - `stdio`  — `command` + `args` + `env` (spawned once, NDJSON JSON-RPC)
 *  - `http` / `streamable-http` — `url` / `httpUrl`, JSON or SSE response body
 *  - `sse` — legacy HTTP+SSE (`event: endpoint` then POST to it)
 *
 * Wire behavior verified against `vendor/iflow-fork/bundle/iflow.js`:
 *  - `session/new` accepts `mcpServers[]` entries shaped
 *    `{name?, command?, args?, env?, cwd?, url?, httpUrl?, headers?,
 *    type?: "stdio"|"sse"|"http"|"streamable-http", ...}` (zod schema at the
 *    ACP request layer). `headers` is a `Record<string,string>`, `env` is an
 *    array of `{name,value}`
 *  - `newSessionConfig()` starts from the CLI's own configured servers
 *    (`{...settings.merged.mcpServers}`) and assigns each REQUEST server into
 *    that map by name (`l[name || "unnamed"] = ...`), i.e. a request entry
 *    OVERRIDES a configured server of the same name. That is what lets a child
 *    receive `{name: "demo", type: "http", url: <broker>}` while the user's
 *    on-disk config still says `{command: "npx", ...}`
 *  - `--allowed-mcp-server-names` filters the MERGED map (settings + request)
 *    down to the named servers, so the child can be scoped to exactly the
 *    broker names — no configured stdio server is ever spawned by the child.
 *
 * Deliberate limits (do not paper over):
 *  - This is a stateless gateway: `initialize` is answered from the shared
 *    upstream handshake, and per-child MCP sessions share one upstream
 *    connection. Servers that keep per-client state (sampling, elicitation,
 *    server→client requests) are NOT supported — the broker never forwards
 *    server→client requests to a specific child.
 *  - Upstream `websocket` URLs are not supported (the CLI supports them, the
 *    broker does not); such entries are skipped and reported, never faked.
 *  - Outbound HTTP uses `node:http(s)` directly, not global `fetch`: the
 *    extension host patches `fetch` with a proxy agent that throws on SOCKS /
 *    scheme-less system proxies (same reason `models-query.ts` does this).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import type { McpServer, McpToolView } from "./protocol.js";

/** Header the child's CLI must present — keeps other local processes out. */
export const MCP_BROKER_TOKEN_HEADER = "x-iflow-mcp-broker";

/** Cap on a downstream request body (mirrors the NDJSON frame limit). */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
/** Cap on collected upstream HTTP response bodies. */
const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;
/** Tail of an MCP server's stderr kept for error messages. */
const STDERR_TAIL_CHARS = 4_000;
/** Default per-request timeout. Tool calls may legitimately run for minutes. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

const INITIALIZE_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "iflow-harness-mcp-broker", version: "1.0.0" },
};

export interface McpBrokerServerConfig {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
}

export interface McpBrokerOptions {
  /** Merged MCP server dict (global settings + project settings). */
  servers: Record<string, unknown>;
  /** Default cwd for stdio servers that do not declare one. */
  cwd?: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  requestTimeoutMs?: number;
  host?: string;
  port?: number;
  /** Fired (debounced) when a connection state/tool declaration actually
   * changes, so the panel can push a fresh `mcpStatus` reply without waiting
   * for the webview to open the card and press 刷新. */
  onStatusChange?: () => void;
}

export interface McpBrokerStatus {
  name: string;
  type: string;
  connected: boolean;
  /** True between `ensure()` starting and the upstream handshake settling.
   * The panel maps this to the webview's "connecting" blue dot instead of a
   * false red "connection failed" light. */
  connecting: boolean;
  /** Tool declarations cached from the shared upstream `tools/list`. This is
   * the honest source of the `≈N tokens` chip: the main session disables MCP
   * so the CLI report carries an empty `tools[]`. */
  tools: McpToolView[];
  error?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface UpstreamClient {
  readonly initResult: unknown;
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

interface UpstreamState {
  config: McpBrokerServerConfig;
  client: UpstreamClient | null;
  connecting: Promise<UpstreamClient> | null;
  error: string | null;
  /** Tool declarations from the shared upstream `tools/list`, cached once.
   * Empty until the handshake succeeds and the listing completes. */
  tools: McpToolView[];
}

interface HttpRawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `env` is an array of `{name,value}` in the CLI's schema, but hand-written
 * settings often use a plain object — accept both. */
function normalizeEnv(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      const name = typeof record?.name === "string" ? record.name : null;
      if (!name) continue;
      out[name] = String(record?.value ?? "");
    }
    return out;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        out[key] = String(raw);
      }
    }
  }
  return out;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  return normalizeEnv(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Normalize a raw upstream `tools/list` result into the same shape the CLI's
 * mcp-status Mod reports (`McpToolView`). The schema key differs by producer:
 * the CLI loader picks `parametersJsonSchema ?? parameters`, while a plain
 * MCP server's tools/list carries `inputSchema`. Prefer the loader's key,
 * accept the others as fallbacks — the token estimate then counts the same
 * JSON the model actually sees.
 */
function toolViewsFromListing(result: unknown): McpToolView[] {
  const record = asRecord(result);
  const rawTools = Array.isArray(record?.tools) ? record.tools : [];
  const views: McpToolView[] = [];
  for (const raw of rawTools) {
    const tool = asRecord(raw);
    if (!tool || typeof tool.name !== "string") continue;
    const schema = tool.parametersJsonSchema ?? tool.inputSchema ?? tool.parameters;
    views.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(schema !== undefined && schema !== null ? { schema } : {}),
    });
  }
  return views;
}

/**
 * Turn the on-disk `mcpServers` dict into broker configs.
 *
 * Skips (and reports) entries the broker cannot serve honestly: `disabled`
 * servers, entries with no usable command/url, and websocket URLs. The caller
 * uses the returned names as the child's `--allowed-mcp-server-names` list, so
 * a skipped server is ALSO absent from the child — never silently left to be
 * spawned per child.
 */
export function normalizeBrokerServers(input: Record<string, unknown> | null | undefined): {
  servers: McpBrokerServerConfig[];
  skipped: { name: string; reason: string }[];
} {
  const servers: McpBrokerServerConfig[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const [name, raw] of Object.entries(input ?? {})) {
    const record = asRecord(raw);
    if (!record) {
      skipped.push({ name, reason: "配置不是对象" });
      continue;
    }
    if (record.disabled === true) {
      skipped.push({ name, reason: "已禁用" });
      continue;
    }
    const declared = typeof record.type === "string" ? record.type : null;
    const command = typeof record.command === "string" ? record.command : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    const httpUrl = typeof record.httpUrl === "string" ? record.httpUrl : undefined;
    const type =
      declared === "http" || declared === "streamable-http"
        ? "http"
        : declared === "sse"
          ? "sse"
          : declared === "stdio"
            ? "stdio"
            : command
              ? "stdio"
              : httpUrl
                ? "http"
                : url
                  ? "sse"
                  : null;
    if (!type) {
      skipped.push({ name, reason: "缺少 command 或 url" });
      continue;
    }
    if (type === "stdio" && !command) {
      skipped.push({ name, reason: "stdio 服务器缺少 command" });
      continue;
    }
    if (type !== "stdio" && !url && !httpUrl) {
      skipped.push({ name, reason: "远程服务器缺少 url" });
      continue;
    }
    const target = httpUrl ?? url ?? "";
    if (type !== "stdio" && /^wss?:/i.test(target)) {
      skipped.push({ name, reason: "websocket transport 不支持共享" });
      continue;
    }
    servers.push({
      name,
      type,
      command,
      args: asStringArray(record.args),
      env: normalizeEnv(record.env),
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      url: type === "stdio" ? undefined : target,
      headers: normalizeHeaders(record.headers),
    });
  }
  return { servers, skipped };
}

/**
 * Resolve a stdio command the way `cross-spawn` does (the CLI's own MCP
 * transport uses it): on Windows a bare `npx` must become `npx.cmd` and a
 * `.cmd`/`.bat` must be launched through `cmd.exe /d /s /c`. `spawn` with
 * `shell: false` alone fails with ENOENT for every npm-installed server.
 */
export function buildStdioSpawn(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveWindowsExecutable(command);
  if (!resolved) return { command, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
  const comspec = process.env.ComSpec || "cmd.exe";
  const line = [resolved, ...args].map(quoteWindowsArg).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", line] };
}

function quoteWindowsArg(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function resolveWindowsExecutable(command: string): string | null {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const names: string[] = [];
  if (path.extname(command)) names.push(command);
  else {
    names.push(command);
    for (const ext of exts) names.push(`${command}${ext.toLowerCase()}`);
  }
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (hasSeparator) {
    for (const name of names) if (existsSync(name)) return name;
    return null;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  }
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

/** Split a buffer of SSE text into complete events (`\n\n` separated). */
function drainSseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: { event: string; data: string }[] = [];
  for (const chunk of chunks) {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

function readJsonRpcResponse(message: JsonRpcMessage, id: number | string): unknown {
  if (message.error) {
    const code = typeof message.error.code === "number" ? message.error.code : -32000;
    throw new Error(`MCP error ${code}: ${message.error.message ?? "unknown error"}`);
  }
  return message.result;
}

function parseJsonRpcBody(body: string, id: number | string): unknown {
  const parsed = JSON.parse(body) as unknown;
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const raw of messages) {
    const message = asRecord(raw) as JsonRpcMessage | null;
    if (!message) continue;
    if (message.id === id) return readJsonRpcResponse(message, id);
  }
  throw new Error("MCP server returned no response for the request");
}

// ---------------------------------------------------------------------------
// Upstream: stdio
// ---------------------------------------------------------------------------

class StdioUpstreamClient implements UpstreamClient {
  initResult: unknown = null;
  private child: ChildProcess | null = null;
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly config: McpBrokerServerConfig,
    private readonly timeoutMs: number,
    private readonly defaultCwd: string | undefined,
  ) {}

  async initialize(): Promise<void> {
    this.start();
    const result = await this.request("initialize", INITIALIZE_PARAMS);
    this.initResult = result;
    this.notify("notifications/initialized");
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error(`MCP server "${this.config.name}" 进程未运行`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP server "${this.config.name}" 在 ${this.timeoutMs}ms 内没有响应 ${method}`,
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAll(new Error(`MCP server "${this.config.name}" 已关闭`));
    if (child) await killTree(child);
  }

  private start(): void {
    const command = this.config.command;
    if (!command) throw new Error(`MCP server "${this.config.name}" 缺少 command`);
    const spawnSpec = buildStdioSpawn(command, this.config.args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.config.cwd ?? this.defaultCwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.failAll(
        new Error(
          `MCP server "${this.config.name}" 已退出（code=${String(code)} signal=${String(signal)}）${
            this.stderrTail ? `：${this.stderrTail.trim()}` : ""
          }`,
        ),
      );
    });
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return; // notifications / server→client requests
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(readJsonRpcResponse(message, message.id));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(messageOf(error)));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Upstream: HTTP (streamable) + legacy SSE
// ---------------------------------------------------------------------------

function postJsonRpc(
  url: string,
  payload: JsonRpcMessage,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpRawResponse> {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<HttpRawResponse>((resolve, reject) => {
    const request = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPSTREAM_BODY_BYTES) {
            request.destroy(new Error("MCP 响应体超过 8MB 上限"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`MCP 请求超时（${timeoutMs}ms）`)));
    request.on("error", reject);
    request.end(body);
  });
}

class HttpUpstreamClient implements UpstreamClient {
  initResult: unknown = null;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(
    private readonly config: McpBrokerServerConfig,
    private readonly timeoutMs: number,
  ) {}

  async initialize(): Promise<void> {
    const result = (await this.request("initialize", INITIALIZE_PARAMS)) as {
      protocolVersion?: unknown;
    } | null;
    this.initResult = result;
    this.protocolVersion =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : null;
    this.notify("notifications/initialized");
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `MCP server "${this.config.name}" 返回 HTTP ${response.status}: ${response.body.slice(0, 500)}`,
      );
    }
    const sessionId = response.headers["mcp-session-id"];
    if (typeof sessionId === "string") this.sessionId = sessionId;
    const contentType = String(response.headers["content-type"] ?? "");
    if (contentType.includes("text/event-stream")) {
      const { events } = drainSseEvents(response.body);
      for (const event of events) {
        try {
          const parsed = JSON.parse(event.data) as JsonRpcMessage;
          if (parsed.id === id) return readJsonRpcResponse(parsed, id);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("MCP error")) throw error;
        }
      }
      throw new Error(`MCP server "${this.config.name}" 的 SSE 响应里没有匹配的结果`);
    }
    if (!response.body.trim()) {
      throw new Error(`MCP server "${this.config.name}" 返回了空响应`);
    }
    return parseJsonRpcBody(response.body, id);
  }

  notify(method: string, params?: unknown): void {
    void this.post(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })
      .catch(() => undefined);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private post(payload: JsonRpcMessage): Promise<HttpRawResponse> {
    const url = this.config.url;
    if (!url) throw new Error(`MCP server "${this.config.name}" 缺少 url`);
    const headers: Record<string, string> = {
      ...this.config.headers,
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    return postJsonRpc(url, payload, headers, this.timeoutMs);
  }
}

class SseUpstreamClient implements UpstreamClient {
  initResult: unknown = null;
  private endpoint: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private streamRequest: ReturnType<typeof httpRequest> | null = null;
  private buffer = "";

  constructor(
    private readonly config: McpBrokerServerConfig,
    private readonly timeoutMs: number,
  ) {}

  async initialize(): Promise<void> {
    await this.openStream();
    const result = await this.request("initialize", INITIALIZE_PARAMS);
    this.initResult = result;
    this.notify("notifications/initialized");
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const endpoint = this.endpoint;
      if (!endpoint) {
        reject(new Error(`MCP server "${this.config.name}" 的 SSE 端点尚未就绪`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.config.name}" 在 ${this.timeoutMs}ms 内没有响应 ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      void postJsonRpc(endpoint, { jsonrpc: "2.0", id, method, params }, this.config.headers, this.timeoutMs)
        .then((response) => {
          if (response.status < 200 || response.status >= 300) {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(
              new Error(
                `MCP server "${this.config.name}" 返回 HTTP ${response.status}: ${response.body.slice(0, 500)}`,
              ),
            );
          }
        })
        .catch((error: unknown) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error(messageOf(error)));
        });
    });
  }

  notify(method: string, params?: unknown): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    void postJsonRpc(
      endpoint,
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
      this.config.headers,
      this.timeoutMs,
    ).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.streamRequest?.destroy();
    this.streamRequest = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server "${this.config.name}" 已关闭`));
    }
    this.pending.clear();
  }

  private openStream(): Promise<void> {
    const url = this.config.url;
    if (!url) return Promise.reject(new Error(`MCP server "${this.config.name}" 缺少 url`));
    const target = new URL(url);
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`MCP server "${this.config.name}" 的 SSE 握手超时`)),
        this.timeoutMs,
      );
      timer.unref?.();
      const request = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: { ...this.config.headers, accept: "text/event-stream" },
          timeout: this.timeoutMs,
        },
        (response) => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            finish(new Error(`MCP server "${this.config.name}" 的 SSE 连接返回 HTTP ${response.statusCode}`));
            response.resume();
            return;
          }
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            this.buffer += chunk;
            const { events, rest } = drainSseEvents(this.buffer);
            this.buffer = rest;
            for (const event of events) {
              if (event.event === "endpoint") {
                try {
                  this.endpoint = new URL(event.data, target).toString();
                } catch (error) {
                  finish(new Error(`无法解析 SSE endpoint: ${messageOf(error)}`));
                  return;
                }
                clearTimeout(timer);
                finish();
              } else if (event.event === "message") {
                this.onMessage(event.data);
              }
            }
          });
          response.on("end", () => finish(new Error(`MCP server "${this.config.name}" 的 SSE 流已结束`)));
          response.on("error", (error) => finish(error));
        },
      );
      request.on("error", (error) => finish(error));
      request.end();
      this.streamRequest = request;
    });
  }

  private onMessage(data: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(readJsonRpcResponse(message, message.id));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(messageOf(error)));
    }
  }
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

function createUpstreamClient(
  config: McpBrokerServerConfig,
  timeoutMs: number,
  defaultCwd: string | undefined,
): UpstreamClient {
  if (config.type === "stdio") return new StdioUpstreamClient(config, timeoutMs, defaultCwd);
  if (config.type === "sse") return new SseUpstreamClient(config, timeoutMs);
  return new HttpUpstreamClient(config, timeoutMs);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("请求体超过 8MB 上限"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export class McpBroker {
  private readonly upstreams = new Map<string, UpstreamState>();
  private readonly token = randomUUID();
  private server: Server | null = null;
  private port = 0;
  private closed = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly configs: McpBrokerServerConfig[],
    private readonly options: McpBrokerOptions,
    private readonly timeoutMs: number,
  ) {
    for (const config of configs) {
      this.upstreams.set(config.name, {
        config,
        client: null,
        connecting: null,
        error: null,
        tools: [],
      });
    }
  }

  static async start(options: McpBrokerOptions): Promise<McpBroker> {
    const { servers } = normalizeBrokerServers(options.servers);
    const broker = new McpBroker(servers, options, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    await broker.listen();
    return broker;
  }

  /** Loopback base URL (no trailing slash). */
  get baseUrl(): string {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.port}`;
  }

  /** Names of the brokered servers, in configuration order. */
  names(): string[] {
    return this.configs.map((config) => config.name);
  }

  /** Entries to hand to a child's `session/new` (`mcpServers`). */
  sessionServers(): McpServer[] {
    return this.configs.map((config) => ({
      name: config.name,
      type: "http",
      url: `${this.baseUrl}/mcp/${encodeURIComponent(config.name)}`,
      headers: { [MCP_BROKER_TOKEN_HEADER]: this.token },
    }));
  }

  statuses(): McpBrokerStatus[] {
    return this.configs.map((config) => {
      const state = this.upstreams.get(config.name);
      return {
        name: config.name,
        type: config.type,
        connected: Boolean(state?.client),
        connecting: Boolean(state?.connecting && !state?.client),
        // Copy: callers (the panel) mutate their own view objects and must not
        // be able to reach the broker's cached declarations.
        tools: [...(state?.tools ?? [])],
        ...(state?.error ? { error: state.error } : {}),
      };
    });
  }

  /** Coalesce the burst of ensure() transitions (start → connected/failed →
   * tools cached) into one panel refresh so the card updates proactively
   * without flooding the webview with a message per micro-state. */
  private scheduleStatusChange(): void {
    if (this.closed || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      try {
        this.options.onStatusChange?.();
      } catch {
        // A failing panel callback must never destabilize the broker.
      }
    }, 50);
    this.statusTimer.unref?.();
  }

  /**
   * Connect every upstream in the background. Failures are recorded and
   * logged; they do NOT reject — a broken server must not block child spawns,
   * and its failure still surfaces on the first request (and in `statuses()`).
   */
  async prewarm(): Promise<void> {
    await Promise.all(
      this.configs.map((config) =>
        this.ensure(config.name).catch((error: unknown) => {
          this.options.log?.("warn", `MCP broker: ${messageOf(error)}`);
        }),
      ),
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    const closes = [...this.upstreams.values()].map(async (state) => {
      const client = state.client;
      state.client = null;
      if (client) await client.close().catch(() => undefined);
    });
    await Promise.all(closes);
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => this.handleHttp(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  private ensure(name: string): Promise<UpstreamClient> {
    const state = this.upstreams.get(name);
    if (!state) return Promise.reject(new Error(`未知的 MCP 服务器 "${name}"`));
    if (state.client) return Promise.resolve(state.client);
    if (!state.connecting) {
      // Announce "connecting" right away so the card shows a blue dot during
      // a slow handshake instead of a false red failure light.
      this.scheduleStatusChange();
      state.connecting = (async () => {
        const client = createUpstreamClient(state.config, this.timeoutMs, this.options.cwd);
        await client.initialize();
        // Cache the shared upstream's tool declarations ONCE. A `tools/list`
        // failure must not turn a healthy connection into a failure — keep the
        // connection with an honest empty listing (≈0 tokens) and log it.
        try {
          state.tools = toolViewsFromListing(await client.request("tools/list", {}));
        } catch (error) {
          this.options.log?.("warn", `MCP broker: ${name} tools/list 失败：${messageOf(error)}`);
          state.tools = [];
        }
        state.client = client;
        state.error = null;
        this.scheduleStatusChange();
        return client;
      })()
        .catch((error: unknown) => {
          state.connecting = null;
          state.error = messageOf(error);
          this.scheduleStatusChange();
          throw error instanceof Error ? error : new Error(state.error);
        });
    }
    return state.connecting;
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    void this.handleHttpAsync(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: `MCP broker: ${messageOf(error)}` },
        }),
      );
    });
  }

  private async handleHttpAsync(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      // The streamable-HTTP client probes GET for a server→client stream and
      // treats 405 as "no stream" (probed in the vendored bundle), so a plain
      // 405 keeps it quiet instead of logging a connection error.
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    if (request.headers[MCP_BROKER_TOKEN_HEADER] !== this.token) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }
    const url = new URL(request.url ?? "/", this.baseUrl);
    const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const name = decodeURIComponent(match[1] ?? "");
    const body = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("invalid JSON");
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const batch = Array.isArray(parsed);
    const responses: JsonRpcMessage[] = [];
    for (const message of messages) {
      const reply = await this.handleMessage(name, message);
      if (reply) responses.push(reply);
    }
    if (responses.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(batch ? responses : responses[0]));
  }

  private async handleMessage(name: string, raw: unknown): Promise<JsonRpcMessage | null> {
    const message = asRecord(raw) as JsonRpcMessage | null;
    if (!message || typeof message.method !== "string") return null;
    const id = message.id;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) {
      // Notifications are fire-and-forget. `initialized` was already sent to
      // the upstream during the shared handshake, so it is NOT forwarded
      // again; other notifications (e.g. logging/setLevel) are best-effort.
      if (message.method === "notifications/initialized") return null;
      const state = this.upstreams.get(name);
      try {
        state?.client?.notify(message.method, message.params);
      } catch {
        // best-effort
      }
      return null;
    }
    if (!this.upstreams.has(name)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `未知的 MCP 服务器 "${name}"` },
      };
    }
    try {
      if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      const client = await this.ensure(name);
      if (message.method === "initialize") {
        // Stateless gateway: answer from the shared upstream handshake so the
        // second child does not re-initialize the server (MCP forbids it).
        return { jsonrpc: "2.0", id, result: client.initResult };
      }
      const result = await client.request(message.method, message.params);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `MCP 服务器 "${name}" 不可用：${messageOf(error)}` },
      };
    }
  }
}
