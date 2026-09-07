import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  History,
  Loader2,
  Moon,
  Plus,
  Settings2,
  Sun,
  Trash2,
} from "lucide-react";
import logo from "./assets/iflow.svg";
import { useChat } from "./store";
import { isEnglishLocale, t } from "./i18n";
import { Chip, Dropdown } from "./components/ui";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";
import { AuthCard } from "./components/AuthCard";
import type { AgentStatus } from "../../shared/messages";

function statusChip(status: AgentStatus) {
  switch (status) {
    case "connecting":
      return (
        <Chip tone="warning">
          <Loader2 className="size-2.5 animate-spin" /> {t("连接中")}
        </Chip>
      );
    case "idle":
      return (
        <Chip tone="success">
          <span className="size-1.5 rounded-full bg-success" /> {t("就绪")}
        </Chip>
      );
    case "streaming":
      return (
        <Chip tone="primary">
          <Loader2 className="size-2.5 animate-spin" /> {t("正在生成")}
        </Chip>
      );
    case "error":
      return (
        <Chip tone="danger">
          <span className="size-1.5 rounded-full bg-destructive" /> {t("错误")}
        </Chip>
      );
  }
}

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const BTN_ICON =
  "rounded p-1 text-muted-foreground hover:bg-surface hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-40";

export function App() {
  const state = useChat((s) => s.state);
  const editorTheme = useChat((s) => s.editorTheme);
  const send = useChat((s) => s.send);
  const [configOpen, setConfigOpen] = useState(false);
  // Theme priority: the user's explicit toggle wins (persisted); otherwise
  // follow the editor color theme pushed by the host; default light.
  const [manual, setManual] = useState<"light" | "dark" | null>(
    () => (localStorage.getItem("iflow-theme") as "light" | "dark" | null) ?? null,
  );
  const dark = manual ? manual === "dark" : editorTheme !== null ? editorTheme === "dark" : false;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    if (manual) localStorage.setItem("iflow-theme", manual);
  }, [dark, manual]);

  if (!state || state.status === "connecting") {
    // Full-screen brand splash until the session is fully initialized.
    return (
      <div className="splash">
        <img src={logo} alt="" className="splash-logo" />
        <div className="splash-title">{t("心流·驭光")}</div>
        {!isEnglishLocale() && <div className="splash-sub">iFlow Harness</div>}
        <div className="splash-bar" />
        <div className="splash-hint">
          {t("正在启动 iFlow CLI…（首次启动或配置了多个 MCP server 时较久）")}
        </div>
      </div>
    );
  }

  const showAuthCard = state.auth.needsSetup || configOpen;
  // While the agent is streaming (or an approval blocks it), or while a new
  // session / history restore is initializing, switching the session / mode /
  // model / profile would desync the in-flight ACP request.
  const busy = state.status === "streaming" || state.replaying || state.initializing;
  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
  const sessionLabel =
    activeSession?.label ?? (state.activeSessionId ? t("当前会话") : t("会话历史"));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-panel text-foreground">
      {/* header */}
      <header className="aurora shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <img src={logo} alt="" className="size-5" />
          <div className="leading-tight">
            <h1 className="text-[13px] font-extrabold tracking-tight">{t("心流·驭光")}</h1>
            {!isEnglishLocale() && (
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                iFlow Harness
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              className={BTN_ICON}
              title={t("新会话")}
              disabled={busy}
              onClick={() => send({ type: "newSession" })}
            >
              <Plus className="size-4" />
            </button>
            <button
              className={BTN_ICON}
              title={dark ? t("切换到浅色主题") : t("切换到深色主题")}
              aria-label={dark ? t("切换到浅色主题") : t("切换到深色主题")}
              onClick={() => setManual((prev) => ((prev ?? (dark ? "dark" : "light")) === "dark" ? "light" : "dark"))}
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            {/* API profiles: quick switch + manage (opens the full auth card) */}
            <Dropdown
              align="right"
              menuClass="w-64"
              trigger={(open) => (
                <button
                  className={`${BTN_ICON}${state.auth.authenticated ? "" : " text-warning"}`}
                  title={t("API 凭据配置")}
                  aria-label={t("API 凭据配置")}
                >
                  <Settings2 className={`size-4${open ? "" : ""}`} />
                </button>
              )}
            >
              {(close) => (
                <>
                  {state.auth.profiles.length > 0 && (
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("API 配置")}
                    </div>
                  )}
                  {state.auth.profiles.map((p) => (
                    <button
                      key={p.name}
                      disabled={busy}
                      onClick={() => {
                        if (!p.active) send({ type: "activateProfile", name: p.name });
                        close();
                      }}
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                    >
                      <span className="flex w-full items-center text-[12px] text-foreground">
                        {p.name}
                        {p.active && <Check className="ml-auto size-3 shrink-0 text-primary" />}
                      </span>
                      <span className="w-full truncate font-mono text-[10px] text-muted-foreground">
                        {p.modelName} · {p.keyTail}
                      </span>
                    </button>
                  ))}
                  <div className="border-t border-border">
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        setConfigOpen(true);
                        close();
                      }}
                    >
                      {t("管理配置与凭据…")}
                    </button>
                  </div>
                </>
              )}
            </Dropdown>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          {/* session switcher */}
          {state.sessions.length > 0 ? (
            <Dropdown
              menuClass="w-72 max-h-64 overflow-y-auto"
              trigger={(open) => (
                <button
                  className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-left text-[11px] hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 ${
                    open ? "bg-surface-2" : ""
                  }`}
                  title={t("历史会话（选择后恢复该会话上下文）")}
                  disabled={busy}
                >
                  <History className="size-3 shrink-0 text-primary" />
                  <span className="truncate text-foreground">{sessionLabel}</span>
                  <ChevronDown className="ml-auto size-3 shrink-0 opacity-60" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("会话历史")}
                  </div>
                  {state.activeSessionId &&
                    !state.sessions.some((s) => s.id === state.activeSessionId) && (
                      <button
                        onClick={close}
                        className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-foreground hover:bg-accent"
                      >
                        {t("当前会话")}
                      </button>
                    )}
                  {state.sessions.map((s) => {
                    const deletable = s.id !== state.activeSessionId && !busy;
                    return (
                      <div
                        key={s.id}
                        className="flex w-full items-center px-3 py-1.5 hover:bg-accent"
                      >
                        <button
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                          onClick={() => {
                            send({ type: "loadSession", sessionId: s.id });
                            close();
                          }}
                        >
                          <span className="flex w-full items-center gap-2 text-[12px] text-foreground">
                            <span className="truncate">{s.label}</span>
                            {s.id === state.activeSessionId && (
                              <Check className="ml-auto size-3 shrink-0 text-primary" />
                            )}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {formatSessionTime(s.updatedAt)}
                          </span>
                        </button>
                        {deletable && (
                          <button
                            className="shrink-0 rounded p-0.5 text-[11px] text-muted-foreground opacity-60 hover:opacity-100 hover:text-destructive"
                            title={t("删除会话 {0}", s.label)}
                            onClick={(e) => {
                              e.stopPropagation();
                              send({ type: "deleteSession", sessionId: s.id });
                            }}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </Dropdown>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground">
              <History className="size-3 shrink-0 text-primary" />
              <span className="truncate">{t("会话历史")}</span>
            </div>
          )}
          {state.replaying ? (
            <Chip tone="info">
              <Loader2 className="size-2.5 animate-spin" /> {t("正在恢复历史会话…")}
            </Chip>
          ) : (
            statusChip(state.status)
          )}
        </div>
      </header>

      {state.errorMessage && (
        <div className="shrink-0 border-b border-border bg-destructive/15 px-3 py-1.5 text-[12px] text-destructive">
          {state.errorMessage}
        </div>
      )}

      {showAuthCard && (
        <AuthCard auth={state.auth} editable={configOpen} busy={busy} onDismiss={() => setConfigOpen(false)} />
      )}

      <MessageList />

      {state.pendingApproval && <ApprovalCard approval={state.pendingApproval} />}

      <Composer />
    </div>
  );
}