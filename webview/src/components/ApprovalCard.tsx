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
export function ApprovalCard({
  approval,
  active = true,
}: {
  approval: PendingApprovalUi;
  /**
   * Whether this card is the one the user can actually see and act on.
   * PendingCards passes `false` for cards covered by a newer arrival in the
   * stack. `inert` (the stack's own guard) only removes a subtree from focus,
   * hit-testing and the accessibility tree — it does NOT stop a listener on
   * `window`, so a buried card would still approve/deny on a global Y/N that
   * the user aimed at the visible card. The shortcut is therefore gated here,
   * on explicit data, not on DOM position probing.
   */
  active?: boolean;
}) {
  const send = useChat((s) => s.send);
  // 远程接续冻结：与 streaming 无关的全局态（陷阱 #12），接管期间任何审批
  // 决策都不得落地；卡片本身仍渲染，用户可只读查看远程在做什么。
  const remoteTakeover = useChat((s) => s.remoteTakeover);
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
    if (answered || remoteTakeover) return;
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
    // A covered card must not own the keyboard: its shortcuts would answer a
    // decision the user cannot see (the top card is what they are reading).
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (answered || remoteTakeover || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
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
      // ESC is the card's dismissal (deny) — the SAME decision as N, on the
      // safe side. It used to live in a React onKeyDown on the card root,
      // which only fired when focus sat inside the card and only called
      // stopPropagation: focus elsewhere (Composer / body) let the key fall
      // through to Composer's window-level "ESC stops generation" listener,
      // so one key meant "deny" or "kill the whole turn" depending on where
      // focus happened to be. Owning ESC here — behind the same `active` /
      // modal / editable / defaultPrevented gates as Y/N — gives it one
      // meaning. preventDefault makes the global stop listener bail even if
      // listener registration order changes; stopPropagation keeps document-
      // level closers out of the way.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAnswered(true);
        send({ type: "respondApproval", id: approval.id, optionId: denyOptionId });
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
  }, [active, answered, remoteTakeover, allowOption?.optionId, denyOptionId, approval.id, send]);

  const actionVerb = KIND_ACTION[approval.toolKind.toLowerCase()] ?? "执行";
  const actionTarget = primary?.path || approval.toolName;

  // Height cap + internal scroll (same shape as QuestionCard): the card caps
  // at the overlay wrapper (max-h-full) instead of growing upward, so a long
  // title / big diff can never paint over the header. Header, countdown and
  // actions stay shrink-0; only the body scrolls.
  return (
    <div
      className="acrylic stream-in glow-ring card-lift pointer-events-auto mx-3 flex max-h-full shrink-0 flex-col rounded-xl border border-primary/40"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        {/* Eyebrow + action: the eyebrow keeps the "iFlow is asking" framing,
            the heading states WHAT would run so the decision is legible
            without reading the body first. */}
        <span className="block min-w-0 space-y-0.5">
          <span className="block text-ui-micro text-muted-foreground/85 tracking-wide">
            {t("iFlow 想执行一项操作")}
          </span>
          <span
            id={titleId}
            className="block truncate text-ui-label font-semibold leading-tight"
            /* truncate 必配 title：文件路径被省略号吃掉的部分只有 hover 拿得到 */
            title={actionTarget || undefined}
          >
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
                {t("「允许一次」只执行这一次；「始终允许」会让本次会话记住这个操作，之后不再询问。")}
              </span>
              <span className="block">
                {t("拒绝或取消都不会执行任何操作。")}
              </span>
              {/* The shortcut line lives once, in the actions row — repeating
                  it here made the same hint compete with itself. */}
            </span>
          </HelpTip>
        </span>
      </div>
      {/* Scroll body: takes whatever is left after the shrink-0 header /
          countdown / actions and scrolls internally. The wire title is
          uncapped (whole shell commands / descriptions), so it belongs in
          here rather than in a nested scroll cap. The tool name no longer
          rides here — the heading carries it. */}
      <div className="min-h-0 flex-auto overflow-y-auto">
        <div className="space-y-2 px-3 py-3 text-ui-label">
          {/* break-words: unbroken tokens used to punch through the card
              border; wrapping keeps long shell commands inside. */}
          <p id={descId} className="select-text break-words text-foreground/90">
            {approval.title}
          </p>
          {primary && (
            <p className="text-ui-caption text-muted-foreground">
              <FileRef path={primary.path} line={primary.line} />
            </p>
          )}
        </div>
        {/* Pre-execution diff preview (edit tools only): the wire request
            itself carries old/new text, so the user approves the CHANGE, not
            a title. Read-only DiffView — hunk editing belongs to the
            post-completion tool card, not the approval gate.
            Height: a coarse cap only. The card is already capped by the
            overlay, so guessing from 100vh (which ignored the header and the
            Super Agent board) is wrong; 45vh keeps the diff scrollable while
            leaving room for the header/countdown/actions below. */}
        {approval.diff && (
          <div className="border-t border-border/60">
            <DiffView diff={approval.diff} maxHeightClass="max-h-[45vh]" />
          </div>
        )}
      </div>
      <div className="shrink-0">
        <CountdownBar
          deadline={approval.deadline}
          timeoutMs={approval.timeoutMs}
          quietLabel={t("自动拒绝")}
        />
      </div>
      <div ref={actionsRef} role="group" aria-label={t("审批操作")} className="flex shrink-0 flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {options.map((opt) => {
          const label = OPTION_LABEL[opt.kind] ?? opt.name;
          const isSafeSide = rejectOption?.optionId === opt.optionId;
          const { variant, className } = optionButton(opt.kind);
          return (
            <Button
              key={opt.optionId}
              variant={variant}
              size="sm"
              disabled={answered || remoteTakeover}
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
            disabled={answered || remoteTakeover}
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
