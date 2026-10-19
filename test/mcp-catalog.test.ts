import { MCP_CATALOG, buildCatalogConfig, type McpCatalogEntry } from "../shared/mcp-catalog";
import { expect, it } from "vitest";

it("catalog exposes the six npx-based templates, all stdio", () => {
  const ids = MCP_CATALOG.map((entry) => entry.id);
  expect(ids).toEqual([
    "filesystem",
    "playwright",
    "chrome-devtools",
    "memory",
    "time",
    "sequential-thinking",
  ]);
  expect(MCP_CATALOG.every((entry) => entry.transport === "stdio")).toBe(true);
  expect(MCP_CATALOG.every((entry) => entry.command === "npx")).toBe(true);
});

it("filesystem template appends the required directory as a trailing arg", () => {
  const fs = MCP_CATALOG.find((entry) => entry.id === "filesystem")!;
  const built = buildCatalogConfig(fs, { directory: "  J:\\projects\\demo  " });
  expect(built.missing).toEqual([]);
  expect(built.config).toEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "J:\\projects\\demo"],
  });
  const blank = buildCatalogConfig(fs, {});
  expect(blank.missing).toEqual(["directory"]);
  // Unknown form keys are ignored, never spliced into args.
  const extra = buildCatalogConfig(fs, { directory: "C:\\x", bogus: "ignored" });
  expect(extra.config).toEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\x"],
  });
});

it("field-less templates round-trip their base args untouched", () => {
  const playwright = MCP_CATALOG.find((entry) => entry.id === "playwright")!;
  const built = buildCatalogConfig(playwright, {});
  expect(built.missing).toEqual([]);
  expect(built.config).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest"] });
});

it("remote (url) transport shape is builder-supported for future entries", () => {
  const entry: McpCatalogEntry = {
    id: "remote",
    name: "remote",
    title: "Remote",
    category: "core",
    description: "远程模板",
    transport: "url",
    url: "https://mcp.example.com/mcp",
    type: "sse",
    fields: [],
  };
  const built = buildCatalogConfig(entry, {});
  expect(built.missing).toEqual([]);
  expect(built.config).toEqual({ type: "sse", url: "https://mcp.example.com/mcp" });
});