// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../prompts/index.js";
import { extractSuperDirectives, parseSuperDelegationPayload } from "../shared/super-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/**
 * 行尾归一化：CRLF / CR 一律折叠成 LF。
 *
 * 仓库根没有 .gitattributes，Windows 上 `core.autocrlf=true` 会把 prompts/*.md
 * 以 CRLF 检出，而 git 对象库里存的是纯 LF —— 同一份文件在不同机器上读出来的
 * 字节不同。下面的断言用 `"\n"` 拼出期望串做逐字比较，行尾不一致就会误报。
 * 这里在读文件处统一归一化：要求的文本本身仍必须一字不差出现，只是不再被
 * 检出行尾差异干扰（与 prompts/index.ts 里的 normalize() 同口径）。
 */
const normalizeEol = (text: string): string => text.replace(/\r\n?/g, "\n");

const systemText = normalizeEol(
  readFileSync(path.join(root, "prompts", "system-prompt.md"), "utf8"),
);
const taskTemplateText = normalizeEol(
  readFileSync(path.join(root, "prompts", "super-agent-task.md"), "utf8"),
);

/** 围栏标记（单独放常量，避免在模板字符串里写反引号）。 */
const FENCE = "```";

/**
 * 两段示例文本。
 *
 * 它们**逐字**来自 `prompts/system-prompt.md` 的 Super Agent 段（下面用
 * `toContain` 断言同一份文本真的在模板里），主会话的示例、宿主解析器的输入
 * 与 shared 层的子会话必须用同一份字符串 —— 模型会照抄示例，三处一旦分叉，
 * 就会出现「模板里是一套、shared 层按另一套解析」的静默错配。
 */
const DEPENDENCY_EXAMPLE =
  '{"tasks":[{"title":"实现数据层","task":"按任务书实现数据层"},{"title":"实现接口层","task":"依赖数据层，实现接口层","dependsOn":["实现数据层"]}]}';
const BATCH_EXAMPLE =
  '{"tasks":[{"title":"实现 A","task":"第一批任务"},{"title":"实现 B","task":"第二批任务","batch":2}]}';

/** 任务书模板允许存在的占位符（与宿主 `buildTaskPrompt` 的渲染清单同源）。 */
const TASK_TEMPLATE_PLACEHOLDERS = [
  "attachmentFailures",
  "attachments",
  "isolation",
  "retry",
  "submission",
  "task",
  "title",
];

/** 宿主渲染任务书时用的一组完整变量。 */
const TASK_TEMPLATE_VARS: Record<string, string> = {
  title: "实现接口层",
  task: "依赖数据层，实现接口层。",
  attachments: "",
  attachmentFailures: "",
  isolation: "Working directory: /tmp/wt",
  retry: "",
  submission: 'Commit before finishing: `git add -A && git commit -m "<message describing the change>"`.',
};

describe("super agent · 委派提示词模板（依赖 / 批次表达）", () => {
  it("两段示例逐字出现在 system-prompt.md 的 Super Agent 段里（围栏包裹）", () => {
    // 模型会照抄示例：示例必须是**合法 JSON**，否则宿主判成「载荷不是合法 JSON」，
    // 整块零派发。所以这里断言「围栏 + 示例」的完整形态，而不只是示例字符串存在。
    const dependencyFence = FENCE + "super-agent\n" + DEPENDENCY_EXAMPLE + "\n" + FENCE;
    const batchFence = FENCE + "super-agent\n" + BATCH_EXAMPLE + "\n" + FENCE;
    expect(systemText).toContain(dependencyFence);
    expect(systemText).toContain(batchFence);
  });

  it("比较逻辑对行尾宽容：CRLF 内容走同一条归一化路径后逐字断言仍成立", () => {
    // 防回归钉子：模拟 core.autocrlf=true 的检出结果（整份 CRLF）。
    // 若把 normalizeEol 去掉，第二个 expect 就会失败 —— 这正是原来在 Windows 上必红的根因。
    const crlfSystem = systemText.replace(/\n/g, "\r\n");
    const dependencyFence = FENCE + "super-agent\n" + DEPENDENCY_EXAMPLE + "\n" + FENCE;
    const batchFence = FENCE + "super-agent\n" + BATCH_EXAMPLE + "\n" + FENCE;
    // 证据 1：原始 CRLF 文本不包含以 LF 拼出的围栏（复现旧失败）。
    expect(crlfSystem).not.toContain(dependencyFence);
    // 证据 2：走与正式断言相同的 normalizeEol → toContain 路径后，逐字包含成立。
    expect(normalizeEol(crlfSystem)).toContain(dependencyFence);
    expect(normalizeEol(crlfSystem)).toContain(batchFence);
  });

  it("两段示例是合法 JSON，结构符合约定（tasks 数组、元素含 title/task）", () => {
    for (const [name, example] of [
      ["依赖模式", DEPENDENCY_EXAMPLE],
      ["批次模式", BATCH_EXAMPLE],
    ] as const) {
      const parsed = JSON.parse(example) as { tasks?: Array<{ title?: unknown; task?: unknown }> };
      expect(parsed.tasks, name + " 示例缺 tasks 数组").toBeInstanceOf(Array);
      expect(parsed.tasks).toHaveLength(2);
      for (const entry of parsed.tasks ?? []) {
        expect(typeof entry.title, name + " 示例的 title 必须是字符串").toBe("string");
        expect(typeof entry.task, name + " 示例的 task 必须是字符串").toBe("string");
      }
    }
    // 依赖模式：dependsOn 引用同块内的 title。
    const dependency = JSON.parse(DEPENDENCY_EXAMPLE) as {
      tasks: Array<{ title: string; dependsOn?: string[] }>;
    };
    expect(dependency.tasks[1]?.dependsOn).toEqual(["实现数据层"]);
    // 批次模式：batch 从 1 基开始，不写即第一批。
    const batch = JSON.parse(BATCH_EXAMPLE) as { tasks: Array<{ title: string; batch?: number }> };
    expect(batch.tasks[0]?.batch).toBeUndefined();
    expect(batch.tasks[1]?.batch).toBe(2);
  });

  it("宿主的解析器能吃下两段示例（真实扫描路径：围栏 → 指令块）", () => {
    for (const [name, example] of [
      ["依赖模式", DEPENDENCY_EXAMPLE],
      ["批次模式", BATCH_EXAMPLE],
    ] as const) {
      // 载荷级入口（宿主工具调用帧走的同一条路径）。
      const payload = parseSuperDelegationPayload(example);
      const reason = payload.ok ? "" : payload.reason;
      expect(payload.ok, name + " 示例被解析器判为非法：" + reason).toBe(true);
      if (payload.ok) {
        expect(payload.tasks).toHaveLength(2);
        expect(payload.tasks[0]?.title).toBeTruthy();
        expect(payload.tasks[1]?.title).toBeTruthy();
      }

      // 围栏级入口（宿主扫模型正文用的真实路径）。
      const scan = extractSuperDirectives([FENCE + "super-agent", example, FENCE].join("\n"));
      expect(scan.invalidBlocks, name + " 示例被判为非法块").toHaveLength(0);
      expect(scan.blocks).toHaveLength(1);
      expect(scan.blocks[0]).toHaveLength(2);
    }

    // TODO(shared 层字段落地后改成真解析断言)：宿主当前的 SuperTaskSpec 只带
    // title / task / attachments，`dependsOn` 与 `batch` 尚未进入解析结果 ——
    // shared 层子会话把这两个字段落地后，这里应改成断言
    // `payload.tasks[1].dependsOn` / `payload.tasks[1].batch` 的真实取值，
    // 并补一条「成环 / 悬空依赖整块拒绝」的用例。当前先断言字段确实在载荷里。
    const dependency = JSON.parse(DEPENDENCY_EXAMPLE) as {
      tasks: Array<{ dependsOn?: string[] }>;
    };
    expect(dependency.tasks[1]?.dependsOn).toEqual(["实现数据层"]);
  });

  it("system-prompt.md 的 Super Agent 段讲清了 dependsOn / batch 与「不得混用」", () => {
    // 依赖模式与批次模式的定义。
    expect(systemText).toContain("## Expressing task dependencies and batches");
    expect(systemText).toContain("`dependsOn`");
    expect(systemText).toContain("**in the same block**");
    expect(systemText).toContain("`batch`, a 1-based batch number");
    expect(systemText).toContain("belongs to the first batch");
    // 「不得混用」必须写死 —— 两种模式混在一块时语义无法判定。
    expect(systemText).toMatch(/mix `dependsOn` and `batch` in the same block/);
    // 同块约束 + 成环 / 悬空依赖整块拒绝并回报。
    expect(systemText).toMatch(/cyclic or dangling dependency invalidates the \*\*whole\*\* block/);
    expect(systemText).toMatch(/rejects it and reports why/);
    // 需要表达依赖时优先用围栏块（内置工具通道可能因 CLI 侧 schema 限制丢字段）。
    expect(systemText).toMatch(
      /write it as a `super-agent` fenced block instead of calling the built-in tool/,
    );
    // 载荷必须是合法 JSON。
    expect(systemText).toMatch(/Keep the payload \*\*valid JSON\*\*/);
  });

  it("任务书模板新增了波次 / 依赖上下文说明，且没有引入新占位符", () => {
    const found = [...taskTemplateText.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
    expect([...new Set(found)].sort()).toEqual(TASK_TEMPLATE_PLACEHOLDERS);
    // 子会话侧要知道自己处在什么执行上下文里。
    expect(taskTemplateText).toContain("Execution context (waves and dependencies)");
    expect(taskTemplateText).toContain(
      "the host adds a plain-text wave/dependency context block to this brief",
    );
    expect(taskTemplateText).toContain("has already completed successfully");
    expect(taskTemplateText).toContain(
      "the host marks it as blocked and reports that instead of running it",
    );
    expect(taskTemplateText).toContain("this task has no upstream dependency and no wave ordering");
  });

  it("任务书渲染后不残留未替换的占位符", () => {
    const rendered = renderPrompt("super-agent-task", TASK_TEMPLATE_VARS);
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    // 渲染结果里波次 / 依赖上下文那一段仍在（说明它不是被折叠掉的空行）。
    expect(rendered).toContain("Execution context (waves and dependencies)");
    expect(rendered).toContain(
      "the host marks it as blocked and reports that instead of running it",
    );

    // 全部可选段落都有值时同样不残留占位符。
    const full = renderPrompt("super-agent-task", {
      ...TASK_TEMPLATE_VARS,
      attachments: "\nFiles attached to this task:\n- a.md → /tmp/a.md",
      attachmentFailures: "\nThese attachments could not be delivered:\n- b.png: boom",
      retry: "\nPrevious attempt was interrupted.",
    });
    expect(full).not.toMatch(/\{\{\w+\}\}/);
    expect(full).toContain("a.md → /tmp/a.md");
    expect(full).toContain("b.png: boom");
    expect(full).toContain("Previous attempt was interrupted.");
  });
});