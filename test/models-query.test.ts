import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATOMIC_REPLACE_RETRY_DELAYS_MS,
  applyThinkingRules,
  mcpScopeOf,
  mergeThinkingRulesIntoFile,
  normalizeModelsUrl,
  parseModelsResponse,
  projectSettingsFor,
  projectSettingsFilePath,
  readActiveEndpoint,
  readMcpServers,
  renameWithRetrySync,
  resolveActiveProfileName,
  retireStaleOAuthCreds,
  sanitizeThinkingRules,
  settingsFilePath,
  thinkingForModelRules,
  updateCliSettings,
} from "../src/acp/models-query";
import {
  deleteKernelApiProfile,
  migrateKernelApiProfiles,
  readKernelApiProfiles,
  setKernelActiveProfile,
  writeKernelApiProfile,
} from "../src/acp/api-profiles";

const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-models-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** How long the cross-process reader polls the settings file (ms). */
const READER_WINDOW_MS = 1200;

function settingsFile(content: unknown): string {
  const file = path.join(tempDir, `settings-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

describe("normalizeModelsUrl", () => {
  it("appends /models once, trimming trailing slashes", () => {
    expect(normalizeModelsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models");
  });

  it("is idempotent when baseUrl already ends with /models", () => {
    expect(normalizeModelsUrl("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("defaults to https when the user-typed baseUrl omits the scheme", () => {
    expect(normalizeModelsUrl("api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("  api.example.com/v1  ")).toBe("https://api.example.com/v1/models");
  });

  it("keeps an explicit http:// scheme (local endpoints)", () => {
    expect(normalizeModelsUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1/models");
  });
});

describe("parseModelsResponse", () => {
  it("parses the OpenAI {data:[{id}]} shape and dedupes", () => {
    expect(
      parseModelsResponse({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }, {}] }),
    ).toEqual(["m1", "m2"]);
  });

  it("accepts the {models:[...]} alt shape with id or name", () => {
    expect(parseModelsResponse({ models: [{ name: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("returns [] for malformed payloads", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: "nope" })).toEqual([]);
    expect(parseModelsResponse([1, 2])).toEqual([]);
  });
});

describe("resolveActiveProfileName", () => {
  it("prefers the kernel pointer (settings.json is the persistence authority)", () => {
    expect(
      resolveActiveProfileName({ currentApiProfile: "商汤" }, "BUZZ"),
    ).toBe("商汤");
    expect(resolveActiveProfileName({ currentApiProfile: "商汤" }, null)).toBe("商汤");
  });

  it("falls back to the panel record when the kernel pointer is absent or blank", () => {
    expect(resolveActiveProfileName({ currentApiProfile: "  " }, "BUZZ")).toBe("BUZZ");
    expect(resolveActiveProfileName({}, "BUZZ")).toBe("BUZZ");
    expect(resolveActiveProfileName(null, "BUZZ")).toBe("BUZZ");
  });

  it("returns null when neither source knows an active profile", () => {
    expect(resolveActiveProfileName({}, null)).toBeNull();
    expect(resolveActiveProfileName(null, null)).toBeNull();
  });
});

describe("updateCliSettings", () => {
  it("merges a multi-key patch and preserves every other field", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      modelName: "keep-me",
      language: "zh-CN",
      apiProfiles: { P: { baseUrl: "https://a/v1", apiKey: "sk-a", modelName: "m" } },
    });
    expect(
      updateCliSettings(
        {
          language: "en-US",
          approvalMode: "smart",
          mcpServers: { figma: { command: "npx", args: ["-y", "figma-mcp"] } },
        },
        file,
      ),
    ).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.language).toBe("en-US");
    expect(after.approvalMode).toBe("smart");
    expect(after.mcpServers.figma.args).toEqual(["-y", "figma-mcp"]);
    // Untouched fields survive the read-modify-write.
    expect(after.modelName).toBe("keep-me");
    expect(after.selectedAuthType).toBe("openai-compatible");
    expect(after.apiProfiles.P.baseUrl).toBe("https://a/v1");
    expect(existsSync(`${file}.iflow-harness-tmp`)).toBe(false);
  });

  it("returns false for a missing/unreadable settings file", () => {
    expect(updateCliSettings({ language: "zh-CN" }, path.join(tempDir, "missing.json"))).toBe(false);
  });

  it("keeps mcpServers / tokensLimit and every other key when only apiProfiles is patched", () => {
    // The regression: a write that loses the user's mcpServers / tokensLimit
    // made the settings page show "尚未配置 MCP 服务器" and the CLI fall back
    // to its hard-coded context ceiling.
    const file = settingsFile({
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha"] },
        beta: { command: "npx", args: ["-y", "beta"] },
      },
      tokensLimit: 1000000,
      compressionTokenThreshold: 0.9,
      contextWindowLength: 1000000,
      language: "zh-CN",
      approvalMode: "default",
      apiProfiles: { existing: { baseUrl: "https://e/v1", apiKey: "sk-e", modelName: "m-e" } },
    });

    expect(
      updateCliSettings(
        { apiProfiles: { work: { baseUrl: "https://w/v1", apiKey: "sk-w", modelName: "m-w" } } },
        file,
      ),
    ).toBe(true);

    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["alpha", "beta"]);
    expect(after.mcpServers.alpha.args).toEqual(["-y", "alpha"]);
    expect(after.tokensLimit).toBe(1000000);
    expect(after.compressionTokenThreshold).toBe(0.9);
    expect(after.contextWindowLength).toBe(1000000);
    expect(after.language).toBe("zh-CN");
    expect(after.approvalMode).toBe("default");
    expect(Object.keys(after.apiProfiles)).toEqual(["work"]);
  });

  it("replaces the file atomically — never unlinks the target, uses a unique temp path", () => {
    // Source guard: the old implementation did `unlink(file)` before
    // `rename(tmp, file)`, which opened a window in which settings.json did
    // not exist at all. A concurrent reader (the CLI's own saveSettings)
    // saw "no file", treated the disk as empty and rewrote the whole file
    // without the user's mcpServers / tokensLimit / language / approvalMode.
    const source = readFileSync(
      fileURLToPath(new URL("../src/acp/models-query.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("export function updateCliSettings(");
    const end = source.indexOf("export function readActiveEndpoint(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).not.toContain("unlinkSync(file)");
    // The replace goes through the retrying helper — on Windows the plain
    // rename is refused with EPERM while any handle is open on the target.
    // (The third argument is the optional test seam for the injected
    // rename; production callers leave it unset.)
    expect(body).toContain("renameWithRetrySync(tmp, file");
    expect(body).toContain("options?.rename");
    // A per-writer unique temp path (pid + timestamp + counter) so two
    // concurrent writers never share (and clobber) one temp file.
    expect(body).toContain("uniqueTmpPath(file)");
    expect(source).toContain("process.pid");
    // The helper exists and is shared with the other atomic writer.
    expect(source).toContain("export function renameWithRetrySync(");
    expect(source).toContain("export async function renameWithRetry(");
  });

  it("never exposes a missing or half-written settings file to a concurrent reader", async () => {
    const file = settingsFile({
      mcpServers: { figma: { command: "npx" } },
      tokensLimit: 1000000,
      language: "zh-CN",
    });

    // A separate process polls the file while we rewrite it over and over.
    // The reader counts ENOENT (the file vanished) as a failure — that is
    // exactly the window the old `unlink + rename` sequence opened.
    // NOTE: the old window is only microseconds wide, so this is an
    // INVARIANT PROBE, not a deterministic reproduction of the old bug —
    // the source guard above is the deterministic regression guard.
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const f=process.argv[1];let miss=0,bad=0,ok=0;
         const end=Date.now()+${READER_WINDOW_MS};
         while(Date.now()<end){
           try{const s=fs.readFileSync(f,"utf8");JSON.parse(s);ok++;}
           catch(e){if(e.code==="ENOENT")miss++;else if(e.code!=="EPERM"&&e.code!=="EBUSY")bad++;}
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
         }
         process.stdout.write(JSON.stringify({miss:miss,bad:bad,ok:ok}));`,
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const report = new Promise<string>((resolve, reject) => {
      let out = "";
      reader.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      reader.on("error", reject);
      reader.on("close", () => resolve(out));
    });

    let written = 0;
    for (let i = 0; i < 80; i += 1) {
      const ok = updateCliSettings(
        { apiProfiles: { P: { baseUrl: `https://p${i}.example/v1`, apiKey: "sk-p", modelName: "m" } } },
        file,
      );
      if (ok) written += 1;
      // A concurrent reader holding the file open can make the FIRST rename
      // attempt fail with a Windows sharing violation (EPERM) — the atomic
      // replace retries with a short backoff and recovers it. Even if the
      // hold outlasted the whole retry budget, the PREVIOUS content would
      // stay intact, which is the guarantee that matters: no key is ever
      // dropped.
    }
    const stats = JSON.parse(await report) as { miss: number; bad: number; ok: number };

    expect(stats.miss).toBe(0); // the file was never observably missing
    expect(stats.bad).toBe(0); // the reader never saw a half-written file
    expect(stats.ok).toBeGreaterThan(0); // the reader really did observe the file
    // Every write went through — the reader's transient EPERM is absorbed by
    // the retry, so the user's edit is not silently dropped any more.
    expect(written).toBe(80);
    // No temp file is left behind (the temp name is unique per write).
    expect(readdirSync(path.dirname(file)).filter((n) => n.includes("iflow-harness-tmp"))).toEqual([]);
    // The key promise of the whole fix: no key is lost by the rewrite.
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.mcpServers.figma.command).toBe("npx");
    expect(after.tokensLimit).toBe(1000000);
    expect(after.language).toBe("zh-CN");
    expect(after.apiProfiles.P.baseUrl).toMatch(/^https:\/\/p\d+\.example\/v1$/);
    // Generous timeout: a write whose rename is refused waits out the whole
    // retry budget (~1.1s) before it can report the failure.
  }, 60_000);
});

/**
 * Windows file-in-use behaviour (probed on win32): replacing an existing
 * file with `rename` is REFUSED with EPERM while any handle is open on the
 * target — even a plain read handle (`fs.openSync(file, "r")`), because
 * replacing a file means deleting the old one and Windows refuses to delete
 * an open file. The refusal is transient, so the atomic replace retries with
 * a short backoff instead of losing the write.
 *
 * The hold is taken by a CHILD process on purpose: the sync retry parks the
 * parent's event loop (Atomics.wait), so an in-process timer could not
 * release the handle while the retry is running.
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

/** A settings file in its own directory (so the temp-file checks are precise). */
function isolatedSettingsFile(content: unknown): string {
  const dir = mkdtempSync(path.join(tempDir, "hold-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes("iflow-harness-tmp"));
}

/**
 * Windows refuses to replace an open file (`rename` → EPERM) because
 * replacing a file means deleting the old one, and Windows will not delete
 * an open file. POSIX has no such rule: `rename(2)` replaces a file another
 * process still holds open, without complaint.
 *
 * So the hold-based cases below only have a premise on Windows. On
 * macOS/Linux the "first rename was refused" never happens and the case
 * would assert nothing, so it is skipped there — and the portable cases
 * that follow drive the very same contract through an injected `rename`,
 * so the retry / visible-failure behaviour is verified on EVERY platform.
 */
const itWindows = it.skipIf(process.platform !== "win32");

/** Run `fn` and return the thrown error (fails the test when it does not throw). */
function captureError(fn: () => void): NodeJS.ErrnoException {
  try {
    fn();
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

describe("atomic replace retry (Windows file-in-use)", () => {
  itWindows("succeeds once the reader releases the file (the first rename was refused)", async () => {
    const file = isolatedSettingsFile({
      mcpServers: { figma: { command: "npx" } },
      language: "zh-CN",
    });
    const holder = holdFileOpen(file, 120);
    try {
      await holder.opened; // the target is really occupied now
      const started = Date.now();
      const ok = updateCliSettings({ language: "en-US" }, file);
      const elapsed = Date.now() - started;
      expect(ok).toBe(true);
      // The first attempt was refused with EPERM — the write only got
      // through because the retry waited for the holder to let go.
      expect(elapsed).toBeGreaterThanOrEqual(15);
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect(after.language).toBe("en-US");
      expect(after.mcpServers.figma.command).toBe("npx"); // nothing else lost
      expect(tmpLeftovers(path.dirname(file))).toEqual([]);
    } finally {
      holder.release();
    }
  });

  itWindows("fails VISIBLY and keeps the previous content when the hold never ends", async () => {
    const file = isolatedSettingsFile({
      mcpServers: { figma: { command: "npx" } },
      language: "zh-CN",
    });
    const holder = holdFileOpen(file, 60_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await holder.opened;
      const ok = updateCliSettings({ language: "en-US" }, file);
      // Not a silent success: the panel turns `false` into the
      // "无法写入内核配置 {0}" toast, so the user sees the failed save.
      expect(ok).toBe(false);
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect(after.language).toBe("zh-CN"); // previous content intact
      expect(after.mcpServers.figma.command).toBe("npx");
      expect(tmpLeftovers(path.dirname(file))).toEqual([]); // no temp file left behind
      // The original error is not swallowed either — code + message reach
      // the host log, so EPERM can be told apart from a permission problem.
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("EPERM");
    } finally {
      warn.mockRestore();
      holder.release();
    }
  });

  itWindows("throws the ORIGINAL error (code + message) when the retry budget runs out", async () => {
    const file = isolatedSettingsFile({ language: "zh-CN" });
    const holder = holdFileOpen(file, 60_000);
    try {
      await holder.opened;
      const tmp = path.join(path.dirname(file), "tmp.json");
      writeFileSync(tmp, "{}", "utf8");
      const error = captureError(() => renameWithRetrySync(tmp, file));
      // The very error the OS raised — not a generic "write failed".
      expect(error.code).toBe("EPERM");
      expect(error.message).toContain("EPERM");
      expect(error.message).toContain("settings.json");
      // The target is untouched: a refused replace never truncates it.
      expect(JSON.parse(readFileSync(file, "utf8")).language).toBe("zh-CN");
    } finally {
      holder.release();
    }
  });

  it("rethrows a non-retryable error immediately, without retrying", () => {
    let attempts = 0;
    const error = captureError(() =>
      renameWithRetrySync("tmp", "target", {
        rename: () => {
          attempts += 1;
          const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
          err.code = "ENOENT";
          throw err;
        },
      }),
    );
    expect(attempts).toBe(1); // exactly one attempt — no backoff was paid
    expect(error.code).toBe("ENOENT");
  });

  it("rethrows a real non-retryable error immediately (missing temp file)", () => {
    const dir = mkdtempSync(path.join(tempDir, "missing-"));
    const started = Date.now();
    const error = captureError(() =>
      renameWithRetrySync(path.join(dir, "nope.tmp"), path.join(dir, "target.json")),
    );
    expect(error.code).toBe("ENOENT");
    // No backoff was paid: the call returns in well under the first delay.
    expect(Date.now() - started).toBeLessThan(ATOMIC_REPLACE_RETRY_DELAYS_MS[0]!);
  });

  it("retries a transient failure and then succeeds", () => {
    let attempts = 0;
    renameWithRetrySync("tmp", "target", {
      delaysMs: [1, 2, 3],
      rename: () => {
        attempts += 1;
        if (attempts < 3) {
          const err: NodeJS.ErrnoException = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        }
      },
    });
    expect(attempts).toBe(3);
  });

  // --- portable counterparts of the Windows-only cases above ---------------
  // The rename is INJECTED so the transient refusal can be produced on every
  // platform. On POSIX a rename over an open file succeeds, so the real
  // file-in-use premise simply cannot be reproduced there — but the
  // behaviour under test (retry → recover / retry → visible failure) is
  // platform-independent and must be verified everywhere.

  it("recovers once the transient refusal clears (portable: injected rename)", () => {
    const file = isolatedSettingsFile({
      mcpServers: { figma: { command: "npx" } },
      language: "zh-CN",
    });
    let attempts = 0;
    const ok = updateCliSettings({ language: "en-US" }, file, {
      rename: (from, to) => {
        attempts += 1;
        if (attempts <= 2) {
          const err: NodeJS.ErrnoException = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        }
        renameSync(from, to);
      },
    });
    expect(ok).toBe(true);
    // Two refusals were absorbed by the retry, the third attempt went through.
    expect(attempts).toBe(3);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.language).toBe("en-US");
    expect(after.mcpServers.figma.command).toBe("npx"); // nothing else lost
    expect(tmpLeftovers(path.dirname(file))).toEqual([]);
  });

  it("fails VISIBLY and keeps the previous content when every replace is refused (portable: injected rename)", () => {
    const file = isolatedSettingsFile({
      mcpServers: { figma: { command: "npx" } },
      language: "zh-CN",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = updateCliSettings({ language: "en-US" }, file, {
        rename: () => {
          const err: NodeJS.ErrnoException = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        },
      });
      // Not a silent success: the panel turns `false` into the
      // "无法写入内核配置 {0}" toast, so the user sees the failed save.
      expect(ok).toBe(false);
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect(after.language).toBe("zh-CN"); // previous content intact
      expect(after.mcpServers.figma.command).toBe("npx");
      expect(tmpLeftovers(path.dirname(file))).toEqual([]); // no temp file left behind
      // The original error is not swallowed either — code + message reach
      // the host log, so EPERM can be told apart from a permission problem.
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("EPERM");
    } finally {
      warn.mockRestore();
    }
  }, 20_000);

  it("surfaces the ORIGINAL error (code + message) once the retry budget is exhausted (portable: injected rename)", () => {
    const dir = mkdtempSync(path.join(tempDir, "budget-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ language: "zh-CN" }), "utf8");
    const tmp = path.join(dir, "tmp.json");
    writeFileSync(tmp, "{}", "utf8");
    let attempts = 0;
    const error = captureError(() =>
      renameWithRetrySync(tmp, file, {
        rename: () => {
          attempts += 1;
          const err: NodeJS.ErrnoException = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        },
      }),
    );
    // One attempt per scheduled delay, plus the last one that exhausts the budget.
    expect(attempts).toBe(ATOMIC_REPLACE_RETRY_DELAYS_MS.length + 1);
    // The very error the OS raised — not a generic "write failed".
    expect(error.code).toBe("EPERM");
    expect(error.message).toContain("EPERM");
    // The target is untouched: a refused replace never truncates it.
    expect(JSON.parse(readFileSync(file, "utf8")).language).toBe("zh-CN");
  }, 20_000);

  it("keeps the sync backoff budget under 1.2s (the host is single-threaded)", () => {
    const total = ATOMIC_REPLACE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(1200);
    expect(ATOMIC_REPLACE_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
  });

  it("retries the thinking-rules write too (same temp+rename pattern)", async () => {
    const dir = mkdtempSync(path.join(tempDir, "rules-"));
    const file = path.join(dir, "thinking-models.json");
    writeFileSync(file, JSON.stringify({ rules: [] }), "utf8");
    const holder = holdFileOpen(file, 120);
    try {
      await holder.opened;
      const result = applyThinkingRules(
        [{ pattern: "gemini-.*", supportsThinking: true }],
        file,
      );
      expect(result.added).toBe(1);
      expect(result.skippedInvalid).toBeUndefined();
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      holder.release();
    }
  });
});

describe("project-scope MCP settings", () => {
  const unique = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2)}`;

  it("points at <cwd>/.iflow/settings.json, and nowhere when cwd IS the home dir", () => {
    const cwd = path.join(tempDir, unique("ws"));
    expect(projectSettingsFilePath(cwd)).toBe(path.join(cwd, ".iflow", "settings.json"));
    expect(projectSettingsFor(cwd)).toBe(path.join(cwd, ".iflow", "settings.json"));
    expect(projectSettingsFor(null)).toBeNull();
    // The CLI skips its Workspace file there too; without the guard we would
    // write a "project" settings.json into the user's home directory.
    expect(projectSettingsFor(homedir())).toBeNull();
  });

  it("creates the project file (and its .iflow dir) only with createIfMissing", () => {
    const file = projectSettingsFilePath(path.join(tempDir, unique("proj")));
    expect(existsSync(file)).toBe(false);
    expect(updateCliSettings({ mcpServers: { a: { command: "node" } } }, file)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(
      updateCliSettings({ mcpServers: { a: { command: "node" } } }, file, { createIfMissing: true }),
    ).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.a.command).toBe("node");
    expect(existsSync(`${file}.iflow-harness-tmp`)).toBe(false);
  });

  it("never clobbers a file that exists but cannot be parsed", () => {
    const broken = path.join(tempDir, `${unique("broken")}.json`);
    writeFileSync(broken, "{oops", "utf8");
    expect(updateCliSettings({ mcpServers: {} }, broken, { createIfMissing: true })).toBe(false);
    expect(readFileSync(broken, "utf8")).toBe("{oops");
    expect(readMcpServers(broken)).toBeNull();
  });

  it("reads one scope's dict: absent file is empty, broken file is null", () => {
    expect(readMcpServers(null)).toEqual({});
    expect(readMcpServers(path.join(tempDir, "absent.json"))).toEqual({});
    expect(readMcpServers(settingsFile({ mcpServers: { a: { command: "node" } }, language: "zh-CN" }))).toEqual({
      a: { command: "node" },
    });
    // A settings file without the field is an empty dict, not an error.
    expect(readMcpServers(settingsFile({ language: "zh-CN" }))).toEqual({});
  });
});

describe("mcpScopeOf", () => {
  it("labels a name by the scope(s) declaring it", () => {
    expect(mcpScopeOf("a", { a: {} }, null)).toBe("global");
    expect(mcpScopeOf("a", {}, { a: {} })).toBe("project");
    // Same name in both files: the CLI merge lets the project entry win.
    expect(mcpScopeOf("a", { a: {} }, { a: {} })).toBe("both");
  });

  it("never fabricates a scope for a name neither file declares", () => {
    expect(mcpScopeOf("plugin-provided", {}, {})).toBeUndefined();
    expect(mcpScopeOf("plugin-provided", { other: {} }, null)).toBeUndefined();
  });
});

describe("readActiveEndpoint", () => {
  it("uses the current profile's baseUrl/apiKey/modelName", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "BUZZ",
      apiProfiles: {
        BUZZ: { baseUrl: "https://buzz.example.com/v1", apiKey: "sk-buzz", modelName: "glm-x" },
        Other: { baseUrl: "https://other.example.com/v1", apiKey: "sk-o", modelName: "m-o" },
      },
    });
    expect(readActiveEndpoint(file)).toEqual({
      baseUrl: "https://buzz.example.com/v1",
      apiKey: "sk-buzz",
      modelName: "glm-x",
    });
  });

  it("falls back to top-level fields when no profile is active", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    });
    expect(readActiveEndpoint(file)).toEqual({
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    });
  });

  it("returns null for non-openai-compatible auth or missing credentials", () => {
    expect(readActiveEndpoint(settingsFile({ selectedAuthType: "iflow" }))).toBeNull();
    expect(readActiveEndpoint(settingsFile({ selectedAuthType: "openai-compatible" }))).toBeNull();
    expect(readActiveEndpoint(path.join(tempDir, "missing.json"))).toBeNull();
  });
});

describe("kernel API profile store", () => {
  const kernelFile = (): string =>
    path.join(tempDir, `kernel-${Math.random().toString(36).slice(2)}.json`);
  const creds = (suffix: string) => ({
    baseUrl: `https://${suffix}.example.com/v1`,
    apiKey: `sk-${suffix}`,
    modelName: `m-${suffix}`,
  });

  it("reads only complete profiles", () => {
    const file = settingsFile({
      apiProfiles: {
        work: creds("work"),
        incomplete: { baseUrl: "https://x/v1", apiKey: "sk-x" },
        blank: { baseUrl: "", apiKey: "sk", modelName: "m" },
      },
    });
    expect(readKernelApiProfiles(file)).toEqual({ work: creds("work") });
    expect(readKernelApiProfiles(path.join(tempDir, "missing-kernel.json"))).toEqual({});
  });

  it("writes one profile and preserves mcpServers/language/other profiles", () => {
    const file = settingsFile({
      language: "zh-CN",
      mcpServers: { figma: { command: "npx", args: ["-y", "figma-mcp"] } },
      apiProfiles: { existing: creds("existing") },
    });
    expect(writeKernelApiProfile("work", creds("work"), file)).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.apiProfiles).toEqual({
      existing: creds("existing"),
      work: creds("work"),
    });
    expect(after.language).toBe("zh-CN");
    expect(after.mcpServers.figma.args).toEqual(["-y", "figma-mcp"]);
    expect(existsSync(`${file}.iflow-harness-tmp`)).toBe(false);
  });

  it("creates a missing file when writing", () => {
    const file = kernelFile();
    expect(writeKernelApiProfile("work", creds("work"), file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).apiProfiles.work).toEqual(creds("work"));
  });

  it("deletes one profile and leaves the others alone", () => {
    const file = settingsFile({
      apiProfiles: { keep: creds("keep"), drop: creds("drop") },
    });
    expect(deleteKernelApiProfile("drop", file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).apiProfiles).toEqual({ keep: creds("keep") });
    // Missing file / unknown name are no-ops (nothing to delete).
    expect(deleteKernelApiProfile("drop", kernelFile())).toBe(true);
    expect(deleteKernelApiProfile("unknown", file)).toBe(true);
  });

  it("sets and clears the kernel active pointer, keeping other fields", () => {
    const file = settingsFile({ language: "en-US", apiProfiles: { work: creds("work") } });
    expect(setKernelActiveProfile("work", file)).toBe(true);
    let after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.currentApiProfile).toBe("work");
    expect(after.language).toBe("en-US");
    expect(setKernelActiveProfile(null, file)).toBe(true);
    after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.currentApiProfile).toBeUndefined();
    expect(after.apiProfiles.work).toEqual(creds("work"));
  });

  it("migrates missing names only and never overwrites a same-named kernel entry", () => {
    const file = settingsFile({ apiProfiles: { work: creds("kernel") } });
    const migrated = migrateKernelApiProfiles(
      { work: creds("legacy"), personal: creds("personal") },
      file,
    );
    expect(migrated).toEqual(["personal"]);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.apiProfiles.work).toEqual(creds("kernel"));
    expect(after.apiProfiles.personal).toEqual(creds("personal"));
  });

  it("migrates into a missing file", () => {
    const file = kernelFile();
    expect(migrateKernelApiProfiles({ work: creds("work") }, file)).toEqual(["work"]);
    expect(JSON.parse(readFileSync(file, "utf8")).apiProfiles.work).toEqual(creds("work"));
  });

  it("never overwrites an existing but unparseable kernel file", () => {
    const file = path.join(tempDir, `kernel-broken-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, "{oops", "utf8");
    expect(writeKernelApiProfile("work", creds("work"), file)).toBe(false);
    expect(deleteKernelApiProfile("work", file)).toBe(false);
    expect(migrateKernelApiProfiles({ work: creds("work") }, file)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });
});

describe("retireStaleOAuthCreds", () => {
  it("archives an expired token aside (reversibly) and reports the archive path", () => {
    const file = settingsFile({ access_token: "dead", expiry_date: 1000 });
    const archived = retireStaleOAuthCreds(2000, file);
    expect(archived).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
    // Reversible: the content survives in the archive.
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).access_token).toBe("dead");
  });

  it("leaves a token with a future expiry_date untouched", () => {
    const file = settingsFile({ access_token: "alive", expiry_date: 99999999999999 });
    expect(retireStaleOAuthCreds(1000, file)).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it("archives a cache without an expiry field (getTokenInfo would still stall)", () => {
    const file = settingsFile({ access_token: "no-expiry" });
    expect(retireStaleOAuthCreds(1000, file)).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
  });

  it("overwrites a previous .bak archive (rename replaces the target file)", () => {
    const file = settingsFile({ access_token: "fresh-stale", expiry_date: 0 });
    writeFileSync(`${file}.bak`, "previous archive", "utf8");
    expect(retireStaleOAuthCreds(5000, file)).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
    // The new archive replaced the old one — previous content was stale too.
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).access_token).toBe("fresh-stale");
  });

  it("returns null for missing or unparseable files (no stall, no touch)", () => {
    expect(retireStaleOAuthCreds(1000, path.join(tempDir, "missing-oauth.json"))).toBeNull();
    const corrupt = path.join(tempDir, "corrupt-oauth.json");
    writeFileSync(corrupt, "{not json", "utf8");
    expect(retireStaleOAuthCreds(1000, corrupt)).toBeNull();
    expect(existsSync(corrupt)).toBe(true);
  });
});

describe("sanitizeThinkingRules", () => {
  it("drops junk entries and dedupes by pattern (first wins)", () => {
    expect(
      sanitizeThinkingRules([
        { pattern: "glm-", supportsThinking: true },
        { pattern: "  ", supportsThinking: true },
        { pattern: "no-flag" },
        { pattern: "glm-", supportsThinking: false },
        { pattern: "[", supportsThinking: true },
        "junk",
      ]),
    ).toEqual([{ pattern: "glm-", supportsThinking: true }]);
  });

  it("filters unknown levels and clamps maxThinkingTokens", () => {
    expect(
      sanitizeThinkingRules([
        {
          pattern: "x",
          supportsThinking: true,
          supportedReasoningLevels: ["low", "ultra", "high"],
          maxThinkingTokens: 1234.7,
        },
      ]),
    ).toEqual([
      {
        pattern: "x",
        supportsThinking: true,
        supportedReasoningLevels: ["low", "high"],
        maxThinkingTokens: 1234,
      },
    ]);
  });
});

describe("thinkingForModelRules", () => {
  it("first match wins, case-insensitively (loader semantics)", () => {
    const rules = [
      { pattern: "glm-", supportsThinking: true },
      { pattern: "GLM-4", supportsThinking: false },
    ];
    expect(thinkingForModelRules("GLM-4.6-air", rules)).toBe(true);
  });

  it("a supportsThinking:false rule gives positive evidence", () => {
    expect(thinkingForModelRules("PandoraCoder", [{ pattern: "PandoraCoder", supportsThinking: false }])).toBe(false);
  });

  it("returns undefined when nothing matches (unknown, not unsupported)", () => {
    expect(thinkingForModelRules("mystery-model", [{ pattern: "^o[34]", supportsThinking: true }])).toBeUndefined();
  });
});

describe("mergeThinkingRulesIntoFile", () => {
  it("appends missing patterns and preserves other keys/rules", () => {
    const existing = {
      version: 1,
      modelAliases: { a: "b" },
      models: [{ pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { x: 1 } } }],
    };
    const merged = mergeThinkingRulesIntoFile(existing, [{ pattern: "deepseek-r1", supportsThinking: true }]);
    expect(merged!.file.modelAliases).toEqual({ a: "b" });
    expect(merged!.added).toBe(1);
    expect(merged!.changed).toBe(0);
    expect(merged!.file.models).toEqual([
      { pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { x: 1 } } },
      { pattern: "deepseek-r1", supportsThinking: true },
    ]);
  });

  it("updates gate-only entries in place only when fields differ", () => {
    const existing = { models: [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low"] }] };
    const same = mergeThinkingRulesIntoFile(existing, [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low"] }]);
    expect(same!.added + same!.changed).toBe(0);
    const edited = mergeThinkingRulesIntoFile(existing, [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low", "high"] }]);
    expect(edited!.changed).toBe(1);
    expect(edited!.file.models).toEqual([{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low", "high"] }]);
    // Loader-default levels equivalence: absent array == ["low","medium","high"].
    const defaulted = mergeThinkingRulesIntoFile(
      { models: [{ pattern: "y", supportsThinking: true }] },
      [{ pattern: "y", supportsThinking: true, supportedReasoningLevels: ["low", "medium", "high"] }],
    );
    expect(defaulted!.added + defaulted!.changed).toBe(0);
  });

  it("never touches DSL-bearing entries with the same pattern (no append, no replace)", () => {
    const existing = { models: [{ pattern: "glm-", supportsThinking: true, nonThinkingRequest: { delete: ["thinking"] } }] };
    const merged = mergeThinkingRulesIntoFile(existing, [{ pattern: "glm-", supportsThinking: false }]);
    expect(merged!.added + merged!.changed).toBe(0);
    expect(merged!.file.models).toEqual(existing.models);
  });

  it("returns null for non-object existing content (caller must not write)", () => {
    expect(mergeThinkingRulesIntoFile("not json", [{ pattern: "x", supportsThinking: true }])).toBeNull();
    expect(mergeThinkingRulesIntoFile([{ a: 1 }], [{ pattern: "x", supportsThinking: true }])).toBeNull();
  });
});

describe("applyThinkingRules", () => {
  it("creates a missing file carrying the sanitized rules", () => {
    const file = path.join(tempDir, "thinking-create.json");
    const result = applyThinkingRules([{ pattern: "^o[34]", supportsThinking: true }], file);
    expect(result).toEqual({ added: 1, changed: 0, created: true });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.models).toEqual([{ pattern: "^o[34]", supportsThinking: true }]);
  });

  it("merges into an existing template-like file, preserving its rules and keys", () => {
    const file = path.join(tempDir, "thinking-merge.json");
    writeFileSync(
      file,
      JSON.stringify({ description: "tpl", version: 1, models: [{ pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { a: 1 } } }] }),
      "utf8",
    );
    const result = applyThinkingRules(
      sanitizeThinkingRules([{ pattern: "deepseek-(r1|reasoner)", supportsThinking: true }]),
      file,
    );
    expect(result).toEqual({ added: 1, changed: 0, created: false });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.description).toBe("tpl");
    expect(written.models).toEqual([
      { pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { a: 1 } } },
      { pattern: "deepseek-(r1|reasoner)", supportsThinking: true },
    ]);
  });

  it("skips unparseable existing JSON without touching the file", () => {
    const file = path.join(tempDir, "thinking-corrupt.json");
    writeFileSync(file, "{not json", "utf8");
    const result = applyThinkingRules([{ pattern: "x", supportsThinking: true }], file);
    expect(result.skippedInvalid).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("is a no-op when already in sync (no write churn on repeat connects)", () => {
    const file = path.join(tempDir, "thinking-sync.json");
    const rules = [{ pattern: "x", supportsThinking: true }];
    writeFileSync(file, JSON.stringify({ models: rules }), "utf8");
    const result = applyThinkingRules(rules, file);
    expect(result).toEqual({ added: 0, changed: 0, created: false });
  });

  it("returns zeros for empty incoming (caller skips)", () => {
    expect(applyThinkingRules([], path.join(tempDir, "thinking-none.json"))).toEqual({ added: 0, changed: 0, created: false });
  });
});
