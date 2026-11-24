import { describe, it, expect } from "vitest";
import { findCliHistoryCut } from "../shared/session-state.js";
import { AGENT_ATTACHMENT_HEADER } from "../shared/messages.js";
import { EFFICIENCY_STEADY_PROMPT, EFFICIENCY_TURBO_PROMPT } from "../prompts/index.js";

const user = (text: string) => ({ role: "user", parts: [{ text }] });

/**
 * The attachment block the host appends to the agent-facing prompt is a
 * PROTOCOL literal: the producer (src/panel/panel.ts) writes it, the CLI
 * records that text verbatim, and the consumer (findCliHistoryCut) must
 * recognise the very same header to locate a turn inside the CLI history.
 *
 * When the two drift apart, a turn that carries attachments can no longer be
 * located → the deletion degrades to "transcript-only", i.e. the message the
 * user deleted STAYS in the model's context.
 */
describe("agent attachment header · producer/consumer contract", () => {
  it("recognizes the attachment block the host writes today", () => {
    const history = [
      user("看这个文件\n\n" + AGENT_ATTACHMENT_HEADER + "\n- a.ts → /p/a.ts"),
    ];
    expect(findCliHistoryCut(history, ["看这个文件"], 0)).toEqual({
      kind: "truncate",
      index: 0,
    });
  });

  it("still recognizes attachment blocks written by older builds", () => {
    const legacyZh = [
      user("看这个文件\n\n用户附带以下本地文件（可按需读取）：\n- a.ts → /p/a.ts"),
    ];
    expect(findCliHistoryCut(legacyZh, ["看这个文件"], 0)).toEqual({
      kind: "truncate",
      index: 0,
    });
    const legacyEn = [
      user(
        "看这个文件\n\nThe user attached these local files (read them as needed):\n- a.ts → /p/a.ts",
      ),
    ];
    expect(findCliHistoryCut(legacyEn, ["看这个文件"], 0)).toEqual({
      kind: "truncate",
      index: 0,
    });
  });

  it("does not treat a bare prefix as an attachment block", () => {
    const history = [user("部署服务并检查日志")];
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "skip" });
  });

  it("does not treat the header text alone (without the file list) as an attachment block", () => {
    const history = [user("部署服务\n\n" + AGENT_ATTACHMENT_HEADER)];
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "skip" });
  });
});

/**
 * 效率开关（`iflow.efficiencyMode`）在档位变化时把一段档位块追加到 prompt
 * 末尾，CLI 逐字记进 chatHistory。转录里的用户气泡不含这段，所以比对前必须
 * 从末尾剥除 —— 否则带档位块的轮次永远对不上，「删除消息 / 编辑重发」会静默
 * 退化成只删转录、模型上下文里那条消息还在。
 */
describe("efficiency-mode block · producer/consumer contract", () => {
  it("剥离末尾的速推块后仍能定位该轮", () => {
    const history = [user("部署服务\n\n" + EFFICIENCY_TURBO_PROMPT)];
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "truncate", index: 0 });
  });

  it("剥离末尾的恢复块后仍能定位该轮", () => {
    const history = [user("部署服务\n\n" + EFFICIENCY_STEADY_PROMPT)];
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "truncate", index: 0 });
  });

  it("档位块与附件块共存时也能定位（附件块在前、档位块在末尾）", () => {
    const history = [
      user("看这个文件\n\n" + AGENT_ATTACHMENT_HEADER + "\n- a.ts → /p/a.ts\n\n" + EFFICIENCY_TURBO_PROMPT),
    ];
    expect(findCliHistoryCut(history, ["看这个文件"], 0)).toEqual({ kind: "truncate", index: 0 });
  });

  it("档位块作为独立的第二个 text part 记录时同样能匹配（真实 wire 形态）", () => {
    const history = [
      { role: "user", parts: [{ text: "部署服务" }, { text: EFFICIENCY_TURBO_PROMPT }] },
    ];
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "truncate", index: 0 });
  });

  it("正文里恰好出现同样的字样（非末尾）不会被误剥", () => {
    const history = [user("请解释这段：" + EFFICIENCY_TURBO_PROMPT + "\n然后继续")];
    // 未被剥离 → 与转录正文不等 → 不匹配（宁可 skip 也不误删）。
    expect(findCliHistoryCut(history, ["请解释这段：然后继续"], 0)).toEqual({ kind: "skip" });
  });
});