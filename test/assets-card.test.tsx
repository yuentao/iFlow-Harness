// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetSection } from "../webview/src/components/AssetCard";

const send = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", () => ({
  useChat: (selector: (s: { send: typeof send; notify: typeof notify }) => unknown) =>
    selector({ send, notify }),
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

const RAW_TOML = [
  "# Command: api-docs",
  "# Description: 在apipost创建api文档",
  'description = "在apipost创建api文档"',
  'prompt = """',
  "在 apipost 创建 API 文档。",
  'description = "假描述，不应出现在详情里"',
  "1. 打开 apipost",
  '"""',
  "",
].join("\n");
const TOML_FIELDS = {
  description: "在apipost创建api文档",
  prompt: "在 apipost 创建 API 文档。\ndescription = \"假描述，不应出现在详情里\"\n1. 打开 apipost",
};
const TOML_CMD = {
  ...CMD,
  name: "api-docs",
  path: "C:\\home\\.iflow\\commands\\api-docs.toml",
  displayPath: "~/.iflow/commands/api-docs.toml",
  description: "在apipost创建api文档",
  hash: "hash-toml",
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
function contentReply(
  path: string,
  content: string,
  hash: string | null,
  fields?: { description: string | null; prompt: string | null } | null,
) {
  act(
    () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "assetContent",
            path,
            content,
            hash,
            ...(fields !== undefined ? { fields } : {}),
          },
        }),
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
  notify.mockReset();
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
  // The copy case stubs navigator.clipboard; jsdom has none by default.
  Reflect.deleteProperty(navigator, "clipboard");
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

it("renders a .toml detail as structured 描述/提示词 fields, keeping the raw TOML behind a collapsed disclosure", () => {
  stateReply([TOML_CMD], [], []);
  clickTitle("详情");
  expect(container.textContent).toContain("读取中…");
  contentReply(TOML_CMD.path, RAW_TOML, "hash-toml", TOML_FIELDS);

  // Semantic field labels (FieldLabel) with their values.
  const labels = [...container.querySelectorAll("span")].map((s) => s.textContent);
  expect(labels).toContain("描述");
  expect(labels).toContain("提示词");
  expect([...container.querySelectorAll("p")].some((p) => p.textContent === TOML_FIELDS.description)).toBe(true);
  const promptPre = [...container.querySelectorAll("pre")].find((p) => p.getAttribute("title") === "提示词");
  expect(promptPre).toBeTruthy();
  expect(promptPre!.textContent).toBe(TOML_FIELDS.prompt);

  // The locating info (path + 详情 chip) stays. The raw TOML is reachable, but
  // not dumped into the structured view — it waits behind its own disclosure.
  expect(container.textContent).toContain("详情");
  expect(container.textContent).toContain("api-docs.toml");
  expect(container.textContent).toContain("原始 TOML");
  expect(container.textContent).not.toContain("# Command:");
  expect(container.textContent).not.toContain("# Description:");
  expect(container.textContent).not.toContain('description = "在apipost创建api文档"');
  expect(container.textContent).not.toContain('prompt = """');
});

it("reveals the raw TOML behind the disclosure, with a labelled copy button", async () => {
  stateReply([TOML_CMD], [], []);
  clickTitle("详情");
  contentReply(TOML_CMD.path, RAW_TOML, "hash-toml", TOML_FIELDS);

  // The disclosure trigger is a real button carrying aria-expanded.
  const trigger = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "原始 TOML",
  );
  expect(trigger).toBeTruthy();
  expect(trigger!.getAttribute("aria-expanded")).toBe("false");

  // The copy affordance is an icon button → it needs an accessible name
  // (aria-label === tooltip wording).
  const copy = container.querySelector("button[aria-label='复制原始 TOML']");
  expect(copy).toBeTruthy();
  expect(copy!.getAttribute("title")).toBe("复制原始 TOML");

  // Expanding shows the original file — comments and unknown keys included.
  await act(async () => {
    trigger!.click();
  });
  expect(trigger!.getAttribute("aria-expanded")).toBe("true");
  const rawPre = [...container.querySelectorAll("pre")].find((p) => p.getAttribute("title") === "原始 TOML");
  expect(rawPre).toBeTruthy();
  expect(rawPre!.textContent).toContain("# Command: api-docs");
  expect(rawPre!.textContent).toContain("# Description: 在apipost创建api文档");
  expect(rawPre!.textContent).toContain('description = "在apipost创建api文档"');
  expect(rawPre!.textContent).toContain('prompt = """');
  // A long file scrolls inside the panel instead of blowing the layout up.
  expect(rawPre!.className).toContain("overflow-auto");
  expect(rawPre!.className).toContain("max-h-");
});

it("copies the raw TOML and reports a refused clipboard honestly", async () => {
  stateReply([TOML_CMD], [], []);
  clickTitle("详情");
  contentReply(TOML_CMD.path, RAW_TOML, "hash-toml", TOML_FIELDS);

  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

  const copy = container.querySelector("button[aria-label='复制原始 TOML']")!;
  await act(async () => {
    copy.click();
  });
  // A denied clipboard must not look like a success: the label stays and one
  // error toast is raised.
  expect(container.querySelector("button[aria-label='复制原始 TOML']")).toBeTruthy();
  expect(notify).toHaveBeenCalledWith("复制失败", "error");

  // A granted clipboard flips the icon to a check mark.
  writeText.mockResolvedValue(undefined);
  await act(async () => {
    copy.click();
  });
  expect(container.querySelector("button[aria-label='已复制']")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(RAW_TOML);
});

it("keeps the full raw TOML in edit mode after a structured detail (edit round trip)", () => {
  stateReply([TOML_CMD], [], []);
  clickTitle("详情");
  contentReply(TOML_CMD.path, RAW_TOML, "hash-toml", TOML_FIELDS);
  click("编辑");
  const textarea = container.querySelector("textarea")!;
  // Editing still targets the raw file — the CLI's zod check on `prompt`
  // would break if the structurer dropped any field.
  expect(textarea.value).toBe(RAW_TOML);
  input(textarea, RAW_TOML + "# touched\n");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveAsset");
  expect(call.content).toContain('prompt = """');
  expect(call.content).toContain("# touched");
  savedReply(1, {}, TOML_CMD.path);
  expect(container.textContent).toContain("已保存");
});

it("falls back to the raw body with a Hint when the host sends no fields", () => {
  stateReply([TOML_CMD], [], []);
  clickTitle("详情");
  contentReply(TOML_CMD.path, RAW_TOML, "hash-toml");
  expect(container.textContent).toContain("无法提取结构化字段，显示原始文件内容");
  expect(container.textContent).toContain("# Command: api-docs");
  expect(container.textContent).toContain('prompt = """');
  expect(
    [...container.querySelectorAll("pre")].some((p) => p.textContent?.includes("# Command:")),
  ).toBe(true);
});

it("refuses a save whose expected hash drifted on disk (conflict, nothing written)", () => {
  stateReply([CMD], [], []);
  clickTitle("编辑");
  contentReply(CMD.path, "draft", "stale-hash");
  click("保存");
  savedReply(1, { conflict: true, ok: false });
      expect(container.textContent).toContain("文件已经在磁盘上被改过，请刷新后再编辑");  expect(container.textContent).not.toContain("已保存");
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
      expect(container.textContent).toContain("名称只能用字母");});

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
      expect(container.textContent).toContain("读取中…");  expect(send.mock.calls.filter(([m]) => m.type === "listAssets")).toHaveLength(2);
});

it("新建与刷新并为一行（同一行动作容器，只留一条收尾分隔线）", () => {
  stateReply([CMD], [], []);
  const create = [...container.querySelectorAll("button")].find((b) => b.textContent === "新建");
  const refresh = [...container.querySelectorAll("button")].find((b) => b.textContent === "刷新");
  expect(create, "新建 button").toBeTruthy();
  expect(refresh, "刷新 button").toBeTruthy();
  // 关键回归：两个动作在同一个行容器里（此前是 ToolbarRow + SecondaryRow 两行）。
  expect(create!.parentElement).toBe(refresh!.parentElement);
  const row = create!.parentElement as HTMLElement;
  expect(row.className).toContain("flex-wrap");
  expect(row.className).toContain("items-center");
  expect(row.className).toContain("border-b");
  // 合并后只剩一条收尾分隔线（原两行各有一条，视觉上像两段工具条）。
  const dividers = [...container.querySelectorAll<HTMLElement>("div")].filter(
    (node) => node.className.includes("border-b") && node.className.includes("border-border/50"),
  );
  expect(dividers).toHaveLength(1);
  // 语义分层保留：主操作是描边次级按钮，便利动作是无边框 ghost。
  expect(create!.className).toContain("border-border");
  expect(refresh!.className).not.toContain("border-border");
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
