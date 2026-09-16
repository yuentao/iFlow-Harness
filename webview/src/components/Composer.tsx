import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FileCode,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Search,
  SendHorizontal,
  Square,
  X,
  Zap,
} from "lucide-react";
import type { CodeContextUi, FileHitUi, SlashCommand } from "../../../shared/messages";
import { useChat } from "../store";
import { modeDisplay, t } from "../i18n";
import { Dropdown, fuzzyScore } from "./ui";

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

/** Compact token count, e.g. 12345 → "12.3k", 1_500_000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Stable empty fallbacks — a fresh `[]` per selector call would re-render on
 * every store change (zustand compares with Object.is). */
const EMPTY_COMMANDS: SlashCommand[] = [];
const EMPTY_MODELS: ModelInfoUi[] = [];

/**
 * Session token usage chip — subscribes to the usage NUMBERS as primitives
 * (postMessage re-clones the usage object on every patch, so an object
 * selector would re-render on every blockPatch; primitives only move when
 * the host's throttled real-time refresh actually changes them) — the live
 * streaming refresh re-renders ONLY this small label, not the whole Composer.
 * The host zeroes usage at session start, so the chip shows ↑0 ↓0 from the
 * first paint; it hides only when the field is absent entirely (older hosts).
 * Sits right of the model dropdown it counts.
 */
function SessionUsageChip() {
  const hasUsage = useChat((s) => s.state?.usage != null);
  const inputTokens = useChat((s) => s.state?.usage?.inputTokens ?? 0);
  const outputTokens = useChat((s) => s.state?.usage?.outputTokens ?? 0);
  if (!hasUsage) return null;
  return (
    <span
      title={t(
        "本次会话 token 消耗（host 估算，非精确计费）：输入 {0} · 输出 {1}",
        inputTokens.toLocaleString(),
        outputTokens.toLocaleString(),
      )}
      className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground/80 @max-[380px]:hidden"
    >
      <span className="flex items-center gap-0.5" title={t("输入（用户消息与工具结果）")}>
        <ArrowUp className="size-2.5" />
        {formatTokens(inputTokens)}
      </span>
      <span className="flex items-center gap-0.5" title={t("输出（回复与思考）")}>
        <ArrowDown className="size-2.5" />
        {formatTokens(outputTokens)}
      </span>
    </span>
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
  const pendingApproval = useChat((s) => s.state?.pendingApproval ?? null);
  const pendingQuestions = useChat((s) => s.state?.pendingQuestions ?? null);
  const commands = useChat((s) => s.state?.commands ?? EMPTY_COMMANDS);
  const modes = useChat((s) => s.state?.modes ?? null);
  const models = useChat((s) => s.state?.models ?? EMPTY_MODELS);
  const currentModelId = useChat((s) => s.state?.currentModelId ?? null);
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
  /** Right-click "加入 iFlow 上下文" selection — rendered as a styled code
   * card above the composer (a plain textarea cannot show a fenced block).
   * At most one card; replaced by a newer right-click, removed explicitly. */
  const [codeContext, setCodeContext] = useState<CodeContextUi | null>(null);
  const stageSeq = useRef(0);
  const attachSeq = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
    const q = mentionQuery.trim();
    const requestId = ++searchSeq.current;
    // W5: read `send` from the store imperatively — its reference is stable,
    // so the effect legitimately depends only on `mentionQuery` (no eslint
    // suppression needed).
    const timer = setTimeout(
      () => useChat.getState().send({ type: "searchFiles", requestId, query: q }),
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
        // Right-click "加入 iFlow 上下文": show the styled code card + focus.
        setCodeContext({ path: msg.path, range: msg.range, code: msg.code });
        setMentionQuery(null);
        requestAnimationFrame(() => taRef.current?.focus());
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Streaming, history replay, and new-session init all lock the composer's
  // switches (the agent / host is mid-operation; mode/model changes and
  // prompts would desync it). An in-flight profile/model/mode switch (pending)
  // locks the other switchers too. Stop is only meaningful for a real
  // generation: beginReplay() also reports status "streaming", so replaying
  // and initializing must be excluded here. Also exclude when there's a
  // pending approval or question card — the user must handle those first.
  const streaming = status === "streaming";
  const hasPendingInteraction = Boolean(pendingApproval || pendingQuestions);
  const canStop = Boolean(streaming && !replaying && !initializing && !hasPendingInteraction);
  const busy = streaming || replaying || initializing || pending !== null || hasPendingInteraction;
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

  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  function showNote(message: string): void {
    setNote(message);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 5000);
  }

  function addImages(files: ArrayLike<File>): void {
    const incoming = Array.from(files);
    const accepted = incoming.filter((f) => f.size <= MAX_IMAGE_BYTES);
    const rejected = incoming.length - accepted.length;
    if (rejected > 0) showNote(t("{0} 张图片超过大小上限（5MB），已跳过", rejected));
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
    if ((!value && images.length === 0 && attachments.length === 0 && !codeContext) || busy) return;
    send({
      type: "sendPrompt",
      text: value || (codeContext ? t("（见附带的代码上下文）") : attachments.length > 0 ? t("（见附件）") : t("（见附图）")),
      images: images.length > 0 ? images.filter((img) => img.data) : undefined,
      files: attachments.length > 0 ? attachments.map(({ name, path }) => ({ name, path })) : undefined,
      codeContext: codeContext ?? undefined,
    });
    setText("");
    setImages([]);
    setAttachments([]);
    setCodeContext(null);
    setMentionQuery(null);
  }

  // whitespace-nowrap: a narrow panel must never squeeze a label into
  // vertical text (e.g. 智/能 stacked) — the row wraps instead (flex-wrap).
  const CANVAS_BTN =
    "card-lift press inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border bg-surface/80 px-2 py-1 text-[11px] text-foreground shadow-card hover:bg-surface-2 transition-colors disabled:pointer-events-none disabled:opacity-40";
  return (
    <div
      ref={rootRef}
      className={`acrylic @container relative flex flex-col shrink-0 border-t p-3 transition-colors ${
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
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-primary/5 text-[12px] font-medium text-primary">
          {t("拖放文件以添加附件")}
        </div>
      )}
      {/* non-image attachment chips + rejected-file note */}
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((f) => (
            <span
              key={f.id}
              className="card-lift inline-flex max-w-[min(260px,100%)] items-center gap-1 rounded-lg border border-border bg-surface/80 px-1.5 py-1 text-[11px] text-foreground shadow-card"
              title={f.path}
            >
              <FileText className="size-3 shrink-0 text-primary" />
              <span className="truncate">{f.name}</span>
              <button
                className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-destructive"
                title={t("移除")}
                onClick={() => removeAttachment(f.id)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {note && <div className="mb-1.5 px-0.5 text-[11px] text-warning">{note}</div>}
      {/* Right-click "加入 iFlow 上下文" code card: the selection is the real
          payload (rides sendPrompt.codeContext), styled as source context —
          accent rail + mono block — not as editable draft text. */}
      {codeContext && (
        <div className="code-context-card card-lift mb-1.5 overflow-hidden rounded-xl border border-border bg-editor shadow-card">
          <div className="flex items-center gap-1.5 border-b border-border/70 bg-surface/60 px-2.5 py-1.5">
            <FileCode className="size-3.5 shrink-0 text-primary" />
            <span className="truncate font-mono text-[11px] text-foreground" title={codeContext.path}>
              {codeContext.path}
            </span>
            <span className="shrink-0 rounded border border-border bg-surface px-1 font-mono text-[10px] text-muted-foreground">
              {codeContext.range}
            </span>
            <button
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
              title={t("移除")}
              onClick={() => setCodeContext(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <pre className="max-h-40 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-foreground/90">
            {codeContext.code}
          </pre>
        </div>
      )}
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
                <ImageIcon className="size-4 text-muted-foreground" />
              )}
              <button
                className="absolute right-0 top-0 flex size-4 items-center justify-center rounded-bl-[4px] bg-black/55 text-white hover:bg-black/75"
                title={t("移除")}
                onClick={() => removeImage(i)}
              >
                <X className="size-2.5" />
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
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                i === cmdIndex ? "bg-accent/70" : "hover:bg-accent/50"
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
        <div className="acrylic-pop dropdown-in absolute inset-x-3 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-xl border border-border">
          {mentionHits.length === 0 && (
            <div className="px-3 py-1.5 text-[12px] text-muted-foreground">{t("无匹配文件")}</div>
          )}
          {mentionHits.map((hit, i) => (
            <button
              key={hit.path}
              ref={i === mentionIndex ? mentionActiveRef : undefined}
              className={`flex w-full items-baseline gap-1 px-3 py-1.5 text-left text-[12px] ${
                i === mentionIndex ? "bg-accent/70" : "hover:bg-accent/50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(hit.path);
              }}
            >
              {hit.path.split("/").slice(0, -1).join("/") && (
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  {hit.path.split("/").slice(0, -1).join("/")}/
                </span>
              )}
              {/* break-all: an unbroken long basename would otherwise force
                  horizontal scroll on the max-h-56 popup (single-axis overflow
                  makes the other axis auto). */}
              <span className="break-all font-medium">{hit.path.split("/").pop()}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-editor/60 shadow-card transition-all duration-300 focus-within:border-primary/50 focus-within:shadow-focus">
        <textarea
          ref={taRef}
          value={text}
          placeholder={t("向 iFlow 提问…（/ 命令 · @ 文件 · 粘贴或回形针按钮添加图片/文件）")}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
          onChange={(e) => {
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
              if (e.key === "ArrowDown" && mentionHits.length > 0) {
                e.preventDefault();
                setMentionIndex((i) => Math.min(mentionHits.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp" && mentionHits.length > 0) {
                e.preventDefault();
                setMentionIndex((i) => Math.max(0, i - 1));
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && mentionHits.length > 0) {
                e.preventDefault();
                insertMention(mentionHits[mentionIndex]!.path);
                return;
              }
              // 弹窗开着（含无匹配）时 ESC 只关闭弹窗，不触发停止生成。
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
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
        {/* flex-wrap: a narrow panel drops controls to a second line instead
            of crushing labels into vertical text; @max-[340px] (composer is
            the @container) degrades the mode button to icon-only. */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pb-2 pt-1.5">
          {/* permission mode dropdown */}
          {modes && currentMode && (
            <Dropdown
              direction="up"
              menuClass="w-56 max-w-[calc(100vw_-_24px)]"
              disabled={busy}
              trigger={(open) => (
                <button
                  className={`${CANVAS_BTN}${open ? " bg-surface-2" : ""}`}
                  title={t("权限模式")}
                  disabled={busy}
                >
                  <Zap className="size-3 shrink-0 text-primary" />
                  <span className="@max-[340px]:hidden">{currentMode ? modeDisplay(currentMode).label : ""}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60 @max-[340px]:hidden" />
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

          {/* model dropdown — refreshed at open time: the host re-queries
              GET {baseUrl}/models, so newly added gateway models show up
              without restarting the session */}
          {models.length > 0 && (
            <Dropdown
              direction="up"
              menuClass="w-56 max-w-[calc(100vw-24px)] max-h-64 overflow-y-auto"
              disabled={busy}
              onOpenChange={(o) => {
                setModelMenuOpen(o);
                if (o) {
                  send({ type: "refreshModels" });
                  // keyboard highlight starts on the active model, not the top
                    const idx = currentModelId
                      ? models.findIndex((m) => m.id === currentModelId)
                      : -1;                  setModelIndex(idx >= 0 ? idx : 0);
                } else {
                  setModelQuery("");
                }
              }}
              trigger={(open) => (
                <button
                  className={`${CANVAS_BTN} min-w-0 font-mono${open ? " bg-surface-2" : ""}`}
                  title={t("模型")}
                  disabled={busy}
                >
                  <span className="max-w-[130px] truncate @max-[440px]:max-w-[84px] @max-[340px]:max-w-[72px]">
                    {currentModelId ?? models[0]!.id}
                  </span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {/* fuzzy search box: matches name and id; sticky so it stays
                      visible while the list scrolls */}
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-panel/50 p-1.5 backdrop-blur-md">
                    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-editor px-2 py-1 transition-colors focus-within:border-primary/50">
                      <Search className="size-3 shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        value={modelQuery}
                        placeholder={t("搜索模型…")}
                        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
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
                  {filteredModels.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-muted-foreground">{t("无匹配模型")}</div>
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
                      className={`flex w-full items-center px-3 py-1.5 text-left font-mono text-[11px] ${
                        i === modelIndex ? "bg-accent/70" : "hover:bg-accent/50"
                      }`}
                    >
                      <span className="truncate" title={m.name}>
                        {m.name}
                      </span>
                      {m.id === currentModelId && (
                        <Check className="ml-auto size-3 shrink-0 text-primary" />
                      )}
                    </button>
                  ))}
                </>
              )}
            </Dropdown>
          )}

          {/* session token usage — input/output split, live-refreshed while
              streaming; its own component so the refresh re-renders only it */}
          <SessionUsageChip />

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              className={CANVAS_BTN}
              title={t("添加附件")}
              disabled={busy}
              onClick={() => send({ type: "pickAttachments" })}
            >
              <Paperclip className="size-3" />
            </button>
            {busy ? (
              <button
                className={`${CANVAS_BTN} text-muted-foreground hover:text-foreground`}
                title={t("停止生成")}
                disabled={!canStop}
                onClick={() => send({ type: "cancel" })}
              >
                <Square className="size-3" /> <span className="@max-[340px]:hidden">{t("停止")}</span>
              </button>
            ) : (
              <button
                className="press inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-to-b from-primary to-primary/90 px-3 py-1 text-[11px] font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 active:brightness-95 disabled:pointer-events-none disabled:opacity-40"
                title={t("发送 (Enter)")}
                disabled={!text.trim() && images.length === 0 && attachments.length === 0}
                onClick={submit}
              >
                <SendHorizontal className="size-3" /> <span className="@max-[340px]:hidden">{t("发送")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
