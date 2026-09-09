import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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

function StatusChip({ status }: { status: ToolBlock["status"] }) {
  // W2: the localized chip text is rebuilt only when the status changes.
  const chip = useMemo(() => {
    if (status === "completed")
      return (
        <Chip tone="success">
          <Check className="size-2.5" /> {t("已完成")}
        </Chip>
      );
    if (status === "failed")
      return (
        <Chip tone="danger">
          <X className="size-2.5" /> {t("失败")}
        </Chip>
      );
    return (
      <Chip tone="primary">
        <Loader2 className="size-2.5 animate-spin" /> {t("执行中")}
      </Chip>
    );
  }, [status]);
  return chip;
}

function OutputDetails({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  if (!output) return null;
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("操作输出")}
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output}
        </pre>
      )}
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
    <div className={`stream-in overflow-hidden rounded-lg border border-border bg-card status-${block.status}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0 text-[12px] font-semibold">{block.title || block.toolName || block.toolKind}</span>
        {primary && !hasDiff && <FileRef path={primary.path} line={primary.line} />}
        <span className="ml-auto flex items-center gap-1.5">
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
    <div className={`stream-in overflow-hidden rounded-lg border bg-card ${accent.border}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Bot className={`size-3.5 shrink-0 ${accent.icon}`} />
        <span className="min-w-0 truncate text-[12px] font-semibold">{localizeStepTitle(block.title)}</span>
        {block.agentType && (
          <Chip tone="muted">{block.agentType}</Chip>
        )}
        <span className="ml-auto">{statusChip}</span>
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
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("子智能体日志")}
          </button>
          {open && (
            <pre className="whitespace-pre-wrap border-t border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {log}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function ThoughtCard({ block }: { block: ThoughtBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stream-in rounded-lg border border-border/70 bg-panel/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Brain className="size-3.5 text-primary" />
        {t("思考过程")}
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          <Markdown text={block.text} />
        </div>
      )}
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
            <span className={entry.status === "completed" ? "text-muted-foreground line-through" : "text-foreground"}>
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
        {hasSummary ? (
          open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
        ) : (
          <CircleDot className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate">{block.notice}</span>
        {hasSummary && <Chip tone="muted">{t("上下文摘要")}</Chip>}
      </button>
      {open && block.summary && (
        <div className="border-t border-border/60 px-3 py-2">
          <div className="max-h-64 overflow-y-auto text-[12px] leading-relaxed text-muted-foreground">
            <Markdown text={block.summary} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Memoized per-block renderer (P4): the default shallow compare anchors on
 * the block reference. With P-1 block patches the unchanged prefix keeps its
 * references (`applyBlockPatch` reuses `blocks.slice(0, tailStart)`), so
 * streaming re-renders only the re-sent tail instead of the whole list.
 */
const BlockView = memo(function BlockView({ block }: { block: Block }) {
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
      return <ThoughtCard block={block} />;
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

function MessageListInner({ state }: { state: SessionState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
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

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    programmaticTop.current = el.scrollTop; // post-clamp actual value
  }

  const [showJump, setShowJump] = useState(false);

  // Re-render trigger: last block identity + text length.
  const last = state.blocks[state.blocks.length - 1];
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [state.blocks.length, last?.kind, (last && "text" in last ? last.text.length : 0)]);

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

  return (
    <div className="relative min-h-0 flex-1">
      <div className="message-scroll h-full space-y-3 overflow-y-auto px-3 pb-0.5 pt-3" ref={scrollRef} onScroll={onScroll}>
        {state.blocks.length === 0 && !state.replaying && (
          <div className="mt-10 text-center text-[12px] text-muted-foreground">
            {t("向 iFlow 发送第一条消息开始")}
          </div>
        )}
        {state.blocks.map((block, i) => (
          <BlockView key={block.id ?? `idx-${i}`} block={block} />
        ))}
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