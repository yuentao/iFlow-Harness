import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverMemoryFiles } from "../src/memory/discovery.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("memory discovery", () => {
  it("orders global, project ancestors, recursive matches and legacy", async () => {
    const home = tempDir("iflow-home-");
    const root = tempDir("iflow-ws-");
    const cwd = path.join(root, "packages", "app");
    const nested = path.join(root, "packages", "app", "src");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(nested, { recursive: true });

    writeFileSync(path.join(home, "AGENTS.md"), "global agents", "utf8");
    writeFileSync(path.join(home, "IFLOW.md"), "global iflow", "utf8");
    writeFileSync(path.join(home, "memory.md"), "legacy", "utf8");
    writeFileSync(path.join(root, "AGENTS.md"), "root agents", "utf8");
    writeFileSync(path.join(cwd, "AGENTS.md"), "cwd agents", "utf8");
    writeFileSync(path.join(nested, "AGENTS.md"), "nested agents", "utf8");

    const files = await discoverMemoryFiles({
      cwd,
      workspaceRoots: [root],
      home,
      maxRecursiveFiles: 50,
    });

    const global = files.filter((f) => f.scope === "global");
    expect(global.map((f) => path.basename(f.path))).toEqual(["AGENTS.md", "IFLOW.md", "memory.md"]);
    expect(global[0]!.role).toBe("primary");
    expect(global[0]!.injected).toBe(true);
    expect(global[1]!.role).toBe("additional");
    expect(global[2]!.role).toBe("legacy");
    expect(global[2]!.injected).toBe(false);

    const project = files.filter((f) => f.scope === "project");
    expect(project.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))).toEqual([
      "AGENTS.md",
      "packages/app/AGENTS.md",
      "packages/app/src/AGENTS.md",
    ]);
    expect(project[1]!.role).toBe("primary");
    expect(project[2]!.role).toBe("hierarchy");
    expect(project.every((f) => f.injected)).toBe(true);
    expect(project.every((f) => f.editable)).toBe(true);

    expect(global[0]!.displayPath).toBe("~/.iflow/AGENTS.md");
    expect(project[1]!.displayPath).toBe("packages/app/AGENTS.md");
  });

  it("honors contextFileName override and reports a missing primary", async () => {
    const home = tempDir("iflow-home-");
    const root = tempDir("iflow-ws-");
    const files = await discoverMemoryFiles({
      cwd: root,
      workspaceRoots: [root],
      home,
      contextFileName: "MEMORY.md",
      maxRecursiveFiles: 0,
    });
    const global = files.filter((f) => f.scope === "global");
    expect(global.map((f) => path.basename(f.path))).toEqual(["MEMORY.md"]);
    expect(global[0]!.exists).toBe(false);
    expect(global[0]!.role).toBe("primary");
    expect(global[0]!.injected).toBe(false);

    const project = files.filter((f) => f.scope === "project");
    expect(project.map((f) => path.basename(f.path))).toEqual(["MEMORY.md"]);
    expect(project[0]!.exists).toBe(false);
    expect(project[0]!.role).toBe("primary");
  });

  it("does not scan the workspace when recursive discovery is disabled", async () => {
    const home = tempDir("iflow-home-");
    const root = tempDir("iflow-ws-");
    const nested = path.join(root, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "AGENTS.md"), "nested", "utf8");

    const files = await discoverMemoryFiles({
      cwd: root,
      workspaceRoots: [root],
      home,
      maxRecursiveFiles: 0,
    });
    expect(files.filter((f) => f.role === "hierarchy")).toHaveLength(0);
  });

  it("skips dot-prefixed directories in the recursive scan", async () => {
    const home = tempDir("iflow-home-");
    const root = tempDir("iflow-ws-");
    // Super Agent worktree copy (tool metadata tree) and a generic hidden dir.
    const worktree = path.join(root, ".iflow", "super", "worktrees", "wt");
    const hidden = path.join(root, ".hidden");
    const nested = path.join(root, "nested");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(hidden, { recursive: true });
    mkdirSync(nested, { recursive: true });

    writeFileSync(path.join(worktree, "AGENTS.md"), "worktree copy", "utf8");
    writeFileSync(path.join(hidden, "AGENTS.md"), "hidden", "utf8");
    writeFileSync(path.join(nested, "AGENTS.md"), "nested", "utf8");

    const files = await discoverMemoryFiles({
      cwd: root,
      workspaceRoots: [root],
      home,
      maxRecursiveFiles: 50,
    });

    const hierarchy = files.filter((f) => f.role === "hierarchy");
    expect(hierarchy.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))).toEqual([
      "nested/AGENTS.md",
    ]);
  });
});
