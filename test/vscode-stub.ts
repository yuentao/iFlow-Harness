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

/** Configuration stub: `get()` returns the override or the default. */
class WorkspaceConfiguration {
  constructor(private readonly overrides: Record<string, unknown> = {}) {}
  get<T>(key: string, defaultValue?: T): T {
    return (key in this.overrides ? this.overrides[key] : defaultValue) as T;
  }
}

export const workspace = {
  workspaceFolders: undefined as unknown[] | undefined,
  getConfiguration: (_section?: string) => new WorkspaceConfiguration(),
  createFileSystemWatcher: (_pattern: unknown) => new FileSystemWatcher(_pattern),
  onDidChangeConfiguration: () => new Disposable(),
};

export const window = {
  createOutputChannel: (name: string) => new LogOutputChannel(name),
  createStatusBarItem: () => new StatusBarItem(),
  activeColorTheme: { kind: ColorThemeKind.Dark },
  onDidChangeActiveColorTheme: () => new Disposable(),
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
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
