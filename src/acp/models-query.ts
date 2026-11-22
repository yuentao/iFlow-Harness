import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { errorMessage } from "./jsonrpc.js";
import type { McpScope } from "../../shared/messages.js";

/** settings.json location — mirrors the CLI loaders' IFLOW_HOME support. */
export function settingsFilePath(): string {
  const home = process.env.IFLOW_HOME ?? path.join(homedir(), ".iflow");
  return path.join(home, "settings.json");
}

/**
 * The CLI's Workspace-scope settings file for a project root.
 *
 * Wire behavior (probed, CLI 0.5.19 bundle): the settings manager builds
 * `join(cwd, ".iflow", "settings.json")` and merges it OVER the User file
 * (`mcpServers: { ...user, ...workspace }`), which is what `iflow mcp add
 * --scope project` writes. Note the CLI deliberately skips this file when
 * `realpath(cwd) === realpath(homedir())` — callers must apply the same guard
 * (see panel.ts#projectSettingsFor) so we never write a "project" file into
 * the user's home directory.
 */
export function projectSettingsFilePath(cwd: string): string {
  return path.join(cwd, ".iflow", "settings.json");
}

/**
 * The Workspace settings file for a project root, or null when there is no
 * project scope at all.
 *
 * Mirrors the CLI's own guard (probed, CLI 0.5.19 bundle: the Workspace file is
 * only read when `realpathSync(cwd) !== realpathSync(homedir())`) — without it,
 * opening a window on the home directory would make us write a "project"
 * settings.json straight into `~/.iflow`'s parent, i.e. duplicate the global
 * file under a second name.
 */
export function projectSettingsFor(cwd: string | null): string | null {
  if (!cwd) return null;
  const home = homedir();
  try {
    if (realpathSync(cwd) === realpathSync(home)) return null;
  } catch {
    // An unreadable cwd falls back to a lexical compare (case-insensitive on
    // Windows, where the home dir is often reached through a short path).
    const same = process.platform === "win32"
      ? path.resolve(cwd).toLowerCase() === path.resolve(home).toLowerCase()
      : path.resolve(cwd) === path.resolve(home);
    if (same) return null;
  }
  return projectSettingsFilePath(cwd);
}

/**
 * Read one settings file's `mcpServers` dict.
 *
 * - `file === null` (no project scope) and a file that does not exist both
 *   yield an empty dict — a project without `.iflow/settings.json` is the
 *   normal case, not an error;
 * - a file that EXISTS but cannot be parsed yields null, so the caller can
 *   report it. Treating it as empty would let the next save replace the user's
 *   whole (unreadable but real) config with our dict.
 */
export function readMcpServers(file: string | null): Record<string, unknown> | null {
  if (!file) return {};
  const settings = readCliSettings(file);
  if (settings) return settings.mcpServers ?? {};
  return existsSync(file) ? null : {};
}

/**
 * Which settings scope(s) declare one MCP server name, from the two on-disk
 * dicts. `both` means the same name appears in both files — the CLI merges
 * `{ ...user, ...workspace }` (probed CLI 0.5.19 bundle), so the PROJECT
 * entry is the one actually running while the global row still renders.
 * `undefined` = neither file declares it (the CLI knows the server from a
 * scope we could not read, e.g. a plugin-provided one) — never fabricated.
 */
export function mcpScopeOf(
  name: string,
  global: Record<string, unknown>,
  project: Record<string, unknown> | null,
): McpScope | "both" | undefined {
  const inGlobal = Object.hasOwn(global, name);
  const inProject = project !== null && Object.hasOwn(project, name);
  if (inGlobal && inProject) return "both";
  if (inProject) return "project";
  if (inGlobal) return "global";
  return undefined;
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
  /** Per-profile context-window limit (Mod-added key, not in the CLI schema). */
  tokensLimit?: unknown;
}

export interface CliSettingsShape {
  /** Top-level context-window limit (Mod-added key, not in the CLI schema). */
  tokensLimit?: unknown;
  selectedAuthType?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  currentApiProfile?: string;
  apiProfiles?: Record<string, ProfileShape>;
  /** CLI UI language ("zh-CN" | "en-US"); CLI reads it at startup only. */
  language?: string;
  /** CLI default approval mode ("default" | "smart" | "yolo", plus a legacy
   * "plan" that the panel no longer offers but an old settings file may hold);
   * startup-only (probed, CLI 0.5.19 bundle: Config reads settings once). */
  approvalMode?: string;
  /** MCP servers as a name → config dict; startup-only. */
  mcpServers?: Record<string, unknown>;
  /** Memory context file name(s). The CLI's hierarchical loader accepts a
   * string or an array; absent = AGENTS.md + IFLOW.md. */
  contextFileName?: string | string[];
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
 * Active profile name, kernel-first. The panel persists its API profiles into
 * the Core's user settings file (`apiProfiles` / `currentApiProfile`), so that
 * pointer is the authority; SecretStorage keeps only the runtime credentials
 * cache and the legacy record, which is the fallback when the kernel pointer
 * is absent (fresh install / not-yet-migrated window).
 */
export function resolveActiveProfileName(
  cli: CliSettingsShape | null,
  extensionActive: string | null,
): string | null {
  const kernelActive = cli?.currentApiProfile?.trim();
  if (kernelActive) return kernelActive;
  return extensionActive?.trim() || null;
}

/**
 * Monotonic counter for temp-file names. Two writes inside the same
 * millisecond must not pick the same temp path, or they would clobber each
 * other's payload (and one writer would rename the other's content into
 * place).
 */
let settingsTmpSeq = 0;

/**
 * A temp path that no concurrent writer can collide with: the pid (unique
 * among live processes) + a millisecond timestamp (unique across restarts) +
 * an in-process counter (unique within a millisecond). Same shape as the
 * memory writer's temp name in src/memory/files.ts#writeAtomic.
 */
function uniqueTmpPath(file: string): string {
  settingsTmpSeq += 1;
  return `${file}.iflow-harness-tmp-${process.pid}-${Date.now()}-${settingsTmpSeq}`;
}

/**
 * Merge `patch` into settings.json without touching anything else.
 * Read-modify-write through a temp file + rename — an ATOMIC REPLACE: the
 * target is never unlinked first, so readers see either the old or the new
 * content, never "no file at all" and never a half-written file. A concurrent
 * external writer (cloud sync, the CLI's own saveSettings) can at worst lose
 * our patch — never its own content. Returns false (caller logs) when the file
 * is missing/unreadable.
 *
 * `createIfMissing` is for the project scope, whose `<cwd>/.iflow/settings.json`
 * usually does not exist yet: the file is then created (directory included)
 * from an empty object. An existing-but-unparseable file still returns false —
 * we never overwrite content we could not read.
 */
export function updateCliSettings(
  patch: Partial<CliSettingsShape>,
  settingsPath?: string,
  options?: { createIfMissing?: boolean },
): boolean {
  const file = settingsPath ?? settingsFilePath();
  let tmp: string | null = null;
  try {
    let settings = readCliSettings(file);
    if (!settings) {
      if (!options?.createIfMissing || existsSync(file)) return false;
      mkdirSync(path.dirname(file), { recursive: true });
      settings = {};
    }
    Object.assign(settings, patch);
    tmp = uniqueTmpPath(file);
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    // Atomic replace — and NEVER delete the target first:
    //   * Node's rename replaces an existing file on Windows (libuv uses
    //     MOVEFILE_REPLACE_EXISTING) and rename(2) always replaces the
    //     target on POSIX, so the unlink is pure overhead;
    //   * the old `unlink + rename` sequence opened a window in which the
    //     settings file did not exist AT ALL. A concurrent reader (the CLI's
    //     own saveSettings) saw "no file", treated the disk as empty and
    //     rewrote the whole file without the user's mcpServers / tokensLimit
    //     / language / approvalMode — the 竞态丢键 bug;
    //   * it was catastrophic on its own: when the unlink succeeded and the
    //     rename then failed, the settings file was gone for good.
    // A failed rename now leaves the previous content intact.
    renameSync(tmp, file);
    tmp = null; // renamed away — nothing to clean up
    return true;
  } catch {
    if (tmp) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
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
  const tmp = uniqueTmpPath(file);
  try {
    writeFileSync(tmp, JSON.stringify(merged.file, null, 2), "utf8");
    // Atomic replace, no unlink of the target first — same reasoning as
    // updateCliSettings(): the file must never be observably missing, and a
    // failed rename must leave the previous rules intact.
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
