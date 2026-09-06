import { useEffect, useRef, useState } from "react";
import type { Block, SessionState, ThoughtBlock, ToolBlock } from "../../../shared/messages";
import { useChat } from "../store";
import { Markdown } from "./Markdown";
import { DiffView } from "./DiffView";

const KIND_ICON: Record<string, string> = {
  read: "👁",
  edit: "✏",
  delete: "🗑",
  move: "📁",
  search: "🔍",
  execute: "⚡",
  think: "🧠",
  fetch: "🌐",
  other: "🔧",
};

const STATUS_ICON: Record<string, string> = {
  pending: "…",
  in_progress: "…",
  completed: "✓",
  failed: "✗",
};

function ToolLine({ block }: { block: ToolBlock }) {
  const send = useChat((s) => s.send);
  const primary = block.locations[0];
  const [showDiff, setShowDiff] = useState(true);
  const hasDiff = block.diff !== null;
  return (
    <div className={`tool-block status-${block.status}`}>
      <div className="tool-line">
        <span className="tool-icon">{STATUS_ICON[block.status] ?? KIND_ICON[block.toolKind] ?? "🔧"}</span>
        <span className="tool-title" title={block.toolName}>
          {block.title || block.toolName || block.toolKind}
        </span>
        {primary && (
          <a
            className="tool-loc"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              send({ type: "openLocation", path: primary.path, line: primary.line });
            }}
          >
            {primary.path.split(/[\\/]/).pop()}
          </a>
        )}
        {block.status === "completed" && hasDiff && block.diff!.oldText !== null && (
          <button
            className="btn tool-revert"
            title="将该文件恢复为编辑前内容"
            onClick={() => send({ type: "revertTool", toolCallId: block.toolCallId })}
          >
            ↩ Revert
          </button>
        )}
        {hasDiff && (
          <button className="tool-diff-toggle" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "▾ diff" : "▸ diff"}
          </button>
        )}
      </div>
      {hasDiff && showDiff && <DiffView diff={block.diff!} />}
      {block.output && (
        <details className="tool-output">
          <summary>输出</summary>
          <pre>{block.output}</pre>
        </details>
      )}
    </div>
  );
}

function ThoughtLine({ block }: { block: ThoughtBlock }) {
  return (
    <details className="thought">
      <summary>思考过程</summary>
      <Markdown text={block.text} />
    </details>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="msg user">
          <Markdown text={block.text} />
        </div>
      );
    case "text":
      return (
        <div className="msg assistant">
          <Markdown text={block.text} />
        </div>
      );
    case "thought":
      return <ThoughtLine block={block} />;
    case "tool":
      return <ToolLine block={block} />;
    case "plan":
      return (
        <div className="plan">
          {block.entries.map((entry, i) => (
            <div key={i} className={`plan-entry status-${entry.status ?? "pending"}`}>
              <span className="plan-check">{entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐"}</span>
              {entry.content}
            </div>
          ))}
        </div>
      );
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

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickToBottom.current = nearBottom;
    setShowJump(!nearBottom);
  }

  return (
    <div className="message-list-wrap">
      <div className="message-list" ref={scrollRef} onScroll={onScroll}>
        {state.blocks.length === 0 && <div className="empty-hint">向 iFlow 发送第一条消息开始</div>}
        {state.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
        {state.status === "streaming" && <div className="cursor">▍</div>}
      </div>
      {showJump && (
        <button
          className="jump-bottom"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            stickToBottom.current = true;
            setShowJump(false);
          }}
        >
          回到最新 ↓
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
