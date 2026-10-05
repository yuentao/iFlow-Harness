import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  History,
  Loader2,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
} from "lucide-react";
import logo from "./assets/iflow.svg";
import { useChat } from "./store";
import { isEnglishLocale, t } from "./i18n";
import { Chip, Dropdown, InlineConfirm } from "./components/ui";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";
import { PlanExitCard } from "./components/PlanExitCard";
import { QuestionCard } from "./components/QuestionCard";
import { AuthCard } from "./components/AuthCard";
import { McpCard } from "./components/McpCard";
import type { AgentStatus, SessionSummaryUi } from "../../shared/messages";

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

/** Stable empty fallbacks — a fresh `[]` per selector call would re-render on
 * every store change (zustand compares with Object.is). */
const EMPTY_SESSIONS: SessionSummaryUi[] = [];

export function App() {
  // P2-1 selector split: App previously subscribed to the whole state object,
  // re-rendering the header + dropdowns + cards on every blockPatch (up to
  // 12.5/s while streaming). Each field below is a primitive or a reference
  // carried over by the patch's metadata spread — only MessageList (which
  // subscribes to `state` itself) re-renders while blocks stream.
  const status = useChat((s) => s.state?.status ?? null);
  const errorMessage = useChat((s) => s.state?.errorMessage ?? null);
  const stopReason = useChat((s) => s.state?.stopReason ?? null);
  const auth = useChat((s) => s.state?.auth ?? null);
  const sessions = useChat((s) => s.state?.sessions ?? EMPTY_SESSIONS);
  const activeSessionId = useChat((s) => s.state?.activeSessionId ?? null);
  const replaying = useChat((s) => s.state?.replaying ?? false);
  const initializing = useChat((s) => s.state?.initializing ?? false);
  const pendingApproval = useChat((s) => s.state?.pendingApproval ?? null);
  const pendingPlanExit = useChat((s) => s.state?.pendingPlanExit ?? null);
  const pendingQuestions = useChat((s) => s.state?.pendingQuestions ?? null);
  // True once the transcript has scrolled under the header — drives the
  // header's bottom shadow (no shadow while the top of the list is visible).
  const headerScrolled = useChat((s) => s.headerScrolled);
  const editorTheme = useChat((s) => s.editorTheme);
  const pending = useChat((s) => s.pending);
  const beginPending = useChat((s) => s.beginPending);
  const send = useChat((s) => s.send);
  const [configOpen, setConfigOpen] = useState(false);
  // MCP management card (reads/writes settings.json via the host). Mutually
  // exclusive with the config card — both are centered modals.
  const [mcpOpen, setMcpOpen] = useState(false);
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

  // Pending-action cards float over the transcript (see the JSX below). Their
  // height is variable (plan editor, expanded custom answers), so a ResizeObserver
  // mirrors it into --pending-card-h on the wrapper; MessageList reads it as the
  // scroll content's bottom padding so the newest message can always be scrolled
  // clear of the card. Writing a CSS var keeps this off React's render path.
  const pendingOverlayRef = useRef<HTMLDivElement>(null);
  const transcriptWrapRef = useRef<HTMLDivElement>(null);
  const hasPendingCard = Boolean(pendingApproval || pendingPlanExit || pendingQuestions);
  useEffect(() => {
    const wrapper = transcriptWrapRef.current;
    if (!wrapper) return;
    const overlay = pendingOverlayRef.current;
    if (!overlay) {
      wrapper.style.removeProperty("--pending-card-h");
      return;
    }
    const apply = () => wrapper.style.setProperty("--pending-card-h", `${overlay.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(overlay);
    return () => ro.disconnect();
  }, [hasPendingCard]);

  // P1-3: screen-reader status announcements. The aria-live region re-announces
  // only when this string changes, so idle re-renders stay silent.
  // NOTE: must stay ABOVE the splash early-return below — a hook after that
  // return would change the hook count between the first render (state null)
  // and the snapshot render, which React rejects with error #310.
  const liveMessage = useMemo(() => {
    if (status === null) return "";
    if (pendingApproval) return t("需要审批工具调用");
    if (pendingPlanExit) return t("需要确认退出计划模式");
    if (pendingQuestions) return t("有待回答问题需要回答");
    if (status === "connecting") return t("正在连接 iFlow…");
    if (status === "streaming") return t("正在生成回复…");
    if (status === "idle") {
      if (errorMessage) return errorMessage;
      if (stopReason === "cancelled") return t("已停止生成");
      return t("已就绪");
    }
    return "";
  }, [status, errorMessage, stopReason, pendingApproval, pendingPlanExit, pendingQuestions]);

  if (status === null || status === "connecting") {
    // Full-screen brand splash until the session is fully initialized.
    return (
      <div className="splash">
        <img src={logo} alt="" className="splash-logo" />
        <div className="splash-title">{t("心流·驭光")}</div>
        {!isEnglishLocale() && <div className="splash-sub">iFlow Harness</div>}
        <div className="splash-bar" />
        <div className="splash-hint">
          {t("正在启动 iFlow …（首次启动或配置了多个 MCP server 时较久）")}
        </div>
      </div>
    );
  }

  const showAuthCard = (auth?.needsSetup ?? false) || configOpen;
  // While the agent is streaming (or an approval blocks it), or while a new
  // session / history restore is initializing, switching the session / mode /
  // model / profile would desync the in-flight ACP request.
  const busy = status === "streaming" || replaying || initializing;
  // A profile switch is in flight (optimistic lock): disable every switcher.
  const switching = pending !== null;
  const locked = busy || switching;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionLabel =
    activeSession?.label ?? (activeSessionId ? t("当前会话") : t("会话历史"));

  return (
    <div className="@container flex h-screen flex-col overflow-hidden text-foreground">
      {/* P1-3: visually-hidden live region for screen-reader status announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>
      {/* header — shadow appears only while messages scroll under it */}
      {/* z-30: above the Composer (z-20) so the header's downward-opening
          dropdowns paint over it, below .auth-backdrop (fixed z-40). */}
      <header className={`acrylic relative z-30 shrink-0 border-b border-border px-3 py-2${headerScrolled ? " header-scrolled" : ""}`}>
        {/* min-w-0 on the row + Dropdown wrapper: the flex shrink chain must
            reach the truncating label inside the trigger, or a long session
            title stretches the whole header row (seen with prompt-derived
            labels). */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* session switcher */}
          {sessions.length > 0 ? (
            <Dropdown
              menuClass="w-72 max-h-64 flex flex-col"
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
                  <div className="shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("会话历史")}
                  </div>
                  <div className="shrink-0 px-2 pb-2">
                    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-editor/60 px-3 py-2 transition-colors duration-200 focus-within:border-primary/40 focus-within:shadow-focus-soft">
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        value={sessionQuery}
                        onChange={(e) => setSessionQuery(e.target.value)}
                        placeholder={t("搜索会话…")}
                        className="w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
                      />
                    </div>
                  </div>
                  {activeSessionId &&
                    !sessions.some((s) => s.id === activeSessionId) && (
                      <button
                        role="menuitem"
                        onClick={close}
                        className="flex w-full shrink-0 items-center px-3 py-1.5 text-left text-[12px] text-foreground hover:bg-accent/60"
                      >
                        {t("当前会话")}
                      </button>
                    )}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                  {sessions
                    .filter((s) => s.label.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                    .map((s) => {
                    const deletable = s.id !== activeSessionId && !locked;
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
                            {s.id === activeSessionId && (
                              <Check className="ml-auto size-3 shrink-0 text-primary" />
                            )}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {formatSessionTime(s.updatedAt)}
                          </span>
                        </button>
                        {deletable && (
                          <InlineConfirm
                            armed={confirmingDelete === s.id}
                            onArm={() => setConfirmingDelete(s.id)}
                            onCancel={() => setConfirmingDelete(null)}
                            onConfirm={() => {
                              send({ type: "deleteSession", sessionId: s.id });
                              setConfirmingDelete(null);
                            }}
                            confirmLabel={t("确认")}
                            cancelLabel={t("取消")}
                            title={t("删除会话 {0}", s.label)}
                            className="ml-1"
                            triggerClassName="opacity-60 hover:opacity-100"
                          />
                        )}
                      </div>
                    );
                  })}
                  </div>
                </>
              )}
            </Dropdown>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2 py-1 text-[11px] text-muted-foreground shadow-card">
              <History className="size-3 shrink-0 text-primary" />
              <span className="truncate">{t("会话历史")}</span>
            </div>
          )}
          {replaying ? (
            <Chip tone="info">
              <Loader2 className="size-2.5 animate-spin" /> <span className="@max-[320px]:hidden">{t("正在恢复历史会话…")}</span>
            </Chip>
          ) : initializing ? (
            <Chip tone="primary">
              <Loader2 className="size-2.5 animate-spin" /> <span className="@max-[320px]:hidden">{t("正在创建新会话…")}</span>
            </Chip>
          ) : (
            statusChip(status)
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
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
              menuClass="w-64 max-w-[calc(100vw_-_24px)] max-h-[70vh] flex flex-col"
              disabled={locked}
              onOpenChange={(o) => {
                if (o) send({ type: "refreshAuth" });
              }}
              trigger={(open) => (
                <button
                  className={`${BTN_ICON}${auth?.authenticated ? "" : " text-warning"}`}
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
                  {(auth?.profiles.length ?? 0) > 0 && (
                    <div className="shrink-0 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("API 配置")}
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                  {(auth?.profiles ?? []).map((p) => (
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
                  </div>
                  <div className="shrink-0 border-t border-border">
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
      </header>

      {showAuthCard && !mcpOpen && (
        <AuthCard
          auth={auth!}
          editable={configOpen}
          busy={locked}
          onDismiss={() => setConfigOpen(false)}
          onOpenMcp={() => setMcpOpen(true)}
        />
      )}
      {mcpOpen && <McpCard busy={locked} onDismiss={() => setMcpOpen(false)} />}

      {/* Pending-action cards (approval / plan-exit / question) float OVER the
          transcript instead of taking a row in the flex column — a shrink-0
          sibling here would squeeze the message list every time a card mounts.
          The wrapper is the relative anchor (same box MessageList fills); the
          overlay is bottom-anchored above the Composer. pointer-events-none on
          the shell keeps the empty side gutters transparent to scroll/click;
          each card re-enables pointer events on itself. */}
      <div ref={transcriptWrapRef} className="relative flex min-h-0 flex-1 flex-col">
        <MessageList />
        {errorMessage && (
          // Error toast: floats over the transcript top instead of taking a
          // flex row, frosted (backdrop-blur) so the content behind bleeds
          // through. z-[5]: must stay BELOW the header's stacking context
          // (z-10) — at z-40 it covered the header's downward-opening config
          // dropdown. break-words + scroll cap: errorMessage() can
          // return unbounded JSON dumps (unbroken tokens) and multi-line
          // detail — without them the toast overflowed its container.
          <div className="pointer-events-none absolute inset-x-0 top-2.5 z-[5] flex justify-center px-3">
            <div className="stream-in pointer-events-auto max-h-24 max-w-[92%] select-text overflow-y-auto break-words rounded-2xl border border-destructive/40 bg-destructive/15 px-3.5 py-1.5 text-[12px] text-destructive shadow-card backdrop-blur-xl">
              {errorMessage}
            </div>
          </div>
        )}
        {(pendingApproval || pendingPlanExit || pendingQuestions) && (
          <div
            ref={pendingOverlayRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col pb-1"
          >
            {pendingApproval && <ApprovalCard approval={pendingApproval} />}
            {pendingPlanExit && <PlanExitCard pending={pendingPlanExit} />}
            {pendingQuestions && <QuestionCard pending={pendingQuestions} />}
          </div>
        )}
      </div>

      <Composer />
    </div>
  );
}