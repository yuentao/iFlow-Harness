/**
 * WorkspaceRootsService — multi-root workspace root management, extracted from
 * `panel.ts` (panel split: 工作区根目录管理; behavior-preserving refactor).
 *
 * Owns the panel-side session root subset: the live root list (via the pure
 * helpers in `./workspace-roots.js`), the workspaceState-persisted "next
 * session" selection, the UI projection's three states (selected / applied /
 * pendingChange), and the two `settings.add_dirs` computations (new session
 * vs. current-session reload).
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It only receives the
 * narrow callback surface below, so it cannot create an import cycle and can
 * be unit-tested without constructing a ChatPanel. Every panel-owned value is
 * read at CALL TIME through callbacks (AGENTS.md pitfall #8) — never captured
 * as a construction-time snapshot. `ChatPanel` keeps same-named thin
 * delegates, so the webview-message switch, SessionRestoreService deps and
 * every existing test keep the exact same contract.
 *
 * Behaviour invariants kept byte-identical:
 *   • `roots[0]` is the VSCode first folder (the CLI process cwd derives from
 *     it); `workspaceRootsFrom` pins it and this module never reorders it.
 *   • `add_dirs` uses the SAME cwd as ensureClient: `services.workspaceRoot`
 *     test hook wins, then `roots[0]`, then `workspaceFolders[0]`, then null.
 *   • the `applied` argument's three states: `undefined` keeps the current
 *     applied set, `null` means the full-root set, an array is that session's
 *     recorded root set.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import type { SessionState, WorkspaceRootUi } from "../../shared/messages.js";
import {
  buildAddDirs,
  buildWorkspaceRootsUi,
  normalizeSelection,
  workspaceRootsFrom,
} from "./workspace-roots.js";

/** workspaceState key (多仓库协作): 用户为**之后新建**的会话选中的目标根集合
 * （绝对路径数组）。它只是「下一个会话的偏好」——当前会话的 CLI 上下文与 cwd
 * 一律不动，已有会话的根集合记在会话索引的 `roots` 字段里。 */
const SESSION_ROOTS_KEY = "iflow.sessionRoots";

/** Structural VSCode-workspace shape — keeps this module vscode-free at runtime. */
export interface WorkspaceRootsWorkspace {
  workspaceFolders?: readonly { uri: { fsPath: string } }[] | undefined;
}

/** Structural workspaceState shape (only the two members this service uses). */
export interface WorkspaceRootsState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface WorkspaceRootsServiceDeps {
  /** Live workspaceState — read at call time (get + update). */
  getWorkspaceState(): WorkspaceRootsState;
  /** Live session state — read at call time. */
  getState(): SessionState;
  /** Projection write-through to the store. */
  setWorkspaceRoots(value: SessionState["workspaceRoots"]): void;
  /** Test hook used by ensureClient; wins over roots[0] for add_dirs cwd. */
  getWorkspaceRoot(): string | null | undefined;
  /** VSCode workspace folders — read at call time. */
  getWorkspace(): WorkspaceRootsWorkspace;
}

export class WorkspaceRootsService {
  constructor(private readonly deps: WorkspaceRootsServiceDeps) {}

  /** Panel-shaped proxies: the migrated method bodies stay verbatim while
   *  every read still goes through a call-time callback (pitfall #8). */
  private get context(): { workspaceState: WorkspaceRootsState } {
    return { workspaceState: this.deps.getWorkspaceState() };
  }
  private get store(): {
    getState(): SessionState;
    setWorkspaceRoots(value: SessionState["workspaceRoots"]): void;
  } {
    return {
      getState: () => this.deps.getState(),
      setWorkspaceRoots: (value) => this.deps.setWorkspaceRoots(value),
    };
  }
  private get services(): { workspaceRoot: string | null | undefined } {
    return { workspaceRoot: this.deps.getWorkspaceRoot() };
  }
  private get workspace(): WorkspaceRootsWorkspace {
    return this.deps.getWorkspace();
  }

  // --- 多仓库协作：目标根子集 ------------------------------------------------

  /** 当前工作区根的单一来源（realpath + 去重 + 稳定排序，第一根保持 VSCode
   * 第一个文件夹 —— 进程 cwd 依赖它）。 */
  workspaceRootInfos(): WorkspaceRootUi[] {
    return workspaceRootsFrom(this.workspace);
  }

  /** 用户为「之后的新会话」选中的根（workspaceState 持久化，未知路径被丢弃）。 */
  selectedSessionRoots(roots: readonly WorkspaceRootUi[]): string[] {
    const stored = this.context.workspaceState.get<string[]>(SESSION_ROOTS_KEY, []);
    return normalizeSelection(stored, roots);
  }

  /** 当前会话的 CLI 实际使用的根（存于会话索引的 `roots` 字段）。 */
  appliedSessionRoots(): string[] | null {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id) return null;
    const summary = state.sessions.find((s) => s.id === id);
    return summary?.roots ?? null;
  }

  /**
   * 把根子集投影写进状态（只动 UI，不动 CLI、不动 cwd）。
   *
   * 三态：`undefined` 沿用当前 applied（用户改选择时用，当前会话的 applied
   * 不能跟着变，否则「对新会话生效」的提示会自我否认）；`null` 表示全量根；
   * 数组表示该会话真实的根集合。
   * 单根工作区不渲染选择器，投影写 null。
   */
  publishWorkspaceRoots(applied?: readonly string[] | null): void {
    const roots = this.workspaceRootInfos();
    if (roots.length <= 1) {
      this.store.setWorkspaceRoots(null);
      return;
    }
    const selected = this.selectedSessionRoots(roots);
    const appliedRoots =
      applied === undefined
        ? this.store.getState().workspaceRoots?.applied ?? this.appliedSessionRoots() ?? null
        : applied;
    this.store.setWorkspaceRoots(buildWorkspaceRootsUi(roots, selected, appliedRoots));
  }

  /**
   * 为即将新建的会话计算 `settings.add_dirs`（null = 不写该键 = 与今天一致）。
   * cwd 与 ensureClient 同源（`services.workspaceRoot` 测试钩子优先）。
   */
  sessionAddDirs(): string[] | null {
    const roots = this.workspaceRootInfos();
    if (roots.length <= 1) return null;
    const cwd =
      this.services.workspaceRoot ??
      roots[0]?.path ??
      this.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      null;
    return buildAddDirs(this.selectedSessionRoots(roots), roots, cwd);
  }

  /**
   * 根选择器写回。只影响**之后新建**的会话：
   * - 持久化到 workspaceState，下一次 `startNewSession` 用它算 `add_dirs`；
   * - 刷新投影（`applied` 保持不变 → `pendingChange` 让 UI 提示「对新会话生效」）；
   * - 当前会话的 CLI 上下文、cwd、会话文件路径一律不动。
   *
   * 空选择归一为「全量根」：不提供「一个根都不给」的形态（那等于只剩 cwd，
   * 语义容易被误读成「工作区丢了」），UI 也会阻止取消最后一个根。
   */
  async setSessionRoots(roots: readonly string[]): Promise<void> {
    const all = this.workspaceRootInfos();
    if (all.length <= 1) return;
    const normalized = normalizeSelection(roots, all);
    const next = normalized.length > 0 ? normalized : all.map((r) => r.path);
    await this.context.workspaceState.update(SESSION_ROOTS_KEY, next);
    this.publishWorkspaceRoots();
  }

  /**
   * 为当前会话的重载（keep-session 热重认证、删除消息后截断重载）计算
   * `add_dirs`：用该会话**已记录**的根集合，而不是根选择器里的下一次偏好 ——
   * 重载不换会话，根可见范围必须保持不变，否则收紧过的会话会被悄悄放宽。
   */
  currentSessionAddDirs(): string[] | null {
    const all = this.workspaceRootInfos();
    if (all.length <= 1) return null;
    const cwd = this.services.workspaceRoot ?? all[0]?.path ?? null;
    return buildAddDirs(this.appliedSessionRoots(), all, cwd);
  }
}
