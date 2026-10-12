export interface McpEntry { name: string; json: string }

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
