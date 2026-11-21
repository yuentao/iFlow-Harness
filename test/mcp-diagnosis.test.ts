import { expect, it } from "vitest";
import {
  MCP_CONTEXT_HINT,
  MCP_CONTEXT_TOKENS_WARN,
  MCP_SCHEMA_OMITTED_HINT,
  diagnoseMcpServer,
} from "../shared/mcp-diagnosis";

/**
 * The status channel reports a raw error + a coarse `errorKind`; this module
 * turns that into advice. The kind strings below are the CLI loader's
 * `classifyError` buckets (verified in
 * vendor/iflow-fork/bundle/mcp-status-loader.cjs).
 */

it("spawn_failed advises checking the command and offers the editor", () => {
  const diag = diagnoseMcpServer({ status: "disconnected", errorKind: "spawn_failed", error: "spawn npx ENOENT" });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("edit");
  expect(diag.hint).toContain("命令不可用");
});

it("an unclassified spawn ENOENT still earns the command advice", () => {
  // The broker side can surface a spawn failure without a classified kind.
  const diag = diagnoseMcpServer({ status: "disconnected", errorKind: "unknown", error: "spawn ENOENT" });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("edit");
  expect(diag.hint).toContain("命令不可用");
  // Same when no kind arrived at all.
  expect(diagnoseMcpServer({ error: "npx: not found" }).action).toBe("edit");
});

it("timeout advises a refresh", () => {
  const diag = diagnoseMcpServer({ status: "disconnected", errorKind: "timeout", error: "request timeout" });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("refresh");
  expect(diag.hint).toContain("连接超时");
});

it("protocol_error advises editing the URL/headers", () => {
  const diag = diagnoseMcpServer({ errorKind: "protocol_error", error: "protocol version mismatch" });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("edit");
  expect(diag.hint).toContain("协议错误");
});

it("network_error advises a refresh", () => {
  const diag = diagnoseMcpServer({ errorKind: "network_error", error: "fetch failed" });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("refresh");
  expect(diag.hint).toContain("网络错误");
});

it("an unknown failure keeps the raw error but offers only a retry", () => {
  const diag = diagnoseMcpServer({ errorKind: "unknown", error: "boom" });
  expect(diag.severity).toBe("error");
  expect(diag.hint).toBeNull();
  expect(diag.action).toBe("refresh");
  // A custom kind is treated the same way, never guessed into a specific hint.
  expect(diagnoseMcpServer({ errorKind: "custom_bucket" }).action).toBe("refresh");
  // An error string with no kind is still a failure, not a healthy server.
  expect(diagnoseMcpServer({ status: "connected", error: "boom" }).severity).toBe("error");
});

it("warns when a connected server's tool declarations cross the budget", () => {
  const atLimit = diagnoseMcpServer({ status: "connected", contextTokens: MCP_CONTEXT_TOKENS_WARN });
  expect(atLimit.severity).toBe("warn");
  expect(atLimit.action).toBeNull();
  expect(atLimit.hint).toBe(MCP_CONTEXT_HINT);
  // Just below the threshold stays quiet.
  const below = diagnoseMcpServer({ status: "connected", contextTokens: MCP_CONTEXT_TOKENS_WARN - 1 });
  expect(below).toEqual({ severity: "ok", hint: null, action: null });
});

it("warns when a connected server had tool schemas dropped over the JSON budget", () => {
  const diag = diagnoseMcpServer({ status: "connected", contextTokens: 100, schemaOmitted: true });
  expect(diag.severity).toBe("warn");
  expect(diag.hint).toBe(MCP_SCHEMA_OMITTED_HINT);
  expect(diag.action).toBeNull();
});

it("a healthy or merely disconnected server is ok with no advice", () => {
  expect(diagnoseMcpServer({ status: "connected", toolCount: 3, contextTokens: 1200 })).toEqual({
    severity: "ok",
    hint: null,
    action: null,
  });
  expect(diagnoseMcpServer({ status: "disconnected" })).toEqual({ severity: "ok", hint: null, action: null });
  expect(diagnoseMcpServer({})).toEqual({ severity: "ok", hint: null, action: null });
});

it("a real failure outranks a large-context warning", () => {
  const diag = diagnoseMcpServer({
    status: "connected",
    errorKind: "timeout",
    error: "timeout",
    contextTokens: MCP_CONTEXT_TOKENS_WARN * 2,
    schemaOmitted: true,
  });
  expect(diag.severity).toBe("error");
  expect(diag.action).toBe("refresh");
});
