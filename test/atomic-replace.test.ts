import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAtomic } from "../src/memory/files";
import { ATOMIC_REPLACE_RETRY_DELAYS_MS } from "../src/acp/models-query";

const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-atomic-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Hold `file` open in a CHILD process (Windows refuses to replace an open
 * file → EPERM). The hold is taken out-of-process so the release does not
 * depend on the parent's event loop.
 */
function holdFileOpen(file: string, holdMs: number): {
  opened: Promise<void>;
  closed: Promise<void>;
  release: () => void;
} {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");
       const fd=fs.openSync(process.argv[1],"r");
       process.stdout.write("opened\\n");
       setTimeout(()=>{try{fs.closeSync(fd);}catch{}
         process.stdout.write("closed\\n");},${holdMs});`,
      file,
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  let openedResolve!: () => void;
  let closedResolve!: () => void;
  const opened = new Promise<void>((resolve) => {
    openedResolve = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += String(chunk);
    if (buffer.includes("opened")) openedResolve();
    if (buffer.includes("closed")) closedResolve();
  });
  return {
    opened,
    closed,
    release: () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes("iflow-harness-tmp"));
}

describe("writeAtomic (memory files)", () => {
  it("writes the file when nothing holds it open", async () => {
    const dir = mkdtempSync(path.join(tempDir, "plain-"));
    const file = path.join(dir, "AGENTS.md");
    await writeAtomic(file, "# hello\n");
    expect(readFileSync(file, "utf8")).toBe("# hello\n");
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("recovers once the reader releases the file (the first rename was refused)", async () => {
    const dir = mkdtempSync(path.join(tempDir, "hold-"));
    const file = path.join(dir, "AGENTS.md");
    writeFileSync(file, "# old\n", "utf8");
    const holder = holdFileOpen(file, 120);
    try {
      await holder.opened;
      const started = Date.now();
      await writeAtomic(file, "# new\n");
      // The first rename was refused with EPERM — the write only got
      // through because the retry waited for the holder to let go.
      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
      expect(readFileSync(file, "utf8")).toBe("# new\n");
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      holder.release();
    }
  });

  it("rejects with the original error and keeps the old content when the hold never ends", async () => {
    const dir = mkdtempSync(path.join(tempDir, "stuck-"));
    const file = path.join(dir, "AGENTS.md");
    writeFileSync(file, "# old\n", "utf8");
    const holder = holdFileOpen(file, 60_000);
    try {
      await holder.opened;
      const error = await writeAtomic(file, "# new\n").then(
        () => null,
        (err: unknown) => err as NodeJS.ErrnoException,
      );
      expect(error).not.toBeNull();
      expect(error!.code).toBe("EPERM");
      expect(error!.message).toContain("EPERM");
      // A refused replace never truncates the target.
      expect(readFileSync(file, "utf8")).toBe("# old\n");
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      holder.release();
    }
  }, 20_000);

  it("keeps the retry budget under 1.2s", () => {
    const total = ATOMIC_REPLACE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(1200);
  });
});
