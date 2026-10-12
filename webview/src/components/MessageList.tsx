import {
  memo,
  useCallback,
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
  History,
  ListOrdered,
  Square,
  Pencil,
  Search,
  Trash2,
  Undo2,
  Wrench,
  X,
  XCircle,
  AlertTriangle,
  Info,
  Zap,
} from "lucide-react";
import type {
  Block,
  CheckpointUi,
  SessionState,
  SubAgentBlock,
  ThoughtBlock,
  ToolBlock,
} from "../../../shared/messages";
import { useChat, type ToastItem } from "../store";
import { t } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";
import { DiffView } from "./DiffView";
import { Chip, ConfirmDialog, FileRef } from "./ui";
import logo from "../assets/iflow.svg";

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

function OutputDetails({ output, truncatedChars }: { output: string; truncatedChars?: number }) {
  const [open, setOpen] = useState(false);
  if (!output) return null;
  const truncation =
    truncatedChars && truncatedChars > 0 ? (
      <span className="ml-1.5 shrink-0 font-mono text-[11px] text-warning">
        {t("已截断 {0} 字符", truncatedChars.toLocaleString())}
      </span>
    ) : null;
  // Fewer than 3 lines: show inline — a toggle around two short lines is
  // chrome, not utility. The fold only pays off once content is tall.
  const lineCount = output.trimEnd().split("\n").length;
  if (lineCount < 3) {
    return (
      <pre className="mx-2.5 mb-2.5 rounded-lg border border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {output}
        {truncation}
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
        {truncation}
      </button>
      <Collapse open={open}>
        <pre className="mx-2.5 mb-2.5 max-h-64 overflow-auto rounded-lg border border-border/60 bg-editor px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
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
    <div className={`stream-in status-fade card-lift overflow-hidden rounded-xl border border-border bg-card shadow-card status-${block.status}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Gradient tile behind the icon: gives dense tool cards a scannable
            glyph instead of a bare stroke icon floating on the card bg. */}
        <span className="tool-icon">
          <Icon className="size-3 shrink-0 text-primary" />
        </span>
        {/* min-w-0 truncate: agent tool titles are uncapped on the wire
            ("Running: <whole shell command>", task descriptions) — shrink-0
            here pushed the status chip out of the card. */}
        <span className="min-w-0 truncate text-[12px] font-semibold" title={block.title || block.toolName || block.toolKind}>
          {block.title || block.toolName || block.toolKind}
        </span>
        {primary && !hasDiff && <FileRef path={primary.path} line={primary.line} toolCallId={block.toolCallId} />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {block.reverted && (
            <Chip tone="muted">
              <Undo2 className="size-2.5" /> {t("已回退")}
            </Chip>
          )}
          {block.partiallyReverted && !block.reverted && (
            <Chip tone="muted">
              <Undo2 className="size-2.5" /> {t("部分回退")}
            </Chip>
          )}
          <StatusChip status={block.status} />
        </span>
      </div>
      {hasDiff && (
        <DiffView
          diff={block.diff!}
          toolCallId={block.toolCallId}
          hunkActions={
            completedWithDiff && block.diff!.newText !== null
              ? {
                  decisions: block.hunkDecisions,
                  onApply: (keep) => send({ type: "applyHunkSelection", toolCallId: block.toolCallId, keep }),
                }
              : undefined
          }
          actions={
            <>
              {completedWithDiff && (
                <>
                  <button
                    className="card-lift press inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
                    title={t("将该文件恢复为编辑前内容")}
                    onClick={() => send({ type: "revertTool", toolCallId: block.toolCallId })}
                  >
                    <Undo2 className="size-3" /> {t("回退此改动")}
                  </button>
                  <button
                    className="card-lift press inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
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
      <OutputDetails output={block.output} truncatedChars={block.truncatedChars} />
    </div>
  );
}

/**
 * CLI-generated step titles follow fixed English patterns; localize the known
 * prefixes (Launch agent / Reading / Running / Updating todos), keep the rest
 * verbatim.
 */
function localizeStepTitle(title: string): string {
  if (/^task$/i.test(title.trim())) return t("子代理");
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

/** Steps beyond this count are folded behind a "show earlier" toggle; the
 * newest steps stay visible because during streaming they arrive at the tail. */
const SUB_AGENT_VISIBLE_STEPS = 4;

function SubAgentCard({ block }: { block: SubAgentBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const send = useChat((s) => s.send);
  const state = useChat((s) => s.state);
  const active = block.status === "pending" || block.status === "in_progress";
  const canStop = active && state?.status === "streaming" && !!state.sessionId && !state.initializing && !state.replaying;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || block.startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, block.startedAt]);
  const duration = block.startedAt === undefined || (!active && block.completedAt === undefined)
    ? t("未知") : `${Math.max(0, Math.floor(((block.completedAt ?? now) - block.startedAt) / 1000))}s`;
  const children = block.entries.filter((b): b is SubAgentBlock => b.kind === "subagent");
  const nested = block.entries.filter((b): b is ToolBlock => b.kind === "tool");
  // W2: derived counter + localized chip text — memoized so re-renders that
  // don't change `entries` skip the t() replaceAll work.
  const done = useMemo(
    () => nested.filter((b) => b.status === "completed" || b.status === "failed").length,
    [block.entries],
  );
  const overflow = nested.length > SUB_AGENT_VISIBLE_STEPS;
  const hiddenCount = nested.length - SUB_AGENT_VISIBLE_STEPS;
  const visible = overflow && !expanded ? nested.slice(nested.length - SUB_AGENT_VISIBLE_STEPS) : nested;
  const progress = nested.length > 0 ? ` ${done}/${nested.length}` : "";
  const statusChip =
    block.stopped ? (
      <Chip tone="muted">
        <Square className="size-2.5" /> {t("已停止")}
      </Chip>
    ) : block.status === "completed" ? (
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

  const accent = agentAccent(block.agentType);

  return (
    <div className={`stream-in status-fade card-lift overflow-hidden rounded-xl border bg-card shadow-card ${accent.border}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="tool-icon">
          <Bot className={`size-3 shrink-0 ${accent.icon}`} />
        </span>
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
        {canStop && (
          <button className="press shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
            title={t("停止此子代理")} aria-label={t("停止此子代理")}
            onClick={() => send({ type: "stopSubagent", sessionId: state!.sessionId!, agentId: block.agentId })}>
            <Square className="size-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-3 px-3 pb-2 font-mono text-[11px] text-muted-foreground">
        <span title={t("子代理 token 为转录估算，包含子代理")}>≈ {block.tokens === undefined ? t("未知") : block.tokens.toLocaleString()} tokens</span>
        <span>{t("耗时")} {duration}</span>
      </div>
      {block.entries.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          <ul className="space-y-1.5">
            {visible.map((t2) => (
              <li key={t2.toolCallId} className="flex items-center gap-2 text-[12px]">
                {stepIcon(t2.status)}
                <span className={`min-w-0 truncate ${t2.status === "completed" ? "text-muted-foreground" : "text-foreground"}`}>
                  {localizeStepTitle(t2.title || t2.toolName)}
                </span>
              </li>
            ))}
          </ul>
          {children.length > 0 && (
            <div className="mt-2 space-y-1.5 border-l border-border/70 pl-2">
              {children.map((child) => <SubAgentCard key={child.id ?? child.agentId} block={child} />)}
            </div>
          )}
          <button
            onClick={() => setTranscriptOpen((v) => !v)}
            className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {transcriptOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            {transcriptOpen ? t("收起") : t("只读转录")}
          </button>
          <Collapse open={transcriptOpen}>
            <div className="mt-1 space-y-1 border-l border-border/50 pl-2 text-[11px] text-muted-foreground">
              {block.entries.map((entry, index) => <ReadOnlySubAgentEntry key={entry.id ?? `${entry.kind}-${index}`} block={entry} />)}
            </div>
          </Collapse>
          {overflow && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? t("收起") : t("显示更早 {0} 条", String(hiddenCount))}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReadOnlySubAgentEntry({ block }: { block: Block }) {
  if (block.kind === "subagent") return null; // Rendered once in the tree above.
  if (block.kind === "tool") return <div><div>{localizeStepTitle(block.title || block.toolName)} · <StatusChip status={block.status} /></div><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{block.output}</pre></div>;
  if (block.kind === "thought") return <div><Brain className="mr-1 inline size-3" />{block.text}</div>;
  if (block.kind === "text" || block.kind === "user") return <Markdown text={block.text} />;
  if (block.kind === "plan") return <TaskList block={block} />;
  return <div>{block.notice}</div>;
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
    <div className="stream-in card-lift overflow-hidden rounded-xl border border-border/70 bg-panel/60 shadow-card">
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
    <div className="stream-in card-lift rounded-xl border border-border bg-card px-3 py-2.5 shadow-card">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
        <CircleDot className="size-3.5 text-primary" />
        {t("任务清单")}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
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

function UserMessage({
  block,
  canDelete,
  checkpoint,
  isLastUser,
  onEditingChange,
}: {
  block: Extract<Block, { kind: "user" }>;
  canDelete: boolean;
  /** This turn's workspace checkpoint (M3 P0-1); absent → no rollback entry. */
  checkpoint?: CheckpointUi;
  /** P1-5: the newest user bubble shows its action icons at full opacity —
   * rollback is a headline capability and must not hide behind hover. */
  isLastUser: boolean;
  /** Reports inline-editor open/close so the parent can hide the floating
   * "jump to latest" pill (z-20, bottom-right) while editing — a near-bottom
   * bubble's editor action row would otherwise sit under the pill. Stable
   * parent callback (BlockView is memo'd); identifies THIS bubble. */
  onEditingChange?: (blockId: string, editing: boolean) => void;
}) {
  const send = useChat((s) => s.send);
  // P1-5: action icons ride at 40% instead of vanishing (opacity-0 made the
  // rollback/edit/delete affordances undiscoverable); hover lifts to 100, and
  // the newest bubble is always fully visible.
  const actionBtnClass = (danger = false) =>
    `press shrink-0 rounded-md border border-border bg-panel/90 p-1 text-muted-foreground shadow-card backdrop-blur-md transition-all hover:bg-surface hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
      isLastUser ? "opacity-100" : "opacity-40"
    } group-hover:opacity-100${danger ? " hover:bg-destructive/10 hover:text-destructive" : ""}`;
  // P1-8: rollback moved from an inline armed pill-row to the shared
  // ConfirmDialog (three-action variant) — delete already uses the dialog,
  // and one dangerous-action language across the product beats three.
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // M4 P1-9: draft for the inline editor; null = not editing.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!canDelete) {
      setConfirmRollback(false);
      setDraft(null);
    }
  }, [canDelete]);
  const editing = draft !== null;
  const editingBlockId = block.id;
  useEffect(() => {
    if (!editingBlockId) return;
    onEditingChange?.(editingBlockId, editing);
    return () => onEditingChange?.(editingBlockId, false);
  }, [editingBlockId, editing, onEditingChange]);
  const canRollbackFiles = !!checkpoint && !checkpoint.partial;
  const showRollback = canDelete && !!block.id && !!checkpoint;
  const rollback = (mode: "files" | "conversation" | "both") => {
    setConfirmRollback(false);
    send({ type: "restoreCheckpoint", userBlockId: block.id!, mode });
  };
  const startEdit = () => {
    setDraft(block.text);
  };
  const cancelEdit = () => {
    setDraft(null);
  };
  const submitEdit = () => {
    const text = (draft ?? "").trim();
    if (!text || !block.id) return;
    setDraft(null);
    send({ type: "editAndResend", blockId: block.id, text });
  };
  return (
    <div className="stream-in flex justify-end">
      {/* user-bubble scopes the attached-code-context styling (styles.css):
          fenced blocks here read as right-clicked source context, not as
          model output. */}
      <div className="user-bubble group relative max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-card" style={{ backgroundImage: "var(--gradient-user)" }}>
        {draft !== null ? (
          /* M4 P1-9 inline editor: re-sending truncates this turn and
             everything after it (checkpoint restore first when available),
             so the editor replaces the bubble rather than cloning it. */
          <div className="w-full min-w-[280px]" onClick={(e) => e.stopPropagation()}>
            <textarea
              className="max-h-64 min-h-16 w-full resize-y rounded-lg border border-border bg-panel/80 px-2 py-1.5 text-[13px] leading-relaxed text-foreground outline-none focus:border-primary/60"
              value={draft}
              rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              <span className="mr-auto text-[11px] text-muted-foreground">
                {checkpoint && !checkpoint.partial ? t("重发将先回滚该轮文件变更并删除其后的对话") : t("重发将删除该消息及其后所有对话")}
              </span>
              <button
                className="press rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
                onClick={cancelEdit}
              >
                {t("取消")}
              </button>
              <button
                className="press rounded-md bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!draft.trim()}
                title={t("重发")}
                onClick={submitEdit}
              >
                {t("重发")}
              </button>
            </div>
          </div>
        ) : (
          <>
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
        {/* subtle inner highlight so the bubble reads as a solid plane */}
        <div className="pointer-events-none absolute inset-0 rounded-2xl shadow-inner" />
        {(canDelete || showRollback) && (
          <div className="absolute -top-2.5 right-1 z-10 flex items-center gap-1">
            {showRollback && (
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <button
                  className={actionBtnClass()}
                  title={t("回滚到此轮之前")}
                  onClick={() => setConfirmRollback(true)}
                >
                  <History className="size-3" />
                </button>
              </div>
            )}
            {canDelete && block.id && (
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <button
                  className={actionBtnClass()}
                  title={t("编辑并重发该消息")}
                  onClick={() => (editing ? cancelEdit() : startEdit())}
                >
                  <Pencil className="size-3" />
                </button>
              </div>
            )}
            {canDelete && block.id && (
              <button
                data-variant="danger"
                className={actionBtnClass(true)}
                title={t("删除该消息及其后所有内容")}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        )}
          </>
        )}
      </div>

      {confirmRollback && (
        <ConfirmDialog
          title={t("回滚到此轮之前")}
          message={
            canRollbackFiles
              ? t("选择回滚范围：文件恢复到此轮之前、删除该消息及其后对话，或两者都要。")
              : t("该轮快照不完整，无法恢复文件，只能删除该消息及其后所有对话。")
          }
          onCancel={() => setConfirmRollback(false)}
          actions={[
            {
              label: t("文件"),
              title: canRollbackFiles ? t("仅回滚工作区文件到本轮之前") : t("该轮快照不完整，无法恢复文件"),
              disabled: !canRollbackFiles,
              onClick: () => rollback("files"),
            },
            {
              label: t("对话"),
              title: t("仅删除该消息及其后所有对话"),
              onClick: () => rollback("conversation"),
            },
            {
              label: t("全部"),
              title: canRollbackFiles ? t("回滚文件并删除该消息及其后所有对话") : t("该轮快照不完整，无法恢复文件"),
              disabled: !canRollbackFiles,
              variant: "primary",
              onClick: () => rollback("both"),
            },
          ]}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("删除消息")}
          message={t("确定删除该消息及其后所有内容吗？此操作不可撤销。")}
          onConfirm={() => {
            setConfirmDelete(false);
            send({ type: "deleteUserMessage", blockId: block.id! });
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** Collapsible context-compression card (slash /compress). The carried
 * conversation summary is long, so it stays folded until requested. */
function CompressionCard({ block }: { block: Extract<Block, { kind: "compression" }> }) {
  const [open, setOpen] = useState(false);
  const hasSummary = block.summary !== null;
  return (
    <div className="stream-in card-lift overflow-hidden rounded-xl border border-border/60 bg-card shadow-card">
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
  canCopy,
  canRegenerate,
  canDelete,
  checkpoint,
  isLastUser,
  onRegenerate,
  onEditingChange,
}: {
  block: Block;
  isLatest: boolean;
  turnActive: boolean;
  /** False while replaying (history restore) — the replay placeholder is a
   * text block and must not grow copy/regenerate icons. */
  canCopy: boolean;
  canRegenerate: boolean;
  /** Deleting is only offered on a settled transcript (not replaying /
   * initializing / streaming) — mirrors the host-side gate. */
  canDelete: boolean;
  /** This turn's checkpoint (user blocks only, M3 P0-1). */
  checkpoint?: CheckpointUi;
  /** P1-5: newest user bubble keeps its action icons visible. */
  isLastUser: boolean;
  onRegenerate: () => void;
  /** M4 P1-9: forwarded to UserMessage's inline editor (see there). */
  onEditingChange?: (blockId: string, editing: boolean) => void;
}) {
  switch (block.kind) {
    case "user":
      return (
        <UserMessage
          block={block}
          canDelete={canDelete}
          checkpoint={checkpoint}
          isLastUser={isLastUser}
          onEditingChange={onEditingChange}
        />
      );
    case "text":
      // Whitespace-only text blocks (streaming separators like "\n\n" between
      // tool calls) render as an orphaned avatar on an empty row — Markdown
      // outputs nothing for them. Skip the whole row.
      if (!block.text.trim()) return null;
      // Host-classified status text (compression chatter, approval/plan
      // resolution notes): a muted system line — no brand avatar, and no
      // copy/regenerate actions (it is not an assistant reply).
      if (block.system) {
        return (
          <div className="system-note stream-in pl-0.5 text-[12px] leading-relaxed text-muted-foreground">
            <Markdown text={block.text} />
          </div>
        );
      }
      return (
        <div className="stream-in group">
          <div className="assistant-row">
            <span className="assistant-avatar">
              {/* Real brand mark, consistent with the header logo */}
              <img src={logo} alt="" className="size-3.5" />
            </span>
          {/* Shimmer rides the BODY column, not the whole row: on the row it
              painted a full-width rectangular band behind the avatar (no
              radius/padding) and read as a disjointed stripe. */}
          <div
            className={`assistant-body text-[13px] leading-relaxed text-foreground/90 ${
              isLatest && turnActive ? "stream-shimmer" : ""
            }`}
          >
            {/* Trailing inline action icons follow the text end: regenerate
                (latest turn, idle) rides beside copy — no overlay on the
                message, no extra row. */}
            <Markdown
              text={block.text}
              showCopyIcon={canCopy}
              onRegenerate={isLatest && canCopy && canRegenerate ? onRegenerate : undefined}
            />
          </div>
          </div>
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

/** P0-4 empty-state examples: localized at render time (the locale arrives
 * with the first snapshot, later than module evaluation). */
const EXAMPLE_PROMPTS = [
  "帮我梳理这个仓库的结构与核心模块",
  "给核心模块补充单元测试",
  "分析这个报错的可能原因并给出修复方案",
];

function MessageListInner({ state }: { state: SessionState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const setHeaderScrolled = useChat((s) => s.setHeaderScrolled);
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
  // True while an animated (smooth) jump-to-latest is running; onScroll must
  // ignore stick-state updates during the animation so the button doesn't
  // flicker back mid-flight.
  const smoothScrolling = useRef(false);

  // --- offscreen history: suffix mounting window ----------------------------
  // Very long restored transcripts would mount (marked+DOMPurify per text
  // block) and lay out every block at once. `windowStart` is the absolute
  // block index below which history stays unmounted. It moves DOWN as the
  // user scrolls up (expandOlder mounts more history) and UP again while
  // streaming to keep the mounted tail bounded (trim effect below), so a
  // long-running session never accumulates an unbounded DOM. The effective
  // start is clamped to the block count so a stale window (session switched
  // to a shorter transcript) can never slice past the end.
  const MAX_WINDOW = TAIL_WINDOW * 2; // mounted-tail budget while streaming
  const [windowStart, setWindowStart] = useState(TAIL_WINDOW);
  // M1 P1-3 Focus view: a pure RENDER filter over the host transcript (the
  // host state is never modified). tool / thought / system / plan /
  // compression cards collapse; user + assistant text remain. The mounting
  // window, sentinel counts and empty-state all key off this filtered view.
  const focusMode = useChat((s) => s.focusMode);
  const visibleBlocks = useMemo(
    () => (focusMode ? state.blocks.filter((b) => b.kind === "user" || (b.kind === "text" && !b.system)) : state.blocks),
    [state.blocks, focusMode],
  );
  // M3 P0-1: index the turn checkpoints by their anchor user-block id so each
  // user bubble can look up its own rollback entry in O(1).
  const checkpointByBlockId = useMemo(() => {
    const map = new Map<string, CheckpointUi>();
    for (const c of state.checkpoints ?? []) map.set(c.userBlockId, c);
    return map;
  }, [state.checkpoints]);
  const total = visibleBlocks.length;
  const start = Math.min(windowStart, total);
  // P1-5: index (within the RENDERED visibleBlocks, which focusMode may have
  // filtered — user blocks always survive that filter) of the newest user
  // bubble whose action icons stay visible. total-keyed: user blocks are
  // append-only, same invariant as lastUserText.
  const lastUserIndex = useMemo(() => {
    for (let i = total - 1; i >= 0; i--) {
      if (visibleBlocks[i]?.kind === "user") return i;
    }
    return -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see lastUserText
  }, [total]);
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
    setWindowStart(Math.max(0, visibleBlocks.length - TAIL_WINDOW));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on identity change only
  }, [state.activeSessionId, state.replaying, focusMode]);

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

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && "scrollTo" in el) {
      // Animated jump-to-latest. Suppress stick-state updates during the
      // animation so the jump button doesn't flicker back mid-flight.
      smoothScrolling.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => {
        smoothScrolling.current = false;
      }, 500);
      programmaticTop.current = el.scrollTop; // pre-animation value
      return;
    }
    el.scrollTop = el.scrollHeight;
    programmaticTop.current = el.scrollTop; // post-clamp actual value
  }

  const [showJump, setShowJump] = useState(false);
  // M4 P1-9: the user bubble whose inline editor is open (at most one at a
  // time). While set, the floating "jump to latest" pill hides — it is a
  // z-20 bottom-right overlay and would sit on top of the editor's action
  // row for a bubble near the viewport bottom.
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const handleEditingChange = useCallback((blockId: string, editing: boolean) => {
    setEditingBlockId((prev) =>
      editing ? blockId : prev === blockId ? null : prev,
    );
  }, []);

  // Streaming-tail trim: while the user is reading new content at the bottom,
  // the mounted window must stay bounded — otherwise a long session appends
  // blocks forever and the offscreen-mounting optimization (which only fires
  // on session restore / scroll-up expansion) never re-prunes. When the
  // MOUNTED count exceeds the MAX_WINDOW budget AND the view is pinned to the
  // bottom, slide windowStart forward and re-anchor; if the user has scrolled
  // up to read history, do nothing (respect their position — the sentinel
  // above will expand history on demand as before).
  // Runs after EVERY commit: the trim must also re-arm when the user RETURNS
  // to the bottom (onScroll flips stickToBottom → setShowJump(false) renders,
  // but total/start are unchanged so a deps-keyed effect would never re-run).
  // The guards below are O(1); the trim itself fires at most once per budget
  // breach, so per-render evaluation is cheap.
  useEffect(() => {
    if (total - start <= MAX_WINDOW) return;
    if (!stickToBottom.current) return;
    setWindowStart((s) => Math.max(s, total - MAX_WINDOW));
    // Pinned trim: the bottom edge is shared by old and new blocks, so after
    // the head is cut the viewport must simply stay at the (new) bottom —
    // NO bottomDistance compensation here. Recording dist pre-trim and
    // restoring it post-trim raced the async onScroll: the restore's scroll
    // event landed with a stale programmaticTop, read the mid-trim
    // scrollHeight as "user scrolled up" and froze the trim (measured:
    // stickToBottom flipped false right after the first trim). scrollToBottom
    // stamps programmaticTop, so the async scroll event is consumed instead.
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable fns
  });
  // Follow-scroll trigger: a ResizeObserver on the content wrapper catches
  // EVERY growth path — streamed text, tool-card status/output flips,
  // SubAgent entry updates, plan changes, async image loads. The previous
  // block-shape deps (length/kind/last-text-length) missed all of those, so
  // the transcript stopped following the moment a tool card updated.
  // The scroller itself is observed too: its height changes on panel resize
  // or approval/question card mount/unmount (rendered outside the scroll
  // area), which can flip content between fitting and overflowing WITHOUT a
  // scroll event — the header shadow flag must re-sync there.
  useEffect(() => {
    const el = contentRef.current;
    const scroller = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
      syncHeaderScrolled();
    });
    // border-box: the floating approval/question card changes the content's
    // padding-bottom via --pending-card-h; a content-box observation (the
    // default) does not fire on padding changes, so in stick-to-bottom mode
    // the newest message would stay pinned under the card instead of
    // scrolling clear of it.
    ro.observe(el, { box: "border-box" });
    if (scroller) ro.observe(scroller);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToBottom/syncHeaderScrolled read refs only
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

  // Prompt sent: force the jump to the live turn regardless of the current
  // scroll position (see promptSeq on ChatStore for why). The user block
  // itself arrives a round-trip later; re-arming stickToBottom here makes the
  // RO follow pick it up on arrival.
  const promptSeq = useChat((s) => s.promptSeq);
  useEffect(() => {
    if (promptSeq === 0) return;
    stickToBottom.current = true;
    setShowJump(false);
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToBottom reads refs only
  }, [promptSeq]);

  // Approval / question / plan-exit cards render OUTSIDE the scroll area
  // (App.tsx), so unmounting any of them never touches the content RO — the
  // scroll container just grows by the card height, leaving the transcript
  // tail floating above an empty gap. All three answers reseed the agent
  // (semantically "continue", like sending a prompt), so any card
  // disappearing re-anchors the viewport. This fixed the reported "answering
  // the question card doesn't scroll to the latest message" bug; the
  // approval card shares the exact same layout, and the plan-exit card the
  // reported "exiting plan mode doesn't follow the scroll" one.
  const prevApproval = useRef(state.pendingApproval);
  const prevQuestions = useRef(state.pendingQuestions);
  const prevPlanExit = useRef(state.pendingPlanExit);
  useEffect(() => {
    const approvalCleared = prevApproval.current !== null && state.pendingApproval === null;
    const questionsCleared = prevQuestions.current !== null && state.pendingQuestions === null;
    const planExitCleared = prevPlanExit.current !== null && state.pendingPlanExit === null;
    prevApproval.current = state.pendingApproval;
    prevQuestions.current = state.pendingQuestions;
    prevPlanExit.current = state.pendingPlanExit;
    if (!approvalCleared && !questionsCleared && !planExitCleared) return;
    stickToBottom.current = true;
    setShowJump(false);
    const raf = requestAnimationFrame(() => scrollToBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToBottom reads refs only
    return () => cancelAnimationFrame(raf);
  }, [state.pendingApproval, state.pendingQuestions, state.pendingPlanExit]);

  /** Re-sync the header shadow flag from the current scroll position.
   * Scroll events alone miss resizes: when the panel is resized (or a card
   * above/below changes layout) and content flips between "fits" and
   * "overflows" WITHOUT firing a scroll event, the browser clamps scrollTop
   * silently — the flag would stay stale until the next scroll. Resize
   * observers below call this too. zustand's Object.is compare makes
   * same-value sets free. */
  function syncHeaderScrolled() {
    const el = scrollRef.current;
    if (!el) return;
    setHeaderScrolled(el.scrollTop > 4);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (smoothScrolling.current) return; // mid animated jump; state already set
    if (programmaticTop.current !== null && Math.abs(el.scrollTop - programmaticTop.current) < 1) {
      programmaticTop.current = null; // consume once: our own follow-scroll
      return;
    }
    programmaticTop.current = null;
    syncHeaderScrolled();
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  }

  const turnActive =
    state.status === "streaming" && !state.replaying && !state.initializing;

  // Last user prompt + a regenerate handler: the webview sends a host-backed
  // `regenerate` message; the host re-runs the preceding user prompt (it owns
  // transcript state, so it extracts the text rather than the webview).
  const lastUserText = useMemo(() => {
    for (let i = total - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (b.kind === "user") return b.text;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on total only:
    // user blocks are always APPENDED (beginUserPrompt/replay), so a new user
    // text implies total grew; the blocks reference changes on every patch
    // and must not re-trigger this reverse scan.
  }, [total]);

  const canRegenerate =
    !turnActive &&
    state.status !== "connecting" &&
    !state.replaying &&
    !state.initializing &&
    !state.pendingApproval &&
    !state.pendingQuestions &&
    lastUserText !== null;

  const onRegenerate = () => {
    useChat.getState().send({ type: "regenerate" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div className="message-scroll h-full overflow-y-auto px-3 pb-3.5 pt-3" ref={scrollRef} onScroll={onScroll}>
        {/* --pending-card-h: height of the floating approval/question/plan card
            overlay (set by App's ResizeObserver on the shared wrapper). The
            card floats over this scroller, so the content reserves its height
            as bottom padding — otherwise the newest message would sit
            permanently under the card. */}
        <div ref={contentRef} className="space-y-3" style={{ paddingBottom: "var(--pending-card-h, 0px)" }}>
          {visibleBlocks.length === 0 && !state.replaying && (
            <div className="empty-state stream-in">
              <div className="empty-state-logo">
                {/* Real brand mark, consistent with the header logo */}
                <img src={logo} alt="" className="size-6" />
              </div>
              <div className="text-[14px] font-semibold text-foreground">
                {t("准备好了，向 iFlow 提问吧")}
              </div>
              <p className="max-w-[280px] text-[11.5px] leading-relaxed text-muted-foreground">
                {t("下发任务、粘贴代码上下文，或直接描述你想实现的功能")}
              </p>
              {/* P0-4: example prompts lower the first-message barrier — a
                  click fills the composer (never clobbers a typed draft). */}
              <div className="mt-3 flex max-w-[300px] flex-col items-stretch gap-1.5">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex}
                    className="card-lift press rounded-xl border border-border bg-card/80 px-3 py-1.5 text-left text-[11.5px] text-foreground/90 shadow-card transition-colors hover:border-primary/40 hover:bg-surface-2"
                    onClick={() => useChat.getState().requestDraft(t(ex))}
                  >
                    {t(ex)}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
                {t("/ 命令 · @ 文件 · @problems · @git · 粘贴文件添加附件")}
              </p>
            </div>
          )}
          {start > 0 && (
            // Sentinel + manual affordance: the IntersectionObserver mounts
            // more history when this approaches the viewport; the button is
            // the explicit fallback (and shows how much is still hidden).
            <div ref={sentinelRef} className="flex justify-center">
              <button
                onClick={expandOlder}
                className="card-lift press inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground shadow-card transition-colors hover:bg-surface hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                {t("展开更早 {0} 条消息", start)}
              </button>
            </div>
          )}
          {visibleBlocks.slice(start).map((block, idx) => {
            const i = start + idx; // absolute index: stable across expansions
            return (
              <div key={block.id ?? `idx-${i}`} className="cv-block">
                <BlockView
        block={block}
        isLatest={i === total - 1}
        turnActive={turnActive}
        canCopy={!state.replaying}
        canRegenerate={canRegenerate && i === total - 1}
        checkpoint={block.kind === "user" && block.id ? checkpointByBlockId.get(block.id) : undefined}
        isLastUser={i === lastUserIndex}
        canDelete={
          !state.replaying &&
          !state.initializing &&
          state.status !== "connecting" &&
          state.status !== "streaming" &&
          !state.pendingApproval &&
          !state.pendingQuestions &&
          !state.pendingPlanExit
        }
        onRegenerate={onRegenerate}
        onEditingChange={handleEditingChange}
      />
              </div>
            );
          })}
          {/* P1-11: queued-message echo — right after the transcript tail so
              pressing Enter mid-turn gives instant feedback IN the transcript
              (the QueueStrip sits above the composer and is easy to miss).
              Rides the host's queue array directly: an entry vanishes the
              moment the host dequeues it, no client-side matching. */}
          {(state.queue ?? []).map((q) => (
            <div key={q.id} className="stream-in flex justify-end">
              <div className="flex max-w-[85%] items-start gap-1.5 rounded-2xl rounded-br-md border border-dashed border-border bg-surface/40 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
                <span className="min-w-0 whitespace-pre-wrap break-words opacity-70">
                  {q.text || t("（附件消息）")}
                </span>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-[1px] text-[11px] font-medium text-primary">
                  <ListOrdered className="size-2.5" /> {t("排队中")}
                </span>
              </div>
            </div>
          ))}
          {(state.status === "streaming" || state.initializing) && !state.pendingApproval && !state.replaying && visibleBlocks.length > 0 && (
            // Sticky to the bottom of the scroll viewport so the indicator stays
            // visible even while new content streams in above it.
            // pointer-events-none: the composer's upward-opening mode dropdown
            // expands into this area — the pill must not steal its clicks.
            <div className="pointer-events-none sticky bottom-2 z-10 flex justify-center py-1.5">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-[11.5px] font-medium text-primary-foreground shadow-lg">
                <Loader2 className="size-3 animate-spin" />
                {state.initializing ? t("正在创建新会话…") : t("正在生成")}
              </div>
            </div>
          )}
          {state.replaying && (
            // History restore indicator — dedicated UI (not a transcript block),
            // so it never mixes with the restored content or grows copy icons.
            <div className="pointer-events-none sticky bottom-2 z-10 flex justify-center py-1.5">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-1.5 text-[11.5px] font-medium text-primary-foreground shadow-lg">
                <Loader2 className="size-3 animate-spin" />
                {t("正在恢复历史会话…")}
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump && !editingBlockId && (
        <button
          className="card-lift press jump-pulse absolute bottom-3 right-4 z-20 inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-card hover:bg-surface-2"
          style={{ bottom: "calc(0.75rem + var(--pending-card-h, 0px))" }}
          onClick={() => {
            stickToBottom.current = true;
            scrollToBottom(true);
            setShowJump(false);
          }}
        >
          <ArrowDown className="inline size-3 align-[-1px]" />
          {t("回到最新")}
        </button>
      )}
      <Toasts />
    </div>
  );
}

/** Transient host notices (rate-limit retry / context-overflow compress),
 * rendered as a centered stack above the streaming indicator. Plain toasts
 * auto-dismiss on a timer and dismiss early on click; countdown retries and
 * display-only/persistent pills are not clickable — persistent ones stay
 * until the host removes them (dismissToast). */
function Toasts() {
  const toasts = useChat((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex flex-col items-center gap-1.5 px-3">
      {toasts.map((t) => (
        <ToastPill key={t.id} toast={t} />
      ))}
    </div>
  );
}

/** One toast pill. When `countdownDeadline` (host epoch-ms) is set, the live
 * countdown is anchored to that absolute deadline so the UI stays in sync with
 * the host's actual wait — no drift from the message round-trip latency. */
function ToastPill({ toast }: { toast: ToastItem }) {
  const dismiss = useChat((s) => s.dismissToast);
  const [secs, setSecs] = useState(
    toast.countdownDeadline ? Math.ceil((toast.countdownDeadline - Date.now()) / 1000) : 0,
  );
  useEffect(() => {
    if (toast.countdownDeadline === undefined) return;
    const deadline = toast.countdownDeadline;
    let last = -1;
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      const s = Math.ceil(left / 1000);
      if (s !== last) {
        last = s;
        setSecs(s);
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [toast.countdownDeadline]);
  const tone =
    toast.level === "error"
      ? "border-destructive/40 bg-destructive/15 text-destructive"
      : toast.level === "warning"
        ? "border-warning/40 bg-warning/15 text-warning"
        : "border-border bg-card/90 text-foreground";
  const body = (
    <>
      {toast.level === "warning" && <AlertTriangle className="size-3.5 shrink-0" />}
      {toast.level === "error" && <XCircle className="size-3.5 shrink-0" />}
      {toast.level === "info" && <Info className="size-3.5 shrink-0 text-primary" />}
      <span className="break-words text-left">{toast.message}</span>
      {toast.countdownDeadline !== undefined && (
        <span className="ml-0.5 shrink-0 font-mono tabular-nums opacity-80">{secs}s</span>
      )}
    </>
  );
  // M1 P0-6: an inline action (e.g. 立即压缩) rides its own button — the pill
  // body stays non-clickable when host-owned (persistent/display-only), but
  // the action must always be reachable.
  const actionButton =
    toast.action && (
      <button
        onClick={() =>
          useChat.getState().send({ type: "toastAction", actionId: toast.action!.actionId, toastId: toast.toastId })
        }
        className="ml-1 shrink-0 rounded-md border border-current/40 px-1.5 py-0.5 text-[11px] font-semibold opacity-90 transition-opacity hover:opacity-100"
      >
        {toast.action.label}
      </button>
    );
  // Display-only pills (countdown retries, host-flagged / persistent notices
  // like the context-overflow compress): the wait is owned by the host (it
  // dismisses the toast when the retry fires / the compress turn ends), so
  // clicking must not falsely imply the user can cancel or skip it.
  if (toast.countdownDeadline !== undefined || toast.displayOnly || toast.persistent) {
    return (
      <div
        className={`pointer-events-auto stream-in flex max-w-[92%] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11.5px] shadow-card backdrop-blur-md ${tone}`}
      >
        {body}
        {actionButton}
      </div>
    );
  }
  return (
    <button
      onClick={() => dismiss(toast.id)}
      className={`pointer-events-auto stream-in flex max-w-[92%] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11.5px] shadow-card backdrop-blur-md ${tone}`}
    >
      {body}
    </button>
  );
}

export function MessageList() {
  const state = useChat((s) => s.state);
  if (!state) return null;
  // Inline boundary: a transcript render throw (e.g. markdown parsing a
  // pathological streaming chunk) must not unmount the header/composer, let
  // alone the whole panel. resetKey is the state reference — new on every
  // snapshot/blockPatch — so the next host update auto-retries the render;
  // a transient bad chunk heals without reopening the tab.
  return (
    <ErrorBoundary variant="inline" resetKey={state}>
      <MessageListInner state={state} />
    </ErrorBoundary>
  );
}