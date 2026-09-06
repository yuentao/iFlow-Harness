/**
 * OpenAI Compatible credentials (M3).
 *
 * iFlow official servers are closed: `openai-compatible` is the only usable
 * auth method (user-supplied baseUrl + apiKey + modelName). Credentials are
 * stored in VSCode SecretStorage — never in plain settings or on disk, and
 * never logged. They are passed to the agent via `authenticate`
 * `{methodId: "openai-compatible", methodInfo: {...}}` when the CLI reports
 * `isAuthenticated: false`.
 */

export interface OpenAiCompatCredentials {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/** Minimal surface of vscode.SecretStorage, injectable for tests. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export const AUTH_SECRET_KEY = "iflow.openai-compatible";

export async function loadCredentials(secrets: SecretStore): Promise<OpenAiCompatCredentials | null> {
  const raw = await secrets.get(AUTH_SECRET_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OpenAiCompatCredentials>;
    if (
      typeof parsed.baseUrl !== "string" ||
      typeof parsed.apiKey !== "string" ||
      typeof parsed.modelName !== "string" ||
      !parsed.baseUrl ||
      !parsed.apiKey ||
      !parsed.modelName
    ) {
      return null;
    }
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, modelName: parsed.modelName };
  } catch {
    return null;
  }
}

export async function saveCredentials(secrets: SecretStore, creds: OpenAiCompatCredentials): Promise<void> {
  await secrets.store(AUTH_SECRET_KEY, JSON.stringify(creds));
}

export async function clearCredentials(secrets: SecretStore): Promise<void> {
  await secrets.delete(AUTH_SECRET_KEY);
}

// --- Named API profiles (multi-config + switching) ----------------------------

export interface StoredProfile {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export const PROFILES_SECRET_KEY = "iflow.profiles";
export const ACTIVE_PROFILE_KEY = "iflow.active-profile";

export type ProfileMap = Record<string, StoredProfile>;

export async function loadProfiles(secrets: SecretStore): Promise<ProfileMap> {
  const raw = await secrets.get(PROFILES_SECRET_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ProfileMap;
    const out: ProfileMap = {};
    for (const [name, p] of Object.entries(parsed)) {
      if (
        typeof p?.baseUrl === "string" &&
        typeof p?.apiKey === "string" &&
        typeof p?.modelName === "string" &&
        name.trim()
      ) {
        out[name] = { baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: p.modelName };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveProfiles(secrets: SecretStore, profiles: ProfileMap): Promise<void> {
  await secrets.store(PROFILES_SECRET_KEY, JSON.stringify(profiles));
}

export async function getActiveProfileName(secrets: SecretStore): Promise<string | null> {
  return (await secrets.get(ACTIVE_PROFILE_KEY)) ?? null;
}

export async function setActiveProfileName(secrets: SecretStore, name: string): Promise<void> {
  await secrets.store(ACTIVE_PROFILE_KEY, name);
}

/** Last-4 mask for UI display; the raw key never leaves the host. */
export function maskKey(apiKey: string): string {
  return apiKey.length > 4 ? `…${apiKey.slice(-4)}` : "…";
}

export type ValidateResult =
  | { ok: true; value: OpenAiCompatCredentials }
  | { ok: false; error: string };

export function validateCredentials(input: {
  baseUrl?: string | null;
  apiKey?: string | null;
  modelName?: string | null;
}): ValidateResult {
  const baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = (input.apiKey ?? "").trim();
  const modelName = (input.modelName ?? "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" };
  }
  if (!apiKey) return { ok: false, error: "API Key 不能为空" };
  if (!modelName) return { ok: false, error: "模型名称不能为空" };
  return { ok: true, value: { baseUrl, apiKey, modelName } };
}
