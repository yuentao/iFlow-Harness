/**
 * SettingsWriteService — panel-owned `iflow.*` settings read/write and the
 * pending-write stash, extracted from `panel.ts` (panel split: 设置写入簇;
 * behavior-preserving refactor).
 *
 * Owns the whole stash lifecycle: registry probe, stash-priority read, stash /
 * drop, replay after a window reload, and the single-key write with its
 * "write failed" toast. Every invariant the user relies on stays byte-identical:
 *   • VSCode configuration is written ONLY through
 *     `getConfiguration("iflow").update(key, value, ConfigurationTarget.Global)`
 *     — a single-key merge. There is no whole-file read/modify/write anywhere
 *     in this module, and none may be added (settings.json is user-editable).
 *   • A write failure toast always carries the REAL rejection reason
 *     (`errorMessage(error)`): read-only settings.json, invalid JSON, Settings
 *     Sync conflict, stale vsix/schema, etc. It is never replaced by a generic
 *     "请检查设置" message.
 *   • An unregistered key is stashed in globalState (never on disk) and the
 *     toast tells the user to reload the window; `applyPendingSettings`
 *     replays it with Global once the declaration is known again.
 *   • Reads put the stash on top of the configuration layer and use
 *     `hasOwnProperty`, so a stashed `false` / `0` / `""` is not mistaken for a
 *     missing value.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. Everything panel-owned
 * arrives through {@link SettingsWriteServiceDeps}; every value is read at CALL
 * TIME through an arrow callback (AGENTS.md pitfall #8), never captured as a
 * construction-time snapshot. `ChatPanel` keeps same-named thin delegates, so
 * its ~40 `readUserSetting` call sites, the webview-message switch, the deps
 * injected into other services, `extension.ts` and every existing test keep the
 * exact same contract. New wire message types: zero.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import * as vscode from "vscode";
import { errorMessage } from "../acp/jsonrpc.js";

/** globalState key: user-settings writes stashed because this window's
 * configuration registry has not loaded their declaration yet (an in-place
 * extension upgrade keeps the renderer on the previous manifest). Replayed by
 * `applyPendingSettings` once the reloaded window knows the key again. */
const PENDING_SETTINGS_KEY = "iflow.pendingSettingsWrites";

/** The narrow panel surface this service needs. All four members are LIVE
 * reads/actions at call time — the panel passes arrows bound to `this`, never
 * a constructor-time value that could go stale (workspace/config/state/log). */
export interface SettingsWriteServiceDeps {
  /** Live VSCode configuration — `getConfiguration("iflow")` at call time. */
  getConfiguration(section: string): vscode.WorkspaceConfiguration;
  /** Live globalState (the stash lives here, never in settings.json). */
  getGlobalState(): vscode.Memento;
  /** Store toast sink (assigns toastId so action clicks can be routed). */
  sendToast(
    level: "info" | "warning" | "error",
    message: string,
    opts?: {
      sticky?: boolean;
      action?: { actionId: string; label: string };
    },
  ): number;
  /** Structured log sink (host output channel). */
  warn(message: string): void;
}

export class SettingsWriteService {
  constructor(private readonly deps: SettingsWriteServiceDeps) {}

  /** Panel-shaped proxies: the migrated method bodies stay verbatim while
   *  every read still goes through a call-time callback (pitfall #8). */
  private get workspace(): { getConfiguration(section: string): vscode.WorkspaceConfiguration } {
    return { getConfiguration: (section) => this.deps.getConfiguration(section) };
  }
  private get context(): { globalState: vscode.Memento } {
    return { globalState: this.deps.getGlobalState() };
  }
  private get store(): { sendToast: SettingsWriteServiceDeps["sendToast"] } {
    return {
      sendToast: (level, message, opts) =>
        opts === undefined
          ? this.deps.sendToast(level, message)
          : this.deps.sendToast(level, message, opts),
    };
  }
  private get log(): { warn(message: string): void } {
    return { warn: (message) => this.deps.warn(message) };
  }

  /** True when the running window's configuration registry knows this key's
   * default layer. `get()` is NOT a valid probe — it also reads the user's
   * settings.json; `inspect().defaultValue` comes from the registry only.
   * Every `iflow.*` declares a default (locked by settings-declared.test), so
   * an undefined defaultValue means the declaration is missing from this
   * window (in-place extension upgrade: the renderer keeps the old manifest
   * until the window reloads). */
  isUserSettingRegistered(key: string): boolean {
    const info = this.workspace.getConfiguration("iflow").inspect(key);
    return info !== undefined && info.defaultValue !== undefined;
  }

  /** Current stash of settings writes waiting for their declaration. */
  pendingSettingsWrites(): Record<string, unknown> {
    return { ...(this.context.globalState.get<Record<string, unknown>>(PENDING_SETTINGS_KEY) ?? {}) };
  }

  /** Read one `iflow.*` setting with the stash as the top layer.
   *
   * A key this window does not register cannot be written (see
   * `writeUserSetting`), so the stashed value is the only copy of the user's
   * choice until the window reloads. Reading it back here keeps the UI from
   * snapping to the old value and keeps the scheduler on the user's choice;
   * once `applyPendingSettings` lands it on disk the stash is dropped and the
   * configuration layer takes over. */
  readUserSetting<T>(key: string, fallback: T): T {
    const pending = this.pendingSettingsWrites();
    if (Object.prototype.hasOwnProperty.call(pending, key)) return pending[key] as T;
    return this.workspace.getConfiguration("iflow").get<T>(key, fallback);
  }

  /** Stash one write in globalState (never on disk): it is replayed by
   * `applyPendingSettings` once the key is registered again. */
  async stashPendingSetting(key: string, value: unknown): Promise<void> {
    const pending = this.pendingSettingsWrites();
    pending[key] = value;
    await this.context.globalState.update(PENDING_SETTINGS_KEY, pending);
  }

  /** Drop one stashed write (it landed, or a fresh write superseded it). */
  async dropPendingSetting(key: string): Promise<void> {
    const pending = this.pendingSettingsWrites();
    if (!(key in pending)) return;
    delete pending[key];
    await this.context.globalState.update(PENDING_SETTINGS_KEY, pending);
  }

  /** Replay stashed writes whose declarations this window registers now (i.e.
   * after the reload the stashing toast asked for). Keys still unregistered
   * stay stashed for the next attempt. */
  async applyPendingSettings(): Promise<void> {
    for (const [key, value] of Object.entries(this.pendingSettingsWrites())) {
      if (!this.isUserSettingRegistered(key)) continue;
      try {
        await this.workspace.getConfiguration("iflow").update(key, value, vscode.ConfigurationTarget.Global);
        await this.dropPendingSetting(key);
      } catch (error) {
        // Keep the stash: the next window may be able to write it.
        this.log.warn(`failed to apply stashed setting ${key}: ${errorMessage(error)}`);
      }
    }
  }

  /** Write one panel-owned setting to USER settings (the scope VSCode
   * Settings Sync carries). Validation happens at the call site.
   *
   * Returns whether the write landed. `label` is an optional human-readable
   * name for the setting, shown in the failure toast instead of the raw key
   * (a caller that has to react to a failed write uses the return value —
   * the toast is emitted here, so nobody double-toasts). */
  async writeUserSetting(key: string, value: unknown, label?: string): Promise<boolean> {
    if (!this.isUserSettingRegistered(key)) {
      // An in-place upgrade leaves this window on the previous manifest, so
      // VSCode rejects the write with "not a registered configuration". Stash
      // it and tell the user the one action that makes it land.
      await this.stashPendingSetting(key, value);
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "设置「{0}」属于刚更新的扩展版本，本窗口还没加载它的定义，已暂存并立即生效；请重启 VS Code（先试重新加载窗口，仍无效则完全退出再启动）。",
          label ?? key,
        ),
        {
          sticky: true,
          action: { actionId: "reload-window", label: vscode.l10n.t("重新加载窗口") },
        },
      );
      return false;
    }
    try {
      await this.workspace.getConfiguration("iflow").update(key, value, vscode.ConfigurationTarget.Global);
      await this.dropPendingSetting(key);
      return true;
    } catch (error) {
      const detail = errorMessage(error);
      this.log.warn(`failed to update ${key}: ${detail}`);
      // A silent failure made the control look like it "snapped back" on its
      // own — say which setting could not be written (the value the user sees
      // is the one VSCode still has on disk). The rejection reason is the only
      // clue the user has (read-only settings.json, invalid JSON, schema
      // rejection, unknown key), so it rides along in the toast instead of
      // staying in the Output log.
      this.store.sendToast("warning", vscode.l10n.t("设置写入失败：{0}（{1}）", label ?? key, detail));
      return false;
    }
  }
}
