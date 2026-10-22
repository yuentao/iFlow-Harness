import { useEffect, useRef, useState, useId } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import type { PendingApprovalUi, PermissionOptionUi } from "../../../shared/messages";
import { useChat } from "../store";
import { t } from "../i18n";
import { Button, type ButtonVariant, CountdownBar, FileRef, HelpTip, ICON_INLINE } from "./ui";
import { DiffView } from "./DiffView";

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

/**
 * Visual risk tiering per option kind, expressed as kit Button variants: a
 * ONE-TIME allow is the primary action (solid gradient), while an ALWAYS allow
 * changes the safety boundary for the whole session — it stays outlined (plus
 * a permanent light fill) with a lock glyph so the two can never be conflated
 * by muscle memory (visual audit P0-2).
 */
function optionButton(kind: PermissionOptionUi["kind"]): { variant: ButtonVariant; className?: string } {
  if (kind === "allow_always") return { variant: "outline-primary", className: "bg-primary/10 hover:bg-primary/20" };
  if (kind.startsWith("allow")) return { variant: "primary" };
  if (kind.startsWith("reject")) return { variant: "outline-danger" };
  return { variant: "canvas" };
}

/**
 * Milestone 14 §4.5: the CLI's own option names are English-ish and vary by
 * model ("Allow for the session", "proceed"), so the SAME decision would read
 * differently every turn. The four canonical kinds get one fixed verb phrase
 * each; anything custom the agent invented keeps its own name (with the CLI
 * original still available in `title`).
 */
const OPTION_LABEL: Record<string, string> = {
  allow_once: "允许一次",
  allow_always: "始终允许",
  reject_once: "拒绝",
  reject_always: "始终拒绝",
};

/** Heading verb per tool kind — the card's title should read as an action
 * ("写入 src/App.tsx"), not as "iFlow requests to run a tool" (which pushed
 * the real consequence down into the body). */
const KIND_ACTION: Record<string, string> = {
  read: "读取",
  edit: "写入",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "执行",
  fetch: "读取网页",
};

/**
 * Tool-execution approval card. Rendered when the host surfaces a pending
 * `session/request_permission`; disappears once answered.
 * Note: permission requests arrive mid-prompt (status is "streaming"), so the
 * buttons must NOT be gated on streaming state — the agent is blocked waiting
 * for this answer.
 */
export function ApprovalCard({ approval }: { approval: PendingApprovalUi }) {
  const send = useChat((s) => s.send);
  // Optimistic lock: the first click answers the request; every button is
  // disabled until the host's next snapshot removes the card. Prevents
  // double-fire on rapid clicks.
  const [answered, setAnswered] = useState(false);
  const titleId = useId();
  const descId = useId();
  // W4 + milestone 14 §4.5 (P0 safety): keyboard users should land on the
  // card's actions, but NEVER on an allow button. A card that appears
  // mid-stream used to autofocus its first option — options are pre-sorted
  // allow-first, so a stray Enter silently executed the tool. The safe side
  // (the agent's own reject option, else the explicit 取消) carries
  // data-autofocus and gets the initial focus; allowing requires an explicit
  // click or a Tab onto the allow button.
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = actionsRef.current;
    if (!row) return;
    (row.querySelector<HTMLElement>("[data-autofocus]") ?? row.querySelector<HTMLButtonElement>("button"))?.focus();
  }, []);

  const answer = (optionId: string | null) => {
    if (answered) return;
    setAnswered(true);
    send({ type: "respondApproval", id: approval.id, optionId });
  };

  const options = [...approval.options].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );

  const primary = approval.locations[0];
  // Y is deliberately bound to allow_once ONLY: binding it to whichever allow
  // variant comes first could silently grant an `allow_always` with one key.
  const allowOption = options.find((option) => option.kind === "allow_once");
  const rejectOption = options.find((option) => option.kind.startsWith("reject"));
  // The deny path is one decision: when the agent offered a reject option that
  // IS the "don't run this" affordance, so Esc / N / the extra 取消 button all
  // collapse onto it (a separate 取消 next to 拒绝 read as two synonyms for
  // the same thing). Only when no reject option exists does 取消 stay.
  const denyOptionId = rejectOption?.optionId ?? null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (answered || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      // A modal above this card (settings / confirm) owns the keyboard; the
      // card is still mounted underneath and must not answer a hidden prompt.
      if (document.querySelector(".auth-backdrop")) return;
      const target = e.target as HTMLElement | null;
      if (
        target
        && (target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.tagName === "SELECT"
          || target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "y" && allowOption) {
        e.preventDefault();
        e.stopPropagation();
        setAnswered(true);
        send({ type: "respondApproval", id: approval.id, optionId: allowOption.optionId });
      } else if (key === "n") {
        e.preventDefault();
        e.stopPropagation();
        setAnswered(true);
        send({ type: "respondApproval", id: approval.id, optionId: denyOptionId });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [answered, allowOption?.optionId, denyOptionId, approval.id, send]);

  const actionVerb = KIND_ACTION[approval.toolKind.toLowerCase()] ?? "执行";
  const actionTarget = primary?.path || approval.toolName;

  return (
    <div
      className="acrylic stream-in glow-ring card-lift pointer-events-auto mx-3 mb-2 shrink-0 rounded-xl border border-primary/40"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={(e) => {
        // W4: Escape means "deny" — consistent with the card's dismissal
        // semantics (the host treats a missing answer as cancelled too).
        // 拦下冒泡：等待审批时 status 仍是 streaming，事件漏到 window 会
        // 连带触发「ESC 停止生成」，一次按键双语义。
        if (e.key === "Escape") {
          e.stopPropagation();
          answer(denyOptionId);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        {/* Eyebrow + action: the eyebrow keeps the "iFlow is asking" framing,
            the heading states WHAT would run so the decision is legible
            without reading the body first. */}
        <span className="block min-w-0 space-y-0.5">
          <span className="block text-ui-micro text-muted-foreground/85 tracking-wide">
            {t("iFlow 请求执行")}
          </span>
          <span id={titleId} className="block truncate text-ui-label font-semibold leading-tight">
            {t(actionVerb)}
            {!!actionTarget && (
              <code className="approval-target ml-1">{actionTarget}</code>
            )}
          </span>
        </span>
        <span className="ml-auto">
          <HelpTip label={t("审批说明")} align="right">
            <span className="block space-y-1">
              <span className="block">
                {t("允许会立即执行该工具；「始终允许」会在本次会话内记住该工具。")}
              </span>
              <span className="block">
                {t("拒绝或取消都不会执行；可在设置 → 审批策略中预审规则。")}
              </span>
              {/* The shortcut line lives once, in the actions row — repeating
                  it here made the same hint compete with itself. */}
            </span>
          </HelpTip>
        </span>
      </div>
      <div className="space-y-2 px-3 py-3 text-ui-label">
        {/* break-words + scroll cap: the wire title is uncapped (whole shell
            commands / descriptions); unbroken tokens used to punch through
            the card border, long ones grew the shrink-0 card unbounded.
            The tool name no longer rides here — the heading carries it. */}
        <p id={descId} className="max-h-40 select-text overflow-y-auto break-words text-foreground/90">
          {approval.title}
        </p>
        {primary && (
          <p className="text-ui-caption text-muted-foreground">
            <FileRef path={primary.path} line={primary.line} />
          </p>
        )}
      </div>
      {/* Pre-execution diff preview (edit tools only): the wire request itself
          carries old/new text, so the user approves the CHANGE, not a title.
          Read-only DiffView — hunk editing belongs to the post-completion
          tool card, not the approval gate. */}
      {approval.diff && (
        <div className="border-t border-border/60">
          <DiffView diff={approval.diff} maxHeightClass="max-h-[max(120px,calc(100vh-360px))]" />
        </div>
      )}
      <CountdownBar
        deadline={approval.deadline}
        timeoutMs={approval.timeoutMs}
        quietLabel={t("自动拒绝")}
      />
      <div ref={actionsRef} role="group" aria-label={t("审批操作")} className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {options.map((opt) => {
          const label = OPTION_LABEL[opt.kind] ?? opt.name;
          const isSafeSide = rejectOption?.optionId === opt.optionId;
          const { variant, className } = optionButton(opt.kind);
          return (
            <Button
              key={opt.optionId}
              variant={variant}
              size="sm"
              disabled={answered}
              data-autofocus={isSafeSide ? true : undefined}
              title={OPTION_LABEL[opt.kind] ? opt.name : undefined}
              aria-label={approval.toolName ? t("{0}（{1}）", label, approval.toolName) : label}
              className={className}
              icon={opt.kind === "allow_always" ? <Lock className={`${ICON_INLINE} shrink-0`} /> : undefined}
              onClick={() => answer(opt.optionId)}
            >
              {label}
            </Button>
          );
        })}
        {!rejectOption && (
          <Button
            variant="canvas"
            size="sm"
            disabled={answered}
            data-autofocus
            aria-label={t("取消审批")}
            onClick={() => answer(null)}
          >
            {t("取消")}
          </Button>
        )}
        <span className="ml-auto self-center text-ui-micro text-muted-foreground/80">
          {rejectOption ? t("Y 允许一次 · N/Esc 拒绝") : t("Y 允许一次 · N 拒绝 · Esc 取消")}
        </span>
      </div>
    </div>
  );
}
