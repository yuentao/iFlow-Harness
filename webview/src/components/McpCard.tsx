import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useChat } from "../store";
import { entriesToServers, sameMcpServers, type McpEntry } from "./mcp-servers";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, ConfirmDialog, SAVE_BTN } from "./ui";
import type { SectionHeader } from "./SettingsModal";
import type { McpStatusUi, McpServerStatusView, McpToolView, McpPromptView } from "../../../shared/messages";

/** Editor-state header override a section reports to the settings shell. */
type SectionHeaderSetter = Dispatch<SetStateAction<SectionHeader | null>>;

/** One MCP server entry as edited in the card: name + raw JSON body.
 * The JSON stays raw text (not parsed into fields) — the CLI's schema is
 * open-ended (command/args/env or url/headers/type, plus free-form
 * description/_lastModified), so a structurer form would drop unknown keys. */
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
  const pending = useRef<Record<string, unknown> | null>(null);
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
        servers?: Record<string, unknown>;
        error?: string;
        status?: McpStatusUi | null;
      };
      if (msg?.type === "mcpStatus") {
        setStatus(msg.status);
        setRefreshing(false);
        return;
      }
      if (msg?.type !== "mcpServers") return;
      if (pending.current) {
        // Failure is terminal too. Never replace local drafts with either reply.
        if (!msg.error && (!msg.servers || !sameMcpServers(pending.current, msg.servers))) return;
        pending.current = null;
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
      setEntries(Object.entries(msg.servers ?? {}).map(([name, config]) => ({
        name,
        json: JSON.stringify(config, null, 2),
      })));
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
          : null,
    );
  }, [editing, isNew, detail, onHeader]);

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
    setSaving(true);
    send({ type: "saveMcpServers", servers });
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

  return (
    <>
      {loadError && <div className="text-[12px] text-destructive">{loadError}</div>}

      {editing === null && detail === null && (
        <>
          {entries === null ? (
            <div className="py-4 text-center text-[12px] text-muted-foreground">{t("读取中…")}</div>
          ) : entries.length === 0 && !loadError ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center">
              <div className="text-[12px] text-muted-foreground">{t("尚未配置 MCP 服务器")}</div>
            </div>
          ) : (
            <div className="space-y-1.5">
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
                      ? t("连接状态不可获取（CLI 未连接或状态上报未启用）")
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
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                        {entry.name}
                      </span>
                      {view?.contextTokens !== undefined && (
                        <span
                          className="ml-1 shrink-0 text-[11px] font-mono text-muted-foreground"
                          title={t("工具声明注入模型上下文约 {0} tokens（估算）", fmtTokens(view.contextTokens))}
                        >
                          ≈{fmtTokens(view.contextTokens)}
                        </span>
                      )}
                      <button
                        className="press shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-accent/60 hover:opacity-100 hover:text-foreground"
                        title={t("详情")}
                        disabled={saving || !!loadError}
                        onClick={() => {
                          setDetail(i);
                          setEditError(null);
                        }}
                      >
                        <ChevronRight className="size-3.5" />
                      </button>
                      <button
                        className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-accent/60 hover:opacity-100 hover:text-foreground"
                        title={t("编辑")}
                        disabled={saving || !!loadError}
                        onClick={() => {
                          setEditing(i);
                          setIsNew(false);
                          setEditError(null);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      {!saving && !loadError && (
                        <button
                          data-variant="danger"
                          className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                          title={t("删除 {0}", entry.name)}
                          onClick={() => setConfirmDelete(i)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {transport && (
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={transport}>
                        {transport}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button
              className={BTN}
              disabled={entries === null || !!loadError || saving}
              onClick={() => {
                setEntries([...(entries ?? []), { name: "", json: '{\n  "command": "npx",\n  "args": ["-y", "…"]\n}' }]);
                setEditing(entries === null ? 0 : entries.length);
                setIsNew(true);
                setEditError(null);
              }}
            >
              <Plus className="mr-0.5 inline size-3 align-[-2px]" />
              {t("添加")}
            </button>
            <button className={SAVE_BTN} disabled={busy || entries === null || !!loadError || saving} onClick={save}>
              {saving ? t("保存中…") : savedFlash ? t("已保存") : t("保存")}
            </button>
            <button
              className={BTN}
              disabled={busy || saving || (entries === null && !loadError)}
              onClick={refresh}
            >
              <RefreshCw className="mr-0.5 inline size-3 align-[-2px]" />
              {refreshing ? t("刷新中…") : t("刷新")}
            </button>
            {editError && <span className="text-[12px] text-destructive">{editError}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            {t(
              "配置直接读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后点击底部「重启 CLI」生效（当前会话自动恢复）。",
            )}
          </p>
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
                  <span className="text-[12.5px] font-semibold text-foreground">{entry.name}</span>
                  <span
                    className={
                      view?.status === "connected"
                        ? "ml-1.5 shrink-0 rounded-full bg-success/15 border border-success/50 px-1.5 py-[1px] text-[11px] font-medium text-success"
                        : view?.status === "connecting"
                          ? "ml-1.5 shrink-0 rounded-full bg-info/15 border border-info/50 px-1.5 py-[1px] text-[11px] font-medium text-info"
                          : "ml-1.5 shrink-0 rounded-full bg-muted-foreground/10 border border-muted-foreground/40 px-1.5 py-[1px] text-[11px] font-medium text-muted-foreground"
                    }
                    title={view ? statusLabel(view) + (view.error ? ` — ${view.error}` : "") : t("连接状态不可获取（CLI 未连接或状态上报未启用）")}
                  >
                    {view ? statusLabel(view) : t("状态不可获取")}
                  </span>
                  {view?.contextTokens !== undefined && (
                    <span
                      className="ml-1.5 shrink-0 text-[11px] font-mono text-muted-foreground"
                      title={t("工具声明注入模型上下文约 {0} tokens（估算）", fmtTokens(view.contextTokens))}
                    >
                      ≈{fmtTokens(view.contextTokens)} tokens
                    </span>
                  )}
                </div>
                {view?.error && (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/8 px-2 py-1.5 text-[11.5px] text-destructive" title={view.error}>
                    {t("连接失败：")}
                    <span className="font-mono">{view.error}</span>
                    {view.errorKind ? ` (${view.errorKind})` : ""}
                  </div>
                )}
                {transport && (
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={transport}>
                    {transport}
                  </div>
                )}

                {tools.length === 0 && prompts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-2 py-2 text-center text-[11.5px] text-muted-foreground">
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
                        <div className="text-[11.5px] font-semibold text-foreground">{t("工具 ({0})", String(tools.length))}</div>
                        {tools.map((tool, ti) => (
                          <div key={ti} className="rounded-lg border border-border px-2 py-1.5 shadow-card">
                            <div className="flex items-center gap-1.5">
                              <span className="shrink-0 font-mono text-[11.5px] font-semibold text-foreground">{tool.name}</span>
                              {tool.description && (
                                <span className="ml-1.5 flex-1 truncate text-[11px] text-muted-foreground" title={tool.description}>
                                  {tool.description}
                                </span>
                              )}
                            </div>
                            {tool.schema !== undefined && !tool.schemaOmitted && (
                              <pre
                                className="mt-1.5 max-h-24 overflow-y-auto rounded-md bg-muted/8 px-1.5 py-1 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all"
                                title={t("参数 schema")}
                              >
                                {JSON.stringify(tool.schema, null, 2)}
                              </pre>
                            )}
                            {tool.schemaOmitted && (
                              <div className="mt-1 text-[10.5px] text-muted-foreground/80">{t("参数 schema 已省略（上报预算超限）")}</div>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                    {prompts.length > 0 && (
                      <>
                        <div className="text-[11.5px] font-semibold text-foreground">{t("提示 ({0})", String(prompts.length))}</div>
                        {prompts.map((prompt, pi) => (
                          <div key={pi} className="flex items-center gap-1.5">
                            <span className="shrink-0 font-mono text-[11.5px] text-foreground">{prompt.name}</span>
                            {prompt.description && (
                              <span className="ml-1.5 flex-1 truncate text-[11px] text-muted-foreground" title={prompt.description}>
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
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              className={BTN}
              onClick={() => {
                setDetail(null);
              }}
            >
              <Check className="mr-0.5 inline size-3 align-[-2px]" />
              {t("返回")}
            </button>
          </div>
        </div>
      )}

      {editing !== null && entries?.[editing] && (
        <div className="space-y-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("名称")}</span>
            <input
              type="text"
              className={INPUT}
              value={entries[editing]!.name}
              placeholder={t("如 chrome-devtools")}
              onChange={(e) => {
                const v = e.target.value;
                setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, name: v } : en)) ?? null);
                setSavedFlash(false);
              }}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">
              {t("配置 JSON（stdio：command/args/env；远程：url/headers/type）")}
            </span>
            <textarea
              className={`${INPUT} min-h-40 resize-y font-mono text-[11.5px] leading-relaxed`}
              spellCheck={false}
              value={entries[editing]!.json}
              onChange={(e) => {
                const v = e.target.value;
                setEntries((current) => current?.map((en, j) => (j === editing ? { ...en, json: v } : en)) ?? null);
                setSavedFlash(false);
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              className={SAVE_BTN}
              onClick={() => {
                const entry = entries[editing];
                if (!entry) return;
                const error = validateEntry(entry) ?? (entries.some((other, ii) => ii !== editing && other.name.trim() === entry.name.trim()) ? t("名称重复：{0}", entry.name.trim()) : null);
                if (error) {
                  setEditError(error);
                  return;
                }
                setEditing(null);
                setEditError(null);
              }}
            >
              {t("完成")}
            </button>
            {editError && <span className="text-[12px] text-destructive">{editError}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            {t("编辑只改本地副本，点击「保存」才写入文件。")}
          </p>
        </div>
      )}

      {confirmDelete !== null && entries?.[confirmDelete] && (
        <ConfirmDialog
          title={t("删除 MCP 服务器")}
          message={t("确定删除「{0}」吗？保存后将从 CLI 配置中移除。", entries[confirmDelete]!.name)}
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
