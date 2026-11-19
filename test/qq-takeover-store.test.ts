// @vitest-environment jsdom
/**
 * 远程接续状态同步（真实 webview store，无 mock）：
 * host 的 `qqTakeoverState` 消息必须只改内存态 `remoteTakeover`，不进快照、
 * 不持久化；连续 start/stop 回推要能正确翻转按钮与冻结门。
 */
import { describe, expect, it } from "vitest";
import { useChat } from "../webview/src/store";

describe("qqTakeoverState 同步", () => {
  it("active 真/假正确翻转 remoteTakeover 内存态", () => {
    useChat.setState({ remoteTakeover: false });
    useChat.getState().applyHostMessage({ type: "qqTakeoverState", active: true });
    expect(useChat.getState().remoteTakeover).toBe(true);
    useChat.getState().applyHostMessage({ type: "qqTakeoverState", active: false });
    expect(useChat.getState().remoteTakeover).toBe(false);
  });
});
