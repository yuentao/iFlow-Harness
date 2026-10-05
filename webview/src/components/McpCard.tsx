import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Pencil, Plus, Server, X } from "lucide-react";
import { useChat } from "../store";
import { t } from "../i18n";
import { InlineConfirm } from "./ui";

/** Visible, non-disabled focusable elements within a container (for focus trap). */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
}

/** One MCP server entry as edited in the card: name + raw JSON body.
 * The JSON stays raw text (not parsed into fields) — the CLI's schema is
 * open-ended (command/args/env or url/headers/type, plus free-form
 * description/_lastModified), so a structurer form would drop unknown keys. */
interface Entry {
  name: string;
  json: string;
}

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

/**
 * MCP server management card: reads/writes the `mcpServers` dict in
 * `~/.iflow/settings.json` through the host (the CLI owns that file, so the
 * card always opens on disk truth via `listMcpServers`). Edits happen on a
 * local copy; 「保存」 sends the whole dict back (replace semantics — see
 * shared/messages.ts) and the host offers a CLI hot-restart, since the CLI
 * only reads mcpServers at startup.
 */
export function McpCard({ busy, onDismiss }: { busy: boolean; onDismiss: () => void }) {
  const send = useChat((s) => s.send);
  const [entries, setEntries] = useState<Entry[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null); // index into entries
  const [isNew, setIsNew] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const backdropRef = useRef<HTMLDivElement>(null);
  // W3-style focus management: focus the dialog on mount, restore on unmount.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const container = backdropRef.current;
    if (container) {
      const focusables = getFocusable(container);
      (focusables.find((el) => el.tagName === "INPUT") ?? focusables[0])?.focus();
    }
    return () => prevFocus?.focus?.();
  }, []);

  // Open → request the current disk state. The reply arrives as a window
  // message (same channel Composer uses for filesPicked — store.ts routes
  // these kinds away from the snapshot pipeline). Late replies after
  // unmount are dropped by React's setState-on-unmounted no-op.
  useEffect(() => {
    send({ type: "listMcpServers" });
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type?: string; servers?: Record<string, unknown>; error?: string };
      if (msg?.type !== "mcpServers") return;
      if (msg.error) {
        setLoadError(msg.error);
        setEntries([]);
        return;
      }
      setEntries(
        Object.entries(msg.servers ?? {}).map(([name, config]) => ({
          name,
          json: JSON.stringify(config ?? {}, null, 2),
        })),
      );
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [send]);

  function save() {
    if (!entries) return;
    const servers: Record<string, unknown> = {};
    for (const entry of entries) {
      const error = validateEntry(entry);
      if (error) {
        setEditError(error);
        return;
      }
      const name = entry.name.trim();
      if (name in servers) {
        setEditError(t("名称重复：{0}", name));
        return;
      }
      servers[name] = JSON.parse(entry.json);
    }
    setEditError(null);
    send({ type: "saveMcpServers", servers });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
  }

  const INPUT =
    "rounded-lg border border-border bg-editor px-2.5 py-1.5 text-[12.5px] text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground/60 focus:border-primary/50 focus:shadow-focus";
  const BTN =
    "press rounded-lg border border-border bg-editor px-2.5 py-1 text-[11px] font-medium text-foreground transition-all duration-200 hover:border-primary/40 hover:bg-accent disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      className="auth-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("MCP 服务器")}
      tabIndex={-1}
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
          return;
        }
        if (e.key === "Tab") {
          const container = backdropRef.current;
          if (!container) return;
          const focusables = getFocusable(container);
          if (focusables.length === 0) return;
          const first = focusables[0]!;
          const last = focusables[focusables.length - 1]!;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div className="auth-modal acrylic-pop">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          {editing !== null ? (
            <button
              className="text-muted-foreground hover:text-foreground"
              title={t("返回列表")}
              onClick={() => {
                setEditing(null);
                setEditError(null);
              }}
            >
              <ArrowLeft className="size-3.5" />
            </button>
          ) : (
            <Server className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="min-w-0 truncate text-[12px] font-semibold">
            {editing !== null ? (isNew ? t("添加 MCP 服务器") : t("编辑 MCP 服务器")) : t("MCP 服务器")}
          </span>
          <button
            className="ml-auto text-muted-foreground hover:text-foreground"
            title={t("收起")}
            onClick={onDismiss}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="space-y-2.5 px-3 py-2.5">
          {loadError && <div className="text-[12px] text-destructive">{loadError}</div>}

          {editing === null && (
            <>
              {entries === null ? (
                <div className="py-4 text-center text-[12px] text-muted-foreground">{t("读取中…")}</div>
              ) : entries.length === 0 && !loadError ? (
                <div className="py-4 text-center text-[12px] text-muted-foreground">
                  {t("尚未配置 MCP 服务器")}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {entries!.map((entry, i) => {
                    let transport = "";
                    try {
                      transport = transportOf(JSON.parse(entry.json));
                    } catch {
                      transport = "";
                    }
                    return (
                      <div key={i} className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                            {entry.name}
                          </span>
                          <button
                            className="shrink-0 text-muted-foreground opacity-70 hover:opacity-100 hover:text-foreground"
                            title={t("编辑")}
                            onClick={() => {
                              setEditing(i);
                              setIsNew(false);
                              setEditError(null);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <InlineConfirm
                            armed={confirmDelete === i}
                            onArm={() => setConfirmDelete(i)}
                            onCancel={() => setConfirmDelete(null)}
                            onConfirm={() => {
                              setEntries(entries!.filter((_, j) => j !== i));
                              setConfirmDelete(null);
                            }}
                            confirmLabel={t("确认")}
                            cancelLabel={t("取消")}
                            title={t("删除 {0}", entry.name)}
                            className="ml-1"
                            triggerClassName="opacity-70 hover:opacity-100"
                          />
                        </div>
                        {transport && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground" title={transport}>
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
                  disabled={entries === null}
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
                <button
                  className="press rounded-lg bg-gradient-to-b from-primary to-primary/90 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40"
                  disabled={busy || entries === null || savedFlash}
                  onClick={save}
                >
                  {savedFlash ? t("已保存") : t("保存")}
                </button>
                {editError && <span className="text-[12px] text-destructive">{editError}</span>}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/85">
                {t(
                  "配置直接读写 ~/.iflow/settings.json 的 mcpServers 字段；保存后需重启 CLI 生效（当前会话自动恢复）。",
                )}
              </p>
            </>
          )}

          {editing !== null && entries && (
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
                    setEntries(entries.map((en, j) => (j === editing ? { ...en, name: v } : en)));
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
                    setEntries(entries.map((en, j) => (j === editing ? { ...en, json: v } : en)));
                  }}
                />
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  className={BTN}
                  onClick={() => {
                    const error = validateEntry(entries[editing]!);
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
        </div>
      </div>
    </div>
  );
}
