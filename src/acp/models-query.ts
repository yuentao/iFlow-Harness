import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
  const file = settingsPath ?? path.join(homedir(), ".iflow", "settings.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliSettingsShape;
  } catch {
    return null;
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

export async function queryModelIds(endpoint: ActiveEndpoint, timeoutMs = 10_000): Promise<string[]> {
  // Resolve explicitly so failures carry the actual URL (user-typed profiles
  // can hide typos; proxies/schemes surface here instead of an opaque error).
  let url: URL;
  const target = normalizeModelsUrl(endpoint.baseUrl);
  try {
    url = new URL(target);
  } catch {
    throw new Error(`模型地址无效: ${target}`);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`请求 ${url.host} 失败（地址 ${target}）: ${cause}`);
  }
  if (!response.ok) throw new Error(`模型列表查询失败: HTTP ${response.status}`);
  return parseModelsResponse(await response.json());
}
