/**
 * 任务书正文解析器（纯逻辑）。
 *
 * 委派卡里的「任务书正文」以前是一整段 whitespace-pre-wrap 文字，模型写的
 * “(1) …(2) …(8) …” 挤在一行里就成了一堵墙。这里钉住解析规则：
 *
 *  - 段落 / 项目符号 / 编号项 / 引用 / 标题 / 代码块；
 *  - **行内枚举**（同一行里的 (1)(2)(3)）被切成独立编号项；
 *  - 行内代码（反引号、文件路径、标识符调用）被标记出来，URL 不被误伤；
 *  - 折叠预览按块截断，不切半句。
 */
import { describe, expect, it } from "vitest";
import {
  parseSuperTaskText,
  previewSuperTaskBlocks,
  splitSuperTaskInlines,
  type SuperTaskBlock,
} from "../webview/src/components/super-task-text";

function kinds(blocks: SuperTaskBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

function texts(blocks: SuperTaskBlock[]): string[] {
  return blocks.map((block) =>
    block.kind === "code" ? block.text : block.inlines.map((inline) => inline.text).join(""),
  );
}

function codeTexts(text: string): string[] {
  return splitSuperTaskInlines(text)
    .filter((inline) => inline.kind === "code")
    .map((inline) => inline.text);
}

describe("parseSuperTaskText", () => {
  it("空文本没有块", () => {
    expect(parseSuperTaskText("")).toEqual([]);
    expect(parseSuperTaskText("   \n  \n")).toEqual([]);
  });

  it("普通文本是一段段落，多行同属一段", () => {
    const blocks = parseSuperTaskText("只做一件事");
    expect(kinds(blocks)).toEqual(["paragraph"]);
    expect(texts(blocks)).toEqual(["只做一件事"]);

    const wrapped = parseSuperTaskText("第一行\n第二行");
    expect(kinds(wrapped)).toEqual(["paragraph"]);
    expect(texts(wrapped)).toEqual(["第一行\n第二行"]);
  });

  it("空行分段", () => {
    const blocks = parseSuperTaskText("第一段\n\n第二段");
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    expect(texts(blocks)).toEqual(["第一段", "第二段"]);
  });

  it("行首项目符号变成 bullet 项", () => {
    const blocks = parseSuperTaskText("- 甲项\n- 乙项");
    expect(kinds(blocks)).toEqual(["bullet", "bullet"]);
    expect(texts(blocks)).toEqual(["甲项", "乙项"]);
  });

  it("行首编号变成有序项（1. / 1) / (1) / （1）都认）", () => {
    expect(kinds(parseSuperTaskText("1. 甲项\n2. 乙项"))).toEqual(["ordered", "ordered"]);
    expect(kinds(parseSuperTaskText("1) 甲项\n2) 乙项"))).toEqual(["ordered", "ordered"]);
    expect(kinds(parseSuperTaskText("(1) 甲项\n(2) 乙项"))).toEqual(["ordered", "ordered"]);
    expect(kinds(parseSuperTaskText("（1）甲项\n（2）乙项"))).toEqual(["ordered", "ordered"]);
    const blocks = parseSuperTaskText("1. 甲项\n2. 乙项");
    expect(blocks.map((block) => (block.kind === "ordered" ? block.label : ""))).toEqual(["1", "2"]);
  });

  it("行首引用与标题各有各的块", () => {
    expect(kinds(parseSuperTaskText("> 引用一句"))).toEqual(["quote"]);
    expect(kinds(parseSuperTaskText("## 目标"))).toEqual(["heading"]);
  });

  it("独占一行的中文方括号小节变成 heading，方括号被去掉", () => {
    const blocks = parseSuperTaskText("【前置检查（重要，先做）】\n- 甲项");
    expect(kinds(blocks)).toEqual(["heading", "bullet"]);
    expect(texts(blocks)[0]).toBe("前置检查（重要，先做）");
  });

  it("行中出现、非独占一行的 【…】 保持普通文本", () => {
    const blocks = parseSuperTaskText("先做前置检查【重要】再继续");
    expect(kinds(blocks)).toEqual(["paragraph"]);
    expect(texts(blocks)).toEqual(["先做前置检查【重要】再继续"]);
  });

  it("行首小节后面还跟正文时，正文另起段落，不丢字", () => {
    const blocks = parseSuperTaskText("【目标】把卡片改好");
    expect(kinds(blocks)).toEqual(["heading", "paragraph"]);
    expect(texts(blocks)).toEqual(["目标", "把卡片改好"]);
  });

  it("缩进行是上一项的续行，不另起一段", () => {
    const blocks = parseSuperTaskText("- 甲项\n  补充说明\n- 乙项");
    expect(kinds(blocks)).toEqual(["bullet", "bullet"]);
    expect(texts(blocks)).toEqual(["甲项\n补充说明", "乙项"]);
  });

  it("行内枚举 (1)(2)(3) 被切成独立编号项，前言仍是段落", () => {
    const blocks = parseSuperTaskText("目标说明。(1) 第一步做 A。(2) 第二步做 B。(3) 第三步做 C。");
    expect(kinds(blocks)).toEqual(["paragraph", "ordered", "ordered", "ordered"]);
    expect(texts(blocks)).toEqual(["目标说明。", "第一步做 A。", "第二步做 B。", "第三步做 C。"]);
    const labels = blocks
      .filter((block) => block.kind === "ordered")
      .map((block) => (block.kind === "ordered" ? block.label : ""));
    expect(labels).toEqual(["1", "2", "3"]);
  });

  it("全角括号的行内枚举同样切开", () => {
    const blocks = parseSuperTaskText("（1）甲项（2）乙项");
    expect(kinds(blocks)).toEqual(["ordered", "ordered"]);
    expect(texts(blocks)).toEqual(["甲项", "乙项"]);
  });

  it("只有一个标记时不切（可能是正文里的括号）", () => {
    const blocks = parseSuperTaskText("前言。(1) 只有一步。");
    expect(kinds(blocks)).toEqual(["paragraph"]);
    expect(texts(blocks)).toEqual(["前言。(1) 只有一步。"]);
  });

  it("序号不递增时不切", () => {
    // 标记不在行首（否则走行首编号规则），且序号不递增 → 保持一整段。
    const blocks = parseSuperTaskText("前言 (2) 甲项 (1) 乙项");
    expect(kinds(blocks)).toEqual(["paragraph"]);
  });

  it("标识符调用不算枚举标记", () => {
    const blocks = parseSuperTaskText("调用 reportPrompt(entries) 一次即可。");
    expect(kinds(blocks)).toEqual(["paragraph"]);
    expect(codeTexts("调用 reportPrompt(entries) 一次即可。")).toEqual([
      "reportPrompt(entries)",
    ]);
  });

  it("围栏代码块单独成块，未闭合时按到文末处理", () => {
    const blocks = parseSuperTaskText("前言\n\n```ts\nconst a = 1;\n```\n\n后语");
    expect(kinds(blocks)).toEqual(["paragraph", "code", "paragraph"]);
    const code = blocks[1];
    expect(code?.kind).toBe("code");
    expect(code?.kind === "code" ? code.text : "").toBe("const a = 1;");
    expect(code?.kind === "code" ? code.lang : "").toBe("ts");

    const unclosed = parseSuperTaskText("```js\nconst a = 1;");
    expect(kinds(unclosed)).toEqual(["code"]);
    expect(unclosed[0]?.kind === "code" ? unclosed[0].text : "").toBe("const a = 1;");
  });
});

describe("splitSuperTaskInlines", () => {
  it("反引号片段是行内代码", () => {
    const inlines = splitSuperTaskInlines("先跑 `npm test` 再跑");
    expect(inlines.map((inline) => inline.kind)).toEqual(["text", "code", "text"]);
    expect(inlines[1]?.text).toBe("npm test");
    // 普通文本原样保留（含空格）。
    expect(inlines[0]?.text).toBe("先跑 ");
    expect(inlines[2]?.text).toBe(" 再跑");
  });

  it("文件路径与标识符调用是行内代码", () => {
    expect(codeTexts("改 src/panel/panel.ts 与 README.md")).toEqual([
      "src/panel/panel.ts",
      "README.md",
    ]);
    expect(codeTexts("看 SuperReportBuffer.takeSettled(sessions) 的实现")).toEqual([
      "SuperReportBuffer.takeSettled(sessions)",
    ]);
  });

  it("URL 不会被切成代码", () => {
    const inlines = splitSuperTaskInlines("见 https://example.com/a.html 与 www.example.com");
    expect(inlines.every((inline) => inline.kind === "text")).toBe(true);
    expect(inlines.map((inline) => inline.text).join("")).toContain("https://example.com/a.html");
  });

  it("普通缩写与版本号不会被误标成代码", () => {
    expect(codeTexts("例如 e.g. 这种写法，版本 1.0.5 也一样")).toEqual([]);
  });

  it("普通中文标点不受影响", () => {
    const inlines = splitSuperTaskInlines("目标（第一）：完成");
    expect(inlines.every((inline) => inline.kind === "text")).toBe(true);
  });

  it("**…** 与 __…__ 解析成 strong，内部仍能切路径与行内代码", () => {
    const inlines = splitSuperTaskInlines("**先跑 `npm test`** 与 __src/panel/panel.ts__");
    expect(inlines.map((inline) => inline.kind)).toEqual(["strong", "text", "strong"]);

    const star = inlines[0];
    expect(star?.kind === "strong" ? star.text : "").toBe("先跑 npm test");
    expect(star?.kind === "strong" ? star.inlines.map((inline) => inline.kind) : []).toEqual([
      "text",
      "code",
    ]);

    const underscore = inlines[2];
    expect(underscore?.kind === "strong" ? underscore.text : "").toBe("src/panel/panel.ts");
    expect(
      underscore?.kind === "strong" ? underscore.inlines.map((inline) => inline.kind) : [],
    ).toEqual(["code"]);
  });

  it("未闭合的 ** 保持普通文本（不吐字面星号以外的变化）", () => {
    const inlines = splitSuperTaskInlines("** 没闭合的说明");
    expect(inlines.every((inline) => inline.kind === "text")).toBe(true);
    expect(inlines.map((inline) => inline.text).join("")).toBe("** 没闭合的说明");
  });

  it("跨行的 ** 不生效", () => {
    const inlines = splitSuperTaskInlines("**第一行\n第二行**");
    expect(inlines.every((inline) => inline.kind === "text")).toBe(true);
  });

  it("标识符里的双下划线不会被当成加粗", () => {
    const inlines = splitSuperTaskInlines("my__var__name 保持原样");
    expect(inlines.every((inline) => inline.kind === "text")).toBe(true);
  });
});

describe("previewSuperTaskBlocks", () => {
  it("内容不超预算时全部返回且不截断", () => {
    const blocks = parseSuperTaskText("- 甲项\n- 乙项");
    const preview = previewSuperTaskBlocks(blocks, 200, 3);
    expect(preview.truncated).toBe(false);
    expect(preview.hiddenChars).toBe(0);
    expect(preview.blocks).toHaveLength(2);
  });

  it("截断时给出剩余字数（「还有 N 字」的数据源）", () => {
    const blocks = parseSuperTaskText("- 甲项\n- 乙项\n- 丙项\n- 丁项");
    const preview = previewSuperTaskBlocks(blocks, 4, 2);
    expect(preview.truncated).toBe(true);
    expect(preview.hiddenChars).toBeGreaterThan(0);
    expect(preview.hiddenChars).toBeLessThanOrEqual(
      blocks.reduce(
        (sum, block) =>
          sum + (block.kind === "code" ? block.text.length : block.inlines.reduce((n, i) => n + i.text.length, 0)),
        0,
      ),
    );
  });

  it("超过块数上限时按块截断，末块保持完整", () => {
    const blocks = parseSuperTaskText("- 甲项\n- 乙项\n- 丙项\n- 丁项");
    // 预算很小 → 进入截断路径；块上限 2 → 只给两块。
    const preview = previewSuperTaskBlocks(blocks, 4, 2);
    expect(preview.truncated).toBe(true);
    // 块边界截断：给出去的块都是完整的（不补省略号，避免看起来像半句）。
    expect(preview.cutText).toBe(false);
    expect(preview.blocks).toHaveLength(2);
    expect(preview.blocks[1]?.inlines[0]?.text).not.toContain("…");
  });

  it("第一块就超预算时在句子边界处切一刀", () => {
    const long = `${"这是一句比较长的说明。".repeat(40)}`;
    const blocks = parseSuperTaskText(long);
    const preview = previewSuperTaskBlocks(blocks, 60, 3);
    expect(preview.truncated).toBe(true);
    expect(preview.cutText).toBe(true);
    expect(preview.blocks).toHaveLength(1);
    const text = preview.blocks[0]?.inlines[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(61);
    expect(text.endsWith("…")).toBe(true);
  });
});
