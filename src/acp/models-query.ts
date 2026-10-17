import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { errorMessage } from "./jsonrpc.js";

/** settings.json location — mirrors the CLI loaders' IFLOW_HOME support. */
export function settingsFilePath(): string {
  const home = process.env.IFLOW_HOME ?? path.join(homedir(), ".iflow");
  return path.join(home, "settings.json");
}

/** OAuth credential cache location — same home resolution as settings.json. */
export function oauthCredsFilePath(): string {
  const home = process.env.IFLOW_HOME ?? path.join(homedir(), ".iflow");
  return path.join(home, "oauth_creds.json");
}

/**
 * The CLI's ACP session-state file — `~/.iflow/acp/sessions/<sessionId>.json`.
 *
 * Wire behavior (probed, CLI 0.5.19 bundle): every `session/prompt` ends in a
 * `finally { saveSessionState() }` that writes
 * `{ sessionId, cwd, createdAt, lastActivity, chatHistory }` where `chatHistory`
 * is the full Gemini-API-form conversation (`{ role, parts }`). `session/load`
 * reads this file back and calls `setHistory(chatHistory)`, which is what makes
 * a genuine context-level deletion possible: rewrite the file, reload, and the
 * model stops seeing the removed turns. Home resolution mirrors the CLI's own
 * `Tn()` (IFLOW_HOME override, else `os.homedir()/.iflow`).
 */
export function acpSessionFilePath(sessionId: string): string {
  const home = process.env.IFLOW_HOME ?? path.join(homedir(), ".iflow");
  return path.join(home, "acp", "sessions", `${sessionId}.json`);
}

/**
 * Archive the OAuth credential cache aside when its token is provably dead.
 *
 * The CLI's `authenticate` consults this file FIRST on every call; for a
 * token with an expired `expiry_date` it blocks on a Google OAuth refresh
 * network call that stalls ~60s (probed, CLI 0.5.19: 63962ms twice in a row;
 * with the file archived aside: 210ms) before its swallowed exception lets
 * openai-compatible auth proceed. The iFlow OAuth login method itself is
 * retired (hardcoded 2026-04-16 deadline in the bundle), so an expired cache
 * is dead weight.
 *
 * Rename-based (reversible), never destructive: a token that still carries a
 * future `expiry_date`, a missing file, or an unparseable file all return
 * null untouched (unparseable content fails dEt instantly — no stall).
 * Returns the archive path when the file was moved, else null.
 */
export function retireStaleOAuthCreds(now = Date.now(), file = oauthCredsFilePath()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { expiry_date?: number };
    if (typeof parsed?.expiry_date === "number" && parsed.expiry_date > now) return null;
    try {
      const archived = `${file}.bak`;
      renameSync(file, archived);
      return archived;
    } catch {
      // Target exists (previous archive) — use a unique suffix instead.
      const archived = `${file}.bak-${now}`;
      renameSync(file, archived);
      return archived;
    }
  } catch {
    return null;
  }
}

/**
 * Live model list for the model dropdown.
 *
 * The CLI's `session/new` `_meta.models.availableModels` is a hardcoded
 * catalog of official iFlow models and does not reflect the user's actual
 * endpoint. Per user requirement, the dropdown is populated by querying the
 * active openai-compatible endpoint's `GET {baseUrl}/models` (OpenAI list
 * models API). The API key is read from the CLI's settings.json and only
 * used in the Authorization header — never logged.
 */

export interface ActiveEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Model name configured for the active profile (the CLI's current model). */
  modelName: string | null;
}

interface ProfileShape {
  selectedAuthType?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
}

export interface CliSettingsShape {
  selectedAuthType?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  currentApiProfile?: string;
  apiProfiles?: Record<string, ProfileShape>;
  /** CLI UI language ("zh-CN" | "en-US"); CLI reads it at startup only. */
  language?: string;
  /** CLI default approval mode ("default" | "smart" | "yolo" | "plan");
   * startup-only (probed, CLI 0.5.19 bundle: Config reads settings once). */
  approvalMode?: string;
  /** MCP servers as a name → config dict; startup-only. */
  mcpServers?: Record<string, unknown>;
}

/** Raw CLI settings.json (apiProfiles are the user's named API configs). */
export function readCliSettings(settingsPath?: string): CliSettingsShape | null {
  const file = settingsPath ?? settingsFilePath();
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliSettingsShape;
  } catch {
    return null;
  }
}

/**
 * Active profile name, extension-first. The panel authenticates its child
 * with SecretStorage creds and the CLI-side api-config-isolation patch keeps
 * the panel-owned fields (apiKey/baseUrl/currentApiProfile…) out of the
 * shared settings.json write-back — so the extension's own record is the
 * authoritative pointer for the panel. The CLI file's currentApiProfile is
 * maintained by the CLI/external tools and lags at whatever was active at the
 * child's startup; it is only a fallback for fresh installs where the user
 * configured profiles outside the panel and the extension has no record yet.
 */
export function resolveActiveProfileName(
  cli: CliSettingsShape | null,
  extensionActive: string | null,
): string | null {
  if (extensionActive?.trim()) return extensionActive.trim();
  return cli?.currentApiProfile?.trim() || null;
}

/**
 * Merge `patch` into settings.json without touching anything else.
 * Read-modify-write through a temp file + rename (atomic on Windows and
 * POSIX), so a concurrent external writer (cloud sync) can at worst lose our
 * patch — never its own content. Returns false (caller logs) when the file is
 * missing/unreadable.
 */
export function updateCliSettings(patch: Partial<CliSettingsShape>, settingsPath?: string): boolean {
  const file = settingsPath ?? settingsFilePath();
  try {
    const settings = readCliSettings(file);
    if (!settings) return false;
    Object.assign(settings, patch);
    const tmp = `${file}.iflow-harness-tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      const tmp = `${file}.iflow-harness-tmp`;
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    return false;
  }
}

/** Active openai-compatible endpoint from the CLI settings, or null. */
export function readActiveEndpoint(settingsPath?: string): ActiveEndpoint | null {
  const settings = readCliSettings(settingsPath);
  if (!settings || settings.selectedAuthType !== "openai-compatible") return null;

  const active = settings.currentApiProfile
    ? settings.apiProfiles?.[settings.currentApiProfile]
    : undefined;
  const baseUrl = active?.baseUrl ?? settings.baseUrl;
  const apiKey = active?.apiKey ?? settings.apiKey;
  const modelName = active?.modelName ?? settings.modelName ?? null;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, modelName };
}

/**
 * `https://host/v1` → `https://host/v1/models` (idempotent, trims slashes).
 * User-typed profiles often omit the scheme (`api.host.com/v1`); default to
 * https in that case — fetch would otherwise throw "Invalid URL protocol".
 */
export function normalizeModelsUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
  return /\/models$/.test(trimmed) ? trimmed : `${trimmed}/models`;
}

/** Accepts OpenAI `{data:[{id}]}` and alt `{models:[{id|name}]}` shapes. */
export function parseModelsResponse(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : typeof obj.name === "string" ? obj.name : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Minimal direct GET over node:http(s).
 *
 * Deliberately bypasses the global `fetch`: the VSCode extension host patches
 * it with its proxy agent, whose undici ProxyAgent throws
 * "Invalid URL protocol: the URL must start with `http:` or `https:`" when
 * the macOS system proxy is a SOCKS / scheme-less entry — even for perfectly
 * valid target URLs. A plain socket request behaves like the CLI does.
 */
function directGet(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const send = url.protocol === "http:" ? httpGet : httpsGet;
  return new Promise((resolve, reject) => {
    const req = send(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`连接超时（${timeoutMs}ms 无响应）`)));
    req.on("error", reject);
    req.end();
  });
}

export async function queryModelIds(endpoint: ActiveEndpoint, timeoutMs = 10_000): Promise<string[]> {
  // Resolve explicitly so failures carry the actual URL (user-typed profiles
  // can hide typos; they surface here instead of an opaque error).
  const target = normalizeModelsUrl(endpoint.baseUrl);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`模型地址无效: ${target}`);
  }
  let response: { status: number; body: string };
  try {
    response = await directGet(url, { Authorization: `Bearer ${endpoint.apiKey}` }, timeoutMs);
  } catch (error) {
    const cause = errorMessage(error);
    throw new Error(`请求 ${url.host} 失败: ${cause}`);
  }
  if (response.status !== 200) throw new Error(`模型列表查询失败: HTTP ${response.status}`);
  try {
    return parseModelsResponse(JSON.parse(response.body));
  } catch {
    throw new Error(`模型列表响应解析失败（HTTP ${response.status}）`);
  }
}

// ---------------------------------------------------------------------------
// Thinking-model capability rules (~/.iflow/thinking-models.json)
// ---------------------------------------------------------------------------

/**
 * The thinking-rules file read by the vendored fork's `thinking-model-loader.cjs`.
 *
 * Wire behavior (probed, vendored bundle `thinking-model-loader.cjs`): the
 * loader reads `join(os.homedir(), ".iflow", "thinking-models.json")` at CLI
 * startup — a HARDCODED homedir path, unlike settingsFilePath it does NOT
 * honour IFLOW_HOME — and for each `models[]` entry requires a truthy
 * `pattern` + boolean `supportsThinking`, compiles `new RegExp(pattern, "i")`
 * (case-insensitive) and registers it on the A2 capability Map BEFORE the
 * built-in regexes, so config rules win over built-ins (first match wins).
 * `supportedReasoningLevels` defaults to ["low","medium","high"] and
 * `maxThinkingTokens` to 0. The ACP `session/set_think` ENABLE path throws
 * "Current model 'X' does not support thinking mode" when
 * `supportsThinking(model)` is false; the DISABLE path never validates.
 */
export function thinkingRulesFilePath(): string {
  return path.join(homedir(), ".iflow", "thinking-models.json");
}

/** One capability rule as authored in the setting / the rules file. */
export interface ThinkingRuleEntry {
  pattern: string;
  supportsThinking: boolean;
  supportedReasoningLevels?: string[];
  maxThinkingTokens?: number;
}

/** Loader-default level/token values, applied when comparing rules. */
const DEFAULT_THINKING_LEVELS = ["low", "medium", "high"];

/**
 * Sanitize raw setting values into valid rules: drop non-object entries,
 * entries without a non-empty `pattern` or with a non-boolean
 * `supportsThinking` (the loader's own validity gate), and patterns that
 * fail regex compilation (the loader skips them with a console.warn);
 * dedupe by pattern (first wins), restrict levels to low/medium/high and
 * clamp `maxThinkingTokens` to a positive integer.
 */
export function sanitizeThinkingRules(raw: unknown): ThinkingRuleEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ThinkingRuleEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rule = item as Record<string, unknown>;
    const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    if (!pattern || typeof rule.supportsThinking !== "boolean") continue;
    try {
      new RegExp(pattern, "i");
    } catch {
      continue;
    }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    const entry: ThinkingRuleEntry = { pattern, supportsThinking: rule.supportsThinking };
    if (Array.isArray(rule.supportedReasoningLevels)) {
      const levels = rule.supportedReasoningLevels.filter((l) => l === "low" || l === "medium" || l === "high");
      if (levels.length > 0) entry.supportedReasoningLevels = levels;
    }
    if (typeof rule.maxThinkingTokens === "number" && Number.isFinite(rule.maxThinkingTokens) && rule.maxThinkingTokens > 0) {
      entry.maxThinkingTokens = Math.trunc(rule.maxThinkingTokens);
    }
    out.push(entry);
  }
  return out;
}

/**
 * First-match-wins capability lookup mirroring the loader's registration
 * order and matching (`new RegExp(pattern, "i").test(model)`). Returns
 * undefined when NO rule matches — unknown, not "unsupported": the CLI's
 * built-in table (and the seeded template file) may still decide the model
 * supports or forbids thinking, so callers must treat undefined as "allow"
 * and let the CLI's own rejection (friendly-toast-matched) cover misses.
 */
export function thinkingForModelRules(model: string, rules: ThinkingRuleEntry[]): boolean | undefined {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      continue;
    }
    if (re.test(model)) return rule.supportsThinking;
  }
  return undefined;
}

/** Whether an existing file entry already encodes the incoming rule (loader defaults applied). */
function thinkingRuleEquivalent(candidate: Record<string, unknown>, incoming: ThinkingRuleEntry): boolean {
  if (candidate.supportsThinking !== incoming.supportsThinking) return false;
  const existingLevels = Array.isArray(candidate.supportedReasoningLevels)
    ? candidate.supportedReasoningLevels
    : DEFAULT_THINKING_LEVELS;
  const incomingLevels = incoming.supportedReasoningLevels ?? DEFAULT_THINKING_LEVELS;
  if (existingLevels.join(",") !== incomingLevels.join(",")) return false;
  const existingTokens = typeof candidate.maxThinkingTokens === "number" ? candidate.maxThinkingTokens : 0;
  return existingTokens === (incoming.maxThinkingTokens ?? 0);
}

/**
 * Merge sanitized setting rules into the parsed rules-file object WITHOUT
 * ever dropping user content:
 *  - a pattern not present in `models[]` appends (counts as `added`);
 *  - an existing entry with the same pattern is replaced in place only when
 *    it is gate-only (no `thinkingRequest`/`nonThinkingRequest` DSL —
 *    hand-authored request-body rewrites must never be clobbered; such an
 *    entry stays untouched and nothing is appended for it); an in-place
 *    update counts as `changed` only when the fields actually differ;
 *  - every other key (description/version/modelAliases/other rules) is
 *    preserved verbatim.
 * Returns null when the existing content is not a mergeable object —
 * callers must refuse to write (user-state, same never-overwrite
 * discipline as ensureIflowDefaultConfigs).
 */
export function mergeThinkingRulesIntoFile(
  existing: unknown,
  incoming: ThinkingRuleEntry[],
): { file: Record<string, unknown>; added: number; changed: number } | null {
  let base: Record<string, unknown>;
  if (existing === undefined || existing === null) {
    base = {};
  } else if (typeof existing === "object" && !Array.isArray(existing)) {
    base = { ...(existing as Record<string, unknown>) };
  } else {
    return null;
  }
  const models = Array.isArray(base.models) ? [...base.models] : [];
  let added = 0;
  let changed = 0;
  for (const rule of incoming) {
    let matched = false;
    for (let i = 0; i < models.length; i += 1) {
      const entry = models[i];
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.pattern !== "string" || candidate.pattern !== rule.pattern) continue;
      const hasDsl = candidate.thinkingRequest !== undefined || candidate.nonThinkingRequest !== undefined;
      if (hasDsl || thinkingRuleEquivalent(candidate, rule)) {
        matched = true;
        break; // user DSL rule wins, or already up to date — untouched
      }
      models[i] = { ...rule };
      changed += 1;
      matched = true;
      break;
    }
    if (!matched) {
      models.push({ ...rule });
      added += 1;
    }
  }
  base.models = models;
  return { file: base, added, changed };
}

/**
 * Apply the panel's `iflow.thinkingModelRules` setting to the CLI's rules
 * file: read-modify-write through a temp file + rename (atomic on Windows
 * and POSIX, same pattern as updateCliSettings). A missing file is created
 * (the seeding step normally pre-creates the template first, but a file
 * carrying only the setting rules is still loader-valid); unparseable
 * existing JSON is SKIPPED, never rewritten (`skippedInvalid`). No-op when
 * nothing would change. Returns what happened for the caller's toast.
 */
export function applyThinkingRules(incoming: ThinkingRuleEntry[], file = thinkingRulesFilePath()): {
  added: number;
  changed: number;
  created: boolean;
  skippedInvalid?: boolean;
} {
  if (incoming.length === 0) return { added: 0, changed: 0, created: false };
  let existingText: string | null;
  try {
    existingText = readFileSync(file, "utf8");
  } catch {
    existingText = null;
  }
  let parsed: unknown = null;
  if (existingText !== null) {
    try {
      parsed = JSON.parse(existingText);
    } catch {
      return { added: 0, changed: 0, created: false, skippedInvalid: true };
    }
  }
  const merged = mergeThinkingRulesIntoFile(parsed, incoming);
  if (!merged) return { added: 0, changed: 0, created: false, skippedInvalid: true };
  if (existingText !== null && merged.added + merged.changed === 0) {
    return { added: 0, changed: 0, created: false }; // already in sync — no write churn
  }
  const tmp = `${file}.iflow-harness-tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(merged.file, null, 2), "utf8");
    if (existingText !== null) unlinkSync(file);
    renameSync(tmp, file);
    return { added: merged.added, changed: merged.changed, created: existingText === null };
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    return { added: 0, changed: 0, created: false, skippedInvalid: true };
  }
}
