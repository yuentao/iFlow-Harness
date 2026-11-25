// @vitest-environment jsdom
/**
 * 前端稳定性回归：提示音上下文 (#1/#8/#9)、错误边界自愈节流 (#12)、
 * 主 snapshot/blockPatch 入站块规范化 (#13)。
 */
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, SessionState } from "../shared/messages";
import { App } from "../webview/src/App";
import { ErrorBoundary } from "../webview/src/components/ErrorBoundary";
import { useChat } from "../webview/src/store";

vi.mock("../webview/src/i18n", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    setLocale: () => {},
    t: (s: string, ...args: Array<string | number>) => {
      let out = s;
      args.forEach((a, i) => { out = out.replaceAll(`{${i}}`, String(a)); });
      return out;
    },
  };
});

declare global {
  // React 19 act() environment flag (react-dom/client in tests).
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  class Obs { observe() {} unobserve() {} disconnect() {} takeRecords(): [] { return []; } }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Obs;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Obs;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function render(ui: ReactNode): void {
  act(() => root.render(ui));
}

// ---------------------------------------------------------------------------
// Web Audio cue: #1 suspended 排程、#8 丢弃 Promise、#9 节点未释放
// ---------------------------------------------------------------------------

class FakeParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
class FakeNode {
  disconnected = false;
  connect(node: unknown) { return node; }
  disconnect() { this.disconnected = true; }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  connectedGain: FakeGain | null = null;
  started = false;
  connect(node: FakeGain) { this.connectedGain = node; return node; }
  start() { this.started = true; }
  stop() {}
}
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state = "suspended";
  currentTime = 123;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  resumeCount = 0;
  private pending: Array<() => void> = [];
  constructor() { FakeAudioContext.last = this; }
  resume() {
    this.resumeCount += 1;
    return new Promise<void>((resolve) => {
      this.pending.push(() => { this.state = "running"; resolve(); });
    });
  }
  resolveResume() {
    const pending = this.pending;
    this.pending = [];
    pending.forEach((fn) => fn());
  }
  createOscillator() {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() { return new FakeGain(); }
}

describe("Web Audio cue", () => {
  it("suspended 时等 resume 完成后才排程，结束后 disconnect 节点", async () => {
    FakeAudioContext.last = null;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    act(() => {
      useChat.getState().applyHostMessage({ type: "playSound", kind: "done" } as never);
    });
    const ctx = FakeAudioContext.last!;
    expect(ctx).toBeTruthy();
    expect(ctx.state).toBe("suspended");
    // unlockAudio 与 playCue 各尝试一次 resume，且 Promise 被消费（无未处理 rejection）
    expect(ctx.resumeCount).toBeGreaterThanOrEqual(1);
    // 修复前：suspended 下立即排程，currentTime 冻结 → 提示音永不响
    expect(ctx.oscillators).toHaveLength(0);

    await act(async () => {
      ctx.resolveResume();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ctx.state).toBe("running");
    expect(ctx.oscillators).toHaveLength(2); // done = 双音

    const osc = ctx.oscillators[0]!;
    const gain = osc.connectedGain!;
    expect(gain).toBeTruthy();
    expect(osc.started).toBe(true);
    expect(typeof osc.onended).toBe("function");
    act(() => osc.onended!());
    expect(osc.disconnected).toBe(true);
    expect(gain.disconnected).toBe(true);
  });

  it("resume 失败时静默降级，不抛出未处理 rejection", async () => {
    FakeAudioContext.last = null;
    class RejectCtx extends FakeAudioContext {
      resume() {
        this.resumeCount += 1;
        // 模拟 context 已 closed：resume() 拒绝（unlockAudio 与 playCue 都调用）
        return Promise.reject(new Error("closed"));
      }
    }
    vi.stubGlobal("AudioContext", RejectCtx);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      await act(async () => {
        useChat.getState().applyHostMessage({ type: "playSound", kind: "done" } as never);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).toHaveLength(0);
      expect(consoleError.mock.calls.filter((a) => String(a[0]).includes("render error"))).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary 自愈节流：#12
// ---------------------------------------------------------------------------

class AlwaysThrows extends Component {
  render(): ReactNode { throw new Error("boom"); }
}
function Healthy(): ReactNode { return <p>ok</p>; }

describe("ErrorBoundary throttling", () => {
  it("病态块持续时按冷却重试，console.error 不刷屏，冷却后仍能自愈", () => {
    vi.useFakeTimers();
    consoleError.mockClear();
    render(<ErrorBoundary resetKey={0}><AlwaysThrows /></ErrorBoundary>);
    expect(container.textContent).toContain("这段内容显示不出来");
    // React 19 自身也会 console.error 报告被捕获的错误，只数边界自己的日志
    const renderErrorCount = () =>
      consoleError.mock.calls.filter((a) => String(a[0]).includes("[iflow] render error")).length;
    expect(renderErrorCount()).toBeGreaterThan(0);

    // 模拟 host 以 ~80ms（12.5/s）推 blockPatch，resetKey 每次都变
    for (let i = 1; i <= 24; i += 1) {
      act(() => { vi.advanceTimersByTime(80); });
      render(<ErrorBoundary resetKey={i}><AlwaysThrows /></ErrorBoundary>);
    }
    expect(container.textContent).toContain("这段内容显示不出来");
    // 修复前：每次 resetKey 变化都清错重抛 → 约 24 次 "[iflow] render error"
    expect(renderErrorCount()).toBeLessThan(5);

    // 冷却窗口过后，下一份健康 snapshot 仍触发自愈重试
    act(() => { vi.advanceTimersByTime(2000); });
    render(<ErrorBoundary resetKey={25}><Healthy /></ErrorBoundary>);
    expect(container.textContent).toContain("ok");
  });
});

// ---------------------------------------------------------------------------
// 主 transcript 入站规范化：#13
// ---------------------------------------------------------------------------

function snapshotState(blocks: unknown[]): SessionState {
  return {
    blocks, status: "idle", errorMessage: null, stopReason: null, sessionId: "s1",
    modes: null, commands: [], skills: [], models: [], currentModelId: null, thinkLevel: "auto",
    pendingApproval: null, pendingQuestions: null, pendingProfileSwitch: null,
    auth: { authenticated: true, needsSetup: false, saved: null, profiles: [], onboardingDismissed: true },
    sessions: [], activeSessionId: null, replaying: false, initializing: false, compressing: false,
    superWaiting: false, superSessions: [],
    queue: [], queuePaused: false, checkpoints: [], nextStepSuggestions: [], nextStepLoading: false,
  } as unknown as SessionState;
}

describe("main transcript sanitize", () => {
  it.each([
    ["缺 text 的 text 块", [{ kind: "text", id: "bad" }]],
    ["缺 text 的 user 块", [{ kind: "user", id: "bad" }]],
    ["未知 kind + 缺字段混合", [
      { kind: "text", id: "ok", text: "hello" },
      { kind: "bogus", id: "x" },
      { kind: "text", id: "bad2" },
    ]],
  ])("snapshot 入站 %s 不再让 block.text.trim() 抛错白屏", (_name, blocks) => {
    const st = useChat.getState();
    act(() => st.applyHostMessage({ type: "snapshot", state: snapshotState(blocks as unknown as Block[]) } as never));
    render(<ErrorBoundary variant="page"><App /></ErrorBoundary>);
    const renderErrors = consoleError.mock.calls.filter((a) => String(a[0]).includes("render error"));
    expect(renderErrors).toHaveLength(0);
    expect(document.body.textContent).not.toContain("界面出错了");
  });

  it("blockPatch 入站缺字段块同样被规范化", () => {
    const st = useChat.getState();
    act(() => st.applyHostMessage({ type: "snapshot", state: snapshotState([]) } as never));
    act(() => st.applyHostMessage({
      type: "blockPatch",
      from: 0,
      blocks: [{ kind: "text", id: "bad" }],
      tail: snapshotState([]),
    } as never));
    render(<ErrorBoundary variant="page"><App /></ErrorBoundary>);
    const renderErrors = consoleError.mock.calls.filter((a) => String(a[0]).includes("render error"));
    expect(renderErrors).toHaveLength(0);
    expect(document.body.textContent).not.toContain("界面出错了");
  });
});
