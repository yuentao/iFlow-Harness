import { useEffect, useRef, useState } from "react";
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
  Search,
  SquareTerminal,
  Trash2,
  Undo2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { Block, SessionState, ThoughtBlock, ToolBlock } from "../../../shared/messages";
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
        <span className="ml-auto">
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
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-foreground">
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

function BlockView({ block }: { block: Block }) {
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
    case "plan":
      return <TaskList block={block} />;
  }
}

function MessageListInner({ state }: { state: SessionState }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Re-render trigger: last block identity + text length.
  const last = state.blocks[state.blocks.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.blocks.length, last?.kind, (last && "text" in last ? last.text.length : 0)]);

  // Session switch / history restore: jump to the end of the recovered
  // transcript and re-enable stick-to-bottom (the user may have been
  // scrolled up in the previous session).
  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [state.activeSessionId, state.replaying]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div className="message-scroll h-full space-y-3 overflow-y-auto px-3 py-3" ref={scrollRef} onScroll={onScroll}>
        {state.replaying && (
          <div className="flex justify-center">
            <Chip tone="info">
              <Loader2 className="size-2.5 animate-spin" /> {t("正在恢复历史会话…")}
            </Chip>
          </div>
        )}
        {state.blocks.length === 0 && !state.replaying && (
          <div className="mt-10 text-center text-[12px] text-muted-foreground">
            {t("向 iFlow 发送第一条消息开始")}
          </div>
        )}
        {state.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
        {state.status === "streaming" && !state.pendingApproval && (
          <div className="stream-in inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
            <Loader2 className="size-3 animate-spin" />
            {t("正在生成")}
            <span className="caret-blink inline-block h-3 w-[5px] bg-primary" />
          </div>
        )}
      </div>
      {showJump && (
        <button
          className="absolute bottom-3 right-4 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground shadow-md transition-opacity hover:opacity-90"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            stickToBottom.current = true;
            setShowJump(false);
          }}
        >
          {t("回到最新 ↓")}
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