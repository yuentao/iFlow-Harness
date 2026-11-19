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
  XCircle,
} from "lucide-react";
import logo from "./assets/iflow.svg";
import { useChat } from "./store";
import { t } from "./i18n";
import { copyText } from "./components/Markdown";
import { Button, Chip, ConfirmDialog, Dropdown, ICON_INLINE, ICON_TOOLBAR, IconButton, SearchInput, TextInput } from "./components/ui";
import { MessageList } from "./components/MessageList";
import { SuperAgentBoard } from "./components/SuperAgentBoard";
import { Composer } from "./components/Composer";
import { PendingCards } from "./components/PendingCards";
import { ProfileSwitchCard } from "./components/ProfileSwitchCard";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { MemoryQuickAdd } from "./components/MemoryQuickAdd";
import { MemoryReviewDialog } from "./components/MemoryReviewDialog";
import { SuperResidueConfirmDialog } from "./components/SuperResidueConfirmDialog";
import type { AgentStatus, ErrorAdviceUi, InitializingReason, MemoryCandidateUi, SessionSummaryUi } from "../../shared/messages";
import { adjacentSessionId } from "../../shared/session-nav";
import { hasActiveSuperSession } from "../../shared/super-agent";

/**
 * Label for the `initializing` busy chip. The host reuses that lock for
 * several async flows (new session, session delete, message delete, rollback,
 * restore) — claiming 「正在创建新会话…」 for all of them was simply wrong.
 */
function initializingLabel(reason: InitializingReason | null | undefined): string {
  switch (reason) {
    case "deleteSession":
      return t("正在删除会话…");
    case "deleteMessage":
      return t("正在删除消息…");
    case "rollback":
      return t("正在回滚对话…");
    case "restore":
      return t("正在恢复会话…");
    default:
      return t("正在创建新会话…");
  }
}

function statusChip(status: AgentStatus, compressing = false) {
  switch (status) {
    case "connecting":
      return (
        <Chip tone="warning">
          <Loader2 className="size-2.5 animate-spin" /> {t("连接中")}
        </Chip>
      );
    // UI-audit 4.2 P0: idle shows NO chip — VSCode's status bar already carries
    // the agent state, and a permanent "ready" pill with an infinite ping was
    // pure decoration stealing attention from the transcript.
    // 顶栏只保留有独立信息量的状态：连接中 / 错误，以及 streaming 下本轮特有
    // 的「正在压缩」。默认的「生成中」不再占顶栏（转录底部已有浮动 pill 显示
    // 正在生成 / 正在压缩 / 正在创建新会话…，重复的信号只会在窄屏挤掉会话
    // 标题）；宿主等待子会话汇报（superWaiting）同样不渲染 chip —— 忙碌信号
    // 由子会话看板的计数承担，superWaiting 本身仍只用于禁用顶栏「新会话」按钮。
    case "idle":
      return null;
    case "streaming":
      if (compressing) {
        return (
          <Chip tone="primary">
            <Loader2 className="size-2.5 animate-spin" /> {t("正在压缩")}
          </Chip>
        );
      }
      return null;
    case "error":
      return (
        <Chip tone="danger">
          <span className="size-1.5 rounded-full bg-destructive" /> {t("出错了")}
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
 * UI-audit 4.9: the error surface belongs to the persistent-banner tier (the
 * same layer as the unauthenticated banner, right under the header). The old
 * floating overlay hid the first transcript message and packed four
 * affordances into one dense pill. Now: one line + one primary action (重试)
 * + 详情; the full dump, the copy button (P1-9) and the host advice hint
 * (3.6) ride the details panel.
 */
function ErrorBanner({
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
  // 详情 is only offered when there IS something to reveal: a long dump or
  // the host advice hint. A short message without advice has nothing to
  // expand — the copy action then stays in the action row (P1-9 keeps the
  // error text copyable in every case).
  const hasDetails = isLong || advice !== null;
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copyButton = (
    <button
      className="press inline-flex items-center gap-1 rounded underline decoration-destructive/30 underline-offset-2 transition-opacity hover:opacity-100"
      title={copied ? t("已复制") : t("复制错误信息")}
      onClick={() => {
        void copyText(message).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("已复制") : t("复制")}
    </button>
  );
  const detailButton = (
    <button
      className="press shrink-0 rounded text-ui-caption font-medium text-destructive/90 underline decoration-destructive/30 underline-offset-2 transition-opacity hover:opacity-100"
      onClick={() => setExpanded((v) => !v)}
    >
      {expanded ? t("收起") : t("详情")}
    </button>
  );
  // 重试 is the banner's ONE action — it wears the banner's own destructive
  // tone (soft destructive fill, same family as the 立即压缩 / 重试 actions on
  // the error pill), not a neutral grey chip and not the primary gradient:
  // an indigo button floating on a red banner read as an unrelated control.
  const retryButton = (
    <Button
      variant="danger-soft"
      className="shrink-0"
      icon={<RefreshCw className={ICON_INLINE} />}
      title={t("重启内核后重试，当前会话会自动恢复")}
      onClick={() => send({ type: "restartCli" })}
    >
      {t("重试")}
    </Button>
  );
  const closeButton = (
    <IconButton icon={<X className={ICON_INLINE} />} label={t("关闭")} onClick={onDismiss} />
  );
  return (
    <div className="stream-in mx-3 my-1 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/15 px-2.5 py-1.5 text-ui-caption leading-relaxed text-destructive">
      {expanded ? (
        // Expanded: the dump owns the FULL width (the action row squeezed it
        // into a 2-word column on narrow panels) and the actions move to their
        // own row underneath.
        <>
          <div className="flex w-full min-w-0 items-start gap-2">
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="select-text max-h-28 break-words overflow-y-auto">{message}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-caption text-destructive/90">
                {copyButton}
                {advice && (
                  <>
                    <span className="select-text">{t(advice.hint)}</span>
                    {advice.openSettingsTab && (
                      <button
                        className="press rounded font-semibold underline decoration-destructive/30 underline-offset-2 hover:opacity-100"
                        onClick={() => onOpenSettings(advice.openSettingsTab!)}
                      >
                        {advice.openSettingsTab === "api" ? t("打开 API 设置") : t("打开运行时设置")}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex w-full items-center gap-2">
            {detailButton}
            {retryButton}
            {closeButton}
          </div>
        </>
      ) : (
        <>
          <XCircle className="size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="select-text line-clamp-1 break-words" title={isLong ? message : undefined}>
              {message}
            </div>
          </div>
          {hasDetails ? detailButton : copyButton}
          {retryButton}
          {closeButton}
        </>
      )}
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
  const initializingReason = useChat((s) => s.state?.initializingReason ?? null);
  // 「新建会话」整个流程的宿主投影（见 shared/messages.ts NewSessionPhase）。
  // 它比 initializing 早——从点击那一刻就非 null。
  const newSessionPhase = useChat((s) => s.state?.newSessionPhase ?? null);
  const compressing = useChat((s) => s.state?.compressing ?? false);
  // 宿主正在等子会话汇报：禁用顶栏「新会话」（等待期新建会话会让排队里的
  // 汇报落到已被替换的会话上）。它是 orthogonal 于 status 的标记，所以等待期
  // 用户仍然可以发消息、由主会话响应。顶栏不再为它渲染忙碌 chip —— 忙碌信号
  // 由转录底部浮动 pill 与子会话看板计数承担。
  const superWaiting = useChat((s) => s.state?.superWaiting ?? false);
  // 用户按了「停止」：superWaiting 是被压住的（汇报还在队列里，等下一条消息或
  // 常驻提示的「继续处理」才投递），不是真的在生成。此时「新会话」必须可点 ——
  // 否则用户点完停止就再无出路，面板看起来永久卡住。pendingCount 用于确认弹窗
  // 如实告知「有多少项结果、切回原会话才会继续投递」。
  const superHeld = useChat((s) => s.state?.superHeld ?? false);
  const superPendingCount = useChat((s) => s.state?.superPendingCount ?? 0);
  // 子会话仍在跑（非终态）时，切换会话 / 模型 / API 配置会让在途的子会话用错
  // 凭据或模型，或让汇报落到已被替换的主会话。与 superWaiting 分开判定：后者
  // 只覆盖「主会话空转等汇报」，子会话运行而主会话自己也在生成时同样要锁。
  //
  // P-2-1 原子订阅：只订阅列表**引用**（宿主推新数组时才变），布尔值由
  // useMemo 派生。旧写法把 `.some()` 写在 selector 里 —— selector 在每次
  // store 更新时都求值（流式期间 12.5 次/秒），等于每秒把整张子会话表扫一遍。
  const superSessions = useChat((s) => s.state?.superSessions);
  const superActive = useMemo(() => hasActiveSuperSession(superSessions), [superSessions]);
  const pendingApproval = useChat((s) => s.state?.pendingApproval ?? null);
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
  // 用户按停止后汇报被压住时点「新会话」：先弹如实确认（结果不丢、切回原会话
  // 才继续投递），确认后才发 newSession —— 这是被停止后唯一的显式出路。
  const [confirmNewSessionHeld, setConfirmNewSessionHeld] = useState(false);
  // 本地乐观锁：点击「新会话」后立刻禁用按钮并显示加载态，不等宿主回包
  // （IPC + 宿主处理有往返窗口，期间重复点击会再发一次 newSession）。
  // 宿主投影一到（starting / waiting）就退场；投影清空（成功 / 被拒 / 失败）
  // 也一并退场。只在投影变化时执行，点击到回包之间的窗口里本地锁保持不变。
  const [newSessionRequested, setNewSessionRequested] = useState(false);
  useEffect(() => {
    setNewSessionRequested(false);
  }, [newSessionPhase]);
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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        sessionId?: string | null;
        candidates?: MemoryCandidateUi[];
      };
      if (msg?.type === "memoryCandidates" && Array.isArray(msg.candidates) && msg.candidates.length > 0) {
        setMemoryReview({ sessionId: msg.sessionId ?? null, candidates: msg.candidates });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Pending-action cards (approval / question) own their overlay
  // in PendingCards: it mirrors its visible height into --pending-card-h on
  // this wrapper (MessageList reads it as the transcript's bottom padding and
  // the "生成中" pill rides on it) and switches between the single-card layout
  // and the stacked layout. Keeping the writer next to the overlay means the
  // stacked height (counter + peek edges + top card) is measured from the
  // same elements that draw it.
  const transcriptWrapRef = useRef<HTMLDivElement>(null);

  // The Super Agent board is part of the header now. Collapsed it takes NO
  // transcript space at all (--super-bar-h = 0 — the control lives inside the
  // header row). Expanded, its popup panel hangs below the header and covers
  // the top of the transcript, so its height is mirrored into --super-bar-h on
  // the transcript wrapper: MessageList reserves it as top padding, and the
  // Focus hint / pending-card overlay start below it instead of being painted
  // over.
  //
  // The panel node arrives through a stable callback ref (SuperAgentBoard
  // reports it via panelRef) into state. A mount-only effect would be wrong
  // here: the panel mounts in the same commit that creates the transcript
  // wrapper (it is PORTALED to document.body, but the ref callback still
  // fires in that commit), and only an effect (after refs attach) can
  // reliably read that wrapper.
  const [superPanelNode, setSuperPanelNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const wrapper = transcriptWrapRef.current;
    if (!wrapper) return;
    if (!superPanelNode) {
      // Collapsed: the control is inside the header, so nothing covers the
      // transcript top — drop the reserved clearance.
      wrapper.style.removeProperty("--super-bar-h");
      return;
    }
    const apply = () => {
      // A callback delivered for a node that already left the document must
      // not write a bogus `0 + 16` into the wrapper: unmounting the board has
      // to leave the clearance at zero.
      if (!superPanelNode.isConnected) {
        wrapper.style.removeProperty("--super-bar-h");
        return;
      }
      // Reserve the panel's own height plus the 8px mt-2 gap above it and an
      // 8px breathing gap below: the pending-card overlay starts at this
      // offset, and butting it against the panel's border read as one merged
      // stacked card.
      wrapper.style.setProperty("--super-bar-h", `${superPanelNode.offsetHeight + 16}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(superPanelNode);
    return () => {
      ro.disconnect();
      wrapper.style.removeProperty("--super-bar-h");
    };
  }, [superPanelNode]);

  // P1-3: screen-reader status announcements. The aria-live region re-announces
  // only when this string changes, so idle re-renders stay silent.
  // NOTE: must stay ABOVE the splash early-return below — a hook after that
  // return would change the hook count between the first render (state null)
  // and the snapshot render, which React rejects with error #310.
  const liveMessage = useMemo(() => {
    if (status === null) return "";
    if (pendingApproval) return t("有操作等你批准");
    if (pendingQuestions) return t("iFlow 有问题等你回答");
    if (pendingProfileSwitch) return t("等你选择切换 API 配置后如何处理当前会话");
    if (status === "connecting") return t("正在连接 iFlow…");
    if (status === "streaming")
      return compressing ? t("正在压缩上下文…") : t("正在生成回复…");
    if (status === "idle") {
      if (errorMessage) return errorMessage;
      if (stopReason === "cancelled") return t("已停止生成");
      return t("已就绪");
    }
    return "";
  }, [status, errorMessage, stopReason, pendingApproval, pendingQuestions, pendingProfileSwitch, compressing]);

  // P0-3: connecting elapsed timer. A wedged handshake used to strand the
  // splash with no feedback and no escape hatch; the live seconds plus a
  // patience-threshold restart affordance give the user both. The hook sits
  // BEFORE the splash early-return (hook-count stability, see liveMessage).
  // A host restart keeps `connecting` (the successor handshake owns this same
  // screen), so connectEpoch is what says "this is a NEW boot": without it the
  // bar keeps counting the superseded attempt and 「重启内核」 reads as a dead
  // button.
  const connectEpoch = useChat((s) => s.state?.connectEpoch ?? 0);
  const connectingSince = useRef<number | null>(null);
  const epochSeen = useRef(connectEpoch);
  const [connectingElapsed, setConnectingElapsed] = useState(0);
  useEffect(() => {
    if (status !== "connecting") {
      epochSeen.current = connectEpoch;
      connectingSince.current = null;
      setConnectingElapsed(0);
      return;
    }
    if (connectingSince.current === null || epochSeen.current !== connectEpoch) {
      epochSeen.current = connectEpoch;
      connectingSince.current = Date.now();
    }
    const tick = () =>
      setConnectingElapsed(Math.max(0, Math.floor((Date.now() - (connectingSince.current ?? Date.now())) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [status, connectEpoch]);

  // The error banner is host-owned (errorMessage rides the snapshot); a local
  // dismiss hides it until a DIFFERENT error arrives.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const focusMode = useChat((s) => s.focusMode);
  const toggleFocusMode = useChat((s) => s.toggleFocusMode);
  // 远程接管态：远端与本机共享同一会话，本机顶栏的会话/配置/视图变更一律
  // 冻结，避免误操作打断远端流程（输入区、审批卡、提问卡另行冻结，关闭接续
  // 的出口在 Composer）。这里订阅一次，下面各顶栏控件统一并入门控。
  const remoteTakeover = useChat((s) => s.remoteTakeover ?? false);
  // Shared gating for the header actions and the Alt+←/→ / Alt+N shortcuts:
  // switching session / mode / model / profile mid-turn would desync the
  // in-flight ACP request, and a profile switch is itself an optimistic lock.
  // 活跃子会话也并入 locked（它同时是 SettingsModal 的 busy）：在跑的子会话
  // 用错配置 / 汇报落到被替换的会话，比 mid-turn 切换更隐蔽。busy 保持原义。
  // 新建会话进行中：本地乐观锁覆盖 IPC 往返窗口，宿主投影覆盖整个流程
  // （含等后台落盘 / 恢复 / 握手的 waiting 阶段）。
  const newSessionBusy = newSessionRequested || newSessionPhase !== null;
  const newSessionWaiting = newSessionPhase === "waiting";
  const busy = status === "streaming" || replaying || initializing || newSessionBusy;
  const switching = pending !== null;
  const locked = busy || switching || superActive;

  // M1 P1-3: Ctrl/Cmd+Alt+F toggles Focus view from anywhere (also while the
  // composer has focus — Alt+F is not a text-editing chord). Declared BEFORE
  // the splash early-return (hook-count stability, see the liveMessage note).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !e.altKey || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
      if (remoteTakeover) return;
      if (document.querySelector(".auth-backdrop")) return;
      e.preventDefault();
      toggleFocusMode();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleFocusMode, remoteTakeover]);

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
      if (remoteTakeover || locked || status === null || status === "connecting" || settingsTab !== null || onboardingOpen) return;
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
        // 等待子会话汇报期间不能新建会话（与顶栏「新会话」按钮同一语义）：
        // 排队里的汇报会落到已被替换的会话上。用户按了停止压住汇报时是例外
        // —— 此时没有汇报在飞，允许新建，否则用户点完停止就再无出路。
        if (superWaiting && !superHeld) return;
        e.preventDefault();
        if (superHeld) setConfirmNewSessionHeld(true);
        else {
          setNewSessionRequested(true);
          send({ type: "newSession" });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessions, activeSessionId, locked, remoteTakeover, status, settingsTab, onboardingOpen, send, superWaiting, superHeld]);

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
          title={t("首次启动时需要多等一会儿")}
        >
          {connectEpoch > 0 ? t("正在重新启动内核 …") : t("正在启动 …")}
          {status === "connecting" && connectingElapsed >= 3 && (
            <span className="ml-1 font-mono tabular-nums opacity-70">{connectingElapsed}s</span>
          )}
        </div>
        {impatient && (
          <div className="splash-hint mt-2 flex flex-col items-center gap-2">
            <span>{t("等待时间偏长：可能是内核启动缓慢或网络不可达")}</span>
            <button
              className="press rounded-lg border border-border bg-surface/80 px-3 py-1 text-ui-caption font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
              onClick={() => send({ type: "restartCli" })}
            >
              {t("重启内核")}
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
              disabled={locked || remoteTakeover}
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
                  disabled={locked || remoteTakeover}
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
                        <SearchInput
                          autoFocus
                          ariaLabel={t("搜索会话")}
                          placeholder={t("搜索会话…")}
                          value={sessionQuery}
                          onChange={setSessionQuery}
                        />
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
                            <TextInput
                              autoFocus
                              aria-label={t("会话名称")}
                              className="min-w-0 flex-1"
                              value={renameDraft}
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
                            />
                            <IconButton
                              role="menuitem"
                              icon={<Check className={ICON_INLINE} />}
                              label={t("保存")}
                              size="sm"
                              tone="primary"
                              onClick={commit}
                            />
                            <IconButton
                              role="menuitem"
                              icon={<X className={ICON_INLINE} />}
                              label={t("取消")}
                              size="sm"
                              onClick={() => setRenamingId(null)}
                            />
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
          {newSessionWaiting ? (
            <Chip tone="primary">
              <Loader2 className="size-2.5 animate-spin" />{" "}
              <span aria-busy="true" className="@max-[320px]:hidden">
                {t("正在等待后台任务结束")}
              </span>
            </Chip>
          ) : replaying ? (
            <Chip tone="info">
              <Loader2 className="size-2.5 animate-spin" /> <span className="@max-[320px]:hidden">{t("正在恢复历史会话…")}</span>
            </Chip>
          ) : newSessionBusy ? (
            <Chip tone="primary">
              <Loader2 className="size-2.5 animate-spin" />{" "}
              <span aria-busy="true" className="@max-[320px]:hidden">
                {t("正在新建会话…")}
              </span>
            </Chip>
          ) : initializing ? (
            <Chip tone="primary">
              <Loader2 className="size-2.5 animate-spin" /> <span className="@max-[320px]:hidden">{initializingLabel(initializingReason)}</span>
            </Chip>
          ) : (
            statusChip(status ?? "connecting", compressing)
          )}
                    {/* Super Agent board: collapsed it is one inline control here in
                        the header; expanded it opens a popup panel under the header.
                        The panel is PORTALED to document.body (so it sits outside the
                        acrylic header's backdrop root and can blur the real backdrop)
                        and is positioned in viewport coordinates from the header's
                        rect. Renders nothing when no child sessions exist, so the
                        header never carries an empty control. */}
          {/* 接管态冻结子会话看板控件：inert 同时拦鼠标与键盘（含看板内的
              中断/合并/清理等所有操作按钮），pointer-events-none/opacity-40
              与顶栏其它禁用控件同一视觉。展开的浮层 portal 到 body，不属于
              顶栏，其操作由宿主侧接管冻结兜底。 */}
          <div
            inert={remoteTakeover || undefined}
            className={`flex shrink-0 items-center${remoteTakeover ? " pointer-events-none opacity-40" : ""}`}
          >
            <SuperAgentBoard panelRef={setSuperPanelNode} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <IconButton
              icon={<Focus className={ICON_TOOLBAR} />}
              label={t("Focus 视图")}
              title={focusMode ? t("退出 Focus 视图（Ctrl+Alt+F）") : t("Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）")}
              aria-pressed={focusMode}
              tone={focusMode ? "primary" : "default"}
              className={focusMode ? "bg-accent/60 ring-1 ring-primary/30" : ""}
              disabled={remoteTakeover}
              onClick={toggleFocusMode}
            />
            <IconButton
              icon={<Plus className={ICON_TOOLBAR} />}
              label={t("新会话")}
              // IconButton 的默认 title 就是 label —— 只有需要解释「为什么现在
              // 不能/能新建会话」时才覆盖它（title={undefined} 会把默认
              // tooltip 抹掉）。
              aria-busy={newSessionBusy ? true : undefined}
              {...(newSessionBusy
                ? { title: newSessionWaiting ? t("正在等待后台任务结束") : t("正在新建会话…") }
                : superWaiting && !superHeld
                  ? { title: t("超流体还在运行，等它们汇报完才能新建会话") }
                  : superWaiting && superHeld
                    ? { title: t("已停止：可以新建会话，待处理的汇报仍留在原会话") }
                    : replaying
                      ? { title: t("取消正在进行的会话恢复并新建会话") }
                      : {})}
              // 恢复中（replaying）不禁用：宿主会放弃这次恢复并立刻新建会话，
              // 用户不必等恢复跑完再点一次。其余忙碌态（生成中 / 正在新建会话 /
              // 正在切换会话）仍然禁用；newSessionBusy 显式优先，因为恢复中发起
              // 新建后 `busy && !replaying` 仍会为 false。
              // superWaiting 且是「用户已停止、汇报被压住」时**不禁用** —— 那时
              // 没有汇报在飞，新建会话不会串台，而是用户停止后唯一的出路。
              disabled={newSessionBusy || switching || (superWaiting && !superHeld) || (busy && !replaying) || remoteTakeover}
              onClick={() => {
                // 进行中重复点击直接忽略：不发第二次请求（宿主侧也会 join 同一个 run）。
                if (newSessionBusy) return;
                if (superWaiting && superHeld) setConfirmNewSessionHeld(true);
                else {
                  setNewSessionRequested(true);
                  send({ type: "newSession" });
                }
              }}
            />
            {/* Settings hub: profiles & credentials, MCP servers, approval
                policies. The gear used to open a profile quick-switcher whose
                list duplicated (and behaved differently from) the auth card's
                — now it opens the unified settings modal directly. Browse is
                normally allowed mid-turn (every mutating control inside gates
                itself on `busy`); only remote takeover freezes the gear, since
                changing API/MCP config mid-takeover would desync the peer. */}
            <IconButton
              icon={<Settings2 className={ICON_TOOLBAR} />}
              label={t("设置")}
              className={auth?.authenticated ? "" : "text-warning"}
              disabled={remoteTakeover}
              onClick={() => setSettingsTab("api")}
            />
          </div>
        </div>
      </header>

      {/* UI-audit 4.9: persistent notification tier — one inline banner row
          under the header for everything that needs handling (errors, missing
          credentials). Replaces the floating ErrorToast over the transcript
          and the composer-side auth banner, so there is a single place to
          look; transient notices keep riding the toast stack below. */}
      {errorMessage && dismissedError !== errorMessage && (
        <ErrorBanner
          message={errorMessage}
          advice={errorAdvice}
          onOpenSettings={(tab) => setSettingsTab(tab)}
          onDismiss={() => setDismissedError(errorMessage)}
        />
      )}
      {auth?.needsSetup && !onboardingOpen && (
        <div className="mx-3 my-1 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-caption leading-relaxed text-warning">
          <span className="min-w-0 flex-1">{t("还没配置 API 密钥，现在还不能开始对话。")}</span>
          <Button variant="warning-soft" size="sm" onClick={() => setSettingsTab("api")}>
            {t("去配置")}
          </Button>
          <Button variant="warning-soft" size="sm" onClick={() => setOnboardingOpen(true)}>
            {t("重新运行引导")}
          </Button>
        </div>
      )}

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

      {/* Pending-action cards (approval / question) float OVER the
          transcript instead of taking a row in the flex column — a shrink-0
          sibling here would squeeze the message list every time a card mounts.
          The wrapper is the relative anchor (same box MessageList fills); the
          overlay spans the whole wrapper and packs cards at the bottom
          (justify-end) above the Composer. A definite-height shell is what
          lets a tall card cap itself with max-h-full and scroll its body —
          a viewport-based budget drifts when the resizable Composer eats the
          wrapper. pointer-events-none on the shell keeps the empty gutters
          transparent to scroll/click; each card re-enables pointer events on
          itself. */}
      {/* The transcript column. The Super Agent board is a header control; only
          its expanded popup panel hangs over the top of the transcript, so
          --super-bar-h (mirrored from that panel above) keeps the Focus hint
          and the pending cards below it. Collapsed it is 0 — the header row
          owns the control, and nothing covers the transcript. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={transcriptWrapRef} className="relative flex min-h-0 flex-1 flex-col">
          <MessageList />
          {focusMode && focusHint && (
            <div
              className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
              style={{ top: "calc(var(--super-bar-h, 0px) + 0.25rem)" }}
            >
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border acrylic-pop px-2.5 py-1 text-ui-caption text-muted-foreground shadow-card">
                <Focus className="size-3 shrink-0" />
                {t("Focus 视图：只看对话，折叠工具与思考（Ctrl+Alt+F）")}
              </div>
            </div>
          )}
          {/* Pending-action cards (approval / question). The
              component owns the overlay shell, the stacked-vs-list switch and
              the --pending-card-h measurement; it starts below the Super Agent
              board's expanded popup panel via the same --super-bar-h offset.
              A single card renders exactly as before. */}
          <PendingCards
            pendingApproval={pendingApproval}
            pendingQuestions={pendingQuestions}
          />
        </div>
      </div>

      <Composer />

      {confirmNewSessionHeld && (
        <ConfirmDialog
          title={t("新建会话")}
          confirmLabel={t("新建会话")}
          message={t(
            "你按了停止，还有 {0} 项超流体结果没处理。新建会话不会丢掉它们：结果留在原会话里，切回去才会继续处理。要新建吗？",
            superPendingCount,
          )}
          onConfirm={() => {
            setConfirmNewSessionHeld(false);
            setNewSessionRequested(true);
            send({ type: "newSession" });
          }}
          onCancel={() => setConfirmNewSessionHeld(false)}
        />
      )}
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
      {/* 新建会话前的残留清空二次确认：文案由宿主组装随消息下发，
          ConfirmDialog 内部 portal 到 body，不受本容器 acrylic / overflow 裁剪。 */}
      <SuperResidueConfirmDialog />
    </div>
  );
}