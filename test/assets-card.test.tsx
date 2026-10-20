// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetSection } from "../webview/src/components/AssetCard";

const send = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", () => ({
  useChat: (selector: (s: { send: typeof send }) => unknown) => selector({ send }),
}));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
}));

let root: Root;
let container: HTMLDivElement;
const header = vi.fn();

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
function clickTitle(title: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.getAttribute("title") === title);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
// ConfirmDialog portals onto document.body, outside the component container.
function bodyClick(text: string) {
  const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** The create form has two textareas: the asset body is the mono one, the
 * AI-generation requirement is not. */
function bodyArea(): HTMLTextAreaElement {
  const area = [...container.querySelectorAll("textarea")].find((ta) => ta.className.includes("font-mono"));
  expect(area).toBeTruthy();
  return area!;
}
function reqArea(): HTMLTextAreaElement {
  const area = [...container.querySelectorAll("textarea")].find((ta) => !ta.className.includes("font-mono"));
  expect(area).toBeTruthy();
  return area!;
}
function generatedReply(requestId: number, content: string, error?: string) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "assetGenerated", requestId, content, error } }),
      ),
  );
}

const CMD = {
  kind: "command",
  scope: "global",
  name: "fix-tests",
  path: "C:\\home\\.iflow\\commands\\fix-tests.md",
  displayPath: "~/.iflow/commands/fix-tests.md",
  description: "Fix failing tests",
  tools: null,
  bytes: 512,
  updatedAt: 1_700_000_000_000,
  hash: "hash-1",
  editable: true,
};
const AGENT = {
  kind: "agent",
  scope: "project",
  name: "docs-writer",
  path: "C:\\ws\\.iflow\\agents\\docs-writer.md",
  displayPath: ".iflow/agents/docs-writer.md",
  description: "Writes docs pages",
  tools: ["Read", "Grep"],
  bytes: 1024,
  updatedAt: 1_700_000_000_000,
  hash: "hash-2",
  editable: true,
};
const SKILL = {
  kind: "skill",
  scope: "global",
  name: "pdf",
  path: "C:\\home\\.iflow\\skills\\pdf\\SKILL.md",
  displayPath: "~/.iflow/skills/pdf/SKILL.md",
  description: "Fill PDF forms",
  tools: null,
  bytes: 2048,
  updatedAt: 1_700_000_000_000,
  hash: "hash-3",
  editable: true,
};

function stateReply(commands: unknown[], agents: unknown[], skills: unknown[]) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent(
          "message",
          {
            data: {
              type: "assetsState",
              state: {
                home: "C:\\home\\.iflow",
                cwd: "C:\\ws",
                workspaceRoots: ["C:\\ws"],
                commands,
                agents,
                skills,
              },
            },
          },
        ),
      ),
  );
}
function contentReply(path: string, content: string, hash: string | null) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "assetContent", path, content, hash } }),
      ),
  );
}
function savedReply(requestId: number, extra: Record<string, unknown> = {}, path: string = CMD.path) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "assetSaved", ok: true, path, requestId, ...extra } }),
      ),
  );
}
function deletedReply(requestId: number) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "assetDeleted", ok: true, requestId } }),
      ),
  );
}

beforeEach(() => {
  send.mockReset();
  header.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<AssetSection busy={false} onHeader={header} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("lists assets through a segmented kind control with scope chips and metadata", () => {
  stateReply([CMD], [AGENT], [SKILL]);
  // 4.7: one list driven by a segmented control instead of three parallel lists.
  expect(container.textContent).toContain("命令");
  expect(container.textContent).toContain("子代理");
  expect(container.textContent).toContain("技能");
  // The command kind is active by default → only its entries are listed.
  expect(container.textContent).toContain("fix-tests");
  expect(container.textContent).not.toContain("docs-writer");
  expect(container.textContent).not.toContain("pdf");
  expect(container.textContent).toContain("512B");
  // Switching the segment swaps the list.
  click("子代理");
  expect(container.textContent).toContain("docs-writer");
  expect(container.textContent).not.toContain("fix-tests");
  expect(container.textContent).toContain("项目");
  expect(container.textContent).toContain("Read, Grep");
  click("技能");
  expect(container.textContent).toContain("pdf");
  expect(container.textContent).not.toContain("docs-writer");
  expect(container.textContent).toContain("全局");
});

it("edits an asset file through the read → textarea → hash-guarded save loop", () => {
  stateReply([CMD], [], []);
  clickTitle("编辑");
  expect(container.textContent).toContain("读取中…");
  contentReply(CMD.path, "old content\n", "hash-1");
  const textarea = container.querySelector("textarea")!;
  expect(taValueOK(textarea)).toBe(true);
  input(textarea, "new content\n");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveAsset");
  expect(call.requestId).toBe(1);
  expect(call.expectedHash).toBe("hash-1");
  expect(container.textContent).toContain("保存中…");
  savedReply(1);
  expect(container.textContent).toContain("已保存");
});

it("refuses a save whose expected hash drifted on disk (conflict, nothing written)", () => {
  stateReply([CMD], [], []);
  clickTitle("编辑");
  contentReply(CMD.path, "draft", "stale-hash");
  click("保存");
  savedReply(1, { conflict: true, ok: false });
  expect(container.textContent).toContain("磁盘文件已被别写入，请刷新后再编辑");
  expect(container.textContent).not.toContain("已保存");
});

it("creates a kind-correct skeleton host-side and re-scans after success", () => {
  stateReply([CMD], [], []);
  click("新建");
  const nameInput = container.querySelector("input")!;
  input(nameInput, "fix-tests");
  const body = bodyArea();
  expect(body.value).toContain("把 {{args}} 分析并修复");
  click("创建");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("createAsset");
  expect(call.kind).toBe("command");
  expect(call.scope).toBe("global");
  expect(call.name).toBe("fix-tests");
  expect(call.requestId).toBe(1);
  savedReply(1);
  expect(container.textContent).toContain("已创建");
  expect(send.mock.calls.some(([m]) => m.type === "listAssets")).toBe(true);
});

it("pre-checks the name rule client-side before any round trip", () => {
  stateReply([CMD], [], []);
  click("新建");
  input(container.querySelector("input")!, "bad name!");
  click("创建");
  expect(send.mock.calls.filter(([m]) => m.type === "createAsset")).toHaveLength(0);
  expect(container.textContent).toContain("名称仅允许");
});

it("deletes via ConfirmDialog and removes the row only on Host confirmation", () => {
  stateReply([CMD], [], []);
  clickTitle("删除 fix-tests");
  expect(document.body.textContent).toContain("确定删除");
  expect(document.body.textContent).toContain("commands/fix-tests.md");
  bodyClick("删除");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("deleteAsset");
  expect(call.requestId).toBe(1);
  deletedReply(1);
  expect(container.textContent).not.toContain("fix-tests");
  expect(container.textContent).toContain("已删除");
});

it("refresh falls back to the scan skeleton and re-requests the state", () => {
  stateReply([CMD], [], []);
  click("刷新");
  expect(container.textContent).toContain("扫描中…");
  expect(send.mock.calls.filter(([m]) => m.type === "listAssets")).toHaveLength(2);
});

function taValueOK(ta: HTMLTextAreaElement): boolean {
  return ta.value === "old content\n";
}

it("drafts the body from a requirement and keeps it across a later name edit", () => {
  stateReply([CMD], [], []);
  click("新建");
  input(reqArea(), "检查类型错误并修复");
  click("AI 生成内容");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("generateAsset");
  expect(call.kind).toBe("command");
  expect(call.requirement).toBe("检查类型错误并修复");
  expect(call.requestId).toBe(1);
  expect(container.textContent).toContain("生成中…");
  // A generation is a draft, never a write.
  expect(send.mock.calls.filter(([m]) => m.type === "createAsset")).toHaveLength(0);
  generatedReply(1, "---\ndescription: 生成的\n---\n\n生成正文\n");
  expect(bodyArea().value).toContain("生成正文");
  expect(container.textContent).not.toContain("生成中…");
  // Renaming must not stamp the skeleton back over the generated draft.
  input(container.querySelector("input")!, "renamed");
  expect(bodyArea().value).toContain("生成正文");
});

it("refuses to generate without a requirement", () => {
  stateReply([CMD], [], []);
  click("新建");
  click("AI 生成内容");
  expect(send.mock.calls.filter(([m]) => m.type === "generateAsset")).toHaveLength(0);
  expect(container.textContent).toContain("请先描述需求");
});

it("ignores a generation reply for another request and surfaces an error", () => {
  stateReply([CMD], [], []);
  click("新建");
  input(reqArea(), "x");
  click("AI 生成内容");
  generatedReply(99, "别的请求的草稿");
  expect(bodyArea().value).not.toContain("别的请求的草稿");
  expect(container.textContent).toContain("生成中…");
  generatedReply(1, "", "网关超时");
  expect(container.textContent).toContain("网关超时");
  expect(container.textContent).not.toContain("生成中…");
});

it("creates the file from the generated draft", () => {
  stateReply([CMD], [], []);
  click("新建");
  input(container.querySelector("input")!, "gen-cmd");
  input(reqArea(), "生成一个命令");
  click("AI 生成内容");
  generatedReply(1, "---\ndescription: d\n---\n\n生成正文\n");
  click("创建");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("createAsset");
  expect(call.name).toBe("gen-cmd");
  expect(call.content).toContain("生成正文");
});
