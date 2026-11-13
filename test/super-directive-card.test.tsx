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
import { AssistantText, SuperDirectiveCard, ThoughtText } from "../webview/src/components/SuperDirectiveCard";

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

function renderThought(text: string): void {
  act(() => root.render(<ThoughtText text={text} />));
}

function renderSegment(segment: DirectiveSegment): void {
  act(() => root.render(<SuperDirectiveCard segment={segment} />));
}

/** 造一个只含任务书的委派协议块。 */
function delegate(tasks: Array<{ title: string; task: string; attachments: string[] }>): string {
  return ["```super-agent", JSON.stringify({ tasks }, null, 2), "```"].join("\n");
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

  // 实测形态（用户截图 2026-11-12）：模型把委派写成工具调用式载荷而不是 markdown
  // 围栏。宿主照样派发，所以转录必须出卡片 —— 按代码块渲染就是一堵 JSON 墙。
  it("工具调用式载荷（DSML 包裹）渲染成任务卡，不留 JSON 墙与包裹残字", () => {
    render(
      [
        "我来拆分两件工作，分别交给两个子会话。",
        "",
        "<｜DSML｜tool-super-agent>",
        '{"tasks":[{"title":"编写模块A设计说明","task":"新建 docs/alpha.md"},{"title":"编写模块B设计说明","task":"新建 docs/beta.md"}]}',
        "</tool-super-agent>",
      ].join("\n"),
    );
    const cards = taskCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("编写模块A设计说明");
    expect(cards[1]!.textContent).toContain("编写模块B设计说明");
    expect(text()).toContain("我来拆分两件工作");
    // 裸 JSON 与包裹标记都不再出现在 DOM 里。
    expect(text()).not.toContain('"tasks"');
    expect(text()).not.toContain("tool-super-agent");
    expect(container.querySelector("pre code")).toBeNull();
  });

  it("「super-agent:」+ ```json 载荷渲染成任务卡，代码块与孤立收栏都消失", () => {
    render(
      [
        "现在派一个复核会话跑全量检查。",
        "super-agent:",
        "```json",
        '{"tasks":[{"title":"合并后全量复核","task":"跑全量检查、如实汇报真实输出"}]}',
        "```",
        "复核会话已开工。",
      ].join("\n"),
    );
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("合并后全量复核");
    expect(text()).toContain("现在派一个复核会话");
    expect(text()).toContain("复核会话已开工");
    expect(text()).not.toContain('"tasks"');
    expect(container.querySelector("pre code")).toBeNull();
  });

  // 用户实测截图 2026-11-12：模型把委派写成「散文 + 内联开栏 + 单行 JSON」——
  // 开栏粘在前一段散文后面（不在独占一行）。宿主照样派发（面板出现等待汇报的
  // pill），转录里必须出任务卡，不能是一整块 JSON 墙。
  it("内联开栏（粘在散文后面）+ 单行 JSON 渲染成任务卡，散文留在卡片前后", () => {
    render(
      [
        "我来分派两件事。```super-agent",
        '{"tasks":[{"title":"甲任务","task":"做甲"}]}',
        "```",
        "分派完成。",
      ].join("\n"),
    );
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("甲任务");
    expect(cards[0]!.textContent).toContain("做甲");
    // 卡片前后的散文都还在（既不被吞掉，也不被 JSON 墙淹没）。
    expect(text()).toContain("我来分派两件事");
    expect(text()).toContain("分派完成");
    // 裸 JSON 不进 DOM。
    expect(text()).not.toContain('"tasks"');
    expect(container.querySelector("pre code")).toBeNull();
  });

  // 同一形态后面还跟着一个正常围栏块时，内联载荷照样出卡（渲染侧的协议块扫描
  // 与派发侧同源：工具调用式载荷不会被后面的围栏块挤掉）。
  it("内联开栏载荷 + 后续独占围栏块：两个任务各出一张卡", () => {
    render(
      [
        "我来分派两件事。```super-agent",
        '{"tasks":[{"title":"甲任务","task":"做甲"}]}',
        "```",
        "再补一个：",
        "```super-agent",
        '{"tasks":[{"title":"乙任务","task":"做乙"}]}',
        "```",
      ].join("\n"),
    );
    const cards = taskCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("甲任务");
    expect(cards[1]!.textContent).toContain("乙任务");
    expect(text()).toContain("我来分派两件事");
    expect(text()).toContain("再补一个");
    expect(text()).not.toContain('"tasks"');
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

  // 用户截图 2026-11-12：任务书正文是一整段文字墙，(1)…(8) 挤在同一行里读不下去。
  // 卡片正文改成结构化排版后，这些用例钉住「墙」被拆成了什么。
  it("任务书正文里的行内 (1)(2)(3) 枚举被切成独立编号项", () => {
    render(
      delegate([
        {
          title: "枚举任务书",
          task: "目标说明。(1) 第一步做 A。(2) 第二步做 B。(3) 第三步做 C。",
          attachments: [],
        },
      ]),
    );
    const ordered = [...container.querySelectorAll('[data-testid="super-task-ordered"]')];
    expect(ordered).toHaveLength(3);
    expect(ordered[0]!.textContent).toContain("第一步做 A");
    expect(ordered[1]!.textContent).toContain("第二步做 B");
    expect(ordered[2]!.textContent).toContain("第三步做 C");
    // 序号徽标：1 / 2 / 3。
    const markers = [...container.querySelectorAll('[data-testid="super-task-ordered-marker"]')];
    expect(markers.map((marker) => marker.textContent)).toEqual(["1", "2", "3"]);
    // 枚举之前的前言仍是段落。
    const paragraphs = [...container.querySelectorAll('[data-testid="super-task-paragraph"]')];
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.textContent).toContain("目标说明");
  });

  it("任务书正文里的反引号片段与文件路径渲染成行内代码", () => {
    render(
      delegate([
        {
          title: "带代码的任务书",
          task: "先跑 `npm test`，再改 src/panel/panel.ts",
          attachments: [],
        },
      ]),
    );
    const codes = [...container.querySelectorAll("code.super-task-code")];
    expect(codes.map((code) => code.textContent)).toEqual([
      "npm test",
      "src/panel/panel.ts",
    ]);
    // 代码块（围栏）与行内代码是两种物种。
    expect(container.querySelector('[data-testid="super-task-code"]')).toBeNull();
  });

  it("任务书正文里的行首项目符号与编号渲染成列表项", () => {
    render(
      delegate([
        { title: "列表任务书", task: "- 甲项\n- 乙项\n1. 丙项", attachments: [] },
      ]),
    );
    const bullets = [...container.querySelectorAll('[data-testid="super-task-bullet"]')];
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.textContent).toContain("甲项");
    const ordered = [...container.querySelectorAll('[data-testid="super-task-ordered"]')];
    expect(ordered).toHaveLength(1);
    expect(ordered[0]!.textContent).toContain("丙项");
  });

  it("任务书里的 **加粗** 渲染成强调文本，DOM 里不留字面星号", () => {
    render(
      delegate([
        { title: "加粗任务", task: "**不要重复实现**，先把检查跑一遍", attachments: [] },
      ]),
    );
    const strong = container.querySelector('[data-testid="super-task-strong"]');
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe("不要重复实现");
    expect(strong!.className).toContain("font-medium");
    expect(text()).not.toContain("**");
    expect(text()).toContain("先把检查跑一遍");
  });

  it("独占一行的【小节】渲染成小节标题，行中【…】仍留在正文", () => {
    render(
      delegate([
        {
          title: "分节任务",
          task: "【前置检查（重要，先做）】\n先跑 npm test\n\n说明【重要】这一段",
          attachments: [],
        },
      ]),
    );
    const heading = container.querySelector('[data-testid="super-task-heading"]');
    expect(heading).toBeTruthy();
    expect(heading!.textContent).toBe("前置检查（重要，先做）");
    expect(heading!.className).toContain("text-ui-label");
    // 小节标题不再带方括号。
    expect(text()).not.toContain("【前置检查");
    // 行中的【…】仍是普通段落文字。
    const paragraphs = [...container.querySelectorAll('[data-testid="super-task-paragraph"]')];
    expect(paragraphs.some((p) => p.textContent?.includes("说明【重要】这一段"))).toBe(true);
  });

  it("代码块与长路径换行显示，不产生横向滚动容器", () => {
    render(
      delegate([
        {
          title: "长路径",
          task: "改 src/very/long/path/that/keeps/going/and/going/component-name.tsx\n\n```\nnpx vitest run test/super-task-text.test.ts\n```",
          attachments: [],
        },
      ]),
    );
    const pre = container.querySelector('[data-testid="super-task-code"]');
    expect(pre).toBeTruthy();
    expect(pre!.className).toContain("whitespace-pre-wrap");
    expect(pre!.className).not.toContain("overflow-x-auto");
    // 长路径保持等宽药丸，靠 super-task-code 的 overflow-wrap:anywhere 折行。
    const code = container.querySelector("code.super-task-code");
    expect(code).toBeTruthy();
    expect(code!.textContent).toContain("component-name.tsx");
  });

  it("折叠态按块截断（不切半句），展开后渲染全部块", () => {
    const item = "这是一条比较长的任务说明，用来把任务书正文撑过折叠预览的字符预算，确保折叠态真的会截断。";
    render(
      delegate([
        {
          title: "长任务书",
          task: Array.from({ length: 6 }, () => `- ${item}`).join("\n"),
          attachments: [],
        },
      ]),
    );
    const blocks = () => [...container.querySelectorAll('[data-testid="super-task-body"] > *')];
    // 折叠态只给前几块，每块都是完整的列表项（末块不被切半句）。
    expect(blocks().length).toBeLessThan(6);
    expect(blocks().length).toBeGreaterThan(0);
    expect(blocks()[blocks().length - 1]!.textContent).not.toContain("…");
    // 展开/收起只有一个通道：底部 ghost 按钮，文案带剩余字数，没有孤立的「…」行。
    expect(container.querySelector('[data-testid="super-task-more"]')).toBeNull();
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="展开任务说明"]');
    expect(expand).toBeTruthy();
    expect(expand!.textContent).toContain("展开全文");
    expect(expand!.textContent).toMatch(/还有 \d+ 字/);
    act(() => expand!.click());
    expect(blocks()).toHaveLength(6);
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="收起任务说明"]');
    expect(collapse).toBeTruthy();
    expect(collapse!.textContent).toBe("收起");
    // 收起后不再有「还有 N 字」的重复提示。
    expect(text()).not.toMatch(/还有 \d+ 字/);
  });
});

// 用户截图 2026-11-13：模型把委派块写进思考通道时，思考卡里是一堵带
// `super-agent` 语言标签的 JSON。思考正文必须与助手正文走同一套切分。
describe("ThoughtText 思考卡正文", () => {
  it("思考正文里的完整 super-agent 围栏渲染成任务卡，不再显示语言标签与裸 JSON", () => {
    renderThought(["先确认归属：", "", DELEGATE, "", "派发完成。"].join("\n"));
    const cards = taskCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("修复登录跳转");
    expect(cards[1]!.textContent).toContain("补文档");
    // 卡片前后的思考文字仍是 Markdown 段落。
    expect(text()).toContain("先确认归属");
    expect(text()).toContain("派发完成");
    // 没有代码块，也没有语言标签或裸载荷。
    expect(container.querySelector("pre code")).toBeNull();
    expect(container.querySelector(".code-lang")).toBeNull();
    expect(text()).not.toContain('"tasks"');
  });

  it("未闭合围栏（流式中间态）不出现卡片，仍是普通代码块", () => {
    const unclosed = [
      "思考中：",
      "",
      "```super-agent",
      '{"tasks": [{"title": "进行中的任务"',
    ].join("\n");
    renderThought(unclosed);
    expect(taskCards()).toHaveLength(0);
    const code = container.querySelector("pre code.language-super-agent");
    expect(code).toBeTruthy();
    expect(code!.textContent).toContain("进行中的任务");
    expect(text()).toContain("思考中");
  });
});