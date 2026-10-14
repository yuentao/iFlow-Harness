import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Focus,
  History,
  Loader2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import logo from "./assets/iflow.svg";
import { useChat } from "./store";
import { isEnglishLocale, t } from "./i18n";
import { copyText } from "./components/Markdown";
import { BTN_ICON, Chip, ConfirmDialog, Dropdown } from "./components/ui";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";
import { PlanExitCard } from "./components/PlanExitCard";
import { QuestionCard } from "./components/QuestionCard";
import { ProfileSwitchCard } from "./components/ProfileSwitchCard";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import type { AgentStatus, SessionSummaryUi } from "../../shared/messages";
import { isPlanMode } from "../../shared/messages";

function statusChip(status: AgentStatus, compressing = false, plan = false) {
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
          <Loader2 className="size-2.5 animate-spin" />{" "}
          {compressing ? t("正在压缩") : plan ? t("正在规划") : t("生成中")}
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

/**
 * P1-9: the error toast used to be a dead-end scroll box — CLI errors are
 * often multi-line JSON dumps you could neither read fully nor take with
 * you. Now: collapsed to one line by default with an expand toggle (only
 * when the text is actually long), a copy button (Clipboard API with the
 * textarea fallback from Markdown.tsx), plus the P0-3 retry/dismiss.
 */
function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const send = useChat((s) => s.send);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isLong = message.length > 90 || message.includes("\n");
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2.5 z-[5] flex justify-center px-3">
      <div className="stream-in pointer-events-auto flex max-h-40 w-full max-w-[92%] items-start gap-2 rounded-2xl border border-destructive/40 bg-destructive/15 px-3.5 py-1.5 text-[12px] text-destructive shadow-card backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <div
            className={`select-text break-words ${expanded ? "max-h-28 overflow-y-auto" : "line-clamp-1"}`}
            title={isLong && !expanded ? message : undefined}
          >
            {message}
          </div>
          {isLong && (
            <button
              className="press mt-0.5 rounded text-[11px] font-medium text-destructive/90 underline decoration-destructive/30 underline-offset-2 transition-opacity hover:opacity-100"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("收起") : t("展开")}
            </button>
          )}
        </div>
        <button
          className="press shrink-0 rounded p-0.5 opacity-80 transition-opacity hover:opacity-100"
          title={copied ? t("已复制") : t("复制错误信息")}
          aria-label={t("复制错误信息")}
          onClick={() => {
            void copyText(message).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
        <button
          className="press shrink-0 rounded-md border border-destructive/40 px-1.5 py-0.5 text-[11px] font-semibold transition-opacity hover:opacity-100"
          title={t("重启 CLI 并重试（会话自动恢复）")}
          onClick={() => send({ type: "restartCli" })}
        >
          <RefreshCw className="mr-0.5 inline size-2.5 align-[-1px]" />
          {t("重试")}
        </button>
        <button
          className="press shrink-0 rounded p-0.5 opacity-80 transition-opacity hover:opacity-100"
          title={t("关闭")}
          aria-label={t("关闭")}
          onClick={onDismiss}
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}

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
  const compressing = useChat((s) => s.state?.compressing ?? false);
  const modes = useChat((s) => s.state?.modes ?? null);
  const pendingApproval = useChat((s) => s.state?.pendingApproval ?? null);
  const pendingPlanExit = useChat((s) => s.state?.pendingPlanExit ?? null);
  const pendingQuestions = useChat((s) => s.state?.pendingQuestions ?? null);
  const pendingProfileSwitch = useChat((s) => s.state?.pendingProfileSwitch ?? null);
  // True once the transcript has scrolled under the header — drives the
  // header's bottom shadow (no shadow while the top of the list is visible).
  const headerScrolled = useChat((s) => s.headerScrolled);
  const editorTheme = useChat((s) => s.editorTheme);
  const pending = useChat((s) => s.pending);
  const send = useChat((s) => s.send);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // Delete keeps a modal confirm (the host delete is irreversible); the armed
  // session is held here so the dialog can render its label.
  const [confirmingDelete, setConfirmingDelete] = useState<SessionSummaryUi | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  // M4 P1-8: archived sessions live in a collapsed second section — they are
  // kept out of the default results until the user opens the section.
  const [showArchived, setShowArchived] = useState(false);
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

  // Settings modal opened: refresh the profile list the same way the header
  // dropdown does, so the modal never shows a stale snapshot either.
  useEffect(() => {
    if (settingsTab) send({ type: "refreshAuth" });
  }, [settingsTab, send]);

  // M4 P1-1 handoff: an approval card's 「始终允许」 makes the host derive a
  // rule draft and push `approvalPolicy` — jump the settings modal to the
  // policy tab so the user can name & save it (the section's own listener
  // loads the draft into the editor; here we only route visibility).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type?: string; draft?: unknown };
      if (msg?.type === "approvalPolicy" && msg.draft) setSettingsTab("policy");
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

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
    if (pendingProfileSwitch) return t("等待选择切换 API 配置的会话处理方式");
    if (status === "connecting") return t("正在连接 iFlow…");
    if (status === "streaming")
      return compressing
        ? t("正在压缩上下文…")
        : isPlanMode(modes)
          ? t("正在规划…")
          : t("正在生成回复…");
    if (status === "idle") {
      if (errorMessage) return errorMessage;
      if (stopReason === "cancelled") return t("已停止生成");
      return t("已就绪");
    }
    return "";
  }, [status, errorMessage, stopReason, pendingApproval, pendingPlanExit, pendingQuestions, pendingProfileSwitch, compressing, modes]);

  // P0-3: connecting elapsed timer. A wedged handshake used to strand the
  // splash with no feedback and no escape hatch; the live seconds plus a
  // patience-threshold restart affordance give the user both. The hook sits
  // BEFORE the splash early-return (hook-count stability, see liveMessage).
  const connectingSince = useRef<number | null>(null);
  const [connectingElapsed, setConnectingElapsed] = useState(0);
  useEffect(() => {
    if (status !== "connecting") {
      connectingSince.current = null;
      setConnectingElapsed(0);
      return;
    }
    if (connectingSince.current === null) connectingSince.current = Date.now();
    const tick = () =>
      setConnectingElapsed(Math.max(0, Math.floor((Date.now() - (connectingSince.current ?? Date.now())) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [status]);

  // The error toast is host-owned (errorMessage rides the snapshot); a local
  // dismiss hides it until a DIFFERENT error arrives.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const focusMode = useChat((s) => s.focusMode);
  const toggleFocusMode = useChat((s) => s.toggleFocusMode);

  // M1 P1-3: Ctrl/Cmd+Alt+F toggles Focus view from anywhere (also while the
  // composer has focus — Alt+F is not a text-editing chord). Declared BEFORE
  // the splash early-return (hook-count stability, see the liveMessage note).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !e.altKey || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
      e.preventDefault();
      toggleFocusMode();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleFocusMode]);

  // P2-15: the activation ring alone went unnoticed (tooltips are mouse-only,
  // a11y audit #15). Each time Focus view turns on, a pill announces the mode
  // and its exit shortcut at the top of the transcript, auto-retiring after
  // 3s — discoverability without a permanent chrome element.
  const [focusHint, setFocusHint] = useState(false);
  useEffect(() => {
    if (!focusMode) return;
    setFocusHint(true);
    const id = window.setTimeout(() => setFocusHint(false), 3000);
    return () => window.clearTimeout(id);
  }, [focusMode]);

  if (status === null || status === "connecting") {
    // Full-screen brand splash until the session is fully initialized.
    // P0-3: a live elapsed counter turns a silent hang into a diagnosable
    // wait, and past the patience threshold the splash grows its own restart
    // escape (the host's handshake timeout eventually markErrors, but that
    // can take 2 minutes — the user shouldn't have to stare at a spinner).
    const impatient = connectingElapsed >= 45;
    return (
      <div className="splash">
        <img src={logo} alt="" className="splash-logo" />
        <div className="splash-title">{t("心流·驭光")}</div>
        {!isEnglishLocale() && <div className="splash-sub">iFlow Harness</div>}
        <div className="splash-bar" />
        <div className="splash-hint">
          {t("正在启动 iFlow…（首次启动或配置了多个 MCP server 时较久）")}
          {status === "connecting" && (
            <span className="ml-1 font-mono tabular-nums opacity-70">{connectingElapsed}s</span>
          )}
        </div>
        {impatient && (
          <div className="splash-hint mt-2 flex flex-col items-center gap-2">
            <span>{t("等待时间偏长：可能是 MCP 服务器连接缓慢或网络不可达")}</span>
            <button
              className="press rounded-lg border border-border bg-surface/80 px-3 py-1 text-[11.5px] font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
              onClick={() => send({ type: "restartCli" })}
            >
              {t("重启 CLI")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Unified settings modal: open when a tab is selected — or force-opened on
  // the API tab while unauthenticated (credentials are mandatory; the modal
  // stays non-dismissible until they're set, same rule as the old setup card).
  const settingsOpen = settingsTab !== null || (auth?.needsSetup ?? false);
  const settingsTabValue: SettingsTab = settingsTab ?? "api";
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
                  aria-haspopup="menu"
                  aria-expanded={open}
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
                  <div className="shrink-0 px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
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
                        className="w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/80"
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
                  {(() => {
                    const q = sessionQuery.trim().toLowerCase();
                    const matches = (s: SessionSummaryUi) => s.label.toLowerCase().includes(q);
                    const activeList = sessions.filter((s) => !s.archived && matches(s));
                    const archivedList = sessions.filter((s) => s.archived && matches(s));
                    // M4 P1-8: one row renderer for both sections. Pin/archive
                    // toggle via setSessionFlags (index-only, safe mid-stream);
                    // delete keeps its two-step confirm.
                    const renderRow = (s: SessionSummaryUi) => {
                      const deletable = s.id !== activeSessionId && !locked;
                      const flag = (pinned: boolean, archived: boolean) =>
                        send({ type: "setSessionFlags", sessionId: s.id, pinned, archived });
                      return (
                        <div key={s.id} className="flex w-full items-center px-3 py-1.5 hover:bg-accent/60">
                          <button
                            role="menuitem"
                            className="flex min-w-0 flex-1 flex-col items-start text-left"
                            onClick={() => {
                              send({ type: "loadSession", sessionId: s.id });
                              close();
                            }}
                          >
                            <span className="flex w-full items-center gap-2 text-[12px] text-foreground">
                              {!!s.pinned && <Pin className="size-3 shrink-0 text-primary/80" />}
                              <span className="truncate">{s.label}</span>
                              {s.id === activeSessionId && (
                                <Check className="ml-auto size-3 shrink-0 text-primary" />
                              )}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {formatSessionTime(s.updatedAt)}
                            </span>
                          </button>
                          <button
                            role="menuitem"
                            className="shrink-0 p-0.5 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground"
                            title={s.pinned ? t("取消置顶") : t("置顶")}
                            onClick={() => flag(!s.pinned, !!s.archived)}
                          >
                            {s.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                          </button>
                          <button
                            role="menuitem"
                            className="shrink-0 p-0.5 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground"
                            title={s.archived ? t("取消归档") : t("归档")}
                            onClick={() => flag(!!s.pinned, !s.archived)}
                          >
                            {s.archived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
                          </button>
                          {deletable && (
                            <button
                              role="menuitem"
                              data-variant="danger"
                              className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-60 transition-colors hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                              title={t("删除会话 {0}", s.label)}
                              onClick={() => {
                                close();
                                setConfirmingDelete(s);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </button>
                          )}
                        </div>
                      );
                    };
                    return (
                      <>
                        {activeList.map(renderRow)}
                        {archivedList.length > 0 && (
                          <button
                            className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
                            onClick={() => setShowArchived((v) => !v)}
                          >
                            {showArchived ? (
                              <ChevronDown className="size-3" />
                            ) : (
                              <ChevronRight className="size-3" />
                            )}
                            {t("已归档（{0}）", archivedList.length)}
                          </button>
                        )}
                        {showArchived && archivedList.map(renderRow)}
                      </>
                    );
                  })()}
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
            statusChip(status, compressing, isPlanMode(modes))
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className={`${BTN_ICON}${focusMode ? " bg-accent/60 text-primary ring-1 ring-primary/30" : ""}`}
              title={focusMode ? t("退出 Focus 视图（Ctrl+Alt+F）") : t("Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）")}
              aria-label={t("Focus 视图")}
              aria-pressed={focusMode}
              onClick={toggleFocusMode}
            >
              <Focus className="size-4" />
            </button>
            <button
              className={BTN_ICON}
              title={t("新会话")}
              disabled={locked}
              onClick={() => send({ type: "newSession" })}
            >
              <Plus className="size-4" />
            </button>
            {/* Settings hub: profiles & credentials, MCP servers, approval
                policies. The gear used to open a profile quick-switcher whose
                list duplicated (and behaved differently from) the auth card's
                — now it opens the unified settings modal directly. Never
                disabled: browsing settings mid-turn is safe, and every
                mutating control inside gates itself on `busy`. */}
            <button
              className={`${BTN_ICON}${auth?.authenticated ? "" : " text-warning"}`}
              title={t("设置")}
              aria-label={t("设置")}
              onClick={() => setSettingsTab("api")}
            >
              <Settings2 className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {settingsOpen && auth && (
        <SettingsModal
          tab={settingsTabValue}
          onTabChange={setSettingsTab}
          onDismiss={() => setSettingsTab(null)}
          dismissible={!auth.needsSetup}
          busy={locked}
          auth={auth}
          dark={dark}
          onThemeChange={setManual}
        />
      )}

      {/* Profile-switch choice dialog: centered modal over everything (the
          switch can be started from the header dropdown or the auth card's
          profile list, so it must stack above both — same fixed z-40 layer,
          later in the DOM wins). */}
      {pendingProfileSwitch && <ProfileSwitchCard pending={pendingProfileSwitch} />}

      {/* Pending-action cards (approval / plan-exit / question) float OVER the
          transcript instead of taking a row in the flex column — a shrink-0
          sibling here would squeeze the message list every time a card mounts.
          The wrapper is the relative anchor (same box MessageList fills); the
          overlay is bottom-anchored above the Composer. pointer-events-none on
          the shell keeps the empty side gutters transparent to scroll/click;
          each card re-enables pointer events on itself. */}
      <div ref={transcriptWrapRef} className="relative flex min-h-0 flex-1 flex-col">
        <MessageList />
        {focusMode && focusHint && (
          <div className="pointer-events-none absolute inset-x-0 top-1 z-30 flex justify-center">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border acrylic-pop px-2.5 py-1 text-[11px] text-muted-foreground shadow-card">
              <Focus className="size-3 shrink-0" />
              {t("Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）")}
            </div>
          </div>
        )}
        {errorMessage && dismissedError !== errorMessage && (
          <ErrorToast message={errorMessage} onDismiss={() => setDismissedError(errorMessage)} />
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

      {confirmingDelete && (
        <ConfirmDialog
          title={t("删除会话")}
          message={t("确定删除会话「{0}」吗？此操作不可撤销。", confirmingDelete.label)}
          onConfirm={() => {
            send({ type: "deleteSession", sessionId: confirmingDelete.id });
            setConfirmingDelete(null);
          }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  );
}