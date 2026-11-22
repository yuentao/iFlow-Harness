/**
 * Effective CLI context-window limit for the spawned subprocess — the single
 * resolver behind every push of the window to the CLI (main session spawn,
 * child spawn, model hot-switch).
 *
 * Why this exists: the CLI derives its auto-compression threshold from
 * `compressionTokenThreshold` (default 0.8) × effective context window, and
 * resolves that window through its own `JR(model, limit)` chain. That chain
 * (probed, CLI 0.5.19 bundle) is, high → low:
 *   1. an explicit limit (the env override the host pushes),
 *   2. the Mod's `context-window-loader` → `readTokensLimit()`, i.e. the
 *      top-level `tokensLimit` of `~/.iflow/settings.json`,
 *   3. an EXACT-model-id table that holds only the nine Gemini ids — no
 *      modern id is in it at all,
 *   4. a regex pattern table whose `deepseek` row is
 *      `{pattern:/deepseek/i, limits:{v3:128000, default:65000}}`, and
 *   5. a 128000 last-resort fallback.
 *
 * So a modern id such as `auto/deepseek-v4.1-flash` matches neither the
 * exact table nor (except for its `default` branch) the pattern table and
 * therefore falls into that tiny 65k default: every single turn crossed the
 * 0.8 ratio and ran a FULL auto-compression, while the panel's occupancy bar
 * showed the real 1M window — one model, two windows.
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
import type { CliSettingsShape } from "./models-query.js";
import { normalizeModelId, resolveContextWindowWithSource } from "../../shared/context-window.js";

/** Where the resolved number came from — mirrors the authority chain above. */
export type CliTokensLimitSource = "user" | "profile" | "settings" | "builtin-table";

/** The resolved window plus its provenance. `limit === undefined` means
 * "no authority" — the caller must push nothing. */
export interface CliTokensLimitResolution {
  limit: number | undefined;
  source: CliTokensLimitSource | undefined;
}

/** Host-side facts the lookup key can be built from, in decreasing trust. */
export interface TokensLimitLookupKeyOptions {
  /** The panel store's current model id (`currentModelId`). */
  modelId?: string | null;
  /** The model the user just switched to, not effective yet. */
  pendingSwitchModel?: string | null;
  /** The model remembered for the current workspace profile. */
  workspaceModelId?: string | null;
  /** Kernel settings file to read; defaults to `~/.iflow/settings.json`. */
  settingsPath?: string;
}

export interface ResolveCliTokensLimitOptions extends TokensLimitLookupKeyOptions {
  /** Parsed `iflow.contextWindowOverrides` (keys already normalized by
   * `parseContextWindowOverrides`). */
  overrides?: Record<string, number>;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** First non-empty (trimmed) string of the list, or null. */
function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return null;
}

/** The active kernel profile's `modelName` — the last grounded lookup key. */
function kernelProfileModelName(settings: CliSettingsShape | null): string | null {
  const name = settings?.currentApiProfile?.trim();
  if (!name) return null;
  return firstNonEmpty(settings?.apiProfiles?.[name]?.modelName);
}

/**
 * The lookup key, resolved through the host's own fallbacks (high → low):
 *
 *   1. the store's `currentModelId`,
 *   2. `pendingSwitchModel` — the model the user just switched to, not
 *      effective yet,
 *   3. the workspace-remembered model,
 *   4. the active kernel profile's `modelName`
 *      (`~/.iflow/settings.json` → `currentApiProfile` → `apiProfiles[…]`),
 *   5. nothing (null) — the caller must then push NO limit at all.
 *
 * WHY the fallbacks exist (cold start): the spawn env is built BEFORE the
 * CLI's `session/new` returns, so `currentModelId` is still `null` on the
 * very first spawn of a fresh window (it only arrives with the session's
 * `_meta.models.currentModelId`). With a null key the user's
 * `iflow.contextWindowOverrides` and the curated table both MISS, and the
 * CLI silently falls back to its own 65k `deepseek` default — the exact
 * "every turn auto-compresses" symptom this resolver exists to prevent.
 *
 * The key is used for TABLE LOOKUPS ONLY. It never changes what the host
 * pushes as the model id (`session/set_model` stays a verbatim pass-through —
 * see the CLI-model-dual-variable trap in AGENTS.md).
 */
function lookupKeyFrom(
  settings: CliSettingsShape | null,
  modelId: string | null | undefined,
  pendingSwitchModel: string | null | undefined,
  workspaceModelId: string | null | undefined,
): string | null {
  return (
    firstNonEmpty(modelId, pendingSwitchModel, workspaceModelId) ??
    kernelProfileModelName(settings)
  );
}

/**
 * The model id used to LOOK UP a context window — see
 * {@link lookupKeyFrom} for the fallback chain and the cold-start rationale.
 */
export function resolveTokensLimitLookupKey(
  options: TokensLimitLookupKeyOptions = {},
): string | null {
  const { modelId, pendingSwitchModel, workspaceModelId, settingsPath } = options;
  return lookupKeyFrom(
    readCliSettings(settingsPath),
    modelId,
    pendingSwitchModel,
    workspaceModelId,
  );
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
 *
 * The LOOKUP KEY for tiers 1 and 4 is resolved through the fallback chain
 * (store's model → pending switch → workspace model → kernel profile's
 * `modelName`) so a cold start (no `currentModelId` yet) still hits the
 * user's override and the curated table. The tier ORDER is unchanged: tier 2
 * (profile) and tier 3 (settings top-level) still outrank the curated
 * table.
 */
export function resolveCliTokensLimit(
  options: ResolveCliTokensLimitOptions = {},
): CliTokensLimitResolution {
  const { modelId, pendingSwitchModel, workspaceModelId, overrides = {}, settingsPath } = options;

  // The kernel settings file is the authority for tiers 2/3 AND for the
  // last-resort lookup key (the active profile's modelName) — read it once.
  const settings = readCliSettings(settingsPath);
  const activeName = settings?.currentApiProfile?.trim();
  const activeProfile = activeName ? settings?.apiProfiles?.[activeName] : undefined;

  // Lookup key for the two TABLE tiers (see lookupKeyFrom).
  const lookupKey = lookupKeyFrom(settings, modelId, pendingSwitchModel, workspaceModelId);

  // 1) user override for THIS model.
  const key = normalizeModelId(lookupKey);
  const userLimit = key ? positiveInt(overrides[key]) : undefined;
  if (userLimit !== undefined) return { limit: userLimit, source: "user" };

  // 2) active profile / 3) settings top-level — the kernel settings file is
  // the authority for both (read fresh; it is rewritten by the panel).
  const profileLimit = positiveInt(activeProfile?.tokensLimit);
  if (profileLimit !== undefined) return { limit: profileLimit, source: "profile" };
  const settingsLimit = positiveInt(settings?.tokensLimit);
  if (settingsLimit !== undefined) return { limit: settingsLimit, source: "settings" };

  // 4) curated table — longest-prefix match. Only the `builtin-table` source
  // counts; `fallback-estimate` is a guess and must never reach the CLI.
  const builtin = resolveContextWindowWithSource(lookupKey, {});
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
  options: ResolveCliTokensLimitOptions = {},
): { IFLOW_TOKENS_LIMIT?: string } {
  return cliTokensLimitEnv(resolveCliTokensLimit(options).limit);
}
