// @vitest-environment jsdom
/**
 * T-2/3/4 用量来源展示的前端行为验收。
 *
 * 目标：一眼看出成本、占用条、输入/输出拆分这三个数字是「估的还是准的」。
 * 这里用 mock store 直接渲染 Composer 的用量 chip，逐项核对：
 *  - 占用条：kernel-report 无前缀 / transcript-estimate ≈ / lower-bound ≥ / 缺失 ?
 *  - 成本：用户配置单价无前缀 / 回退估算 ≈ / 缺失 ?
 *  - 拆分：按 sources.split 加前缀并标注来源
 *  - tooltip：数据出处行列出 token 来源 + 单价来源 + 采集时间 + 来源链接，
 *    任一项缺失都如实说「来源未知 / 无来源链接」，绝不默认标成权威。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageUi, UsageNumberSource } from "../shared/messages";

const holder = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: (selector: (s: unknown) => unknown) => selector(holder.state),
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

import { SessionUsageChip } from "../webview/src/components/Composer";

function usage(overrides: Partial<SessionUsageUi> = {}): SessionUsageUi {
  return {
    inputTokens: 12000,
    outputTokens: 3000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15000,
    contextWindow: 128000,
    contextUsed: 56000,
    estimatedCost: 0.05,
    ...overrides,
  };
}

function withSources(
  src: Partial<NonNullable<SessionUsageUi["sources"]>> | undefined,
  extra: Partial<SessionUsageUi> = {},
): SessionUsageUi {
  return usage({ sources: src, ...extra });
}

const at = Date.UTC(2026, 10, 20, 8, 30, 0);
const INPUT = (12000).toLocaleString();
const OUTPUT = (3000).toLocaleString();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(u: SessionUsageUi | null): void {
  holder.state = { state: { usage: u } };
  act(() => root.render(<SessionUsageChip />));
}

/** 用量 chip 外层 span（DOM 顺序上第一个带「数据出处」title 的节点；成本
 * 内层 span 复用同一 title）。 */
function chip(): HTMLElement {
  const found = Array.from(container.querySelectorAll("[title]")).find((el) =>
    el.getAttribute("title")?.includes("数据出处"),
  );
  if (!found) throw new Error("usage chip not found");
  return found as HTMLElement;
}
const chipText = () => chip().textContent ?? "";
const chipTitle = () => chip().getAttribute("title") ?? "";

describe("占用条来源标注（T-3）", () => {
  const cases: Array<[UsageNumberSource, string]> = [
    ["kernel-report", ""],
    ["transcript-estimate", "≈"],
    ["lower-bound", "≥"],
  ];
  for (const [source, prefix] of cases) {
    it(`sources.contextUsed=${source} → 前缀「${prefix || "无"}」`, () => {
      render(withSources({ contextUsed: source }));
      expect(chipText()).toContain(`${prefix}44%`);
      expect(chipText()).toContain("44%");
    });
  }

  it("来源缺失 → 前缀「?」，绝不裸奔成权威", () => {
    render(usage());
    expect(chipText()).toContain("?44%");
    expect(chipText()).not.toContain("≈44%");
    expect(chipText()).not.toContain("≥44%");
  });
});

describe("成本来源前缀（T-2）", () => {
  it("用户配置单价 → 无前缀", () => {
    render(withSources({ cost: "user" }));
    expect(chipText()).toContain("$0.05");
    expect(chipText()).not.toContain("?$0.05");
    expect(chipText()).not.toContain("≈$0.05");
  });

  it("回退估算单价 → ≈ 前缀", () => {
    render(withSources({ cost: "fallback-estimate" }));
    expect(chipText()).toContain("≈$0.05");
  });

  it("单价来源缺失 → ? 前缀", () => {
    render(usage());
    expect(chipText()).toContain("?$0.05");
  });
});

describe("输入/输出拆分来源（T-4）", () => {
  it("split=transcript-estimate → 两项都标 ≈ 且注明来源", () => {
    render(withSources({ split: "transcript-estimate" }));
    expect(chipTitle()).toContain(`输入 ≈${INPUT} tokens · 输出 ≈${OUTPUT} tokens（拆分来源：转录估算）`);
  });

  it("split 缺失 → 标 ? 且注明来源未知", () => {
    render(usage());
    expect(chipTitle()).toContain(`输入 ?${INPUT} tokens · 输出 ?${OUTPUT} tokens（拆分来源：来源未知）`);
  });
});

describe("tooltip 数据出处行（T-2 + 来源缺失纪律）", () => {
  it("全部来源齐全 → token 来源 + 单价来源 + 采集时间 + 来源链接都在", () => {
    const url = "https://example.com/model-spec";
    render(
      withSources(
        { contextUsed: "kernel-report", cost: "ai-supplement", split: "kernel-report", window: "builtin-table" },
        { capturedAt: at, sourceUrl: url },
      ),
    );
    expect(chipTitle()).toContain("数据出处：token 内核上报 · 单价 AI 补充 · 采集 ");
    expect(chipTitle()).toContain(`来源链接：${url}`);
    expect(chipTitle()).not.toContain("来源未知");
    expect(chipTitle()).not.toContain("无来源链接");
    expect(chipTitle()).toContain("窗口来源：内置表");
  });

  it("sources、capturedAt、sourceUrl 全缺 → 各项如实显示「来源未知 / 无来源链接」", () => {
    render(usage());
    expect(chipTitle()).toContain("数据出处：token 来源未知 · 单价 来源未知 · 采集 来源未知 · 无来源链接");
    expect(chipTitle()).toContain("拆分来源：来源未知");
    expect(chipTitle()).toContain("窗口来源：来源未知");
    // 绝不出现任何「权威 / 内核上报」字样，更没有重新推算的时间戳。
    expect(chipTitle()).not.toContain("内核上报");
    expect(chipTitle()).not.toContain("内置表");
  });

  it("单个来源缺失不污染其它已填来源", () => {
    render(withSources({ contextUsed: "lower-bound" }, { capturedAt: at }));
    expect(chipTitle()).toContain("数据出处：token 下界 · 单价 来源未知 · 采集 ");
    expect(chipTitle()).not.toContain("数据出处：token 来源未知");
    expect(chipTitle()).toContain("无来源链接");
  });

  it("capturedAt 缺失但 sourceUrl 存在 → 采集说来源未知、链接照常展示", () => {
    const url = "https://example.com/price";
    render(withSources({ cost: "user" }, { sourceUrl: url }));
    expect(chipTitle()).toContain("采集 来源未知");
    expect(chipTitle()).toContain(`来源链接：${url}`);
  });
});

describe("无占用窗口的旧宿主形态", () => {
  it("contextWindow=null 时仍显示来源行，不因缺窗口冒称权威", () => {
    render(withSources(undefined, { contextWindow: null }));
    expect(chipTitle()).toContain("数据出处：token 来源未知");
    expect(chipTitle()).toContain("拆分来源：来源未知");
    // 百分比不渲染，但成本前缀与来源披露依旧在。
    expect(chipText()).not.toContain("44%");
    expect(chipText()).toContain("?$0.05");
  });
});
