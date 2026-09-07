import { useEffect, useMemo, useRef, useState } from "react";
import type { FileHitUi, SlashCommand } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";

/** One attached image (base64, no data: prefix). */
export interface ImageAttachment {
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function Composer() {
  const state = useChat((s) => s.state);
  const send = useChat((s) => s.send);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // --- @-mention file search (M5) ---
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHits, setMentionHits] = useState<FileHitUi[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (mentionQuery === null) return;
    const q = mentionQuery.trim();
    const requestId = ++searchSeq.current;
    const timer = setTimeout(() => send({ type: "searchFiles", requestId, query: q }), 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "fileList" && msg.requestId === searchSeq.current) {
        setMentionHits(msg.hits ?? []);
        setMentionIndex(0);
        return;
      }
      if (msg?.type === "setDraft" && typeof msg.text === "string") {
        // Right-click "Add to iFlow Context": prefill + focus the composer.
        setText(msg.text);
        setMentionQuery(null);
        requestAnimationFrame(() => taRef.current?.focus());
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const streaming = state?.status === "streaming";
  const commands: SlashCommand[] = state?.commands ?? [];

  const suggestion = useMemo(() => {
    if (!text.startsWith("/") || text.includes(" ")) return null;
    const input = text.slice(1).toLowerCase();
    return commands.find((c) => c.name.toLowerCase().startsWith(input)) ?? null;
  }, [text, commands]);

  function addImages(files: ArrayLike<File>): void {
    const incoming = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.size <= MAX_IMAGE_BYTES,
    );
    // Updaters must stay side-effect free: React may run them lazily and, in
    // StrictMode, more than once. Slots are pure placeholders; the actual
    // data lands by scanning for the first empty slot below.
    setImages((prev) => {
      const room = Math.max(0, MAX_IMAGES - prev.length);
      return [...prev, ...incoming.slice(0, room).map(() => ({ data: "", mimeType: "image/*" }))];
    });
    for (const file of incoming) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
        setImages((prev) => {
          const idx = prev.findIndex((img) => img.data === "");
          if (idx < 0) return prev; // over the limit or the slot was removed
          const next = [...prev];
          next[idx] = { data: base64, mimeType: file.type };
          return next;
        });
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index: number): void {
    setImages((prev) => prev.filter((_, i) => i !== index));
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
    if ((!value && images.length === 0) || streaming) return;
    send({
      type: "sendPrompt",
      text: value || t("（见附图）"),
      images: images.length > 0 ? images.filter((img) => img.data) : undefined,
    });
    setText("");
    setImages([]);
    setMentionQuery(null);
  }

  return (
    <div
      className={`composer${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
      }}
    >
      {images.length > 0 && (
        <div className="attachments">
          {images.map((img, i) => (
            <span key={i} className={`attachment${img.data ? "" : " pending"}`} title={img.mimeType}>
              {img.data ? (
                <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
              ) : (
                <span className="attachment-loading">…</span>
              )}
              <button className="attachment-remove" title={t("移除")} onClick={() => removeImage(i)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {suggestion && (
        <div className="cmd-hint">
          <span className="cmd-name">/{suggestion.name}</span>
          <span className="cmd-desc">{suggestion.description}</span>
          <span className="cmd-key">{t("Tab 补全")}</span>
        </div>
      )}
      {mentionQuery !== null && (
        <div className="mention-pop">
          {mentionHits.length === 0 && <div className="mention-empty">{t("无匹配文件")}</div>}
          {mentionHits.map((hit, i) => (
            <div
              key={hit.path}
              className={`mention-item${i === mentionIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(hit.path);
              }}
            >
              {hit.path.split("/").slice(0, -1).join("/") && (
                <span className="mention-dir">{hit.path.split("/").slice(0, -1).join("/")}/</span>
              )}
              <span className="mention-name">{hit.path.split("/").pop()}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={text}
          placeholder={t("向 iFlow 提问…（/ 命令 · @ 文件 · 粘贴/拖入图片）")}
          rows={Math.min(6, text.split("\n").length)}
          onChange={(e) => {
            setText(e.target.value);
            updateMentionFromCaret(e.target.value);
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addImages(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab" && suggestion) {
              e.preventDefault();
              setText(`/${suggestion.name} `);
              return;
            }
            if (mentionQuery !== null && mentionHits.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => Math.min(mentionHits.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(mentionHits[mentionIndex]!.path);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="btn stop" title={t("停止生成")} onClick={() => send({ type: "cancel" })}>
            ■
          </button>
        ) : (
          <button
            className="btn send"
            title={t("发送 (Enter)")}
            disabled={!text.trim() && images.length === 0}
            onClick={submit}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}