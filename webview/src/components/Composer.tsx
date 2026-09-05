import { useMemo, useRef, useState } from "react";
import type { SlashCommand } from "../../../shared/messages";
import { useChat } from "../store";

export function Composer() {
  const state = useChat((s) => s.state);
  const send = useChat((s) => s.send);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const streaming = state?.status === "streaming";
  const commands: SlashCommand[] = state?.commands ?? [];

  const suggestion = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return null;
    const input = text.slice(1).toLowerCase();
    return commands.find((c) => c.name.toLowerCase().startsWith(input)) ?? null;
  }, [text, commands]);

  function submit() {
    const value = text.trim();
    if (!value || streaming) return;
    send({ type: "sendPrompt", text: value });
    setText("");
  }

  return (
    <div className="composer">
      {suggestion && (
        <div className="cmd-hint">
          <span className="cmd-name">/{suggestion.name}</span>
          <span className="cmd-desc">{suggestion.description}</span>
          <span className="cmd-key">Tab 补全</span>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={text}
          placeholder="向 iFlow 提问…（/ 唤起命令）"
          rows={Math.min(6, text.split("\n").length)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && suggestion) {
              e.preventDefault();
              setText(`/${suggestion.name} `);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="btn stop" title="停止生成" onClick={() => send({ type: "cancel" })}>
            ■
          </button>
        ) : (
          <button className="btn send" title="发送 (Enter)" disabled={!text.trim()} onClick={submit}>
            ➤
          </button>
        )}
      </div>
    </div>
  );
}