/**
 * Built-in MCP server template catalog — the settings card's 「模板目录」.
 *
 * Pure data + pure builder (zero vscode dependency, same shape as
 * provider-presets.ts): each template pre-fills an `mcpServers` entry so the
 * form only asks for what the user would otherwise copy out of provider docs
 * (a root directory, that's it). Templates here are npx-based stdio servers —
 * Windows-friendly (no shell shim, no uvx/python), and deliberately NO
 * key-required servers (those stay hand-written JSON until an env-field form
 * lands).
 *
 * Package names verified against the official modelcontextprotocol/servers
 * repo, the Playwright MCP repo and Google's chrome-devtools-mcp (2026-10).
 * The config shape matches the CLI's `mcpServers` entry contract
 * (src/acp/protocol.ts#McpServerStdio: { command, args?, env? }).
 */

export interface McpCatalogField {
  key: string;
  /** Chinese source string, translated through the webview i18n dictionary. */
  label: string;
  /** Blank required slot → the install button refuses with this label. */
  required?: boolean;
  placeholder?: string;
}

export interface McpCatalogEntry {
  id: string;
  /** Default `mcpServers` key; the install form lets the user rename it. */
  name: string;
  /** Brand name — locale-neutral, never translated. */
  title: string;
  category: "browser" | "core" | "workflow";
  /** Chinese source string for the row description. */
  description: string;
  docsUrl?: string;
  transport: "stdio" | "url";
  /** stdio template (transport "stdio"). */
  command?: string;
  args?: readonly string[];
  /** url template (transport "url") — no entries use it today, kept for
   * future remote templates. */
  url?: string;
  type?: "http" | "sse";
  /** Editable form slots appended as extra args, in declaration order. */
  fields: readonly McpCatalogField[];
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    category: "core",
    description: "允许 agent 读写/搜索在本机目录（按参数限定到所选根）",
    docsUrl: "https://github.com/modelcontextprotocol/servers",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    fields: [
      {
        key: "directory",
        label: "允许根目录（agent 可读写/搜索在此）",
        required: true,
        placeholder: "如 J:\\projects\\demo",
      },
    ],
  },
  {
    id: "playwright",
    name: "playwright",
    title: "Playwright",
    category: "browser",
    description: "浏览器自动化：navigate/click/screenshot，前端「改完即看」验证",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    fields: [],
  },
  {
    id: "chrome-devtools",
    name: "chrome-devtools",
    title: "Chrome DevTools",
    category: "browser",
    description: "Chrome 开发者工具：console/network/performance 与页面操作",
    docsUrl: "https://github.com/chrome-devtools/chrome-devtools-mcp",
    transport: "stdio",
    command: "npx",
    args: ["chrome-devtools-mcp@latest"],
    fields: [],
  },
  {
    id: "memory",
    name: "memory",
    title: "Memory",
    category: "core",
    description: "知识图谱记忆（实体/关系/观察），跨轮沉淀",
    docsUrl: "https://github.com/modelcontextprotocol/servers",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    fields: [],
  },
  {
    id: "time",
    name: "time",
    title: "Time",
    category: "core",
    description: "当前时间、时钟与_timezone_ 换算",
    docsUrl: "https://github.com/modelcontextprotocol/servers",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
    fields: [],
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    category: "workflow",
    description: "逐步思考工具（可分支/ revise 的建模步）",
    docsUrl: "https://github.com/modelcontextprotocol/servers",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    fields: [],
  },
];

/**
 * Build the `mcpServers` entry config from a template plus form values.
 * Pure: unknown value keys are ignored; a blank required slot is reported in
 * `missing` (the caller shows the field label, nothing is written).
 */
export function buildCatalogConfig(
  entry: McpCatalogEntry,
  values: Record<string, string>,
): { config: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const field of entry.fields) {
    const value = (values[field.key] ?? "").trim();
    if (!value) {
      if (field.required) missing.push(field.key);
      continue;
    }
    extra.push(value);
  }
  const config: Record<string, unknown> =
    entry.transport === "url"
      ? { type: entry.type ?? "http", url: entry.url }
      : { command: entry.command, args: [...(entry.args ?? []), ...extra] };
  return { config, missing };
}
