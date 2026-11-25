/**
 * Direct tests for the migrated `WorkspaceRootsService` (panel split:
 * 工作区根目录管理), plus a source-level wiring lock on `panel.ts`.
 *
 * The service is constructed with fake deps only — no ChatPanel, no disk.
 * Cases pin the behaviour that MUST stay equivalent after the extraction:
 * the first VSCode root stays at index 0 (cwd anchor), the `applied`
 * three-state rule, `add_dirs` cwd sourcing, and the "empty selection means
 * full roots" normalization. The wiring lock fails if the panel stops
 * delegating to the service or if the service ever imports panel.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  initialSessionState,
  type SessionState,
  type SessionSummaryUi,
} from "../shared/messages.js";
import {
  WorkspaceRootsService,
  type WorkspaceRootsServiceDeps,
  type WorkspaceRootsState,
  type WorkspaceRootsWorkspace,
} from "../src/panel/workspace-roots-service.js";

const KEY = "iflow.sessionRoots";
const A = path.resolve("ws-a");
const B = path.resolve("ws-b");
const C = path.resolve("ws-c");

function summary(id: string, roots?: readonly string[]): SessionSummaryUi {
  return {
    id,
    label: id,
    updatedAt: 0,
    ...(roots ? { roots: [...roots] } : {}),
  };
}

function makeWorkspace(folders: readonly string[]): WorkspaceRootsWorkspace {
  return { workspaceFolders: folders.map((p) => ({ uri: { fsPath: p } })) };
}

function makeWorkspaceState(
  initial: Record<string, unknown> = {},
): WorkspaceRootsState & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get<T>(key: string, defaultValue: T): T {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

interface HarnessOptions {
  folders?: readonly string[];
  storedRoots?: readonly string[];
  sessionId?: string | null;
  activeSessionId?: string | null;
  sessions?: SessionSummaryUi[];
  initialWorkspaceRoots?: SessionState["workspaceRoots"];
  workspaceRoot?: string | null;
}

function harness(options: HarnessOptions = {}) {
  const wsState = makeWorkspaceState(
    options.storedRoots ? { [KEY]: [...options.storedRoots] } : {},
  );
  const state: SessionState = {
    ...initialSessionState(),
    sessionId: options.sessionId === undefined ? "s1" : options.sessionId,
    activeSessionId: options.activeSessionId === undefined ? null : options.activeSessionId,
    sessions: options.sessions ?? [summary("s1", [B])],
    workspaceRoots: options.initialWorkspaceRoots ?? null,
  };
  let workspaceRoot = options.workspaceRoot;
  let workspace = makeWorkspace(options.folders ?? [A, B, C]);
  const projections: SessionState["workspaceRoots"][] = [];
  const deps: WorkspaceRootsServiceDeps = {
    getWorkspaceState: () => wsState,
    getState: () => state,
    setWorkspaceRoots: (value) => {
      projections.push(value);
      state.workspaceRoots = value;
    },
    getWorkspaceRoot: () => workspaceRoot,
    getWorkspace: () => workspace,
  };
  return {
    service: new WorkspaceRootsService(deps),
    state,
    wsState,
    projections,
    setWorkspaceRoot: (value: string | null | undefined) => { workspaceRoot = value; },
    setFolders: (folders: readonly string[]) => { workspace = makeWorkspace(folders); },
  };
}

describe("WorkspaceRootsService · 根列表与选择", () => {
  it("workspaceRootInfos 保持 VSCode 第一根在索引 0，其余稳定排序", () => {
    const { service } = harness({ folders: [A, C, B] });
    const roots = service.workspaceRootInfos();
    expect(roots[0]!.path).toBe(A);
    expect(roots.map((r) => r.path)).toEqual([A, B, C]);
    expect(roots.map((r) => r.name)).toEqual(["ws-a", "ws-b", "ws-c"]);
  });

  it("空工作区得到空根列表", () => {
    expect(harness({ folders: [] }).service.workspaceRootInfos()).toEqual([]);
  });

  it("selectedSessionRoots 按根顺序过滤未知路径；空存储归一为空选择", () => {
    // 原实现用 get(key, []) + normalizeSelection([], roots) → 空选择；
    // buildAddDirs 对空选择返回 null（省略该字段 = 全量根），语义不变。
    expect(harness().service.selectedSessionRoots(harness().service.workspaceRootInfos()))
      .toEqual([]);
    const stored = harness({ storedRoots: [C, path.resolve("ghost")] });
    expect(stored.service.selectedSessionRoots(stored.service.workspaceRootInfos())).toEqual([C]);
  });
});

describe("WorkspaceRootsService · applied 三态与投影", () => {
  it("appliedSessionRoots 优先 activeSessionId，缺失则 null", () => {
    const active = harness({
      activeSessionId: "s2",
      sessions: [summary("s1", [B]), summary("s2", [A])],
    });
    expect(active.service.appliedSessionRoots()).toEqual([A]);
    expect(harness({ sessions: [summary("s1")] }).service.appliedSessionRoots()).toBeNull();
    expect(harness({ sessionId: null }).service.appliedSessionRoots()).toBeNull();
  });

  it("publishWorkspaceRoots(undefined) 沿用当前 applied（不把下次偏好写进 applied）", () => {
    const h = harness({ storedRoots: [A] });
    h.service.publishWorkspaceRoots();
    const projection = h.projections.at(-1)!;
    expect(projection!.selected).toEqual([A]);
    expect(projection!.applied).toEqual([B]);
    expect(projection!.pendingChange).toBe(true);
  });

  it("publishWorkspaceRoots(undefined) 优先已存投影的 applied，再回退会话记录", () => {
    const h = harness({
      storedRoots: [C],
      sessions: [summary("s1", [B])],
      initialWorkspaceRoots: {
        roots: [A, B, C] as never,
        selected: [C],
        applied: [A, B],
        pendingChange: false,
      },
    });
    h.service.publishWorkspaceRoots();
    expect(h.projections.at(-1)!.applied).toEqual([A, B]);
  });

  it("publishWorkspaceRoots(null) 表示全量根；显式数组就是该会话真实根集合", () => {
    const full = harness({ storedRoots: [A, B, C] });
    full.service.publishWorkspaceRoots(null);
    const fullProjection = full.projections.at(-1)!;
    expect(fullProjection!.applied).toEqual([A, B, C]);
    expect(fullProjection!.pendingChange).toBe(false);

    const subset = harness({ storedRoots: [C] });
    subset.service.publishWorkspaceRoots([A]);
    const subsetProjection = subset.projections.at(-1)!;
    expect(subsetProjection!.applied).toEqual([A]);
    expect(subsetProjection!.pendingChange).toBe(true);
  });

  it("单根工作区投影写 null（不渲染选择器）", () => {
    const h = harness({ folders: [A] });
    h.service.publishWorkspaceRoots([A]);
    expect(h.projections).toEqual([null]);
  });
});

describe("WorkspaceRootsService · add_dirs", () => {
  it("sessionAddDirs 用 services.workspaceRoot 优先，其次 roots[0]；cwd 根被剔除", () => {
    const h = harness({ storedRoots: [B] });
    expect(h.service.sessionAddDirs()).toEqual([B]);
    h.setWorkspaceRoot(C);
    expect(h.service.sessionAddDirs()).toEqual([B]);
    h.setWorkspaceRoot(B);
    expect(h.service.sessionAddDirs()).toEqual([]);
  });

  it("全量选择或单根工作区省略 add_dirs（返回 null）", () => {
    expect(harness().service.sessionAddDirs()).toBeNull(); // 未持久化 → 全量
    expect(harness({ storedRoots: [A, B, C] }).service.sessionAddDirs()).toBeNull();
    expect(harness({ folders: [A], storedRoots: [A] }).service.sessionAddDirs()).toBeNull();
  });

  it("currentSessionAddDirs 用已记录根，不被下次偏好改写", () => {
    const h = harness({ storedRoots: [A], sessions: [summary("s1", [B])] });
    expect(h.service.currentSessionAddDirs()).toEqual([B]);
    h.setWorkspaceRoot(B);
    expect(h.service.currentSessionAddDirs()).toEqual([]);
    expect(harness({ sessions: [summary("s1")] }).service.currentSessionAddDirs()).toBeNull();
  });
});

describe("WorkspaceRootsService · 写回", () => {
  it("setSessionRoots 归一化后持久化（根顺序），并刷新投影保持 applied", async () => {
    const h = harness();
    await h.service.setSessionRoots([C, B]);
    expect(h.wsState.data.get(KEY)).toEqual([B, C]);
    expect(h.projections.at(-1)!.applied).toEqual([B]);
    expect(h.projections.at(-1)!.pendingChange).toBe(true);
  });

  it("空选择归一为全量根；单根工作区不写 workspaceState", async () => {
    const h = harness();
    await h.service.setSessionRoots([]);
    expect(h.wsState.data.get(KEY)).toEqual([A, B, C]);
    const single = harness({ folders: [A] });
    await single.service.setSessionRoots([]);
    expect(single.wsState.data.has(KEY)).toBe(false);
    expect(single.projections).toEqual([]);
  });

  it("deps 在调用时读取，构造后替换 workspaceState / workspace 立即生效（陷阱 #8）", () => {
    const h = harness({ folders: [A], storedRoots: [] });
    expect(h.service.workspaceRootInfos()).toHaveLength(1);
    h.setFolders([A, B, C]);
    expect(h.service.workspaceRootInfos()).toHaveLength(3);
    h.wsState.data.set(KEY, [C]);
    expect(h.service.selectedSessionRoots(h.service.workspaceRootInfos())).toEqual([C]);
  });
});

describe("panel 接线锁（外迁后行为等价）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const panelSource = fs.readFileSync(path.join(here, "..", "src", "panel", "panel.ts"), "utf8");
  const serviceSource = fs.readFileSync(
    path.join(here, "..", "src", "panel", "workspace-roots-service.ts"),
    "utf8",
  );

  it("panel 保留 7 个同名薄委托并实例化服务", () => {
    expect(panelSource).toContain('import { WorkspaceRootsService } from "./workspace-roots-service.js"');
    expect(panelSource).toContain("new WorkspaceRootsService({");
    for (const name of [
      "workspaceRootInfos",
      "selectedSessionRoots",
      "appliedSessionRoots",
      "publishWorkspaceRoots",
      "sessionAddDirs",
      "setSessionRoots",
      "currentSessionAddDirs",
    ]) {
      expect(panelSource).toContain(`this.workspaceRootsService.${name}(`);
    }
  });

  it("迁移的实现细节只留在服务里，服务不反向依赖 panel.ts", () => {
    expect(panelSource).not.toContain("workspaceRootsFrom(vscode.workspace)");
    expect(panelSource).not.toContain('const SESSION_ROOTS_KEY = "iflow.sessionRoots"');
    expect(serviceSource).toContain('const SESSION_ROOTS_KEY = "iflow.sessionRoots"');
    expect(serviceSource).not.toMatch(/from\s+["']\.\/panel\.js["']/);
  });
});
