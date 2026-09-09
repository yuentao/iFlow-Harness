/**
 * Minimal "vscode" module stub for vitest: shared/ modules import
 * `vscode.l10n` for user-facing strings; tests run with the source language
 * (Chinese) so the message table is identity. `t(message, args…)` performs
 * the real `vscode.l10n.t` `{0}`-indexed substitution so formatted strings
 * (e.g. "上下文已压缩：{0} → {1} tokens") assert against concrete text.
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