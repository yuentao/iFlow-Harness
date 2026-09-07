/**
 * Minimal "vscode" module stub for vitest: shared/ modules import
 * `vscode.l10n` for user-facing strings; tests run with the source language
 * (Chinese) so identity translation keeps assertions stable.
 */
export const l10n = {
  t: (message: string, ..._args: unknown[]): string => message,
};
