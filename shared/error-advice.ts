/**
 * 3.6 (2026-10-19): turn a raw error message into structured next-step
 * guidance for the error toast. Competitive review: "内置 CLI 缺失" just
 * threw the raw error (blunt), and API 401/403 carried no "check your key /
 * balance" suggestion at all.
 *
 * Pure text heuristic over the ALREADY-stringified message (host callers
 * pass `errorMessage(error)` output, which merges JSON-RPC envelope message +
 * data). Deliberately self-contained regexes rather than importing
 * `isRateLimitError`/`isContextOverflowError` from src/acp/jsonrpc.ts: those
 * pull Node `util.inspect` at runtime, and this module must stay bundleable
 * into the webview. The patterns are the actionable subset of the jsonrpc
 * ones (same gateway phrasings, probed CLI 0.5.19) — drift there only costs a
 * generic toast, never a wrong suggestion (unknown → null → no advice line).
 *
 * Order is precedence: the concrete CLI-missing banner first, then the two
 * auto-recovery failures the host already retried (overflow/rateLimit — the
 * advice explains WHY the retries gave up), then auth/model (wrong config),
 * then network last (its broad transport words would swallow the rest).
 */
import type { ErrorAdviceUi } from "./messages.js";

/** `内核缺失，扩展包不完整，请重新安装：…` (l10n source) plus the
 * raw ENOENT/Cannot-find-module shapes the loader can surface. */
const CLI_RE = /内核缺失|扩展包不完整|Cannot find module.*entry\.js|ENOENT.*(?:vendor[\\/]+iflow-cli|entry\.js)/i;

/** Gateway context-overflow phrasings (subset of jsonrpc's CONTEXT_OVERFLOW_RE). */
const OVERFLOW_RE = new RegExp(
  [
    "content\\s+length\\s+exceed",
    "maximum\\s+context\\s+length",
    "context[_\\s-]?(length|window|limit)[_\\s-]?(is\\s+)?(exceeded?|too\\s+long|is\\s+full|overflow)",
    "prompt\\s+is\\s+too\\s+long",
    "上下文(长度)?(超出|超限|过长|已满)",
    "输入(长度)?(超出|超限|过长)",
  ].join("|"),
  "i",
);

/** Rate-limit phrasings (subset of jsonrpc's RATE_LIMIT_RE). */
const RATE_LIMIT_RE = new RegExp(
  [
    "rate[_\\s-]?limit",
    "\\b429\\b",
    "too\\s+many\\s+requests",
    "quota\\s+(exceeded|exhausted)",
    "限流",
    "速率限制",
    "请求过于频繁",
  ].join("|"),
  "i",
);

/** Credential/permission failures: HTTP 401/403 words + provider error
 * types (OpenAI `invalid_api_key`, Anthropic `authentication_error` /
 * `permission_error`) + Chinese gateway wording + balance exhaustion. */
const AUTH_RE = new RegExp(
  [
    "\\b(401|403)\\b",
    "unauthorized",
    "forbidden",
    "invalid[\\s_-]*(api[\\s_-]*)?key",
    "incorrect\\s+api\\s+key",
    "authentication[_\\s-]?error",
    "permission[_\\s-]?error",
    "invalid\\s+x-api-key",
    "insufficient\\s+(balance|credit)",
    "api\\s+key.*(invalid|expired|missing|not\\s+set)",
    "密钥.{0,2}(无效|错误|过期|不正确|缺失)",
    "鉴权(失败|错误)",
    "认证失败",
    "未授权|无权限|没有权限",
    "余额不足",
  ].join("|"),
  "i",
);

/** Model unavailable / capability mismatch (incl. the CLI's thinking-mode
 * rejection and validateModelForPush's fallback note). */
const MODEL_RE = new RegExp(
  [
    "model[_\\s-]?not[_\\s-]?found",
    "model.*(not\\s+(found|available|exist|supported))",
    "no\\s+such\\s+model",
    "does\\s+not\\s+support\\s+thinking",
    "模型.*(不存在|已下架|不可用|不支持|已停用)",
  ].join("|"),
  "i",
);

/** Transport-level failures (subset deliberately free of generic words like
 * "not found" so it cannot swallow the categories above). */
const NETWORK_RE = new RegExp(
  [
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "socket\\s+hang\\s+up",
    "fetch\\s+failed",
    "\\bnetwork\\s+(error|failure)\\b",
    "(timed?\\s+out|timeout)",
    "连接(失败|被拒绝|超时)",
    "网络(错误|异常|超时|不可达)",
  ].join("|"),
  "i",
);

/**
 * Classify a (stringified) error message into toast advice, or null when no
 * category matches — null means "show the raw message only", never a wrong
 * guess. `hint` is a Chinese source string; the webview translates it via
 * its i18n dictionary (same discipline as every other host-sent string).
 */
export function classifyErrorAdvice(message: string): ErrorAdviceUi | null {
  if (!message) return null;
  if (CLI_RE.test(message)) {
    return {
      kind: "cli",
      hint: "扩展包不完整或内核文件被安全软件删除，重新安装扩展后重启窗口即可恢复",
      openSettingsTab: "runtime",
    };
  }
  if (OVERFLOW_RE.test(message)) {
    return {
      kind: "overflow",
      hint: "上下文已超出模型上限且自动压缩未能恢复，可发送 /compress 再次压缩，或开启新会话后继续",
    };
  }
  if (RATE_LIMIT_RE.test(message)) {
    return {
      kind: "rateLimit",
      hint: "平台速率限制持续触发，可稍候片刻再重试，或在设置中切换到其他模型 / API 配置",
      openSettingsTab: "api",
    };
  }
  if (AUTH_RE.test(message)) {
    return {
      kind: "auth",
      hint: "检查 API Key 是否有效、账户余额/额度是否充足，或在设置中切换到其他 API 配置后重试",
      openSettingsTab: "api",
    };
  }
  if (MODEL_RE.test(message)) {
    return {
      kind: "model",
      hint: "当前模型可能已下架或不支持该能力，在设置中重新选择可用模型后重试",
      openSettingsTab: "api",
    };
  }
  if (NETWORK_RE.test(message)) {
    return {
      kind: "network",
      hint: "本机网络或代理不可达，检查网络连接与代理设置后点击重试",
    };
  }
  return null;
}
