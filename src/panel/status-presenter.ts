/**
 * StatusPresenter — status-bar display logic, extracted from `panel.ts`
 * (阶段 2 of the panel split; behavior-preserving refactor).
 *
 * Owns the `vscode.StatusBarItem` lifecycle (create in ctor → show → update on
 * every state push → dispose with the panel) and the single source of truth
 * for its text / tooltip. `ChatPanel.updateStatusBar` stays as a thin delegate
 * so the store callback, `extension.ts` and the existing tests keep the exact
 * same contract (including reaching the live item via `panel.statusBar`).
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It receives a
 * `SessionState` per update, reads nothing else from the host, and routes every
 * user-visible string through `vscode.l10n.t`. `esbuild.mjs` only bundles
 * `src/extension.ts`, so this file reaches the output solely through the
 * `panel.ts` import below.
 */

import * as vscode from "vscode";
import type { SessionState } from "../../shared/messages.js";

export class StatusPresenter {
  /** The live status bar item. `ChatPanel` keeps a read alias to it so tests
   * that reach into `panel.statusBar.text` / `.tooltip` keep working. */
  readonly statusBar: vscode.StatusBarItem;
  /** Last rendered tooltip text — the status bar is refreshed on every state
   * push, and rebuilding the Markdown for identical numbers is pure churn. */
  private statusBarTooltipText = "";

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "iflow.openPanel";
    this.statusBar.tooltip = vscode.l10n.t("心流·驭光 — 点击打开聊天面板");
  }

  /** Mount the always-visible launcher (called at the end of the panel ctor). */
  show(): void {
    this.statusBar.show();
  }

  /** Render one state snapshot into the status bar. Dedup guard is unchanged:
   * a write only happens when the rendered text / background / tooltip differ. */
  update(state: SessionState): void {
    const model = state.currentModelId ? ` · ${state.currentModelId}` : "";
    const mode = state.modes ? ` · ${state.modes.currentModeId}` : "";
    let text: string;
    let background: vscode.ThemeColor | undefined;
    switch (state.status) {
      case "connecting":
        text = `$(sync~spin) iFlow${model}`;
        break;
      case "streaming": {
        // beginReplay 也会把 status 置成 "streaming"，但那是恢复转录而不是
        // 模型在生成：转圈配「生成中」会让用户以为卡在生成（webview 同一
        // 时刻显示的是「正在恢复会话…」）。replaying 优先于 compressing 与
        // 生成中，文案与 webview 的 restore 态保持一致。
        const label = state.replaying
          ? vscode.l10n.t("正在恢复会话…")
          : state.compressing
            ? vscode.l10n.t("正在压缩")
            : vscode.l10n.t("生成中");
        text = `$(sync~spin) iFlow: ${label}${model}`;
        break;
      }
      case "error":
        text = `$(error) iFlow: ${vscode.l10n.t("出错")}${model}`;
        background = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      default:
        if (state.pendingApproval) {
          text = `$(bell) iFlow: ${vscode.l10n.t("等待审批")}${model}`;
          background = new vscode.ThemeColor("statusBarItem.warningBackground");
        } else if (state.superWaiting && state.superHeld) {
          // 用户按了停止：汇报被压在队列里，主会话并没有在生成。旧实现把它和
          // 真 streaming 渲染成同一串「生成中」+ 转圈，而 composer 明明显示
          // 「发送」—— 用户看到的就是「卡住了」。如实写已停止 + 待处理数量，
          // 不转圈；下一步动作放在 hover tooltip 与常驻提示里。
          const pending = state.superPendingCount ?? 0;
          text = pending > 0
            ? `$(history) iFlow: ${vscode.l10n.t("已停止 · {0} 项待处理", pending)}${model}`
            : `$(history) iFlow: ${vscode.l10n.t("已停止")}${model}`;
        } else if (state.superWaiting) {
          // 子会话确实还在跑 / 在等你回答：如实用「运行中 / 等你回答」，
          // 不能说「生成中」——那是主回合的语义，此刻主会话是 idle。
          const kids = state.superSessions ?? [];
          const awaiting = kids.some((session) => session.status === "awaiting_input");
          text = awaiting
            ? `$(bell) iFlow: ${vscode.l10n.t("等你回答")}${model}`
            : `$(sync~spin) iFlow: ${vscode.l10n.t("运行中")}${model}`;
        } else {
          text = `$(check) iFlow${mode}${model}`;
        }
    }
    if (this.statusBar.text !== text || this.statusBar.backgroundColor !== background) {
      this.statusBar.text = text;
      this.statusBar.backgroundColor = background;
    }
    const tip = this.statusBarTooltip(state);
    if (tip !== this.statusBarTooltipText) {
      this.statusBarTooltipText = tip;
      this.statusBar.tooltip = tip;
    }
  }

  /**
   * Status-bar hover content: launcher hint plus the session's token usage.
   * UI-audit 4.6 moved the usage breakdown out of the composer (a section
   * appended to the model menu was unreachable behind a gateway's long model
   * list); the status bar is always visible, so its tooltip is the on-demand
   * "session info" view. Plain strings in StatusBarItem.tooltip render as
   * Markdown.
   */
  private statusBarTooltip(state: SessionState): string {
    const base = vscode.l10n.t("心流·驭光 — 点击打开聊天面板");
    // 压住态必须告诉用户「下一步是什么」，否则「已停止 · N 项待处理」照样像
    // 死锁。它比用量信息更重要，所以即使没有用量也要出现在 tooltip 里。
    const heldTip = state.superHeld
      ? vscode.l10n.t(
          "已停止：还有 {0} 项超流体结果待处理。发送下一条消息，或点提示条上的「继续处理」来收取汇报",
          state.superPendingCount ?? 0,
        )
      : null;
    const u = state.usage;
    if (!u || u.totalTokens <= 0) return heldTip ? `${base}\n\n${heldTip}` : base;
    const used = u.contextUsed ?? u.inputTokens;
    const rows: string[] = [];
    if (u.contextWindow) {
      const pct = Math.min(100, Math.round((used / u.contextWindow) * 100));
      rows.push(
        vscode.l10n.t(
          "上下文 {0} / {1}（{2}%）",
          used.toLocaleString(),
          u.contextWindow.toLocaleString(),
          `${u.estimated ? "≈" : ""}${pct}`,
        ),
      );
    } else {
      rows.push(vscode.l10n.t("上下文约 {0} tokens", used.toLocaleString()));
    }
    rows.push(
      vscode.l10n.t("输入 {0} tokens · 输出 {1} tokens", u.inputTokens.toLocaleString(), u.outputTokens.toLocaleString()),
    );
    // Fixed prefill: the instructions / memory / tool declarations the model
    // re-reads on EVERY request. Without this row the occupancy looks like
    // "the conversation so far" while the model actually carries tens of
    // thousands of tokens of fixed input.
    if (u.prefillTokens && u.prefillTokens > 0) {
      rows.push(
        vscode.l10n.t(
          "每次请求固定携带 {0} tokens（系统提示词、记忆与工具说明）",
          u.prefillTokens.toLocaleString(),
        ),
      );
    }
    if (u.cacheReadTokens > 0) {
      rows.push(vscode.l10n.t("缓存读取 {0} tokens", u.cacheReadTokens.toLocaleString()));
    }
    if (u.breakdown) {
      rows.push(
        vscode.l10n.t(
          "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}",
          u.breakdown.user.toLocaleString(),
          u.breakdown.assistant.toLocaleString(),
          u.breakdown.tool.toLocaleString(),
          u.breakdown.thought.toLocaleString(),
        ),
      );
    }
    if (u.estimatedCost !== null && u.estimatedCost !== undefined) {
      const cost = u.estimatedCost > 0 && u.estimatedCost < 0.01
        ? `$${u.estimatedCost.toFixed(4)}`
        : `$${u.estimatedCost.toFixed(2)}`;
      rows.push(vscode.l10n.t("预估成本 {0}（按公开单价估算）", cost));
    }
    const usageTip = `${base}\n\n**${vscode.l10n.t("会话用量")}**\n\n${rows.map((r) => `- ${r}`).join("\n")}`;
    return heldTip ? `${usageTip}\n\n${heldTip}` : usageTip;
  }

  /** Dispose the status bar item. Called from ChatPanel.dispose() at the same
   * point in the teardown order as before the extraction. */
  dispose(): void {
    this.statusBar.dispose();
  }
}