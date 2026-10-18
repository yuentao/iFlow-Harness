import { describe, it, expect, beforeEach } from "vitest";
import {
  TerminalRecorder,
  openInTerminal,
  getTerminalRecorder,
  resetTerminalRecorderForTests,
  resetManagedTerminalForTests,
  TERMINAL_RECORD_MAX,
  TERMINAL_OUTPUT_MAX_CHARS,
  type ShellExecutionLike,
  type ShellExecutionEventSource,
} from "../src/panel/terminal.js";
import { extractRerunnableCommand, MAX_TOOL_INPUT_DISPLAY_CHARS } from "../shared/session-state.js";
import { buildTerminalReport } from "../shared/context-source.js";
import { resetStubTerminals, stubTerminals, type StubTerminal } from "./vscode-stub.js";

/** Let the recorder's async consume loop drain pending microtasks/timers. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Controllable async-iterable output stream for a fake execution. */
function makeStream(): {
  iterable: AsyncIterable<string>;
  push(chunk: string): void;
  end(): void;
} {
  const queue: string[] = [];
  let pending: ((r: IteratorResult<string>) => void) | null = null;
  let done = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const next = queue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              pending = resolve;
            });
          },
        };
      },
    },
    push(chunk: string) {
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    },
    end() {
      done = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: undefined, done: true });
      }
    },
  };
}

function makeExecution(command: string, opts: { cwd?: string } = {}): {
  execution: ShellExecutionLike;
  stream: ReturnType<typeof makeStream>;
} {
  const stream = makeStream();
  const execution: ShellExecutionLike = {
    commandLine: { value: command },
    exitCode: null,
    shellIntegration: opts.cwd ? { cwd: { fsPath: opts.cwd } } : undefined,
    read: () => stream.iterable,
  };
  return { execution, stream };
}

/** Fake event source capturing the recorder's listeners. */
function makeSource(): {
  source: ShellExecutionEventSource;
  fireStart(e: ShellExecutionLike): void;
  fireEnd(e: ShellExecutionLike, exitCode: number | null): void;
} {
  let startListener: ((e: ShellExecutionLike) => void) | null = null;
  let endListener: ((e: ShellExecutionLike) => void) | null = null;
  return {
    source: {
      onStart: (l) => {
        startListener = l;
        return () => {
          startListener = null;
        };
      },
      onEnd: (l) => {
        endListener = l;
        return () => {
          endListener = null;
        };
      },
    },
    fireStart(e) {
      startListener?.(e);
    },
    fireEnd(e, exitCode) {
      e.exitCode = exitCode;
      endListener?.(e);
    },
  };
}

describe("TerminalRecorder", () => {
  it("consumes output incrementally while the command runs (dev-server case)", async () => {
    const { source, fireStart, fireEnd } = makeSource();
    const recorder = new TerminalRecorder(source);
    recorder.attach();
    const { execution, stream } = makeExecution("npm run dev", { cwd: "J:\\proj" });
    fireStart(execution);
    stream.push("VITE ready\n");
    await tick();
    let snap = recorder.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.running).toBe(true);
    expect(snap[0]!.commandLine).toBe("npm run dev");
    expect(snap[0]!.cwd).toBe("J:\\proj");
    expect(snap[0]!.output).toBe("VITE ready\n");
    // A still-running record keeps growing — @terminal can see live output.
    stream.push("hmr update /src/App.tsx\n");
    await tick();
    snap = recorder.snapshot();
    expect(snap[0]!.output).toContain("hmr update");
    expect(snap[0]!.running).toBe(true);
    fireEnd(execution, 0);
    stream.end();
    await tick();
    snap = recorder.snapshot();
    expect(snap[0]!.running).toBe(false);
    expect(snap[0]!.exitCode).toBe(0);
    expect(snap[0]!.endedAt).not.toBeNull();
    recorder.dispose();
  });

  it("keeps the output TAIL under the cap and counts dropped head chars", async () => {
    const { source, fireStart } = makeSource();
    const recorder = new TerminalRecorder(source);
    recorder.attach();
    const { execution, stream } = makeExecution("big");
    fireStart(execution);
    const head = "h".repeat(TERMINAL_OUTPUT_MAX_CHARS - 10);
    stream.push(head);
    stream.push("0123456789ABCDE"); // 15 chars → 5 over the cap
    await tick();
    const record = recorder.snapshot()[0]!;
    expect(record.output).toHaveLength(TERMINAL_OUTPUT_MAX_CHARS);
    expect(record.output.endsWith("0123456789ABCDE")).toBe(true);
    expect(record.droppedChars).toBe(5);
    recorder.dispose();
  });

  it("evicts the oldest records beyond the ring size", async () => {
    const { source, fireStart, fireEnd } = makeSource();
    const recorder = new TerminalRecorder(source);
    recorder.attach();
    for (let i = 0; i < TERMINAL_RECORD_MAX + 5; i++) {
      const { execution, stream } = makeExecution(`cmd-${i}`);
      fireStart(execution);
      stream.end();
      fireEnd(execution, 0);
    }
    await tick();
    const snap = recorder.snapshot();
    expect(snap).toHaveLength(TERMINAL_RECORD_MAX);
    expect(snap[0]!.commandLine).toBe(`cmd-5`);
    expect(snap[snap.length - 1]!.commandLine).toBe(`cmd-${TERMINAL_RECORD_MAX + 4}`);
    recorder.dispose();
  });

  it("recovers buffered output on the end-only channel", async () => {
    let endListener: ((e: ShellExecutionLike) => void) | null = null;
    const recorder = new TerminalRecorder({
      onEnd: (l) => {
        endListener = l;
        return () => {};
      },
    });
    recorder.attach();
    expect(recorder.isAvailable()).toBe(true);
    const { execution, stream } = makeExecution("ls");
    stream.push("a\nb\n");
    stream.end();
    execution.exitCode = 0;
    endListener?.(execution);
    await tick();
    const snap = recorder.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.output).toBe("a\nb\n");
    expect(snap[0]!.exitCode).toBe(0);
    expect(snap[0]!.running).toBe(false);
    recorder.dispose();
  });

  it("reports unavailable when the editor exposes no shell-execution channel", () => {
    const recorder = new TerminalRecorder({});
    expect(recorder.isAvailable()).toBe(false);
    expect(recorder.snapshot()).toEqual([]);
  });

  it("singleton attaches lazily and survives reset (stub has no shell API)", () => {
    resetTerminalRecorderForTests();
    const recorder = getTerminalRecorder();
    expect(recorder.isAvailable()).toBe(false);
    expect(getTerminalRecorder()).toBe(recorder);
    resetTerminalRecorderForTests();
  });
});

describe("openInTerminal", () => {
  beforeEach(() => {
    resetStubTerminals();
    resetManagedTerminalForTests();
  });

  it("creates the iFlow terminal and prefills without executing", () => {
    openInTerminal("npm test", "J:\\proj", false);
    expect(stubTerminals).toHaveLength(1);
    const terminal = stubTerminals[0]!;
    expect(terminal.name).toBe("iFlow");
    expect(terminal.shown).toBe(1);
    expect(terminal.sentTexts).toEqual([{ text: "npm test", shouldExecute: false }]);
  });

  it("reuses the managed terminal and cds when the cwd differs", () => {
    openInTerminal("npm test", "J:\\proj", true);
    const first = stubTerminals[0]!;
    openInTerminal("npm test", "J:\\proj", true);
    expect(stubTerminals).toHaveLength(1);
    expect(first.sentTexts.at(-1)).toEqual({ text: "npm test", shouldExecute: true });
    openInTerminal("ls", "J:\\other", true);
    expect(stubTerminals).toHaveLength(1);
    expect(first.sentTexts.at(-2)).toEqual({ text: 'cd "J:\\other"', shouldExecute: true });
    expect(first.sentTexts.at(-1)).toEqual({ text: "ls", shouldExecute: true });
  });

  it("creates a fresh terminal after the managed one closed", () => {
    openInTerminal("npm test", "J:\\proj", true);
    const first = stubTerminals[0]!;
    (first as { exitStatus?: unknown }).exitStatus = { code: 0 };
    openInTerminal("echo hi", "J:\\proj", true);
    expect(stubTerminals).toHaveLength(2);
    expect(stubTerminals[1]!.sentTexts.at(-1)).toEqual({ text: "echo hi", shouldExecute: true });
  });
});

describe("extractRerunnableCommand", () => {
  it("returns null for missing/empty input", () => {
    expect(extractRerunnableCommand(null)).toBeNull();
    expect(extractRerunnableCommand(undefined)).toBeNull();
    expect(extractRerunnableCommand("   ")).toBeNull();
  });

  it("returns the trimmed command line", () => {
    expect(extractRerunnableCommand("  npm run build  ")).toBe("npm run build");
  });

  it("refuses a capToolInput-truncated command (MAX+1 chars ending in …)", () => {
    const truncated = "x".repeat(MAX_TOOL_INPUT_DISPLAY_CHARS) + "…";
    expect(truncated).toHaveLength(MAX_TOOL_INPUT_DISPLAY_CHARS + 1);
    expect(extractRerunnableCommand(truncated)).toBeNull();
  });

  it("keeps a genuine short command that happens to end in …", () => {
    expect(extractRerunnableCommand("echo …")).toBe("echo …");
  });
});

describe("buildTerminalReport", () => {
  it("renders running and finished entries with meta, tail notice and separators", () => {
    const body = buildTerminalReport([
      {
        commandLine: "npm run dev",
        cwd: "J:\\proj",
        output: "VITE ready\n",
        droppedChars: 0,
        exitCode: null,
        running: true,
      },
      {
        commandLine: "npm test",
        cwd: null,
        output: "  pass  ",
        droppedChars: 120,
        exitCode: 1,
        running: false,
      },
      {
        commandLine: "silent",
        cwd: null,
        output: "",
        droppedChars: 0,
        exitCode: 0,
        running: false,
      },
    ]);
    expect(body).toContain("$ npm run dev");
    expect(body).toContain("（J:\\proj · 仍在运行）");
    expect(body).toContain("VITE ready");
    expect(body).toContain("$ npm test");
    expect(body).toContain("（退出码 1）");
    expect(body).toContain("…（更早的输出已截断，共 120 字符）");
    expect(body).toContain("pass"); // trailing whitespace trimmed
    expect(body).toContain("（无输出）");
    expect(body.split("\n\n---\n\n")).toHaveLength(3);
  });
});
