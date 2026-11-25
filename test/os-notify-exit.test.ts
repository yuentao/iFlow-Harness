import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Control the ChildProcess that runQuiet() spawns without touching the real OS.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

import { runQuiet } from "../src/acp/os-notify.js";

/** Drive runQuiet()'s child through the real Node 'exit' signature (code, signal). */
function driveExit(code: number | null, signal: string | null): Promise<number> {
  const child = new EventEmitter();
  (child as unknown as { kill: (sig: string) => boolean }).kill = () => true;
  spawnMock.mockReturnValueOnce(child);
  const result = runQuiet("fake-notifier", []);
  // Listeners are registered synchronously inside the Promise executor, so the
  // event can be emitted immediately and still be observed.
  child.emit("exit", code, signal);
  return result;
}

describe("runQuiet — child 'exit' argument mapping (mM1)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves 0 when the child exits with code 0", async () => {
    await expect(driveExit(0, null)).resolves.toBe(0);
  });

  it("resolves 1 when the child exits with code 1", async () => {
    await expect(driveExit(1, null)).resolves.toBe(1);
  });

  it("resolves -1 when the child is killed by a signal (code is null)", async () => {
    await expect(driveExit(null, "SIGKILL")).resolves.toBe(-1);
  });
});
