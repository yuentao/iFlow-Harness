import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { errorMessage } from "./jsonrpc.js";

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
