import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Coins,
  History,
  Loader2,
  Moon,
  Plus,
  Search,
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
import { PlanExitCard } from "./components/PlanExitCard";
import { QuestionCard } from "./components/QuestionCard";
import { AuthCard } from "./components/AuthCard";
import type { AgentStatus } from "../../shared/messages";

/** Compact token count, e.g. 12345 → "12.3k", 1_500_000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success" />
          </span>
          {t("就绪")}
        </Chip>
      );
    case "streaming":
      return (
        <Chip tone="primary">
          <Loader2 className="size-2.5 animate-spin" /> {t("生成中")}
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
  "rounded-md p-1.5 text-muted-foreground hover:bg-surface hover:text-foreground transition-all duration-200 active:scale-95 disabled:pointer-events-none disabled:opacity-40";

export function App() {
  const state = useChat((s) => s.state);
  const editorTheme = useChat((s) => s.editorTheme);
  const pending = useChat((s) => s.pending);
  const beginPending = useChat((s) => s.beginPending);
  const send = useChat((s) => s.send);
  const [configOpen, setConfigOpen] = useState(false);
  // Two-step delete: clicking the trash arms confirmation for that session id;
  // a second click on 确认 actually sends deleteSession. Prevents accidental
  // loss of a persisted transcript (the host delete is irreversible).
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  // Theme priority: the user's explicit toggle wins (persisted); otherwise
  // follow the editor color theme pushed by the host; default light.
  const [manual, setManual] = useState<"light" | "dark" | null>(
    () => (localStorage.getItem("iflow-theme") as "light" | "dark" | null) ?? null,
  );
  const dark = manual ? manual === "dark" : editorTheme !== null ? editorTheme === "dark" : false;
  const firstThemeRun = useRef(true);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    if (manual) localStorage.setItem("iflow-theme", manual);
    // Smoothly animate the theme switch (colors only). Skip the initial mount
    // so the first paint doesn't flash a transition from the default theme.
    if (firstThemeRun.current) {
      firstThemeRun.current = false;
      return;
    }
    const root = document.documentElement;
    root.classList.add("theme-anim");
    const id = window.setTimeout(() => root.classList.remove("theme-anim"), 320);
    return () => window.clearTimeout(id);
  }, [dark, manual]);

  // Auth card opened: refresh the profile list the same way the header
  // dropdown does, so the card never shows a stale snapshot either.
  useEffect(() => {
    if (configOpen) send({ type: "refreshAuth" });
  }, [configOpen, send]);

  // P1-3: screen-reader status announcements. The aria-live region re-announces
  // only when this string changes, so idle re-renders stay silent.
  // NOTE: must stay ABOVE the splash early-return below — a hook after that
  // return would change the hook count between the first render (state null)
  // and the snapshot render, which React rejects with error #310.
  const liveMessage = useMemo(() => {
    if (!state) return "";
    if (state.pendingApproval) return t("需要审批工具调用");
    if (state.pendingPlanExit) return t("需要确认退出计划模式");
    if (state.pendingQuestions) return t("有待回答问题需要回答");
    if (state.status === "connecting") return t("正在连接 iFlow…");
    if (state.status === "streaming") return t("正在生成回复…");
    if (state.status === "idle") {
      if (state.errorMessage) return state.errorMessage;
      if (state.stopReason === "cancelled") return t("已停止生成");
      return t("已就绪");
    }
    return "";
  }, [state?.status, state?.errorMessage, state?.stopReason, state?.pendingApproval, state?.pendingPlanExit, state?.pendingQuestions]);

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
      {/* P1-3: visually-hidden live region for screen-reader status announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>
      {/* header */}
      <header className="acrylic relative z-10 shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 shadow-btn ring-1 ring-primary/25">
            <img src={logo} alt="" className="size-[18px]" />
            {/* top-edge highlight: the logo tile reads as a polished gem */}
            <span className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-lg bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          </div>
          <div className="leading-tight">
            <h1 className="text-[13px] font-extrabold tracking-tight">{t("心流·驭光")}</h1>
            {!isEnglishLocale() && (
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                iFlow Harness
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
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
              disabled={locked}
              onOpenChange={(o) => {
                if (o) send({ type: "refreshAuth" });
              }}
              trigger={(open) => (
                <button
                  className={`${BTN_ICON}${state.auth.authenticated ? "" : " text-warning"}`}
                  title={t("API 凭据配置")}
                  aria-label={t("API 凭据配置")}
                  disabled={locked}
                >
                  <Settings2 className="size-4" />
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
                      role="menuitem"
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
              disabled={locked}
              trigger={(open) => (
                <button
                  className={`card-lift press flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2 py-1 text-left text-[11px] shadow-card hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 ${
                    open ? "bg-surface-2 ring-1 ring-primary/30" : ""
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
                  <div className="px-2 pb-1.5">
                    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-editor/60 px-2 py-1 transition-colors focus-within:border-primary/50">
                      <Search className="size-3 shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        value={sessionQuery}
                        onChange={(e) => setSessionQuery(e.target.value)}
                        placeholder={t("搜索会话…")}
                        className="w-full bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70"
                      />
                    </div>
                  </div>
                  {state.activeSessionId &&
                    !state.sessions.some((s) => s.id === state.activeSessionId) && (
                      <button
                        role="menuitem"
                        onClick={close}
                        className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-foreground hover:bg-accent/60"
                      >
                        {t("当前会话")}
                      </button>
                    )}
                  {state.sessions
                    .filter((s) => s.label.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                    .map((s) => {
                    const deletable = s.id !== state.activeSessionId && !locked;
                    return (
                      <div
                        key={s.id}
                        className="flex w-full items-center px-3 py-1.5 hover:bg-accent/60"
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
                          confirmingDelete === s.id ? (
                            <span className="flex shrink-0 items-center gap-1">
                              <button
                                className="rounded px-1 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  send({ type: "deleteSession", sessionId: s.id });
                                  setConfirmingDelete(null);
                                }}
                              >
                                {t("确认")}
                              </button>
                              <button
                                className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-surface-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmingDelete(null);
                                }}
                              >
                                {t("取消")}
                              </button>
                            </span>
                          ) : (
                            <button
                              data-variant="danger"
                              className="shrink-0 rounded p-0.5 text-[11px] text-muted-foreground opacity-60 hover:opacity-100 hover:text-destructive"
                              title={t("删除会话 {0}", s.label)}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmingDelete(s.id);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </button>
                          )
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </Dropdown>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2 py-1 text-[11px] text-muted-foreground shadow-card">
              <History className="size-3 shrink-0 text-primary" />
              <span className="truncate">{t("会话历史")}</span>
            </div>
          )}
          {state.usage && (
            <span title={t("本次会话累计 token 消耗（host 估算，非精确计费）")} className="inline-flex">
              <Chip tone="muted">
                <Coins className="size-2.5" />
                ≈ {formatTokens(state.usage.totalTokens)}
              </Chip>
            </span>
          )}
          {state.replaying ? (
            <Chip tone="info">
              <Loader2 className="size-2.5 animate-spin" /> {t("正在恢复历史会话…")}
            </Chip>
          ) : state.initializing ? (
            <Chip tone="primary">
              <Loader2 className="size-2.5 animate-spin" /> {t("正在创建新会话…")}
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

      {state.pendingPlanExit && <PlanExitCard pending={state.pendingPlanExit} />}

      {state.pendingQuestions && <QuestionCard pending={state.pendingQuestions} />}

      <Composer />
    </div>
  );
}