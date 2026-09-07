import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  SendHorizontal,
  Square,
  Zap,
} from "lucide-react";
import type { FileHitUi, SlashCommand } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Dropdown } from "./ui";

/** One attached image (base64, no data: prefix). */
export interface ImageAttachment {
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Localized display for the CLI's permission modes (ids come from the agent,
 * names may be English) — label + one-line description per the design spec.
 * Unknown ids fall back to the agent-provided name.
 */
function modeDisplay(mode: { id: string; name: string }): { label: string; desc: string } {
  switch (mode.id) {
    case "smart":
      return { label: t("智能"), desc: t("AI 评估风险后决定是否确认") };
    case "yolo":
      return { label: t("免确认"), desc: t("所有工具直接执行") };
    case "default":
      return { label: t("标准"), desc: t("执行前均需确认") };
    case "plan":
      return { label: t("规划"), desc: t("只读，仅分析与规划") };
    default:
      return { label: mode.name || mode.id, desc: "" };
  }
}

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

  // Streaming, history replay, and new-session init all lock the composer's
  // switches (the agent / host is mid-operation; mode/model changes and
  // prompts would desync it). Stop stays available while streaming.
  const streaming = state?.status === "streaming";
  const busy = (streaming || state?.replaying || state?.initializing) ?? false;
  const commands: SlashCommand[] = state?.commands ?? [];
  const modes = state?.modes ?? null;
  const models = state?.models ?? [];
  const currentMode = modes?.availableModes.find((m) => m.id === modes.currentModeId) ?? null;

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
    if ((!value && images.length === 0) || busy) return;
    send({
      type: "sendPrompt",
      text: value || t("（见附图）"),
      images: images.length > 0 ? images.filter((img) => img.data) : undefined,
    });
    setText("");
    setImages([]);
    setMentionQuery(null);
  }

  const CANVAS_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground hover:bg-surface-2 transition-colors disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      className={`relative shrink-0 border-t border-border bg-panel px-2.5 pb-2.5 pt-2${dragOver ? " composer-drag" : ""}`}
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
      {/* attached images */}
      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <span
              key={i}
              className="relative inline-flex size-[52px] items-center justify-center overflow-hidden rounded-md border border-border"
              title={img.mimeType}
            >
              {img.data ? (
                <img src={`data:${img.mimeType};base64,${img.data}`} alt="" className="size-full object-cover" />
              ) : (
                <span className="text-[16px] text-muted-foreground">…</span>
              )}
              <button
                className="absolute right-0 top-0 size-4 rounded-bl-[4px] bg-black/55 text-[11px] leading-[15px] text-white hover:bg-black/75"
                title={t("移除")}
                onClick={() => removeImage(i)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* slash-command popup: all prefix matches, keyboard navigable */}
      {cmdMatches.length > 0 && (
        <div className="absolute inset-x-2.5 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover panel-shadow">
          {cmdMatches.map((c, i) => (
            <button
              key={c.name}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                i === cmdIndex ? "bg-accent" : "hover:bg-accent/60"
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(`/${c.name} `);
                taRef.current?.focus();
              }}
            >
              <span className="font-mono text-primary">/{c.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{c.description}</span>
              {i === cmdIndex && (
                <kbd className="ml-auto rounded border border-border px-1 font-mono text-[9px] text-muted-foreground">
                  {t("Tab 补全")}
                </kbd>
              )}
            </button>
          ))}
        </div>
      )}

      {/* @-mention popup */}
      {mentionQuery !== null && (
        <div className="absolute inset-x-2.5 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover panel-shadow">
          {mentionHits.length === 0 && (
            <div className="px-3 py-1.5 text-[12px] text-muted-foreground">{t("无匹配文件")}</div>
          )}
          {mentionHits.map((hit, i) => (
            <button
              key={hit.path}
              className={`flex w-full items-baseline gap-1 px-3 py-1.5 text-left text-[12px] ${
                i === mentionIndex ? "bg-accent" : "hover:bg-accent/60"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(hit.path);
              }}
            >
              {hit.path.split("/").slice(0, -1).join("/") && (
                <span className="truncate text-[11px] text-muted-foreground">
                  {hit.path.split("/").slice(0, -1).join("/")}/
                </span>
              )}
              <span className="font-medium">{hit.path.split("/").pop()}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-editor transition-colors focus-within:border-primary/60">
        <textarea
          ref={taRef}
          value={text}
          placeholder={t("向 iFlow 提问…（/ 命令 · @ 文件 · 粘贴/拖入图片）")}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className="w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
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
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {/* permission mode dropdown */}
          {modes && currentMode && (
            <Dropdown
              direction="up"
              menuClass="w-56"
              trigger={(open) => (
                <button
                  className={`${CANVAS_BTN}${open ? " bg-surface-2" : ""}`}
                  title={t("权限模式")}
                  disabled={busy}
                >
                  <Zap className="size-3 shrink-0 text-primary" />
                  {currentMode ? modeDisplay(currentMode).label : ""}
                  <ChevronDown className="size-3 opacity-60" />
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
                        onClick={() => {
                          send({ type: "setMode", modeId: m.id });
                          close();
                        }}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent"
                      >
                        <span className="text-[12px] text-foreground">
                          {view.label}
                          {m.id === modes.currentModeId && (
                            <Check className="ml-1 inline size-3 text-primary" />
                          )}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{view.desc}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </Dropdown>
          )}

          {/* model dropdown */}
          {models.length > 0 && (
            <Dropdown
              direction="up"
              menuClass="w-56 max-h-64 overflow-y-auto"
              trigger={(open) => (
                <button
                  className={`${CANVAS_BTN} min-w-0 font-mono${open ? " bg-surface-2" : ""}`}
                  title={t("模型")}
                  disabled={busy}
                >
                  <span className="max-w-[130px] truncate">{state?.currentModelId ?? models[0]!.id}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("模型")}
                  </div>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        send({ type: "setModel", modelId: m.id });
                        close();
                      }}
                      className="flex w-full items-center px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent"
                    >
                      <span className="truncate" title={m.name}>
                        {m.name}
                      </span>
                      {m.id === state?.currentModelId && (
                        <Check className="ml-auto size-3 shrink-0 text-primary" />
                      )}
                    </button>
                  ))}
                </>
              )}
            </Dropdown>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {busy ? (
              <button
                className={`${CANVAS_BTN} text-muted-foreground hover:text-foreground`}
                title={t("停止生成")}
                disabled={!streaming}
                onClick={() => send({ type: "cancel" })}
              >
                <Square className="size-3" /> {t("停止")}
              </button>
            ) : (
              <button
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                title={t("发送 (Enter)")}
                disabled={!text.trim() && images.length === 0}
                onClick={submit}
              >
                <SendHorizontal className="size-3" /> {t("发送")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
