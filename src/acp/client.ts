import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
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
  UserQuestionsRequest,
  UserQuestionsResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
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
  /** Timeout for long-lived requests like prompt. 0 = wait indefinitely
   * (default — real agent tasks can run for hours; cancellation is user-
   * driven via `session/cancel`). A positive value re-enables the guard. */
  promptTimeoutMs?: number;
  /** Timeout for control-plane requests (default 60s). */
  requestTimeoutMs?: number;
  wireTap?: WireTap;
  /**
   * Roots the agent's fs callbacks are allowed to touch, in addition to
   * `cwd` (the session dir). Real CLIs legitimately operate on files outside
   * the session dir — multi-root workspaces, a sibling folder the user
   * explicitly approved, `~/.iflow` config — so the boundary is the union of
   * these roots, not the session dir alone. Paths resolving outside every
   * root are rejected (review A1 / AGENTS.md S1).
   */
  allowedRoots?: string[];
}

export interface AcpClientCallbacks {
  onSessionUpdate?: (notification: SessionNotification) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onUnparseableStdout?: (line: string) => void;
  /** Approve/deny tool execution. Default: deny (cancel outcome). */
  onRequestPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  /** iFlow extension: answer the ask_user_question tool. Default: empty
   * answers (the tool reports "no answer" and the agent moves on). */
  onUserQuestions?: (request: UserQuestionsRequest) => Promise<UserQuestionsResponse>;
  /** iFlow extension: Plan-mode approval. Default: reject. */
  onExitPlanMode?: (request: ExitPlanModeRequest) => Promise<ExitPlanModeResponse>;
}

const ACP_PROTOCOL_VERSION = 1;

const execFileP = promisify(execFile);

/**
 * Boundary containment test: is `target` the root itself, or strictly inside
 * it? Uses path.relative so the semantics are correct even at the filesystem
 * root (`/`) and for nested paths. Windows paths are case-insensitive — the
 * CLI's absolute path may use a different drive-letter case than the
 * workspace root (`C:\Repo` vs `c:\repo`), which a startsWith check would
 * spuriously reject.
 */
function isInsideRoot(root: string, target: string): boolean {
  const normalize = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(normalize(root), normalize(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Thrown by AcpClient when an agent-supplied path escapes the session
 * directory boundary (review A1 / AGENTS.md S1). Carries enough detail for
 * the JSON-RPC error reply to tell the agent what was rejected and why.
 */
export class PathBoundaryError extends Error {
  constructor(
    readonly rawPath: string,
    readonly allowedRoots: string[],
  ) {
    super(
      `path outside allowed directories (${allowedRoots.join(", ")}) is not allowed via fs callbacks: ${rawPath}`,
    );
    this.name = "PathBoundaryError";
  }
}

/**
 * Kill the CLI's whole process tree. `child.kill()` only terminates the node
 * root — MCP servers the CLI spawned survive as orphans, still holding the
 * stdio pipes and contending with the NEXT CLI instance's MCP startup
 * (port/file-lock conflicts there produce minute-scale stalls that only show
 * up on profile switches, never on a cold first start).
 */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      await execFileP("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // Already exited (or taskkill unavailable) — fall through to kill().
    }
  }
  child.kill();
}

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
    // R1 (final): no timeout by default — agent tasks can legitimately run
    // for hours. Cancellation is user-driven (`session/cancel`); a positive
    // `promptTimeoutMs` opt-in re-enables the guard.
    return (await this.peer!.request(
      AcpMethods.prompt,
      request,
      this.options.promptTimeoutMs ?? 0,
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
    await killTree(child);
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000))]);
    if (!graceful && child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }

  /**
   * Resolve an agent-supplied path against the session cwd, enforcing a
   * directory boundary (review A1 / AGENTS.md S1):
   * - relative paths are session-cwd relative; `..` traversal that escapes
   *   every allowed root is rejected instead of silently joined;
   * - absolute paths are accepted only when they point inside an allowed
   *   root (the CLI's own tools can still reach anywhere via
   *   `run_shell_command` + approval; that is the documented trust model,
   *   but the fs callbacks must not be an unguarded write-anything channel).
   * The boundary is the union of `cwd` and `options.allowedRoots` — real
   * CLIs legitimately edit files outside the session dir (multi-root
   * workspaces, a sibling folder the user approved, `~/.iflow` config), so
   * confining to the session dir alone would break legitimate flows.
   * Throws a PathBoundaryError so the JSON-RPC layer reports a real error to
   * the agent instead of the write silently landing outside the boundary.
   * Existing paths are realpath'd before comparison (see realpathOrLexical),
   * matching the CLI's own `fullyResolvedPath` — without it, a workspace
   * under macOS's `/tmp` (which realpaths to `/private/tmp`) would have the
   * CLI accept a path this check then rejects. Remaining limitation: the
   * check and the subsequent I/O are not atomic (TOCTOU), so a symlink
   * swapped in between them can still escape; complete isolation requires
   * OS-level containment, out of scope for an editor extension. This guard
   * closes the naive `..`/absolute-path hole.
   */
  private resolveAgentPath(rawPath: string): string {
    const base = this.realpathOrLexical(path.resolve(this.options.cwd));
    const target = path.resolve(this.options.cwd, rawPath);
    const roots = [base, ...(this.options.allowedRoots ?? []).map((r) => this.realpathOrLexical(path.resolve(r)))];
    // Compare on the realpath'd target when it exists; a not-yet-created file
    // (write_file) has no realpath, so fall back to the lexical path. The
    // parent is realpath'd first so `/tmp/new.ts` still matches a root that
    // realpaths to `/private/tmp` (macOS).
    const resolvedTarget = this.realpathOrLexical(target);
    const inside = roots.some((root) => isInsideRoot(root, resolvedTarget));
    if (!inside) throw new PathBoundaryError(rawPath, roots);
    return target;
  }

  /**
   * realpath a path when it exists, else realpath its nearest existing
   * ancestor and re-append the remaining segments. Mirrors the CLI's
   * `fullyResolvedPath` (realpathSync with an ENOENT fallback) so both sides
   * agree on macOS system symlinks (`/tmp` → `/private/tmp`). Never throws:
   * an unresolvable path degrades to the lexical form.
   */
  private realpathOrLexical(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return p;
      try {
        return path.join(this.realpathOrLexical(parent), path.basename(p));
      } catch {
        return p;
      }
    }
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
      const filePath = this.resolveAgentPath(request.path);
      const content = await readFile(filePath, "utf8");
      return { content } satisfies ReadTextFileResponse;
    });

    peer.onRequest(AcpMethods.writeTextFile, async (params) => {
      const request = params as WriteTextFileRequest;
      const filePath = this.resolveAgentPath(request.path);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, request.content, "utf8");
      return {};
    });

    // iFlow extension (probed, CLI 0.5.19): the ask_user_question tool
    // bridges to this request; the response's `answers` map is keyed by
    // question header. Unregistered before → MethodNotFound → the tool
    // failed on every call.
    peer.onRequest(AcpMethods.userQuestions, async (params) => {
      const request = params as UserQuestionsRequest;
      if (this.callbacks.onUserQuestions) return await this.callbacks.onUserQuestions(request);
      return { answers: {} } satisfies UserQuestionsResponse;
    });

    peer.onRequest(AcpMethods.exitPlanMode, async (params) => {
      const request = params as ExitPlanModeRequest;
      if (this.callbacks.onExitPlanMode) return await this.callbacks.onExitPlanMode(request);
      return { approved: false, reason: "Plan approval not supported by this client" } satisfies ExitPlanModeResponse;
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
