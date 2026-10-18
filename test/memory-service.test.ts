import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Block, HostToWebview, MemoryFileUi, MemoryStateUi } from "../shared/messages.js";
import { MemoryService, type MemoryServiceOptions } from "../src/memory/service.js";
import { MEMORY_MARKER } from "../src/memory/files.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(
  home: string,
  cwd: string,
  overrides: Partial<MemoryServiceOptions> = {},
) {
  const messages: HostToWebview[] = [];
  const service = new MemoryService({
    home,
    getCwd: () => (cwd ? cwd : null),
    getWorkspaceRoots: () => (cwd ? [cwd] : []),
    getContextFileName: () => null,
    isAutoCaptureEnabled: () => false,
    runPrompt: async () => null,
    getSessionId: () => null,
    scanWorkspace: async () => ({ files: [], truncated: false }),
    readWorkspaceFile: async () => null,
    runKnowledgePrompt: async () => null,
    getModelName: () => "test-model",
    post: (message) => messages.push(message),
    openFile: () => {},
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  });
  return { service, messages };
}

function lastState(messages: HostToWebview[]): MemoryStateUi {
  const state = [...messages].reverse().find((m) => m.type === "memoryState");
  if (!state || state.type !== "memoryState") throw new Error("no memoryState posted");
  return state.state;
}

function lastSaved(messages: HostToWebview[]) {
  const saved = [...messages].reverse().find((m) => m.type === "memorySaved");
  if (!saved || saved.type !== "memorySaved") throw new Error("no memorySaved posted");
  return saved;
}

function fileByPath(state: MemoryStateUi, file: string): MemoryFileUi {
  const found = state.files.find((f) => f.path === file);
  if (!found) throw new Error(`file not in state: ${file}`);
  return found;
}

describe("MemoryService", () => {
  it("reads global/project files and appends a CLI-compatible fact", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    writeFileSync(path.join(root, "AGENTS.md"), "# Project\n", "utf8");
    writeFileSync(path.join(home, "memory.md"), "legacy\n", "utf8");
    const { service, messages } = makeService(home, root);

    await service.sendState();
    const state = lastState(messages);
    const globalPrimary = path.join(home, "AGENTS.md");
    const projectPrimary = path.join(root, "AGENTS.md");
    expect(state.globalPrimary).toBe(globalPrimary);
    expect(state.projectPrimary).toBe(projectPrimary);
    expect(state.files.some((f) => f.role === "legacy" && !f.injected)).toBe(true);

    await service.appendFact({ scope: "global", fact: "  ---  use pnpm  ", requestId: 42 });
    const saved = lastSaved(messages);
    expect(saved.ok).toBe(true);
    expect(saved.requestId).toBe(42);
    expect(readFileSync(globalPrimary, "utf8")).toBe(
      `${MEMORY_MARKER}\n- use pnpm\n`,
    );

    await service.sendState();
    const after = lastState(messages);
    const file = fileByPath(after, globalPrimary);
    expect(file.facts?.map((f) => f.text)).toContain("use pnpm");
  });

  it("refuses a stale-hash save and keeps the current content", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    const project = path.join(root, "AGENTS.md");
    writeFileSync(project, "old\n", "utf8");
    const { service, messages } = makeService(home, root);

    await service.sendState();
    const original = fileByPath(lastState(messages), project);

    await service.saveFile({ path: project, content: "new\n", expectedHash: original.hash });
    expect(lastSaved(messages).ok).toBe(true);
    expect(readFileSync(project, "utf8")).toBe("new\n");

    await service.saveFile({ path: project, content: "other\n", expectedHash: original.hash });
    const conflict = lastSaved(messages);
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(readFileSync(project, "utf8")).toBe("new\n");
  });

  it("deletes a parsed fact and creates a project memory file", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    const global = path.join(home, "AGENTS.md");
    writeFileSync(global, `${MEMORY_MARKER}\n- first\n- second\n`, "utf8");
    const { service, messages } = makeService(home, root);

    await service.sendState();
    const file = fileByPath(lastState(messages), global);
    const first = file.facts?.find((f) => f.text === "first");
    expect(first).toBeDefined();

    await service.deleteFacts({ path: global, factIds: [first!.id] });
    expect(readFileSync(global, "utf8")).not.toContain("- first");
    expect(readFileSync(global, "utf8")).toContain("- second");

    await service.createProjectMemory("IFLOW.md");
    const created = path.join(root, "IFLOW.md");
    expect(readFileSync(created, "utf8")).toContain(MEMORY_MARKER);
    await service.sendState();
    expect(lastState(messages).files.some((f) => f.path === created)).toBe(true);
  });

  it("injectedContextItems excludes the legacy memory.md", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    writeFileSync(path.join(home, "AGENTS.md"), "GLOBAL_MARK\n", "utf8");
    writeFileSync(path.join(home, "memory.md"), "LEGACY_MARK\n", "utf8");
    writeFileSync(path.join(root, "AGENTS.md"), "PROJECT_MARK\n", "utf8");
    const { service } = makeService(home, root);

    const items = await service.injectedContextItems();
    const contents = items.map((i) => i.content).join("\n");
    expect(contents).toContain("GLOBAL_MARK");
    expect(contents).toContain("PROJECT_MARK");
    expect(contents).not.toContain("LEGACY_MARK");
    expect(items.some((i) => i.kind === "memory")).toBe(true);
    expect(items.some((i) => i.kind === "context-file")).toBe(true);
  });

  it("reports a missing project cwd instead of writing", async () => {
    const home = tempDir("iflow-mem-home-");
    const { service, messages } = makeService(home, "");
    await service.appendFact({ scope: "project", fact: "x" });
    const saved = lastSaved(messages);
    expect(saved.ok).toBe(false);
    expect(saved.error).toBeTruthy();
  });

  it("generates a knowledge index and toggles its managed import", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    writeFileSync(path.join(root, "AGENTS.md"), "# Project\n\n- keep me\n", "utf8");
    writeFileSync(path.join(root, "README.md"), "# Demo\n", "utf8");
    const { service, messages } = makeService(home, root, {
      scanWorkspace: async () => ({
        files: [{ path: path.join(root, "README.md"), rel: "README.md", size: 7, mtimeMs: 1 }],
        truncated: false,
      }),
      readWorkspaceFile: async (file) => (file.endsWith("README.md") ? "# Demo\n" : null),
      runKnowledgePrompt: async () => "# 项目知识索引\n\n## 概览\n\nDemo 项目。\n",
      getModelName: () => "test-model",
    });

    await service.generateKnowledge("job-1");
    expect(
      messages.some(
        (message) => message.type === "knowledgeJob" && message.stage === "done",
      ),
    ).toBe(true);

    const index = path.join(root, ".iflow", "knowledge", "index.md");
    expect(readFileSync(index, "utf8")).toContain("Demo 项目");
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".iflow", "knowledge", "manifest.json"), "utf8"),
    ) as { model: string; docs: Array<{ path: string; tokens: number }> };
    expect(manifest.model).toBe("test-model");
    expect(manifest.docs[0]?.path).toBe("index.md");
    // The state after done must not claim a generation is still running.
    expect(lastState(messages).knowledge?.generating).toBe(false);
    expect(manifest.docs[0]?.tokens).toBeGreaterThan(0);

    const memoryFile = path.join(root, "AGENTS.md");
    expect(readFileSync(memoryFile, "utf8")).toContain("@.iflow/knowledge/index.md");

    await service.sendState();
    const state = lastState(messages);
    expect(state.knowledge?.index?.injected).toBe(true);
    expect(state.knowledge?.injectedTokens ?? 0).toBeGreaterThan(0);
    expect(state.knowledge?.managedBy).toBe(memoryFile);

    await service.setKnowledgeInjection(index, false);
    expect(readFileSync(memoryFile, "utf8")).not.toContain("@.iflow/knowledge/index.md");
    await service.sendState();
    expect(lastState(messages).knowledge?.index?.injected).toBe(false);

    await service.setKnowledgeInjection(index, true);
    expect(readFileSync(memoryFile, "utf8")).toContain("@.iflow/knowledge/index.md");
  });

  it("honors contextFileName for the knowledge import target", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const { service } = makeService(home, root, {
      getContextFileName: () => "CLAUDE.md",
      scanWorkspace: async () => ({
        files: [{ path: path.join(root, "README.md"), rel: "README.md", size: 0, mtimeMs: 0 }],
        truncated: false,
      }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async () => "# 项目知识索引\n\n## 概览\n\nDemo",
      getModelName: () => "mock-model",
    });
    await service.generateKnowledge("job-custom-name");
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain(
      "@.iflow/knowledge/index.md",
    );
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });

  it("refreshes knowledge incrementally and skips when the workspace is unchanged", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const files = [
      { path: path.join(root, "README.md"), rel: "README.md", size: 6, mtimeMs: 1 },
    ];
    const prompts: string[] = [];
    const { service, messages } = makeService(home, root, {
      scanWorkspace: async () => ({ files, truncated: false }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? "# 项目知识索引\n\n## 概览\n\nDemo"
          : `# 项目知识索引\n\n## 概览\n\n${"Demo v2\n".repeat(40)}`;
      },
      getModelName: () => "mock-model",
    });

    await service.generateKnowledge("job-full", "full");
    expect(prompts).toHaveLength(1);

    files[0] = { ...files[0]!, size: 7, mtimeMs: 2 };
    await service.generateKnowledge("job-inc", "incremental");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("变化摘要");
    expect(prompts[1]).toContain("README.md");
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".iflow", "knowledge", "manifest.json"), "utf8"),
    ) as { mode: string; sources: Array<{ rel: string; mtimeMs: number }> };
    expect(manifest.mode).toBe("incremental");
    expect(manifest.sources[0]?.mtimeMs).toBe(2);

    await service.generateKnowledge("job-noop", "incremental");
    expect(prompts).toHaveLength(2);
    expect(
      messages.some((m) => m.type === "toast" && m.message.includes("最新")),
    ).toBe(true);
  });

  it("forces a full rebuild when the workspace scan is truncated", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const files = [
      { path: path.join(root, "README.md"), rel: "README.md", size: 6, mtimeMs: 1 },
    ];
    const prompts: string[] = [];
    const { service } = makeService(home, root, {
      scanWorkspace: async () => ({ files, truncated: true }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo";
      },
    });
    await service.generateKnowledge("job-full", "full");
    expect(prompts).toHaveLength(1);
    await service.generateKnowledge("job-inc", "incremental");
    expect(prompts).toHaveLength(2);
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".iflow", "knowledge", "manifest.json"), "utf8"),
    ) as { truncated?: boolean };
    expect(manifest.truncated).toBe(true);
  });

  it("truncated scans cannot overwrite a manually edited index", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const files = [
      { path: path.join(root, "README.md"), rel: "README.md", size: 6, mtimeMs: 1 },
    ];
    const prompts: string[] = [];
    const first = makeService(home, root, {
      scanWorkspace: async () => ({ files, truncated: false }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo";
      },
    });
    await first.service.generateKnowledge("job-full", "full");
    const indexPath = path.join(root, ".iflow", "knowledge", "index.md");
    writeFileSync(indexPath, "# 项目知识索引\n\n## 概览\n\n手工修改\n");
    // The next scan is truncated: it must still honor the baseline safety gate.
    const truncated = makeService(home, root, {
      scanWorkspace: async () => ({ files, truncated: true }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo v2";
      },
    });
    await truncated.service.generateKnowledge("job-truncated-edited", "incremental");
    expect(prompts).toHaveLength(1);
    expect(readFileSync(indexPath, "utf8")).toContain("手工修改");
    expect(
      truncated.messages.some((m) => m.type === "knowledgeJob" && m.stage === "error"),
    ).toBe(true);
  });

  it("still refuses a manual index when the scan is truncated", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    mkdirSync(path.join(root, ".iflow", "knowledge"), { recursive: true });
    const indexPath = path.join(root, ".iflow", "knowledge", "index.md");
    writeFileSync(indexPath, "# 手工索引\n\n不要覆盖\n");
    const prompts: string[] = [];
    const { service, messages } = makeService(home, root, {
      scanWorkspace: async () => ({
        files: [{ path: path.join(root, "README.md"), rel: "README.md", size: 1, mtimeMs: 1 }],
        truncated: true,
      }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo";
      },
    });
    await service.generateKnowledge("job-truncated-manual", "incremental");
    expect(prompts).toHaveLength(0);
    expect(readFileSync(indexPath, "utf8")).toContain("不要覆盖");
    expect(messages.some((m) => m.type === "knowledgeJob" && m.stage === "error")).toBe(true);
  });

  it("refuses incremental refresh when an index exists without a valid manifest", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    mkdirSync(path.join(root, ".iflow", "knowledge"), { recursive: true });
    const indexPath = path.join(root, ".iflow", "knowledge", "index.md");
    writeFileSync(indexPath, "# 手工索引\n\n不要覆盖\n");
    const prompts: string[] = [];
    const { service, messages } = makeService(home, root, {
      scanWorkspace: async () => ({
        files: [{ path: path.join(root, "README.md"), rel: "README.md", size: 1, mtimeMs: 1 }],
        truncated: false,
      }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo";
      },
    });
    await service.generateKnowledge("job-no-manifest", "incremental");
    expect(prompts).toHaveLength(0);
    expect(readFileSync(indexPath, "utf8")).toContain("不要覆盖");
    expect(
      messages.some(
        (m) => m.type === "knowledgeJob" && m.stage === "error",
      ),
    ).toBe(true);
  });

  it("refuses incremental refresh after the index was edited manually", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const files = [
      { path: path.join(root, "README.md"), rel: "README.md", size: 6, mtimeMs: 1 },
    ];
    const prompts: string[] = [];
    const { service, messages } = makeService(home, root, {
      scanWorkspace: async () => ({ files, truncated: false }),
      readWorkspaceFile: async () => "# Demo\n",
      runKnowledgePrompt: async (prompt) => {
        prompts.push(prompt);
        return "# 项目知识索引\n\n## 概览\n\nDemo";
      },
    });
    await service.generateKnowledge("job-full", "full");
    const indexPath = path.join(root, ".iflow", "knowledge", "index.md");
    writeFileSync(indexPath, "# 项目知识索引\n\n## 概览\n\n手工修改\n");
    files[0] = { ...files[0]!, size: 7, mtimeMs: 2 };
    await service.generateKnowledge("job-edited", "incremental");
    expect(prompts).toHaveLength(1);
    expect(readFileSync(indexPath, "utf8")).toContain("手工修改");
    expect(
      messages.some(
        (m) => m.type === "knowledgeJob" && m.stage === "error",
      ),
    ).toBe(true);
  });

  it("detects and removes knowledge imports across the whole memory hierarchy", async () => {
    const home = tempDir("iflow-memory-home-");
    const root = tempDir("iflow-memory-root-");
    const sub = path.join(root, "sub");
    mkdirSync(sub, { recursive: true });
    mkdirSync(path.join(root, ".iflow", "knowledge"), { recursive: true });
    const indexPath = path.join(root, ".iflow", "knowledge", "index.md");
    writeFileSync(indexPath, "# 项目知识索引\n\n## 概览\n\nroot import\n");
    writeFileSync(
      path.join(root, "AGENTS.md"),
      "# Root\n\n<!-- iflow-harness:knowledge:start -->\n## 项目知识库\n@.iflow/knowledge/index.md\n<!-- iflow-harness:knowledge:end -->\n",
    );
    writeFileSync(path.join(sub, "AGENTS.md"), "# Sub\n\nkeep me\n");

    const { service, messages } = makeService(home, sub, {
      getWorkspaceRoots: () => [root],
    });
    await service.sendState();
    const first = lastState(messages);
    expect(first.knowledge?.index?.injected).toBe(true);

    await service.setKnowledgeInjection(indexPath, false);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).not.toContain(
      "@.iflow/knowledge/index.md",
    );
    expect(readFileSync(path.join(sub, "AGENTS.md"), "utf8")).toContain("keep me");
    await service.sendState();
    expect(lastState(messages).knowledge?.index?.injected).toBe(false);

    await service.setKnowledgeInjection(indexPath, true);
    const subContent = readFileSync(path.join(sub, "AGENTS.md"), "utf8");
    expect(subContent).toContain("@../.iflow/knowledge/index.md");
    await service.sendState();
    expect(lastState(messages).knowledge?.index?.injected).toBe(true);
    // A second enable must be a no-op (no duplicate import line).
    await service.setKnowledgeInjection(indexPath, true);
    expect(
      readFileSync(path.join(sub, "AGENTS.md"), "utf8").split("@../.iflow/knowledge/index.md").length - 1,
    ).toBe(1);
  });

  it("extracts candidates, reviews, and applies selected facts", async () => {
    const home = tempDir("iflow-mem-home-");
    const root = tempDir("iflow-mem-ws-");
    const sessionId = "session-1";
    const { service, messages } = makeService(home, root, {
      isAutoCaptureEnabled: () => true,
      getSessionId: () => sessionId,
      runPrompt: async () =>
        JSON.stringify({
          facts: [
            {
              text: "以后用 pnpm 安装依赖",
              scope: "global",
              category: "preference",
              confidence: 0.9,
            },
          ],
        }),
    });
    const blocks: Block[] = [
      { kind: "user", text: "以后用 pnpm 安装依赖" },
      { kind: "text", text: "好的，记住了。" },
    ];
    await service.maybeExtract(sessionId, blocks);
    const toast = messages.find(
      (message) => message.type === "toast" && message.action?.actionId === "memory-review",
    );
    expect(toast).toBeTruthy();
    service.reviewCandidates();
    const review = messages.find((message) => message.type === "memoryCandidates");
    expect(review?.type).toBe("memoryCandidates");
    if (review?.type !== "memoryCandidates") throw new Error("no candidates");
    expect(review.candidates[0]?.text).toBe("以后用 pnpm 安装依赖");

    await service.applyCandidates(review.candidates, sessionId);
    expect(readFileSync(path.join(home, "AGENTS.md"), "utf8")).toContain("- 以后用 pnpm 安装依赖");
  });
});
