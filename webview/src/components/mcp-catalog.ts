import data from "./mcp-catalog.json";

export interface CatalogField {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  secret?: boolean;
}
export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  description: string;
  source: string;
  template: Record<string, unknown>;
  fields: CatalogField[];
}
export interface McpEntry { name: string; json: string }
export const mcpCatalog: CatalogItem[] = data;

/** Substitute values as data, never as serialized JSON or shell fragments. */
export function fillMcpTemplate(item: CatalogItem, values: Record<string, string>): Record<string, unknown> {
  for (const field of item.fields) {
    if (field.required && !values[field.key]?.trim()) throw new Error(field.key);
  }
  function fill(value: unknown): unknown {
    if (typeof value === "string") {
      return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        if (!Object.hasOwn(values, key)) throw new Error(key);
        return values[key]!;
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fill(child)]));
    }
    return value;
  }
  return fill(item.template) as Record<string, unknown>;
}

/** Own keys only, including legal server names such as __proto__ / constructor. */
export function entriesToServers(entries: McpEntry[]): Record<string, unknown> {
  const servers: Record<string, unknown> = Object.create(null);
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name || Object.hasOwn(servers, name)) throw new Error(name);
    servers[name] = JSON.parse(entry.json);
  }
  return servers;
}

/** Host replies have no request ID; compare the submitted payload structurally.
 * Only one request is outstanding and no list refresh is sent during saving. */
export function sameMcpServers(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return value;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
