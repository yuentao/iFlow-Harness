import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Pencil, Plus, ShieldCheck, ShieldQuestion, ShieldX, Trash2 } from "lucide-react";
import type { ApprovalAction, ApprovalRule } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import {
  ActionRow,
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  Hint,
  ICON_INLINE,
  IconButton,
  Select,
  TextInput,
  ToggleChip,
} from "./ui";
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
          <span className={`min-w-0 flex-1 truncate text-ui-body font-semibold ${rule.enabled ? "text-foreground" : "text-muted-foreground/80 line-through"}`}>
            {rule.label}
          </span>
          <span className="shrink-0 text-ui-label text-muted-foreground">{t(ACTION_LABEL[rule.action])}</span>
          {!readOnly && (
            <>
              <Checkbox
                label={t("启用")}
                title={rule.enabled ? t("点击停用") : t("点击启用")}
                checked={rule.enabled}
                onChange={(checked) =>
                  setRules((prev) => (prev ?? []).map((r) => (r.id === rule.id ? { ...r, enabled: checked } : r)))
                }
              />
              <IconButton
                icon={<Pencil className={ICON_INLINE} />}
                label={t("编辑")}
                size="sm"
                onClick={() => {
                  setEditing({
                    rule: { ...rule },
                    index: (rules ?? []).findIndex((r) => r.id === rule.id),
                  });
                  setEditError(null);
                }}
              />
              <IconButton
                icon={<Trash2 className={ICON_INLINE} />}
                label={t("删除 {0}", rule.label)}
                size="sm"
                tone="danger"
                onClick={() => setConfirmDelete(rule.id)}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <div className="min-w-0 flex-1 truncate font-mono text-ui-label text-muted-foreground" title={summary}>
              {summary}
            </div>
          )}
          {!readOnly && typeof rule.hits === "number" && rule.hits > 0 && (
            <div className="shrink-0 text-ui-label text-muted-foreground/80">{t("命中 {0} 次", rule.hits)}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {editing === null && (
        <>
          {defaults && <div className="mb-3">{defaults}</div>}
          {rules === null ? (
            <div className="py-4 text-center text-ui-body text-muted-foreground">{t("读取中…")}</div>
          ) : (
            <div className="space-y-2">
              {rules.length === 0 && projectRules.length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
                  <div className="text-ui-body text-muted-foreground">{t("尚未配置审批规则")}</div>
                </div>
              )}
              {rules.map((rule) => renderRow(rule, false))}
              {projectRules.length > 0 && (
                <div className="pt-1 text-ui-label text-muted-foreground">{t("项目规则（只读）")}</div>
              )}
              {projectRules.map((rule) => renderRow(rule, true))}
            </div>
          )}

          <ActionRow className="mt-2">
            <Button
              icon={<Plus className={ICON_INLINE} />}
              disabled={rules === null}
              onClick={() => {
                setEditing({
                  rule: { id: `rule-new-${Date.now().toString(36)}`, label: "", enabled: true, action: "allow" },
                  index: null,
                });
                setEditError(null);
              }}
            >
              {t("添加")}
            </Button>
            <Button variant="primary" disabled={busy || rules === null || savedFlash} onClick={save}>
              {savedFlash ? t("已保存") : t("保存")}
            </Button>
            {editError && <span className="text-ui-body text-destructive">{editError}</span>}
          </ActionRow>
          <Hint className="mt-2">
            {t(
              "审批请求按顺序匹配规则（项目规则优先），首条命中即生效：自动允许 / 自动拒绝 / 弹卡。内置硬底线：rm、git push 等破坏性命令永不被自动允许，命中时仍弹卡确认。",
            )}
          </Hint>
        </>
      )}

      {editing && (
        <div className="space-y-2">
          <Field label={t("规则名称")}>
            <TextInput
              value={editing.rule.label}
              placeholder={t("如 允许读取 src 下文件")}
              onChange={(e) => {
                const v = e.target.value;
                setEditing({ ...editing, rule: { ...editing.rule, label: v } });
              }}
            />
          </Field>
          <Field label={t("动作")}>
            <Select
              ariaLabel={t("动作")}
              options={[
                { value: "allow", label: t("自动允许") },
                { value: "deny", label: t("自动拒绝") },
                { value: "ask", label: t("弹卡确认") },
              ]}
              value={editing.rule.action}
              onChange={(action) => {
                setEditing({ ...editing, rule: { ...editing.rule, action: action as ApprovalAction } });
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-1">
            {KINDS.map((kind) => (
              <ToggleChip
                key={kind}
                mono
                active={editing.rule.kinds?.includes(kind) ?? false}
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
              </ToggleChip>
            ))}
          </div>
          <Field label={t("路径通配（相对会话目录）")}>
            <TextInput
              mono
              value={editing.rule.path ?? ""}
              placeholder="src/**/*.ts"
              onChange={(e) => {
                const v = e.target.value.trim();
                setEditing({ ...editing, rule: { ...editing.rule, path: v || undefined } });
              }}
            />
          </Field>
          <Field label={t("命令首词（逗号分隔，仅执行类）")}>
            <TextInput
              mono
              value={(editing.rule.commands ?? []).join(", ")}
              placeholder="git, npm"
              onChange={(e) => {
                setEditing({ ...editing, rule: { ...editing.rule, commands: parseList(e.target.value) } });
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Field label={t("MCP 服务器名")} className="min-w-0 flex-1">
              <TextInput
                value={editing.rule.server ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setEditing({ ...editing, rule: { ...editing.rule, server: v || undefined } });
                }}
              />
            </Field>
            <Field label={t("工具名（精确匹配）")} className="min-w-0 flex-1">
              <TextInput
                mono
                value={editing.rule.tool ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setEditing({ ...editing, rule: { ...editing.rule, tool: v || undefined } });
                }}
              />
            </Field>
          </div>
          <ActionRow>
            <Button onClick={() => closeEditor(true)}>
              {t("完成")}
            </Button>
            {editError && <span className="text-ui-body text-destructive">{editError}</span>}
          </ActionRow>
          <Hint>
            {t("维度全部留空将匹配所有请求（谨慎）；编辑只改本地副本，点击「保存」才生效。")}
          </Hint>
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
