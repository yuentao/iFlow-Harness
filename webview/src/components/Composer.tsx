import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileText,
  Folder as FolderIcon,
  FolderTree,
  GitBranch,
  Globe,
  Image as ImageIcon,
  ListOrdered,
  Loader2,
  Paperclip,
  Radio,
  SendHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Unplug,
  Wand2,
  X,
} from "lucide-react";
import { collectUserPromptTexts, type ContextRefUi, type FileHitUi, type ModelInfoUi, type ModelMetadataSource, type SkillInfo, type SlashCommand, type ThinkLevel, type UsageNumberSource } from "../../../shared/messages";
import { SKILL_COMMAND } from "../../../shared/skills";
import { isTerminalSuperStatus } from "../../../shared/super-agent";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, CANVAS_CHIP, Chip, ConfirmDialog, Dropdown, ICON_INLINE, IconButton, SearchInput, TextInput, ToggleChip, fuzzyScore } from "./ui";

/** One attached image (base64, no data: prefix). */
export interface ImageAttachment {
  data: string;
  mimeType: string;
  /**
   * 用户为这张图写的单行说明（多模态方案 C）。随 `sendPrompt.imageCaptions`
   * 发给宿主，写进转录并进入模型可见的图片清单；空/缺失表示无说明。
   */
  caption?: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Cap for staging non-image files through the host (base64 round-trip). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Failsafes for the composer's request-in-flight indicators. Each control
 * that locks itself while waiting for a host reply must release even when the
 * reply never lands (host crash / dropped message) — a spinner stuck forever
 * is worse than no spinner.
 */
const MENTION_SEARCH_TIMEOUT_MS = 10_000;
const CONTEXT_RESOLVE_TIMEOUT_MS = 15_000;
const STAGE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

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
const EMPTY_SKILLS: SkillInfo[] = [];
const EMPTY_MODELS: ModelInfoUi[] = [];

/**
 * 面板本地 slash 指令：`/memory-curate` 立即跑一轮记忆整理。
 *
 * 它不是 CLI 指令（CLI 不认识，会被当成 unknown command 而模型看不到），
 * 也不该走模型：与记忆页的「整理记忆」按钮一样直接调用宿主
 * `curateMemoryNow`（同一条 MaintenanceScheduler 通道）。
 */
export const MEMORY_CURATE_COMMAND = "memory-curate";

/** 文本是否恰好是该指令（允许前后空白；带参数时按普通提示词处理）。 */
export function isMemoryCurateCommand(text: string): boolean {
  return text.trim().toLowerCase() === `/${MEMORY_CURATE_COMMAND}`;
}

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
  // T-2/3/4 provenance: read as PRIMITIVES so the clone-on-patch behavior of
  // postMessage cannot re-render this leaf on every streamed block. A missing
  // field is null — the UI must then say 来源未知, never assume authoritative.
  const sourceContextUsed = useChat((s) => s.state?.usage?.sources?.contextUsed ?? null);
  const sourceSplit = useChat((s) => s.state?.usage?.sources?.split ?? null);
  const sourceWindow = useChat((s) => s.state?.usage?.sources?.window ?? null);
  const sourceCost = useChat((s) => s.state?.usage?.sources?.cost ?? null);
  const capturedAt = useChat((s) => s.state?.usage?.capturedAt ?? null);
  const sourceUrl = useChat((s) => s.state?.usage?.sourceUrl ?? null);
  const bdUser = useChat((s) => s.state?.usage?.breakdown?.user ?? 0);
  const bdAssistant = useChat((s) => s.state?.usage?.breakdown?.assistant ?? 0);
  const bdTool = useChat((s) => s.state?.usage?.breakdown?.tool ?? 0);
  const bdThought = useChat((s) => s.state?.usage?.breakdown?.thought ?? 0);
  const bdPrefill = useChat((s) => s.state?.usage?.breakdown?.prefill ?? 0);
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
    sourceContextUsed,
    sourceSplit,
    sourceWindow,
    sourceCost,
    capturedAt,
    sourceUrl,
    bdUser,
    bdAssistant,
    bdTool,
    bdThought,
    bdPrefill,
  };
}

type Usage = ReturnType<typeof useUsage>;

function usageBarTone(pct: number): string {
  return pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary/70";
}

/**
 * T-2/3/4 — 用量来源「一眼可读」标签。所有标签只是把宿主 U1 `sources`
 * 描述的既有计算路径翻译成中文，不重新推算、不打分。来源缺失一律返回
 * 「来源未知」，绝不能回退成「内核上报 / 权威」——把估算冒充实测正是本
 * 单元要消灭的问题。
 */
function usageNumberLabel(src: UsageNumberSource | null): string {
  switch (src) {
    case "kernel-report":
      return t("内核上报");
    case "transcript-estimate":
      return t("转录估算");
    case "lower-bound":
      return t("下界");
    default:
      return t("来源未知");
  }
}

function modelMetadataLabel(src: ModelMetadataSource | null): string {
  switch (src) {
    case "user":
      return t("用户配置");
    case "builtin-table":
      return t("内置表");
    case "ai-supplement":
      return t("AI 补充");
    // 五档权威链的第 2/3 档（占用条与 CLI 共用同一 resolver）：数值来自活动
    // API 配置档 / 内核 settings.json 顶层，不是猜测出来的估算值。
    case "profile":
      return t("API 配置");
    case "settings":
      return t("内核配置");
    case "fallback-estimate":
      return t("回退估算");
    default:
      return t("来源未知");
  }
}

/** 占用条 / 拆分数字前缀：权威无前缀、转录估算 ≈、下界 ≥、未知 ?（不裸奔成权威）。 */
function usageNumberPrefix(src: UsageNumberSource | null): string {
  switch (src) {
    case "kernel-report":
      return "";
    case "transcript-estimate":
      return "≈";
    case "lower-bound":
      return "≥";
    default:
      return "?";
  }
}

/** 成本前缀：用户配置 / 内置表 / AI 补充单价视为已知值（无前缀），回退估算加 ≈，未知 ?。 */
function costPrefix(src: ModelMetadataSource | null): string {
  switch (src) {
    case "user":
    case "builtin-table":
    case "ai-supplement":
      return "";
    case "fallback-estimate":
      return "≈";
    default:
      return "?";
  }
}

/** 采集时间的诚实文案：缺失就说来源未知，不伪造时间戳。 */
function capturedAtLabel(at: number | null): string {
  return at != null && Number.isFinite(at) ? new Date(at).toLocaleString() : t("来源未知");
}

/** Full breakdown, shared by the chip's tooltip and the menu summary.
 * The breakdown carries the PREFILL bucket — the fixed per-request overhead
 * the model reads on every request (system prompt / memory / tool
 * declarations). Without it the occupancy looked like "the conversation so
 * far" while the model actually reads tens of thousands of tokens of
 * instructions. In the estimate path a caveat line marks the number as a
 * lower bound: the CLI's built-in tool declarations and its directory
 * listing never reach the ACP wire, so only the kernel-reported number
 * covers them. */
function usageTooltip(u: Usage): string {
  const breakdownLine =
    u.bdPrefill > 0
      ? t(
          "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3} · 固定开销 {4}",
          u.bdUser.toLocaleString(),
          u.bdAssistant.toLocaleString(),
          u.bdTool.toLocaleString(),
          u.bdThought.toLocaleString(),
          u.bdPrefill.toLocaleString(),
        )
      : t(
          "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}",
          u.bdUser.toLocaleString(),
          u.bdAssistant.toLocaleString(),
          u.bdTool.toLocaleString(),
          u.bdThought.toLocaleString(),
        );
  const prefillNote = u.bdPrefill > 0 ? t("固定开销 = 系统提示词、记忆和工具说明，每次请求都要带上") : "";
  const caveatLine = !u.usageAuthoritative && u.bdPrefill > 0 ? t("估算没有算上内核内置的工具说明和目录清单") : "";
  // T-4：ACP wire 不带输入/输出拆分，拆分永远是转录估算；按 sources.split
  // 如实标注，缺失就标「来源未知」而不是冒称权威。
  const splitLine = t(
    "输入 {0}{1} tokens · 输出 {2}{3} tokens（拆分来源：{4}）",
    usageNumberPrefix(u.sourceSplit),
    u.inputTokens.toLocaleString(),
    usageNumberPrefix(u.sourceSplit),
    u.outputTokens.toLocaleString(),
    usageNumberLabel(u.sourceSplit),
  );
  // T-2：一行说清 token 从哪来、单价从哪来、什么时候采集、引用了哪个链接。
  // 每个分量独立处理缺失，绝不拼出一个「看起来很准」的假来源。
  const provenanceLine = t(
    "数据出处：token {0} · 单价 {1} · 采集 {2} · {3}",
    usageNumberLabel(u.sourceContextUsed),
    modelMetadataLabel(u.sourceCost),
    capturedAtLabel(u.capturedAt),
    u.sourceUrl ? t("来源链接：{0}", u.sourceUrl) : t("无来源链接"),
  );
  const windowLine = t("窗口来源：{0}", modelMetadataLabel(u.sourceWindow));
  const costLine =
    u.estimatedCost !== null
      ? t("预估成本 {0}（按公开单价估算）", costPrefix(u.sourceCost) + formatCost(u.estimatedCost))
      : t("该模型无单价记录，不显示成本");
  return u.pct === null
    ? [
        t(
          u.usageAuthoritative
            ? "当前上下文 {0} tokens（内核上报）"
            : "当前上下文约 {0} tokens（本地估算；压缩后按压缩结果重算）",
          (u.usageAuthoritative ? u.contextUsed : u.inputTokens).toLocaleString(),
        ),
        splitLine,
        breakdownLine,
        prefillNote,
        caveatLine,
        windowLine,
        provenanceLine,
      ]
        .filter(Boolean)
        .join("\n")
    : [
        t(
          "上下文占用 {0} / {1}（{2}%{3}{4}）",
          u.contextUsed.toLocaleString(),
          (u.contextWindow as number).toLocaleString(),
          u.pct,
          u.estimated ? t("，上限为估算值") : "",
          u.usageAuthoritative ? t("，占用为内核上报值") : "",
        ),
        splitLine,
        breakdownLine,
        prefillNote,
        caveatLine,
        u.cacheReadTokens > 0 ? t("缓存读取 {0} tokens", u.cacheReadTokens.toLocaleString()) : "",
        costLine,
        windowLine,
        provenanceLine,
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
export function SessionUsageChip() {
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
            {usageNumberPrefix(u.sourceContextUsed)}
            {u.pct}%
          </span>
        </span>
      )}
      {u.estimatedCost !== null && (
        <span className="ml-0.5 opacity-80" title={hoverTitle}>
          {costPrefix(u.sourceCost)}
          {formatCost(u.estimatedCost)}
        </span>
      )}
    </span>
  );
}

/** Round-trip id for the host's `queueEdited` reply (the queue strip that
 * used to consume it is gone; the listener stays for protocol parity). */
const queueEditSeqGlobal = { current: 0 };

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
  /** 远程接续按钮只在机器人已启用时渲染；状态来自设置页的 qqSettings 快照。 */
  const qqEnabled = useChat((s) => s.qqSettings?.enabled ?? false);
  /** host 权威的远程接续内存态：true 时冻结本地全部干预，转录仍只读可滚动。 */
  const remoteTakeover = useChat((s) => s.remoteTakeover ?? false);
  const commands = useChat((s) => s.state?.commands ?? EMPTY_COMMANDS);
  const skills = useChat((s) => s.state?.skills ?? EMPTY_SKILLS);
  const models = useChat((s) => s.state?.models ?? EMPTY_MODELS);
  const currentModelId = useChat((s) => s.state?.currentModelId ?? null);
  const thinkLevel = useChat((s) => s.state?.thinkLevel ?? "auto");
  /** Turn-end model predictions; host metadata, cleared when a new turn starts. */
  const suggestions = useChat((s) => s.state?.nextStepSuggestions);
  /** The prediction call is running: render the pill in the chips' slot. */
  const suggestionsLoading = useChat((s) => s.state?.nextStepLoading ?? false);
  // 子会话仍在跑时不能换模型（在途子会话会用错模型）。只供模型下拉用，
  // 不并入 controlsLocked —— 主会话跑子会话时仍必须能发消息 / enhance。
  const superActive = useChat((s) =>
    (s.state?.superSessions ?? []).some((session) => !isTerminalSuperStatus(session.status)),
  );
// Hard evidence only: thinking===false comes from an explicit
// iflow.thinkingModelRules entry (supportsThinking:false) evaluated by the
// host; unknown (undefined) stays ALLOWED — the CLI's own rejection is
// friendly-toasted in setThink instead of pre-gated here.
const thinkUnsupported = models.find((m) => m.id === currentModelId)?.thinking === false;
  const pending = useChat((s) => s.pending);
  const beginPending = useChat((s) => s.beginPending);
  const send = useChat((s) => s.send);
  // 多仓库协作：根子集投影（宿主持有，单根工作区为 null → 不渲染选择器）。
  const workspaceRoots = useChat((s) => s.state?.workspaceRoots ?? null);
  // Stop is only meaningful for a real generation: beginReplay() also reports
  // status "streaming", so replaying and initializing must be excluded.
  //
  // Deliberately NOT gated on a pending approval / question card: those cards
  // stay interactive while a turn streams (pitfall #12), and the ESC handler
  // below stops the turn in exactly that state. Gating the button gave one
  // feature two different rules — worse, the slot then rendered an ENABLED
  // 发送/派发 button, so clicking where Stop had been dispatched the typed
  // text as a child session instead of stopping. One semantic: while a real
  // turn runs, Stop is there.
  const streaming = status === "streaming";
  const canStop = streaming && !replaying && !initializing && !remoteTakeover;
  /** 接管态关闭接续的二次确认：确认后才真正发 stop，避免误触断掉远程会话。
   *  ConfirmDialog 走 portal 到 body，不受本卡片 overflow-hidden / 冻结门控影响。 */
  const [takeoverConfirmOpen, setTakeoverConfirmOpen] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** 图片数量的即时读数：窗口消息监听只挂载一次，闭包里的 `images` 永远是
   *  首帧值；「已附加 N 张 / 已忽略 N 张」的提示必须按当下数量算。 */
  const imagesRef = useRef<ImageAttachment[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  /** Non-image attachments (chips only — paths ride the sendPrompt message,
   * they never pollute the draft text the user types). The id decouples chip
   * identity from the path: picking the same file twice yields two removable
   * chips instead of one key collision. */
  const [attachments, setAttachments] = useState<Array<{ id: number; name: string; path: string }>>([]);
  /** Placeholder chips for files currently being staged through the host: the
   * real chips only appear when `stagedFiles` comes back, so a large paste/drop
   * used to leave the composer unchanged for seconds. */
  const [staging, setStaging] = useState<Array<{ id: number; name: string }>>([]);
  /** requestId → placeholder chip ids + failsafe timer. */
  const stagingRef = useRef(new Map<number, { ids: number[]; timer: ReturnType<typeof setTimeout> }>());
  /** @-mention file/folder search in flight (spinner row in the popup). */
  const [mentionSearching, setMentionSearching] = useState(false);
  const mentionSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Context cards being resolved by the host (@folder/@problems/@git/@url):
   * a URL fetch can take seconds, so the chip row shows a placeholder. */
  const [resolvingContexts, setResolvingContexts] = useState<Array<{ id: number; label: string }>>([]);
  const resolveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  /** Stop request in flight: the Stop button spins (and ignores repeats) until
   * the turn settles or the failsafe fires. */
  const [stopping, setStopping] = useState(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // --- request-in-flight feedback (item: "锁而不示") -----------------------
  /** Register placeholder chips for one stageFiles round trip. */
  function trackStaging(requestId: number, names: string[]): void {
    const entries = names.map((name) => ({ id: ++attachSeq.current, name }));
    setStaging((prev) => [...prev, ...entries]);
    const timer = setTimeout(() => {
      stagingRef.current.delete(requestId);
      setStaging((prev) => prev.filter((s) => !entries.some((e) => e.id === s.id)));
      showNote(t("添加文件超时了，请重试"));
    }, STAGE_TIMEOUT_MS);
    stagingRef.current.set(requestId, { ids: entries.map((e) => e.id), timer });
  }
  /** Drop the placeholders of a stageFiles round trip (reply or timeout). */
  function settleStaging(requestId: number): void {
    const entry = stagingRef.current.get(requestId);
    if (!entry) return;
    stagingRef.current.delete(requestId);
    clearTimeout(entry.timer);
    setStaging((prev) => prev.filter((s) => !entry.ids.includes(s.id)));
  }
  /** Show a "resolving" chip until the contextResolved reply (or timeout). */
  function trackContextResolve(requestId: number, label: string): void {
    setResolvingContexts((prev) => [...prev, { id: requestId, label }]);
    const timer = setTimeout(() => {
      resolveTimers.current.delete(requestId);
      pendingContextResolves.current.delete(requestId);
      setResolvingContexts((prev) => prev.filter((c) => c.id !== requestId));
      showNote(t("读取上下文超时了，请重试"));
    }, CONTEXT_RESOLVE_TIMEOUT_MS);
    resolveTimers.current.set(requestId, timer);
  }
  function settleContextResolve(requestId: number): void {
    const timer = resolveTimers.current.get(requestId);
    if (timer) {
      clearTimeout(timer);
      resolveTimers.current.delete(requestId);
    }
    setResolvingContexts((prev) => prev.filter((c) => c.id !== requestId));
  }
  /** Stop the running turn once; the button spins until the turn settles. */
  function stopGeneration(): void {
    if (stopping) return;
    setStopping(true);
    send({ type: "cancel" });
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      stopTimer.current = null;
      setStopping(false);
    }, STOP_TIMEOUT_MS);
  }
  // The turn left streaming (cancel landed) → release the Stop spinner early.
  useEffect(() => {
    if (!canStop && stopping) {
      if (stopTimer.current) {
        clearTimeout(stopTimer.current);
        stopTimer.current = null;
      }
      setStopping(false);
    }
  }, [canStop, stopping]);
  // ESC's window listener only depends on canStop; the ref keeps it on the
  // CURRENT stopping state instead of the render that registered it.
  const stopRef = useRef<() => void>(() => {});
  stopRef.current = stopGeneration;
  // Unmount: never leave a timer behind (the panel can be closed mid-flight).
  useEffect(
    () => () => {
      if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
      if (stopTimer.current) clearTimeout(stopTimer.current);
      for (const entry of stagingRef.current.values()) clearTimeout(entry.timer);
      for (const timer of resolveTimers.current.values()) clearTimeout(timer);
    },
    [],
  );
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
    if (mentionQuery === null) {
      setMentionSearching(false);
      if (mentionSearchTimer.current) {
        clearTimeout(mentionSearchTimer.current);
        mentionSearchTimer.current = null;
      }
      return;
    }
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
    const timer = setTimeout(() => {
      setMentionSearching(true);
      if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
      mentionSearchTimer.current = setTimeout(() => {
        mentionSearchTimer.current = null;
        setMentionSearching(false);
      }, MENTION_SEARCH_TIMEOUT_MS);
      useChat.getState().send({ type: "searchFiles", requestId, query: q, kind: folder ? "folder" : "file" });
    }, 120);
    return () => clearTimeout(timer);
  }, [mentionQuery]);

  // ESC 停止生成 —— 与停止按钮**同一个**判定（canStop），不再维护第二套规则。
  // 弹窗内的 ESC（mention/斜杠补全在 textarea onKeyDown、Dropdown 在 document）
  // 都会 stopPropagation，事件只有未被拦截时才到达这里的 window 监听。
  useEffect(() => {
    if (!canStop) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      // 待决卡（审批 / 提问）在等待用户决策时 status 仍是 streaming，但此刻
      // ESC 归卡片所有（拒绝 / 不回答并继续），不是「停掉整轮」。卡片的
      // window 监听会 preventDefault；这里再按 store 的待决态兜一层，覆盖
      // 监听注册先后差异，保证一次按键只有一种语义。上层 modal 有自己的
      // document ESC 处理（会 stopPropagation），这里同样让位。
      const s = useChat.getState().state;
      if (s?.pendingApproval || s?.pendingQuestions) return;
      if (document.querySelector(".auth-backdrop")) return;
      e.preventDefault();
      stopRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canStop]);

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
        setMentionSearching(false);
        if (mentionSearchTimer.current) {
          clearTimeout(mentionSearchTimer.current);
          mentionSearchTimer.current = null;
        }
        return;
      }
      if (msg?.type === "stagedFiles") {
        // Accept late replies too: the placeholders may already have been
        // dropped by the failsafe, but the files ARE staged — settleStaging is
        // a no-op then and the real chips still land.
        settleStaging(msg.requestId);
        const failed = msg.paths.filter((p: string | null) => p === null).length;
        const staged: Array<{ id: number; name: string; path: string }> = [];
        for (const p of msg.paths) {
          if (p === null) continue;
          staged.push({ id: ++attachSeq.current, name: p.split(/[\\/]/).pop() ?? p, path: p });
        }
        if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
        if (failed > 0) showNote(t("{0} 个文件添加失败，已跳过", failed));
        return;
      }
      if (msg?.type === "filesPicked") {
        const pickedImages = msg.images.filter(
          (img: { name: string; data: string; mimeType: string }) => img.data,
        );
        if (pickedImages.length > 0) {
          const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
          const dropped = pickedImages.length - Math.min(room, pickedImages.length);
          setImages((prev) => [
            ...prev,
            ...pickedImages
              .slice(0, Math.max(0, MAX_IMAGES - prev.length))
              .map((img: { data: string; mimeType: string }) => ({ data: img.data, mimeType: img.mimeType })),
          ]);
          if (dropped > 0) {
            showNote(t("最多 {0} 张图片，已忽略 {1} 张", MAX_IMAGES, dropped), "warning");
          } else {
            showNote(t("已附加 {0} 张图片", pickedImages.length), "info");
          }
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
          showNote(t("输入框已有内容，没有填入（原条目仍在）"));
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
        settleContextResolve(msg.requestId);
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

  // The main session only DELEGATES: streaming does not lock the composer, and
  // Enter while generating is not queued locally — the host dispatches that
  // message as a child session (own process, own worktree). The switches that
  // would desync the agent (model/profile dropdowns, attachments, enhance)
  // keep the original mid-turn lock; only replay/init/an in-flight switch
  // block sending entirely. `streaming` / `canStop` are computed up top so the
  // ESC handler and the Stop button share one rule.
  const hasPendingInteraction = Boolean(pendingApproval || pendingQuestions);
  // 远程接续是独立于 streaming 的全局冻结态（陷阱 #12：审批/提问卡刻意不受
  // streaming 门控，所以冻结必须另走一条）——覆盖模型/资料下拉、附件、enhance、
  // 发送与停止，但不碰 MessageList，转录仍可只读滚动观察远程在做什么。
  const controlsLocked = streaming || replaying || initializing || pending !== null || hasPendingInteraction || remoteTakeover;
  // 模型下拉额外跟随活跃子会话；发送 / enhance / 附件仍只看 controlsLocked。
  const modelLocked = controlsLocked || superActive;
  const sendBlocked = replaying || initializing || pending !== null || needsSetup || remoteTakeover;
  /** Enter/发送 while a real turn streams → the host spawns a child session. */
  const delegateMode = streaming && !replaying && !initializing && !remoteTakeover;
  /** Optimistic switch in flight (`store.pending`, cleared by the confirming
   * snapshot or its 10s failsafe): the trigger shows a spinner instead of its
   * idle icon — the lock alone looked like a dead control. */
  const modelSwitching = pending?.kind === "model" || pending?.kind === "think";
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
  //
  // Skills are NOT CLI slash commands — the CLI exposes them through
  // `_meta.availableSkills`, and its Skill tool is model-invoked (its
  // confirmation is denied by the default approval policy), so the panel
  // resolves `/skill <name>` itself. The popup therefore lists one synthetic
  // entry per skill next to the CLI's own commands.
  const skillCommands = useMemo<SlashCommand[]>(
    () =>
      skills.map((skill) => ({
        name: `${SKILL_COMMAND} ${skill.name}`,
        description: skill.description ?? null,
      })),
    [skills],
  );
  const allCommands = useMemo(
    () => [
      { name: MEMORY_CURATE_COMMAND, description: t("立即整理记忆：去重、合并、归档低价值条目") },
      ...commands,
      ...skillCommands,
    ],
    [commands, skillCommands],
  );
  const cmdMatches = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return [];
    const input = text.slice(1).toLowerCase();
    return allCommands.filter((c) => {
      const name = c.name.toLowerCase();
      if (name.startsWith(input)) return true;
      // A skill is also addressable by its bare name ("/pdf" → "/skill pdf").
      if (!name.startsWith(`${SKILL_COMMAND} `)) return false;
      return name.slice(SKILL_COMMAND.length + 1).startsWith(input);
    });
  }, [text, allCommands]);
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
  /** 面板本地指令（/memory-curate）的请求号；回包只用于宿主 toast，这里只需自增。 */
  const curateSeq = useRef(0);
  const enhancePending = useRef(false);
  const enhanceOriginal = useRef<string | null>(null);
  const enhanceSnapshot = useRef<string | null>(null);
  // The reply listener below is registered once ([] deps) — it must read the
  // CURRENT draft through a ref, not the stale `text` captured at mount.
  const textRef = useRef(text);
  textRef.current = text;
  const cancelInflightRef = useRef<() => void>(() => {});
  function cancelInflight(): void {
    if (enhancePending.current) {
      send({ type: "cancelEnhance", requestId: enhanceSeq.current });
      // Late replies can no longer match the sequence → ignored here too, even
      // against a host build that still answers a cancelled request.
      enhanceSeq.current += 1;
      enhancePending.current = false;
      setEnhancing(false);
    }
    // The "enhanced" marker describes ONE draft. Once that draft is gone (the
    // prompt was sent, or the session switched) the marker must go with it —
    // otherwise the wand keeps its enhanced tint and a click would restore a
    // stale prompt into the now-empty composer.
    enhanceOriginal.current = null;
    enhanceSnapshot.current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 增强结果监听只挂载一次；回调仅读 ref 与稳定 setter，重复订阅无意义
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
    if (oversized.length > 0) {
      addOtherFiles(oversized);
      showNote(
        t("图片超过 {0}MB，已作为文件附件发送", Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)),
        "warning",
      );
    }
    if (accepted.length === 0) return;
    // Slots are pure placeholders; the actual data lands by scanning for the
    // first empty slot below. Capacity is computed from the live ref so the
    // "ignored N" note reflects the real cap, not a stale render.
    const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    setImages((prev) => {
      const remaining = Math.max(0, MAX_IMAGES - prev.length);
      return [...prev, ...accepted.slice(0, remaining).map(() => ({ data: "", mimeType: "image/*" }))];
    });
    const dropped = accepted.length - Math.min(room, accepted.length);
    if (dropped > 0) {
      showNote(t("最多 {0} 张图片，已忽略 {1} 张", MAX_IMAGES, dropped), "warning");
    } else {
      showNote(t("已附加 {0} 张图片", accepted.length), "info");
    }
    for (const file of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
        setImages((prev) => {
          const idx = prev.findIndex((img) => img.data === "");
          if (idx < 0) return prev; // over the limit or the slot was removed
          const next = [...prev];
          next[idx] = { ...next[idx]!, data: base64, mimeType: imageMime(file) };
          return next;
        });
      };
      reader.readAsDataURL(file);
    }
  }

  /** Edit one image's caption in place (captions stay index-aligned with images). */
  function setImageCaption(index: number, caption: string): void {
    setImages((prev) => prev.map((img, i) => (i === index ? { ...img, caption } : img)));
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
    // Instant feedback: the bytes still have to be read + round-tripped through
    // the host, so show placeholder chips now instead of leaving the composer
    // unchanged for the whole round trip.
    trackStaging(requestId, storable.map((f) => f.name));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- KEYWORD_SOURCES 为组件内固定常量、t 为模块级稳定函数，仅 mentionQuery 变化需要重算
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
    const requestId = nextContextRequestId();
    trackContextResolve(requestId, relPath);
    useChat.getState().send({
      type: "resolveContext",
      requestId,
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
    const requestId = nextContextRequestId();
    trackContextResolve(
      requestId,
      kind === "problems"
        ? t("工作区诊断（Problems）")
        : kind === "git"
          ? t("Git 状态与变更")
          : t("终端最近输出"),
    );
    useChat.getState().send({
      type: "resolveContext",
      requestId,
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
    const requestId = nextContextRequestId();
    trackContextResolve(requestId, target);
    useChat.getState().send({
      type: "resolveContext",
      requestId,
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
    // 面板本地指令：/memory-curate 直接触发宿主整理，绝不作为提示词发给模型
    // （CLI 会把未知 / 指令当成 unknown command，模型根本看不到正文）。
    if (isMemoryCurateCommand(value) && images.length === 0 && attachments.length === 0 && contexts.length === 0) {
      send({ type: "curateMemoryNow", requestId: ++curateSeq.current });
      setText("");
      setHistIndex(-1);
      histDraft.current = null;
      histEntryRef.current = null;
      editedRecall.current = false;
      showNote(t("已触发记忆整理，完成后会提示结果"), "info");
      return;
    }
    // 只发送真的带数据的图片；说明必须与之一一对应（占位槽没有 data，
    // 不能把它的说明错位给下一张）。
    const sentImages = images.filter((img) => img.data);
    const sentCaptions = sentImages.map((img) => (img.caption ?? "").trim());
    const hasCaptions = sentCaptions.some((caption) => caption !== "");
    send({
      type: "sendPrompt",
      text:
        value ||
        (contexts.length > 0
          ? t("（见附带的上下文）")
          : attachments.length > 0
            ? t("（见附件）")
            : t("（见附图）")),
      images: sentImages.length > 0 ? sentImages : undefined,
      imageCaptions: sentImages.length > 0 && hasCaptions ? sentCaptions : undefined,
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
      className={`acrylic @container relative z-20 flex flex-col shrink-0 border-t p-3 transition-all duration-200 ${
        remoteTakeover ? "overflow-hidden" : ""
      } ${dragOver ? "border-primary/60 bg-primary/5" : "border-border"}`}
      style={{ height: remoteTakeover ? undefined : (height ?? undefined), boxShadow: "var(--shadow-stage)" }}
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
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-primary/5 text-ui-label font-medium text-primary">
          {t("拖放文件以添加附件")}
        </div>
      )}
      {/* 多仓库协作：目标根子集。只在多根工作区出现；多选用 ToggleChip，
          选择写回宿主并持久化。改根只影响**之后新建**的会话（已有会话的根
          与 cwd 一律不迁移），因此与 applied 不一致时给出「新会话生效」提示。 */}
      {workspaceRoots && workspaceRoots.roots.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label={t("目标根（多仓库）")}>
          <span className="inline-flex shrink-0 items-center gap-1 text-ui-caption text-muted-foreground">
            <FolderTree className="size-3" />
            {t("目标根")}
          </span>
          {workspaceRoots.roots.map((root) => {
            const active = workspaceRoots.selected.includes(root.path);
            return (
              <ToggleChip
                key={root.path}
                active={active}
                mono
                title={root.path}
                aria-label={t("目标根 {0}", root.name)}
                onClick={() => {
                  // 至少保留一个根：取消最后一个等于「只剩 cwd」，语义容易被
                  // 误读成「工作区丢了」，宿主也会把空选择归一为全量根。
                  if (active && workspaceRoots.selected.length <= 1) return;
                  const next = active
                    ? workspaceRoots.selected.filter((p) => p !== root.path)
                    : [...workspaceRoots.selected, root.path];
                  send({ type: "setSessionRoots", roots: next });
                }}
              >
                {root.name}
              </ToggleChip>
            );
          })}
          {workspaceRoots.pendingChange && (
            <Chip tone="info" title={t("根变更对已建立的会话无效，新建会话后生效")}>
              {t("新会话生效")}
            </Chip>
          )}
        </div>
      )}
      {/* non-image attachment chips + rejected-file note */}
      {(attachments.length > 0 || staging.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {staging.map((f) => (
            <span
              key={`stage-${f.id}`}
              className="card-lift inline-flex max-w-[min(260px,100%)] items-center gap-1 rounded-lg border border-dashed border-border bg-surface/80 px-1.5 py-1 text-ui-caption text-muted-foreground shadow-card"
              title={f.name}
              aria-label={t("暂存中…")}
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-ui-micro">{t("暂存中…")}</span>
            </span>
          ))}
          {attachments.map((f) => (
            <span
              key={f.id}
              className="card-lift inline-flex max-w-[min(260px,100%)] items-center gap-1 rounded-lg border border-border bg-surface/80 px-1.5 py-1 text-ui-caption text-foreground shadow-card"
              title={f.path}
            >
              <FileText className="size-3.5 shrink-0 text-primary" />
              <span className="truncate">{f.name}</span>
              <IconButton
                icon={<X className={ICON_INLINE} />}
                label={t("移除")}
                size="sm"
                tone="danger"
                onClick={() => removeAttachment(f.id)}
              />
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
      {(contexts.length > 0 || resolvingContexts.length > 0) && (
        <div className="mb-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {resolvingContexts.map((r) => (
              <span
                key={`resolve-${r.id}`}
                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-dashed border-border bg-surface/80 px-1.5 py-0.5 text-ui-caption text-muted-foreground shadow-card"
                title={r.label}
                aria-label={t("解析中…")}
              >
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                <span className="shrink-0">{t("解析中…")}</span>
                <span className="max-w-[150px] truncate font-mono text-ui-micro" title={r.label}>
                  {r.label}
                </span>
              </span>
            ))}
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
                  <IconButton
                    icon={<X className={ICON_INLINE} />}
                    label={t("移除")}
                    size="sm"
                    tone="danger"
                    onClick={() => removeContext(c.id)}
                  />
                </span>
              );
            })}
            {contexts.length > CONTEXT_CHIP_MAX && (
              <button
                type="button"
                className={`${CANVAS_CHIP} shrink-0 font-mono text-muted-foreground hover:text-foreground`}
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
                <IconButton
                  icon={<ChevronDown className={`${ICON_INLINE} rotate-180`} />}
                  label={t("收起")}
                  size="sm"
                  className="ml-auto"
                  onClick={() => setExpandedContextId(null)}
                />
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
        <div className="mb-2 flex flex-col gap-1.5">
          {images.map((img, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="relative inline-flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-border"
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
              {/* 说明是可选的单行文本；与图片同序号，发送时按顺序成为模型
                  看到的「第 N 张图是什么」清单。 */}
              <TextInput
                dense
                className="min-w-0 flex-1"
                value={img.caption ?? ""}
                onChange={(event) => setImageCaption(i, event.target.value)}
                placeholder={t("图片说明（可选，例如：报错弹窗）")}
                aria-label={t("第 {0} 张图片的说明", i + 1)}
              />
            </div>
          ))}
        </div>
      )}

      {/* slash-command popup: all prefix matches, keyboard navigable */}
      {cmdMatches.length > 0 && (
        <div className="acrylic-pop shadow-float dropdown-in absolute inset-x-3 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-xl border border-border">
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
              {/* The command name must not wrap: a long skill name ("skill
                  code-review") used to break the row into three lines, so the
                  rows had ragged heights and the "Tab 补全" hint was squeezed
                  into a vertical strip. The name keeps its own width (only
                  ellipsised when it exceeds the row), the description takes
                  the rest and truncates, the hint stays on one line. */}
              <span className="max-w-[62%] shrink-0 truncate font-mono text-primary" title={`/${c.name}`}>
                /{c.name}
              </span>
              {/* truncate 必配 title：省略号里的原文只有 hover 才拿得到 */}
              <span
                className="min-w-0 flex-1 truncate text-ui-caption text-muted-foreground"
                title={c.description ?? undefined}
              >
                {c.description}
              </span>
              {i === cmdIndex && (
                <kbd className="ml-auto shrink-0 whitespace-nowrap rounded border border-border px-1 font-mono text-ui-micro text-muted-foreground">
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
        <div className="acrylic-pop shadow-float dropdown-in absolute inset-x-3 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-xl border border-border">
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
                <span className="truncate text-ui-caption text-muted-foreground" title={a.label}>
                  {a.label}
                </span>
              </button>
            );
          })}
          {mentionKind !== "url" && mentionHits.length === 0 && sourceActions.length === 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-ui-label text-muted-foreground" aria-live="polite">
              {mentionSearching ? (
                <>
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                  {t("搜索中…")}
                </>
              ) : mentionKind === "folder" ? (
                t("无匹配文件夹")
              ) : (
                t("无匹配文件")
              )}
            </div>
          )}
          {mentionKind !== "url" &&
            mentionHits.map((hit, i) => {
              const idx = sourceActions.length + i;
              const dir = hit.path.split("/").slice(0, -1).join("/");
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
                  {dir && (
                    <span className="min-w-0 truncate text-ui-caption text-muted-foreground" title={dir}>
                      {dir}/
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
          className={`flex items-center gap-1 rounded-lg border border-border bg-surface/80 px-2 text-ui-caption text-muted-foreground shadow-card transition-all duration-200 ${
            remoteTakeover ? "mb-0 max-h-0 overflow-hidden py-0 opacity-0 pointer-events-none" : "mb-2 py-1"
          }`}
          aria-label={t("正在想下一步建议…")}
        >
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate">{t("正在想下一步建议…")}</span>
        </div>
      )}

      {/* Turn-end next-step suggestions: candidate-word chips from one
          dedicated model call. Click inserts at the caret and keeps the rest
          of the batch on screen; only the close button (or the host clearing
          the batch when the user actually sends) retires the row. */}
      {suggestions && suggestions.length > 0 && !suggestionsHidden && (
        <div
          className={`flex flex-wrap items-center gap-1.5 transition-all duration-200 ${
            remoteTakeover ? "mb-0 max-h-0 overflow-hidden py-0 opacity-0 pointer-events-none" : "mb-2"
          }`}
          aria-label={t("iFlow 猜的下一步，点一下填进输入框")}
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
              className={CANVAS_CHIP}
              title={t("iFlow 猜的下一步，点一下填进输入框")}
              onClick={() => applySuggestion(s)}
            >
              {/* truncate 与 title 成对：省略号里的建议全文只有 hover 拿得到。
                  外层按钮的 title 说的是「点一下填进输入框」这个动作，不是建议本身。 */}
              <span className="truncate" title={s}>
                {s}
              </span>
            </button>
          ))}
          <IconButton
            icon={<X className={ICON_INLINE} />}
            label={t("关闭建议")}
            size="sm"
            className="ml-auto"
            onClick={() => setSuggestionsHidden(true)}
          />
        </div>
      )}

      <div className={`flex min-h-0 flex-1 flex-col transition-all duration-300 ${
        remoteTakeover ? "" : "rounded-lg border border-border bg-editor/60 shadow-card focus-within:border-primary/50 focus-within:shadow-focus"
      }`}>
        <textarea
          ref={taRef}
          value={text}
          readOnly={remoteTakeover}
          placeholder={delegateMode ? t("派发为超流体（Enter）") : t("向 iFlow 提问…")}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className={`min-h-0 w-full flex-1 resize-none bg-transparent px-3 text-ui-body leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80 transition-all duration-200 ${
            remoteTakeover ? "max-h-0 overflow-hidden py-0 opacity-0 pointer-events-none" : "max-h-[420px] py-3 opacity-100"
          }`}
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
                // 完整输入了面板本地指令时直接执行；其余情况仍是补全。
                if (e.key === "Enter" && isMemoryCurateCommand(text)) {
                  submit();
                  return;
                }
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
        <div
          className={`flex shrink-0 items-center gap-1.5 transition-all duration-200 ${
            remoteTakeover ? "justify-center px-2 py-1.5" : "px-2 pb-2 pt-2"
          }`}
        >
          {/* The zone clips horizontally (the takeover collapse wipes the row
              away) but must NOT clip vertically: the canvas buttons carry
              `card-lift` (translateY(-1px) on hover) plus a card shadow, and
              `overflow: hidden` sliced the button's top border off exactly at
              the clip edge — the reported 「底部栏 hover 时上边缘被裁切掉一点」
              (measured in Chromium: hovered top 850 vs clip edge 851).
              `overflow-x: clip` keeps the horizontal wipe and, unlike
              `overflow-x: hidden`, does not force the vertical axis to
              `auto` — so the lift and the shadow paint outside the box. */}
          <div
            className={`flex min-w-0 items-center gap-1.5 overflow-x-clip overflow-y-visible transition-all duration-200 ${
              remoteTakeover ? "max-w-0 flex-none opacity-0" : "max-w-full flex-1 opacity-100"
            }`}
          >
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
              disabled={modelLocked}
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
                <Button
                  variant="canvas"
                  className={`min-w-0${open ? " bg-surface-2" : ""}`}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-busy={modelSwitching || undefined}
                  title={modelSwitching ? t("切换中…") : t("模型")}
                  disabled={modelLocked}
                >
                  <span className="max-w-[130px] truncate @max-[520px]:max-w-[84px] @max-[340px]:max-w-[60px]">
                    {currentModelName}
                  </span>
                  <SessionUsageChip />
                  {modelSwitching ? (
                    <Loader2 className={`${ICON_INLINE} shrink-0 animate-spin text-primary`} />
                  ) : (
                    <ChevronDown className={`${ICON_INLINE} shrink-0 opacity-60`} />
                  )}
                </Button>
              )}
            >
              {(close) => (
                <>
                  {/* fuzzy search box: matches name and id; sticky so it stays
                      visible while the list scrolls. UI-audit 4.6: only worth a
                      row once the catalog is long enough to need filtering. */}
                  {models.length > MODEL_SEARCH_MIN && (
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-panel/50 p-1.5 backdrop-blur-md">
                    <SearchInput
                      autoFocus
                      mono
                      value={modelQuery}
                      onChange={setModelQuery}
                      placeholder={t("搜索模型…")}
                      ariaLabel={t("搜索模型…")}
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
            {/* 远程接续开关：仅机器人已启用时显示。刻意不受 controlsLocked /
                remoteTakeover 门控 —— 它是解冻的唯一出口，冻结自己会造成死锁。 */}
            {qqEnabled && (
              <Button
                variant={remoteTakeover ? "danger" : "canvas"}
                icon={remoteTakeover ? <Unplug className={ICON_INLINE} /> : <Radio className={ICON_INLINE} />}
                aria-label={remoteTakeover ? t("关闭接续") : t("远程接续")}
                title={remoteTakeover ? t("关闭远程接续，恢复本地操作") : t("开启后本地输入与审批将被冻结")}
                onClick={() => {
                  if (remoteTakeover) {
                    // 关闭接续是解冻的唯一出口：先二次确认，确认后才真正 stop，
                    // 避免误触把远程会话断掉。start 路径无需确认。
                    setTakeoverConfirmOpen(true);
                  } else {
                    send({ type: "qqTakeover", action: "start" });
                  }
                }}
              >
                <span className="@max-[340px]:hidden">{remoteTakeover ? t("关闭接续") : t("远程接续")}</span>
              </Button>
            )}
            {/* 接管态下其余操作按钮水平收缩隐藏，只留下方的「关闭接续」作为
                解冻的唯一出口；用 CSS 过渡而非卸载 DOM，保持布局稳定。
                横向裁剪（overflow-x: clip）负责收起动画；垂直方向必须放行，
                否则 canvas 按钮 hover 时的 card-lift 抬升会被切掉上边框
                （左侧模型分区同一个坑，两处一起修）。 */}
            <div
              className={`flex items-center gap-1.5 overflow-x-clip overflow-y-visible transition-all duration-200 ${
                remoteTakeover ? "max-w-0 opacity-0" : "max-w-full opacity-100"
              }`}
            >
            {/* UI-audit 4.6: the wand only appears once there is something to
                enhance (or a rewrite to undo) — an always-present disabled
                button just widened the row. */}
            {(text.trim() !== "" || enhancing || enhanceOriginal.current !== null) && (
              <Button
                variant="canvas"
                icon={enhancing ? <Loader2 className={`${ICON_INLINE} animate-spin`} /> : <Wand2 className={ICON_INLINE} />}
                className={enhanceOriginal.current !== null ? "text-primary" : ""}
                aria-label={enhancing ? t("取消增强") : t("增强提示词")}
                title={
                  enhancing
                    ? t("正在增强，点击取消")
                    : enhanceOriginal.current !== null
                      ? t("还原原始输入")
                      : t("增强提示词（AI 改写为更清晰的请求）")
                }
                disabled={!enhancing && (controlsLocked || (!text.trim() && enhanceOriginal.current === null))}
                onClick={enhance}
              />
            )}
            <Button
              variant="canvas"
              icon={<Paperclip className={ICON_INLINE} />}
              aria-label={t("添加附件")}
              title={t("添加附件")}
              disabled={controlsLocked}
              onClick={() => send({ type: "pickAttachments" })}
            />
            {/* P1-7: stop and send share ONE slot (swap in place) — the old
                separate stop button made the primary action area jump every
                time a turn started/ended. Sending while generating stays on
                Enter, where the host dispatches a child session (the
                textarea's delegateMode placeholder says so). */}
            {canStop ? (
              <Button
                variant="emphasis"
                icon={stopping ? <Loader2 className={`${ICON_INLINE} animate-spin`} /> : <Square className={ICON_INLINE} />}
                title={stopping ? t("正在停止…") : t("停止生成")}
                aria-label={stopping ? t("正在停止…") : t("停止生成")}
                aria-busy={stopping || undefined}
                disabled={stopping}
                onClick={stopGeneration}
              >
                <span className="@max-[340px]:hidden">{stopping ? t("正在停止…") : t("停止生成")}</span>
              </Button>
            ) : (
              <Button
                variant={delegateMode ? "primary-soft" : "primary"}
                icon={delegateMode ? <ListOrdered className={ICON_INLINE} /> : <SendHorizontal className={ICON_INLINE} />}
                title={delegateMode ? t("派发为超流体 (Enter)") : t("发送 (Enter)")}
                disabled={sendBlocked || (!text.trim() && images.length === 0 && attachments.length === 0 && contexts.length === 0)}
                onClick={submit}
              >
                <span className="@max-[340px]:hidden">{delegateMode ? t("派发") : t("发送")}</span>
              </Button>
            )}
            </div>
          </div>
        </div>
      </div>
      {takeoverConfirmOpen && (
        <ConfirmDialog
          title={t("确认关闭远程接续？")}
          message={t("关闭后将恢复本地操作，远程用户将无法继续控制本会话。")}
          confirmLabel={t("确认关闭")}
          cancelLabel={t("取消")}
          onCancel={() => setTakeoverConfirmOpen(false)}
          onConfirm={() => {
            setTakeoverConfirmOpen(false);
            send({ type: "qqTakeover", action: "stop" });
          }}
        />
      )}
    </div>
  );
}
