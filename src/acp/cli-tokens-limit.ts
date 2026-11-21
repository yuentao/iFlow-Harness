/**
 * Effective CLI context-window limit for the spawned subprocess.
 *
 * Why: the CLI derives its auto-compression threshold from
 * `compressionTokenThreshold` (default 0.8) × effective context window. If the
 * window falls back to the CLI's 128000 default, the threshold is 102400 and a
 * super-agent child's baseline (~103000) triggers compression immediately.
 * The CLI accepts a top-level `tokensLimit` override via env (`zOt()`'s
 * `CT("tokensLimit")`, candidates incl. `IFLOW_TOKENS_LIMIT`) spread LAST in the
 * settings merge — so passing it here wins over both the file's top-level key
 * and the Mod's `readTokensLimit()` without ever touching settings.json.
 *
 * Precedence for the effective value (positive integers only):
 *   active profile's `tokensLimit`  >  settings top-level `tokensLimit`  >  undefined.
 * Invalid/missing values are treated as absent. We deliberately do NOT invent a
 * default: when nothing valid is found we omit the env var and let the CLI use
 * its own tables — a bogus large number would be worse than no override.
 *
 * Zero VSCode dependency (only node-free pure logic + models-query, which is
 * itself VSCode-free), so it is directly unit-testable.
 */
import { readCliSettings } from "./models-query.js";

export interface TokensLimitHolder {
  tokensLimit?: unknown;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Resolve the effective tokens limit from the active profile and settings root. */
export function effectiveCliTokensLimit(
  activeProfile: TokensLimitHolder | null | undefined,
  settingsTopLevel: TokensLimitHolder | null | undefined,
): number | undefined {
  return positiveInt(activeProfile?.tokensLimit) ?? positiveInt(settingsTopLevel?.tokensLimit);
}

/** Spawn-env patch: sets IFLOW_TOKENS_LIMIT only for a positive integer. */
export function cliTokensLimitEnv(effective: number | undefined): { IFLOW_TOKENS_LIMIT?: string } {
  return positiveInt(effective) !== undefined ? { IFLOW_TOKENS_LIMIT: String(effective) } : {};
}

/**
 * Read settings.json fresh (kernel authority) and build the env patch for the
 * CLI subprocess. The active profile is the kernel `currentApiProfile` pointer;
 * its per-profile `tokensLimit` is the Mod-added key the CLI's whole-file
 * `saveSettings` never preserves, which is exactly why we surface it via env.
 */
export function tokensLimitEnvFromSettings(settingsPath?: string): { IFLOW_TOKENS_LIMIT?: string } {
  const settings = readCliSettings(settingsPath);
  if (!settings) return {};
  const activeName = settings.currentApiProfile?.trim();
  const activeProfile = activeName ? settings.apiProfiles?.[activeName] : undefined;
  return cliTokensLimitEnv(effectiveCliTokensLimit(activeProfile, settings));
}
