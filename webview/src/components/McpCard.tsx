import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ChevronRight, MoreHorizontal, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useChat } from "../store";
import { entriesToServers, sameMcpServers, serversToEntries, type McpEntry } from "./mcp-servers";
import { MCP_CATALOG, buildCatalogConfig } from "../../../shared/mcp-catalog";
import { t } from "../i18n";
import { ActionRow, Button, Chip, ConfirmDialog, Dropdown, Field, FieldLabel, Hint, ICON_INLINE, IconButton, SecondaryRow, Segmented, TextArea, TextInput, ToolbarRow } from "./ui";
import type { SectionHeader } from "./SettingsModal";
import type { McpScope, McpStatusUi, McpServerStatusView, McpToolView, McpPromptView } from "../../../shared/messages";

/** Editor-state header override a section reports to the settings shell. */
type SectionHeaderSetter = Dispatch<SetStateAction<SectionHeader | null>>;

/** One MCP server entry as edited in the card: name + JSON body. The editor
 * renders the common CLI schema fields (command/args/env, url/headers) as a
 * form over the parsed object and merges each field edit back, so unknown
 * keys (free-form description, type, _lastModified…) survive untouched. */
type Entry = McpEntry;

/** Parse an entry's JSON body; returns the parse error message or null. */
function validateEntry(entry: Entry): string | null {
  if (!entry.name.trim()) return t("名称不能为空");
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.json);
  } catch {
    return t("JSON 格式不合法");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return t("配置必须是 JSON 对象");
  }
  return null;
}

/** Parse an entry's JSON body into a plain object (null when not an object). */
function parseConfig(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Top-level keys the form edits; everything else is preserved verbatim. */
const MCP_FORM_KEYS = new Set(["command", "args", "env", "url", "headers", "type", "description"]);

/** Transport tabs shown in the editor; the selected tab is derived back. */
const MCP_TRANSPORTS = ["stdio", "sse", "streamable-http"];

/** Scope tabs. The CLI merges both settings files with the project (Workspace)
 * entry winning per name, so each scope is edited on its own and clashes are
 * flagged rather than silently merged. */
const MCP_SCOPES: McpScope[] = ["global", "project"];

/** File each scope writes, shown next to the tabs (display only). */
const SCOPE_FILE: Record<McpScope, string> = {
  global: "~/.iflow/settings.json",
  project: "<工作区>/.iflow/settings.json",
};

/** Serialize after setting/clearing a top-level string field (blank clears). */
function configWithField(obj: Record<string, unknown>, key: string, value: string): string {
  const next = { ...obj };
  if (value.trim()) next[key] = value;
  else delete next[key];
  return JSON.stringify(next, null, 2);
}

/** Display value of a string field for the form inputs. */
function fieldOfConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/** Which transport tab is active for this config. */
function transportOfConfig(config: Record<string, unknown>): string {
  const type = config.type;
  if (type === "sse" || type === "streamable-http") return type;
  if (typeof config.command === "string") return "stdio";
  if (typeof config.url === "string") return "sse";
  return "stdio";
}

/** Switch transport: drop the other branch's managed keys; remote carries
 * `type` so the CLI can tell sse from streamable-http. */
function configWithTransport(obj: Record<string, unknown>, kind: string): string {
  const next = { ...obj };
  if (kind === "stdio") {
    delete next.url;
    delete next.headers;
    delete next.type;
  } else {
    delete next.command;
    delete next.args;
    delete next.env;
    next.type = kind;
  }
  return JSON.stringify(next, null, 2);
}

/** Normalized args view for row rendering (non-string entries stringified). */
function normalizeArgs(value: unknown): string[] {
  return Array.isArray(value) ? value.map((a) => String(a)) : [];
}

function configWithArgsList(obj: Record<string, unknown>, args: string[]): string {
  const next = { ...obj };
  if (args.length > 0) next.args = args;
  else delete next.args;
  return JSON.stringify(next, null, 2);
}

/** Set/remove/append one arg row. */
function configWithArgSet(obj: Record<string, unknown>, index: number, value: string): string {
  const args = normalizeArgs(obj.args);
  if (index < args.length) args[index] = value;
  else args.push(value);
  return configWithArgsList(obj, args);
}
function configWithArgRemoved(obj: Record<string, unknown>, index: number): string {
  const args = normalizeArgs(obj.args);
  if (index < args.length) args.splice(index, 1);
  return configWithArgsList(obj, args);
}
function configWithArgAdded(obj: Record<string, unknown>): string {
  const args = normalizeArgs(obj.args);
  args.push("");
  return configWithArgsList(obj, args);
}

/** env/headers rows: `[key, value]` pairs (non-string values dropped). */
function normalizePairs(value: unknown): [string, string][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => [k, v as string]);
}

function configWithPairs(obj: Record<string, unknown>, field: string, pairs: [string, string][]): string {
  const next = { ...obj };
  const map = Object.fromEntries(pairs);
  if (Object.keys(map).length > 0) next[field] = map;
  else delete next[field];
  return JSON.stringify(next, null, 2);
}

/** Edit one `KEY=VALUE` row (first "=" splits; no "=" means key-only row). */
function configWithPairSet(obj: Record<string, unknown>, field: string, index: number, text: string): string {
  const pairs = normalizePairs(obj[field]);
  const eq = text.indexOf("=");
  const pair: [string, string] = eq <= 0 ? [text.trim(), ""] : [text.slice(0, eq).trim(), text.slice(eq + 1)];
  if (index < pairs.length) pairs[index] = pair;
  else pairs.push(pair);
  return configWithPairs(obj, field, pairs);
}
function configWithPairRemoved(obj: Record<string, unknown>, field: string, index: number): string {
  const pairs = normalizePairs(obj[field]);
  if (index < pairs.length) pairs.splice(index, 1);
  return configWithPairs(obj, field, pairs);
}
function configWithPairAdded(obj: Record<string, unknown>, field: string): string {
  const pairs = normalizePairs(obj[field]);
  pairs.push(["", ""]);
  return configWithPairs(obj, field, pairs);
}

/** Drop abandoned empty rows (empty env/headers keys, empty args) when the
 * editor closes, so half-added rows never reach disk. */
function finalizeEntryJson(json: string): string {
  const cfg = parseConfig(json) ?? {};
  const next = { ...cfg };
  for (const field of ["env", "headers"]) {
    const value = next[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const kept = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([k]) => k !== ""),
      );
      if (Object.keys(kept).length > 0) next[field] = kept;
      else delete next[field];
    }
  }
  if (Array.isArray(next.args)) {
    const args = (next.args as unknown[]).map((a) => String(a)).filter((a) => a !== "");
    if (args.length > 0) next.args = args;
    else delete next.args;
  }
  return JSON.stringify(next, null, 2);
}

/** Short transport summary for the list row: stdio command or remote URL. */
function transportOf(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const c = config as Record<string, unknown>;
  if (typeof c.command === "string") {
    const args = Array.isArray(c.args) ? c.args.join(" ") : "";
    return [c.command, args].filter(Boolean).join(" ").trim();
  }
  if (typeof c.url === "string") return c.url;
  return "";
}

/** Compact token count (1234 → "1.2k") for the context-length chip. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** Connection label per server, shared by the list dot and the detail view. */
function statusLabel(view: McpServerStatusView & { contextTokens?: number } | undefined): string {
  if (!view) return t("状态未知");
  if (view.disabled) return t("已禁用");
  if (view.blocked) return t("已屏蔽");
  switch (view.status) {
    case "connected": return t("已连接");
    case "connecting": return t("连接中…");
    default: return t("未连接");
  }
}

/**
 * MCP servers settings section (lives inside SettingsModal): reads/writes the
 * `mcpServers` dict in `~/.iflow/settings.json` through the host (the CLI owns
 * that file, so the section always opens on disk truth via `listMcpServers`).
 * Edits happen on a local copy; 「保存」 sends the whole dict back (replace
 * semantics — see shared/messages.ts) and the footer's 重启 CLI applies them,
 * since the CLI only reads mcpServers at startup.
 *
 * Live connection state is a SEPARATE channel (`mcpStatus` ↔ the host's
 * `_iflow/mcp/status` query via the mcp-status-refactor Mod): each row carries
 * a state dot (green connected / blue connecting / red disconnected / grey
 * disabled-blocked-unknown), an `≈Nk` chip estimating the context the server's
 * tool declarations inject (host-computed BPE, same tokenizer as the occupancy
 * bar), and clicking 「详情」 opens a sub-page with the tool/prompt declarations
 * and the captured connection error. Status never gates editing — a status
 * refresh cannot disturb the local draft or the save guards.
 */
export function McpSection({ busy, onHeader }: { busy: boolean; onHeader: SectionHeaderSetter }) {
  const send = useChat((s) => s.send);
  const [entries, setEntries] = useState<Entry[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null); // index into entries
  const [isNew, setIsNew] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<number | null>(null); // index into entries
  // undefined = status reply not yet arrived; null = no channel (CLI offline /
  // Mod missing) → rows render a hollow dot instead of a wrong-colored one.
  const [status, setStatus] = useState<McpStatusUi | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  // 「模板目录」 browse + install form (values keyed by catalog field key;
  // entryId indirection keeps the form serializable across setState).
  const [catalogBrowse, setCatalogBrowse] = useState(false);
  const [catalogForm, setCatalogForm] = useState<{ entryId: string; values: Record<string, string>; name: string } | null>(null);
  /** Active scope tab. The CLI merges both settings files
   * (`mcpServers: { ...user, ...workspace }`), so the card edits ONE scope at a
   * time and flags cross-scope name clashes instead of pretending they merge. */
  const [scope, setScope] = useState<McpScope>("global");
  /** Mirror of `scope` for the message handler, whose closure only depends on
   * `send` — reading the state there would yield the mount-time value and seed
   * the wrong scope after a refresh. */
  const scopeRef = useRef<McpScope>("global");
  /** False when the host reports no project scope (no cwd, or cwd IS the home
   * dir — the CLI skips its Workspace file there too). Disables the tab. */
  const [projectAvailable, setProjectAvailable] = useState(false);
  /** Per-scope drafts: an unsaved edit must survive a scope round trip. The
   * ACTIVE scope's draft lives in `entries` (every editor handler writes it);
   * the other one parks here until the user switches back. */
  const drafts = useRef<{ global: Entry[] | null; project: Entry[] | null }>({
    global: null,
    project: null,
  });
  /** Disk truth per scope from the last reply. Seeds a scope switch and drives
   * the override chips — never the editor's value (that is the draft). */
  const disk = useRef<{ global: Record<string, unknown>; project: Record<string, unknown> | null }>({
    global: {},
    project: null,
  });
  const pending = useRef<Record<string, unknown> | null>(null);
  /** Which scope the in-flight save belongs to, so its echo is compared
   * against the right dict (the reply always carries both). */
  const pendingScope = useRef<McpScope | null>(null);
  const loaded = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Open → request the current disk state AND the live connection state. The
  // replies arrive as window messages (same channel Composer uses for filesPicked
  // — store.ts routes these kinds away from the snapshot pipeline). Late replies
  // after unmount are dropped by React's setState-on-unmounted no-op.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        global?: Record<string, unknown>;
        project?: Record<string, unknown> | null;
        error?: string;
        status?: McpStatusUi | null;
      };
      if (msg?.type === "mcpStatus") {
        setStatus(msg.status);
        setRefreshing(false);
        return;
      }
      if (msg?.type !== "mcpServers") return;
      // Disk truth for both scopes: seeds a later switch and drives the
      // override chips. It never overwrites `entries` (the user's draft).
      disk.current = { global: msg.global ?? {}, project: msg.project ?? null };
      setProjectAvailable(msg.project !== null && msg.project !== undefined);
      if (pending.current) {
        const savedScope = pendingScope.current ?? "global";
        const echoed = savedScope === "project" ? msg.project ?? null : msg.global ?? null;
        // Failure is terminal too. Never replace local drafts with either reply.
        if (!msg.error && (!echoed || !sameMcpServers(pending.current, echoed))) return;
        pending.current = null;
        pendingScope.current = null;
        setSaving(false);
        if (msg.error) {
          setEditError(msg.error);
          return;
        }
        setSavedFlash(true);
        flashTimer.current = setTimeout(() => setSavedFlash(false), 2500);
        return;
      }
      if (loaded.current) return; // stale read/save replies must not overwrite edits
      loaded.current = true;
      if (msg.error) {
        setLoadError(msg.error);
        setEntries([]);
        return;
      }
      // Seed the ACTIVE scope (a refresh can arrive while the project tab is
      // open, so this must not assume the mount-time default).
      const active = scopeRef.current;
      const seeded = serversToEntries(active === "project" ? msg.project : msg.global);
      drafts.current[active] = seeded;
      setEntries(seeded);
    };
    const request = () => {
      send({ type: "listMcpServers" });
      send({ type: "mcpStatus" });
    };
    window.addEventListener("message", handler);
    request();
    return () => {
      window.removeEventListener("message", handler);
      clearTimeout(flashTimer.current);
    };
  }, [send]);

  // Sub-editor / detail-view → shell header (back arrow + contextual title).
  useEffect(() => {
    onHeader(
      editing !== null
        ? {
            back: () => {
              setEditing(null);
              setEditError(null);
            },
            title: isNew ? t("添加 MCP 服务器") : t("编辑 MCP 服务器"),
          }
        : detail !== null
          ? {
              back: () => setDetail(null),
              title: t("MCP 服务器详情"),
            }
          : catalogForm !== null
            ? {
                back: () => setCatalogForm(null),
                title: t("安装 MCP 模板"),
              }
            : catalogBrowse
              ? {
                  back: () => setCatalogBrowse(false),
                  title: t("模板目录"),
                }
              : null,
    );
  }, [editing, isNew, detail, catalogForm, catalogBrowse, onHeader]);

  function save() {
    if (!entries || pending.current || loadError || editing !== null) return;
    for (const entry of entries) {
      const error = validateEntry(entry);
      if (error) { setEditError(error); return; }
    }
    let servers: Record<string, unknown>;
    try { servers = entriesToServers(entries); }
    catch (error) { setEditError(t("名称重复：{0}", (error as Error).message)); return; }
    setEditError(null);
    setSavedFlash(false);
    pending.current = servers;
    pendingScope.current = scope;
    setSaving(true);
    send({ type: "saveMcpServers", scope, servers });
  }

  /** Switch the active scope WITHOUT a round trip — the last reply already
   * carried both dicts. The outgoing draft parks in `drafts` so a
   * look-at-the-other-scope detour never costs an unsaved edit. */
  function switchScope(next: McpScope) {
    if (next === scope || (next === "project" && !projectAvailable)) return;
    drafts.current[scope] = entries;
    const seeded =
      drafts.current[next] ??
      serversToEntries(next === "project" ? disk.current.project : disk.current.global);
    drafts.current[next] = seeded;
    scopeRef.current = next;
    setScope(next);
    setEntries(seeded);
    setEditing(null);
    setIsNew(false);
    setDetail(null);
    setConfirmDelete(null);
    setEditError(null);
    setSavedFlash(false);
  }

  /** Cross-scope name clash for one server. The CLI resolves it as
   * `mcpServers: { ...user, ...workspace }` — the project entry wins — so both
   * sides get flagged: otherwise the global row looks authoritative while the
   * CLI is actually running the project one. */
  function scopeClash(name: string): "overrides" | "overridden" | null {
    if (!name) return null;
    const other = scope === "project" ? disk.current.global : disk.current.project;
    if (!other || !Object.hasOwn(other, name)) return null;
    return scope === "project" ? "overrides" : "overridden";
  }

  // Re-read disk config + live status (e.g. after an external CLI edit or a
  // restart): both replies refill their own state, entries go through the
  // loading skeleton exactly like on open.
  function refresh() {
    if (!entries && !loadError) return; // initial load still in flight
    setEntries(null);
    setStatus(undefined);
    loaded.current = false;
    send({ type: "listMcpServers" });
    send({ type: "mcpStatus" });
    setRefreshing(true);
  }

  // Install a catalog template: the shared builder assembles the config from
  // form values (missing required fields are a hard stop, unknown extra keys
  // ignored). The entry lands as a LOCAL draft — 「保存」 still gates the disk
  // write, same replace semantics as hand-added entries.
  function installCatalog(): void {
    if (!catalogForm || pending.current || saving) return;
    const template = MCP_CATALOG.find((c) => c.id === catalogForm.entryId);
    if (!template) {
      setEditError(t("模板不存在"));
      setCatalogForm(null);
      return;
    }
    const name = catalogForm.name.trim() || template.name;
    if (!name) {
      setEditError(t("名称不能为空"));
      return;
    }
    if ((entries ?? []).some((en) => en.name.trim() === name)) {
      setEditError(t("名称重复：{0}", name));
      return;
    }
    const built = buildCatalogConfig(template, catalogForm.values);
    if (built.missing.length > 0) {
      setEditError(t("请填写：{0}", built.missing.join(", ")));
      return;
    }
    const idx = (entries ?? []).length;
    setEntries([...(entries ?? []), { name, json: JSON.stringify(built.config, null, 2) }]);
    setCatalogForm(null);
    setCatalogBrowse(false);
    setEditing(idx);
    setIsNew(true);
    setEditError(null);
  }

  return (
    <>
      {loadError && <div className="text-ui-body text-destructive">{loadError}</div>}

      {editing === null && detail === null && catalogForm === null && (
        <>
          <div className="flex items-center gap-2">
            <Segmented
              ariaLabel={t("配置作用域")}
              value={scope}
              onChange={switchScope}
              options={MCP_SCOPES.map((candidate) => ({
                value: candidate,
                label: candidate === "global" ? t("全局") : t("项目"),
                disabled: candidate === "project" && !projectAvailable,
                title:
                  candidate === "project" && !projectAvailable
                    ? t("无项目上下文（未打开工作区）")
                    : t("写入 {0}", SCOPE_FILE[candidate]),
              }))}
            />
            <span
              className="ml-auto min-w-0 truncate font-mono text-ui-caption text-muted-foreground/75"
              title={t("写入 {0}", SCOPE_FILE[scope])}
            >
              {SCOPE_FILE[scope]}
            </span>
          </div>

          {/* Catalog browsing is a sub-page (shell header carries the back
              arrow) — the list-page toolbar/secondary rows do not belong to
              it, and the entry button only ever *opens* the catalog. */}
          {!catalogBrowse && (
            <>
              <ToolbarRow>
                <Button
                  variant="secondary"
                  icon={<Plus className={ICON_INLINE} />}
                  disabled={entries === null || !!loadError || saving}
                  onClick={() => {
                    setEntries([...(entries ?? []), { name: "", json: "{}" }]);
                    setEditing(entries === null ? 0 : entries.length);
                    setIsNew(true);
                    setEditError(null);
                  }}
                >
                  {t("添加")}
                </Button>
                <Button variant="primary" disabled={busy || entries === null || !!loadError || saving} onClick={save}>
                  {saving ? t("保存中…") : savedFlash ? t("已保存") : t("保存")}
                </Button>
                {editError && <span className="text-ui-body text-destructive">{editError}</span>}
              </ToolbarRow>

              {/* Secondary actions: catalog browsing and refresh are conveniences,
                  not the primary flow — they must not read as peers of 添加/保存. */}
              <SecondaryRow>
                <Button
                  variant="ghost"
                  icon={<Sparkles className={ICON_INLINE} />}
                  disabled={busy || saving || entries === null || !!loadError}
                  onClick={() => setCatalogBrowse(true)}
                >
                  {t("模板目录")}
                </Button>
                <Button
                  variant="ghost"
                  icon={<RefreshCw className={ICON_INLINE} />}
                  disabled={busy || saving || (entries === null && !loadError)}
                  onClick={refresh}
                >
                  {refreshing ? t("刷新中…") : t("刷新")}
                </Button>
              </SecondaryRow>
            </>
          )}

          {catalogBrowse && catalogForm === null ? (
            <div className="mt-2 space-y-2">
              {MCP_CATALOG.map((template) => {
                const transport =
                  template.transport === "url"
                    ? template.url ?? ""
                    : [template.command ?? "", ...(template.args ?? [])].filter(Boolean).join(" ");
                return (
                  <div key={template.id} className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-ui-body font-semibold text-foreground">
                        {template.title}
                      </span>
                      <IconButton
                        icon={<Plus className={ICON_INLINE} />}
                        label={t("安装")}
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setCatalogForm({ entryId: template.id, values: {}, name: template.name });
                          setEditError(null);
                        }}
                      />
                    </div>
                    {template.description && (
                      <div className="truncate text-ui-label text-muted-foreground">{template.description}</div>
                    )}
                    <div className="mt-1 truncate font-mono text-ui-caption text-muted-foreground/80" title={transport}>
                      {transport}
                    </div>
                    {template.docsUrl && (
                      <div className="mt-1 truncate font-mono text-ui-caption text-muted-foreground/60" title={t("官方文档")}>
                        {template.docsUrl}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : entries === null ? (
            <div className="py-4 text-center text-ui-body text-muted-foreground">{t("读取中…")}</div>
          ) : entries.length === 0 && !loadError ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
              <div className="text-ui-body text-muted-foreground">{t("尚未配置 MCP 服务器")}</div>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              {(entries ?? []).map((entry, i) => {
                const name = entry.name.trim();
                const view = status?.servers[name];
                const transport = (() => {
                  try { return transportOf(JSON.parse(entry.json)); } catch { return ""; }
                })();
                // State dot: filled = the CLI reported this server (green
                // connected / blue connecting / red disconnected / grey
                // disabled-blocked); hollow = no channel (offline or Mod
                // missing) — never a guessed color.
                const dot =
                  view === undefined && status === undefined
                    ? null
                    : view === undefined && status === null
                      ? "shrink-0 size-1.5 rounded-full border-2 border-muted-foreground"
                      : view === undefined
                        ? "shrink-0 size-1.5 rounded-full bg-muted-foreground"
                        : view.disabled || view.blocked
                          ? "shrink-0 size-1.5 rounded-full bg-muted-foreground"
                          : view.status === "connected"
                            ? "shrink-0 size-1.5 rounded-full bg-success"
                            : view.status === "connecting"
                              ? "shrink-0 size-1.5 rounded-full bg-info"
                              : "shrink-0 size-1.5 rounded-full bg-destructive";
                const dotTitle =
                  view === undefined
                    ? status === null
                      ? t("连接状态不可获取（内核未连接或状态上报未启用）")
                      : t("连接状态读取中…")
                    : statusLabel(view) + (view.error ? ` — ${view.error}` : "");
                return (
                  <div key={i} className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card">
                    <div className="flex items-center gap-1.5">
                      {dot && (
                        <span
                          className={dot}
                          title={dotTitle}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-ui-body font-semibold text-foreground">
                        {entry.name}
                      </span>
                      {(() => {
                        const clash = scopeClash(name);
                        if (!clash) return null;
                        return (
                          <Chip
                            tone={clash === "overrides" ? "warning" : "muted"}
                            title={t("两级同名时内核用项目级配置整体替换全局条目（不合并字段）")}
                          >
                            {clash === "overrides" ? t("覆盖全局") : t("被项目覆盖")}
                          </Chip>
                        );
                      })()}
                      {view?.contextTokens !== undefined && (
                        <span
                          className="ml-1 shrink-0 text-ui-label font-mono text-muted-foreground"
                          title={t("工具声明注入模型上下文约 {0} tokens（估算）", fmtTokens(view.contextTokens))}
                        >
                          ≈{fmtTokens(view.contextTokens)}
                        </span>
                      )}
                      <IconButton
                        icon={<ChevronRight className={ICON_INLINE} />}
                        label={t("详情")}
                        size="sm"
                        disabled={saving || !!loadError}
                        onClick={() => {
                          setDetail(i);
                          setEditError(null);
                        }}
                      />
                      <IconButton
                        icon={<Pencil className={ICON_INLINE} />}
                        label={t("编辑")}
                        size="sm"
                        disabled={saving || !!loadError}
                        onClick={() => {
                          setEditing(i);
                          setIsNew(false);
                          setEditError(null);
                        }}
                      />
                      {!saving && !loadError && (
                        <Dropdown
                          align="right"
                          menuClass="w-[9rem]"
                          trigger={(open) => (
                            <IconButton
                              icon={<MoreHorizontal className={ICON_INLINE} />}
                              label={t("服务器 {0} 的操作", entry.name)}
                              size="sm"
                              aria-haspopup="menu"
                              aria-expanded={open}
                              className={open ? "bg-accent/60 text-foreground" : ""}
                            />
                          )}
                        >
                          {(close) => (
                            <button
                              role="menuitem"
                              data-variant="danger"
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-label text-destructive hover:bg-destructive/10"
                              onClick={() => {
                                close();
                                setConfirmDelete(i);
                              }}
                            >
                              <Trash2 className={ICON_INLINE} />
                              {t("删除")}
                            </button>
                          )}
                        </Dropdown>
                      )}
                    </div>
                    {transport && (
                      <div className="truncate font-mono text-ui-label text-muted-foreground" title={transport}>
                        {transport}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Hint className="mt-2">
            {scope === "project"
              ? t(
                  "项目级读写 <工作区>/.iflow/settings.json 的 mcpServers 字段；与全局同名时内核用项目条目整体替换全局条目（不合并字段）。保存后点击底部「重启内核」生效。",
                )
              : t(
                  "全局读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后点击底部「重启内核」生效（当前会话自动恢复）。",
                )}
          </Hint>
        </>
      )}

      {detail !== null && entries?.[detail] && (
        <div className="space-y-2">
          {(() => {
            const entry = entries[detail]!;
            const name = entry.name.trim();
            const view = status?.servers[name];
            const transport = (() => {
              try { return transportOf(JSON.parse(entry.json)); } catch { return ""; }
            })();
            const tools: McpToolView[] = view?.tools ?? [];
            const prompts: McpPromptView[] = view?.prompts ?? [];
            return (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-ui-body font-semibold text-foreground">{entry.name}</span>
                  <span
                    className={
                      view?.status === "connected"
                        ? "ml-1.5 shrink-0 rounded-full bg-success/15 border border-success/50 px-1.5 py-px text-ui-label font-medium text-success"
                        : view?.status === "connecting"
                          ? "ml-1.5 shrink-0 rounded-full bg-info/15 border border-info/50 px-1.5 py-px text-ui-label font-medium text-info"
                          : "ml-1.5 shrink-0 rounded-full bg-muted-foreground/10 border border-muted-foreground/40 px-1.5 py-px text-ui-label font-medium text-muted-foreground"
                    }
                    title={view ? statusLabel(view) + (view.error ? ` — ${view.error}` : "") : t("连接状态不可获取（内核未连接或状态上报未启用）")}
                  >
                    {view ? statusLabel(view) : t("状态不可获取")}
                  </span>
                  {view?.contextTokens !== undefined && (
                    <span
                      className="ml-1.5 shrink-0 text-ui-label font-mono text-muted-foreground"
                      title={t("工具声明注入模型上下文约 {0} tokens（估算）", fmtTokens(view.contextTokens))}
                    >
                      ≈{fmtTokens(view.contextTokens)} tokens
                    </span>
                  )}
                </div>
                {view?.error && (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/8 px-2 py-1.5 text-ui-label text-destructive" title={view.error}>
                    {t("连接失败：")}
                    <span className="font-mono">{view.error}</span>
                    {view.errorKind ? ` (${view.errorKind})` : ""}
                  </div>
                )}
                {transport && (
                  <div className="truncate font-mono text-ui-label text-muted-foreground" title={transport}>
                    {transport}
                  </div>
                )}

                {tools.length === 0 && prompts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-2 py-2 text-center text-ui-label text-muted-foreground">
                    {view
                      ? view.toolCount + view.promptCount === 0
                        ? t("该服务器当前暴露无工具与提示")
                        : t("工具声明读取中…")
                      : t("工具声明不可获取（未连接或状态上报未启用）")}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tools.length > 0 && (
                      <>
                        <div className="text-ui-label font-semibold text-foreground">{t("工具 ({0})", String(tools.length))}</div>
                        {tools.map((tool, ti) => (
                          <div key={ti} className="rounded-lg border border-border px-2 py-1.5 shadow-card">
                            <div className="flex items-center gap-1.5">
                              <span className="shrink-0 font-mono text-ui-label font-semibold text-foreground">{tool.name}</span>
                              {tool.description && (
                                <span className="ml-1.5 flex-1 truncate text-ui-label text-muted-foreground" title={tool.description}>
                                  {tool.description}
                                </span>
                              )}
                            </div>
                            {tool.schema !== undefined && !tool.schemaOmitted && (
                              <pre
                                className="mt-2 max-h-24 overflow-y-auto rounded-md bg-muted/8 px-1.5 py-1 font-mono text-ui-caption leading-snug whitespace-pre-wrap break-all"
                                title={t("参数 schema")}
                              >
                                {JSON.stringify(tool.schema, null, 2)}
                              </pre>
                            )}
                            {tool.schemaOmitted && (
                              <div className="mt-1 text-ui-caption text-muted-foreground/80">{t("参数 schema 已省略（上报预算超限）")}</div>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                    {prompts.length > 0 && (
                      <>
                        <div className="text-ui-label font-semibold text-foreground">{t("提示 ({0})", String(prompts.length))}</div>
                        {prompts.map((prompt, pi) => (
                          <div key={pi} className="flex items-center gap-1.5">
                            <span className="shrink-0 font-mono text-ui-label text-foreground">{prompt.name}</span>
                            {prompt.description && (
                              <span className="ml-1.5 flex-1 truncate text-ui-label text-muted-foreground" title={prompt.description}>
                                {prompt.description}
                              </span>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {editing !== null && entries?.[editing] && (() => {
        const entry = entries[editing]!;
        const config = parseConfig(entry.json) ?? {};
        const transport = transportOfConfig(config);
        const isStdio = transport === "stdio";
        const args = normalizeArgs(config.args);
        const envRows = normalizePairs(config.env);
        const headerRows = normalizePairs(config.headers);
        const extraKeys = Object.keys(config).filter((key) => !MCP_FORM_KEYS.has(key));
        return (
          <div className="space-y-3">
            <section className="overflow-hidden rounded-lg border border-border bg-surface/60 shadow-card">
              <div className="flex items-baseline gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
                <h3 className="text-ui-label font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("服务器信息")}
                </h3>
              </div>
              <div className="divide-y divide-border/50">
                <Field required className="px-3 py-3" label={t("名称")}>
                  <TextInput
                    value={entry.name}
                    placeholder={t("如 chrome-devtools")}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, name: v } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  />
                </Field>
                <Field className="px-3 py-3" label={t("描述")}>
                  <TextArea
                    className="min-h-16 leading-relaxed"
                    value={fieldOfConfig(config, "description")}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithField(parseConfig(en.json) ?? {}, "description", v) } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  />
                </Field>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-border bg-surface/60 shadow-card">
              <div className="flex items-baseline gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
                <h3 className="text-ui-label font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("传输与运行")}
                </h3>
                <span className="ml-auto min-w-0 truncate font-mono text-ui-caption text-muted-foreground/75">
                  {transport}
                </span>
              </div>
              <div className="divide-y divide-border/50">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="mr-1 text-ui-label text-muted-foreground">{t("传输类型")}</span>
                  <Segmented
                    ariaLabel={t("传输类型")}
                    value={transport}
                    onChange={(kind) => {
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithTransport(parseConfig(en.json) ?? {}, kind) } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                    options={MCP_TRANSPORTS.map((kind) => ({
                      value: kind,
                      label: <span className="font-mono">{kind}</span>,
                      title: kind,
                    }))}
                  />
                </div>
            {isStdio ? (
              <>
                <Field required className="px-3 py-3" label={t("命令")}>
                  <TextInput
                    mono
                    value={fieldOfConfig(config, "command")}
                    placeholder="npx"
                    onChange={(e) => {
                      const v = e.target.value;
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithField(parseConfig(en.json) ?? {}, "command", v) } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  />
                </Field>
                <div className="flex flex-col gap-2 px-3 py-3">
                  <FieldLabel>{t("参数")}</FieldLabel>
                  {args.length > 0 && (
                    <div className="overflow-hidden rounded-lg border border-border/60 divide-y divide-border/60">
                      {args.map((arg, ai) => (
                        <div key={ai} className="flex items-center gap-2 px-2 py-1">
                          <TextInput
                            mono
                            aria-label={t("参数 {0}", ai + 1)}
                            className="flex-1 text-ui-label"
                            value={arg}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithArgSet(parseConfig(en.json) ?? {}, ai, v) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                          <IconButton
                            icon={<Trash2 className={ICON_INLINE} />}
                            label={t("删除参数")}
                            size="sm"
                            tone="danger"
                            onClick={() => {
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithArgRemoved(parseConfig(en.json) ?? {}, ai) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <Button
                    variant="secondary"
                    icon={<Plus className={ICON_INLINE} />}
                    onClick={() => {
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithArgAdded(parseConfig(en.json) ?? {}) } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  >
                    {t("添加参数")}
                  </Button>
                </div>
                <div className="flex flex-col gap-2 px-3 py-3 pb-3">
                  <FieldLabel>{t("环境变量")}</FieldLabel>
                  {envRows.length > 0 && (
                    <div className="overflow-hidden rounded-lg border border-border/60 divide-y divide-border/60">
                      {envRows.map(([keyName, keyValue], ri) => (
                        <div key={ri} className="flex items-center gap-2 px-2 py-1">
                          <TextInput
                            mono
                            aria-label={t("环境变量 {0}", keyName)}
                            className="flex-1 text-ui-label"
                            value={`${keyName}=${keyValue}`}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairSet(parseConfig(en.json) ?? {}, "env", ri, v) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                          <IconButton
                            icon={<Trash2 className={ICON_INLINE} />}
                            label={t("删除变量")}
                            size="sm"
                            tone="danger"
                            onClick={() => {
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairRemoved(parseConfig(en.json) ?? {}, "env", ri) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <Button
                    variant="secondary"
                    icon={<Plus className={ICON_INLINE} />}
                    onClick={() => {
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairAdded(parseConfig(en.json) ?? {}, "env") } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  >
                    {t("添加变量")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Field required className="px-3 py-3" label={t("服务 URL")}>
                  <TextInput
                    mono
                    value={fieldOfConfig(config, "url")}
                    placeholder="https://…"
                    onChange={(e) => {
                      const v = e.target.value;
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithField(parseConfig(en.json) ?? {}, "url", v) } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  />
                </Field>
                <div className="flex flex-col gap-2 px-3 py-3 pb-3">
                  <FieldLabel>{t("请求头")}</FieldLabel>
                  {headerRows.length > 0 && (
                    <div className="overflow-hidden rounded-lg border border-border/60 divide-y divide-border/60">
                      {headerRows.map(([keyName, keyValue], ri) => (
                        <div key={ri} className="flex items-center gap-2 px-2 py-1">
                          <TextInput
                            mono
                            aria-label={t("请求头 {0}", keyName)}
                            className="flex-1 text-ui-label"
                            value={`${keyName}=${keyValue}`}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairSet(parseConfig(en.json) ?? {}, "headers", ri, v) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                          <IconButton
                            icon={<Trash2 className={ICON_INLINE} />}
                            label={t("删除 header")}
                            size="sm"
                            tone="danger"
                            onClick={() => {
                              setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairRemoved(parseConfig(en.json) ?? {}, "headers", ri) } : en)) ?? null);
                              setSavedFlash(false);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <Button
                    variant="secondary"
                    icon={<Plus className={ICON_INLINE} />}
                    onClick={() => {
                      setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: configWithPairAdded(parseConfig(en.json) ?? {}, "headers") } : en)) ?? null);
                      setSavedFlash(false);
                    }}
                  >
                    {t("添加 header")}
                  </Button>
                </div>
                            </>
                          )}
                          {extraKeys.length > 0 && (
                            <div className="truncate rounded-lg border border-border/70 bg-surface/40 px-2 py-1 text-ui-label leading-relaxed text-muted-foreground/85">
                              {t("额外字段保留：{0}", extraKeys.join(", "))}
                            </div>
                          )}
                            </div>
                          </section>
            <ActionRow>
              <Button
                variant="primary"
                onClick={() => {
                  const target = entries[editing];
                  if (!target) return;
                  let error = validateEntry(target);
                  if (!error) {
                    const cfg = parseConfig(target.json) ?? {};
                    error = transportOfConfig(cfg) === "stdio"
                      ? typeof cfg.command === "string" && cfg.command.trim() !== ""
                        ? null
                        : t("stdio 配置需 command field")
                      : typeof cfg.url === "string" && cfg.url.trim() !== ""
                        ? null
                        : t("sse/streamable-http 配置需 url field");
                  }
                  if (!error && entries.some((other, ii) => ii !== editing && other.name.trim() === target.name.trim())) {
                    error = t("名称重复：{0}", target.name.trim());
                  }
                  if (error) {
                    setEditError(error);
                    return;
                  }
                  setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: finalizeEntryJson(en.json) } : en)) ?? null);
                  setEditing(null);
                  setEditError(null);
                }}
              >
                {t("完成")}
              </Button>
              {editError && <span className="text-ui-body text-destructive">{editError}</span>}
            </ActionRow>
            <Hint>
              {t("编辑只改本地副本，点击「保存」才写入文件。")}
            </Hint>
          </div>
        );
      })()}

      {catalogForm !== null && (() => {
        const template = MCP_CATALOG.find((c) => c.id === catalogForm.entryId);
        if (!template) return null;
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-ui-body font-semibold text-foreground">{template.title}</span>
              <span className="ml-1.5 text-ui-label text-muted-foreground">{t("安装模板")}</span>
            </div>
            <Field label={t("名称")}>
              <TextInput
                value={catalogForm.name}
                placeholder={template.name}
                onChange={(e) => {
                  const v = e.target.value;
                  setCatalogForm((current) => (current ? { ...current, name: v } : null));
                }}
              />
            </Field>
            {template.fields.map((field) => (
              <Field key={field.key} label={field.label}>
                <TextInput
                  mono
                  value={catalogForm.values[field.key] ?? ""}
                  placeholder={field.placeholder ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCatalogForm((current) =>
                      current ? { ...current, values: { ...current.values, [field.key]: v } } : null,
                    );
                  }}
                />
              </Field>
            ))}
            <ActionRow>
              <Button variant="primary" onClick={installCatalog}>
                {t("安装")}
              </Button>
              {editError && <span className="text-ui-body text-destructive">{editError}</span>}
            </ActionRow>
            <Hint>
              {t("安装只把模板本地草稿，点击「保存」才写入文件。")}
            </Hint>
          </div>
        );
      })()}

      {confirmDelete !== null && entries?.[confirmDelete] && (
        <ConfirmDialog
          title={t("删除 MCP 服务器")}
          message={t("确定删除「{0}」吗？保存后将从内核配置中移除。", entries[confirmDelete]!.name)}
          onConfirm={() => {
            setEntries((current) => current?.filter((_, j) => j !== confirmDelete) ?? null);
            setSavedFlash(false);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
