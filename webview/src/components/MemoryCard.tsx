import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { KnowledgeDocUi, MemoryFactUi, MemoryFileUi, MemoryScope, MemoryStateUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { ActionRow, Button, Chip, Hint, ICON_INLINE, IconButton, Segmented, Select, SettingsDisclosure, TextArea } from "./ui";
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

/** Auto-extracted facts are long technical paragraphs; past this count the
 * list collapses to a summary row so the settings page stays scannable. */
const FACT_COLLAPSE_THRESHOLD = 3;

/** One memory fact. Clamped to two lines until the row text is clicked;
 * the delete affordance stays on its own channel (never toggles expansion).
 * `index > 0` draws the separator line — `divide-y` utilities are not emitted
 * by this build's Tailwind pipeline (probed via dist CSS, 2026-10-22). */
function FactRow({
  fact,
  index,
  editable,
  busy,
  saving,
  onDelete,
}: {
  fact: MemoryFactUi;
  index: number;
  editable: boolean;
  busy: boolean;
  saving: boolean;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={`group flex items-start gap-2 px-1 py-1.5 ${index > 0 ? "border-t border-border/40" : ""}`}>
      <span className="mt-2 size-1 shrink-0 rounded-full bg-primary/60" />
      <button
        type="button"
        aria-expanded={expanded}
        title={expanded ? t("收起全文") : t("展开全文")}
        onClick={() => setExpanded((v) => !v)}
        className="min-w-0 flex-1 text-left text-ui-body leading-relaxed text-foreground/85 hover:text-foreground"
      >
        <span className={`break-words ${expanded ? "" : "line-clamp-2"}`}>{fact.text}</span>
      </button>
      <IconButton
        icon={<Trash2 className={ICON_INLINE} />}
        label={t("删除这条记忆")}
        size="sm"
        tone="danger"
        className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
        disabled={busy || saving || !editable}
        onClick={onDelete}
      />
    </li>
  );
}

function MemoryFileCard({
  file,
  busy,
  saving,
  onOpen,
  onEdit,
  onDeleteFact,
}: {
  file: MemoryFileUi;
  busy: boolean;
  saving: boolean;
  onOpen: (file: MemoryFileUi) => void;
  onEdit: (file: MemoryFileUi) => void;
  onDeleteFact: (file: MemoryFileUi, id: string) => void;
}) {
  const [factsOpen, setFactsOpen] = useState(false);
  const label = roleLabel(file);
  const isLegacy = file.role === "legacy";
  const facts = file.facts ?? [];
  const collapsible = facts.length > FACT_COLLAPSE_THRESHOLD;
  // NOTE: keep the ternary outside the JSX expression container — TS 7's
  // parser mis-ends `{...}` containers holding parenthesized nested JSX
  // ternaries (probed with minimal repro, 2026-10-22).
  const factsSection =
    facts.length === 0
      ? null
      : collapsible && !factsOpen
        ? <button
            type="button"
            aria-expanded={false}
            onClick={() => setFactsOpen(true)}
            className="mt-1.5 flex items-center gap-1.5 rounded-md px-1 py-1 text-ui-caption text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <ChevronRight className={ICON_INLINE} />
            <span>{t("{0} 条记忆", facts.length)}</span>
          </button>
        : <>
            <ul className="mt-1.5">
              {facts.slice(0, 20).map((fact, index) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
                  index={index}
                  editable={file.editable}
                  busy={busy}
                  saving={saving}
                  onDelete={() => onDeleteFact(file, fact.id)}
                />
              ))}
              {facts.length > 20 && (
                <li className="px-1 py-1 text-ui-caption text-muted-foreground">{t("还有 {0} 条…", facts.length - 20)}</li>
              )}
            </ul>
            {collapsible && (
              <button
                type="button"
                aria-expanded={true}
                onClick={() => setFactsOpen(false)}
                className="mt-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-ui-caption text-muted-foreground hover:bg-surface hover:text-foreground"
              >
                <ChevronRight className={`${ICON_INLINE} rotate-90`} />
                <span>{t("收起记忆列表")}</span>
              </button>
            )}
          </>;
  return (
    <div className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <FileText className={`${ICON_INLINE} shrink-0 text-muted-foreground`} />
        <span className="min-w-0 flex-1 truncate font-mono text-ui-label text-foreground" title={file.path}>
          {file.displayPath}
        </span>
        {label && <Chip tone={isLegacy ? "warning" : file.role === "primary" ? "primary" : "muted"}>{label}</Chip>}
        {/* The caveat belongs to the injection chip, not a separate grey line. */}
        <Chip
          tone={file.injected ? "info" : "warning"}
          title={file.injected ? undefined : t("当前内核不会加载此文件")}
        >
          {file.injected ? t("已注入") : t("未注入")}
        </Chip>
        <IconButton
          icon={<ExternalLink className={ICON_INLINE} />}
          label={t("打开文件")}
          size="sm"
          disabled={busy || saving || !file.exists}
          onClick={() => onOpen(file)}
        />
        <IconButton
          icon={<Pencil className={ICON_INLINE} />}
          label={t("编辑")}
          size="sm"
          disabled={busy || saving || !file.editable}
          onClick={() => onEdit(file)}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-caption text-muted-foreground">
        <span>{file.exists ? t("{0} 字节", file.bytes) : t("尚未创建")}</span>
        {file.updatedAt && <span>{t("更新于 {0}", formatTime(file.updatedAt))}</span>}
        <span title={t("约 {0} tokens（BPE 估算）", file.tokens)}>≈{fmtTokens(file.tokens)} tokens</span>
      </div>
      {factsSection}
    </div>
  );
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

  if (editing) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-ui-label leading-relaxed text-muted-foreground">
          <div className="truncate font-mono text-ui-caption" title={editing.path}>
            {editing.path}
          </div>
                      <Hint className="mt-1">{t("记忆在新建会话或恢复会话时加载。当前会话需要重启内核才会读取新内容。")}</Hint>        </div>
        {conflict && (
          <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-label leading-relaxed text-warning">
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
        <TextArea
          mono
          aria-label={t("记忆文件内容")}
          className="min-h-[220px] w-full text-ui-label leading-relaxed"
          value={editing.content}
          spellCheck={false}
          onChange={(e) => setEditing((current) => (current ? { ...current, content: e.target.value } : current))}
        />
        <ActionRow>
          <Button variant="primary" icon={<Save className={ICON_INLINE} />} disabled={busy || saving} onClick={saveEdit}>
            {saving ? t("保存中…") : t("保存")}
          </Button>
          <Button variant="secondary" onClick={back}>
            {t("取消")}
          </Button>
          <span className="text-ui-caption text-muted-foreground">
            {t("{0} 字符 · ≈{1} tokens", editing.content.length, fmtTokens(Math.ceil(editing.content.length / 4)))}
          </span>
        </ActionRow>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <div className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-ui-label leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1">{loadError}</span>
        </div>
      )}
      {savedFlash && (
        <div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 py-1.5 text-ui-label text-success">
          <Check className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">{savedFlash}</span>
          <span className="text-success/80">{t("新建会话或重启内核后生效")}</span>
        </div>
      )}
      {editLoading && (
        <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-ui-label text-muted-foreground">
          {t("读取 {0}…", editLoading)}
        </div>
      )}

      <div className="rounded-lg border border-border/70 bg-surface/60 px-2.5 py-1.5 text-ui-label leading-relaxed text-muted-foreground">
        {t("以下是内核每次请求都会自动注入的记忆文件。内容会随请求发送给模型，请勿写入密钥。")}
      </div>

      {state === null ? (
        <div className="py-4 text-center text-ui-body text-muted-foreground">{t("读取中…")}</div>
      ) : (
        <>
          {/* 4.7: 文件列表 / 快速追加 / 知识库 三块用 disclosure 分开，
              块头保留主操作，避免长列表把关键按钮埋到底部。 */}
          <SettingsDisclosure title={t("记忆文件")} defaultOpen>
            <section className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="text-ui-body font-semibold text-foreground">{t("全局记忆")}</span>
                <span className="min-w-0 truncate font-mono text-ui-caption text-muted-foreground">{state.home}</span>
                <IconButton
                  icon={<RefreshCw className={ICON_INLINE} />}
                  label={t("重新扫描")}
                  size="sm"
                  className="ml-auto"
                  disabled={busy || saving}
                  onClick={refresh}
                />
              </div>
              {globalFiles.map((file) => (
                <MemoryFileCard
                  key={file.path}
                  file={file}
                  busy={busy}
                  saving={saving}
                  onOpen={open}
                  onEdit={startEdit}
                  onDeleteFact={removeFact}
                />
              ))}
            </section>

            <section className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="text-ui-body font-semibold text-foreground">{t("项目记忆")}</span>
                <span className="min-w-0 truncate text-ui-caption text-muted-foreground">
                  {state.cwd ?? t("未打开工作区")}
                </span>
              </div>
              {projectFiles.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-ui-body text-muted-foreground">
                  {t("当前工作区没有可用的项目记忆文件")}
                </div>
              ) : (
                projectFiles.map((file) => (
                  <MemoryFileCard
                    key={file.path}
                    file={file}
                    busy={busy}
                    saving={saving}
                    onOpen={open}
                    onEdit={startEdit}
                    onDeleteFact={removeFact}
                  />
                ))
              )}
              <ActionRow>
                <Button
                  variant="secondary"
                  icon={<Plus className={ICON_INLINE} />}
                  disabled={busy || saving || !state.cwd}
                  onClick={() => {
                    setCreating((v) => !v);
                    setLoadError(null);
                  }}
                >
                  {t("新建项目记忆")}
                </Button>
                {creating && (
                  <>
                    <Button
                      variant="primary"
                      disabled={saving}
                      onClick={() => {
                        createProject("AGENTS.md");
                        setCreating(false);
                      }}
                    >
                      AGENTS.md
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={saving}
                      onClick={() => {
                        createProject("IFLOW.md");
                        setCreating(false);
                      }}
                    >
                      IFLOW.md
                    </Button>
                  </>
                )}
              </ActionRow>
            </section>
          </SettingsDisclosure>

          <SettingsDisclosure
            title={t("项目知识库")}
            defaultOpen
            header={
              <>
                {knowledge && knowledge.docs.length > 0 && (
                  <Chip tone="muted">{t("{0} 篇文档", knowledge.docs.length)}</Chip>
                )}
                {knowledge?.index ? (
                  <>
                    <Button
                      variant="secondary"
                      icon={<RefreshCw className={ICON_INLINE} />}
                      disabled={busy || saving || knowledgeBusy || !state.cwd}
                      title={t("只根据变化更新索引，无变化时不会调用模型")}
                      onClick={() => generateKnowledge("incremental")}
                    >
                      {t("增量刷新")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || saving || knowledgeBusy || !state.cwd}
                      title={t("重新分析整个工作区并覆盖索引")}
                      onClick={() => generateKnowledge("full")}
                    >
                      {t("全量重建")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    icon={<RefreshCw className={ICON_INLINE} />}
                    disabled={busy || saving || knowledgeBusy || !state.cwd}
                    onClick={() => generateKnowledge("full")}
                  >
                    {t("生成项目知识")}
                  </Button>
                )}
              </>
            }
          >
            <div className="space-y-2 px-4 py-3">
              {knowledge?.dir && (
                <div className="truncate font-mono text-ui-caption text-muted-foreground" title={knowledge.dir}>
                  {knowledge.dir}
                </div>
              )}
              {knowledge?.manifest && (
                <div className="text-ui-caption text-muted-foreground">
                  {t(
                    "上次生成：{0} · {1} 个文件",
                    knowledge.manifest.mode === "incremental" ? t("增量更新") : t("全量生成"),
                    `${knowledge.manifest.sourceCount}${knowledge.manifest.truncated ? "+" : ""}`,
                  )}
                </div>
              )}
              {knowledgeGenerating && (
                <div className="text-ui-label text-muted-foreground">
                  {knowledgeStageMessage ?? (knowledgeStage ? knowledgeStageLabel(knowledgeStage) : t("正在生成…"))}
                </div>
              )}
              {knowledgeError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-ui-label text-destructive">
                  {knowledgeError}
                </div>
              )}
              {!knowledge?.index ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-ui-body text-muted-foreground">
                  {t("尚未生成项目知识。点击「生成项目知识」分析当前工作区。")}
                </div>
              ) : (
                <div className="space-y-2">
                  {knowledge.docs.map((doc) => (
                    <div
                      key={doc.path}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-1.5"
                    >
                      <FileText className={`${ICON_INLINE} shrink-0 text-muted-foreground`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-body font-semibold text-foreground">
                          {doc.title}
                        </span>
                        <span className="block truncate font-mono text-ui-caption text-muted-foreground">
                          {doc.displayPath}
                        </span>
                      </span>
                      <Chip tone={doc.injected ? "info" : "muted"}>
                        {doc.injected ? t("已注入") : t("未注入")}
                      </Chip>
                      <span
                        className="shrink-0 font-mono text-ui-caption text-muted-foreground"
                        title={t("约 {0} tokens（BPE 估算）", doc.tokens)}
                      >
                        ≈{fmtTokens(doc.tokens)} tokens
                      </span>
                      <IconButton
                        icon={<ExternalLink className={ICON_INLINE} />}
                        label={t("打开文件")}
                        size="sm"
                        disabled={busy || knowledgeBusy}
                        onClick={() => openKnowledge(doc)}
                      />
                      <Button
                        variant="secondary"
                        disabled={busy || saving || knowledgeBusy}
                        onClick={() => toggleKnowledge(doc)}
                      >
                        {doc.injected ? t("取消注入") : t("注入")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {knowledge && knowledge.injectedTokens > 8_000 && (
                <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-ui-label leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>
                    {t("项目知识已注入约 {0} tokens，会随每次请求发送；建议只保留索引或精简文档。", knowledge.injectedTokens)}
                  </span>
                </div>
              )}
              {knowledge?.managedBy && (
                <div className="truncate text-ui-caption text-muted-foreground" title={knowledge.managedBy}>
                  {t("导入位置：{0}", knowledge.managedBy)}
                </div>
              )}
              <Hint>
                {t("知识索引生成后写入 .iflow/knowledge/，通过项目记忆的 @ 导入注入；默认只在新建或恢复会话时生效。")}
              </Hint>
            </div>
          </SettingsDisclosure>

          <SettingsDisclosure title={t("快速追加")}>
            <div className="space-y-2 px-4 py-3">
              <div className="text-ui-body font-semibold text-foreground">{t("添加一条记忆")}</div>
              <div className="flex items-center gap-2">
                <Segmented
                  ariaLabel={t("记忆作用域")}
                  value={factScope}
                  onChange={(scope) => setFactScope(scope)}
                  options={[
                    { value: "global", label: t("全局") },
                    { value: "project", label: t("项目") },
                  ]}
                />
                {writableTargets.length > 1 && (
                  <Select
                    ariaLabel={t("写入目标文件")}
                    wrapperClass="ml-auto min-w-0 flex-1"
                    value={factTarget}
                    onChange={(path) => setFactTarget(path)}
                    options={writableTargets.map((file) => ({ value: file.path, label: file.displayPath }))}
                  />
                )}
              </div>
              <TextArea
                aria-label={t("要记住的内容")}
                className="min-h-[58px] w-full"
                value={factText}
                placeholder={t("例如：本项目的测试命令是 npm test；不要修改 vendor/ 下的文件。")}
                onChange={(e) => setFactText(e.target.value)}
              />
              <div className="flex items-center gap-1.5">
                <Button
                  variant="primary"
                  icon={<Plus className={ICON_INLINE} />}
                  disabled={busy || saving || !factText.trim() || writableTargets.length === 0}
                  onClick={appendFact}
                >
                  {saving ? t("写入中…") : t("保存到{0}", scopeLabel(factScope))}
                </Button>
                <span className="text-ui-caption text-muted-foreground">
                  {writableTargets.length === 0
                    ? t("请先创建项目记忆文件")
                    : t("保存后新建会话或重启内核生效")}
                </span>
              </div>
            </div>
          </SettingsDisclosure>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
            <Button variant="secondary" disabled={busy} onClick={() => send({ type: "newSession" })}>
              {t("新建会话")}
            </Button>
            <Button
              variant="secondary"
              icon={<RefreshCw className={ICON_INLINE} />}
              disabled={busy}
              title={t("重启内核并恢复当前会话，使记忆立即生效")}
              onClick={() => send({ type: "restartCli" })}
            >
              {t("重启内核使记忆生效")}
            </Button>
            <span className="text-ui-caption text-muted-foreground">{t("记忆不会热更新到正在进行的会话。")}</span>
          </div>
        </>
      )}
    </div>
  );
}
