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
 * Active profile name, CLI-first. `~/.iflow/settings.json` is what the CLI
 * actually loads on startup AND is rewritten by external tools (iFlow's
 * profile manager / cloud sync — verified: 0.5.19's bundle contains no
 * apiProfiles handling, the fields come and go externally). When
 * `currentApiProfile` is present it therefore wins over the extension's own
 * record; the extension value is only a fallback for fresh installs.
 */
export function resolveActiveProfileName(
  cli: CliSettingsShape | null,
  extensionActive: string | null,
): string | null {
  const fromCli = cli?.currentApiProfile?.trim();
  return fromCli || extensionActive || null;
}

/**
 * Point `currentApiProfile` at `name` without touching anything else.
 * Read-modify-write through a temp file + rename (atomic on Windows and
 * POSIX), so a concurrent external writer (cloud sync) can at worst lose our
 * pointer update — never its own profile content. Returns false (caller
 * logs) when the file is missing/unreadable.
 */
export function updateCurrentApiProfile(name: string, settingsPath?: string): boolean {
  const file = settingsPath ?? settingsFilePath();
  try {
    const settings = readCliSettings(file);
    if (!settings) return false;
    settings.currentApiProfile = name;
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
