/**
 * Effective CLI context-window limit for the spawned subprocess — the single
 * resolver behind every push of the window to the CLI (main session spawn,
 * child spawn, model hot-switch).
 *
 * Why this exists: the CLI derives its auto-compression threshold from
 * `compressionTokenThreshold` (default 0.8) × effective context window, and
 * resolves that window through its own `JR(model, limit)` chain — an env
 * override, then `~/.iflow/settings.json`'s top-level `tokensLimit`, then a
 * table of a handful of exact model ids, then a regex pattern table whose
 * `default` branch is tiny (65k). A modern id such as
 * `auto/deepseek-v4.1-flash` matches neither exact table and therefore falls
 * into that tiny default: every single turn crossed the 0.8 ratio and ran a
 * FULL auto-compression, while the panel's occupancy bar showed the real 1M
 * window — one model, two windows.
 *
 * The host already knows the real window (curated table + explicit user
 * overrides + the kernel's profile/settings keys), so the host's resolution is
 * pushed to the CLI as the single authority. The CLI accepts it via env
 * (`zOt()`'s `CT("tokensLimit")`, spread LAST in the settings merge), so it
 * wins over the file's top-level key, the Mod's `readTokensLimit()` and the
 * CLI's own tables — no settings.json write needed.
 *
 * Precedence for the effective value (positive integers only), high → low:
 *   1. `user`          — `iflow.contextWindowOverrides` entry for this model
 *   2. `profile`       — the active API profile's `tokensLimit`
 *   3. `settings`      — `~/.iflow/settings.json` top-level `tokensLimit`
 *   4. `builtin-table` — curated window table hit (longest-prefix match)
 *   5. (nothing)       — we push NOTHING.
 *
 * Tier 5 is deliberate: an unfounded estimate is worse than no override at
 * all (the very bug this resolver fixes), so there is no fallback number
 * here. Unknown models leave the CLI's own tables alone.
 *
 * The chain itself lives in `shared/context-window.ts`
 * (`resolveContextWindowAuthority`) — the webview occupancy bar resolves its
 * window through the SAME function with the SAME inputs, so the number shown
 * in the panel and the number pushed to the CLI can never diverge (that was
 * the "one model, two windows" bug: the bar ignored the profile / settings
 * tiers). This module is only the host-side adapter: it reads the kernel
 * settings file and feeds the two kernel-derived tiers into the shared
 * resolver.
 *
 * Zero VSCode dependency (pure logic + models-query, which is itself
 * VSCode-free), so it is directly unit-testable.
 */
import { statSync } from "node:fs";
import { readCliSettings, settingsFilePath } from "./models-query.js";
import {
  positiveTokenLimit,
  resolveContextWindowAuthority,
  type ContextWindowAuthoritySource,
} from "../../shared/context-window.js";

/** Where the resolved number came from — mirrors the authority chain above. */
export type CliTokensLimitSource = ContextWindowAuthoritySource;

/** The resolved window plus its provenance. `limit === undefined` means
 * "no authority" — the caller must push nothing. */
export interface CliTokensLimitResolution {
  limit: number | undefined;
  source: CliTokensLimitSource | undefined;
}

export interface ResolveCliTokensLimitOptions {
  /** Model id as the host knows it — may carry a `provider/` prefix
   * (`auto/deepseek-v4.1-flash`); keys are normalized before matching. */
  modelId?: string | null;
  /** Parsed `iflow.contextWindowOverrides` (keys already normalized by
   * `parseContextWindowOverrides`). */
  overrides?: Record<string, number>;
  /** Kernel settings file to read; defaults to `~/.iflow/settings.json`. */
  settingsPath?: string;
}

/** The two kernel-derived tiers of the authority chain (read from the
 * kernel's settings.json — the authority for both). */
export interface KernelTokensLimits {
  /** Active API profile's `tokensLimit` (tier 2). */
  profileTokensLimit?: number;
  /** Settings file's top-level `tokensLimit` (tier 3). */
  settingsTokensLimit?: number;
}

/** Spawn-env patch: sets IFLOW_TOKENS_LIMIT only for a positive integer. */
export function cliTokensLimitEnv(effective: number | undefined): { IFLOW_TOKENS_LIMIT?: string } {
  return positiveTokenLimit(effective) !== undefined ? { IFLOW_TOKENS_LIMIT: String(effective) } : {};
}

/**
 * Read the two kernel tiers from the settings file.
 *
 * Cached on the file's (mtime, size): the occupancy bar resolves its window
 * on EVERY store push (a few times per second while streaming), so parsing
 * settings.json each time would be wasteful — yet the file is also edited
 * outside the panel (the CLI writes it, the user hand-edits it). Keying the
 * cache on the file's stamp keeps both properties: same file ⇒ same numbers,
 * changed file ⇒ re-read. A missing file is cached too (mtime/size = -1).
 */
interface KernelLimitsSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  limits: KernelTokensLimits;
}
let kernelLimitsSnapshot: KernelLimitsSnapshot | null = null;

/** Drop the cached kernel tiers (call after the panel writes settings.json). */
export function invalidateKernelTokensLimitsCache(): void {
  kernelLimitsSnapshot = null;
}

/** The two kernel-derived tiers, read fresh from the settings file. */
function readKernelTokensLimitsUncached(file: string): KernelTokensLimits {
  const settings = readCliSettings(file);
  const activeName = settings?.currentApiProfile?.trim();
  const activeProfile = activeName ? settings?.apiProfiles?.[activeName] : undefined;
  const profileLimit = positiveTokenLimit(activeProfile?.tokensLimit);
  const settingsLimit = positiveTokenLimit(settings?.tokensLimit);
  return {
    ...(profileLimit !== undefined ? { profileTokensLimit: profileLimit } : {}),
    ...(settingsLimit !== undefined ? { settingsTokensLimit: settingsLimit } : {}),
  };
}

/** Cached read of the two kernel tiers (see `KernelLimitsSnapshot`). */
export function readKernelTokensLimits(settingsPath?: string): KernelTokensLimits {
  const file = settingsPath ?? settingsFilePath();
  let mtimeMs = -1;
  let size = -1;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // Missing file → keep the sentinel (-1/-1) so "still missing" is cached.
  }
  const cached = kernelLimitsSnapshot;
  if (cached && cached.path === file && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.limits;
  }
  const limits = readKernelTokensLimitsUncached(file);
  kernelLimitsSnapshot = { path: file, mtimeMs, size, limits };
  return limits;
}

/**
 * The single window resolver — five tiers, high → low:
 *
 *   1. `user`          — explicit `iflow.contextWindowOverrides` hit for this
 *                        model (hand-typed or AI-appended; both are the user's
 *                        intent as far as the CLI is concerned).
 *   2. `profile`       — the active API profile's `tokensLimit` (kernel
 *                        settings file, `currentApiProfile` pointer).
 *   3. `settings`      — the settings file's top-level `tokensLimit`.
 *   4. `builtin-table` — curated window table hit, longest-prefix match
 *                        (`auto/deepseek-v4.1-flash` → `deepseek-v4` → 1M).
 *   5. (nothing)       — no authority: `limit` stays `undefined` and the
 *                        caller pushes NOTHING. The curated table's
 *                        `fallback-estimate` branch is deliberately NOT used
 *                        here: an unknown model must not receive a guess.
 *
 * The chain is implemented ONCE, in `shared/context-window.ts`
 * (`resolveContextWindowAuthority`); this function only reads the kernel
 * tiers and forwards them. The webview occupancy bar calls the very same
 * shared resolver with the very same inputs, so the bar's window and the
 * window pushed to the CLI are the same number by construction.
 *
 * Model ids are normalized (`normalizeModelId`: strip the last `/` prefix,
 * lowercase) before matching, so `auto/deepseek-v4.1-flash` and
 * `deepseek-v4.1-flash` hit the very same override entry.
 */
export function resolveCliTokensLimit(
  options: ResolveCliTokensLimitOptions = {},
): CliTokensLimitResolution {
  const { modelId, overrides = {}, settingsPath } = options;
  const { profileTokensLimit, settingsTokensLimit } = readKernelTokensLimits(settingsPath);
  return resolveContextWindowAuthority({ modelId, overrides, profileTokensLimit, settingsTokensLimit });
}

/**
 * Spawn-env patch built from the resolver above: sets IFLOW_TOKENS_LIMIT when
 * (and only when) the resolution has a positive integer.
 */
export function tokensLimitEnvFromSettings(
  options: {
    settingsPath?: string;
    modelId?: string | null;
    overrides?: Record<string, number>;
  } = {},
): { IFLOW_TOKENS_LIMIT?: string } {
  return cliTokensLimitEnv(resolveCliTokensLimit(options).limit);
}