/**
 * UsageProvenanceService — 用量来源解析（占用条窗口 / 成本的五档权威链 +
 * T-9 AI 补充 provenance），从 `panel.ts` 外迁（panel 拆分第 3 批；行为等价重构）。
 *
 * Owns the two in-memory fields (`usageOverridesCache` / `aiMetadataStamp`)
 * and the two methods (`recordAiMetadataStamp` / `resolveUsageContext`) verbatim.
 * The stamp is the ONLY distinction between a hand-typed `user` row and a row
 * appended by the 「联网补充模型数据」 flow: both land in the same settings
 * arrays, so the shared resolvers can only report `user`. It is purely
 * in-memory — no settings disk format is touched and this module has NO write
 * dependency at all; a process restart simply drops the tags while the values
 * remain honest user overrides.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. Everything panel-owned
 * arrives through {@link UsageProvenanceServiceDeps} and is read at CALL TIME
 * through arrow callbacks (AGENTS.md pitfall #8) — never captured as a
 * construction-time snapshot. `ChatPanel` keeps same-named thin delegates (and
 * a writable `usageOverridesCache` accessor for the config-change invalidation
 * and existing tests), so the store callback, the metadata-append flow and
 * every existing test keep the exact same contract. New wire message types: zero.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import type { KernelTokensLimits } from "../acp/cli-tokens-limit.js";
import type { ModelMetadataSource } from "../../shared/messages.js";
import type { UsageContext } from "../../shared/session-state.js";
import type { MetadataAdditions, MetadataSource, ModelMetadataEntry } from "../../shared/model-metadata.js";
import { normalizeModelId, parseContextWindowOverrides, parseCostTable, resolveContextWindowAuthority, resolveCostWithSource } from "../../shared/context-window.js";

/** Cached parse of the two usage settings. */
export interface UsageOverridesCache {
  overrides: Record<string, number>;
  cost: Record<string, { input: number; output: number }>;
}

/** One AI-supplement provenance entry, keyed by normalized model id. */
export interface AiMetadataStampEntry {
  window?: { value: number; sourceUrl?: string; capturedAt: number };
  cost?: { value: { input: number; output: number }; sourceUrl?: string; capturedAt: number };
}

/** The narrow panel surface this service needs. All three members are LIVE
 * reads at call time — the panel passes arrows bound to `this`, never a
 * construction-time value that could go stale (store/config/kernel settings). */
export interface UsageProvenanceServiceDeps {
  /** Live panel settings read (stash on top of the configuration layer). */
  readUserSetting<T>(key: string, fallback: T): T;
  /** Live current model id — read from `store.getState()` at call time. */
  getCurrentModelId(): string | null | undefined;
  /** Kernel settings tiers — read at call time (mtime cache lives in the caller). */
  readKernelTokensLimits(): KernelTokensLimits;
}

export class UsageProvenanceService {
  /** Cached parse of the two usage settings (invalidated on config change —
   * `resolveUsageContext` runs on EVERY store push, so re-parsing the arrays
   * per push would waste work during streaming). */
  usageOverridesCache: UsageOverridesCache | null = null;

  /**
   * T-9 in-memory provenance for values appended by the 「联网补充模型数据」
   * flow. That flow APPENDS AI-supplied `name=value` rows into the SAME
   * `contextWindowOverrides` / `costTable` settings as hand-typed rows, so
   * T-8's `resolveContextWindowWithSource` / `resolveCostWithSource` can only
   * report `user` for both (documented in shared/context-window.ts). This map
   * is the ONLY distinction: keyed by normalized model id, it records which
   * kind of value the AI appended, its exact value (so a later hand-edit stops
   * being labeled ai-supplement), the citation URL and the capture time.
   * Purely in-memory — no settings disk format is touched, so user settings
   * stay compatible; a process restart simply drops the tags while the values
   * remain honest user overrides.
   */
  readonly aiMetadataStamp: Map<string, AiMetadataStampEntry> = new Map();

  constructor(private readonly deps: UsageProvenanceServiceDeps) {}

  /** Panel-shaped proxies: the migrated method bodies stay verbatim while
   *  every read still goes through a call-time callback (pitfall #8). */
  private readUserSetting<T>(key: string, fallback: T): T {
    return this.deps.readUserSetting(key, fallback);
  }
  private get store(): { getState(): { currentModelId: string | null | undefined } } {
    return { getState: () => ({ currentModelId: this.deps.getCurrentModelId() }) };
  }
  private readKernelTokensLimits(): KernelTokensLimits {
    return this.deps.readKernelTokensLimits();
  }

  /** Record AI-supplement provenance for the rows actually appended by
   * `planMetadataAdditions` (pre-existing user rows are never stamped). Called
   * right before the setting writes in the metadata fetch flow. */
  recordAiMetadataStamp(
    entries: readonly ModelMetadataEntry[],
    sources: readonly MetadataSource[],
    additions: MetadataAdditions,
  ): void {
    const windowKeys = new Set(additions.windows.map((line) => normalizeModelId(line.slice(0, line.indexOf("=")))));
    const costKeys = new Set(additions.costs.map((line) => normalizeModelId(line.slice(0, line.indexOf("=")))));
    if (windowKeys.size === 0 && costKeys.size === 0) return;
    const capturedAt = Date.now();
    for (const entry of entries) {
      const key = normalizeModelId(entry.name);
      if (!key) continue;
      const sourceUrl = entry.source ? sources.find((s) => s.id === entry.source)?.url : undefined;
      const stamp = this.aiMetadataStamp.get(key) ?? {};
      if (windowKeys.has(key) && entry.contextWindow !== undefined) {
        stamp.window = { value: entry.contextWindow, capturedAt, ...(sourceUrl ? { sourceUrl } : {}) };
      }
      if (costKeys.has(key) && entry.inputPrice !== undefined && entry.outputPrice !== undefined) {
        stamp.cost = {
          value: { input: entry.inputPrice, output: entry.outputPrice },
          capturedAt,
          ...(sourceUrl ? { sourceUrl } : {}),
        };
      }
      if (stamp.window || stamp.cost) this.aiMetadataStamp.set(key, stamp);
    }
  }

  /** Resolve the store's usage context: the five-tier authority chain
   * (user override → active profile → settings top-level → curated table →
   * no authority), together with the provenance of each number (T-8) and the
   * ai-supplement relabel (T-9). Value and label come from the SAME resolver
   * call so they can never drift. Synchronous and cheap (per push).
   *
   * 2026-11-22：占用条与 CLI 现在走**同一个** resolver
   * （`shared/context-window.ts` 的 `resolveContextWindowAuthority`）——
   * 此前占用条只认「override → 内建表」，推给 CLI 的窗口还多认「profile 档 →
   * settings 顶层档」两档，于是同一个模型在面板显示的窗口与 CLI 用的窗口会
   * 分叉（实测：profile tokensLimit=128000 的 auto/deepseek-v4.1-flash，占用条
   * 显示内建表的 1,000,000）。现在占用条显示的窗口 == 推给 CLI 的
   * `IFLOW_TOKENS_LIMIT` == `session/set_tokens_limit` 推送的值。
   *
   * 无依据（任何一档都没有落地数值）时**不显示分母**：占用条只显示原始 token
   * 数，不给出一个与 CLI 不同的猜测值（旧的 32,768 兜底估算正是「一个模型
   * 两个窗口」的残留）。 */
  resolveUsageContext(): UsageContext {
    let cached = this.usageOverridesCache;
    if (!cached) {
      cached = {
        overrides: parseContextWindowOverrides(this.readUserSetting<string[]>("contextWindowOverrides", [])),
        cost: parseCostTable(this.readUserSetting<string[]>("costTable", [])),
      };
      this.usageOverridesCache = cached;
    }
    const modelId = this.store.getState().currentModelId;
    // 内核两档（活动 profile 的 tokensLimit / settings 顶层 tokensLimit）由
    // 内核 settings.json 提供；读取带 mtime 缓存（占用条每次推送都要用）。
    const { profileTokensLimit, settingsTokensLimit } = this.readKernelTokensLimits();
    const win = resolveContextWindowAuthority({
      modelId,
      overrides: cached.overrides,
      profileTokensLimit,
      settingsTokensLimit,
    });
    const cost = resolveCostWithSource(modelId, cached.cost);
    // 有窗口才有出处：模型 id 为空时（窗口是端点级别的上限，不是某个模型的
    // 窗口）不显示窗口，也不标来源。
    let windowSource: ModelMetadataSource | null = modelId ? (win.source ?? null) : null;
    let costSource: ModelMetadataSource | null = cost.source;
    let capturedAt: number | undefined;
    let sourceUrl: string | undefined;

    const key = normalizeModelId(modelId);
    if (key) {
      const aiStamp = this.aiMetadataStamp.get(key);
      // Relabel ONLY a winning "user" override whose exact value still matches
      // what the AI flow appended. A hand-typed override — or a later hand edit
      // of an AI value — stays / returns to `user`, never a false
      // `ai-supplement`. T-5's contextUsed/split sources are produced
      // downstream (estimateSessionUsage + kernel overlay) and left untouched.
      if (aiStamp?.window && win.source === "user" && cached.overrides[key] === aiStamp.window.value) {
        windowSource = "ai-supplement";
        capturedAt = aiStamp.window.capturedAt;
        if (aiStamp.window.sourceUrl) sourceUrl = aiStamp.window.sourceUrl;
      }
      if (aiStamp?.cost && cost.source === "user") {
        const live = cached.cost[key];
        if (live && live.input === aiStamp.cost.value.input && live.output === aiStamp.cost.value.output) {
          costSource = "ai-supplement";
          if (capturedAt === undefined) capturedAt = aiStamp.cost.capturedAt;
          if (sourceUrl === undefined) sourceUrl = aiStamp.cost.sourceUrl;
        }
      }
    }

    return {
      // 没有模型 id ⇒ 没有「这个模型的窗口」可言（profile / settings 两档与
      // 模型无关，但那是端点级别的上限，不能当成某个模型的窗口显示）。
      contextWindow: modelId ? (win.limit ?? null) : null,
      // 显示出来的窗口永远是有依据的值（要么来自五档权威链），所以这里不再
      // 有「估算」形态：宁可没有分母，也不显示一个猜测的分母。
      estimated: false,
      costPrice: cost.price,
      windowSource,
      costSource,
      ...(capturedAt !== undefined ? { capturedAt } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  }
}
