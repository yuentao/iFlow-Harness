import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendFact,
  deleteFacts,
  displayPathFor,
  isWithin,
  MEMORY_MARKER,
  parseFacts,
  resolveContextFileNames,
  sha256,
  writeAtomic,
} from "../src/memory/files.js";

describe("memory files: CLI-compatible fact format", () => {
  it("creates the marker in an empty file", () => {
    expect(appendFact("", "run npm test")).toBe(`${MEMORY_MARKER}\n- run npm test\n`);
  });

  it("separates a new marker from existing content", () => {
    expect(appendFact("hello", "x")).toBe(`hello\n\n${MEMORY_MARKER}\n- x\n`);
    expect(appendFact("hello\n", "x")).toBe(`hello\n\n${MEMORY_MARKER}\n- x\n`);
    expect(appendFact("hello\n\n", "x")).toBe(`hello\n\n${MEMORY_MARKER}\n- x\n`);
  });

  it("inserts before the next heading so the section stays contiguous", () => {
    const content = `# Memory\n\n${MEMORY_MARKER}\n- old\n\n## Other\nbody\n`;
    expect(appendFact(content, "new")).toBe(
      `# Memory\n\n${MEMORY_MARKER}\n- old\n- new\n\n## Other\nbody\n`,
    );
  });

  it("strips leading dashes and whitespace exactly like save_memory", () => {
    expect(appendFact("", "  ---  remember this  ")).toBe(
      `${MEMORY_MARKER}\n- remember this\n`,
    );
  });

  it("ignores empty facts", () => {
    const content = `# Memory\n\n${MEMORY_MARKER}\n- keep\n`;
    expect(appendFact(content, "   ")).toBe(content);
  });
});

describe("memory files: fact parsing and deletion", () => {
  const content = [
    "# Memory",
    "",
    MEMORY_MARKER,
    "- first",
    "- second",
    "",
    "## Other",
    "body",
    "",
  ].join("\n");

  it("parses only bullets inside the marker section", () => {
    const facts = parseFacts(content);
    expect(facts.map((f) => f.text)).toEqual(["first", "second"]);
    expect(new Set(facts.map((f) => f.id)).size).toBe(2);
  });

  it("deletes one fact without touching other lines", () => {
    const first = parseFacts(content)[0]!;
    const next = deleteFacts(content, [first.id]);
    expect(next).toContain("- second");
    expect(next).not.toContain("- first");
    expect(next).toContain("## Other\nbody");
  });

  it("is a no-op for unknown ids", () => {
    expect(deleteFacts(content, ["missing"])).toBe(content);
  });
});

describe("memory files: settings and paths", () => {
  it("resolves contextFileName like the CLI loader", () => {
    expect(resolveContextFileNames(null)).toEqual(["AGENTS.md", "IFLOW.md"]);
    expect(resolveContextFileNames(undefined)).toEqual(["AGENTS.md", "IFLOW.md"]);
    expect(resolveContextFileNames("MEMORY.md")).toEqual(["MEMORY.md"]);
    expect(resolveContextFileNames(["A.md", "B.md"])).toEqual(["A.md", "B.md"]);
    expect(resolveContextFileNames([])).toEqual(["AGENTS.md", "IFLOW.md"]);
    expect(resolveContextFileNames("  ")).toEqual(["AGENTS.md", "IFLOW.md"]);
  });

  it("computes a stable sha256", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });

  it("detects path containment", () => {
    const root = path.resolve("/tmp/root");
    expect(isWithin(root, path.join(root, "a", "b"))).toBe(true);
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, path.resolve("/tmp/other"))).toBe(false);
  });

  // 附件通道只放行工作区内路径、会话暂存目录与用户本轮亲自附上的文件。纯词法
  // 比较挡不住「工作区里的一个链接指向工作区外」—— 词法上它在工作区里，实际
  // 指向工作区外，于是工作区外的文件会被复制进子会话上下文。
  it("工作区内指向工作区外的链接判定为越界", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "iflow-iswithin-"));
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    const link = path.join(root, "link");
    try {
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(path.join(outside, "secret.txt"), "secret");
      writeFileSync(path.join(root, "inside.txt"), "inside");
      // Windows 的 junction 不需要管理员权限；POSIX 上等价于目录符号链接。
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

      // 工作区里的普通文件照常放行。
      expect(isWithin(root, path.join(root, "inside.txt"))).toBe(true);
      // 指向工作区外的链接：越界（拒绝）。
      expect(isWithin(root, path.join(link, "secret.txt"))).toBe(false);
      // 链接本身（目录）同样越界。
      expect(isWithin(root, link)).toBe(false);
    } finally {
      // 先摘掉链接（不能顺着它删掉工作区外的目录），再清理临时目录。
      rmSync(link, { force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("待创建的文件（路径不存在）仍按词法判断放行", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "iflow-iswithin-new-"));
    const root = path.join(base, "root");
    try {
      mkdirSync(root);
      // 目标还不存在：解析最近的存在的祖先再拼回去，仍在工作区内 → 放行。
      expect(isWithin(root, path.join(root, "new", "file.txt"))).toBe(true);
      expect(isWithin(root, path.join(root, "..", "outside", "file.txt"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("renders ~/.iflow paths for global files", () => {
    const home = path.resolve(os.tmpdir(), "memory-home-test");
    expect(displayPathFor(path.join(home, "AGENTS.md"), [], home)).toBe("~/.iflow/AGENTS.md");
    const root = path.resolve(os.tmpdir(), "memory-ws-test");
    expect(displayPathFor(path.join(root, "AGENTS.md"), [root], home)).toBe("AGENTS.md");
  });
});

describe("memory files: atomic write", () => {
  it("writes the file and leaves no temp file behind", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "iflow-memory-write-"));
    try {
      const file = path.join(dir, "AGENTS.md");
      await writeAtomic(file, "# hello\n");
      expect(readFileSync(file, "utf8")).toBe("# hello\n");
      await writeAtomic(file, "# replaced\n");
      expect(readFileSync(file, "utf8")).toBe("# replaced\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
