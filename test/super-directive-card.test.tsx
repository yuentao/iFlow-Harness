// @vitest-environment jsdom
/**
 * super-agent 协议块 → 转录卡片。
 *
 * 协议围栏（```super-agent / ```super-agent-actions）是给宿主读的指令，按
 * 普通 JSON 代码块渲染时是一堵难以阅读的 JSON 墙。这些用例钉住：
 *
 *  - 纯函数切分：普通文本段与协议段分开，未闭合围栏不切；
 *  - 委派卡：每个任务书渲染成**一张独立卡片**（标题 / 正文 / 附件 / 序号 chip），
 *    不再有「委派子会话 / N 个任务」那种汇总卡，也不再出现裸 JSON；
 *  - 容错提示：载荷没能完整解析时，拆出的任务书带一条诚实提示；
 *  - 操作卡：动作中文名 + 目标子会话 id；
 *  - 非法 JSON / 未知形状 / 未知语言：退化为「原始协议块」卡，不抛异常；
 *  - 未闭合围栏（流式中间态）：仍是普通代码块，不渲染半截卡片；
 *  - 混排：普通段落 / 列表 / 普通代码块照常走 Markdown。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitSuperDirectiveSegments } from "../shared/super-agent";
import { AssistantText, SuperDirectiveCard } from "../webview/src/components/SuperDirectiveCard";

const send = vi.hoisted(() => vi.fn());
const useChat = vi.hoisted(() =>
  Object.assign(
    (selector: (state: { send: typeof send }) => unknown) => selector({ send }),
    { getState: () => ({ send }) },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

const DELEGATE = [
  "```super-agent",
  JSON.stringify(
    {
      tasks: [
        { title: "修复登录跳转", task: "修好 src/auth.ts 的登录跳转并补单测", attachments: [{ path: "src/auth.ts" }] },
        { title: "补文档", task: "更新 README 的登录章节" },
      ],
    },
    null,
    2,
  ),
  "```",
].join("\n");

const DELEGATE_ONE = [
  "```super-agent",
  JSON.stringify(
    {
      tasks: [{ title: "独自开工", task: "只派一个子会话时也应该就是一张卡" }],
    },
    null,
    2,
  ),
  "```",
].join("\n");

const ACTIONS = [
  "```super-agent-actions",
  JSON.stringify(
    {
      actions: [
        { action: "retry", sessionId: "super-mwc6c04t-c3" },
        { action: "cleanup", sessionId: "super-mwc6c04t-c4", keepBranch: true },
        { action: "answer", sessionId: "super-mwc6c04t-c5", answers: { q1: "方案 A" } },
      ],
    },
    null,
    2,
  ),
  "```",
].join("\n");

/** 单条协议段的类型（组件的 props 类型不是导出的，用 Parameters 取）。 */
type DirectiveSegment = Parameters<typeof SuperDirectiveCard>[0]["segment"];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(text: string): void {
  act(() => root.render(<AssistantText text={text} />));
}

function renderSegment(segment: DirectiveSegment): void {
  act(() => root.render(<SuperDirectiveCard segment={segment} />));
}

function text(): string {
  return container.textContent ?? "";
}

/** 委派任务卡（每张任务书一张）。 */
function taskCards(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="super-task-card"]')];
}

describe("splitSuperDirectiveSegments", () => {
  it("没有协议围栏时只返回一个文本段", () => {
    expect(splitSuperDirectiveSegments("普通回复")).toEqual([{ kind: "text", text: "普通回复" }]);
  });

  it("把围栏前后的文本与协议段分开，并识别所有 super-agent-* 语言", () => {
    const segments = splitSuperDirectiveSegments(
      ["前置说明", DELEGATE, "中间", ACTIONS, "尾注"].join("\n"),
    );
    expect(segments.map((s) => s.kind)).toEqual([
      "text",
      "directive",
      "text",
      "directive",
      "text",
    ]);
    const languages = segments.flatMap((s) => (s.kind === "directive" ? [s.language] : []));
    const displays = segments.flatMap((s) => (s.kind === "directive" ? [s.display.kind] : []));
    expect(languages).toEqual(["super-agent", "super-agent-actions"]);
    expect(displays).toEqual(["tasks", "actions"]);
  });

  it("未闭合的围栏不切分（整段仍是文本）", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "甲", "task": "乙"}]'].join("\n");
    const segments = splitSuperDirectiveSegments(unclosed);
    expect(segments).toEqual([{ kind: "text", text: unclosed }]);
  });

  it("围栏不在行首（句子里的行内代码）不识别", () => {
    const segments = splitSuperDirectiveSegments("这里是 ```super-agent 说明");
    expect(segments).toEqual([{ kind: "text", text: "这里是 ```super-agent 说明" }]);
  });
});

describe("AssistantText 协议块卡片", () => {
  it("super-agent 围栏里的每个任务书渲染成一张独立卡片", () => {
    render(DELEGATE);
    const cards = taskCards();
    expect(cards).toHaveLength(2);

    // 每张卡只带自己那份任务书：标题 / 正文 / 附件各自独立。
    expect(cards[0]!.textContent).toContain("修复登录跳转");
    expect(cards[0]!.textContent).toContain("修好 src/auth.ts 的登录跳转并补单测");
    expect(cards[0]!.textContent).toContain("auth.ts");
    expect(cards[0]!.textContent).not.toContain("补文档");

    expect(cards[1]!.textContent).toContain("补文档");
    expect(cards[1]!.textContent).toContain("更新 README 的登录章节");
    expect(cards[1]!.textContent).not.toContain("修复登录跳转");

    // 序号 chip 表达批次内的次序。
    expect(cards[0]!.textContent).toContain("第 1/2 个任务");
    expect(cards[1]!.textContent).toContain("第 2/2 个任务");

    // 不再有「委派子会话 / N 个任务」那种汇总卡：只有每张卡自己的序号 chip。
    const body = text();
    expect(body).not.toContain("委派子会话");
    expect(body.match(/第 \d+\/\d+ 个任务/g)).toEqual(["第 1/2 个任务", "第 2/2 个任务"]);
    // 原始载荷不再进 DOM。
    expect(body).not.toContain('"tasks"');
  });

  it("只有一个任务书时就是一张卡，不出现多余的序号层级", () => {
    render(DELEGATE_ONE);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("独自开工");
    expect(cards[0]!.textContent).toContain("只派一个子会话时也应该就是一张卡");
    // 单卡没有批次信息，不显示「第 1/1 个任务」。
    expect(text()).not.toMatch(/第 \d+\/\d+ 个任务/);
  });

  it("容错拆出的任务书带一条诚实提示（可能尚未派发）", () => {
    renderSegment({
      kind: "directive",
      language: "super-agent",
      raw: "```super-agent\n{坏掉的载荷\n```",
      // shared 侧给 tasks 变体加的容错标记（可选字段）：这里直接构造，
      // 不依赖 shared 的解析路径。
      display: {
        kind: "tasks",
        tasks: [{ title: "容错拆出的任务", task: "正文", attachments: [] }],
        salvaged: true,
      },
    } as unknown as DirectiveSegment);

    const notice = container.querySelector('[data-testid="super-task-salvaged"]');
    expect(notice).toBeTruthy();
    expect(notice!.textContent).toContain("载荷未能完整解析");
    expect(notice!.textContent).toContain("可能尚未派发");
    // 提示之外，任务书照常展示（用户至少能读到模型想干什么）。
    expect(taskCards()).toHaveLength(1);
    expect(taskCards()[0]!.textContent).toContain("容错拆出的任务");
  });

  it("正常派发的任务书没有容错提示", () => {
    render(DELEGATE);
    expect(container.querySelector('[data-testid="super-task-salvaged"]')).toBeNull();
  });

  it("super-agent-actions 围栏渲染成操作卡：动作中文名 + 目标子会话 id", () => {
    render(ACTIONS);
    const body = text();
    expect(body).toContain("子会话操作");
    expect(body).toContain("3 个动作");
    expect(body).toContain("重试");
    expect(body).toContain("清理");
    expect(body).toContain("回答");
    expect(body).toContain("super-mwc6c04t-c3");
    expect(body).toContain("保留分支");
    expect(body).toContain("1 个回答");
    expect(body).not.toContain('"actions"');
    // 动作卡仍是一张卡多行，不跟着任务书拆。
    expect(taskCards()).toHaveLength(0);
  });

  it("非法 JSON 退化为原始协议块卡（带原因，不抛异常）", () => {
    const invalid = ["```super-agent", '{"tasks": [oops]}', "```"].join("\n");
    expect(() => render(invalid)).not.toThrow();
    const body = text();
    expect(body).toContain("原始协议块");
    expect(body).toContain("内容不是合法 JSON");
    expect(body).not.toContain("委派子会话");
    expect(taskCards()).toHaveLength(0);
  });

  it("JSON 合法但形状不符同样退化", () => {
    render(["```super-agent-actions", '{"foo": 1}', "```"].join("\n"));
    expect(text()).toContain("原始协议块");
    expect(text()).toContain("缺少 actions 数组");
  });

  it("未知的 super-agent-* 语言退化为原始协议块卡，显示语言与长度", () => {
    const unknown = ["```super-agent-whatever", '{"x": 1}', "```"].join("\n");
    render(unknown);
    const body = text();
    expect(body).toContain("原始协议块");
    expect(body).toContain("未知的协议块语言");
    expect(body).toContain("super-agent-whatever");
    expect(body).toMatch(/字符/);
  });

  it("未闭合围栏（流式中间态）保持普通代码块，不出现卡片", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "进行中的任务"'].join("\n");
    expect(() => render(unclosed)).not.toThrow();
    expect(text()).not.toContain("委派子会话");
    expect(taskCards()).toHaveLength(0);
    const code = container.querySelector("pre code");
    expect(code).toBeTruthy();
    expect(code!.className).toContain("language-super-agent");
    expect(code!.textContent).toContain("进行中的任务");
  });

  it("普通段落 / 列表 / 普通代码块与协议卡共存，Markdown 不丢", () => {
    const mixed = [
      "开始处理：",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      DELEGATE,
      "",
      "收尾。",
    ].join("\n");
    render(mixed);
    const body = text();
    // 段落 / 列表 / 普通代码块
    expect(body).toContain("开始处理：");
    expect(body).toContain("第一项");
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
    const jsCode = container.querySelector("pre code.language-js");
    expect(jsCode).toBeTruthy();
    expect(jsCode!.textContent).toContain("const a = 1;");
    // 协议卡与尾注
    expect(body).toContain("修复登录跳转");
    expect(body).toContain("收尾。");
  });
});