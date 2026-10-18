import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Pencil, Plus, ShieldCheck, ShieldQuestion, ShieldX, Trash2 } from "lucide-react";
import type { ApprovalAction, ApprovalRule } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { BTN, BTN_INPUT as INPUT, ConfirmDialog, SAVE_BTN } from "./ui";
import type { SectionHeader } from "./SettingsModal";

/** Editor-state header override a section reports to the settings shell. */
type SectionHeaderSetter = Dispatch<SetStateAction<SectionHeader | null>>;

/** Tool kinds offered as chips (mirrors the ACP ToolKind set). */
const KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];

const ACTION_LABEL: Record<ApprovalAction, string> = {
  allow: "自动允许",
  deny: "自动拒绝",
  ask: "弹卡确认",
};

function ActionIcon({ action }: { action: ApprovalAction }) {
  if (action === "allow") return <ShieldCheck className="size-3.5 shrink-0 text-primary" />;
  if (action === "deny") return <ShieldX className="size-3.5 shrink-0 text-destructive" />;
  return <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** One-line dimension summary for a rule row ("read · src/** · git"). */
function summaryOf(rule: ApprovalRule): string {
  const parts: string[] = [];
  if (rule.kinds && rule.kinds.length > 0) parts.push(rule.kinds.join("/"));
  if (rule.path) parts.push(rule.path);
  if (rule.commands && rule.commands.length > 0) parts.push(rule.commands.join(", "));
  if (rule.server) parts.push(`mcp:${rule.server}`);
  if (rule.tool) parts.push(rule.tool);
  return parts.join(" · ");
}

function parseList(value: string): string[] | undefined {
  const items = value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Approval-policy settings section (lives inside SettingsModal): CRUD over
 * the host's pre-review rule table (global rules in globalState, editable;
 * workspace `.iflow/approval.json` shown read-only — the panel never writes
 * it). Opens on `listApprovalPolicy`; the host answers with `approvalPolicy`
 * (same window-message channel as the MCP section). A 「始终允许」 click on an
 * approval card arrives as `draft` and opens the editor pre-filled — the rule
 * is only persisted when the user names it and saves.
 */
export function ApprovalPolicySection({ busy, onHeader, defaults }: { busy: boolean; onHeader: SectionHeaderSetter; defaults?: ReactNode }) {
  const send = useChat((s) => s.send);
  const [rules, setRules] = useState<ApprovalRule[] | null>(null); // null = loading
  const [projectRules, setProjectRules] = useState<ApprovalRule[]>([]);
  const [editing, setEditing] = useState<{ rule: ApprovalRule; index: number | null } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  // A host-derived draft opens the editor exactly once per draft id —
  // later `approvalPolicy` pushes (e.g. after saving) must not reopen it.
  const draftSeen = useRef<string | null>(null);

  useEffect(() => {
    send({ type: "listApprovalPolicy" });
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        rules?: ApprovalRule[];
        projectRules?: ApprovalRule[];
        draft?: ApprovalRule | null;
      };
      if (msg?.type !== "approvalPolicy") return;
      setRules(msg.rules ?? []);
      setProjectRules(msg.projectRules ?? []);
      const draft = msg.draft;
      if (draft && draftSeen.current !== draft.id) {
        draftSeen.current = draft.id;
        setEditing({ rule: { ...draft }, index: null });
        setEditError(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [send]);

  // Sub-editor → shell header (back arrow + contextual title).
  useEffect(() => {
    onHeader(
      editing
        ? {
            back: () => closeEditor(false),
            title: t("审批规则"),
          }
        : null,
    );
  }, [editing, onHeader]);

  function save() {
    if (!rules) return;
    send({ type: "saveApprovalPolicy", rules });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
  }

  function closeEditor(commit: boolean) {
    const editor = editing;
    setEditing(null);
    setEditError(null);
    if (!editor) return;
    if (commit) {
      const rule = editor.rule;
      if (!rule.label.trim()) {
        setEditError(t("名称不能为空"));
        setEditing(editor);
        return;
      }
      const cleaned: ApprovalRule = { ...rule, label: rule.label.trim() };
      setRules((prev) => {
        const list = prev ?? [];
        if (editor.index !== null && editor.index < list.length) {
          return list.map((r, i) => (i === editor.index ? cleaned : r));
        }
        return [...list, cleaned];
      });
    } else if (draftSeen.current === editor.rule.id && editor.index === null) {
      // Cancelling the host-derived draft tells the host to drop it too.
      send({ type: "dismissApprovalRuleDraft" });
      draftSeen.current = null;
    }
  }

  // A plain render function, NOT a nested component: a component defined in
  // the body gets a new identity every render, which unmounts/remounts its
  // subtree and would drop focus from the enable checkbox on every keystroke.
  function renderRow(rule: ApprovalRule, readOnly: boolean) {
    const summary = summaryOf(rule);
    return (
      <div
        key={readOnly ? `p-${rule.id}` : rule.id}
        className="card-lift rounded-lg border border-border px-2 py-1.5 shadow-card"
      >
        <div className="flex items-center gap-1.5">
          <ActionIcon action={rule.action} />
          <span className={`min-w-0 flex-1 truncate text-[12px] font-semibold ${rule.enabled ? "text-foreground" : "text-muted-foreground/80 line-through"}`}>
            {rule.label}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{t(ACTION_LABEL[rule.action])}</span>
          {!readOnly && (
            <>
              <label
                className="shrink-0 cursor-pointer text-[11px] text-muted-foreground"
                title={rule.enabled ? t("点击停用") : t("点击启用")}
              >
                <input
                  type="checkbox"
                  className="mr-0.5 align-[-1px] accent-[var(--color-primary)]"
                  checked={rule.enabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? { ...r, enabled: checked } : r)));
                  }}
                />
                {t("启用")}
              </label>
              <button
                className="press shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-accent/60 hover:opacity-100 hover:text-foreground"
                title={t("编辑")}
                onClick={() => {
                  setEditing({
                    rule: { ...rule },
                    index: (rules ?? []).findIndex((r) => r.id === rule.id),
                  });
                  setEditError(null);
                }}
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                data-variant="danger"
                className="press ml-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
                title={t("删除 {0}", rule.label)}
                onClick={() => setConfirmDelete(rule.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={summary}>
              {summary}
            </div>
          )}
          {!readOnly && typeof rule.hits === "number" && rule.hits > 0 && (
            <div className="shrink-0 text-[11px] text-muted-foreground/80">{t("命中 {0} 次", rule.hits)}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {editing === null && (
        <>
          {defaults && <div className="mb-2.5">{defaults}</div>}
          {rules === null ? (
            <div className="py-4 text-center text-[12px] text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <div className="space-y-1.5">
              {rules.length === 0 && projectRules.length === 0 && (
                <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center">
                  <div className="text-[12px] text-muted-foreground">{t("尚未配置审批规则")}</div>
                </div>
              )}
              {rules.map((rule) => renderRow(rule, false))}
              {projectRules.length > 0 && (
                <div className="pt-1 text-[11px] text-muted-foreground">{t("项目规则（只读）")}</div>
              )}
              {projectRules.map((rule) => renderRow(rule, true))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button
              className={BTN}
              disabled={rules === null}
              onClick={() => {
                setEditing({
                  rule: { id: `rule-new-${Date.now().toString(36)}`, label: "", enabled: true, action: "allow" },
                  index: null,
                });
                setEditError(null);
              }}
            >
              <Plus className="mr-0.5 inline size-3 align-[-2px]" />
              {t("添加")}
            </button>
            <button className={SAVE_BTN} disabled={busy || rules === null || savedFlash} onClick={save}>
              {savedFlash ? t("已保存") : t("保存")}
            </button>
            {editError && <span className="text-[12px] text-destructive">{editError}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            {t(
              "审批请求按顺序匹配规则（项目规则优先），首条命中即生效：自动允许 / 自动拒绝 / 弹卡。内置硬底线：rm、git push 等破坏性命令永不被自动允许，命中时仍弹卡确认。",
            )}
          </p>
        </>
      )}

      {editing && (
        <div className="space-y-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("规则名称")}</span>
            <input
              type="text"
              className={INPUT}
              value={editing.rule.label}
              placeholder={t("如 允许读取 src 下文件")}
              onChange={(e) => {
                const v = e.target.value;
                setEditing({ ...editing, rule: { ...editing.rule, label: v } });
              }}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("动作")}</span>
            <select
              className={INPUT}
              value={editing.rule.action}
              onChange={(e) => {
                const action = e.target.value as ApprovalAction;
                setEditing({ ...editing, rule: { ...editing.rule, action } });
              }}
            >
              <option value="allow">{t("自动允许")}</option>
              <option value="deny">{t("自动拒绝")}</option>
              <option value="ask">{t("弹卡确认")}</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-1">
            {KINDS.map((kind) => {
              const active = editing.rule.kinds?.includes(kind) ?? false;
              return (
                <button
                  key={kind}
                  type="button"
                  className={`press rounded-full border px-2 py-0.5 font-mono text-[11px] transition-all duration-200 ${
                    active
                      ? "border-primary/50 bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/30"
                  }`}
                  onClick={() => {
                    const kinds = new Set(editing.rule.kinds ?? []);
                    if (kinds.has(kind)) kinds.delete(kind);
                    else kinds.add(kind);
                    const list = KINDS.filter((k) => kinds.has(k));
                    setEditing({
                      ...editing,
                      rule: { ...editing.rule, kinds: list.length > 0 ? list : undefined },
                    });
                  }}
                >
                  {kind}
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("路径通配（相对会话目录）")}</span>
            <input
              type="text"
              className={`${INPUT} font-mono`}
              value={editing.rule.path ?? ""}
              placeholder="src/**/*.ts"
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value.trim();
                setEditing({ ...editing, rule: { ...editing.rule, path: v || undefined } });
              }}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{t("命令首词（逗号分隔，仅执行类）")}</span>
            <input
              type="text"
              className={`${INPUT} font-mono`}
              value={(editing.rule.commands ?? []).join(", ")}
              placeholder="git, npm"
              spellCheck={false}
              onChange={(e) => {
                setEditing({ ...editing, rule: { ...editing.rule, commands: parseList(e.target.value) } });
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[11.5px] text-muted-foreground">{t("MCP 服务器名")}</span>
              <input
                type="text"
                className={INPUT}
                value={editing.rule.server ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setEditing({ ...editing, rule: { ...editing.rule, server: v || undefined } });
                }}
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[11.5px] text-muted-foreground">{t("工具名（精确匹配）")}</span>
              <input
                type="text"
                className={`${INPUT} font-mono`}
                value={editing.rule.tool ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setEditing({ ...editing, rule: { ...editing.rule, tool: v || undefined } });
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button className={BTN} onClick={() => closeEditor(true)}>
              {t("完成")}
            </button>
            {editError && <span className="text-[12px] text-destructive">{editError}</span>}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            {t("维度全部留空将匹配所有请求（谨慎）；编辑只改本地副本，点击「保存」才生效。")}
          </p>
        </div>
      )}

      {confirmDelete !== null && (rules ?? []).some((r) => r.id === confirmDelete) && (
        <ConfirmDialog
          title={t("删除审批规则")}
          message={t("确定删除规则「{0}」吗？保存后生效。", (rules ?? []).find((r) => r.id === confirmDelete)!.label)}
          onConfirm={() => {
            setRules((prev) => (prev ?? []).filter((r) => r.id !== confirmDelete));
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}