/**
 * 共享的 webview store mock 工厂。
 *
 * 为什么需要它：`test/` 下曾有 44 个文件各自手写 `vi.mock("../webview/src/store")`，
 * 每个只声明自己那次渲染碰巧读到的成员。store 新增一个 action / 视图（例如
 * 0cbaee9 的 `requestSuperProfileModels` / `superProfileModelsView`）时，没同步
 * 的那些 mock 会在组件挂载瞬间抛 `TypeError` —— 一次回归就带崩 19 个用例。
 * 这里按 `ChatStore` 的**完整表面**（全部 action + 全部视图）建一份默认 mock：
 * 组件新订阅任何成员都拿得到安全值，新成员的漂移在 smoke 测试里当场暴露。
 *
 * 默认值口径：
 * - 全部 action = `vi.fn()`（可直接断言调用）；
 * - 其余视图 = 真实 store 的首帧值（`state` 用共享的 `initialSessionState()`，
 *   `hostSettings` 用 store 里 `DEFAULT_HOST_SETTINGS` 的逐字副本并标注为
 *   `HostSettingsUi`，所以接口新增必填字段会在 `npm run typecheck` 直接报错，
 *   不会静默漏字段）；
 * - `overrides` 支持顶层合并；`hostSettings` / `state` 额外做一层深合并，方便
 *   只改一个开关（`{ hostSettings: { theme: "dark" } }`）。
 *
 * ## `vi.mock` 的 hoisting —— 必须这样用
 *
 * `vi.mock(path, factory)` 会被 vitest 提升到文件最顶部（早于 import），而
 * factory 在「被测模块第一次 import」时执行。因此**不能在文件顶部静态 import
 * 本模块再在 factory 里直接用**（那时绑定还在 TDZ）。让 factory 动态 import：
 *
 * ```ts
 * // ① 最简：只需把 store 喂给被测组件
 * vi.mock("../webview/src/store", async () => {
 *   const { createStoreMock } = await import("./helpers/store-mock");
 *   return createStoreMock(); // 可按需传 overrides
 * });
 *
 * // ② 需要在断言里访问 vi.fn / 中途改写视图时：用 vi.hoisted 槽位接住实例
 * import type { StoreMock } from "./helpers/store-mock"; // 纯类型导入，编译后消失
 * const storeMock = vi.hoisted(() => ({ current: null as unknown as StoreMock }));
 * vi.mock("../webview/src/store", async () => {
 *   const { createStoreMock } = await import("./helpers/store-mock");
 *   const mock = createStoreMock({ hostSettings: { theme: "dark" } });
 *   storeMock.current = mock;
 *   return mock; // 工厂对象即 mock 模块命名空间：{ useChat, getState, store, actions }
 * });
 * // factory 已在 import 阶段执行完毕，模块体里可以安全取用：
 * const { send, updateHostSetting } = storeMock.current.actions;
 * const hostSettings = storeMock.current.store.hostSettings; // 可变引用
 * ```
 *
 * 被测组件只 import `useChat`，所以工厂返回的附加句柄（`store` / `actions` /
 * `getState` / `set`）对组件无副作用；`useChat.getState()` 与真实 zustand store
 * 一样返回同一份可变 store（`SettingsModal` 的 `beginPending` 就是这样调的）。
 */
import { vi } from "vitest";
import {
  initialSessionState,
  pickQqSettingsUi,
  type Block,
  type ContextWindowOverridesUi,
  type HostSettingsUi,
  type HostToWebview,
  type ModelMetadataStateUi,
  type QqSettingsUi,
  type SessionState,
  type SuperProfileModelsUi,
} from "../../shared/messages";
// 纯类型导入：store.ts 在测试里整体被 mock，这里不产生任何运行时依赖。
import type { PendingOpKind, ToastItem } from "../../webview/src/store";

/** 每个 action 都是 `vi.fn()` 的返回类型，断言时直接 `expect(actions.send)...`。 */
export type ActionMock = ReturnType<typeof vi.fn>;

/**
 * `webview/src/store.ts` 里 `ChatStore` 的全部 action（逐项对应）。
 *
 * `ChatStore` 本身没有导出，所以这里用结构化副本 + 类型标注：漏一个成员时
 * 组件挂载会抛 `TypeError`（smoke 测试兜住），改签名时组件侧编译报错。
 */
export interface StoreActions {
  respondSuperResidueConfirm: ActionMock;
  requestSuperResidueList: ActionMock;
  handleSuperResidueAction: ActionMock;
  updateHostSetting: ActionMock;
  requestSuperProfileModels: ActionMock;
  dismissToast: ActionMock;
  notify: ActionMock;
  setHeaderScrolled: ActionMock;
  toggleFocusMode: ActionMock;
  requestDraft: ActionMock;
  clearDraftRequest: ActionMock;
  requestMemoryDraft: ActionMock;
  clearMemoryDraft: ActionMock;
  applyHostMessage: ActionMock;
  beginPending: ActionMock;
  clearPending: ActionMock;
  send: ActionMock;
}

/** `ChatStore` 的全部视图字段（组件用 selector 读的那些）。 */
export interface StoreViews {
  state: SessionState | null;
  superTranscripts: Record<string, Block[]>;
  superResidueConfirm: Extract<HostToWebview, { type: "superResidueConfirm" }> | null;
  superResidueList: Extract<HostToWebview, { type: "superResidueList" }> | null;
  superResidueRequestId: string | null;
  superResidueLoading: boolean;
  qqSettings: QqSettingsUi;
  qqStatus: { connected: boolean; detail?: string } | null;
  remoteTakeover: boolean;
  qqPendingUsers: Extract<HostToWebview, { type: "qqPendingUsers" }>["users"];
  qqLoginQr: Extract<HostToWebview, { type: "qqLoginQr" }> | null;
  qqManagedStatus: Extract<HostToWebview, { type: "qqManagedStatus" }> | null;
  editorTheme: "light" | "dark" | null;
  hostSettings: HostSettingsUi;
  contextWindowOverridesView: ContextWindowOverridesUi | null;
  superProfileModelsView: SuperProfileModelsUi | null;
  superProfileModelsRequestId: number | null;
  modelMetadata: ModelMetadataStateUi;
  toasts: ToastItem[];
  pending: { kind: PendingOpKind; target: string } | null;
  promptSeq: number;
  headerScrolled: boolean;
  focusMode: boolean;
  composerDraftRequest: { text: string; seq: number } | null;
  memoryDraftRequest: { text: string; seq: number } | null;
}

/** mock 的完整 store：视图 + action 同一份对象（selector 每次都取到它）。 */
export type StoreMockState = StoreViews & StoreActions;

/**
 * 覆盖项：视图按顶层键替换；`hostSettings` / `state` 支持深一层合并
 * （`state.auth` 再合一层），免得每个测试重复整份默认设置。
 */
export type StoreMockOverrides = Omit<Partial<StoreMockState>, "hostSettings" | "state"> & {
  hostSettings?: Partial<HostSettingsUi>;
  state?: Partial<SessionState> | null;
};

/** 模拟 zustand hook：`useChat(selector)` 同步取到当前 store，`getState()` 直读。 */
export interface UseChatMock {
  <T>(selector: (state: StoreMockState) => T): T;
  getState: () => StoreMockState;
}

export interface StoreMock {
  /** 可变 store（selector 与 getState 都指向它；测试可原地改字段）。 */
  store: StoreMockState;
  /** 与 `store` 上同一批 `vi.fn()` 实例的便捷句柄。 */
  actions: StoreActions;
  /** 喂给 `vi.mock` 工厂的 `useChat` 导出。 */
  useChat: UseChatMock;
  /** 等价于 `useChat.getState`。 */
  getState: () => StoreMockState;
  /** 测试中途合并覆盖（`hostSettings` / `state` 深合并，其余顶层替换）。 */
  set: (overrides: StoreMockOverrides) => void;
}

/**
 * webview store 首帧的 `hostSettings` 默认值（与 `webview/src/store.ts` 的
 * `DEFAULT_HOST_SETTINGS` 逐字一致）。该常量没有从 store 导出，这里复刻一
 * 份；`HostSettingsUi` 标注保证接口新增必填字段时 typecheck 立刻失败。
 */
export const DEFAULT_HOST_SETTINGS: HostSettingsUi = {
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: true,
  autoTitle: true,
  efficiencyMode: "steady",
  memoryExtractTimeoutSeconds: 90,
  memoryMaintenanceEnabled: false,
  memoryMaintenanceIntervalDays: 7,
  memoryMaintenanceIdleMinutes: 15,
  memoryMaintenanceGlobalTokenBudget: 4000,
  memoryMaintenanceProjectTokenBudget: 2500,
  memoryMaintenanceTotalTokenBudget: 12000,
  memoryMaintenanceStrategy: "report",
  nextStepTimeoutSeconds: 25,
  compressTimeoutSeconds: 0,
  autoCompressThresholdPercent: 95,
  restoreLastSession: false,
  autoOpenPanel: false,
  warmStart: true,
  soundFeedback: true,
  osNotifications: "approvals",
  language: "",
  theme: "auto",
  auroraIntensity: 35,
  uiFontSize: "standard",
  uiDensity: "standard",
  nodePath: "",
  checkpoints: true,
  checkpointMaxFiles: 50_000,
  checkpointMaxFileMB: 300,
  checkpointDir: "",
  checkpointMaxTurns: 0,
  checkpointMaxSizeMB: 0,
  contextWindowOverrides: [],
  costTable: [],
  thinkingModelRules: [],
  superAgentMaxConcurrent: 5,
  superAgentMaxAttempts: 2,
  superAgentDependencyPolicy: "block",
  superAgentIntegration: "merge",
  superAgentMaxWorktrees: 10,
  superAgentKeepWorktree: false,
  superAgentFullTrust: false,
  superAgentDefaultWorkspace: "",
};

function createActions(): StoreActions {
  return {
    respondSuperResidueConfirm: vi.fn(),
    requestSuperResidueList: vi.fn(),
    handleSuperResidueAction: vi.fn(),
    updateHostSetting: vi.fn(),
    requestSuperProfileModels: vi.fn(),
    dismissToast: vi.fn(),
    notify: vi.fn(),
    setHeaderScrolled: vi.fn(),
    toggleFocusMode: vi.fn(),
    requestDraft: vi.fn(),
    clearDraftRequest: vi.fn(),
    requestMemoryDraft: vi.fn(),
    clearMemoryDraft: vi.fn(),
    applyHostMessage: vi.fn(),
    beginPending: vi.fn(),
    clearPending: vi.fn(),
    send: vi.fn(),
  };
}

/** 合并覆盖项（就地改 `store`）。 */
function applyOverrides(store: StoreMockState, overrides: StoreMockOverrides): void {
  const { hostSettings, state, ...rest } = overrides;
  if (hostSettings) {
    store.hostSettings = Object.assign({}, store.hostSettings, hostSettings);
  }
  if (state === null) {
    store.state = null;
  } else if (state) {
    // 始终以全新的 initialSessionState() 为底，避免与其它 mock 共享引用。
    const prev = store.state ?? initialSessionState();
    const merged = Object.assign(initialSessionState(), prev, state);
    if (state.auth) merged.auth = Object.assign({}, prev.auth, state.auth);
    store.state = merged;
  }
  Object.assign(store, rest);
}

/**
 * 建一个完整的 store mock。
 *
 * @param overrides 只写需要改的部分；`hostSettings` / `state` 深合并一层。
 */
export function createStoreMock(overrides: StoreMockOverrides = {}): StoreMock {
  const actions = createActions();
  const store: StoreMockState = {
    state: initialSessionState(),
    superTranscripts: {},
    superResidueConfirm: null,
    superResidueList: null,
    superResidueRequestId: null,
    superResidueLoading: false,
    qqSettings: pickQqSettingsUi({}, { hasAppSecret: false }),
    qqStatus: null,
    remoteTakeover: false,
    qqPendingUsers: [],
    qqLoginQr: null,
    qqManagedStatus: null,
    editorTheme: null,
    hostSettings: Object.assign({}, DEFAULT_HOST_SETTINGS),
    contextWindowOverridesView: null,
    superProfileModelsView: null,
    superProfileModelsRequestId: null,
    modelMetadata: { state: "idle" },
    toasts: [],
    pending: null,
    promptSeq: 0,
    headerScrolled: false,
    focusMode: false,
    composerDraftRequest: null,
    memoryDraftRequest: null,
    ...actions,
  };

  const getState = (): StoreMockState => store;
  const useChat: UseChatMock = Object.assign(
    <T>(selector: (state: StoreMockState) => T): T => selector(store),
    { getState },
  );

  const mock: StoreMock = {
    store,
    actions,
    useChat,
    getState,
    set: (next) => applyOverrides(store, next),
  };
  applyOverrides(store, overrides);
  return mock;
}
