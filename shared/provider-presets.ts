/**
 * Onboarding presets for OpenAI-compatible endpoints.
 *
 * Pure data shared by the host and the webview (no vscode dependency). Each
 * preset only pre-fills values the user would otherwise copy out of provider
 * docs: the base URL, where to create an API key, and — when the IDs are
 * stable API aliases — example model names. Users can still type any endpoint;
 * this is a shortcut, not a whitelist.
 */

export interface ProviderPreset {
  id: string;
  /** Brand name (same in every locale). */
  label: string;
  baseUrl: string;
  /** Where the user creates/copies an API key. */
  keyUrl?: string;
  /** Provider documentation home. */
  docsUrl?: string;
  /** Stable model IDs rendered as clickable chips under the model field. */
  models: readonly string[];
  /** Chinese source string translated through the webview i18n dictionary. */
  note: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "在 DeepSeek 开放平台创建 API Key；端点兼容 OpenAI 协议。",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    docsUrl: "https://platform.moonshot.cn/docs",
    models: [],
    note: "在 Moonshot 开放平台创建 API Key，用于 Kimi 系列模型。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://docs.bigmodel.cn/",
    models: [],
    note: "在智谱开放平台创建 API Key，使用 GLM 系列模型。",
  },
  {
    id: "dashscope",
    label: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/",
    docsUrl: "https://help.aliyun.com/zh/model-studio/",
    models: [],
    note: "在阿里云百炼控制台创建 API Key，使用通义千问系列模型。",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    docsUrl: "https://docs.siliconflow.cn/",
    models: [],
    note: "在硅基流动控制台创建 API Key，可访问多家开源模型。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    models: [],
    note: "在 OpenRouter 创建 API Key，可路由到多家供应商的模型。",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    docsUrl: "https://ollama.com/",
    models: [],
    note: "本地 Ollama 不校验 API Key，填任意非空值（如 ollama）即可；请确认 Ollama 服务已启动。",
  },
];

/** Trailing-slash and case-insensitive endpoint comparison. */
function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** Resolve the preset an existing base URL belongs to (edit-flow guidance). */
export function matchProviderPreset(baseUrl: string): ProviderPreset | null {
  const target = normalizeEndpoint(baseUrl);
  if (!target) return null;
  return PROVIDER_PRESETS.find((preset) => normalizeEndpoint(preset.baseUrl) === target) ?? null;
}
