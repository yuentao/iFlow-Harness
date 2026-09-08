import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AcpMethods,
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
} from "./protocol.js";
import { JsonRpcPeer, type WireTap } from "./jsonrpc.js";

export interface AcpClientOptions {
  /** e.g. "node" */
  command: string;
  /** e.g. ["C:/.../entry.js", "--experimental-acp"] */
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Protocol version to advertise in initialize (ACP v1). */
  protocolVersion?: number;
  /** Timeout for long-lived requests like prompt (default 30 min). */
  promptTimeoutMs?: number;
  /** Timeout for control-plane requests (default 60s). */
  requestTimeoutMs?: number;
  wireTap?: WireTap;
}

export interface AcpClientCallbacks {
  onSessionUpdate?: (notification: SessionNotification) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onUnparseableStdout?: (line: string) => void;
  /** Approve/deny tool execution. Default: deny (cancel outcome). */
  onRequestPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

const ACP_PROTOCOL_VERSION = 1;

export class AcpClient {
  private child: ChildProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private initializeResult: InitializeResponse | null = null;
  private stopped = false;

  constructor(
    private readonly options: AcpClientOptions,
    private readonly callbacks: AcpClientCallbacks = {},
  ) {}

  /** Spawn the agent process and complete the initialize handshake. */
  async connect(): Promise<InitializeResponse> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Surface early spawn failures (ENOENT etc.) as a rejected promise.
    child.on("error", (error) => {
      this.failAllPending(`Agent process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.callbacks.onExit?.(code, signal);
      if (!this.stopped) this.failAllPending(`Agent process exited unexpectedly (code=${code}, signal=${signal})`);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // R3: no consumer — skip the per-chunk split entirely.
      const cb = this.callbacks.onStderr;
      if (!cb) return;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) cb(line);
      }
    });

    this.child = child;
    this.peer = new JsonRpcPeer(
      (line) => {
        if (child.stdin?.writable) child.stdin.write(line + "\n");
      },
      this.options.wireTap,
      // R5: surface unparseable stdout lines (banners, noise) to the host.
      (error, rawLine) => this.callbacks.onUnparseableStdout?.(rawLine || error.message),
    );

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.peer!.handleData(chunk));

    this.registerServerRequests();

    const request: InitializeRequest = {
      protocolVersion: this.options.protocolVersion ?? ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    };
    try {
      this.initializeResult = (await this.peer.request(
        AcpMethods.initialize,
        request,
        this.options.requestTimeoutMs ?? 60_000,
      )) as InitializeResponse;
      return this.initializeResult;
    } catch (error) {
      // C5: initialize failed (timeout / handshake error) — the spawned child
      // is still alive with its stdout listeners attached and no owner. Kill
      // it before propagating, or every retry leaks one node process.
      this.stopped = true;
      void this.dispose().catch(() => {});
      throw error;
    }
  }

  getInitializeResult(): InitializeResponse | null {
    return this.initializeResult;
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    // OAuth flows can take minutes (user opens browser and logs in).
    return (await this.peer!.request(AcpMethods.authenticate, request, 5 * 60_000)) as AuthenticateResponse;
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return (await this.peer!.request(AcpMethods.newSession, request, this.options.requestTimeoutMs ?? 120_000)) as NewSessionResponse;
  }

  async loadSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return (await this.peer!.request(AcpMethods.loadSession, request, this.options.requestTimeoutMs ?? 120_000)) as NewSessionResponse;
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    return (await this.peer!.request(
      AcpMethods.prompt,
      request,
      this.options.promptTimeoutMs ?? 30 * 60_000,
    )) as PromptResponse;
  }

  cancel(sessionId: string): void {
    this.peer!.notify(AcpMethods.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return await this.peer!.request(AcpMethods.setMode, { sessionId, modeId });
  }

  async setModel(sessionId: string, modelId: string): Promise<unknown> {
    return await this.peer!.request(AcpMethods.setModel, { sessionId, modelId });
  }

  /** iFlow extension: toggle thinking mode (verified in bundle, probed on wire). */
  async setThink(sessionId: string, thinkEnabled: boolean, thinkConfig?: "think" | "megathink" | "ultrathink"): Promise<unknown> {
    return await this.peer!.request(AcpMethods.setThink, { sessionId, thinkEnabled, ...(thinkConfig ? { thinkConfig } : {}) });
  }

  /** Kill the agent process. Pending requests are rejected. */
  async dispose(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.failAllPending("Client disposed");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000))]);
    if (!graceful && child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }

  /** Resolve agent-supplied paths: relative ones are session-cwd relative. */
  private resolveAgentPath(rawPath: string): string {
    return path.isAbsolute(rawPath) ? rawPath : path.join(this.options.cwd, rawPath);
  }

  private registerServerRequests(): void {
    const peer = this.peer!;

    peer.onNotification(AcpMethods.sessionUpdate, (params) => {
      this.callbacks.onSessionUpdate?.(params as SessionNotification);
    });

    peer.onRequest(AcpMethods.requestPermission, async (params) => {
      // M0 default policy: reject everything (safe for harness runs).
      // Real UI approval flows override this via a callback (plan §4 PermissionService).
      const request = params as RequestPermissionRequest;
      return await this.onRequestPermission(request);
    });

    peer.onRequest(AcpMethods.readTextFile, async (params) => {
      const request = params as ReadTextFileRequest;
      const content = await readFile(this.resolveAgentPath(request.path), "utf8");
      return { content } satisfies ReadTextFileResponse;
    });

    peer.onRequest(AcpMethods.writeTextFile, async (params) => {
      const request = params as WriteTextFileRequest;
      const filePath = this.resolveAgentPath(request.path);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, request.content, "utf8");
      return {};
    });
  }

  private async onRequestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Default: reject everything (safe for harness runs).
    // Real UI approval flows override this via callbacks.onRequestPermission.
    if (this.callbacks.onRequestPermission) return await this.callbacks.onRequestPermission(request);
    return { outcome: { outcome: "cancelled" } };
  }

  private failAllPending(message: string): void {
    this.peer?.rejectAll(message);
  }
}
