/**
 * Integrated-terminal command recording + "open/rerun in terminal".
 *
 * Capture rides VS Code's shell-integration execution API (`onDidStart/
 * onDidEndTerminalShellExecution` + `execution.read()`), finalized in VS Code
 * 1.93. `engines` stays ^1.90.0 and @types/vscode is pinned at 1.90, so the
 * API is runtime-detected through local structural types — on older editors
 * (or with `terminal.integrated.shellIntegration.enabled` off) the recorder
 * reports unavailable and @terminal degrades to an explanatory error instead
 * of guessing.
 *
 * Long-running processes (dev servers): output is consumed INCREMENTALLY from
 * the moment the execution starts, so a still-running command's record keeps
 * growing — @terminal injects the latest tail without waiting for the process
 * to exit. This is the "持续输出订阅" the CLI's own tool executions cannot
 * offer (its child shells are not attachable and die with the tool call).
 *
 * The recorder is an extension-lifetime singleton attached from `activate`
 * (capture must not depend on the chat panel being open); the panel only
 * reads `snapshot()`.
 */
import * as vscode from "vscode";

/** Structural mirror of `vscode.TerminalShellExecution` (VS Code 1.93+). */
export interface ShellExecutionLike {
  commandLine?: { value: string } | string;
  exitCode?: number | null;
  shellIntegration?: { cwd?: { fsPath: string } };
  read?(): AsyncIterable<string>;
}

/** One recorded terminal command (mirrored by shared TerminalCommandEntryUi). */
export interface TerminalCommandRecord {
  commandLine: string;
  cwd: string | null;
  /** Tail-kept output; `droppedChars` counts the evicted head. */
  output: string;
  droppedChars: number;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
}

/** Ring size: @terminal only reads the last few, but scrollback context
 * helps when the user asks about an older command in the same session. */
export const TERMINAL_RECORD_MAX = 20;
/** Per-record output cap (tail kept — dev-server logs: the newest lines are
 * the interesting ones). Same order as MAX_TOOL_OUTPUT_CHARS. */
export const TERMINAL_OUTPUT_MAX_CHARS = 65_536;

type Unsubscribe = () => void;

/**
 * Injectable event source so the recorder's buffer discipline is unit-
 * testable without a VS Code window (same injection style as auth tests).
 */
export interface ShellExecutionEventSource {
  onStart?: (listener: (execution: ShellExecutionLike) => void) => Unsubscribe;
  onEnd?: (listener: (execution: ShellExecutionLike) => void) => Unsubscribe;
}

export class TerminalRecorder {
  private readonly records: TerminalCommandRecord[] = [];
  /** Live mapping for start→end correlation (cleaned on end/eviction). */
  private readonly byExecution = new Map<ShellExecutionLike, TerminalCommandRecord>();
  private unsubscribes: Unsubscribe[] = [];
  private attached = false;

  constructor(private readonly events: ShellExecutionEventSource = defaultEventSource()) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    if (this.events.onStart) {
      this.unsubscribes.push(this.events.onStart((e) => this.handleStart(e)));
    }
    if (this.events.onEnd) {
      this.unsubscribes.push(this.events.onEnd((e) => this.handleEnd(e)));
    }
  }

  dispose(): void {
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch {
        // best-effort teardown
      }
    }
    this.unsubscribes = [];
    this.attached = false;
    this.records.length = 0;
    this.byExecution.clear();
  }

  /** True when the editor exposes at least one shell-execution channel. */
  isAvailable(): boolean {
    return this.events.onStart !== undefined || this.events.onEnd !== undefined;
  }

  /** Chronological copy (oldest first) of the recorded commands. */
  snapshot(): TerminalCommandRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  private handleStart(execution: ShellExecutionLike): void {
    const record = this.pushRecord(execution);
    void this.consume(execution, record);
  }

  private handleEnd(execution: ShellExecutionLike): void {
    let record = this.byExecution.get(execution);
    if (!record) {
      // End-only channel (start missed / API asymmetry): the execution's
      // output stays buffered until read, so the full text is still
      // recoverable here — just not incrementally.
      record = this.pushRecord(execution);
      void this.consume(execution, record);
    }
    record.exitCode = execution.exitCode ?? null;
    record.endedAt = Date.now();
    record.running = false;
    this.byExecution.delete(execution);
  }

  private pushRecord(execution: ShellExecutionLike): TerminalCommandRecord {
    const commandLine =
      typeof execution.commandLine === "string"
        ? execution.commandLine
        : execution.commandLine?.value ?? "";
    const record: TerminalCommandRecord = {
      commandLine,
      cwd: execution.shellIntegration?.cwd?.fsPath ?? null,
      output: "",
      droppedChars: 0,
      exitCode: execution.exitCode ?? null,
      startedAt: Date.now(),
      endedAt: null,
      running: true,
    };
    this.records.push(record);
    if (this.records.length > TERMINAL_RECORD_MAX) {
      const evicted = this.records.shift();
      if (evicted) {
        for (const [key, value] of this.byExecution) {
          if (value === evicted) this.byExecution.delete(key);
        }
      }
    }
    this.byExecution.set(execution, record);
    return record;
  }

  /** Drain `execution.read()` into the record. An evicted record keeps
   * receiving chunks into a detached object — harmless, bounded by the cap. */
  private async consume(execution: ShellExecutionLike, record: TerminalCommandRecord): Promise<void> {
    if (!execution.read) return;
    try {
      for await (const chunk of execution.read()) {
        this.appendOutput(record, chunk);
      }
    } catch {
      // The stream breaks when the terminal is disposed mid-read — keep
      // whatever arrived so far.
    }
  }

  private appendOutput(record: TerminalCommandRecord, chunk: string): void {
    if (!chunk) return;
    record.output += chunk;
    if (record.output.length > TERMINAL_OUTPUT_MAX_CHARS) {
      const drop = record.output.length - TERMINAL_OUTPUT_MAX_CHARS;
      record.output = record.output.slice(drop);
      record.droppedChars += drop;
    }
  }
}

/** Runtime-detect the 1.93 shell-execution events on the live vscode API. */
function defaultEventSource(): ShellExecutionEventSource {
  const w = vscode.window as unknown as {
    onDidStartTerminalShellExecution?: (
      listener: (e: { execution: unknown }) => void,
    ) => { dispose(): void };
    onDidEndTerminalShellExecution?: (
      listener: (e: { execution: unknown }) => void,
    ) => { dispose(): void };
  };
  const source: ShellExecutionEventSource = {};
  if (typeof w.onDidStartTerminalShellExecution === "function") {
    const on = w.onDidStartTerminalShellExecution;
    source.onStart = (listener) => {
      const sub = on.call(w, (e) => listener(e.execution as ShellExecutionLike));
      return () => sub.dispose();
    };
  }
  if (typeof w.onDidEndTerminalShellExecution === "function") {
    const on = w.onDidEndTerminalShellExecution;
    source.onEnd = (listener) => {
      const sub = on.call(w, (e) => listener(e.execution as ShellExecutionLike));
      return () => sub.dispose();
    };
  }
  return source;
}

// --- singleton ----------------------------------------------------------------

let singleton: TerminalRecorder | undefined;

/** Extension-lifetime recorder; attaches on first access (idempotent). */
export function getTerminalRecorder(): TerminalRecorder {
  if (!singleton) {
    singleton = new TerminalRecorder();
    singleton.attach();
  }
  return singleton;
}

/** Test hook: drop the singleton so the next access re-detects the API. */
export function resetTerminalRecorderForTests(): void {
  singleton?.dispose();
  singleton = undefined;
}

// --- open / rerun ---------------------------------------------------------------

const TERMINAL_NAME = "iFlow";

/** The terminal we manage plus the cwd it was last used with (VS Code exposes
 * no way to read a live terminal's cwd, so repeated reruns track it here). */
let managed: { terminal: vscode.Terminal; cwd: string | undefined } | null = null;
let closeListenerInstalled = false;

/** Test hook: forget the managed terminal (stub terminals reset per test). */
export function resetManagedTerminalForTests(): void {
  managed = null;
}

/**
 * Open the command in a real integrated terminal. `execute: false` prefills
 * without a trailing newline (the user reviews and presses Enter); `true`
 * runs it immediately. Reuses a single "iFlow" terminal, emitting a `cd`
 * first when the requested cwd differs from the one it was last used with.
 *
 * Shell semantics caveat: the integrated terminal runs the user's default
 * profile (PowerShell on Windows), which may differ from the shell the CLI
 * used — the command text is passed through verbatim.
 */
export function openInTerminal(command: string, cwd: string | undefined, execute: boolean): void {
  if (!closeListenerInstalled) {
    closeListenerInstalled = true;
    vscode.window.onDidCloseTerminal((closed) => {
      if (managed?.terminal === closed) managed = null;
    });
  }
  if (managed && managed.terminal.exitStatus !== undefined) managed = null;
  let terminal = managed?.terminal;
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
    managed = { terminal, cwd };
  } else if (cwd && managed && managed.cwd !== cwd) {
    terminal.sendText(`cd "${cwd}"`, true);
    managed.cwd = cwd;
  }
  terminal.show();
  terminal.sendText(command, execute);
}
