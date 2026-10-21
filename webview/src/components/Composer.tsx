import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileText,
  Folder as FolderIcon,
  GitBranch,
  Globe,
  Image as ImageIcon,
  ListOrdered,
  Loader2,
  Paperclip,
  Pencil,
  Play,
  Search,
  SendHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { collectUserPromptTexts, type ContextRefUi, type FileHitUi, type ModelInfoUi, type QueuedPromptUi, type SlashCommand, type ThinkLevel } from "../../../shared/messages";
import { useChat } from "../store";
import { modeDisplay, t } from "../i18n";
import { CANVAS_BTN, ConfirmDialog, Dropdown, fuzzyScore } from "./ui";

/** One attached image (base64, no data: prefix). */
export interface ImageAttachment {
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Cap for staging non-image files through the host (base64 round-trip). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** UI-audit 4.6: context cards collapse to one-line chips; beyond this many
 * the rest fold behind a "+N" chip so a stack of sources cannot eat the
 * composer's height. */
const CONTEXT_CHIP_MAX = 3;

/** UI-audit 4.6: the model menu only grows a search row past this many models
 * — a five-entry catalog does not need a filter box above it. */
const MODEL_SEARCH_MIN = 8;

/** Reasoning levels (label + one-line description), rendered as a section at
 * the bottom of the model menu. */
const THINK_LEVELS = [
  ["auto", "自动", "模型自行决定思考投入"],
  ["fast", "快速", "优先响应速度"],
  ["balanced", "平衡", "平衡速度与分析能力"],
  ["deep", "深度", "适合复杂任务、规划和调试"],
] as const satisfies ReadonlyArray<readonly [ThinkLevel, string, string]>;

/** Icon per context-card source kind — shared by the collapsed chip row and
 * the expanded preview header. */
function contextIcon(kind: ContextRefUi["kind"]): typeof FileCode {
  return kind === "code"
    ? FileCode
    : kind === "folder"
      ? FolderIcon
      : kind === "problems"
        ? AlertTriangle
        : kind === "git"
          ? GitBranch
          : kind === "terminal"
            ? SquareTerminal
            : Globe;
}

function isImageFile(file: File): boolean {
  // Clipboard files may carry an empty MIME type — fall back to the extension.
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function imageMime(file: File): string {
  if (file.type) return file.type;
  const m = IMAGE_EXT.exec(file.name);
  if (!m) return "application/octet-stream";
  const ext = m[1]!.toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  return `image/${ext}`;
}

/** USD estimate: sub-cent figures keep 4 decimals (a cheap model's turn is
 * well under a cent), everything else 2. */
function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Stable empty fallbacks — a fresh `[]` per selector call would re-render on
 * every store change (zustand compares with Object.is). */
const EMPTY_COMMANDS: SlashCommand[] = [];
const EMPTY_MODELS: ModelInfoUi[] = [];
const EMPTY_QUEUE: QueuedPromptUi[] = [];

/**
 * Session token usage, read as PRIMITIVE selectors — postMessage re-clones the
 * usage object on every patch, so an object selector would re-render on every
 * blockPatch (up to 12.5/s while streaming); primitives only move when the
 * host's throttled real-time refresh actually changes a number. Both consumers
 * below are tiny leaf components, so the live refresh never re-renders the
 * whole Composer.
 *
 * The host zeroes usage at session start, so the readout shows real numbers
 * from the first paint; it hides only when the field is absent entirely (older
 * hosts).
 *
 * M1 P0-6: when the host resolves a context window for the active model, the
 * chip grows a mini occupancy bar (post-compression context / window, hover
 * shows the per-kind breakdown; a fallback window is labeled 估算).
 * M1 P1-6: an estimated cost (unit price × cached token sums) rides along
 * when a price is known for the model.
 */
function useUsage() {
  const hasUsage = useChat((s) => s.state?.usage != null);
  const inputTokens = useChat((s) => s.state?.usage?.inputTokens ?? 0);
  const outputTokens = useChat((s) => s.state?.usage?.outputTokens ?? 0);
  const contextWindow = useChat((s) => s.state?.usage?.contextWindow ?? null);
  const contextUsed = useChat((s) => s.state?.usage?.contextUsed ?? 0);
  const estimated = useChat((s) => s.state?.usage?.estimated ?? false);
  const usageAuthoritative = useChat((s) => s.state?.usage?.usageAuthoritative ?? false);
  const estimatedCost = useChat((s) => s.state?.usage?.estimatedCost ?? null);
  const cacheReadTokens = useChat((s) => s.state?.usage?.cacheReadTokens ?? 0);
  const bdUser = useChat((s) => s.state?.usage?.breakdown?.user ?? 0);
  const bdAssistant = useChat((s) => s.state?.usage?.breakdown?.assistant ?? 0);
  const bdTool = useChat((s) => s.state?.usage?.breakdown?.tool ?? 0);
  const bdThought = useChat((s) => s.state?.usage?.breakdown?.thought ?? 0);
  const pct =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 100))
      : null;
  return {
    hasUsage,
    inputTokens,
    outputTokens,
    contextWindow,
    contextUsed,
    pct,
    estimated,
    usageAuthoritative,
    estimatedCost,
    cacheReadTokens,
    bdUser,
    bdAssistant,
    bdTool,
    bdThought,
  };
}

type Usage = ReturnType<typeof useUsage>;

function usageBarTone(pct: number): string {
  return pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary/70";
}

/** Full breakdown, shared by the chip's tooltip and the menu summary. */
function usageTooltip(u: Usage): string {
  return u.pct === null
    ? [
        t(
          u.usageAuthoritative
            ? "当前上下文 {0} tokens（CLI 上报）"
            : "当前上下文约 {0} tokens（host 估算，压缩后按压缩上下文重算）",
          (u.usageAuthoritative ? u.contextUsed : u.inputTokens).toLocaleString(),
        ),
        t("输入 {0} tokens · 输出 {1} tokens", u.inputTokens.toLocaleString(), u.outputTokens.toLocaleString()),
      ].join("\n")
    : [
        t(
          "上下文占用 {0} / {1}（{2}%{3}{4}）",
          u.contextUsed.toLocaleString(),
          (u.contextWindow as number).toLocaleString(),
          u.pct,
          u.estimated ? t("，窗口为估算值") : "",
          u.usageAuthoritative ? t("，占用为 CLI 上报值") : "",
        ),
        t("输入 {0} tokens · 输出 {1} tokens", u.inputTokens.toLocaleString(), u.outputTokens.toLocaleString()),
        t("用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}", u.bdUser.toLocaleString(), u.bdAssistant.toLocaleString(), u.bdTool.toLocaleString(), u.bdThought.toLocaleString()),
        u.cacheReadTokens > 0 ? t("缓存读取 {0} tokens", u.cacheReadTokens.toLocaleString()) : "",
        u.estimatedCost !== null ? t("预估成本 {0}（按公开单价估算）", formatCost(u.estimatedCost)) : t("该模型无单价记录，不显示成本"),
      ]
        .filter(Boolean)
        .join("\n");
}

/**
 * Compact occupancy readout embedded in the model trigger (UI-audit 4.6:
 * model + usage are ONE chip — the row used to carry both separately). Hover
 * carries the full breakdown; the always-available session detail lives in the
 * status-bar tooltip (a menu section was tried here first and was unreachable
 * behind a gateway's long model list).
 */
function SessionUsageChip() {
  const u = useUsage();
  if (!u.hasUsage) return null;
  const hoverTitle = usageTooltip(u);
  return (
    <span
      title={hoverTitle}
      className="flex shrink-0 items-center gap-1 font-mono text-ui-caption tabular-nums text-muted-foreground/80 @max-[620px]:hidden"
    >
      {u.pct !== null && (
        <span className="ml-0.5 flex items-center gap-1">
          <span className="h-1 w-12 overflow-hidden rounded-full bg-border/70">
            <span
              className={`block h-full rounded-full transition-all duration-300 ${usageBarTone(u.pct)}`}
              style={{ width: `${u.pct}%` }}
            />
          </span>
          <span className={u.pct >= 90 ? "text-destructive" : u.pct >= 70 ? "text-warning" : ""}>
            {u.estimated ? "≈" : ""}
            {u.pct}%
          </span>
        </span>
      )}
      {u.estimatedCost !== null && (
        <span className="ml-0.5 opacity-80" title={t("预估成本（token 估算 × 公开单价，仅供参考）")}>
          {formatCost(u.estimatedCost)}
        </span>
      )}
    </span>
  );
}

/** QueueStrip's edit round-trip ids share one counter with the Composer's
 * queueEdited listener matching (module-level: the strip is a sibling). */
const queueEditSeqGlobal = { current: 0 };

/**
 * M2 P0-3 queued-message strip. Subscribes to the queue ARRAY itself — the
 * same isolation pattern as SessionUsageChip: blockPatch re-clones the tail,
 * so only this small strip re-renders when the queue changes, never the
 * whole Composer. Renders nothing while the queue is empty and unpaused.
 */
function QueueStrip() {
  const queue = useChat((s) => s.state?.queue ?? EMPTY_QUEUE);
  const paused = useChat((s) => s.state?.queuePaused ?? false);
  const send = useChat((s) => s.send);
  // P1-8: the 3s armed pill was the product's second confirm language;
  // destructive actions now all share the modal ConfirmDialog.
  const [confirmClear, setConfirmClear] = useState(false);
  // The strip collapses to a one-line summary by default: the transcript echo
  // bubble (P1-11) already shows the queued content right above the streaming
  // pill, so an always-expanded entry list stacked a second copy of the same
  // text and crowded the bottom area mid-turn. Click the header to manage
  // entries (interrupt / take back / reorder / delete).
  const [expanded, setExpanded] = useState(false);
  if (queue.length === 0 && !paused) return null;
  const act = (action: "edit" | "delete" | "move" | "sendNow" | "resume" | "clear", id?: string, delta?: number): void => {
    send({ type: "queueAction", action, id, delta });
  };
  // UI-audit 4.6: 24px hit area (the icons stay 14px) — 12px targets were
  // easy to miss in a dense row.
  const miniBtn =
    "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-surface/70 shadow-card">
      <div className={`flex items-center gap-1.5 px-2.5 py-1 ${expanded && queue.length > 0 ? "border-b border-border/60" : ""}`}>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded disabled:cursor-default"
          title={expanded ? t("收起") : t("展开")}
          disabled={queue.length === 0}
          onClick={() => setExpanded((v) => !v)}
        >
          <ListOrdered className="size-3.5 shrink-0 text-primary" />
          <span className="text-ui-caption font-medium text-foreground">
            {t("队列 · {0} 条待发送", queue.length)}
          </span>
          {queue.length > 0 && (
            <ChevronDown className={`size-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-180" : ""}`} />
          )}
        </button>
        {paused && (
          <span className="inline-flex items-center gap-1 rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-ui-caption text-warning">
            <AlertTriangle className="size-2.5" /> {t("已暂停")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {paused && queue.length > 0 && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-primary/50 bg-primary/15 px-1.5 py-0.5 text-ui-caption font-medium text-primary hover:bg-primary/25"
              title={t("继续依序发送队列")}
              onClick={() => act("resume")}
            >
              <Play className="size-2.5" /> {t("继续")}
            </button>
          )}
          {queue.length > 0 && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-ui-caption text-muted-foreground hover:text-destructive"
              title={t("清空队列")}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-2.5" /> {t("清空")}
            </button>
          )}
        </div>
      </div>
      {expanded && queue.length > 0 && (
        <ul className="max-h-32 overflow-y-auto">
          {queue.map((q, i) => (
            <li
              key={q.id}
              className="group flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1 last:border-b-0 hover:bg-accent/30"
            >
              <span className="w-4 shrink-0 text-right font-mono text-ui-caption text-muted-foreground/80">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-ui-caption text-foreground" title={q.text}>
                {q.text || t("（附件消息）")}
              </span>
              {q.attachments.length > 0 && (
                <span className="shrink-0 rounded border border-border bg-surface px-1 font-mono text-ui-micro text-muted-foreground">
                  {t("附件 {0}", q.attachments.length)}
                </span>
              )}
              <span className="flex shrink-0 items-center gap-0.5 opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <button className={miniBtn} title={t("打断并立即发送")} onClick={() => act("sendNow", q.id)}>
                  <Play className="size-3.5" />
                </button>
                <button
                  className={miniBtn}
                  title={t("取回编辑")}
                  onClick={() => send({ type: "queueAction", action: "edit", id: q.id, requestId: ++queueEditSeqGlobal.current })}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button className={miniBtn} title={t("上移")} disabled={i === 0} onClick={() => act("move", q.id, -1)}>
                  <ArrowUp className="size-3.5" />
                </button>
                <button
                  className={miniBtn}
                  title={t("下移")}
                  disabled={i === queue.length - 1}
                  onClick={() => act("move", q.id, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </button>
                <button className={miniBtn} title={t("删除")} onClick={() => act("delete", q.id)}>
                  <X className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {confirmClear && (
        <ConfirmDialog
          title={t("清空队列")}
          message={t("确定清空队列中全部 {0} 条待发送消息吗？", queue.length)}
          confirmLabel={t("清空")}
          onConfirm={() => {
            setConfirmClear(false);
            act("clear");
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

export function Composer() {
  // P2-1 selector split: the composer previously subscribed to the whole
  // state object, re-rendering on every blockPatch (up to 12.5/s during
  // streaming). Each field below is a primitive or a reference carried over
  // by the patch's metadata spread — none change while blocks stream.
  const status = useChat((s) => s.state?.status ?? null);
  const replaying = useChat((s) => s.state?.replaying ?? false);
  const initializing = useChat((s) => s.state?.initializing ?? false);
  const needsSetup = useChat((s) => s.state?.auth.needsSetup ?? false);
  const pendingApproval = useChat((s) => s.state?.pendingApproval ?? null);
  const pendingQuestions = useChat((s) => s.state?.pendingQuestions ?? null);
  const commands = useChat((s) => s.state?.commands ?? EMPTY_COMMANDS);
  const modes = useChat((s) => s.state?.modes ?? null);
  const models = useChat((s) => s.state?.models ?? EMPTY_MODELS);
  const currentModelId = useChat((s) => s.state?.currentModelId ?? null);
  const thinkLevel = useChat((s) => s.state?.thinkLevel ?? "auto");
  /** Turn-end model predictions; host metadata, cleared when a new turn starts. */
  const suggestions = useChat((s) => s.state?.nextStepSuggestions);
  /** The prediction call is running: render the pill in the chips' slot. */
  const suggestionsLoading = useChat((s) => s.state?.nextStepLoading ?? false);
// Hard evidence only: thinking===false comes from an explicit
// iflow.thinkingModelRules entry (supportsThinking:false) evaluated by the
// host; unknown (undefined) stays ALLOWED — the CLI's own rejection is
// friendly-toasted in setThink instead of pre-gated here.
const thinkUnsupported = models.find((m) => m.id === currentModelId)?.thinking === false;
  const pending = useChat((s) => s.pending);
  const beginPending = useChat((s) => s.beginPending);
  const send = useChat((s) => s.send);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** Non-image attachments (chips only — paths ride the sendPrompt message,
   * they never pollute the draft text the user types). The id decouples chip
   * identity from the path: picking the same file twice yields two removable
   * chips instead of one key collision. */
  const [attachments, setAttachments] = useState<Array<{ id: number; name: string; path: string }>>([]);
  /** M2 P0-4: context cards above the composer (right-click selection +
   * @folder/@problems/@git/@url). Generalizes the old single code card;
   * each card is removable, the host assembles all of them at send time. */
  const [contexts, setContexts] = useState<ContextRefUi[]>([]);
  /** UI-audit 4.6: chips are collapsed by default; this is the one card whose
   * preview is open (null = none). */
  const [expandedContextId, setExpandedContextId] = useState<string | null>(null);
  /** "+N" chip: reveal the sources beyond CONTEXT_CHIP_MAX. */
  const [showAllContexts, setShowAllContexts] = useState(false);
  /** The card whose preview is open — a removed id simply collapses it. */
  const expandedContext = contexts.find((c) => c.id === expandedContextId) ?? null;

  /** Remove a context source (the host re-assembles the rest at send time). */
  function removeContext(id: string): void {
    setContexts((prev) => prev.filter((x) => x.id !== id));
    setExpandedContextId((cur) => (cur === id ? null : cur));
  }
  const contextSeq = useRef(0);
  const stageSeq = useRef(0);
  const attachSeq = useRef(0);
  /** M2 P0-4: resolveContext request id generator + in-flight registry.
   * The reply must match by id against the SET — matching only the latest
   * id silently dropped every slower reply (URL fetches run up to 10s; a
   * folder/problems card issued meanwhile killed the URL card entirely). */
  const contextResolveSeq = useRef(0);
  const pendingContextResolves = useRef(new Set<number>());
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Turn-end suggestions: local dismissal hides this batch until the next
  // prediction arrives (the host stores each batch as a fresh array, so
  // identity is the batch key).
  const [suggestionsHidden, setSuggestionsHidden] = useState(false);
  const lastSuggestionsRef = useRef<string[] | undefined>(undefined);
  useEffect(() => {
    if (lastSuggestionsRef.current !== suggestions) {
      lastSuggestionsRef.current = suggestions;
      setSuggestionsHidden(false);
    }
  }, [suggestions]);
  /** Candidate-word semantics: insert at the caret (empty composer = plain
   * fill) and keep focus in the textarea — never auto-send, and never retract
   * the batch: the other candidates are still one click away. The row is
   * retired by its close button or by the host when the user actually sends. */
  const applySuggestion = (value: string): void => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    setText(`${text.slice(0, start)}${value}${text.slice(end)}`);
    requestAnimationFrame(() => {
      ta?.focus();
      const caret = start + value.length;
      ta?.setSelectionRange(caret, caret);
    });
  };

  // Drag-and-drop file attachment: dropping files/photos from the OS or editor
  // onto the composer routes them through the same staging paths as paste. The
  // `dragover` preventDefault is what lets the webview receive the drop
  // instead of VSCode opening the file in an editor.
  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const imgs = files.filter(isImageFile);
    const others = files.filter((f) => !isImageFile(f));
    if (imgs.length > 0) addImages(imgs);
    if (others.length > 0) addOtherFiles(others);
  };

  // Drag the top edge to resize the composer height. The handle writes an
  // explicit pixel height; the textarea area (flex-1) fills the remaining
  // space, so the input grows/shrinks with the drag.
  // Upper bound is viewport-relative (45vh): a fixed pixel cap lets a short
  // panel get swallowed whole by a dragged-tall composer (the message list
  // would collapse to nothing). 200px floor keeps the cap sane on tiny
  // viewports; a resize listener re-clamps an already-set height when the
  // window shrinks below it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  // The default (content-sized) height doubles as the drag floor: measured
  // once on mount while `height` is still null, so shrinking all the way
  // lands exactly on the initial look — the composer never renders shorter
  // than it started. 110 is only a pre-measure fallback.
  const minComposerHeight = useRef(110);
  useEffect(() => {
    if (rootRef.current) minComposerHeight.current = rootRef.current.offsetHeight;
  }, []);
  const resizing = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const maxComposerHeight = () => Math.max(200, Math.floor(window.innerHeight * 0.45));
  useEffect(() => {
    const onWinResize = () =>
      setHeight((h) => (h === null ? h : Math.min(h, maxComposerHeight())));
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);
  const onResizeMove = (e: MouseEvent) => {
    if (!resizing.current) return;
    const delta = startY.current - e.clientY; // drag up → taller
    setHeight(Math.min(maxComposerHeight(), Math.max(minComposerHeight.current, startH.current + delta)));
  };
  const stopResize = () => {
    if (!resizing.current) return;
    resizing.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", stopResize);
  };
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    startY.current = e.clientY;
    startH.current = rootRef.current?.offsetHeight ?? 160;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", stopResize);
  };

  // --- @-mention file search (M5) ---
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHits, setMentionHits] = useState<FileHitUi[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Active @-mention row — kept in a ref so keyboard navigation can scroll
   * it into view when the popup overflows. */
  const mentionActiveRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mentionActiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionHits.length]);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (mentionQuery === null) return;
    const raw = mentionQuery.trim();
    if (raw.toLowerCase().startsWith("url:")) return; // URL source: no file search
    // M2 P0-4: "@/…" searches folders (host derives the dir set from the
    // same file cache); plain "@" tokens keep searching files.
    const folder = raw.startsWith("/");
    const q = folder ? raw.slice(1) : raw;
    const requestId = ++searchSeq.current;
    // W5: read `send` from the store imperatively — its reference is stable,
    // so the effect legitimately depends only on `mentionQuery` (no eslint
    // suppression needed).
    const timer = setTimeout(
      () => useChat.getState().send({ type: "searchFiles", requestId, query: q, kind: folder ? "folder" : "file" }),
      120,
    );
    return () => clearTimeout(timer);
  }, [mentionQuery]);

  // ESC 停止生成（与停止按钮同语义）：仅在真实生成中生效（回放/初始化除外）。
  // 弹窗内的 ESC（mention/斜杠补全在 textarea onKeyDown、Dropdown 在 document）
  // 都会 stopPropagation，事件只有未被拦截时才到达这里的 window 监听。
  const canStopForEsc = status === "streaming" && !replaying && !initializing;
  useEffect(() => {
    if (!canStopForEsc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      useChat.getState().send({ type: "cancel" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canStopForEsc]);

  // P1-4: press "/" anywhere outside an input/textarea/contenteditable to jump
  // focus into the composer. When the textarea is already focused the keystroke
  // falls through to normal typing (slash-command prefix), so this only fires
  // from elsewhere (body, header buttons).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      e.preventDefault();
      taRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "fileList" && msg.requestId === searchSeq.current) {
        setMentionHits(msg.hits ?? []);
        setMentionIndex(0);
        return;
      }
      if (msg?.type === "stagedFiles" && msg.requestId === stageSeq.current) {
        const failed = msg.paths.filter((p: string | null) => p === null).length;
        const staged: Array<{ id: number; name: string; path: string }> = [];
        for (const p of msg.paths) {
          if (p === null) continue;
          staged.push({ id: ++attachSeq.current, name: p.split(/[\\/]/).pop() ?? p, path: p });
        }
        if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
        if (failed > 0) showNote(t("{0} 个文件暂存失败，已跳过", failed));
        return;
      }
      if (msg?.type === "filesPicked") {
        const pickedImages = msg.images.filter(
          (img: { name: string; data: string; mimeType: string }) => img.data,
        );
        if (pickedImages.length > 0) {
          setImages((prev) => [
            ...prev,
            ...pickedImages
              .slice(0, Math.max(0, MAX_IMAGES - prev.length))
              .map((img: { data: string; mimeType: string }) => ({ data: img.data, mimeType: img.mimeType })),
          ]);
        }
        if (msg.files.length > 0) {
          setAttachments((prev) => [
            ...prev,
            ...msg.files.map((f: { name: string; path: string }) => ({
              id: ++attachSeq.current,
              name: f.name,
              path: f.path,
            })),
          ]);
        }
        return;
      }
      if (msg?.type === "setCodeContext" && typeof msg.code === "string") {
        // Right-click "加入 iFlow 上下文": attach as a code-kind context
        // card (M2 P0-4 generalization). Re-right-clicking the same file +
        // range replaces the previous card instead of stacking duplicates.
        const card: ContextRefUi = {
          id: `ctx-${++contextSeq.current}`,
          kind: "code",
          label: msg.path,
          detail: msg.range,
          content: msg.code,
        };
        setContexts((prev) => {
          const dup = prev.findIndex((c) => c.kind === "code" && c.label === msg.path && c.detail === msg.range);
          if (dup >= 0) {
            const next = [...prev];
            next[dup] = card;
            return next;
          }
          return [...prev, card];
        });
        setMentionQuery(null);
        requestAnimationFrame(() => taRef.current?.focus());
      }
      if (msg?.type === "queueEdited" && msg.requestId === queueEditSeqGlobal.current) {
        // M2 P0-3: an entry popped back from the queue fills the composer.
        // Guarded like enhance: never clobber fresh typing (the user may
        // have typed while the round trip ran) — drop with a note instead.
        queueEditSeqGlobal.current += 1;
        if (msg.error) {
          showNote(msg.error);
          return;
        }
        if (textRef.current.trim() !== "") {
          showNote(t("输入框非空，已放弃回填（队列条目仍在）"));
          return;
        }
        setText(msg.text);
        if (msg.images?.length)
          setImages(
            msg.images.map((img: { data: string; mimeType: string }) => ({ data: img.data, mimeType: img.mimeType })),
          );
        if (msg.files?.length) {
          setAttachments(
            msg.files.map((f: { name: string; path: string }) => ({ id: ++attachSeq.current, name: f.name, path: f.path })),
          );
        }
        if (msg.contexts?.length) setContexts(msg.contexts);
        requestAnimationFrame(() => taRef.current?.focus());
      }
      if (msg?.type === "contextResolved" && pendingContextResolves.current.delete(msg.requestId)) {
        // M2 P0-4: a resolved @folder/@problems/@git/@url source becomes a card.
        if (msg.error) {
          showNote(msg.error);
          return;
        }
        setContexts((prev) => [
          ...prev,
          { id: `ctx-${++contextSeq.current}`, kind: msg.kind, label: msg.label, detail: msg.detail, content: msg.content },
        ]);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Stop is only meaningful for a real generation: beginReplay() also reports
  // status "streaming", so replaying and initializing must be excluded there.
  // M2 P0-3: streaming no longer locks the composer — Enter while generating
  // ENQUEUES the message (host-owned queue, dispatched when the turn settles).
  // The switches that would desync the agent (model/profile dropdowns,
  // attachments, enhance) keep the original mid-turn lock; only replay/init/
  // an in-flight switch block sending entirely (the host enqueue gate rejects
  // replay too, so the webview must not offer it).
  const streaming = status === "streaming";
  const hasPendingInteraction = Boolean(pendingApproval || pendingQuestions);
  const canStop = Boolean(streaming && !replaying && !initializing && !hasPendingInteraction);
  const controlsLocked = streaming || replaying || initializing || pending !== null || hasPendingInteraction;
  const sendBlocked = replaying || initializing || pending !== null || needsSetup;
  /** Enter/发送 while a real turn streams → the host queues this message. */
  const enqueueMode = streaming && !replaying && !initializing;
  // The permission mode is a session-level setting the agent re-reads per turn
  // (set_mode is an independent JSON-RPC request; CLI 0.5.19 applies it without
  // touching the in-flight prompt), so it stays switchable while streaming or
  // while an approval/question card is up. It is only locked before a session
  // exists (replay/init) or while another switch is in flight.
  const modeLocked = replaying || initializing || pending !== null;
  const currentMode = modes?.availableModes.find((m) => m.id === modes.currentModeId) ?? null;
  /** UI-audit 4.6: the trigger shows the display name (matching the menu rows);
   * an unknown / delisted id falls back to the raw id so the chip never lies
   * about what is actually selected. */
  const currentModelName =
    models.find((m) => m.id === currentModelId)?.name ??
    currentModelId ??
    models[0]?.name ??
    models[0]?.id ??
    "";

  // Slash-command popup: every command matching the typed prefix. While the
  // popup is open, Enter/Tab complete the selected command instead of sending.
  const cmdMatches = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return [];
    const input = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(input));
  }, [text, commands]);
  const [cmdIndex, setCmdIndex] = useState(0);
  useEffect(() => {
    setCmdIndex(0);
  }, [cmdMatches.length]);
  /** Active slash-command row — kept in a ref so keyboard navigation can
   * scroll it into view when the popup overflows. */
  const cmdActiveRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cmdActiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [cmdIndex, cmdMatches.length]);

  // Model dropdown fuzzy search: filters by name AND id (ids are what the
  // gateway actually accepts and often carry the meaningful segments).
  const [modelQuery, setModelQuery] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const currentModelRef = useRef<HTMLButtonElement | null>(null);
  /** UI-audit 4.6 (revised): reasoning level sits in a sticky footer of the
   * model menu (the row is always reachable, unlike a section appended after a
   * gateway's hundred-model list). Clicking it swaps the footer for the four
   * levels instead of stacking another section. Reset whenever the menu
   * closes, and focus moves into the panel when it opens (Dropdown only
   * focuses at open time). */
  const [thinkPanel, setThinkPanel] = useState(false);
  const thinkPanelRef = useRef<HTMLDivElement | null>(null);
  const thinkRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (thinkPanel) thinkPanelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [thinkPanel]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim();
    if (!q) return models.map((m) => ({ m, score: 0 }));
    return models
      .map((m) => ({
        m,
        score: Math.max(fuzzyScore(q, m.name) ?? -1, fuzzyScore(q, m.id) ?? -1),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
  }, [modelQuery, models]);
  useEffect(() => {
    setModelIndex(0);
  }, [modelQuery]);

  // Scroll the active model into view when the dropdown opens (empty query
  // only, so manual scrolling / search results are never hijacked); the
  // `models` dep re-anchors after the async refreshModels reply re-renders
  // the list.
  useEffect(() => {
    if (modelMenuOpen && !modelQuery.trim()) {
      currentModelRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [modelMenuOpen, modelQuery, models]);

  // UI-audit 4.6: the inline note row was a fourth notification surface next to
  // host toasts / the error pill / the auth banner. Local notices now ride the
  // shared toast stack (store.notify), so there is one place to look; only
  // field-level validation would stay inline (the composer has none).
  const notify = useChat((s) => s.notify);
  function showNote(message: string, level: "info" | "warning" | "error" = "warning"): void {
    notify(message, level);
  }

  // M1 P1-5 Enhance Prompt: hand the draft to the host (one internal prompt,
  // never recorded in the transcript) and fill the rewrite back in. The
  // original text is kept in a ref so a second click undoes the enhancement
  // (Roo's wand toggles between draft and enhanced). The reply arrives on the
  // shared window-message listener below (matched by requestId).
  // Anti-footgun (the rewrite takes 40-180s): re-clicking the wand cancels
  // the in-flight request; submitting or switching sessions cancels it too;
  // and a reply whose draft the user edited meanwhile is DISCARDED instead of
  // clobbering fresh typing. `enhanceSnapshot` records the exact draft the
  // rewrite was generated from — the host additionally drops replies that
  // arrive after a cancel or a session switch.
  const [enhancing, setEnhancing] = useState(false);
  const enhanceSeq = useRef(0);
  const enhancePending = useRef(false);
  const enhanceOriginal = useRef<string | null>(null);
  const enhanceSnapshot = useRef<string | null>(null);
  // The reply listener below is registered once ([] deps) — it must read the
  // CURRENT draft through a ref, not the stale `text` captured at mount.
  const textRef = useRef(text);
  textRef.current = text;
  const cancelInflightRef = useRef<() => void>(() => {});
  function cancelInflight(): void {
    if (!enhancePending.current) return;
    send({ type: "cancelEnhance", requestId: enhanceSeq.current });
    // Late replies can no longer match the sequence → ignored here too, even
    // against a host build that still answers a cancelled request.
    enhanceSeq.current += 1;
    enhancePending.current = false;
    enhanceOriginal.current = null;
    enhanceSnapshot.current = null;
    setEnhancing(false);
  }
  cancelInflightRef.current = cancelInflight;
  function enhance(): void {
    // While a rewrite is in flight the wand becomes a cancel button.
    if (enhancePending.current) {
      cancelInflight();
      showNote(t("已取消增强"), "info");
      return;
    }
    const value = text.trim();
    if (!value || controlsLocked) return;
    // Second click while an enhancement is shown: restore the original draft.
    if (enhanceOriginal.current !== null) {
      setText(enhanceOriginal.current);
      enhanceOriginal.current = null;
      showNote(t("已还原原始输入"), "info");
      return;
    }
    enhancePending.current = true;
    setEnhancing(true);
    enhanceOriginal.current = text;
    enhanceSnapshot.current = text;
    send({ type: "enhancePrompt", requestId: ++enhanceSeq.current, text: value });
  }
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type !== "enhancedPrompt" || msg.requestId !== enhanceSeq.current) return;
      enhancePending.current = false;
      setEnhancing(false);
      const snapshot = enhanceSnapshot.current;
      enhanceSnapshot.current = null;
      if (msg.error) {
        // Keep the original draft (the host preserved it too).
        enhanceOriginal.current = null;
        showNote(msg.error);
        return;
      }
      // The user kept typing while the rewrite was in flight — never
      // clobber fresh work; drop the result instead.
      if (snapshot !== null && textRef.current !== snapshot) {
        enhanceOriginal.current = null;
        showNote(t("输入已修改，已放弃增强结果"));
        return;
      }
      setText(msg.text);
      showNote(t("已增强输入（再次点击增强可还原）"), "info");
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listener reads refs + stable setters only
  }, []);

  function addImages(files: ArrayLike<File>): void {
    const incoming = Array.from(files);
    const accepted = incoming.filter((f) => f.size <= MAX_IMAGE_BYTES);
    // Over-limit images are NOT dropped: they degrade to staged file
    // attachments, mirroring the host picker's fall-through (picked images
    // above ATTACHMENT_IMAGE_MAX_BYTES land in filesPicked.files). A large
    // screenshot thus still reaches the agent as a file path instead of
    // vanishing; addOtherFiles applies its own 50MB cap + rejection note.
    const oversized = incoming.filter((f) => f.size > MAX_IMAGE_BYTES);
    if (oversized.length > 0) addOtherFiles(oversized);
    // Updaters must stay side-effect free: React may run them lazily and, in
    // StrictMode, more than once. Slots are pure placeholders; the actual
    // data lands by scanning for the first empty slot below.
    setImages((prev) => {
      const room = Math.max(0, MAX_IMAGES - prev.length);
      return [...prev, ...accepted.slice(0, room).map(() => ({ data: "", mimeType: "image/*" }))];
    });
    for (const file of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
        setImages((prev) => {
          const idx = prev.findIndex((img) => img.data === "");
          if (idx < 0) return prev; // over the limit or the slot was removed
          const next = [...prev];
          next[idx] = { data: base64, mimeType: imageMime(file) };
          return next;
        });
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index: number): void {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  /** Remove a non-image attachment chip. */
  function removeAttachment(id: number): void {
    setAttachments((prev) => prev.filter((f) => f.id !== id));
  }

  /**
   * Non-image files pasted into the composer: a pasted File has no real
   * filesystem path, so hand the bytes to the host (stageFiles) and show the
   * staged file as a chip — the absolute path rides sendPrompt.files at send
   * time, where the host appends the list to the agent-facing prompt.
   */
  function addOtherFiles(files: ArrayLike<File>): void {
    const incoming = Array.from(files);
    const storable = incoming.filter((f) => f.size <= MAX_FILE_BYTES);
    const rejected = incoming.length - storable.length;
    if (rejected > 0) showNote(t("{0} 个文件超过大小上限（50MB），已跳过", rejected));
    if (storable.length === 0) return;
    const requestId = ++stageSeq.current;
    let pending = storable.length;
    const payloads: { name: string; data: string }[] = [];
    for (const file of storable) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        payloads.push({
          name: file.name,
          data: result.includes(",") ? result.slice(result.indexOf(",") + 1) : result,
        });
        if (--pending === 0) {
          useChat.getState().send({ type: "stageFiles", requestId, files: payloads });
        }
      };
      reader.onerror = () => {
        if (--pending === 0) {
          useChat.getState().send({ type: "stageFiles", requestId, files: payloads });
        }
      };
      reader.readAsDataURL(file);
    }
  }

  const mentionToken = useMemo(() => {
    // The token being typed: from the last "@" up to the caret.
    if (mentionQuery === null || !taRef.current) return null;
    const caret = taRef.current.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    return { at, token: before.slice(at + 1) };
  }, [mentionQuery, text]);

  // --- M2 P0-4: extended @-mention sources ---------------------------------
  // "@" files (original), "@/" folders, "@problems" / "@git" / "@terminal"
  // workspace snapshots, "@url:…" web pages. Keyword/url sources resolve
  // through the host (resolveContext) and land as context cards — they never
  // expand inline into the draft.
  const mentionKind: "file" | "folder" | "url" = mentionQuery === null
    ? "file"
    : mentionQuery.trim().toLowerCase().startsWith("url:")
      ? "url"
      : mentionQuery.startsWith("/")
        ? "folder"
        : "file";
  /** Keyword source rows (@problems / @git / @terminal), shown only while the
   * token is still a prefix of the keyword — once the user types past it the
   * row disappears and plain file search takes over. */
  const KEYWORD_SOURCES: ReadonlyArray<{ kind: "problems" | "git" | "terminal"; keyword: string; icon: typeof AlertTriangle }> = [
    { kind: "problems", keyword: "problems", icon: AlertTriangle },
    { kind: "git", keyword: "git", icon: GitBranch },
    { kind: "terminal", keyword: "terminal", icon: SquareTerminal },
  ];
  const sourceActions = useMemo(() => {
    if (mentionQuery === null) return [];
    const raw = mentionQuery.trim().toLowerCase();
    if (raw.startsWith("/")) return []; // folder mode: hits only
    const rows: Array<{
      kind: "problems" | "git" | "terminal" | "url";
      keyword: string;
      icon: typeof AlertTriangle;
      label: string;
      ready: boolean;
    }> = KEYWORD_SOURCES.filter((s) => s.keyword.startsWith(raw)).map((s) => ({
      kind: s.kind,
      keyword: s.keyword,
      icon: s.icon,
      label:
        s.kind === "problems"
          ? t("工作区诊断（Problems）")
          : s.kind === "git"
            ? t("Git 状态与变更")
            : t("终端最近输出"),
      ready: raw === s.keyword,
    }));
    // The URL row is discoverable from a bare "@" too (and while typing
    // "u…url:"): list it whenever the token is still a prefix of "url:".
    if (raw.startsWith("url:") || "url:".startsWith(raw)) {
      const target = raw.startsWith("url:") ? mentionQuery.trim().slice(4).trim() : "";
      rows.push({
        kind: "url",
        keyword: "",
        icon: Globe,
        label: target || t("输入 URL 后回车附加"),
        ready: target !== "",
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- KEYWORD_SOURCES is a module-level constant shape
  }, [mentionQuery]);
  /** Rows the keyboard navigates: source actions first, then file/folder hits. */
  const popupRowCount = sourceActions.length + (mentionKind === "url" ? 0 : mentionHits.length);
  useEffect(() => {
    setMentionIndex(0);
  }, [sourceActions.length, mentionHits.length]);

  /** Mint a resolveContext request id and register it as in-flight (the
   * reply listener consumes it whenever it lands, in any order). */
  function nextContextRequestId(): number {
    const id = ++contextResolveSeq.current;
    pendingContextResolves.current.add(id);
    return id;
  }

  /** Attach a folder hit as a context card (M2 P0-4: folders are cards, not
   * inline @paths — the host builds the listing). */
  function resolveFolderContext(relPath: string): void {
    useChat.getState().send({
      type: "resolveContext",
      requestId: nextContextRequestId(),
      kind: "folder",
      query: relPath,
    });
    const ta = taRef.current;
    if (ta && mentionToken !== null) {
      const caret = ta.selectionStart ?? text.length;
      setText(text.slice(0, mentionToken.at) + text.slice(caret));
    }
    setMentionQuery(null);
    setMentionHits([]);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  /** Attach @problems / @git / @terminal as a context card (token consumed). */
  function resolveKeywordContext(kind: "problems" | "git" | "terminal"): void {
    useChat.getState().send({
      type: "resolveContext",
      requestId: nextContextRequestId(),
      kind,
      query: "",
    });
    const ta = taRef.current;
    if (ta && mentionToken !== null) {
      const caret = ta.selectionStart ?? text.length;
      setText(text.slice(0, mentionToken.at) + text.slice(caret));
    }
    setMentionQuery(null);
    setMentionHits([]);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  /** Attach @url:<target> as a context card (host fetches + extracts text).
   * With no target yet (row picked from a bare "@"), seed the draft with
   * "@url:" and keep the popup in URL mode instead of silently doing nothing. */
  function attachUrlContext(): void {
    const target = mentionQuery!.trim().slice(4).trim();
    if (!target) {
      const ta = taRef.current;
      if (!ta || mentionToken === null) return;
      const caret = ta.selectionStart ?? text.length;
      const { at } = mentionToken;
      const next = `${text.slice(0, at)}@url:${text.slice(caret)}`;
      setText(next);
      setMentionHits([]);
      const pos = at + 5;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos, pos);
        updateMentionFromCaret(next);
      });
      return;
    }
    useChat.getState().send({
      type: "resolveContext",
      requestId: nextContextRequestId(),
      kind: "url",
      query: target,
    });
    const ta = taRef.current;
    if (ta && mentionToken !== null) {
      const caret = ta.selectionStart ?? text.length;
      setText(text.slice(0, mentionToken.at) + text.slice(caret));
    }
    setMentionQuery(null);
    setMentionHits([]);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function updateMentionFromCaret(value: string): void {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
      setMentionQuery(before.slice(at + 1));
    } else {
      setMentionQuery(null);
    }
  }

  function insertMention(relPath: string): void {
    const ta = taRef.current;
    if (!ta || mentionToken === null) return;
    const caret = ta.selectionStart ?? text.length;
    const { at } = mentionToken;
    const next = `${text.slice(0, at)}@${relPath} ${text.slice(caret)}`;
    setText(next);
    setMentionQuery(null);
    setMentionHits([]);
    requestAnimationFrame(() => {
      const pos = at + relPath.length + 2;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function submit() {
    const value = text.trim();
    const hasPayload = value !== "" || images.length > 0 || attachments.length > 0 || contexts.length > 0;
    if (!hasPayload || sendBlocked) return;
    // The draft is gone once sent — a rewrite still in flight would
    // ghost-fill the cleared composer, so cancel it first.
    cancelInflightRef.current();
    send({
      type: "sendPrompt",
      text:
        value ||
        (contexts.length > 0
          ? t("（见附带的上下文）")
          : attachments.length > 0
            ? t("（见附件）")
            : t("（见附图）")),
      images: images.length > 0 ? images.filter((img) => img.data) : undefined,
      files: attachments.length > 0 ? attachments.map(({ name, path }) => ({ name, path })) : undefined,
      contexts: contexts.length > 0 ? contexts : undefined,
    });
    setText("");
    setImages([]);
    setAttachments([]);
    setContexts([]);
    setMentionQuery(null);
    setHistIndex(-1);
    histDraft.current = null;
    histEntryRef.current = null;
    editedRecall.current = false;
  }

  // --- ↑/↓ prompt-history recall (shell style) ------------------------------
  // History is read imperatively at keypress time (useChat.getState()) instead
  // of subscribing to `blocks`: a blocks selector would re-render the whole
  // composer on every blockPatch and undo the P2-1 selector split.
  // histIndex: -1 = not browsing; 0 = newest entry; k = k+1-th newest.
  // histDraft holds the pre-browsing buffer, restored when ↓ walks past the
  // newest entry back out of history.
  const [histIndex, setHistIndex] = useState(-1);
  const histDraft = useRef<string | null>(null);
  const histEntryRef = useRef<string | null>(null);
  const editedRecall = useRef(false);
  const activeSessionId = useChat((s) => s.state?.activeSessionId ?? null);

  // P0-4: empty-state example chips fill the composer through the store.
  // Never clobber a typed draft (same discipline as the queue-edit round
  // trip) — the request is consumed either way so a later click can re-fire.
  const draftRequest = useChat((s) => s.composerDraftRequest);
  useEffect(() => {
    if (!draftRequest) return;
    if (textRef.current.trim() !== "") {
      useChat.getState().clearDraftRequest(draftRequest.seq);
      return;
    }
    setText(draftRequest.text);
    useChat.getState().clearDraftRequest(draftRequest.seq);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, [draftRequest]);

  // A history buffer belongs to one session. Reset it before a restored/new
  // session can reuse the composer instance, otherwise ArrowDown may restore
  // the previous session's draft into the new session.
  useEffect(() => {
    setHistIndex(-1);
    histDraft.current = null;
    histEntryRef.current = null;
    editedRecall.current = false;
    // Session changed: the host drops the rewrite on its session-isolation
    // check WITHOUT replying, so the wand must be reset locally here or it
    // would spin forever. cancelInflight also tells the host to abort.
    cancelInflightRef.current();
  }, [activeSessionId]);

  /** Newest-first user prompts of the current session (deduped upstream). */
  function getUserHistory(): string[] {
    const blocks = useChat.getState().state?.blocks ?? [];
    return collectUserPromptTexts(blocks).reverse();
  }

  function setCaretToEnd(): void {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  /** Recall writes the textarea directly (no onChange), so the @-mention
   * popup — driven by `mentionQuery` — would keep stale hits on screen. */
  function closeMention(): void {
    setMentionQuery(null);
    setMentionHits([]);
  }

  function applyRecall(value: string): void {
    histEntryRef.current = value;
    setText(value);
    closeMention();
    setCaretToEnd();
  }

  /** dir=-1 recalls an older prompt, dir=+1 a newer one (or the draft).
   * Returns true when the keystroke was consumed. */
  function recallHistory(dir: -1 | 1): boolean {
    // The @-mention popup being OPEN (even with zero hits) means the user is
    // mid-token — recall would replace the whole draft including the "@…"
    // fragment. The popup's own ArrowUp/Down branches only fire when hits
    // exist, so the guard belongs here rather than in the popup branch.
    if (mentionQuery !== null) return false;
    if (editedRecall.current) {
      editedRecall.current = false;
      return false;
    }
    const ta = taRef.current;
    if (!ta || ta.selectionStart === null || ta.selectionEnd === null) return false;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    if (histIndex >= 0 && text !== histEntryRef.current) {
      setHistIndex(-1);
      histDraft.current = null;
      histEntryRef.current = null;
      return false;
    }
    if (dir === -1) {
      // ↑ only recalls while the caret sits on the FIRST line — multi-line
      // navigation inside the draft keeps its normal meaning.
      const before = ta.value.slice(0, ta.selectionStart);
      if (before.includes("\n")) return false;
      const hist = getUserHistory();
      if (hist.length === 0) return false;
      if (histIndex < 0) {
        histDraft.current = text;
        setHistIndex(0);
        applyRecall(hist[0] ?? "");
        return true;
      }
      if (histIndex >= hist.length - 1) return true; // already at the oldest — swallow
      const next = histIndex + 1;
      setHistIndex(next);
      applyRecall(hist[next] ?? "");
      return true;
    }
    // ↓: only while browsing history AND the caret is on the LAST line.
    if (histIndex < 0) return false;
    const after = ta.value.slice(ta.selectionEnd);
    if (after.includes("\n")) return false;
    const hist = getUserHistory();
    if (histIndex === 0) {
      setHistIndex(-1);
      applyRecall(histDraft.current ?? "");
      histDraft.current = null;
      histEntryRef.current = null;
      return true;
    }
    const next = histIndex - 1;
    setHistIndex(next);
    applyRecall(hist[next] ?? "");
    return true;
  }

  return (
    <div
      ref={rootRef}
      className={`acrylic @container relative z-20 flex flex-col shrink-0 border-t p-3 transition-colors ${
        dragOver ? "border-primary/60 bg-primary/5" : "border-border"
      }`}
      style={{ height: height ?? undefined, boxShadow: "var(--shadow-stage)" }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Top-edge drag handle to resize the composer height. */}
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize hover:bg-primary/30"
        title={t("拖拽调整高度")}
        onMouseDown={startResize}
      />
      {/* M2 P0-3: queued-message strip (own subscription to state.queue). */}
      <QueueStrip />
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-primary/5 text-ui-label font-medium text-primary">
          {t("拖放文件以添加附件")}
        </div>
      )}
      {/* non-image attachment chips + rejected-file note */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((f) => (
            <span
              key={f.id}
              className="card-lift inline-flex max-w-[min(260px,100%)] items-center gap-1 rounded-lg border border-border bg-surface/80 px-1.5 py-1 text-ui-caption text-foreground shadow-card"
              title={f.path}
            >
              <FileText className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">{f.name}</span>
              <button
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive"
                title={t("移除")}
                aria-label={t("移除")}
                onClick={() => removeAttachment(f.id)}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* M2 P0-4 context sources: right-click selection + @folder/@problems/
          @git/@url; the host assembles every card into a titled fenced section
          ahead of the typed text at send time.
          UI-audit 4.6: collapsed to one-line chips (icon + name + range + size)
          — the raw <pre> used to dominate the composer once a few sources were
          attached. Click a chip for the preview; at most CONTEXT_CHIP_MAX chips
          show, the rest fold into "+N". */}
      {contexts.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {(showAllContexts ? contexts : contexts.slice(0, CONTEXT_CHIP_MAX)).map((c) => {
              const Icon = contextIcon(c.kind);
              const open = expandedContextId === c.id;
              return (
                <span
                  key={c.id}
                  className={`inline-flex max-w-full items-center gap-0.5 rounded-lg border bg-surface/80 py-0.5 pl-1.5 pr-0.5 text-ui-caption shadow-card transition-colors ${
                    open ? "border-primary/50" : "border-border hover:bg-surface-2"
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1.5 rounded text-left text-foreground"
                    aria-expanded={open}
                    title={open ? t("收起") : t("展开上下文")}
                    onClick={() => setExpandedContextId(open ? null : c.id)}
                  >
                    <Icon className="size-3.5 shrink-0 text-primary" />
                    <span className="max-w-[150px] truncate font-mono" title={c.label}>
                      {c.label}
                    </span>
                    {c.detail && (
                      <span className="shrink-0 rounded border border-border bg-surface px-1 font-mono text-ui-micro text-muted-foreground">
                        {c.detail}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-ui-micro tabular-nums text-muted-foreground/80">
                      {t("{0} 字符", c.content.length.toLocaleString())}
                    </span>
                    <ChevronDown
                      className={`size-3 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive"
                    title={t("移除")}
                    aria-label={t("移除")}
                    onClick={() => removeContext(c.id)}
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              );
            })}
            {contexts.length > CONTEXT_CHIP_MAX && (
              <button
                type="button"
                className="press inline-flex h-6 shrink-0 items-center rounded-lg border border-border bg-surface/80 px-2 font-mono text-ui-caption text-muted-foreground shadow-card transition-colors hover:bg-surface-2 hover:text-foreground"
                title={showAllContexts ? t("收起") : t("展开全部 {0} 张上下文卡", contexts.length)}
                onClick={() => setShowAllContexts((v) => !v)}
              >
                {showAllContexts ? t("收起") : `+${contexts.length - CONTEXT_CHIP_MAX}`}
              </button>
            )}
          </div>
          {expandedContext && (
            <div className="code-context-card overflow-hidden rounded-lg border border-border bg-editor shadow-card">
              <div className="flex items-center gap-1.5 border-b border-border/70 bg-surface/60 px-2.5 py-1.5">
                {(() => {
                  const Icon = contextIcon(expandedContext.kind);
                  return <Icon className="size-3.5 shrink-0 text-primary" />;
                })()}
                <span className="truncate font-mono text-ui-caption text-foreground" title={expandedContext.label}>
                  {expandedContext.label}
                </span>
                <button
                  type="button"
                  className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                  title={t("收起")}
                  aria-label={t("收起")}
                  onClick={() => setExpandedContextId(null)}
                >
                  <ChevronDown className="size-3.5 rotate-180" />
                </button>
              </div>
              {expandedContext.kind === "code" ? (
                <pre className="max-h-40 overflow-auto px-2.5 py-2 font-mono text-ui-caption leading-[1.6] text-foreground/90">
                  {expandedContext.content}
                </pre>
              ) : (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap px-2.5 py-1.5 font-mono text-ui-caption leading-[1.55] text-muted-foreground">
                  {expandedContext.content}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <span
              key={i}
              className="relative inline-flex size-[52px] items-center justify-center overflow-hidden rounded-md border border-border"
              title={img.mimeType}
            >
              {img.data ? (
                <img src={`data:${img.mimeType};base64,${img.data}`} alt="" className="size-full object-cover" />
              ) : (
                <ImageIcon className="size-4 text-muted-foreground" />
              )}
              <button
                className="absolute right-0 top-0 flex size-6 items-center justify-center rounded-bl-lg bg-black/55 text-white transition-colors hover:bg-black/75"
                title={t("移除")}
                aria-label={t("移除")}
                onClick={() => removeImage(i)}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* slash-command popup: all prefix matches, keyboard navigable */}
      {cmdMatches.length > 0 && (
        <div className="acrylic-pop dropdown-in absolute inset-x-3 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-xl border border-border">
          {cmdMatches.map((c, i) => (
            <button
              key={c.name}
              ref={i === cmdIndex ? cmdActiveRef : undefined}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-label ${
                i === cmdIndex ? "bg-accent/70" : "hover:bg-accent/50"
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(`/${c.name} `);
                taRef.current?.focus();
              }}
            >
              <span className="font-mono text-primary">/{c.name}</span>
              <span className="truncate text-ui-caption text-muted-foreground">{c.description}</span>
              {i === cmdIndex && (
                <kbd className="ml-auto rounded border border-border px-1 font-mono text-ui-micro text-muted-foreground">
                  {t("Tab 补全")}
                </kbd>
              )}
            </button>
          ))}
        </div>
      )}

      {/* @-mention popup (M2 P0-4): source-action rows (@problems / @git /
          @url) first, then file or folder hits. Selecting a source resolves a
          context card via the host instead of inserting text. */}
      {mentionQuery !== null && (
        <div className="acrylic-pop dropdown-in absolute inset-x-3 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-xl border border-border">
          {sourceActions.map((a, i) => {
            const Icon = a.icon;
            return (
              <button
                key={`src-${a.kind}`}
                ref={i === mentionIndex ? mentionActiveRef : undefined}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-label ${
                  i === mentionIndex ? "bg-accent/70" : "hover:bg-accent/50"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (a.kind === "url") attachUrlContext();
                  else resolveKeywordContext(a.kind);
                }}
              >
                <Icon className="size-3.5 shrink-0 text-primary" />
                <span className="font-mono text-ui-caption text-primary">
                  @{a.kind === "url" ? `url:${a.label}` : a.keyword}
                </span>
                <span className="truncate text-ui-caption text-muted-foreground">{a.label}</span>
              </button>
            );
          })}
          {mentionKind !== "url" && mentionHits.length === 0 && sourceActions.length === 0 && (
            <div className="px-3 py-1.5 text-ui-label text-muted-foreground">
              {mentionKind === "folder" ? t("无匹配文件夹") : t("无匹配文件")}
            </div>
          )}
          {mentionKind !== "url" &&
            mentionHits.map((hit, i) => {
              const idx = sourceActions.length + i;
              return (
                <button
                  key={hit.path}
                  ref={idx === mentionIndex ? mentionActiveRef : undefined}
                  className={`flex w-full items-baseline gap-1 px-3 py-1.5 text-left text-ui-label ${
                    idx === mentionIndex ? "bg-accent/70" : "hover:bg-accent/50"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (mentionKind === "folder") resolveFolderContext(hit.path);
                    else insertMention(hit.path);
                  }}
                >
                  {mentionKind === "folder" && <FolderIcon className="size-3 shrink-0 self-center text-primary" />}
                  {hit.path.split("/").slice(0, -1).join("/") && (
                    <span className="min-w-0 truncate text-ui-caption text-muted-foreground">
                      {hit.path.split("/").slice(0, -1).join("/")}/
                    </span>
                  )}
                  {/* break-all: an unbroken long basename would otherwise force
                      horizontal scroll on the max-h-56 popup (single-axis overflow
                      makes the other axis auto). */}
                  <span className="break-all font-medium">{hit.path.split("/").pop()}</span>
                </button>
              );
            })}
        </div>
      )}

      {/* Turn-end prediction in flight: the pill sits in the chips' slot so
          the wait is visible instead of the row appearing from nowhere. */}
      {suggestionsLoading && (suggestions?.length ?? 0) === 0 && !suggestionsHidden && (
        <div
          className="mb-2 flex items-center gap-1 rounded-lg border border-border bg-surface/80 px-2 py-1 text-ui-caption text-muted-foreground shadow-card"
          aria-label={t("预测下一步操作…")}
        >
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate">{t("预测下一步操作…")}</span>
        </div>
      )}

      {/* Turn-end next-step suggestions: candidate-word chips from one
          dedicated model call. Click inserts at the caret and keeps the rest
          of the batch on screen; only the close button (or the host clearing
          the batch when the user actually sends) retires the row. */}
      {suggestions && suggestions.length > 0 && !suggestionsHidden && (
        <div
          className="mb-2 flex flex-wrap items-center gap-1.5"
          aria-label={t("AI 推测的下一步操作，点击填入输入框")}
        >
          <span className="inline-flex shrink-0 items-center gap-1 text-ui-caption text-muted-foreground">
            <Sparkles className="size-3" />
            {t("建议")}
          </span>
          {/* UI-audit 4.6: neutral chips (primary used to compete with the send
              button for attention) and at most 3 candidates. */}
          {suggestions.slice(0, 3).map((s) => (
            <button
              key={s}
              className="press inline-flex max-w-full items-center rounded-lg border border-border bg-surface/80 px-2 py-1 text-ui-caption text-foreground shadow-card transition-colors hover:bg-surface-2"
              title={t("AI 推测的下一步操作，点击填入输入框")}
              onClick={() => applySuggestion(s)}
            >
              <span className="truncate">{s}</span>
            </button>
          ))}
          <button
            className="press ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            title={t("关闭建议")}
            aria-label={t("关闭建议")}
            onClick={() => setSuggestionsHidden(true)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-editor/60 shadow-card transition-all duration-300 focus-within:border-primary/50 focus-within:shadow-focus">
        <textarea
          ref={taRef}
          value={text}
          placeholder={enqueueMode ? t("排队发送（Enter）") : t("向 iFlow 提问…")}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-3 text-ui-body leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80"
          onChange={(e) => {
            if (histIndex >= 0 && e.target.value !== histEntryRef.current) {
              setHistIndex(-1);
              histDraft.current = null;
              histEntryRef.current = null;
              editedRecall.current = true;
            }
            setText(e.target.value);
            updateMentionFromCaret(e.target.value);
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return; // plain text paste: let it through
            e.preventDefault();
            const imgs = files.filter(isImageFile);
            const others = files.filter((f) => !isImageFile(f));
            if (imgs.length > 0) addImages(imgs);
            if (others.length > 0) addOtherFiles(others);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return;
            if (cmdMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCmdIndex((i) => Math.min(cmdMatches.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCmdIndex((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                setText(`/${cmdMatches[cmdIndex]!.name} `);
                return;
              }
              // 斜杠弹窗打开时 ESC 只吞掉按键（弹窗由输入内容驱动，无独立
              // 关闭态），阻止冒泡到 window 的「ESC 停止生成」。
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
            }
            if (mentionQuery !== null) {
              if (e.key === "ArrowDown" && popupRowCount > 0) {
                e.preventDefault();
                setMentionIndex((i) => Math.min(popupRowCount - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp" && popupRowCount > 0) {
                e.preventDefault();
                setMentionIndex((i) => Math.max(0, i - 1));
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && popupRowCount > 0) {
                e.preventDefault();
                const srcCount = sourceActions.length;
                if (mentionIndex < srcCount) {
                  const a = sourceActions[mentionIndex]!;
                  if (a.kind === "url") attachUrlContext();
                  else resolveKeywordContext(a.kind);
                } else {
                  const hit = mentionHits[mentionIndex - srcCount];
                  if (hit) {
                    if (mentionKind === "folder") resolveFolderContext(hit.path);
                    else insertMention(hit.path);
                  }
                }
                return;
              }
              // 弹窗开着（含无匹配）时 ESC 只关闭弹窗，不触发停止生成。
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMentionQuery(null);
                return;
              }
            }
            // History recall: never while an IME composition is open (the
            // arrows belong to the candidate picker) or mid-@-mention.
            if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && recallHistory(-1)) {
              e.preventDefault();
              return;
            }
            if (e.key === "ArrowDown" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && recallHistory(1)) {
              e.preventDefault();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {/* P1-7: fixed single row, two zones — left = session settings +
            status (shrinks via truncate / icon-only degradation), right =
            actions at a constant anchor. No flex-wrap: wrapping used to drop
            buttons to a second line and drift the send key's position. */}
        <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2 pt-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* permission mode dropdown */}
          {modes && currentMode && (
            <Dropdown
              direction="up"
              menuClass="w-56 max-w-[calc(100vw_-_24px)]"
              disabled={modeLocked}
              trigger={(open) => (
                <button
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className={`${CANVAS_BTN}${open ? " bg-surface-2" : ""}`}
                  title={t("权限模式")}
                  disabled={modeLocked}
                >
                  <Zap className="size-3.5 shrink-0 text-primary" />
                  <span className="@max-[340px]:hidden">{currentMode ? modeDisplay(currentMode).label : ""}</span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-60 @max-[340px]:hidden" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {modes.availableModes.map((m) => {
                    const view = modeDisplay(m);
                    return (
                      <button
                        key={m.id}
                        role="menuitem"
                        onClick={() => {
                          if (m.id !== modes.currentModeId) {
                            beginPending("mode", m.id);
                            send({ type: "setMode", modeId: m.id });
                          }
                          close();
                        }}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent/50"
                      >
                        <span className="text-ui-label text-foreground">
                          {view.label}
                          {m.id === modes.currentModeId && (
                            <Check className="ml-1 inline size-3 text-primary" />
                          )}
                        </span>
                        <span className="text-ui-caption text-muted-foreground">{view.desc}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </Dropdown>
          )}

          {/* model dropdown — refreshed at open time: the host re-queries
              GET {baseUrl}/models, so newly added gateway models show up
              without restarting the session.
              UI-audit 4.6: ONE chip carries model + usage (occupancy bar and
              cost ride the trigger; the full breakdown lives in the status-bar
              tooltip, NOT in this menu), and the reasoning level is a sticky
              footer row here instead of its own control. The trigger shows the
              display NAME — it used to show the raw id while the menu listed
              names, so the two disagreed. */}
          {models.length > 0 && (
            <Dropdown
              direction="up"
              menuClass="w-60 max-w-[calc(100vw-24px)] max-h-[min(60vh,22rem)] overflow-y-auto"
              disabled={controlsLocked}
              onOpenChange={(o) => {
                setModelMenuOpen(o);
                setThinkPanel(false);
                if (o) {
                  send({ type: "refreshModels" });
                  // keyboard highlight starts on the active model, not the top
                  const idx = currentModelId ? models.findIndex((m) => m.id === currentModelId) : -1;
                  setModelIndex(idx >= 0 ? idx : 0);
                } else {
                  setModelQuery("");
                }
              }}
              trigger={(open) => (
                <button
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className={`${CANVAS_BTN} min-w-0${open ? " bg-surface-2" : ""}`}
                  title={t("模型")}
                  disabled={controlsLocked}
                >
                  <span className="max-w-[130px] truncate @max-[520px]:max-w-[84px] @max-[340px]:max-w-[60px]">
                    {currentModelName}
                  </span>
                  <SessionUsageChip />
                  <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {/* fuzzy search box: matches name and id; sticky so it stays
                      visible while the list scrolls. UI-audit 4.6: only worth a
                      row once the catalog is long enough to need filtering. */}
                  {models.length > MODEL_SEARCH_MIN && (
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-panel/50 p-1.5 backdrop-blur-md">
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-editor px-3 py-2 transition-colors duration-200 focus-within:border-primary/40 focus-within:shadow-focus-soft">
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        value={modelQuery}
                        placeholder={t("搜索模型…")}
                        className="w-full min-w-0 bg-transparent font-mono text-ui-caption text-foreground outline-none placeholder:text-muted-foreground/80"
                        onChange={(e) => setModelQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setModelIndex((i) => Math.min(filteredModels.length - 1, i + 1));
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setModelIndex((i) => Math.max(0, i - 1));
                          } else if (e.key === "Enter") {
                            const hit = filteredModels[modelIndex];
                            if (!hit) return;
                            e.preventDefault();
                            if (hit.m.id !== currentModelId) {
                              beginPending("model", hit.m.id);
                              send({ type: "setModel", modelId: hit.m.id });
                            }
                            close();
                          }
                        }}
                      />
                    </div>
                  </div>
                  )}
                  {filteredModels.length === 0 && (
                    <div className="px-3 py-2 text-ui-label text-muted-foreground">{t("无匹配模型")}</div>
                  )}
                  {filteredModels.map(({ m }, i) => (
                    <button
                      key={m.id}
                      role="menuitem"
                      ref={m.id === currentModelId ? currentModelRef : undefined}
                      onClick={() => {
                        if (m.id !== currentModelId) {
                          beginPending("model", m.id);
                          send({ type: "setModel", modelId: m.id });
                        }
                        close();
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                        i === modelIndex ? "bg-accent/70" : "hover:bg-accent/50"
                      }`}
                    >
                      {/* UI-audit 4.6: primary line = friendly name, secondary =
                          the raw id. Gateways reuse display names, so the id is
                          what actually disambiguates two entries. */}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-ui-label text-foreground" title={m.name}>
                          {m.name}
                        </span>
                        <span className="truncate font-mono text-ui-micro text-muted-foreground/80" title={m.id}>
                          {m.id}
                        </span>
                      </span>
                      {m.id === currentModelId && (
                        <Check className="ml-auto size-3 shrink-0 text-primary" />
                      )}
                    </button>
                  ))}

                  {/* UI-audit 4.6 (revised 2026-10-20): the reasoning level is a
                      STICKY footer row, never a section appended after the
                      list — some gateways expose dozens of models, so anything
                      at the end of a long scrolling list is unreachable.
                      Clicking the row swaps the footer for the four levels. */}
                  <div className="sticky bottom-0 z-10 border-t border-border/60 bg-panel/60 backdrop-blur-md">
                    {thinkPanel ? (
                      <div
                        ref={thinkPanelRef}
                        className="py-1"
                        onKeyDown={(e) => {
                          if (e.key !== "Escape") return;
                          // Esc backs out one level (panel → row) instead of
                          // dismissing the whole model menu; stopPropagation
                          // keeps Dropdown's document-level Escape closer out.
                          e.preventDefault();
                          e.stopPropagation();
                          setThinkPanel(false);
                          requestAnimationFrame(() => thinkRowRef.current?.focus());
                        }}
                      >
                        <button
                          role="menuitem"
                          className="flex w-full items-center gap-1 px-3 py-1 text-left text-ui-caption text-muted-foreground hover:bg-accent/50"
                          onClick={() => {
                            setThinkPanel(false);
                            // the clicked node disappears: hand focus back to
                            // the row that replaces it.
                            requestAnimationFrame(() => thinkRowRef.current?.focus());
                          }}
                        >
                          <ChevronLeft className="size-3.5 shrink-0" />
                          <span>{t("思考级别")}</span>
                        </button>
                        {THINK_LEVELS.map(([level, label, desc]) => {
                          const blocked = thinkUnsupported && level !== "auto";
                          return (
                            <button
                              key={level}
                              role="menuitem"
                              onClick={() => {
                                if (level !== thinkLevel && !blocked) {
                                  beginPending("think", level);
                                  send({ type: "setThink", level });
                                }
                                close();
                              }}
                              title={blocked ? t("当前模型不支持思考模式") : undefined}
                              className={`flex w-full flex-col items-start px-3 py-1 text-left hover:bg-accent/50 ${blocked ? "opacity-45" : ""}`}
                            >
                              <span className="text-ui-label text-foreground">
                                {t(label)}
                                {level === thinkLevel && <Check className="ml-1 inline size-3 text-primary" />}
                              </span>
                              <span className="text-ui-caption text-muted-foreground">{t(desc)}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <button
                        role="menuitem"
                        ref={thinkRowRef}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
                        onClick={() => setThinkPanel(true)}
                      >
                        <Brain className="size-3.5 shrink-0 text-primary" />
                        <span className="text-ui-label text-foreground">{t("思考级别")}</span>
                        <span className="ml-auto flex items-center gap-1 text-ui-caption text-muted-foreground">
                          {t(THINK_LEVELS.find(([level]) => level === thinkLevel)?.[1] ?? "自动")}
                          <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                        </span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </Dropdown>
          )}

          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* UI-audit 4.6: the wand only appears once there is something to
                enhance (or a rewrite to undo) — an always-present disabled
                button just widened the row. */}
            {(text.trim() !== "" || enhancing || enhanceOriginal.current !== null) && (
              <button
                className={`${CANVAS_BTN}${enhanceOriginal.current !== null ? " text-primary" : ""}`}
                title={
                  enhancing
                    ? t("正在增强，点击取消")
                    : enhanceOriginal.current !== null
                      ? t("还原原始输入")
                      : t("增强提示词（AI 改写为更清晰的请求）")
                }
                disabled={!enhancing && (controlsLocked || (!text.trim() && enhanceOriginal.current === null))}
                onClick={enhance}
              >
                {enhancing ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              </button>
            )}
            <button
              className={CANVAS_BTN}
              title={t("添加附件")}
              disabled={controlsLocked}
              onClick={() => send({ type: "pickAttachments" })}
            >
              <Paperclip className="size-3.5" />
            </button>
            {/* P1-7: stop and send share ONE slot (swap in place) — the old
                separate stop button made the primary action area jump every
                time a turn started/ended. Queuing stays on Enter (the
                textarea's enqueueMode placeholder says so). */}
            {canStop ? (
              <button
                className="press inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface h-7 px-3 text-ui-caption font-semibold text-foreground shadow-btn transition-all duration-200 hover:bg-surface-2 active:brightness-95"
                title={t("停止生成")}
                onClick={() => send({ type: "cancel" })}
              >
                <Square className="size-3.5" /> <span className="@max-[340px]:hidden">{t("停止")}</span>
              </button>
            ) : (
              <button
                className={
                  enqueueMode
                    ? "press inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-primary/50 bg-primary/15 h-7 px-3 text-ui-caption font-semibold text-primary shadow-btn transition-all duration-200 hover:bg-primary/25 active:brightness-95 disabled:pointer-events-none disabled:opacity-40"
                    : "press inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-gradient-to-b from-primary to-primary/90 h-7 px-3 text-ui-caption font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 active:brightness-95 disabled:pointer-events-none disabled:opacity-40"
                }
                title={enqueueMode ? t("排队发送 (Enter)") : t("发送 (Enter)")}
                disabled={sendBlocked || (!text.trim() && images.length === 0 && attachments.length === 0 && contexts.length === 0)}
                onClick={submit}
              >
                {enqueueMode ? <ListOrdered className="size-3.5" /> : <SendHorizontal className="size-3.5" />}{" "}
                <span className="@max-[340px]:hidden">{enqueueMode ? t("排队") : t("发送")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
