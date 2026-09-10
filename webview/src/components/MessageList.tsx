import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Columns2,
  Eye,
  FilePen,
  FolderInput,
  Globe,
  Loader2,
  ArrowDown,
  Bot,
  Search,
  SquareTerminal,
  Trash2,
  Undo2,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  Block,
  SessionState,
  SubAgentBlock,
  ThoughtBlock,
  ToolBlock,
} from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Markdown } from "./Markdown";
import { DiffView } from "./DiffView";
import { Chip, FileRef } from "./ui";

const KIND_ICON: Record<string, typeof Eye> = {
  read: Eye,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: Zap,
  think: Brain,
  fetch: Globe,
  other: Wrench,
};

/**
 * Animated collapsible body: keeps children mounted and animates height via
 * the CSS grid-rows 0fr→1fr trick (no JS measurement, smooth both ways).
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="collapse-wrap" data-open={open}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** Chevron that rotates with the collapse state. */
function Caret({ open, className = "size-3" }: { open: boolean; className?: string }) {
  return (
    <ChevronDown
      className={`${className} shrink-0 transition-transform duration-300 ${open ? "" : "-rotate-90"}`}
    />
  );
}

function StatusChip({ status }: { status: ToolBlock["status"] }) {
  // W2: the localized chip text is rebuilt only when the status changes.
  // key=status replays the chip-in animation on every status flip, and the
  // muted→tone crossfade reads as "this just happened".
  const chip = useMemo(() => {
    if (status === "completed")
      return (
        <Chip tone="success" className="chip-in">
          <Check className="size-2.5" /> {t("已完成")}
        </Chip>
      );
    if (status === "failed")
      return (
        <Chip tone="danger" className="chip-in">
          <X className="size-2.5" /> {t("失败")}
        </Chip>
      );
    return (
      <Chip tone="primary" className="chip-in">
        <Loader2 className="size-2.5 animate-spin" /> {t("执行中")}
      </Chip>
    );
  }, [status]);
  // key forces a remount on status flip → chip-in animation replays.
  return <span key={status} className="inline-flex">{chip}</span>;
}

function OutputDetails({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  if (!output) return null;
  // Fewer than 3 lines: show inline — a toggle around two short lines is
  // chrome, not utility. The fold only pays off once content is tall.
  const lineCount = output.trimEnd().split("\n").length;
  if (lineCount < 3) {
    return (
      <pre className="border-t border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {output}
      </pre>
    );
  }
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Caret open={open} />
        {t("操作输出")}
      </button>
      <Collapse open={open}>
        <pre className="max-h-64 overflow-auto border-t border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output}
        </pre>
      </Collapse>
    </>
  );
}

function ToolCard({ block }: { block: ToolBlock }) {
  const send = useChat((s) => s.send);
  const primary = block.locations[0];
  const hasDiff = block.diff !== null;
  const Icon = KIND_ICON[block.toolKind] ?? Wrench;
  const completedWithDiff = block.status === "completed" && hasDiff && block.diff!.oldText !== null;

  return (
    <div className={`stream-in status-fade overflow-hidden rounded-lg border border-border bg-card status-${block.status}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-primary" />
        {/* min-w-0 truncate: agent tool titles are uncapped on the wire
            ("Running: <whole shell command>", task descriptions) — shrink-0
            here pushed the status chip out of the card. */}
        <span className="min-w-0 truncate text-[12px] font-semibold" title={block.title || block.toolName || block.toolKind}>
          {block.title || block.toolName || block.toolKind}
        </span>
        {primary && !hasDiff && <FileRef path={primary.path} line={primary.line} />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {block.reverted && (
            <Chip tone="muted">
              <Undo2 className="size-2.5" /> {t("已回退")}
            </Chip>
          )}
          <StatusChip status={block.status} />
        </span>
      </div>
      {hasDiff && (
        <DiffView
          diff={block.diff!}
          actions={
            <>
              {completedWithDiff && (
                <>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-2"
                    title={t("将该文件恢复为编辑前内容")}
                    onClick={() => send({ type: "revertTool", toolCallId: block.toolCallId })}
                  >
                    <Undo2 className="size-3" /> {t("回退此改动")}
                  </button>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-2"
                    title={t("在 VSCode diff 视图中查看该变更")}
                    onClick={() => send({ type: "openDiff", toolCallId: block.toolCallId })}
                  >
                    <Columns2 className="size-3" /> {t("文件对比")}
                  </button>
                </>
              )}
            </>
          }
        />
      )}
      <OutputDetails output={block.output} />
    </div>
  );
}

/**
 * CLI-generated step titles follow fixed English patterns; localize the known
 * prefixes (Launch agent / Reading / Running / Updating todos), keep the rest
 * verbatim.
 */
function localizeStepTitle(title: string): string {
  if (/^task$/i.test(title.trim())) return t("子智能体");
  let m = /^Launch agent\(([^)]*)\):\s*([\s\S]*)$/.exec(title);
  if (m) return t("启动子代理（{0}）：{1}", m[1], m[2]);
  m = /^Reading\s+([\s\S]+)$/.exec(title);
  if (m) return t("读取 {0}", m[1]);
  m = /^Running:\s*([\s\S]*)$/.exec(title);
  if (m) return t("运行：{0}", m[1]);
  if (/^Updating todos$/i.test(title.trim())) return t("更新任务清单");
  return title;
}

/** Deterministic accent color per SubAgent type (hash of the type name). */
function agentAccent(type: string | null): { border: string; icon: string; chip: string } {
  const palette = [
    { border: "border-info/40", icon: "text-info", chip: "bg-info/15 text-info" },
    { border: "border-success/40", icon: "text-success", chip: "bg-success/15 text-success" },
    { border: "border-warning/40", icon: "text-warning", chip: "bg-warning/15 text-warning" },
    { border: "border-primary/40", icon: "text-primary", chip: "bg-primary/15 text-primary" },
  ];
  if (!type) return palette[0]!;
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}

function SubAgentCard({ block }: { block: SubAgentBlock }) {
  const [open, setOpen] = useState(false);
  const nested = block.entries.filter((b): b is ToolBlock => b.kind === "tool");
  // W2: derived counter + localized chip text — memoized so re-renders that
  // don't change `entries` skip the t() replaceAll work.
  const done = useMemo(
    () => nested.filter((b) => b.status === "completed" || b.status === "failed").length,
    [block.entries],
  );
  const progress = nested.length > 0 ? ` ${done}/${nested.length}` : "";
  const statusChip =
    block.status === "completed" ? (
      <Chip tone="success">
        <Check className="size-2.5" /> {t("已完成")}
        {progress}
      </Chip>
    ) : block.status === "failed" ? (
      <Chip tone="danger">
        <X className="size-2.5" /> {t("失败")}
      </Chip>
    ) : (
      <Chip tone="info">
        <Loader2 className="size-2.5 animate-spin" /> {t("运行中")}
        {progress}
      </Chip>
    );

  const stepIcon = (s: ToolBlock["status"]) =>
    s === "completed" ? (
      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
    ) : s === "failed" ? (
      <XCircle className="size-3.5 shrink-0 text-destructive" />
    ) : s === "in_progress" ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    ) : (
      <span className="mt-[3px] size-3 shrink-0 rounded-full border border-border" />
    );

  // Compact mono log over the nested entries (reference-design "日志" pane).
  // P5: memoized on the entries reference — a streaming card re-renders on
  // every nested chunk, and rebuilding this string each time is O(entries).
  const log = useMemo(() => {
    return block.entries
      .map((e) => {
        if (e.kind === "tool") {
          const s = e.status === "completed" ? t("已完成") : e.status === "failed" ? t("失败") : t("运行中");
          const title = localizeStepTitle(e.title && e.title !== e.toolName ? e.title : e.toolName);
          return `> tool: ${e.toolName} — ${title} · ${s}`;
        }
        if (e.kind === "text") return e.text;
        if (e.kind === "thought") return `> ${e.text}`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }, [block.entries]);

  const accent = agentAccent(block.agentType);

  return (
    <div className={`stream-in status-fade overflow-hidden rounded-lg border bg-card ${accent.border}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Bot className={`size-3.5 shrink-0 ${accent.icon}`} />
        <span className="min-w-0 truncate text-[12px] font-semibold">{localizeStepTitle(block.title)}</span>
        {/* min-w-0 + clip: agentType comes from an uncapped regex capture of
            the task title; a pathological one gets clipped instead of evicting
            the status chip. */}
        {block.agentType && (
          <span className="flex min-w-0 items-center overflow-hidden">
            <Chip tone="muted">{block.agentType}</Chip>
          </span>
        )}
        <span className="ml-auto shrink-0">{statusChip}</span>
      </div>
      {nested.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          <ul className="space-y-1.5">
            {nested.map((t2) => (
              <li key={t2.toolCallId} className="flex items-center gap-2 text-[12px]">
                {stepIcon(t2.status)}
                <span className={`min-w-0 truncate ${t2.status === "completed" ? "text-muted-foreground" : "text-foreground"}`}>
                  {localizeStepTitle(t2.title || t2.toolName)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {block.entries.length > 0 && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Caret open={open} />
            {t("子智能体日志")}
          </button>
          <Collapse open={open}>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {log}
            </pre>
          </Collapse>
        </>
      )}
    </div>
  );
}

function ThoughtCard({
  block,
  isLatest,
  turnActive,
}: {
  block: ThoughtBlock;
  /** True while this thought is the transcript tail (still streaming). */
  isLatest: boolean;
  /** True while the turn is generating (status=streaming, no replay/init). */
  turnActive: boolean;
}) {
  // Default OPEN: the live reasoning is the interesting part of a turn.
  const [open, setOpen] = useState(true);
  // User override wins: once they toggle manually, stop auto-collapsing.
  const userTouched = useRef(false);
  // Auto-collapse shortly after the thought is done — i.e. when it stops
  // being the transcript tail (the next block started) or the turn ended.
  // The delay lets the user finish skimming before the card folds itself.
  const done = !isLatest || !turnActive;
  useEffect(() => {
    if (!done || userTouched.current) return;
    const timer = setTimeout(() => setOpen(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <div className="stream-in overflow-hidden rounded-lg border border-border/70 bg-panel/60">
      <button
        onClick={() => {
          userTouched.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Caret open={open} className="size-3.5" />
        <Brain className="size-3.5 text-primary" />
        {t("思考过程")}
      </button>
      <Collapse open={open}>
        <div className="border-t border-border/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          <Markdown text={block.text} />
        </div>
      </Collapse>
    </div>
  );
}

function TaskList({ block }: { block: Extract<Block, { kind: "plan" }> }) {
  const total = block.entries.length;
  const done = block.entries.filter((e) => e.status === "completed").length;
  return (
    <div className="stream-in rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
        <CircleDot className="size-3.5 text-primary" />
        {t("任务清单")}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {done} / {total}
        </span>
      </div>
      <ul className="space-y-1.5">
        {block.entries.map((entry, i) => (
          <li key={i} className={`flex items-start gap-2 text-[12px] status-${entry.status ?? "pending"}`}>
            {entry.status === "completed" ? (
              <CheckCircle2 className="size-3.5 shrink-0 translate-y-[1px] text-success" />
            ) : entry.status === "in_progress" ? (
              <Loader2 className="size-3.5 shrink-0 translate-y-[1px] animate-spin text-primary" />
            ) : (
              <span className="mt-[3px] size-3 shrink-0 rounded-full border border-border" />
            )}
            <span className={`min-w-0 break-words ${entry.status === "completed" ? "text-muted-foreground line-through" : "text-foreground"}`}>
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UserMessage({ block }: { block: Extract<Block, { kind: "user" }> }) {
  const send = useChat((s) => s.send);
  return (
    <div className="stream-in flex justify-end">
      {/* user-bubble scopes the attached-code-context styling (styles.css):
          fenced blocks here read as right-clicked source context, not as
          model output. */}
      <div className="user-bubble max-w-[85%] rounded-xl rounded-br-sm bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-foreground">
        <Markdown text={block.text} />
        {block.images && block.images.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {block.images.map((src, i) => (
              <img
                key={i}
                className="h-16 max-w-[160px] cursor-zoom-in rounded-md border border-border object-cover transition-transform hover:-translate-y-px"
                src={src}
                alt={t("附件图片 {0}", i + 1)}
                title={t("在 VSCode 中打开")}
                onClick={() => send({ type: "openImage", dataUrl: src })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible context-compression card (slash /compress). The carried
 * conversation summary is long, so it stays folded until requested. */
function CompressionCard({ block }: { block: Extract<Block, { kind: "compression" }> }) {
  const [open, setOpen] = useState(false);
  const hasSummary = block.summary !== null;
  return (
    <div className="stream-in overflow-hidden rounded-lg border border-border/60 bg-card">
      <button
        onClick={() => hasSummary && setOpen((v) => !v)}
        disabled={!hasSummary}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] ${
          hasSummary ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground"
        }`}
      >
        {hasSummary ? <Caret open={open} /> : <CircleDot className="size-3 shrink-0" />}
        <span className="min-w-0 truncate">{block.notice}</span>
        {hasSummary && <Chip tone="muted">{t("上下文摘要")}</Chip>}
      </button>
      <Collapse open={open && hasSummary}>
        <div className="border-t border-border/60 px-3 py-2">
          <div className="max-h-64 overflow-y-auto text-[12px] leading-relaxed text-muted-foreground">
            {block.summary !== null && <Markdown text={block.summary} />}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

/**
 * Memoized per-block renderer (P4): the default shallow compare anchors on
 * the block reference. With P-1 block patches the unchanged prefix keeps its
 * references (`applyBlockPatch` reuses `blocks.slice(0, tailStart)`), so
 * streaming re-renders only the re-sent tail instead of the whole list.
 * `isLatest`/`turnActive` feed ThoughtCard's auto-collapse; identity-only
 * changes re-render thought cards cheaply (no markdown work when text is
 * unchanged — Markdown memoizes on its `text` prop).
 */
const BlockView = memo(function BlockView({
  block,
  isLatest,
  turnActive,
}: {
  block: Block;
  isLatest: boolean;
  turnActive: boolean;
}) {
  switch (block.kind) {
    case "user":
      return <UserMessage block={block} />;
    case "text":
      return (
        <div className="stream-in text-[13px] leading-relaxed text-foreground/90">
          <Markdown text={block.text} />
        </div>
      );
    case "thought":
      return <ThoughtCard block={block} isLatest={isLatest} turnActive={turnActive} />;
    case "tool":
      return <ToolCard block={block} />;
    case "subagent":
      return <SubAgentCard block={block} />;
    case "compression":
      return <CompressionCard block={block} />;
    case "plan":
      return <TaskList block={block} />;
  }
});

/**
 * Offscreen tail-window tuning: a restored transcript mounts only the newest
 * TAIL_WINDOW blocks; scrolling toward the top mounts MOUNT_STEP more at a
 * time (see the sentinel IntersectionObserver in MessageListInner). 60 covers
 * a few viewport-heights of dense transcript without mounting a whole
 * multi-thousand-block session up front.
 */
const TAIL_WINDOW = 60;
const MOUNT_STEP = 60;

function MessageListInner({ state }: { state: SessionState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Everything inside the scroller (blocks + streaming indicator) lives in
  // this wrapper so a ResizeObserver on it sees EVERY content-height change.
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Scroll events fire asynchronously after a scrollTop assignment: by the
  // time the handler runs, streaming DOM updates may already have grown
  // scrollHeight, so a naive distance-to-bottom check reads our own
  // follow-scroll as "user scrolled up" and kills stick-to-bottom (the
  // reported "回到最新 does nothing" bug). Record the scrollTop we set
  // programmatically; scroll events landing on that value are ours and must
  // not touch the stick state. Falls through if a user drag happens to land
  // within 1px of it — the next scroll event corrects the state.
  const programmaticTop = useRef<number | null>(null);

  // --- offscreen history: suffix mounting window ----------------------------
  // Very long restored transcripts would mount (marked+DOMPurify per text
  // block) and lay out every block at once. `windowStart` is the absolute
  // block index below which history stays unmounted; it only ever DECREASES
  // (mount more old blocks), so streaming appends extend the suffix without
  // re-cutting already-mounted history. The effective start is clamped to the
  // block count so a stale window (session switched to a shorter transcript)
  // can never slice past the end.
  const [windowStart, setWindowStart] = useState(TAIL_WINDOW);
  const total = state.blocks.length;
  const start = Math.min(windowStart, total);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Scroll compensation for expansion: expandOlder() records the
  // distance-from-bottom (scrollHeight - scrollTop); the layout effect
  // restores it after the newly mounted blocks shift content down, keeping
  // the viewport visually anchored on the same blocks.
  const bottomDistance = useRef<number | null>(null);

  // Session switch / history restore: collapse back to the tail window.
  // Layout effect (not useEffect) so the trimmed list is painted on the first
  // commit — a plain effect would show one frame of a stale/empty slice when
  // the previous session left windowStart larger than the new block count.
  useLayoutEffect(() => {
    setWindowStart(Math.max(0, state.blocks.length - TAIL_WINDOW));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on identity change only
  }, [state.activeSessionId, state.replaying]);

  function expandOlder() {
    const el = scrollRef.current;
    if (el) bottomDistance.current = el.scrollHeight - el.scrollTop;
    setWindowStart((s) => Math.max(0, s - MOUNT_STEP));
  }

  useLayoutEffect(() => {
    const dist = bottomDistance.current;
    if (dist === null) return;
    bottomDistance.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - dist;
  });

  // Auto-expand: when the sentinel (placeholder above the mounted window)
  // approaches the viewport top, mount another MOUNT_STEP of history.
  // Re-created per `start` so one intersection expands exactly one step.
  useEffect(() => {
    if (start <= 0) return;
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) expandOlder();
      },
      { root, rootMargin: "480px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expandOlder reads refs only
  }, [start]);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    programmaticTop.current = el.scrollTop; // post-clamp actual value
  }

  const [showJump, setShowJump] = useState(false);

  // Follow-scroll trigger: a ResizeObserver on the content wrapper catches
  // EVERY growth path — streamed text, tool-card status/output flips,
  // SubAgent entry updates, plan changes, async image loads. The previous
  // block-shape deps (length/kind/last-text-length) missed all of those, so
  // the transcript stopped following the moment a tool card updated.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToBottom reads refs only
  }, []);

  // Session switch / history restore: jump to the end of the recovered
  // transcript and re-enable stick-to-bottom (the user may have been
  // scrolled up in the previous session).
  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    const raf = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(raf);
  }, [state.activeSessionId, state.replaying]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (programmaticTop.current !== null && Math.abs(el.scrollTop - programmaticTop.current) < 1) {
      programmaticTop.current = null; // consume once: our own follow-scroll
      return;
    }
    programmaticTop.current = null;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  }

  const turnActive =
    state.status === "streaming" && !state.replaying && !state.initializing;
  return (
    <div className="relative min-h-0 flex-1">
      <div className="message-scroll h-full overflow-y-auto px-3 pb-0.5 pt-3" ref={scrollRef} onScroll={onScroll}>
        <div ref={contentRef} className="space-y-3">
          {state.blocks.length === 0 && !state.replaying && (
            <div className="mt-10 text-center text-[12px] text-muted-foreground">
              {t("向 iFlow 发送第一条消息开始")}
            </div>
          )}
          {start > 0 && (
            // Sentinel + manual affordance: the IntersectionObserver mounts
            // more history when this approaches the viewport; the button is
            // the explicit fallback (and shows how much is still hidden).
            <div ref={sentinelRef} className="flex justify-center">
              <button
                onClick={expandOlder}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                {t("展开更早 {0} 条消息", start)}
              </button>
            </div>
          )}
          {state.blocks.slice(start).map((block, idx) => {
            const i = start + idx; // absolute index: stable across expansions
            return (
              <div key={block.id ?? `idx-${i}`} className="cv-block">
                <BlockView block={block} isLatest={i === total - 1} turnActive={turnActive} />
              </div>
            );
          })}
          {(state.status === "streaming" || state.initializing) && !state.pendingApproval && !state.replaying && state.blocks.length > 0 && (
            // Sticky to the bottom of the scroll viewport so the indicator stays
            // visible even while new content streams in above it.
            <div className="sticky bottom-1 z-10 flex justify-center">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-md">
                <Loader2 className="size-3 animate-spin" />
                {state.initializing ? t("正在创建新会话…") : t("正在生成")}
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="absolute bottom-3 right-4 z-20 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground shadow-md transition-opacity hover:opacity-90"
          onClick={() => {
            stickToBottom.current = true;
            scrollToBottom();
            setShowJump(false);
          }}
        >
          <ArrowDown className="inline size-3 align-[-1px]" />
          {t("回到最新")}
        </button>
      )}
    </div>
  );
}

export function MessageList() {
  const state = useChat((s) => s.state);
  if (!state) return null;
  return <MessageListInner state={state} />;
}