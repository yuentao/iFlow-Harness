import { describe, it, expect } from "vitest";
import { findCliHistoryCut } from "../shared/session-state.js";
import { AGENT_ATTACHMENT_HEADER } from "../shared/messages.js";

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