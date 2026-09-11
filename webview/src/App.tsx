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
import { QuestionCard } from "./components/QuestionCard";
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
  const pending = useChat((s) => s.pending);
  const beginPending = useChat((s) => s.beginPending);
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

  // Auth card opened: refresh the profile list the same way the header
  // dropdown does, so the card never shows a stale snapshot either.
  useEffect(() => {
    if (configOpen) send({ type: "refreshAuth" });
  }, [configOpen, send]);

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
  // A profile switch is in flight (optimistic lock): disable every switcher.
  const switching = pending !== null;
  const locked = busy || switching;
  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
  const sessionLabel =
    activeSession?.label ?? (state.activeSessionId ? t("当前会话") : t("会话历史"));

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      {/* header */}
      <header className="acrylic shrink-0 border-b border-border px-3 py-2.5">
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
              disabled={locked}
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
            {/* API profiles: quick switch + manage (opens the full auth card).
                Refresh the profile list at open time: settings.json is rewritten
                by external tools behind our back, so the shown list must be
                recomputed on every open, not reused from panel load. */}
            <Dropdown
              align="right"
              menuClass="w-64"
              onOpenChange={(o) => {
                if (o) send({ type: "refreshAuth" });
              }}
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
                      disabled={locked}
                      onClick={() => {
                        if (!p.active) {
                          beginPending("profile", p.name);
                          send({ type: "activateProfile", name: p.name });
                        }
                        close();
                      }}
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                    >
                      <span className="flex w-full min-w-0 items-center text-[12px] text-foreground">
                        <span className="min-w-0 truncate">{p.name}</span>
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
        {/* min-w-0 on the row + Dropdown wrapper: the flex shrink chain must
            reach the truncating label inside the trigger, or a long session
            title stretches the whole header row (seen with prompt-derived
            labels). */}
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          {/* session switcher */}
          {state.sessions.length > 0 ? (
            <Dropdown
              menuClass="w-72 max-h-64 overflow-y-auto"
              wrapperClass="min-w-0 flex-1"
              trigger={(open) => (
                <button
                  className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-left text-[11px] hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 ${
                    open ? "bg-surface-2" : ""
                  }`}
                  title={t("历史会话（选择后恢复该会话上下文）")}
                  disabled={locked}
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
                    const deletable = s.id !== state.activeSessionId && !locked;
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
        // break-words + scroll cap: errorMessage() can return unbounded JSON
        // dumps (unbroken tokens) and multi-line detail — without them the
        // banner overflowed horizontally / crushed the transcript area.
        <div className="max-h-24 shrink-0 select-text overflow-y-auto break-words border-b border-border bg-destructive/15 px-3 py-1.5 text-[12px] text-destructive">
          {state.errorMessage}
        </div>
      )}

      {showAuthCard && (
        <AuthCard auth={state.auth} editable={configOpen} busy={locked} onDismiss={() => setConfigOpen(false)} />
      )}

      <MessageList />

      {state.pendingApproval && <ApprovalCard approval={state.pendingApproval} />}

      {state.pendingQuestions && <QuestionCard pending={state.pendingQuestions} />}

      <Composer />
    </div>
  );
}