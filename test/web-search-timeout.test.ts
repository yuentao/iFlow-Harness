import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPageText, searchWeb } from "../src/acp/web-search.js";

type Handler = (...args: any[]) => void;

/**
 * Shared fake-socket state for both node:http and node:https. `request()`
 * returns a request whose `end()` does nothing, so a fetch stays pending
 * until the test explicitly invokes the captured setTimeout callback. That
 * mirrors the old bug's dangerous case: destroy() that emits no 'error'.
 */
const h = vi.hoisted(() => {
  const state: {
    handlers: Record<string, Handler[]>;
    timeoutCb: (() => void) | null;
    destroyCalls: number;
    destroyEmitsError: boolean;
    requests: number;
  } = {
    handlers: {},
    timeoutCb: null,
    destroyCalls: 0,
    destroyEmitsError: true,
    requests: 0,
  };
  const makeReq = () => {
    const req: any = {
      setTimeout(_ms: number, fn: () => void) {
        state.timeoutCb = fn;
        return req;
      },
      on(event: string, fn: Handler) {
        (state.handlers[event] ??= []).push(fn);
        return req;
      },
      destroy() {
        state.destroyCalls += 1;
        if (state.destroyEmitsError) {
          for (const fn of state.handlers["error"] ?? []) fn(new Error("socket hang up"));
        }
        return req;
      },
      end() {
        return req;
      },
    };
    return req;
  };
  const reset = () => {
    state.handlers = {};
    state.timeoutCb = null;
    state.destroyCalls = 0;
    state.destroyEmitsError = true;
    state.requests = 0;
  };
  return { state, makeReq, reset };
});

vi.mock("node:http", () => ({
  request: vi.fn(() => {
    h.state.requests += 1;
    return h.makeReq();
  }),
}));
vi.mock("node:https", () => ({
  request: vi.fn(() => {
    h.state.requests += 1;
    return h.makeReq();
  }),
}));

/** Let pending promise continuations (and one macrotask) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Count how many times each `new Promise(...)` resolves during `run()`. */
function withResolveCounts(
  run: () => Promise<unknown>,
): { promise: Promise<unknown>; counts: () => number[] } {
  const Native = globalThis.Promise as any;
  const counts: number[] = [];
  class CountingPromise extends Native {
    // `await` calls .then() on the promise, which otherwise clones this
    // subclass via Symbol.species and would count the derived promise too.
    static get [Symbol.species]() {
      return Native as PromiseConstructor;
    }
    constructor(executor: any) {
      super((resolve: any, reject: any) => {
        const index = counts.length;
        counts[index] = 0;
        executor(
          (value: any) => {
            counts[index] = (counts[index] ?? 0) + 1;
            resolve(value);
          },
          reject,
        );
      });
    }
  }
  (globalThis as any).Promise = CountingPromise;
  let promise: Promise<unknown>;
  try {
    promise = run();
  } finally {
    // Restore synchronously: only the `new Promise(...)` created while
    // `run()` executes synchronously is instrumented.
    (globalThis as any).Promise = Native;
  }
  return { promise, counts: () => counts.slice() };
}

beforeEach(() => h.reset());

describe("web-search 超时显式 settle", () => {
  it("fetchPageText: destroy() 不产生 error 时，超时回调依然 settle 为 ''", async () => {
    h.state.destroyEmitsError = false;
    const promise = fetchPageText("https://example.test/page", { timeoutMs: 1 });
    expect(h.state.timeoutCb).toBeTypeOf("function");

    h.state.timeoutCb?.();

    await expect(promise).resolves.toBe("");
    expect(h.state.destroyCalls).toBe(1);
  });

  it("fetchPageText: 超时与后续 error 事件并存时只 settle 一次", async () => {
    const { promise, counts } = withResolveCounts(() =>
      fetchPageText("https://example.test/page", { timeoutMs: 1 }),
    );
    h.state.timeoutCb?.();
    // Simulate destroy()'s error event plus an extra late error: both call
    // done(null) again but must be swallowed by the settled guard.
    for (const fn of h.state.handlers["error"] ?? []) fn(new Error("late error"));
    for (const fn of h.state.handlers["error"] ?? []) fn(new Error("even later"));

    await expect(promise).resolves.toBe("");
    expect(counts()).toEqual([1]);
    expect(h.state.destroyCalls).toBe(1);
  });

  it("searchWeb: Bing 与 DDG 都超时仍 settle 为 []，保留回退链", async () => {
    h.state.destroyEmitsError = false;
    const promise = searchWeb("anything", { timeoutMs: 1 });

    await flush();
    expect(h.state.requests).toBe(1);
    h.state.timeoutCb?.(); // Bing

    await flush();
    expect(h.state.requests).toBe(2);
    h.state.timeoutCb?.(); // DuckDuckGo fallback

    await expect(promise).resolves.toEqual([]);
  });

  it("searchWeb: 超时与 error 事件并存时首个引擎只 settle 一次，整体回退为 []", async () => {
    const { promise, counts } = withResolveCounts(() => searchWeb("anything", { timeoutMs: 1 }));

    await flush();
    h.state.timeoutCb?.(); // Bing timeout -> destroy() fires 'error'
    for (const fn of h.state.handlers["error"] ?? []) fn(new Error("late Bing error"));

    await flush();
    h.state.timeoutCb?.(); // DuckDuckGo timeout
    for (const fn of h.state.handlers["error"] ?? []) fn(new Error("late DDG error"));

    await expect(promise).resolves.toEqual([]);
    // Only the first engine's promise is created synchronously inside
    // withResolveCounts; the DDG promise is created after the global is
    // restored, and its settle is proven by searchWeb resolving to [].
    expect(counts()).toEqual([1]);
  });
});
