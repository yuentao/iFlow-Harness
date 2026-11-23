// @vitest-environment jsdom
/**
 * super-agent 协议块 → 转录卡片。
 *
 * 协议围栏（```super-agent / ```super-agent-actions）是给宿主读的指令，按
 * 普通 JSON 代码块渲染时是一堵难以阅读的 JSON 墙。这些用例钉住：
 *
 *  - 纯函数切分：普通文本段与协议段分开，未闭合围栏切出 pending 段；
 *  - 委派卡：每个任务书渲染成**一张独立卡片**（标题 / 正文 / 附件 / 序号 chip），
 *    不再有「委派子会话 / N 个任务」那种汇总卡，也不再出现裸 JSON；
 *  - 容错提示：载荷没能完整解析时，拆出的任务书带一条诚实提示；
 *  - 操作卡：动作中文名 + 目标子会话 id；
 *  - 非法 JSON / 未知形状 / 未知语言：退化为「原始协议块」卡，不抛异常；
 *  - 未闭合围栏（流式中间态）：「正在编写任务书…」占位卡（不展示载荷、不宣称已派发，
 *    也不渲染半截卡片或原始 JSON 代码块）；
 *  - 混排：普通段落 / 列表 / 普通代码块照常走 Markdown。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitSuperDirectiveSegments } from "../shared/super-agent";
import { AssistantText, SuperActionsToolCallCard, SuperDirectiveCard, ThoughtText } from "../webview/src/components/SuperDirectiveCard";
import type { ToolBlock } from "../shared/messages";

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
      tasks: [{ title: "独自开工", task: "只派一个超流体时也应该就是一张卡" }],
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

/**
 * 用户实测截图 2026-11-13 的真实形态：散文 + 独占行围栏 + **单行压缩超长
 * JSON**（任务书里带换行转义、中文、反斜杠路径、反引号、花括号、ASCII 双引号）
 * + 独占行收栏。宿主已派发（看板 running），转录却是一堵带 `super-agent`
 * 语言标签的 JSON 墙。JSON.stringify 不带缩进 → 载荷只有一行，与截图一致。
 * 原文取自 ~/.iflow/acp/sessions 那一轮 assistant 文本（6111 字符，单任务书）。
 */
const REAL_ONE_LINE_TASK = [
  "项目：j:\\git\\iflow-harness（VSCode 扩展，TypeScript strict + React 19 + Tailwind 4 + vitest 5；Super Agent 多超流体看板）。你负责实现并自验下面这个完整需求。",
  "【背景：看板与数据】节点文本被截断，`status/title/aria-label` 要一起改。",
  "1. 数切：`webview/src/components/SuperAgentBoard.tsx:251` 的 SuperTimeline 编排为 `flex min-w-0 max-w-[50%] shrink items-center gap-1 overflow-hidden`，内容是 `shrink-0 items-center gap-1`。",
  "2. 数据：`src/acp/protocol.ts:312` 已有 `{ sessionStatus: 'plan'; entries: PlanEntry[] }`，L316 `PlanEntry { priority: 'high'|'medium'|'low'; status: 'pending'|'in_progress'|'completed' }`。",
  "3. 引号与花括号：确认「双引号 \" 与 { PlanEntry }」，路径 j:\\git\\iflow-harness\\a\\b.tsx，跑 `npx vitest run test/super-timeline.test.ts`。",
  "4. **不要重复实现**，先把检查跑一遍，如实贴真实输出；`rawInput.tools` 的注释要保留。",
].join("\n");

const REAL_ONE_LINE_DELEGATE = [
  "已确认走「只用 todo 节点」方案。派一个超流体完成整条链路（数据捕获 → 纯逻辑 → 看板渲染），避免并行改动同一批类型文件时互相看不到。",
  "",
  "```super-agent",
  JSON.stringify({ tasks: [{ title: "时间轴改用超流体 todo", task: REAL_ONE_LINE_TASK }] }),
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

  it("未闭合围栏切出 pending 段：开栏行与半截载荷都不进文本段", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "甲", "task": "乙"}]'].join("\n");
    const segments = splitSuperDirectiveSegments(unclosed);
    expect(segments).toEqual([{ kind: "pending", language: "super-agent" }]);
  });

  it("未闭合围栏 + 已写出部分 JSON：前缀是文本段，之后是 pending 段，没有尾随文本", () => {
    const unclosed = [
      "我先拆两件事。",
      "```super-agent",
      '{"tasks": [{"title": "甲", "task": "乙"',
    ].join("\n");
    const segments = splitSuperDirectiveSegments(unclosed);
    expect(segments).toEqual([
      { kind: "text", text: "我先拆两件事。\n" },
      { kind: "pending", language: "super-agent" },
    ]);
    // pending 之后不再有任何文本段（半截载荷绝不回流给 Markdown）。
    expect(segments[segments.length - 1]?.kind).toBe("pending");
  });

  it("收栏后同一段文本不再有 pending 段，改切出任务卡", () => {
    const unclosed = [
      "我先拆两件事。",
      "```super-agent",
      '{"tasks": [{"title": "甲", "task": "乙"',
    ].join("\n");
    expect(splitSuperDirectiveSegments(unclosed).map((segment) => segment.kind)).toEqual([
      "text",
      "pending",
    ]);

    const closed = `${unclosed}]}\n\`\`\``;
    const segments = splitSuperDirectiveSegments(closed);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "directive"]);
    const directive = segments[1];
    expect(directive?.kind === "directive" ? directive.display.kind : undefined).toBe("tasks");
    expect(directive?.kind === "directive" ? directive.raw : "").toContain('"tasks"');
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
    expect(body).not.toContain("委派超流体");
    expect(body.match(/第 \d+\/\d+ 个任务/g)).toEqual(["第 1/2 个任务", "第 2/2 个任务"]);
    // 原始载荷不再进 DOM。
    expect(body).not.toContain('"tasks"');
  });

  it("只有一个任务书时就是一张卡，不出现多余的序号层级", () => {
    render(DELEGATE_ONE);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("独自开工");
    expect(cards[0]!.textContent).toContain("只派一个超流体时也应该就是一张卡");
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
    expect(notice!.textContent).toContain("这段内容没能完整读取");
    expect(notice!.textContent).toContain("可能还没有真正派出去");
    // 提示之外，任务书照常展示（用户至少能读到模型想干什么）。
    expect(taskCards()).toHaveLength(1);
    expect(taskCards()[0]!.textContent).toContain("容错拆出的任务");
  });

  it("正常派发的任务书没有容错提示", () => {
    render(DELEGATE);
    expect(container.querySelector('[data-testid="super-task-salvaged"]')).toBeNull();
  });

  it("super-agent-actions 围栏渲染成操作卡：动作中文名 + 序号（不暴露内部 id）", () => {
    render(ACTIONS);
    const body = text();
    expect(body).toContain("超流体操作");
    expect(body).toContain("3 个动作");
    expect(body).toContain("重试");
    expect(body).toContain("清理");
    expect(body).toContain("回答");
    // 内部 sessionId 不上卡面：没有标题时按本卡内序号显示。
    expect(body).not.toContain("super-mwc6c04t-c3");
    expect(body).not.toContain("super-mwc6c04t-c4");
    expect(body).not.toContain("super-mwc6c04t-c5");
    expect(body).toContain("第 1 个");
    expect(body).toContain("第 2 个");
    expect(body).toContain("第 3 个");
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
    expect(body).toContain("原始指令内容");
    expect(body).toContain("内容格式不对，读不出来");
    expect(body).not.toContain("委派超流体");
    expect(taskCards()).toHaveLength(0);
  });

  it("JSON 合法但形状不符同样退化", () => {
    render(["```super-agent-actions", '{"foo": 1}', "```"].join("\n"));
    expect(text()).toContain("原始指令内容");
    expect(text()).toContain("里面没有操作列表");
  });

  it("未知的 super-agent-* 语言退化为原始协议块卡，显示语言与长度", () => {
    const unknown = ["```super-agent-whatever", '{"x": 1}', "```"].join("\n");
    render(unknown);
    const body = text();
    expect(body).toContain("原始指令内容");
    expect(body).toContain("认不出这是什么指令");
    expect(body).toContain("super-agent-whatever");
    expect(body).toMatch(/字符/);
  });

  it("未闭合围栏（流式中间态）渲染「正在编写任务书…」占位卡，不再是代码块", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "进行中的任务"'].join("\n");
    expect(() => render(unclosed)).not.toThrow();
    expect(text()).not.toContain("委派超流体");
    expect(taskCards()).toHaveLength(0);
    // 进行中 ≠ 已派发：只有占位卡，没有任何任务卡。
    expect(container.querySelector('[data-testid="super-directive-pending"]')).toBeTruthy();
    expect(text()).toContain("正在编写任务书…");
    // 占位卡只说「正在编写任务书…」：beta 提交 5a687c3「移除冗余文本」把
    // PendingDirectiveCard 里的「收栏后派发」提示与对应 i18n 键一起下线了
    // （UI 意图：不重复解释宿主何时派发），此处随之改为负向断言。
    expect(text()).not.toContain("收栏后派发");
    // 半截载荷绝不交回 Markdown：没有代码块，也不出现原始 JSON。
    expect(container.querySelector("pre code")).toBeNull();
    expect(text()).not.toContain('"tasks"');
    expect(text()).not.toContain('"title"');
    expect(text()).not.toContain("进行中的任务");
  });

  it("围栏前有正常散文时，散文仍渲染成 Markdown（不被吞掉）", () => {
    render(
      [
        "先看这段说明：",
        "",
        "**重点**在下面。",
        "",
        "```super-agent",
        '{"tasks": [{"title": "进行中的任务"',
      ].join("\n"),
    );
    expect(text()).toContain("先看这段说明");
    // 文本段仍走完整 Markdown 链路（强调样式生效，不是字面星号）。
    expect(container.querySelector("strong")?.textContent).toBe("重点");
    expect(text()).not.toContain("**");
    // 占位卡照常出现，载荷不进 DOM。
    expect(container.querySelector('[data-testid="super-directive-pending"]')).toBeTruthy();
    expect(text()).not.toContain("进行中的任务");
  });

  // 实测形态（用户截图 2026-11-12）：模型把委派写成工具调用式载荷而不是 markdown
  // 围栏。宿主照样派发，所以转录必须出卡片 —— 按代码块渲染就是一堵 JSON 墙。
  it("工具调用式载荷（DSML 包裹）渲染成任务卡，不留 JSON 墙与包裹残字", () => {
    render(
      [
        "我来拆分两件工作，分别交给两个超流体。",
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

  // 用户实测截图 2026-11-13：主会话把任务书写成「散文 + 独占行围栏 + 单行
  // 压缩超长 JSON + 独占行收栏」，宿主已派发（看板 running），转录却是一堵带
  // `super-agent` 语言标签的 JSON 墙。钉住「已派发的块必须每任务一张卡片」。
  it("真实形态：散文 + 独占行围栏 + 单行压缩超长 JSON 每任务一张卡片，DOM 无裸 JSON", () => {
    expect(splitSuperDirectiveSegments(REAL_ONE_LINE_DELEGATE).map((s) => s.kind)).toEqual([
      "text",
      "directive",
    ]);
    render(REAL_ONE_LINE_DELEGATE);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("时间轴改用超流体 todo");
    // 折叠态只给前几块（按设计），但绝不能是 JSON 墙：正文已按块排版。
    expect(cards[0]!.textContent).toContain("项目：j:\\git\\iflow-harness");
    expect(text()).toContain("已确认走「只用 todo 节点」方案");
    expect(text()).not.toContain('"tasks"');
    expect(text()).not.toContain('"title"');
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
    // 展开后整份任务书都可读（单行压缩载荷被还原成结构化正文，不是一堵 JSON）。
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="展开任务说明"]');
    expect(expand).toBeTruthy();
    act(() => expand!.click());
    expect(text()).toContain("SuperTimeline");
    expect(text()).toContain("npx vitest run test/super-timeline.test.ts");
    expect(text()).not.toContain('"tasks"');
  });

  // CommonMark 允许围栏行带最多 3 个空格缩进；Markdown 组件照常渲染成带
  // `super-agent` 语言标签的代码块。切分器旧实现只认「零缩进行首」，于是判
  // unclosed → 整段退回 Markdown → 又是一堵 JSON 墙（用户截图的观感）。
  it("收栏带 2 空格缩进（CommonMark 合法围栏）仍出任务卡，不留 JSON 墙", () => {
    const indented = REAL_ONE_LINE_DELEGATE.replace(/\n```$/, "\n  ```");
    expect(splitSuperDirectiveSegments(indented).map((s) => s.kind)).toContain("directive");
    render(indented);
    expect(taskCards()).toHaveLength(1);
    expect(taskCards()[0]!.textContent).toContain("时间轴改用超流体 todo");
    expect(text()).not.toContain('"tasks"');
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
  });

  it("开栏与收栏都带 2 空格缩进时同样出任务卡", () => {
    const indented = REAL_ONE_LINE_DELEGATE.replace("\n```super-agent\n", "\n  ```super-agent\n").replace(
      /\n```$/,
      "\n  ```",
    );
    render(indented);
    expect(taskCards()).toHaveLength(1);
    expect(taskCards()[0]!.textContent).toContain("时间轴改用超流体 todo");
    expect(text()).not.toContain('"tasks"');
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
  });

  it("缩进围栏但载荷未收全：渲染编写中占位卡，不伪造已派发", () => {
    const unclosed = ["  ```super-agent", '{"tasks": [{"title": "进行中的任务"'].join("\n");
    render(unclosed);
    expect(taskCards()).toHaveLength(0);
    expect(container.querySelector('[data-testid="super-directive-pending"]')).toBeTruthy();
    // 半截载荷既不是代码块，也不进 DOM。
    expect(container.querySelector("pre code")).toBeNull();
    expect(text()).not.toContain("进行中的任务");
    expect(container.querySelector('[data-testid="super-task-salvaged"]')).toBeNull();
  });

  // marked 实测（2026-11-13）：下面这些围栏写法都会被渲染成 language-super-agent
  // 代码块。宿主派发了它们，转录就必须出卡片；旧切分器只认「零缩进 + ``` + 语言
  // 紧贴」，其余形态判未闭合 → 整段退回 Markdown → 又一堵 JSON 墙。
  it.each([
    ["收栏带 2 空格缩进", "```super-agent", "  ```"],
    ["开闭都带 3 空格缩进", "   ```super-agent", "   ```"],
    ["反引号后带空格", "``` super-agent", "```"],
    ["波浪线围栏", "~~~super-agent", "~~~"],
    ["info string 带附加词", "```super-agent json", "```"],
    ["四个反引号", "````super-agent", "````"],
    ["大写语言名", "```Super-Agent", "```"],
  ])("%s 仍出任务卡、不留 JSON 墙", (_name, open, close) => {
    const source = [
      "先说明一下。",
      "",
      open,
      '{"tasks":[{"title":"变体任务","task":"变体正文"}]}',
      close,
    ].join("\n");
    render(source);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("变体任务");
    expect(cards[0]!.textContent).toContain("变体正文");
    expect(container.querySelector("pre code")).toBeNull();
    expect(text()).not.toContain('"tasks"');
    expect(text()).toContain("先说明一下。");
  });

  // 真实语料（~/.iflow/acp/sessions，2026-11-13）里的收栏形态：收栏行后面还有
  // 内容 —— CLI 历史里的 ` ```</arg_value:6124c78e>`，以及模型在收栏同行续写的
  // 散文。marked 不认这种收栏（CommonMark 要求收栏行后只剩空白），于是代码块
  // 一路吞到文本末尾：用户看到的正是那堵 JSON 墙，而宿主其实已经派发。
  it.each([
    ["收栏同行带 CLI 历史标记", "```super-agent", "```</arg_value:6124c78e>"],
    ["收栏同行带散文", "```super-agent", "``` 我在这一轮结束？"],
    ["收栏比开栏短（~~~ 开 / ~~ 收）", "~~~super-agent", "~~"],
    ["收栏比开栏短（```` 开 / ``` 收）", "````super-agent", "```"],
  ])("%s 仍出任务卡、不留 JSON 墙", (_name, open, closeLine) => {
    const source = [
      "派一个超流体。",
      "",
      open,
      '{"tasks":[{"title":"尾巴收栏任务","task":"收栏行后面还有内容"}]}',
      closeLine,
    ].join("\n");
    const segments = splitSuperDirectiveSegments(source);
    // 收栏行后面的尾巴不属于协议块：有尾巴时它作为块之后的文本段留在转录里（不丢内容）。
    expect(segments[0]?.kind).toBe("text");
    expect(segments[1]?.kind).toBe("directive");
    if (segments.length > 2) expect(segments[2]?.kind).toBe("text");
    render(source);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("尾巴收栏任务");
    expect(cards[0]!.textContent).toContain("收栏行后面还有内容");
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
    expect(text()).not.toContain('"tasks"');
    expect(text()).toContain("派一个超流体。");
  });

  it("收栏同行带尾巴时，尾巴留在卡片之后的文本段里", () => {
    const source = [
      "```super-agent",
      '{"tasks":[{"title":"带尾巴的任务","task":"正文"}]}',
      "``` 我在这一轮结束。",
    ].join("\n");
    render(source);
    expect(taskCards()).toHaveLength(1);
    expect(text()).toContain("我在这一轮结束。");
    // 尾巴不能混进卡片正文。
    expect(taskCards()[0]!.textContent).not.toContain("我在这一轮结束");
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
  });

  // 收栏是宽容认的，正文必须仍只取 JSON 本身；夹在载荷与收栏之间的散文不能随
  // 收栏一起被消费掉（它得留在转录里），也不能混进卡片正文。
  it("JSON 收尾与收栏之间夹散文时，卡片正文只有任务书，散文不丢", () => {
    const source = [
      "```super-agent",
      '{"tasks":[{"title":"夹散文的任务","task":"正文"}]}',
      "",
      "这段是模型写在载荷后面的散文。",
      "```",
      "",
      "收栏之后的正文。",
    ].join("\n");
    render(source);
    const cards = taskCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("夹散文的任务");
    expect(cards[0]!.textContent).not.toContain("这段是模型写在载荷后面的散文");
    expect(text()).toContain("这段是模型写在载荷后面的散文");
    expect(text()).toContain("收栏之后的正文。");
    // 载荷本身绝不以 JSON 形式出现。
    expect(text()).not.toContain('"tasks"');
    expect(container.querySelector("pre code.language-super-agent")).toBeNull();
  });

  it("载荷未收全时，带尾巴的收栏也不伪造已派发", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "进行中的任务"', "``` 尾巴"].join("\n");
    expect(splitSuperDirectiveSegments(unclosed)).toEqual([
      { kind: "pending", language: "super-agent" },
    ]);
    render(unclosed);
    expect(taskCards()).toHaveLength(0);
    expect(container.querySelector('[data-testid="super-directive-pending"]')).toBeTruthy();
    expect(text()).not.toContain("进行中的任务");
    expect(container.querySelector('[data-testid="super-task-salvaged"]')).toBeNull();
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

// 用户要求 2026-11-13：思考过程中不渲染委派卡。思考通道是模型的内部独白，
// 宿主也不会派发写在里面的围栏 —— 思考正文按普通 Markdown 渲染，委派围栏只是
// 一段带语言标签的代码块，不出现任务卡，也不显示任何派发语义。
describe("ThoughtText 思考卡正文", () => {
  it("思考正文里的 super-agent 围栏按普通代码块渲染，不出现任务卡与派发语义", () => {
    renderThought(["先确认归属：", "", DELEGATE, "", "派发完成。"].join("\n"));
    // 不出现任何任务卡、批次序号 chip 或容错提示。
    expect(taskCards()).toHaveLength(0);
    expect(container.querySelector('[data-testid="super-task-salvaged"]')).toBeNull();
    expect(text()).not.toMatch(/第 \d+\/\d+ 个任务/);
    expect(text()).not.toContain("委派超流体");
    expect(text()).not.toContain("超流体操作");
    // 围栏就是普通代码块：语言标签与原始载荷都在，不再被投影成卡片。
    const code = container.querySelector("pre code.language-super-agent");
    expect(code).toBeTruthy();
    expect(code!.textContent).toContain('"tasks"');
    expect(code!.textContent).toContain("修复登录跳转");
    // 卡片前后的思考文字仍是 Markdown 段落。
    expect(text()).toContain("先确认归属");
    expect(text()).toContain("派发完成");
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

/**
 * 委派卡独立表面（2026-11-15）：内置 `super-agent` 工具上线后，委派卡与
 * 「工具操作卡」ToolCard（`bg-card + border-border + shadow-card`、单行头部）
 * 常并排出现在转录里。这里钉住委派家族的专属材质，防止有人再把它改回通用
 * 卡材质 —— 两种卡读起来一模一样正是本次要修的反馈。
 */
describe("委派卡独立表面（与工具操作卡区分）", () => {
  const TOOL_CARD_CLASSES = ["bg-card", "shadow-card", "tool-card", "border-border/60"];

  it("任务书卡：淡主色底 + 主色描边 + 强调条 + eyebrow + 高一级标题，不带工具卡材质", () => {
    render(DELEGATE);
    const card = taskCards()[0]!;
    expect(card.classList.contains("super-directive-card")).toBe(true);
    expect(card.className).toContain("bg-primary/10");
    expect(card.className).toContain("border-primary/35");
    expect(card.className).toContain("shadow-float");
    for (const cls of TOOL_CARD_CLASSES) {
      expect(card.classList.contains(cls)).toBe(false);
    }
    // 顶部主色强调条：工具卡没有这一层。
    expect(card.firstElementChild!.className).toContain("bg-primary/60");
    // 两行头部：eyebrow 家族标签 + 16px 任务标题（工具卡 label 是 13px）。
    expect(card.textContent).toContain("委派指令");
    const title = [...card.querySelectorAll("span")].find(
      (span) => span.textContent === "修复登录跳转",
    );
    expect(title).toBeTruthy();
    expect(title!.className).toContain("text-ui-title");
    // 独立图标徽章（Users），不是工具卡的裸 `.tool-icon`。
    const badge = card.querySelector<HTMLElement>('[class*="border-primary/30"]');
    expect(badge).toBeTruthy();
    expect(badge!.querySelector("svg")).toBeTruthy();
  });

  it("窄屏先收缩标题：序号 chip 外套 shrink-0，标题列可收缩换行", () => {
    render(DELEGATE);
    const head = taskCards()[0]!.children[1] as HTMLElement;
    expect(head.className).toContain("flex");
    const titleColumn = head.children[1] as HTMLElement;
    expect(titleColumn.className).toContain("min-w-0");
    const chipSlot = head.lastElementChild as HTMLElement;
    expect(chipSlot.className).toContain("shrink-0");
    expect(chipSlot.querySelector(".chip-fade")?.className).toContain("shrink-0");
    expect(chipSlot.textContent).toContain("第 1/2 个任务");
  });

  it("单任务卡没有序号 chip，独立表面照常存在", () => {
    render(DELEGATE_ONE);
    const card = taskCards()[0]!;
    expect(card.classList.contains("super-directive-card")).toBe(true);
    expect(card.className).toContain("bg-primary/10");
    expect(text()).not.toMatch(/第 \d+\/\d+ 个任务/);
  });

  it("进行中占位卡同样独立，但徽章与 eyebrow 保持中性，文案不丢", () => {
    const unclosed = ["```super-agent", '{"tasks": [{"title": "进行中的任务"'].join("\n");
    render(unclosed);
    const pending = container.querySelector<HTMLElement>(
      '[data-testid="super-directive-pending"]',
    )!;
    expect(pending.classList.contains("super-directive-card")).toBe(true);
    expect(pending.className).toContain("bg-primary/10");
    for (const cls of TOOL_CARD_CLASSES) expect(pending.classList.contains(cls)).toBe(false);
    expect(pending.getAttribute("role")).toBe("status");
    expect(pending.textContent).toContain("正在编写任务书…");
    expect(pending.textContent).toContain("委派指令");
    // 中性徽章不宣称已派发。
    expect(pending.querySelector('[class*="bg-surface/60"]')).toBeTruthy();
  });

  it("操作卡与原始协议块卡也用同一独立表面", () => {
    render(ACTIONS);
    const actionsCard = container.querySelector<HTMLElement>(".super-directive-card")!;
    expect(actionsCard.className).toContain("bg-primary/10");
    expect(actionsCard.className).not.toContain("bg-card");
    expect(actionsCard.textContent).toContain("超流体操作");
    expect(actionsCard.textContent).toContain("3 个动作");

    render(["```super-agent", '{"tasks": [oops]}', "```"].join("\n"));
    const rawCard = container.querySelector<HTMLElement>(".super-directive-card")!;
    expect(rawCard.className).toContain("bg-primary/10");
    expect(rawCard.textContent).toContain("原始指令内容");
  });
});

describe("SuperActionsToolCallCard（super-agent 工具 actions 载荷）", () => {
  function toolBlock(input: string | null, status: ToolBlock["status"] = "completed"): ToolBlock {
    return {
      kind: "tool",
      id: "b-actions",
      toolCallId: "tc-actions",
      toolName: "super-agent",
      title: "Manage child sessions",
      toolKind: "other",
      status,
      output: "Actions executed.",
      input,
      locations: [],
      diff: null,
    };
  }

  it("与围栏动作卡的动作行逐项一致，并沿用 ToolBlock 状态 chip，不挂飞入起点", () => {
    const input = JSON.stringify({
      actions: [
        { action: "retry", sessionId: "super-mwc6c04t-c3" },
        { action: "cleanup", sessionId: "super-mwc6c04t-c4", keepBranch: true },
        { action: "answer", sessionId: "super-mwc6c04t-c5", answers: { q1: "方案 A" } },
      ],
    });

    act(() => root.render(<AssistantText text={ACTIONS} />));
    const fencedRows = [...container.querySelectorAll("li")].map((li) => li.textContent);

    act(() => root.render(<SuperActionsToolCallCard block={toolBlock(input, "failed")} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    expect(card.classList.contains("super-directive-card")).toBe(true);
    expect(card.className).toContain("bg-primary/10");
    expect(card.textContent).toContain("超流体操作");
    expect(card.textContent).toContain("3 个动作");
    expect(card.textContent).toContain("失败");
    expect(card.hasAttribute("data-super-delegation-origin")).toBe(false);
    expect([...card.querySelectorAll("li")].map((li) => li.textContent)).toEqual(fencedRows);
  });

  it("工具帧 completed 但动作 not-found：显示真实失败与原因，不再谎报绿色已完成", () => {
    // 修复点3 的回归：内核对 super-agent 工具只回 ack，cancel 抄错 id 报
    // not-found 时工具帧同样是 completed —— 旧卡片据此染成绿色「已完成」。
    const input = JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-wrong" }] });
    const block: ToolBlock = {
      ...toolBlock(input, "completed"),
      superActionResult: [
        { action: "cancel", sessionId: "super-wrong", ok: false, reason: "not-found" },
      ],
    };

    act(() => root.render(<SuperActionsToolCallCard block={block} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    expect(card.textContent).toContain("未找到目标");
    expect(card.textContent).not.toContain("已完成");
    const failed = card.querySelector<HTMLElement>('[data-testid="super-action-result-failed"]');
    expect(failed).toBeTruthy();
    // 内部 sessionId 不摊到卡面：用「第 N 个」定位失败项。
    expect(failed!.textContent).not.toContain("super-wrong");
    expect(failed!.textContent).toContain("第 1 个");
    expect(failed!.textContent).toContain("找不到该超流体");
  });

  it("动作结果全部生效：显示绿色已完成与成功摘要", () => {
    const input = JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-ok" }] });
    const block: ToolBlock = {
      ...toolBlock(input, "completed"),
      superActionResult: [
        { action: "cancel", sessionId: "super-ok", ok: true, reason: "applied" },
      ],
    };

    act(() => root.render(<SuperActionsToolCallCard block={block} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    expect(card.textContent).toContain("已完成");
    expect(card.querySelector('[data-testid="super-action-result-ok"]')).toBeTruthy();
    expect(card.querySelector('[data-testid="super-action-result-failed"]')).toBeNull();
  });

  it("宿主回填带标题的动作：显示标题而非内部 id，覆盖多种动作类型", () => {
    // 用户实测截图 2026-11-18：中断卡只显示 super-mwm2zrdl-m 这种裸 id，
    // 第一眼认不出针对哪个子会话。标题只存在于宿主的 super-session 记录，
    // 由 runSuperActions 回填到 block.superActions；内部 id 属排障信息，不上卡面。
    const input = JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-mwm2zrdl-m" }] });
    const block: ToolBlock = {
      ...toolBlock(input, "completed"),
      superActions: [
        { action: "cancel", sessionId: "super-mwm2zrdl-m", title: "修复登录跳转" },
        { action: "cleanup", sessionId: "super-cleanup-01", title: "补文档", keepBranch: true },
      ],
      superActionResult: [
        { action: "cancel", sessionId: "super-mwm2zrdl-m", ok: true, reason: "applied" },
        { action: "cleanup", sessionId: "super-cleanup-01", ok: true, reason: "applied" },
      ],
    };

    act(() => root.render(<SuperActionsToolCallCard block={block} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    const rows = [...card.querySelectorAll("li")].map((li) => li.textContent ?? "");
    // cancel 与 cleanup 两种动作都只带标题，不再拼内部 id。
    expect(rows[0]).toContain("中断");
    expect(rows[0]).toContain("修复登录跳转");
    expect(rows[0]).not.toContain("super-mwm2zrdl-m");
    expect(rows[1]).toContain("清理");
    expect(rows[1]).toContain("补文档");
    expect(rows[1]).not.toContain("super-cleanup-01");
    expect(rows[1]).toContain("保留分支");
  });

  it("没有标题（流式中 / 旧转录 / 记录已清理）：显示本卡内序号，不暴露内部 sessionId", () => {
    const input = JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-bare-id" }] });
    act(() => root.render(<SuperActionsToolCallCard block={toolBlock(input)} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    expect(card.textContent).not.toContain("super-bare-id");
    expect(card.textContent).not.toContain("（）");
    expect(card.textContent).toContain("第 1 个");
  });

  it("标题为空字符串：同样显示序号，不显示占位符或内部 id", () => {
    const input = JSON.stringify({ actions: [{ action: "retry", sessionId: "super-empty-title" }] });
    const block: ToolBlock = {
      ...toolBlock(input),
      superActions: [{ action: "retry", sessionId: "super-empty-title", title: "   " }],
    };
    act(() => root.render(<SuperActionsToolCallCard block={block} />));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]')!;
    expect(card.textContent).not.toContain("super-empty-title");
    expect(card.textContent).not.toContain("（）");
    expect(card.textContent).toContain("第 1 个");
  });
});

describe("操作卡标题渲染（围栏路径与工具调用路径共用 ActionRows）", () => {
  it("围栏 super-agent-actions 段带 title 时只显示标题，不带内部 id", () => {
    renderSegment({
      kind: "directive",
      language: "super-agent-actions",
      raw: "",
      display: {
        kind: "actions",
        actions: [
          { action: "cancel", sessionId: "super-fence-01", title: "围栏里的中断标题" },
          { action: "answer", sessionId: "super-fence-02" },
        ],
      },
    });
    const body = text();
    expect(body).toContain("围栏里的中断标题");
    expect(body).not.toContain("super-fence-01");
    // 没有 title 的那条显示本卡内序号，不暴露内部 id，也没有空括号。
    expect(body).not.toContain("super-fence-02");
    expect(body).not.toContain("（super-fence-02）");
    expect(body).toContain("第 2 个");
  });
});
