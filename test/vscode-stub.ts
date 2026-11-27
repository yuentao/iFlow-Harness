/**
 * Minimal "vscode" module stub for vitest. `shared/` modules import
 * `vscode.l10n` for user-facing strings; tests run with the source language
 * (Chinese) so the message table is identity. `t(message, args…)` performs
 * the real `vscode.l10n.t` `{0}`-indexed substitution so formatted strings
 * (e.g. "上下文已压缩：{0} → {1} tokens") assert against concrete text.
 *
 * The rest of the surface exists for `src/panel/panel.ts` (ChatPanel
 * integration tests): the constructor touches the Output channel, status bar,
 * configuration, and file-system watchers, so those are stubbed too. Tests
 * inject their own watchers via `services.watchers` to skip the watcher API.
 */
export const l10n = {
  t: (message: string, ...args: unknown[]): string =>
    args.length === 0
      ? message
      : message.replace(/\{(\d+)\}/g, (m, i: string) => {
          const v = args[Number(i)];
          return v === undefined ? m : String(v);
        }),
};

/** Disposable stub: `dispose()` is a no-op, listeners are dropped. */
export class Disposable {
  dispose(): void {}
}

/** Uri stub: only `fsPath`/`toString()` matter to the panel. */
export class Uri {
  private constructor(readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.fsPath, ...segments].join("/"));
  }
  toString(): string {
    return this.fsPath;
  }
}

export const RelativePattern = class {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
};

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel(): void {}
  dispose(): void {}
}

/** LogOutputChannel stub: records levels so tests can assert on the trail. */
export class LogOutputChannel {
  readonly name: string;
  readonly lines: { level: string; message: string }[] = [];
  constructor(name: string) {
    this.name = name;
  }
  private record(level: string, ...args: unknown[]): void {
    this.lines.push({ level, message: args.map(String).join(" ") });
  }
  trace(...args: unknown[]): void {
    this.record("trace", ...args);
  }
  debug(...args: unknown[]): void {
    this.record("debug", ...args);
  }
  info(...args: unknown[]): void {
    this.record("info", ...args);
  }
  warn(...args: unknown[]): void {
    this.record("warn", ...args);
  }
  error(...args: unknown[]): void {
    this.record("error", ...args);
  }
  show(): void {}
  hide(): void {}
  clear(): void {
    this.lines.length = 0;
  }
  dispose(): void {}
}

/** StatusBarItem stub: records the last text/background it was given. */
export class StatusBarItem {
  text = "";
  tooltip = "";
  command = "";
  backgroundColor: unknown = undefined;
  show(): void {}
  hide(): void {}
  dispose(): void {}
}

/** FileSystemWatcher stub: records subscriptions, never fires. */
export class FileSystemWatcher {
  private readonly subs: (() => void)[] = [];
  constructor(public readonly pattern: unknown) {}
  onDidCreate(listener: () => void): Disposable {
    this.subs.push(listener);
    return new Disposable();
  }
  onDidChange(listener: () => void): Disposable {
    this.subs.push(listener);
    return new Disposable();
  }
  onDidDelete(listener: () => void): Disposable {
    this.subs.push(listener);
    return new Disposable();
  }
  dispose(): void {}
}

/** Write target for `WorkspaceConfiguration.update()`; values mirror VSCode's
 * public enum so `ConfigurationTarget.Global` is usable from the panel. The
 * stub configuration has no `update()` unless a test opts into recording
 * (`enableConfigUpdateRecording`), so a write throws by default — tests like
 * `panel-busy-receipts` rely on that "write rejected" path. */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** Test hook shape: 一个 `iflow.*` 键在各作用域上的覆盖值。 */
export interface StubConfigScopeValues {
  /** 用户级（Global）值。 */
  global?: unknown;
  /** 工作区级值（单根窗口的 .vscode/settings.json）。 */
  workspace?: unknown;
  /** 多根：按 `workspaceFolders[i].uri.fsPath` 索引的 folder 级值。 */
  folders?: Record<string, unknown>;
}

const configScopeValues = new Map<string, StubConfigScopeValues>();

const scopeKey = (key: string): string => (key.startsWith("iflow.") ? key : `iflow.${key}`);
const shortKey = (key: string): string =>
  key.startsWith("iflow.") ? key.slice("iflow.".length) : key;

/** Test hook: 给 `inspect()` 装上分层值（global / workspace / folder）。默认全空。 */
export function setConfigScopeValues(values: Record<string, StubConfigScopeValues>): void {
  configScopeValues.clear();
  for (const [key, value] of Object.entries(values)) configScopeValues.set(scopeKey(key), value);
}

/** Test hook: 清空分层值。 */
export function resetConfigScopeValues(): void {
  configScopeValues.clear();
}

/** 一次 `update()` 调用的记录（只有显式开启记录后才会产生）。 */
export interface StubConfigUpdate {
  key: string;
  value: unknown;
  target: ConfigurationTarget | undefined;
  /** folder 级配置对象的 scope（`getConfiguration(section, folder.uri)`）。 */
  scopePath?: string;
}

const configUpdates: StubConfigUpdate[] = [];
let configUpdateRecording = false;

/** Test hook: 开启 `update()` 记录。关闭时配置对象没有 `update`，写入照旧抛错。 */
export function enableConfigUpdateRecording(): void {
  configUpdateRecording = true;
}

/** Test hook: 取出（不清空）`update()` 记录。 */
export function getConfigUpdates(): StubConfigUpdate[] {
  return [...configUpdates];
}

/** Test hook: 关闭记录并清空。 */
export function resetConfigUpdates(): void {
  configUpdateRecording = false;
  configUpdates.length = 0;
}

/** Configuration stub: `get()` returns the override or the default. Tests
 * inject overrides via `setConfigOverrides` (e.g. the osNotifications tier);
 * `setConfigScopeValues` additionally fills the workspace / folder layers for
 * `inspect()` (backward compatible — all layers empty by default). */
class WorkspaceConfiguration {
  /** 只在 `enableConfigUpdateRecording()` 后存在；默认没有它 → 写入抛错。 */
  update?: (
    key: string,
    value: unknown,
    target?: ConfigurationTarget,
  ) => Promise<void>;

  constructor(
    private readonly overrides: Record<string, unknown> = {},
    /** `getConfiguration(section, folder.uri)` 传入的 folder 级 scope。 */
    private readonly scopePath?: string,
  ) {
    if (configUpdateRecording) {
      this.update = async (key, value, target) => {
        configUpdates.push({
          key,
          value,
          target,
          ...(this.scopePath === undefined ? {} : { scopePath: this.scopePath }),
        });
      };
    }
  }

  private folderValue(short: string): unknown {
    const scopes = configScopeValues.get(scopeKey(short));
    if (!scopes?.folders || this.scopePath === undefined) return undefined;
    return scopes.folders[this.scopePath];
  }

  get<T>(key: string, defaultValue?: T): T {
    const short = shortKey(key);
    if (key in this.overrides) return this.overrides[key] as T;
    const scopes = configScopeValues.get(scopeKey(short));
    if (scopes) {
      // 原生优先级（folder > workspace > global）：这是「合并后」的值，
      // QQ 读侧的 Global 优先解析走 inspect()，两者刻意不同。
      const effective = this.folderValue(short) ?? scopes.workspace ?? scopes.global;
      if (effective !== undefined) return effective as T;
    }
    return defaultValue as T;
  }

  /** Registry probe used by the panel's `isUserSettingRegistered`: the stub has
   * no manifest to consult, so every key reports a defaultValue (non-undefined
   * = "declared") unless the test marked it unregistered. */
  inspect(key: string): {
    key: string;
    defaultValue: unknown;
    globalValue: unknown;
    workspaceValue: unknown;
    workspaceFolderValue: unknown;
  } {
    const short = shortKey(key);
    const unregistered = unregisteredConfigKeys.has(key) || unregisteredConfigKeys.has(short);
    const scopes = configScopeValues.get(scopeKey(short));
    return {
      key: `iflow.${short}`,
      defaultValue: unregistered ? undefined : (short in this.overrides ? this.overrides[short] : true),
      globalValue: scopes && "global" in scopes ? scopes.global : this.overrides[short],
      workspaceValue: scopes?.workspace,
      workspaceFolderValue: this.folderValue(short),
    };
  }
}

/** Test hook: `iflow.*` keys whose declaration is NOT in this window's
 * configuration registry (an in-place extension upgrade leaves the renderer
 * on the previous manifest). Pass an empty array to clear. */
const unregisteredConfigKeys = new Set<string>();
export function setUnregisteredConfigKeys(keys: string[]): void {
  unregisteredConfigKeys.clear();
  for (const key of keys) unregisteredConfigKeys.add(key);
}

/** Test hook: the keys currently marked unregistered, so a test-installed
 * configuration fake can mirror the same "old manifest" view. */
export function getUnregisteredConfigKeys(): string[] {
  return [...unregisteredConfigKeys];
}

const configOverrides: Record<string, unknown> = {
  // Hermetic tests: panel integration tests drive real sendPrompt flows, and
  // the turn-end predictor is a direct gateway call. Keep it off unless a test
  // explicitly opts in — the production default (true) lives in package.json
  // and in the panel's get() fallback.
  nextStepSuggestions: false,
};

/** Test hook: set `iflow.*` configuration values returned by the stub. */
export function setConfigOverrides(values: Record<string, unknown>): void {
  for (const key of Object.keys(configOverrides)) delete configOverrides[key];
  Object.assign(configOverrides, { nextStepSuggestions: false }, values);
}

/** 工作区文件夹变化事件的监听器（测试可手动触发）。 */
const workspaceFolderListeners: Array<() => void> = [];

/** Test hook: 替换 `workspace.workspaceFolders`（`undefined` = 无文件夹窗口）。 */
export function setWorkspaceFolders(
  folders: Array<{ uri: { fsPath: string } }> | undefined,
): void {
  workspace.workspaceFolders = folders as unknown[] | undefined;
}

/**
 * Test hook: 手动触发 `onDidChangeWorkspaceFolders`（真实 VSCode 在多根工作区
 * 增删文件夹 / 空窗口打开文件夹时触发）。单个监听器抛错不影响其它监听器 ——
 * 用例断言的是副作用，不是监听器异常。
 */
export function fireWorkspaceFoldersChanged(): void {
  for (const listener of [...workspaceFolderListeners]) {
    try {
      listener();
    } catch {
      // 已销毁面板的监听器可能抛错：测试只关心当前用例的接线。
    }
  }
}

/** Test hook: 清空文件夹监听器与根集合（用例之间互不串味）。 */
export function resetWorkspaceFoldersStub(): void {
  workspaceFolderListeners.length = 0;
  workspace.workspaceFolders = undefined;
}

export const workspace = {
  workspaceFolders: undefined as unknown[] | undefined,
  getConfiguration: (_section?: string, scope?: { fsPath?: string } | null) =>
    new WorkspaceConfiguration(configOverrides, scope?.fsPath),
  createFileSystemWatcher: (_pattern: unknown) => new FileSystemWatcher(_pattern),
  onDidChangeConfiguration: () => new Disposable(),
  // 多仓库协作：根集合变化监听 + @ 文件搜索（默认空结果）。
  onDidChangeWorkspaceFolders: (listener: unknown) => {
    workspaceFolderListeners.push(listener as () => void);
    return new Disposable();
  },
  findFiles: async (_include?: unknown, _exclude?: unknown, _maxResults?: number) => [] as Uri[],
  asRelativePath: (p: string | { fsPath: string }) =>
    (typeof p === "string" ? p : p.fsPath).replace(/\\/g, "/"),
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export interface StubDiagnostic {
  severity: DiagnosticSeverity;
  range: { start: { line: number } };
  message: string;
}

/** Diagnostics stub: empty by default; tests can replace `getDiagnostics`. */
export const languages: {
  getDiagnostics: () => Array<[Uri, StubDiagnostic[]]>;
  onDidChangeDiagnostics: () => Disposable;
} = {
  getDiagnostics: () => [],
  onDidChangeDiagnostics: () => new Disposable(),
};

/** Terminal stub: created terminals are recorded so tests can assert on
 * sendText calls (open/rerun in terminal). */
export interface StubTerminal {
  name: string;
  exitStatus: undefined;
  sentTexts: Array<{ text: string; shouldExecute: boolean }>;
  shown: number;
  show(): void;
  sendText(text: string, shouldExecute?: boolean): void;
}

const stubTerminals: StubTerminal[] = [];

function createStubTerminal(opts?: { name?: string; cwd?: string }): StubTerminal {
  const terminal: StubTerminal = {
    name: opts?.name ?? "terminal",
    exitStatus: undefined,
    sentTexts: [],
    shown: 0,
    show() {
      this.shown++;
    },
    sendText(text: string, shouldExecute = true) {
      this.sentTexts.push({ text, shouldExecute });
    },
  };
  stubTerminals.push(terminal);
  return terminal;
}

/** Test hook: drop all stub terminals (openInTerminal reuses by name). */
export function resetStubTerminals(): void {
  stubTerminals.length = 0;
}

export { stubTerminals };

export const window = {
  createOutputChannel: (name: string) => new LogOutputChannel(name),
  createStatusBarItem: () => new StatusBarItem(),
  activeColorTheme: { kind: ColorThemeKind.Dark },
  onDidChangeActiveColorTheme: () => new Disposable(),
  /** Mutable so tests drive the turnDone focus gate (shared/notifications). */
  state: { focused: true },
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  terminals: stubTerminals,
  createTerminal: createStubTerminal,
  onDidCloseTerminal: () => new Disposable(),
  // No onDidStart/EndTerminalShellExecution: the recorder runtime-detects
  // these and reports unavailable, which is the pre-1.93 production path.
};

export const env = {
  language: "zh-CN",
  openExternal: () => Promise.resolve(true),
};

export const commands = {
  executeCommand: () => Promise.resolve(undefined),
};

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}
