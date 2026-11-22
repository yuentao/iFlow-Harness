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
 * Zero VSCode dependency (pure logic + models-query, which is itself
 * VSCode-free), so it is directly unit-testable.
 */
import { readCliSettings } from "./models-query.js";
import { normalizeModelId, resolveContextWindowWithSource } from "../../shared/context-window.js";

/** Where the resolved number came from — mirrors the authority chain above. */
export type CliTokensLimitSource = "user" | "profile" | "settings" | "builtin-table";

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

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Spawn-env patch: sets IFLOW_TOKENS_LIMIT only for a positive integer. */
export function cliTokensLimitEnv(effective: number | undefined): { IFLOW_TOKENS_LIMIT?: string } {
  return positiveInt(effective) !== undefined ? { IFLOW_TOKENS_LIMIT: String(effective) } : {};
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
 * Model ids are normalized (`normalizeModelId`: strip the last `/` prefix,
 * lowercase) before matching, so `auto/deepseek-v4.1-flash` and
 * `deepseek-v4.1-flash` hit the very same override entry.
 */
export function resolveCliTokensLimit(
  options: ResolveCliTokensLimitOptions = {},
): CliTokensLimitResolution {
  const { modelId, overrides = {}, settingsPath } = options;

  // 1) user override for THIS model.
  const key = normalizeModelId(modelId);
  const userLimit = key ? positiveInt(overrides[key]) : undefined;
  if (userLimit !== undefined) return { limit: userLimit, source: "user" };

  // 2) active profile / 3) settings top-level — the kernel settings file is
  // the authority for both (read fresh; it is rewritten by the panel).
  const settings = readCliSettings(settingsPath);
  const activeName = settings?.currentApiProfile?.trim();
  const activeProfile = activeName ? settings?.apiProfiles?.[activeName] : undefined;
  const profileLimit = positiveInt(activeProfile?.tokensLimit);
  if (profileLimit !== undefined) return { limit: profileLimit, source: "profile" };
  const settingsLimit = positiveInt(settings?.tokensLimit);
  if (settingsLimit !== undefined) return { limit: settingsLimit, source: "settings" };

  // 4) curated table — longest-prefix match. Only the `builtin-table` source
  // counts; `fallback-estimate` is a guess and must never reach the CLI.
  const builtin = resolveContextWindowWithSource(modelId, {});
  if (builtin.source === "builtin-table") {
    const builtinLimit = positiveInt(builtin.window);
    if (builtinLimit !== undefined) return { limit: builtinLimit, source: "builtin-table" };
  }

  // 5) no authority at all → push nothing.
  return { limit: undefined, source: undefined };
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
