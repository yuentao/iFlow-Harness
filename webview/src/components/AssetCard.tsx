import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Check, ChevronRight, Copy, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type {
  AssetContentFields,
  AssetKind,
  AssetScope,
  AssetUi,
  AssetsStateUi,
} from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { copyText } from "./Markdown";
import { ActionRow, Button, Chip, ConfirmDialog, DisclosureButton, Field, FieldLabel, Hint, IconButton, ICON_INLINE, Segmented, TextArea, TextInput, ToolbarRow } from "./ui";
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
 * 复制原文（.toml 命令的原始 TOML / 其它资产的原始文件内容）。
 *
 * 成功翻成对勾，2 秒后复原；剪贴板被 webview 权限拒绝时抛一条「复制失败」
 * 提示 —— 拒绝和成功长得不一样，绝不谎报已复制（与转录的复制反馈同一语言）。
 */
function CopySourceButton({ text, label }: { text: string; label: string }) {
  const notify = useChat((s) => s.notify);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <IconButton
      size="sm"
      label={copied ? t("已复制") : label}
      icon={
        copied ? (
          <Check className={ICON_INLINE} aria-hidden="true" />
        ) : (
          <Copy className={ICON_INLINE} aria-hidden="true" />
        )
      }
      onClick={() => {
        Promise.resolve()
          .then(() => copyText(text))
          .then(
            () => {
              if (timer.current) clearTimeout(timer.current);
              setCopied(true);
              timer.current = setTimeout(() => {
                timer.current = null;
                setCopied(false);
              }, 2000);
            },
            () => notify(t("复制失败"), "error"),
          );
      }}
    />
  );
}

/**
 * 原始正文面板：.toml 命令 = 原始 TOML 源文本，其它资产 = 原始文件内容。
 *
 * 结构化视图只显示 description / prompt 两个字段，而注释、未知键、CLI 的
 * zod 校验依据都只在原文里 —— 原文必须有一个入口，否则用户永远拿不到
 * 自己那份文件。折叠走 kit 的 DisclosureButton（aria-expanded + 焦点环，
 * 不自绘按钮），复制走 kit 的 IconButton（aria-label 与 tooltip 同文），
 * 正文是 <pre> + overflow-auto + max-h，长文件在面板内滚动，不撑破布局。
 */
function RawSourcePanel({
  content,
  label,
  copyLabel,
  defaultOpen = false,
}: {
  content: string;
  label: string;
  copyLabel: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <DisclosureButton
          expanded={open}
          aria-label={label}
          title={label}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span className="text-ui-label font-medium text-foreground">{label}</span>
        </DisclosureButton>
        <CopySourceButton text={content} label={copyLabel} />
      </div>
      {open && (
        <pre
          className="max-h-72 overflow-auto rounded-md bg-muted/8 px-2 py-1.5 font-mono text-ui-caption leading-snug whitespace-pre-wrap break-all"
          title={label}
        >
          {content}
        </pre>
      )}
    </div>
  );
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
  /** Structured description/prompt from the host (.toml only). null = no
   * structured view → fall back to the raw body. */
  const [detailFields, setDetailFields] = useState<AssetContentFields | null>(null);
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
        fields?: AssetContentFields;
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
          setDetailFields(msg.fields ?? null);
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
                setDetailFields(null);
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
      setEditError(t("名称只能用字母、数字、- 和 _，并且要以字母或数字开头"));
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
      {loadError && <div role="alert" className="text-ui-body text-destructive">{loadError}</div>}

      {editing === null && detail === null && creating === null && confirmDelete === null && (
        <>
          <Segmented
            ariaLabel={t("资产类型")}
            value={kind}
            onChange={setKind}
            options={KIND_TABS.map((tab) => ({ value: tab.kind, label: tab.label }))}
          />
          {/* 动作并为一行：新建（主操作，secondary 实心描边）+ 刷新（便利动作，
              ghost 无边框），顺序与设置面板其它区块一致（主操作在前、便利动作在后）。
              此前拆成 ToolbarRow + SecondaryRow 两行、两条分隔线，视觉上像两段互不
              相干的工具条（用户反馈）；合并后只留一条收尾分隔线。行容器仍是 kit 的
              ToolbarRow（flex-wrap：窄面板放不下时允许换行，不会横向溢出）。 */}
          <ToolbarRow>
            <Button
              variant="secondary"
              icon={<Plus className={ICON_INLINE} />}
              disabled={state === null || !!loadError || saving}
              onClick={() => {
                closeCreate();
                setCreating({ kind, scope: "global", name: "", body: templateBody(kind, "") });
                setEditError(null);
              }}
            >
              {t("新建")}
            </Button>
            <Button
              variant="ghost"
              icon={<RefreshCw className={ICON_INLINE} />}
              disabled={saving || (state === null && !loadError)}
              onClick={refresh}
            >
              {refreshing ? t("刷新中…") : t("刷新")}
            </Button>
            {editError && <span role="alert" className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span role="alert" className="ml-auto text-ui-label text-warning">
                {t("文件已经在磁盘上被改过，请刷新后再编辑")}
              </span>
            )}
            {savedFlash && !saving && (
              <span role="status" aria-live="polite" className="ml-auto text-ui-label text-success">{savedFlash}</span>
            )}
          </ToolbarRow>
          {state === null ? (
            <div className="py-4 text-center text-ui-body text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <div className="mt-2 space-y-2">
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-2 py-1.5 text-center text-ui-label text-muted-foreground">
                  {t("这里还没有内容")}
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
                          <Chip tone="warning">{t("有同名全局版本，实际用的是它")}</Chip>
                        )}
                        <IconButton
                          icon={<ChevronRight className={ICON_INLINE} />}
                          label={t("详情")}
                          size="sm"
                          disabled={saving || !!loadError}
                          onClick={() => {
                            setDetail({ path: item.path, hash: item.hash });
                            setDetailContent(null);
                            setDetailFields(null);
                            setEditError(null);
                            requestOpen(item.path, "detail");
                          }}
                        />
                        <IconButton
                          icon={<Pencil className={ICON_INLINE} />}
                          label={t("编辑")}
                          size="sm"
                          disabled={saving || !!loadError || !item.editable}
                          onClick={() => {
                            setEditing({ path: item.path, content: "", hash: null });
                            setEditError(null);
                            requestOpen(item.path, "edit");
                          }}
                        />
                        {!saving && !loadError && (
                          <IconButton
                            icon={<Trash2 className={ICON_INLINE} />}
                            label={t("删除 {0}", item.name)}
                            size="sm"
                            tone="danger"
                            onClick={() => setConfirmDelete(item.path)}
                          />
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
              "这里的列表直接来自磁盘：全局的在 ~/.iflow 下，项目的在工作区的 .iflow 下。改完的文件要等新建会话或重启内核后才生效。",
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
          ) : detailFields && (detailFields.description !== null || detailFields.prompt !== null) ? (
            <div className="space-y-2">
              {detailFields.description !== null && (
                <div className="flex flex-col gap-1">
                  <FieldLabel>{t("描述")}</FieldLabel>
                  <p className="text-ui-body leading-relaxed text-foreground">{detailFields.description}</p>
                </div>
              )}
              {detailFields.prompt !== null && (
                <div className="flex flex-col gap-1">
                  <FieldLabel>{t("提示词")}</FieldLabel>
                  <pre
                    className="max-h-48 overflow-y-auto rounded-md bg-muted/8 px-1.5 py-1 font-mono text-ui-caption leading-snug whitespace-pre-wrap break-all"
                    title={t("提示词")}
                  >
                    {detailFields.prompt}
                  </pre>
                </div>
              )}
              {/* 原始 TOML：结构化视图之外仍要能拿到原文 —— 注释、未知键、CLI 的
                  zod 校验依据都只在原文里。默认折叠，不抢结构化视图的位置。 */}
              <RawSourcePanel
                key={detail.path}
                content={detailContent}
                label={t("原始 TOML")}
                copyLabel={t("复制原始 TOML")}
              />
            </div>
          ) : (
            <>
              <Hint>{t("无法提取结构化字段，显示原始文件内容")}</Hint>
              <RawSourcePanel
                key={detail.path}
                content={detailContent}
                label={detail.path.toLowerCase().endsWith(".toml") ? t("原始 TOML") : t("原始文件内容")}
                copyLabel={detail.path.toLowerCase().endsWith(".toml") ? t("复制原始 TOML") : t("复制原始文件内容")}
                defaultOpen
              />
            </>
          )}
          {detailContent !== null && (
            <ActionRow>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing({ path: detail.path, content: detailContent, hash: detail.hash });
                  setDetail(null);
                  setDetailContent(null);
                  setDetailFields(null);
                  setEditError(null);
                }}
              >
                {t("编辑")}
              </Button>
            </ActionRow>
          )}
        </div>
      )}

      {editing !== null && (
        <div className="space-y-2">
          {editLoading !== null ? (
            <div className="py-3 text-center text-ui-label text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <Field label={t("文件内容（Markdown 正文与头部配置）")}>
              <TextArea
                mono
                className="min-h-40 text-ui-label leading-relaxed"
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
            <Button variant="primary" disabled={editLoading !== null} onClick={saveEditing}>
              {saving ? t("保存中…") : savedFlash ? t("已保存") : t("保存")}
            </Button>
            {editError && <span role="alert" className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span role="alert" className="text-ui-label text-warning">
                {t("文件已经在磁盘上被改过，请刷新后再编辑")}
              </span>
            )}
          </ActionRow>
          <Hint>
            {t("保存前会核对文件是否被改动；如果磁盘上的内容已经变了，会提示你刷新，而不是覆盖它。")}
          </Hint>
        </div>
      )}

      {creating !== null && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel={t("资产类型")}
              value={creating.kind}
              onChange={(kind) => {
                // A kind switch legitimately needs that kind's skeleton
                // (frontmatter keys differ), so the draft is reset here.
                bodyTouched.current = false;
                setGenError(null);
                setCreating((current) =>
                  current && { ...current, kind, body: templateBody(kind, current.name.trim()) },
                );
              }}
              options={(["command", "agent", "skill"] as AssetKind[]).map((kind) => ({
                value: kind,
                label: kindLabel(kind),
              }))}
            />
            <Segmented
              ariaLabel={t("保存位置")}
              value={creating.scope}
              onChange={(scope) => setCreating((current) => (current ? { ...current, scope } : null))}
              options={(["global", "project"] as AssetScope[]).map((scope) => ({
                value: scope,
                label: scopeLabel(scope),
                disabled: scope === "project" && state?.cwd === null,
              }))}
            />
          </div>
          <Field label={t("名称")}>
            <TextInput
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
            <Field label={t("你希望它做什么（用于 AI 生成）")}>
              <TextArea
                className="min-h-16 leading-relaxed"
                value={genRequirement}
                placeholder={t("如：检查本次改动的类型错误并给出修复步骤")}
                onChange={(e) => {
                  setGenRequirement(e.target.value);
                  setGenError(null);
                }}
              />
            </Field>
            <ActionRow className="mt-2">
              <Button
                variant="secondary"
                icon={<Sparkles className={ICON_INLINE} />}
                disabled={generating || saving}
                onClick={generateBody}
              >
                {generating ? t("生成中…") : t("AI 生成内容")}
              </Button>
              {genError && <span role="alert" className="text-ui-body text-destructive">{genError}</span>}
            </ActionRow>
          </div>
          <Field label={t("内容（模板，可直接修改）")}>
            <TextArea
              mono
              className="min-h-40 text-ui-label leading-relaxed"
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
            <Button variant="primary" disabled={generating} onClick={createAsset}>
              {saving ? t("创建中…") : savedFlash ? t("已创建") : t("创建")}
            </Button>
            {editError && <span role="alert" className="text-ui-body text-destructive">{editError}</span>}
            {conflict && (
              <span role="alert" className="text-ui-label text-warning">
                {t("已经有同名文件了，直接编辑它即可")}
              </span>
            )}
          </ActionRow>
          <Hint>
            {t("文件路径由类型、保存位置和名称自动拼出（名称只能用字母、数字、- 和 _，并且要以字母或数字开头）。同名文件不会被覆盖；AI 生成只会填好上面的内容，点「创建」才会真正写入文件。")}
          </Hint>
        </div>
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          title={t("删除资产文件")}
          message={t("确定删除「{0}」吗？删除后无法恢复。", confirmDelete.split(/[\\/]/).slice(-2).join("/"))}
          onConfirm={() => {
            deleteAsset(confirmDelete);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
