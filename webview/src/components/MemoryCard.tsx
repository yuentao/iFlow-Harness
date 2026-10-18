import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { KnowledgeDocUi, MemoryFileUi, MemoryScope, MemoryStateUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, Chip, SAVE_BTN } from "./ui";
import type { SectionHeader } from "./SettingsModal";

/** Editor-state header override a section reports to the settings shell. */
type SectionHeaderSetter = Dispatch<SetStateAction<SectionHeader | null>>;

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function roleLabel(file: MemoryFileUi): string | null {
  if (file.role === "primary") return t("主文件");
  if (file.role === "hierarchy") return t("自动发现");
  if (file.role === "legacy") return t("遗留文件");
  return null;
}

function scopeLabel(scope: MemoryScope): string {
  return scope === "global" ? t("全局记忆") : t("项目记忆");
}

function knowledgeStageLabel(stage: string | null): string {
  switch (stage) {
    case "scanning": return t("正在扫描工作区…");
    case "summarizing": return t("正在生成知识索引…");
    case "writing": return t("正在写入项目知识…");
    default: return "";
  }
}

/**
 * F3 Phase 1 — memory manager (settings tab). The CLI auto-injects the global
 * and hierarchical `AGENTS.md` / `IFLOW.md` files; this card is the first UI
 * that lets users see, edit and extend those files.
 *
 * Timing contract (probed): the CLI assembles its system instruction at
 * `startChat`, i.e. on session/new and session/load. Saving a file therefore
 * takes effect on the NEXT new/restored session; the current chat keeps its
 * old instruction. The card offers 「新建会话」 and 「重启 CLI」 (restart restores
 * the current session, rebuilding the instruction).
 */
export function MemorySection({ busy, onHeader }: { busy: boolean; onHeader: SectionHeaderSetter }) {
  const send = useChat((s) => s.send);
  const sessionId = useChat((s) => s.state?.sessionId ?? null);
  const [state, setState] = useState<MemoryStateUi | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string; hash: string | null } | null>(null);
  const [editLoading, setEditLoading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [factText, setFactText] = useState("");
  const [factScope, setFactScope] = useState<MemoryScope>("global");
  const [factTarget, setFactTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [knowledgeStage, setKnowledgeStage] = useState<string | null>(null);
  const [knowledgeStageMessage, setKnowledgeStageMessage] = useState<string | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeGenerating, setKnowledgeGenerating] = useState(false);
  const [knowledgeToggling, setKnowledgeToggling] = useState(false);
  const knowledgeBusy = knowledgeGenerating || knowledgeToggling;
  const knowledgeJobRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPath = useRef<string | null>(null);
  const editRequestRef = useRef<string | null>(null);
  const editingPathRef = useRef<string | null>(null);
  useEffect(() => {
    editingPathRef.current = editing?.path ?? null;
  }, [editing?.path]);

  // Open → read disk truth (the CLI's save_memory tool and external editors
  // write the same files behind our back).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        state?: MemoryStateUi;
        path?: string;
        ok?: boolean;
        conflict?: boolean;
        file?: MemoryFileUi;
        content?: string;
        hash?: string | null;
        error?: string;
        stage?: string;
        message?: string;
        jobId?: string;
      };
      if (msg?.type === "knowledgeJob") {
        if (knowledgeJobRef.current && msg.jobId && msg.jobId !== knowledgeJobRef.current) return;
        const stage = msg.stage ?? null;
        setKnowledgeStage(stage === "done" || stage === "error" ? null : stage);
        setKnowledgeStageMessage(stage === "done" || stage === "error" ? null : msg.message ?? null);
        setKnowledgeGenerating(stage !== "done" && stage !== "error");
        if (stage === "done" || stage === "error") knowledgeJobRef.current = null;
        if (stage === "error") setKnowledgeError(msg.message ?? t("生成失败"));
        if (stage === "done") setKnowledgeError(null);
        return;
      }
      if (msg?.type === "memoryFileContent") {
        if (editRequestRef.current !== msg.path) return;
        editRequestRef.current = null;
        setEditLoading(null);
        if (msg.error) {
          setLoadError(msg.error);
          return;
        }
        setEditing({ path: msg.path ?? "", content: msg.content ?? "", hash: msg.hash ?? null });
        setConflict(null);
        return;
      }
      if (msg?.type === "memoryState" && msg.state) {
        setState(msg.state);
        setLoadError(msg.state.error ?? null);
        // Knowledge generation survives settings re-open via the host flag;
        // a state read must not clear an active local generating lock (only
        // done/error job messages do), but it does settle an injection toggle.
        const hostGenerating = msg.state.knowledge?.generating === true;
        if (hostGenerating) setKnowledgeGenerating(true);
        else if (!knowledgeJobRef.current) setKnowledgeGenerating(false);
        setKnowledgeToggling(false);
        if (pendingPath.current === null) setSaving(false);
        return;
      }
      if (msg?.type !== "memorySaved") return;
      const path = msg.path ?? "";
      setSaving(false);
      pendingPath.current = null;
      if (!msg.ok) {
        if (msg.conflict) setConflict(msg.error ?? t("文件已在磁盘上发生变化，请重新加载后再保存"));
        else setLoadError(msg.error ?? t("保存失败"));
        return;
      }
      if (msg.file) {
        const file = msg.file;
        setState((prev) =>
          prev
            ? {
                ...prev,
                files: prev.files.map((entry) => (entry.path === file.path ? file : entry)),
              }
            : prev,
        );
        if (editingPathRef.current === file.path) setEditing(null);
      }
      setConflict(null);
      setFactText("");
      setSavedFlash(path ? t("已保存 {0}", path) : t("已保存"));
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(null), 4000);
    };
    window.addEventListener("message", handler);
    send({ type: "listMemory" });
    return () => {
      window.removeEventListener("message", handler);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [send]);

  // A new/restored session can change the cwd; re-read the project files.
  useEffect(() => {
    if (sessionId) send({ type: "listMemory" });
  }, [sessionId, send]);

  // Editor → shell header (back arrow + contextual title).
  const back = useCallback(() => {
    setEditing(null);
    setConflict(null);
  }, []);
  const editingOpen = editing !== null;
  useEffect(() => {
    onHeader(editingOpen ? { back, title: t("编辑记忆") } : null);
  }, [editingOpen, back, onHeader]);

  const globalFiles = useMemo(() => state?.files.filter((f) => f.scope === "global") ?? [], [state]);
  const projectFiles = useMemo(() => state?.files.filter((f) => f.scope === "project") ?? [], [state]);
  const knowledge = state?.knowledge;
  const writableTargets = useMemo(() => {
    const files = state?.files.filter((f) => f.scope === factScope && f.role !== "legacy") ?? [];
    return files;
  }, [state, factScope]);

  // Keep the quick-add target on the scope's primary file unless the user
  // explicitly picked another one.
  useEffect(() => {
    if (writableTargets.length === 0) {
      setFactTarget("");
      return;
    }
    setFactTarget((current) => {
      if (current && writableTargets.some((f) => f.path === current)) return current;
      return (
        writableTargets.find((f) => f.role === "primary")?.path ??
        writableTargets[0]!.path
      );
    });
  }, [writableTargets]);

  function refresh() {
    setLoadError(null);
    send({ type: "listMemory" });
  }

  function open(file: MemoryFileUi) {
    send({ type: "openMemoryFile", path: file.path });
  }

  function generateKnowledge(mode: "incremental" | "full") {
    if (busy || saving || knowledgeBusy) return;
    setKnowledgeError(null);
    setKnowledgeGenerating(true);
    setKnowledgeToggling(false);
    setKnowledgeStage("scanning");
    setKnowledgeStageMessage(null);
    const jobId =
      (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ??
      `knowledge-${Date.now()}`;
    knowledgeJobRef.current = jobId;
    send({ type: "generateKnowledge", jobId, mode });
  }

  function toggleKnowledge(doc: KnowledgeDocUi) {
    if (busy || saving || knowledgeBusy) return;
    setKnowledgeToggling(true);
    setKnowledgeError(null);
    send({ type: "setKnowledgeInjection", path: doc.path, injected: !doc.injected });
  }

  function openKnowledge(doc: KnowledgeDocUi) {
    send({ type: "openKnowledgeFile", path: doc.path });
  }

  function startEdit(file: MemoryFileUi) {
    editRequestRef.current = file.path;
    setEditLoading(file.path);
    setConflict(null);
    setLoadError(null);
    send({ type: "readMemoryFile", path: file.path });
  }

  function saveEdit() {
    if (!editing || saving) return;
    setConflict(null);
    setSaving(true);
    pendingPath.current = editing.path;
    send({
      type: "saveMemoryFile",
      path: editing.path,
      content: editing.content,
      expectedHash: editing.hash,
    });
  }

  function appendFact() {
    const fact = factText.trim();
    if (!fact || saving) return;
    setLoadError(null);
    setSaving(true);
    pendingPath.current = factTarget || null;
    send({
      type: "appendMemoryFact",
      scope: factScope,
      fact,
      ...(factTarget ? { path: factTarget } : {}),
    });
  }

  function removeFact(file: MemoryFileUi, id: string) {
    if (saving) return;
    setSaving(true);
    pendingPath.current = file.path;
    send({ type: "deleteMemoryFacts", path: file.path, factIds: [id] });
  }

  function createProject(fileName: "AGENTS.md" | "IFLOW.md") {
    if (saving) return;
    setCreating(true);
    setSaving(true);
    pendingPath.current = null;
    send({ type: "createProjectMemory", fileName });
    // The host replies with a fresh memoryState; clear the spinner there.
  }

  function renderFile(file: MemoryFileUi) {
    const label = roleLabel(file);
    const isLegacy = file.role === "legacy";
    return (
      <div key={file.path} className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card">
        <div className="flex flex-wrap items-center gap-1.5">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={file.path}>
            {file.displayPath}
          </span>
          {label && <Chip tone={isLegacy ? "warning" : file.role === "primary" ? "primary" : "muted"}>{label}</Chip>}
          <Chip tone={file.injected ? "info" : "muted"}>{file.injected ? t("已注入") : t("未注入")}</Chip>
          <span
            className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
            title={t("约 {0} tokens（BPE 估算）", file.tokens)}
          >
            ≈{fmtTokens(file.tokens)} tokens
          </span>
          <button
            className="press shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            title={t("打开文件")}
            disabled={busy || saving || !file.exists}
            onClick={() => open(file)}
          >
            <ExternalLink className="size-3.5" />
          </button>
          <button
            className="press shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            title={t("编辑")}
            disabled={busy || saving || !file.editable}
            onClick={() => startEdit(file)}
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
          <span>{file.exists ? t("{0} 字节", file.bytes) : t("尚未创建")}</span>
          {file.updatedAt && <span>{t("更新于 {0}", formatTime(file.updatedAt))}</span>}
          {!file.injected && <span className="text-warning">{t("当前 CLI 不会加载此文件")}</span>}
        </div>
        {file.facts && file.facts.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {file.facts.slice(0, 20).map((fact) => (
              <li key={fact.id} className="group flex items-start gap-1 rounded-md px-1 py-0.5 text-[11px] text-foreground/85">
                <span className="mt-0.5 size-1 shrink-0 rounded-full bg-primary/60" />
                <span className="min-w-0 flex-1 break-words">{fact.text}</span>
                <button
                  className="press shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                  title={t("删除这条记忆")}
                  disabled={busy || saving || !file.editable}
                  onClick={() => removeFact(file, fact.id)}
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            ))}
            {file.facts.length > 20 && (
              <li className="px-1 text-[10.5px] text-muted-foreground">{t("还有 {0} 条…", file.facts.length - 20)}</li>
            )}
          </ul>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <div className="truncate font-mono text-[10.5px]" title={editing.path}>
            {editing.path}
          </div>
          <div className="mt-0.5">{t("记忆在新建会话或恢复会话时加载。当前会话需要重启 CLI 才会读取新内容。")}</div>
        </div>
        {conflict && (
          <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <div className="min-w-0 flex-1">
              <div>{conflict}</div>
              <button
                className="mt-1 underline"
                onClick={() => {
                  setEditing(null);
                  setConflict(null);
                  refresh();
                }}
              >
                {t("重新加载")}
              </button>
            </div>
          </div>
        )}
        <textarea
          className={`${INPUT} min-h-[220px] w-full resize-y font-mono text-[11.5px] leading-relaxed`}
          value={editing.content}
          spellCheck={false}
          onChange={(e) => setEditing((current) => (current ? { ...current, content: e.target.value } : current))}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={SAVE_BTN} disabled={busy || saving} onClick={saveEdit}>
            <Save className="mr-0.5 inline size-3 align-[-2px]" />
            {saving ? t("保存中…") : t("保存")}
          </button>
          <button className={BTN} onClick={back}>
            {t("取消")}
          </button>
          <span className="text-[10.5px] text-muted-foreground">
            {t("{0} 字符 · ≈{1} tokens", editing.content.length, fmtTokens(Math.ceil(editing.content.length / 4)))}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <div className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1">{loadError}</span>
        </div>
      )}
      {savedFlash && (
        <div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 py-1.5 text-[11px] text-success">
          <Check className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">{savedFlash}</span>
          <span className="text-success/80">{t("新建会话或重启 CLI 后生效")}</span>
        </div>
      )}
      {editLoading && (
        <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {t("读取 {0}…", editLoading)}
        </div>
      )}

      <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("以下是 CLI 每次请求都会自动注入的记忆文件。内容会随请求发送给模型，请勿写入密钥。")}
      </div>

      {state === null ? (
        <div className="py-4 text-center text-[12px] text-muted-foreground">{t("读取中…")}</div>
      ) : (
        <>
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold text-foreground">{t("全局记忆")}</span>
              <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">{state.home}</span>
              <button
                className="press ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                title={t("重新扫描")}
                disabled={busy || saving}
                onClick={refresh}
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            {globalFiles.map(renderFile)}
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-semibold text-foreground">{t("项目记忆")}</span>
              <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
                {state.cwd ?? t("未打开工作区")}
              </span>
            </div>
            {projectFiles.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                {t("当前工作区没有可用的项目记忆文件")}
              </div>
            ) : (
              projectFiles.map(renderFile)
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                className={BTN}
                disabled={busy || saving || !state.cwd}
                onClick={() => {
                  setCreating((v) => !v);
                  setLoadError(null);
                }}
              >
                <Plus className="mr-0.5 inline size-3 align-[-2px]" />
                {t("新建项目记忆")}
              </button>
              {creating && (
                <>
                  <button
                    className={SAVE_BTN}
                    disabled={saving}
                    onClick={() => {
                      createProject("AGENTS.md");
                      setCreating(false);
                    }}
                  >
                    AGENTS.md
                  </button>
                  <button
                    className={BTN}
                    disabled={saving}
                    onClick={() => {
                      createProject("IFLOW.md");
                      setCreating(false);
                    }}
                  >
                    IFLOW.md
                  </button>
                </>
              )}
            </div>
          </section>

          <section className="space-y-1.5 rounded-xl border border-border bg-surface/60 px-2.5 py-2 shadow-card">
            <div className="flex flex-wrap items-center gap-1.5">
              <BookOpen className="size-3.5 shrink-0 text-primary" />
              <span className="text-[12px] font-semibold text-foreground">{t("项目知识库")}</span>
              {knowledge && knowledge.docs.length > 0 && (
                <Chip tone="muted">{t("{0} 篇文档", knowledge.docs.length)}</Chip>
              )}
              {knowledge?.index ? (
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <button
                    className={BTN}
                    disabled={busy || saving || knowledgeBusy || !state.cwd}
                    title={t("只根据变化更新索引，无变化时不会调用模型")}
                    onClick={() => generateKnowledge("incremental")}
                  >
                    <RefreshCw className="mr-0.5 inline size-3 align-[-2px]" />
                    {t("增量刷新")}
                  </button>
                  <button
                    className={BTN}
                    disabled={busy || saving || knowledgeBusy || !state.cwd}
                    title={t("重新分析整个工作区并覆盖索引")}
                    onClick={() => generateKnowledge("full")}
                  >
                    {t("全量重建")}
                  </button>
                </div>
              ) : (
                <button
                  className={`${BTN} ml-auto`}
                  disabled={busy || saving || knowledgeBusy || !state.cwd}
                  onClick={() => generateKnowledge("full")}
                >
                  <RefreshCw className="mr-0.5 inline size-3 align-[-2px]" />
                  {t("生成项目知识")}
                </button>
              )}
            </div>
            {knowledge?.dir && (
              <div className="truncate font-mono text-[10.5px] text-muted-foreground" title={knowledge.dir}>
                {knowledge.dir}
              </div>
            )}
            {knowledge?.manifest && (
              <div className="text-[10.5px] text-muted-foreground">
                {t(
                  "上次生成：{0} · {1} 个文件",
                  knowledge.manifest.mode === "incremental" ? t("增量更新") : t("全量生成"),
                  `${knowledge.manifest.sourceCount}${knowledge.manifest.truncated ? "+" : ""}`,
                )}
              </div>
            )}
            {knowledgeGenerating && (
              <div className="text-[11px] text-muted-foreground">
                {knowledgeStageMessage ?? (knowledgeStage ? knowledgeStageLabel(knowledgeStage) : t("正在生成…"))}
              </div>
            )}
            {knowledgeError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                {knowledgeError}
              </div>
            )}
            {!knowledge?.index ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                {t("尚未生成项目知识。点击「生成项目知识」分析当前工作区。")}
              </div>
            ) : (
              <div className="space-y-1">
                {knowledge.docs.map((doc) => (
                  <div
                    key={doc.path}
                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-1.5"
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold text-foreground">
                        {doc.title}
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                        {doc.displayPath}
                      </span>
                    </span>
                    <Chip tone={doc.injected ? "info" : "muted"}>
                      {doc.injected ? t("已注入") : t("未注入")}
                    </Chip>
                    <span
                      className="shrink-0 font-mono text-[10.5px] text-muted-foreground"
                      title={t("约 {0} tokens（BPE 估算）", doc.tokens)}
                    >
                      ≈{fmtTokens(doc.tokens)} tokens
                    </span>
                    <button
                      className="press shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                      title={t("打开文件")}
                      disabled={busy || knowledgeBusy}
                      onClick={() => openKnowledge(doc)}
                    >
                      <ExternalLink className="size-3.5" />
                    </button>
                    <button
                      className={BTN}
                      disabled={busy || saving || knowledgeBusy}
                      onClick={() => toggleKnowledge(doc)}
                    >
                      {doc.injected ? t("取消注入") : t("注入")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {knowledge && knowledge.injectedTokens > 8_000 && (
              <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>
                  {t("项目知识已注入约 {0} tokens，会随每次请求发送；建议只保留索引或精简文档。", knowledge.injectedTokens)}
                </span>
              </div>
            )}
            {knowledge?.managedBy && (
              <div className="truncate text-[10.5px] text-muted-foreground" title={knowledge.managedBy}>
                {t("导入位置：{0}", knowledge.managedBy)}
              </div>
            )}
            <p className="text-[10.5px] leading-relaxed text-muted-foreground/85">
              {t("知识索引生成后写入 .iflow/knowledge/，通过项目记忆的 @ 导入注入；默认只在新建或恢复会话时生效。")}
            </p>
          </section>

          <section className="space-y-1.5 rounded-xl border border-border bg-surface/60 px-2.5 py-2 shadow-card">
            <div className="text-[12px] font-semibold text-foreground">{t("添加一条记忆")}</div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`${BTN} ${factScope === "global" ? "border-primary/50 text-primary" : ""}`}
                aria-pressed={factScope === "global"}
                onClick={() => setFactScope("global")}
              >
                {t("全局")}
              </button>
              <button
                type="button"
                className={`${BTN} ${factScope === "project" ? "border-primary/50 text-primary" : ""}`}
                aria-pressed={factScope === "project"}
                onClick={() => setFactScope("project")}
              >
                {t("项目")}
              </button>
              {writableTargets.length > 1 && (
                <select
                  className={`${INPUT} ml-auto max-w-[55%]`}
                  value={factTarget}
                  onChange={(e) => setFactTarget(e.target.value)}
                >
                  {writableTargets.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.displayPath}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <textarea
              className={`${INPUT} min-h-[58px] w-full resize-y`}
              value={factText}
              placeholder={t("例如：本项目的测试命令是 npm test；不要修改 vendor/ 下的文件。")}
              onChange={(e) => setFactText(e.target.value)}
            />
            <div className="flex items-center gap-1.5">
              <button
                className={SAVE_BTN}
                disabled={busy || saving || !factText.trim() || writableTargets.length === 0}
                onClick={appendFact}
              >
                <Plus className="mr-0.5 inline size-3 align-[-2px]" />
                {saving ? t("写入中…") : t("保存到{0}", scopeLabel(factScope))}
              </button>
              <span className="text-[10.5px] text-muted-foreground">
                {writableTargets.length === 0
                  ? t("请先创建项目记忆文件")
                  : t("保存后新建会话或重启 CLI 生效")}
              </span>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
            <button className={BTN} disabled={busy} onClick={() => send({ type: "newSession" })}>
              {t("新建会话")}
            </button>
            <button
              className={BTN}
              disabled={busy}
              title={t("重启 CLI 并恢复当前会话，使记忆立即生效")}
              onClick={() => send({ type: "restartCli" })}
            >
              <RefreshCw className="mr-0.5 inline size-3 align-[-2px]" />
              {t("重启 CLI 使记忆生效")}
            </button>
            <span className="text-[10.5px] text-muted-foreground">{t("记忆不会热更新到正在进行的会话。")}</span>
          </div>
        </>
      )}
    </div>
  );
}
