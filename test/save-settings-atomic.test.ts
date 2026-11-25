import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root-cause guard for the vendored CLI's non-atomic `saveSettings` write.
 *
 * The real write path lives inside the minified fork bundle (`function BMi`),
 * so this test verifies two things:
 *   1. bundle wiring: the unique BMi anchor now delegates to the atomic helper
 *      and the bare `writeFileSync(A.path, ...)` is gone;
 *   2. helper behaviour: unique tmp in the target directory, rename-based
 *      replace (never unlink the target), EPERM/EACCES/EBUSY-only retry,
 *      original error rethrown and tmp cleaned on failure.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(here, "..", "vendor", "iflow-fork", "bundle");
const bundlePath = join(bundleDir, "iflow.js");
const helperPath = join(bundleDir, "atomic-settings-write.cjs");

interface HelperModule {
  writeAtomicSync(
    file: string,
    settings: unknown,
    options?: { fs?: FakeFs; delaysMs?: number[] },
  ): void;
  uniqueTmpPath(file: string): string;
  isRetryable(error: { code?: string } | null | undefined): boolean;
  RETRY_DELAYS_MS: number[];
}

interface FakeFs {
  files: Map<string, string>;
  ops: string[];
  renameCalls: Array<[string, string]>;
  failCodes: string[];
  writeFileSync(path: string, data: string, encoding?: string): void;
  renameSync(from: string, to: string): void;
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

function makeFs(codes: string[] = []): FakeFs {
  const files = new Map<string, string>();
  const ops: string[] = [];
  const renameCalls: Array<[string, string]> = [];
  const failCodes = [...codes];
  return {
    files,
    ops,
    renameCalls,
    failCodes,
    writeFileSync(path, data) {
      ops.push(`write:${path}`);
      files.set(path, data);
    },
    renameSync(from, to) {
      renameCalls.push([from, to]);
      const code = failCodes.shift();
      if (code) throw Object.assign(new Error(`injected ${code}`), { code });
      const data = files.get(from);
      if (data === undefined) throw Object.assign(new Error("missing tmp"), { code: "ENOENT" });
      ops.push(`rename:${from}->${to}`);
      files.set(to, data);
      files.delete(from);
    },
    existsSync(path) {
      return files.has(path);
    },
    unlinkSync(path) {
      ops.push(`unlink:${path}`);
      files.delete(path);
    },
  };
}

const helper = require(helperPath) as HelperModule;

describe("saveSettings atomic write — bundle wiring", () => {
  it("BMi 锚点唯一，且裸 writeFileSync(A.path,...) 已彻底移除", () => {
    const bundle = readFileSync(bundlePath, "utf-8");
    expect(bundle.split("function BMi(").length - 1).toBe(1);
    expect(bundle.split("writeFileSync(A.path").length - 1).toBe(0);
    expect(bundle.split('require("./atomic-settings-write.cjs")').length - 1).toBe(1);

    const i = bundle.indexOf("function BMi(");
    const body = bundle.slice(i, i + 500);
    expect(body).toContain('require("./atomic-settings-write.cjs").writeAtomicSync(A.path,A.settings)');
    // The intercept semantics (null skip / object replace / silent fallback)
    // and the outer upstream error log must survive untouched.
    expect(body).toContain('require("./api-config-isolation-loader.cjs")');
    expect(body).toContain("if(r===null)return;r&&(A=r)");
    expect(body).toContain('console.error("Error saving user settings file:",e)');
  });

  it("helper 与 bundle 同目录随 vendor 一起复制，且不再污染 ACP wire", () => {
    expect(existsSync(helperPath)).toBe(true);
    const source = readFileSync(helperPath, "utf-8");
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(executable).not.toContain("console.");
    expect(source).toContain("renameSync(tmp, file)");
  });
});

describe("atomic-settings-write helper", () => {
  const target = join(tmpdir(), "iflow-atomic-test", "settings.json");

  it("写同目录唯一 tmp 后用 rename 覆盖目标，不 unlink、不丢键", () => {
    const fs = makeFs();
    const settings = { language: "zh-cn", nested: { a: 1 }, list: [1, 2, 3] };
    helper.writeAtomicSync(target, settings, { fs, delaysMs: [0, 0, 0, 0, 0] });

    expect(fs.renameCalls.length).toBe(1);
    expect(fs.ops.some((op) => op.startsWith("unlink:"))).toBe(false);
    expect(JSON.parse(fs.files.get(target)!)).toEqual(settings);
    expect([...fs.files.keys()].some((k) => k.includes("iflow-harness-tmp"))).toBe(false);

    const tmp = fs.renameCalls[0]![0];
    expect(tmp.startsWith(`${target}.iflow-harness-tmp-`)).toBe(true);
    expect(tmp).toMatch(new RegExp(`\\.iflow-harness-tmp-${process.pid}-\\d+-\\d+$`));
    expect(fs.ops[0]).toBe(`write:${tmp}`);
  });

  it("仅对 EPERM/EACCES/EBUSY 重试，短暂占用后可成功写入", () => {
    const fs = makeFs(["EPERM", "EACCES", "EBUSY"]);
    helper.writeAtomicSync(target, { ok: true }, { fs, delaysMs: [0, 0, 0, 0, 0] });
    expect(fs.renameCalls.length).toBe(4);
    expect(JSON.parse(fs.files.get(target)!)).toEqual({ ok: true });
    expect([...fs.files.keys()].some((k) => k.includes("iflow-harness-tmp"))).toBe(false);
  });

  it("非重试错误立即中止、清理 tmp 并抛出原始 code", () => {
    const fs = makeFs(["ENOENT"]);
    let caught: unknown;
    try {
      helper.writeAtomicSync(target, { a: 1 }, { fs, delaysMs: [0, 0, 0, 0, 0] });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("ENOENT");
    expect(fs.renameCalls.length).toBe(1);
    expect([...fs.files.keys()].some((k) => k.includes("iflow-harness-tmp"))).toBe(false);
  });

  it("重试预算耗尽抛原始错误、清理 tmp，且旧目标键完整保留", () => {
    const old = { existingKey: "keep-me", mcpServers: { a: { command: "x" } } };
    const fs = makeFs(Array(8).fill("EPERM"));
    fs.files.set(target, JSON.stringify(old));

    let caught: unknown;
    try {
      helper.writeAtomicSync(target, { replacement: true }, { fs, delaysMs: [0] });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("EPERM");
    expect(fs.renameCalls.length).toBe(2); // 1 initial + 1 retry, then budget exhausted
    expect(fs.files.get(target)).toBe(JSON.stringify(old)); // never unlinked
    expect([...fs.files.keys()].some((k) => k.includes("iflow-harness-tmp"))).toBe(false);
  });

  it("uniqueTmpPath 每次都不同并带 pid/时间戳/序号", () => {
    const a = helper.uniqueTmpPath(target);
    const b = helper.uniqueTmpPath(target);
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`\\.iflow-harness-tmp-${process.pid}-\\d+-\\d+$`));
    expect(helper.RETRY_DELAYS_MS).toEqual([20, 60, 150, 300, 600]);
  });

  it("真实文件系统：原子替换落盘内容正确", () => {
    const dir = mkdtempSync(join(tmpdir(), "iflow-atomic-real-"));
    try {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify({ stale: true }), "utf-8");
      helper.writeAtomicSync(file, { fresh: 42, nested: { ok: true } });
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ fresh: 42, nested: { ok: true } });
      expect(existsSync(`${file}.iflow-harness-tmp-${process.pid}`)).toBe(false);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
