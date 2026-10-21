import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, ChevronRight, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type {
  AssetKind,
  AssetScope,
  AssetUi,
  AssetsStateUi,
} from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, Chip, ConfirmDialog, SAVE_BTN, ActionRow, Field, Hint, ToolbarRow } from "./ui";
import type { SectionHeader } from "./SettingsModal";

/** Editor-state header override a section reports to the settings shell. */
type SectionHeaderSetter = Dispatch<SetStateAction<SectionHeader | null>>;

/** createAsset name rule — mirrors the host's ASSET_NAME_RE (the host
 * re-validates; pre-checking here saves a doomed round trip). */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${n}B`;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function scopeLabel(scope: AssetScope): string {
  return scope === "global" ? t("全局") : t("项目");
}

function kindLabel(kind: AssetKind): string {
  switch (kind) {
    case "command": return t("命令");
    case "agent": return t("子代理");
    default: return t("技能");
  }
}

/** Body skeletons per kind matching the CLI's loader contracts (probed):
 * command .md frontmatter description + prompt body; agent .md needs
 * frontmatter name (agent-type also accepted); skill SKILL.md frontmatter
 * name + description. The user edits the skeleton in place. */
function templateBody(kind: AssetKind, name: string): string {
  switch (kind) {
    case "command":
      return `---\ndescription: 描述此任务\n---\n\n把 {{args}} 分析并修复\n`;
    case "agent":
      return `---\nname: ${name || "my-agent"}\ndescription: 何时委派到此子代理\nallowed-tools: Read, Grep, Glob\n---\n\n任务说明在此。\n`;
    default:
      return `---\nname: ${name || "my-skill"}\ndescription: 使用场景说明\n---\n\n# 步骤\n\n1. …\n`;
  }
}

/**
 * F4 asset manager (settings tab): lists the CLI's user-level assets —
 * custom slash commands, subagent definitions, skills — as they stand on
 * disk (the CLI and the agent's own tools write the same files behind our
 * back, so the card always opens on a fresh scan via `listAssets`).
 *
 * Editing is raw-file (markdown + frontmatter): the CLI's zod validation is
 * authoritative, and a structurer form would silently drop the open-ended
 * frontmatter keys (color/model/proactive/…) — same honest tradeoff as the
 * MCP card's raw JSON. The 「新建」 form generates a kind-correct skeleton
 * and the HOST builds the path from validated kind/scope/name.
 *
 * Save round trips carry a requestId and echo the sha256 the card read:
 * a `conflict` reply means the file moved on disk since — nothing was
 * written, the user must refresh and re-edit (never silently overwrite).
 */
export function AssetSection({ busy: _, onHeader }: { busy: boolean; onHeader: SectionHeaderSetter }) {
  void _;
  const send = useChat((s) => s.send);
  const [state, setState] = useState<AssetsStateUi | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // detail/edit subviews (one at a time); editLoading = read in flight.
  const [detail, setDetail] = useState<{ path: string; hash: string | null } | null>(null);
  const [detailContent, setDetailContent] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string; hash: string | null } | null>(null);
  const [editLoading, setEditLoading] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ kind: AssetKind; scope: AssetScope; name: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 4.7: three parallel lists (commands / agents / skills) read as three
  // unrelated sections. A segmented control keeps one list on screen with the
  // kind as the axis — same data, one place.
  const [kind, setKind] = useState<AssetKind>("command");
  // AI drafting (F4): the requirement only feeds the prompt, and the reply
  // fills the body — nothing is written until the user clicks 创建.
  const [genRequirement, setGenRequirement] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  /** Echoed by `assetGenerated`; filters out other requests' replies. */
  const genRequestRef = useRef<number | null>(null);
  /** Set once the body holds user- or model-written text, so a later name edit
   * must not stamp the skeleton template back over it. */
  const bodyTouched = useRef(false);
  const pending = useRef<{ requestId: number; kind: "save" | "create" | "delete" } | null>(null);
  const requestSeq = useRef(0);
  const editRequestRef = useRef<string | null>(null);
  const requestMode = useRef<"detail" | "edit" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingKind = useRef<"save" | "create" | null>(null);
  const confirmDeleteRef = useRef<string | null>(null);

  const nextRequestId = (): number => {
    requestSeq.current += 1;
    return requestSeq.current;
  };

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        state?: AssetsStateUi;
        path?: string;
        content?: string;
        hash?: string | null;
        ok?: boolean;
        conflict?: boolean;
        error?: string;
        requestId?: number;
      };
      if (msg?.type === "assetsState" && msg.state) {
        setState(msg.state);
        setLoadError(msg.state.error ?? null);
        setRefreshing(false);
        if (pending.current === null) setSaving(false);
        return;
      }
      if (msg?.type === "assetContent") {
        if (editRequestRef.current !== msg.path) return;
        const mode = requestMode.current;
        editRequestRef.current = null;
        requestMode.current = null;
        setEditLoading(null);
        const targetPath = msg.path ?? "";
        if (msg.error) {
          setEditError(msg.error);
          setDetail(null);
          setEditing(null);
          return;
        }
        if (mode === "detail") {
          setDetail({ path: targetPath, hash: msg.hash ?? null });
          setDetailContent(msg.content ?? "");
          return;
        }
        setEditing((current) =>
          current && current.path === targetPath
            ? { ...current, content: msg.content ?? "", hash: msg.hash ?? null }
            : current,
        );
        return;
      }
      if (msg?.type === "assetDeleted") {
        if (pending.current?.kind !== "delete" || msg.requestId !== pending.current?.requestId) return;
        pending.current = null;
        setSaving(false);
        if (msg.error) {
          setEditError(msg.error);
          return;
        }
        const removed = confirmDeleteRef.current;
        setConfirmDelete(null);
        setState((current) =>
          current && {
            ...current,
            commands: current.commands.filter((i) => i.path !== removed),
            agents: current.agents.filter((i) => i.path !== removed),
            skills: current.skills.filter((i) => i.path !== removed),
          },
        );
        setSavedFlash(t("已删除"));
        flashTimer.current = setTimeout(() => setSavedFlash(null), 2500);
        return;
      }
      if (msg?.type === "assetGenerated") {
        // Only our own request: the id is echoed, so a stale or concurrent
        // generation cannot overwrite what the user is looking at.
        if (genRequestRef.current === null || msg.requestId !== genRequestRef.current) return;
        genRequestRef.current = null;
        setGenerating(false);
        if (msg.error) {
          setGenError(msg.error);
          return;
        }
        setGenError(null);
        bodyTouched.current = true;
        setCreating((current) => (current ? { ...current, body: msg.content ?? "" } : null));
        return;
      }
      if (msg?.type !== "assetSaved") return;
      if (
        !pending.current ||
        (pending.current.kind !== "save" && pending.current.kind !== "create") ||
        msg.requestId !== pending.current.requestId
      ) {
        return;
      }
      pending.current = null;
      setSaving(false);
      if (msg.conflict) {
        setConflict(msg.path ?? "");
        return;
      }
      if (msg.error) {
        setEditError(msg.error);
        return;
      }
      if (pendingKind.current === "create") {
        // A created file must appear in the list — re-scan.
        send({ type: "listAssets" });
      }
      setSavedFlash(pendingKind.current === "create" ? t("已创建") : t("已保存"));
      flashTimer.current = setTimeout(() => setSavedFlash(null), 2500);
    };
    window.addEventListener("message", handler);
    send({ type: "listAssets" });
    return () => {
      window.removeEventListener("message", handler);
      clearTimeout(flashTimer.current);
    };
  }, [send]);

  // Sub-editor / detail-view → shell header (back arrow + contextual title).
  useEffect(() => {
    onHeader(
      editing !== null
        ? {
            back: () => {
              setEditing(null);
              setEditError(null);
            },
            title: t("编辑资产文件"),
          }
        : detail !== null
          ? {
              back: () => {
                setDetail(null);
                setDetailContent(null);
              },
              title: t("资产详情"),
            }
          : creating !== null
            ? {
                back: closeCreate,
                title: t("新建资产"),
              }
            : null,
    );
  }, [editing, detail, creating, onHeader]);

  function requestOpen(file: string, mode: "detail" | "edit"): void {
    editRequestRef.current = file;
    requestMode.current = mode;
    setEditLoading(file);
    send({ type: "readAsset", path: file });
  }

  function saveEditing(): void {
    if (!editing || pending.current) return;
    const requestId = nextRequestId();
    pendingKind.current = "save";
    pending.current = { requestId, kind: "save" };
    setSaving(true);
    send({
      type: "saveAsset",
      path: editing.path,
      content: editing.content,
      expectedHash: editing.hash,
      requestId,
    });
  }

  function createAsset(): void {
    if (!creating || pending.current) return;
    const name = creating.name.trim();
    if (!name) {
      setEditError(t("名称不能为空"));
      return;
    }
    if (!ASSET_NAME_RE.test(name)) {
      setEditError(t("名称仅允许字母/数字/-/_（以字母或数字开头）"));
      return;
    }
    const requestId = nextRequestId();
    pendingKind.current = "create";
    pending.current = { requestId, kind: "create" };
    setSaving(true);
    send({
      type: "createAsset",
      kind: creating.kind,
      scope: creating.scope,
      name,
      content: creating.body,
      requestId,
    });
    closeCreate();
    setEditError(null);
  }

  /** Ask the host to draft the body from the requirement. Own requestId lane
   * (this is not a write, so `pending` stays free for 创建/保存/删除). */
  function generateBody(): void {
    if (!creating || generating) return;
    const requirement = genRequirement.trim();
    if (!requirement) {
      setGenError(t("请先描述需求，再生成内容"));
      return;
    }
    const requestId = nextRequestId();
    genRequestRef.current = requestId;
    setGenError(null);
    setGenerating(true);
    send({
      type: "generateAsset",
      kind: creating.kind,
      name: creating.name.trim(),
      requirement,
      requestId,
    });
  }

  /** Close the create dialog and drop any in-flight generation: a late reply
   * must neither resurrect `generating` (blocking every later attempt) nor
   * stamp a body onto a form the user already left. */
  function closeCreate(): void {
    genRequestRef.current = null;
    setGenerating(false);
    setGenError(null);
    setGenRequirement("");
    bodyTouched.current = false;
    setCreating(null);
  }

  function deleteAsset(path: string): void {
    if (pending.current) return;
    const requestId = nextRequestId();
    pendingKind.current = null;
    pending.current = { requestId, kind: "delete" };
    confirmDeleteRef.current = path;
    setSaving(true);
    send({ type: "deleteAsset", path, requestId });
  }

  function refresh(): void {
    if (!state && !loadError) return; // initial scan still in flight
    setState(null);
    editRequestRef.current = null;
    setEditLoading(null);
    send({ type: "listAssets" });
    setRefreshing(true);
  }

  // 4.7: three parallel lists (commands / agents / skills) read as three
  // unrelated sections. A segmented control keeps one list on screen with the
  // kind as the axis — same data, one place.
  const KIND_TABS: Array<{ kind: AssetKind; label: string }> = [
    { kind: "command", label: t("命令") },
    { kind: "agent", label: t("子代理") },
    { kind: "skill", label: t("技能") },
  ];
  const items: AssetUi[] = state
    ? kind === "command"
      ? state.commands
      : kind === "agent"
        ? state.agents
        : state.skills
    : [];

  return (
    <>
      {loadError && <div className="text-ui-body text-destructive">{loadError}</div>}

      {editing === null && detail === null && creating === null && confirmDelete === null && (
        <>
          <ToolbarRow>
            <button
              className={BTN}
              disabled={state === null || !!loadError || saving}
              onClick={() => {
                closeCreate();
                setCreating({ kind, scope: "global", name: "", body: templateBody(kind, "") });
                setEditError(null);
              }}
            >
              <Plus className="size-3.5" />
              {t("新建")}
            </button>
            <button
              className={BTN}
              disabled={saving || (state === null && !loadError)}
              onClick={refresh}
            >
              <RefreshCw className="size-3.5" />
              {refreshing ? t("刷新中…") : t("刷新")}
            </button>
            {editError && <span className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span className="ml-auto text-ui-label text-warning">
                {t("磁盘文件已被别写入，请刷新后再编辑")}
              </span>
            )}
            {savedFlash && !saving && (
              <span className="ml-auto text-ui-label text-success">{savedFlash}</span>
            )}
          </ToolbarRow>
          {state === null ? (
            <div className="py-4 text-center text-ui-body text-muted-foreground">{t("扫描中…")}</div>
          ) : (
            <div className="mt-2 space-y-3">
              <div
                role="group"
                aria-label={t("资产类型")}
                className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-panel/60 p-0.5"
              >
                {KIND_TABS.map((tab) => (
                  <button
                    key={tab.kind}
                    type="button"
                    aria-pressed={kind === tab.kind}
                    className={`press rounded-md px-2.5 py-1.5 text-ui-label transition-colors duration-200 ${
                      kind === tab.kind
                        ? "bg-primary/15 font-semibold text-primary"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    }`}
                    onClick={() => setKind(tab.kind)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-2 py-1.5 text-center text-ui-label text-muted-foreground">
                  {t("尚未定义")}
                </div>
              ) : (
                <div className="space-y-2">
                  {items.map((item) => (
                    <div
                      key={item.path}
                      className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Chip tone={item.scope === "global" ? "primary" : "info"}>
                          {scopeLabel(item.scope)}
                        </Chip>
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-ui-body font-semibold text-foreground"
                          title={item.displayPath}
                        >
                          {item.name}
                        </span>
                        {item.shadowed && (
                          <Chip tone="warning">{t("全局同名遮蔽")}</Chip>
                        )}
                        <button
                          className="press shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors duration-150 hover:bg-accent/60 hover:opacity-100 hover:text-foreground"
                          title={t("详情")}
                          disabled={saving || !!loadError}
                          onClick={() => {
                            setDetail({ path: item.path, hash: item.hash });
                            setDetailContent(null);
                            setEditError(null);
                            requestOpen(item.path, "detail");
                          }}
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                        <button
                          className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors duration-150 hover:bg-accent/60 hover:opacity-100 hover:text-foreground"
                          title={t("编辑")}
                          disabled={saving || !!loadError || !item.editable}
                          onClick={() => {
                            setEditing({ path: item.path, content: "", hash: null });
                            setEditError(null);
                            requestOpen(item.path, "edit");
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        {!saving && !loadError && (
                          <button
                            data-variant="danger"
                            className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                            title={t("删除 {0}", item.name)}
                            onClick={() => setConfirmDelete(item.path)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                      {item.description && (
                        <div className="truncate text-ui-label text-muted-foreground" title={item.description}>
                          {item.description}
                        </div>
                      )}
                      <div className="mt-1 text-ui-caption font-mono text-muted-foreground/80">
                        {fmtBytes(item.bytes)} · {fmtTime(item.updatedAt)}
                        {item.tools ? ` · ${t("工具")}: ${item.tools.join(", ")}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Hint className="mt-2">
            {t(
              "扫描与编辑直接读写 ~/.iflow 与 <cwd>/.iflow 的 commands / agents / skills 目录（与 CLI 加载语义：命令递归 .md/.toml，子代理顶层 .md，技能 <目录>/SKILL.md）；当前会话已固定记忆，恢复会话后生效。",
            )}
          </Hint>
        </>
      )}

      {detail !== null && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-ui-body font-semibold text-foreground">
              {detail.path.split(/[\\/]/).slice(-2).join("/")}
            </span>
            <Chip tone="muted">{t("详情")}</Chip>
          </div>
          {detailContent === null ? (
            <div className="py-3 text-center text-ui-label text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <pre
              className="max-h-48 overflow-y-auto rounded-md bg-muted/8 px-2 py-1.5 font-mono text-ui-label leading-snug whitespace-pre-wrap break-all"
              title={t("文件内容")}
            >
              {detailContent}
            </pre>
          )}
          <ActionRow>
            <button
              className={BTN}
              onClick={() => {
                setDetail(null);
                setDetailContent(null);
              }}
            >
              <Check className="size-3.5" />
              {t("返回")}
            </button>
            {detailContent !== null && (
              <button
                className={BTN}
                onClick={() => {
                  setEditing({ path: detail.path, content: detailContent, hash: detail.hash });
                  setDetail(null);
                  setDetailContent(null);
                  setEditError(null);
                }}
              >
                {t("编辑")}
              </button>
            )}
          </ActionRow>
        </div>
      )}

      {editing !== null && (
        <div className="space-y-2">
          {editLoading !== null ? (
            <div className="py-3 text-center text-ui-label text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <Field label={t("文件内容（markdown + frontmatter）")}>
              <textarea
                className={`${INPUT} min-h-40 resize-y font-mono text-ui-label leading-relaxed`}
                spellCheck={false}
                value={editing.content}
                onChange={(e) => {
                  const v = e.target.value;
                  setEditing((current) => (current ? { ...current, content: v } : null));
                  setSavedFlash(null);
                  setConflict(null);
                }}
              />
            </Field>
          )}
          <ActionRow>
            <button className={SAVE_BTN} disabled={editLoading !== null} onClick={saveEditing}>
              {saving ? t("保存中…") : savedFlash ? t("已保存") : t("保存")}
            </button>
            {editError && <span className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span className="text-ui-label text-warning">
                {t("磁盘文件已被别写入，请刷新后再编辑")}
              </span>
            )}
          </ActionRow>
          <Hint>
            {t("保存前对 hash，磁盘漂移即回 conflict（不覆盖）。")}
          </Hint>
        </div>
      )}

      {creating !== null && (
        <div className="space-y-2">
          <ActionRow>
            {(["command", "agent", "skill"] as AssetKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-current={creating.kind === kind ? "true" : undefined}
                className={`press shrink-0 rounded-lg px-2 py-1 text-ui-label font-medium transition-colors duration-150 ${
                  creating.kind === kind
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                onClick={() => {
                  // A kind switch legitimately needs that kind's skeleton
                  // (frontmatter keys differ), so the draft is reset here.
                  bodyTouched.current = false;
                  setGenError(null);
                  setCreating((current) =>
                    current && { ...current, kind, body: templateBody(kind, current.name.trim()) },
                  );
                }}
              >
                {kindLabel(kind)}
              </button>
            ))}
          </ActionRow>
          <ActionRow>
            {(["global", "project"] as AssetScope[]).map((scope) => (
              <button
                key={scope}
                type="button"
                aria-current={creating.scope === scope ? "true" : undefined}
                disabled={scope === "project" && state?.cwd === null}
                className={`press shrink-0 rounded-lg px-2 py-1 text-ui-label font-medium transition-colors duration-150 ${
                  creating.scope === scope
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                onClick={() => {
                  setCreating((current) => (current ? { ...current, scope } : null));
                }}
              >
                {scopeLabel(scope)}
              </button>
            ))}
          </ActionRow>
          <Field label={t("名称")}>
            <input
              type="text"
              className={INPUT}
              value={creating.name}
              placeholder={t("如 fix-tests")}
              onChange={(e) => {
                const v = e.target.value;
                setCreating((current) =>
                  current && {
                    ...current,
                    name: v,
                    // Stamp the skeleton only while the body is untouched —
                    // never over a generated or hand-written draft.
                    body: bodyTouched.current ? current.body : templateBody(current.kind, v.trim()),
                  },
                );
              }}
            />
          </Field>
          <div className="rounded-lg border border-border/70 bg-surface/40 px-2 py-1.5">
            <Field label={t("需求描述（用于 AI 生成）")}>
              <textarea
                className={`${INPUT} min-h-16 resize-y leading-relaxed`}
                value={genRequirement}
                placeholder={t("如：检查本次改动的类型错误并给出修复步骤")}
                onChange={(e) => {
                  setGenRequirement(e.target.value);
                  setGenError(null);
                }}
              />
            </Field>
            <ActionRow className="mt-2">
              <button className={BTN} disabled={generating || saving} onClick={generateBody}>
                <Sparkles className="size-3.5" />
                {generating ? t("生成中…") : t("AI 生成内容")}
              </button>
              {genError && <span className="text-ui-body text-destructive">{genError}</span>}
            </ActionRow>
          </div>
          <Field label={t("内容（frontmatter 模板，可直接改）")}>
            <textarea
              className={`${INPUT} min-h-40 resize-y font-mono text-ui-label leading-relaxed`}
              spellCheck={false}
              value={creating.body}
              onChange={(e) => {
                const v = e.target.value;
                bodyTouched.current = true;
                setCreating((current) => (current ? { ...current, body: v } : null));
              }}
            />
          </Field>
          <ActionRow>
            <button className={SAVE_BTN} disabled={generating} onClick={createAsset}>
              {saving ? t("创建中…") : savedFlash ? t("已创建") : t("创建")}
            </button>
            {editError && <span className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span className="text-ui-label text-warning">
                {t("同名资产已存在，直接编辑它")}
              </span>
            )}
          </ActionRow>
          <Hint>
            {t("Host 拼路径从类型/作用域/名称（只字母数字-_），同名即回 conflict（不覆盖）。AI 生成只填充上方内容，点「创建」才写入文件。")}
          </Hint>
        </div>
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          title={t("删除资产文件")}
          message={t("确定删除「{0}」吗？此操作不可撤销。", confirmDelete.split(/[\\/]/).slice(-2).join("/"))}
          onConfirm={() => {
            deleteAsset(confirmDelete);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
