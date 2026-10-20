import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Focus,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import logo from "./assets/iflow.svg";
import { useChat } from "./store";
import { t } from "./i18n";
import { copyText } from "./components/Markdown";
import { BTN, BTN_ICON, Chip, ConfirmDialog, Dropdown } from "./components/ui";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";
import { PlanExitCard } from "./components/PlanExitCard";
import { QuestionCard } from "./components/QuestionCard";
import { ProfileSwitchCard } from "./components/ProfileSwitchCard";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { MemoryQuickAdd } from "./components/MemoryQuickAdd";
import { MemoryReviewDialog } from "./components/MemoryReviewDialog";
import type { AgentStatus, ErrorAdviceUi, MemoryCandidateUi, SessionSummaryUi } from "../../shared/messages";
import { isPlanMode } from "../../shared/messages";
import { adjacentSessionId } from "../../shared/session-nav";

function statusChip(status: AgentStatus, compressing = false, plan = false) {
  switch (status) {
    case "connecting":
      return (
        <Chip tone="warning">
          <Loader2 className="size-2.5 animate-spin" /> {t("连接中")}
        </Chip>
      );
    // UI-audit 4.2 P0: idle shows NO chip — VSCode's status bar already carries
    // the agent state, and a permanent "ready" pill with an infinite ping was
    // pure decoration stealing attention from the transcript. Busy/error states
    // still announce themselves.
    case "idle":
      return null;
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

// UI-audit 4.2 P2: platform-conventional dates via Intl (locale follows the
// webview runtime): today "14:32", yesterday "昨天", same year "10月18日",
// older "2025年10月18日". Formatters are built once at module load.
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  // Calendar-day distance (DST-safe: rounded on a noon-anchored diff).
  const dayDiff = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  const sameYear = d.getFullYear() === now.getFullYear();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (dayDiff === 1) return t("昨天");
  if (sameYear) return dayFmt.format(d);
  return fullFmt.format(d);
}

/**
 * P1-9: the error toast used to be a dead-end scroll box — CLI errors are
 * often multi-line JSON dumps you could neither read fully nor take with
 * you. Now: collapsed to one line by default with an expand toggle (only
 * when the text is actually long), a copy button (Clipboard API with the
 * textarea fallback from Markdown.tsx), plus the P0-3 retry/dismiss.
 */
function ErrorToast({
  message,
  advice,
  onOpenSettings,
  onDismiss,
}: {
  message: string;
  /** 3.6: structured next-step guidance from the host (null → message only). */
  advice: ErrorAdviceUi | null;
  onOpenSettings: (tab: "api" | "runtime") => void;
  onDismiss: () => void;
}) {
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
    <div className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center px-3">
      <div className="stream-in pointer-events-auto flex max-h-40 w-full max-w-[92%] items-start gap-2 rounded-2xl border border-destructive/40 bg-destructive/15 px-4 py-1.5 text-ui-label text-destructive shadow-card backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <div
            className={`select-text break-words ${expanded ? "max-h-28 overflow-y-auto" : "line-clamp-1"}`}
            title={isLong && !expanded ? message : undefined}
          >
            {message}
          </div>
          {isLong && (
            <button
              className="press mt-0.5 rounded text-ui-caption font-medium text-destructive/90 underline decoration-destructive/30 underline-offset-2 transition-opacity hover:opacity-100"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("收起") : t("展开")}
            </button>
          )}
          {advice && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-caption text-destructive/90">
              <span className="select-text">{t(advice.hint)}</span>
              {advice.openSettingsTab && (
                <button
                  className="press rounded font-semibold underline decoration-destructive/30 underline-offset-2 hover:opacity-100"
                  onClick={() => onOpenSettings(advice.openSettingsTab!)}
                >
                  {advice.openSettingsTab === "api" ? t("打开 API 设置") : t("打开运行时设置")}
                </button>
              )}
            </div>
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
          className="press shrink-0 rounded-md border border-destructive/40 px-1.5 py-0.5 text-ui-caption font-semibold transition-opacity hover:opacity-100"
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
  const errorAdvice = useChat((s) => s.state?.errorAdvice ?? null);
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
  // First-run wizard: auto-opens once per workspace. The host persists the
  // skipped/completed flag (auth.onboardingDismissed), so a reload never
  // nags again; the unauthenticated banner can reopen it deliberately.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const onboardingAutoOpened = useRef(false);
  useEffect(() => {
    if (onboardingAutoOpened.current || !auth || settingsTab !== null) return;
    if (auth.needsSetup && auth.saved === null && !auth.onboardingDismissed) {
      onboardingAutoOpened.current = true;
      setOnboardingOpen(true);
    }
  }, [auth, settingsTab]);
  const memoryDraft = useChat((s) => s.memoryDraftRequest);
  const clearMemoryDraft = useChat((s) => s.clearMemoryDraft);
  const [memoryReview, setMemoryReview] = useState<{
    sessionId: string | null;
    candidates: MemoryCandidateUi[];
  } | null>(null);
  // Delete keeps a modal confirm (the host delete is irreversible); the armed
  // session is held here so the dialog can render its label.
  const [confirmingDelete, setConfirmingDelete] = useState<SessionSummaryUi | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  // Inline rename: the id being edited and its draft label. Kept in App so the
  // dropdown's close callback can drop a half-typed name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // UI-audit 4.2: session-menu progressive disclosure. `expandedRowId` is the
  // row whose ⋯ action list is currently shown (click ⋯ again to collapse);
  // `searchExpanded` reveals the search input after its icon was clicked —
  // small lists (≤8 sessions) keep the search compact. Both reset on close.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [searchExpanded, setSearchExpanded] = useState(false);
  // M4 P1-8: archived sessions live in a collapsed second section — they are
  // kept out of the default results until the user opens the section.
  const [showArchived, setShowArchived] = useState(false);
  // Theme priority: the synced `iflow.theme` setting wins; "auto" follows
  // the editor color theme pushed by the host; default light.
  const themeMode = useChat((s) => s.hostSettings.theme);
  const dark = themeMode === "auto" ? (editorTheme !== null ? editorTheme === "dark" : false) : themeMode === "dark";
  const firstThemeRun = useRef(true);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
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
  }, [dark]);

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
      const msg = event.data as {
        type?: string;
        draft?: unknown;
        sessionId?: string | null;
        candidates?: MemoryCandidateUi[];
      };
      if (msg?.type === "approvalPolicy" && msg.draft) setSettingsTab("policy");
      if (msg?.type === "memoryCandidates" && Array.isArray(msg.candidates) && msg.candidates.length > 0) {
        setMemoryReview({ sessionId: msg.sessionId ?? null, candidates: msg.candidates });
      }
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
  // Shared gating for the header actions and the Alt+←/→ / Alt+N shortcuts:
  // switching session / mode / model / profile mid-turn would desync the
  // in-flight ACP request, and a profile switch is itself an optimistic lock.
  const busy = status === "streaming" || replaying || initializing;
  const switching = pending !== null;
  const locked = busy || switching;

  // M1 P1-3: Ctrl/Cmd+Alt+F toggles Focus view from anywhere (also while the
  // composer has focus — Alt+F is not a text-editing chord). Declared BEFORE
  // the splash early-return (hook-count stability, see the liveMessage note).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !e.altKey || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
      if (document.querySelector(".auth-backdrop")) return;
      e.preventDefault();
      toggleFocusMode();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleFocusMode]);

  // Session navigation: Alt+←/→ cycles the non-archived history list,
  // Alt+N starts a new session. Editable targets are skipped (Alt+Arrow is
  // word navigation in a textarea; Alt+N can produce a character on some
  // layouts), and overlays/busy states own the keys while they are open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (locked || status === null || status === "connecting" || settingsTab !== null || onboardingOpen) return;
      // ConfirmDialog / memory dialogs / profile-switch all mount ModalShell;
      // never change sessions behind an open modal.
      if (document.querySelector(".auth-backdrop")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const next = adjacentSessionId(sessions, activeSessionId, e.key === "ArrowLeft" ? -1 : 1);
        if (!next || next === activeSessionId) return;
        e.preventDefault();
        send({ type: "loadSession", sessionId: next });
        return;
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        send({ type: "newSession" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessions, activeSessionId, locked, status, settingsTab, onboardingOpen, send]);

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

  if ((status === null || status === "connecting") && !onboardingOpen) {
    // Full-screen brand splash until the session is fully initialized.
    // UI-audit 4.1: static logo + title + thin progress line (fill tracks
    // elapsed against a 60s budget, replacing the infinite shimmer); the
    // elapsed seconds only appear after 3s, and the restart escape only
    // grows past a 30s patience threshold (the host's handshake timeout
    // eventually markErrors, but that can take 2 minutes — the user
    // shouldn't have to stare at a spinner).
    const impatient = connectingElapsed >= 30;
    return (
      <div className="splash">
        <img src={logo} alt="" className="splash-logo" />
        <div className="splash-title">{t("心流·驭光")}</div>
        <div className="splash-bar">
          <div
            className="splash-bar-fill"
            style={{ width: `${Math.min(connectingElapsed / 60, 1) * 100}%` }}
          />
        </div>
        <div
          className="splash-hint"
          title={t("首次启动或配置了多个 MCP server 时较久")}
        >
          {t("正在启动 iFlow…")}
          {status === "connecting" && connectingElapsed >= 3 && (
            <span className="ml-1 font-mono tabular-nums opacity-70">{connectingElapsed}s</span>
          )}
        </div>
        {impatient && (
          <div className="splash-hint mt-2 flex flex-col items-center gap-2">
            <span>{t("等待时间偏长：可能是 MCP 服务器连接缓慢或网络不可达")}</span>
            <button
              className="press rounded-lg border border-border bg-surface/80 px-3 py-1 text-ui-caption font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
              onClick={() => send({ type: "restartCli" })}
            >
              {t("重启 CLI")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Unified settings modal: opened explicitly from the gear / wizard. First-run
  // credential setup lives in OnboardingWizard, so this modal is always
  // dismissible (a user who skipped onboarding can still browse and close it).
  const settingsOpen = settingsTab !== null;
  const settingsTabValue: SettingsTab = settingsTab ?? "api";
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
              menuClass="w-[20rem] max-w-[calc(100vw_-_24px)] max-h-[20rem] flex flex-col"
              wrapperClass="min-w-0 flex-1"
              disabled={locked}
              onOpenChange={(open) => {
                if (!open) {
                  setRenamingId(null);
                  setExpandedRowId(null);
                  setSearchExpanded(false);
                }
              }}
              trigger={(open) => (
                <button
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className={`press flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm px-2 text-left text-ui-label font-medium hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40 ${
                    open ? "bg-surface-2" : ""
                  }`}
                  title={t("历史会话（选择后恢复该会话上下文）")}
                  disabled={locked}
                >
                  <span className="truncate text-foreground">{sessionLabel}</span>
                  <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-60" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="shrink-0 px-3 py-1.5 text-ui-caption uppercase tracking-wider text-muted-foreground">
                    {t("会话历史")}
                  </div>
                  {(() => {
                    if (sessions.length <= 8 && !searchExpanded)
                      return (
                        <div className="shrink-0 px-2 pb-1.5 flex items-center">
                          <button
                            role="menuitem"
                            aria-label={t("搜索会话")}
                            title={t("搜索会话")}
                            className="press rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                            onClick={() => setSearchExpanded(true)}
                          >
                            <Search className="size-3.5" />
                          </button>
                        </div>
                      );
                    return (
                      <div className="shrink-0 px-2 pb-2">
                        <div className="flex items-center gap-3 rounded-md border border-border bg-editor/60 px-3 py-1.5 transition-colors duration-200 focus-within:border-primary/40 focus-within:shadow-focus-soft">
                          <Search className="size-3.5 shrink-0 text-muted-foreground" />
                          <input
                            autoFocus
                            value={sessionQuery}
                            onChange={(e) => setSessionQuery(e.target.value)}
                            placeholder={t("搜索会话…")}
                            className="w-full min-w-0 bg-transparent text-ui-body text-foreground outline-none placeholder:text-muted-foreground/80"
                          />
                        </div>
                      </div>
                    );
                  })()}
                  {activeSessionId &&
                    !sessions.some((s) => s.id === activeSessionId) && (
                      <button
                        role="menuitem"
                        onClick={close}
                        className="flex w-full shrink-0 items-center px-3 py-1.5 text-left text-ui-label text-foreground hover:bg-accent/60"
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
                      if (renamingId === s.id) {
                        const commit = () => {
                          const label = renameDraft.trim();
                          if (label) send({ type: "renameSession", sessionId: s.id, label });
                          setRenamingId(null);
                        };
                        return (
                          <div key={s.id} className="flex w-full items-center gap-1 px-3 py-1.5">
                            <input
                              autoFocus
                              value={renameDraft}
                              aria-label={t("会话名称")}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commit();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setRenamingId(null);
                                }
                              }}
                              className="min-w-0 flex-1 rounded-md border border-border bg-editor px-2 py-1 text-ui-body text-foreground outline-none transition-colors focus:border-primary/50"
                            />
                            <button
                              role="menuitem"
                              className="press shrink-0 rounded-md p-1.5 text-primary transition-colors hover:bg-accent/60"
                              title={t("保存")}
                              aria-label={t("保存")}
                              onClick={commit}
                            >
                              <Check className="size-3.5" />
                            </button>
                            <button
                              role="menuitem"
                              className="press shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                              title={t("取消")}
                              aria-label={t("取消")}
                              onClick={() => setRenamingId(null)}
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div key={s.id} className="group flex w-full shrink-0 flex-col rounded-md hover:bg-accent/60">
                          <div className="flex w-full items-center gap-1 px-3 py-1.5">
                            <button
                              role="menuitem"
                              className="flex min-w-0 flex-1 flex-col items-start text-left"
                              onClick={() => {
                                send({ type: "loadSession", sessionId: s.id });
                                close();
                              }}
                            >
                              <span className="flex w-full items-center gap-2 text-ui-body text-foreground">
                                {!!s.pinned && <Pin className="size-3.5 shrink-0 text-primary/80" />}
                                <span className="truncate">{s.label}</span>
                                {s.id === activeSessionId && (
                                  <Check className="ml-auto size-3.5 shrink-0 text-primary" />
                                )}
                              </span>
                              <span className="font-mono text-ui-caption text-muted-foreground">
                                {formatSessionTime(s.updatedAt)}
                              </span>
                            </button>
                            {expandedRowId === s.id ? null : (
                              <button
                                role="menuitem"
                                aria-label={t("会话操作")}
                                title={t("会话操作")}
                                className="press shrink-0 rounded-md p-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                                onClick={() => setExpandedRowId(s.id)}
                              >
                                <Ellipsis className="size-3.5" />
                              </button>
                            )}
                          </div>
                          {expandedRowId === s.id && (
                            <div className="flex w-full items-center gap-1 px-3 py-1 flex-wrap">
                              <button
                                role="menuitem"
                                className="press shrink-0 rounded-md px-2 py-1 text-ui-caption text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                                title={t("重命名")}
                                onClick={() => {
                                  setRenamingId(s.id);
                                  setRenameDraft(s.label);
                                }}
                              >
                                {t("重命名")}
                              </button>
                              <button
                                role="menuitem"
                                className="press shrink-0 rounded-md px-2 py-1 text-ui-caption text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                                title={s.pinned ? t("取消置顶") : t("置顶")}
                                onClick={() => flag(!s.pinned, !!s.archived)}
                              >
                                {s.pinned ? t("取消置顶") : t("置顶")}
                              </button>
                              <button
                                role="menuitem"
                                className="press shrink-0 rounded-md px-2 py-1 text-ui-caption text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                                title={s.archived ? t("取消归档") : t("归档")}
                                onClick={() => flag(!!s.pinned, !s.archived)}
                              >
                                {s.archived ? t("取消归档") : t("归档")}
                              </button>
                              {deletable && (
                                <button
                                  role="menuitem"
                                  data-variant="danger"
                                  className="press shrink-0 rounded-md px-2 py-1 text-ui-caption text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                  title={t("删除会话 {0}", s.label)}
                                  onClick={() => {
                                    close();
                                    setConfirmingDelete(s);
                                  }}
                                >
                                  {t("删除会话")}
                                </button>
                              )}
                              <button
                                role="menuitem"
                                aria-label={t("会话操作")}
                                title={t("会话操作")}
                                className="press shrink-0 rounded-md p-1.5 opacity-60 transition-opacity text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                                onClick={() => setExpandedRowId(null)}
                              >
                                <Ellipsis className="size-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    };
                    return (
                      <>
                        {activeList.map(renderRow)}
                        {archivedList.length > 0 && (
                          <button
                            className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-ui-caption uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
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
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm px-2 text-ui-label font-medium text-muted-foreground">
              {t("会话历史")}
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
            statusChip(status ?? "connecting", compressing, isPlanMode(modes))
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
              aria-label={t("新会话")}
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
          dismissible
          busy={locked}
          auth={auth}
        />
      )}

      {onboardingOpen && auth && (
        <OnboardingWizard
          auth={auth}
          onClose={() => setOnboardingOpen(false)}
          onOpenSettings={(tab) => setSettingsTab(tab)}
        />
      )}

      {/* Profile-switch choice dialog: centered modal over everything (the
          switch can be started from the header dropdown or the auth card's
          profile list, so it must stack above both — same fixed z-40 layer,
          later in the DOM wins). */}
      {memoryDraft && (
        <MemoryQuickAdd
          request={memoryDraft}
          onClose={() => clearMemoryDraft(memoryDraft.seq)}
        />
      )}

      {memoryReview && (
        <MemoryReviewDialog
          key={memoryReview.candidates.map((candidate) => candidate.id).join("|")}
          sessionId={memoryReview.sessionId}
          candidates={memoryReview.candidates}
          onClose={() => setMemoryReview(null)}
        />
      )}

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
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border acrylic-pop px-2.5 py-1 text-ui-caption text-muted-foreground shadow-card">
              <Focus className="size-3 shrink-0" />
              {t("Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）")}
            </div>
          </div>
        )}
        {errorMessage && dismissedError !== errorMessage && (
          <ErrorToast
            message={errorMessage}
            advice={errorAdvice}
            onOpenSettings={(tab) => setSettingsTab(tab)}
            onDismiss={() => setDismissedError(errorMessage)}
          />
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

      {auth?.needsSetup && !onboardingOpen && (
        <div className="mx-3 mb-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-caption leading-relaxed text-warning">
          <span className="min-w-0 flex-1">{t("尚未配置 API 凭据，无法开始对话。")}</span>
          <button className={BTN} onClick={() => setSettingsTab("api")}>
            {t("配置")}
          </button>
          <button className={BTN} onClick={() => setOnboardingOpen(true)}>
            {t("重新运行引导")}
          </button>
        </div>
      )}

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