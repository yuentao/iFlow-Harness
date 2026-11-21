/**
 * MCP server health diagnosis — pure, zero vscode dependency.
 *
 * The status channel (`_iflow/mcp/status` + the host's shared broker overlay)
 * reports a raw `error` string and a coarse `errorKind`, but nothing turns that
 * into advice a user can act on. This module maps one server's status view to
 * a severity + one-line hint + the single most useful follow-up action, so the
 * settings card can render a diagnosis row instead of a bare stack message.
 *
 * `errorKind` strings come from the CLI loader's `classifyError` (verified in
 * `vendor/iflow-fork/bundle/mcp-status-loader.cjs`): `spawn_failed`,
 * `timeout`, `protocol_error`, `network_error`, `unknown`. An unknown or absent
 * kind falls back to the raw error text — `spawn ENOENT` from a broker-side
 * spawn is the single most common misconfiguration and must still earn the
 * "command unavailable" advice even when the kind was not classified.
 *
 * The hints are Chinese source strings (the product's source language); the
 * webview translates them through its own dictionary, exactly like every other
 * card string.
 */

export type McpDiagnosisSeverity = "ok" | "warn" | "error";

export interface McpDiagnosis {
  severity: McpDiagnosisSeverity;
  hint: string | null;
  action: "refresh" | "edit" | null;
}

export interface McpDiagnosisInput {
  status?: string;
  errorKind?: string;
  error?: string;
  toolCount?: number;
  schemaOmitted?: boolean;
  contextTokens?: number;
}

/**
 * Injected-context budget (BPE-estimated tokens) above which a CONNECTED
 * server earns a warning: its tool declarations ride in every request, so a
 * very large declaration set silently taxes the whole conversation.
 */
export const MCP_CONTEXT_TOKENS_WARN = 8000;

const SPAWN_HINT = "命令不可用：确认 Node/npx 已安装，或在服务器配置里把命令改成绝对路径";
const TIMEOUT_HINT = "连接超时：首次 npx 下载可能较慢，稍后刷新重试；持续超时请检查命令或网络";
const PROTOCOL_HINT = "协议错误：检查服务 URL/请求头与服务端 MCP 版本是否匹配";
const NETWORK_HINT = "网络错误：检查网络与代理设置后刷新";
/** Exported so the row-level token chip can warn in the same words when the
 * server is connected in a child session but the CLI's own status is blocked. */
export const MCP_CONTEXT_HINT = "该服务器工具声明较大，会持续占用上下文预算，可考虑精简或禁用不常用的服务器";
/** Exported so the detail page can show the schema warning independently of
 * which diagnosis branch the server currently lands in. */
export const MCP_SCHEMA_OMITTED_HINT = "部分工具参数结构过大已省略，模型可能无法正确调用这些工具";

/** `spawn ENOENT` / `npx: not found` style messages that mean "command
 * missing" even when the kind was never classified. */
const SPAWN_LIKE_RE = /enoent|not found|\bnpx\b/;

function errorDiagnosis(kind: string, errorText: string): McpDiagnosis | null {
  if (kind === "spawn_failed") return { severity: "error", hint: SPAWN_HINT, action: "edit" };
  if (kind === "timeout") return { severity: "error", hint: TIMEOUT_HINT, action: "refresh" };
  if (kind === "protocol_error") return { severity: "error", hint: PROTOCOL_HINT, action: "edit" };
  if (kind === "network_error") return { severity: "error", hint: NETWORK_HINT, action: "refresh" };
  if (kind === "" || kind === "unknown") {
    // The broker can surface a spawn failure before any classification ran:
    // the raw text is the only evidence, and "command unavailable" is the one
    // hint worth guessing from it.
    if (SPAWN_LIKE_RE.test(errorText)) return { severity: "error", hint: SPAWN_HINT, action: "edit" };
    // Any error text (or an explicit "unknown" kind) is a real failure with no
    // safe generic advice, so offer a retry and keep the raw message.
    if (errorText !== "" || kind === "unknown") return { severity: "error", hint: null, action: "refresh" };
    return null;
  }
  // A kind outside the known buckets: still a failure, never a healthy server.
  return { severity: "error", hint: null, action: "refresh" };
}

/**
 * Diagnose one server from the status view the settings card already holds.
 * Errors win over connection warnings: a server that failed to connect cannot
 * also be "using too much context". `toolCount` is accepted for callers that
 * pass a whole status view; the current rules do not need it.
 */
export function diagnoseMcpServer(input: McpDiagnosisInput): McpDiagnosis {
  const kind = (input.errorKind ?? "").trim().toLowerCase();
  const errorText = (input.error ?? "").trim().toLowerCase();
  const failure = errorDiagnosis(kind, errorText);
  if (failure) return failure;

  if (input.status === "connected") {
    if ((input.contextTokens ?? 0) >= MCP_CONTEXT_TOKENS_WARN) {
      return { severity: "warn", hint: MCP_CONTEXT_HINT, action: null };
    }
    if (input.schemaOmitted) {
      return { severity: "warn", hint: MCP_SCHEMA_OMITTED_HINT, action: null };
    }
  }

  return { severity: "ok", hint: null, action: null };
}
