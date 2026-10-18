// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialSessionState } from "../shared/messages";
import { useChat } from "../webview/src/store";
import { TurnChanges } from "../webview/src/components/TurnChanges";
import { setLocale } from "../webview/src/i18n";

let root: Root;
let container: HTMLDivElement;
const send = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  useChat.setState({ state: { ...initialSessionState(), sessionId: "s", status: "idle", blocks: [{ kind: "user", id: "u", text: "go" }] }, send });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<TurnChanges sessionId="s" userBlockId="u" />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); setLocale(undefined); });
function reply(extra: object = {}) {
  const request = send.mock.calls[0]![0];
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "turnChanges", records: [], unavailable: false, ...extra } })));
}
const record = (toolCallId: string, path: string, additions: number, deletions: number, edits = 1, canUndo = true) => ({
  toolCallId, title: toolCallId, status: "completed", key: path, path, additions, deletions, edits, canUndo,
});
it("renders a changed-files summary and opens a file in the editor", () => {
  expect(send).toHaveBeenCalledWith({ type: "requestTurnChanges", sessionId: "s", userBlockId: "u", requestId: expect.any(String) });
  reply({ requestId: "wrong" });
  expect(container.textContent).toContain("正在读取");
  reply({ records: [
    { ...record("first", "src/first.ts", 471, 0), partiallyReverted: true },
    record("second", "src/second.ts", 62, 6, 2),
  ] });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("2 个文件已更改");
  expect(container.textContent).toContain("+533");
  expect(container.textContent).toContain("−6");
  const rows = container.querySelectorAll<HTMLButtonElement>('[data-testid="turn-change-open"]');
  expect(rows).toHaveLength(2);
  expect(container.textContent).toContain("first.ts");
  expect(container.textContent).toContain("部分回退");
  expect(container.textContent).toContain("2 次修改");
  expect(container.querySelector(".diff-scroll")).toBeNull();
  expect(rows[0]?.getAttribute("title")).toContain("src/first.ts");
  act(() => rows[1]!.click());
  expect(send).toHaveBeenLastCalledWith({ type: "openLocation", path: "src/second.ts", toolCallId: "second" });
  const undo = container.querySelectorAll<HTMLButtonElement>('button[aria-label="撤销此文件的本轮修改"]');
  expect(undo).toHaveLength(2);
  act(() => undo[1]!.click());
  expect(send).toHaveBeenLastCalledWith({ type: "revertTurnFile", sessionId: "s", userBlockId: "u", key: "src/second.ts" });
});
it("hides undo when unsafe and on historical turns", () => {
  reply({ records: [record("safe", "safe.ts", 1, 0), record("created", "created.ts", 2, 0, 1, false)] });
  expect(container.querySelectorAll('button[aria-label="撤销此文件的本轮修改"]')).toHaveLength(1);
  act(() => useChat.setState({ state: {
    ...useChat.getState().state!,
    blocks: [{ kind: "user", id: "u", text: "go" }, { kind: "user", id: "next", text: "next" }],
  } }));
  expect(container.querySelectorAll('button[aria-label="撤销此文件的本轮修改"]')).toHaveLength(0);
});
it("translates the changed-files summary", () => {
  setLocale("en");
  reply({ records: [record("tool", "src/file.ts", 3, 1)] });
  expect(container.textContent).toContain("1 file changed");
  expect(container.textContent).toContain("Click a file to open it in the editor.");
  expect(container.querySelector("ul button")?.getAttribute("title")).toContain("Open in editor");
});
it("uses honest empty wording and disappears when the session changes", () => {
  reply();
  expect(container.textContent).toContain("这不表示没有文件修改");
  act(() => useChat.setState({ state: { ...useChat.getState().state!, sessionId: "other" } }));
  expect(container.textContent).toBe("");
  reply({ records: [record("stale", "stale.ts", 1, 0)] });
  expect(container.textContent).not.toContain("stale");
});