// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 业务组件原生按钮收敛的定点回归：ui-kit-guard 只守 kit 自身的控件物种，
 * 这里补一层断言，确保下面这些「同一动作双实现」的工位不再回退成手搓
 * <button>（disabled / focus ring / 主题一旦分裂，交互就会漂移）。
 */
const WEBVIEW_SRC = join(__dirname, "..", "webview", "src");

function source(rel: string): string {
  return readFileSync(join(WEBVIEW_SRC, rel), "utf8");
}

/** 在两端唯一锚点之间切片，锚点缺失时给出明确失败信息。 */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `missing start anchor: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `missing end anchor: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

const nativeButton = /<button\b/;

describe("业务组件按钮收敛到 UI kit", () => {
  it("DiffView 的「应用标记」只有一份 kit Button（flat/非 flat 不再分叉）", () => {
    const src = source("components/DiffView.tsx");
    const block = between(src, "{editable && hunkCount > 0 && (", "{dirty && (");
    expect(block).not.toMatch(nativeButton);
    expect(block).toMatch(/<Button\s/);
    expect(block).toContain('variant="canvas"');
    expect(block).toContain('size="sm"');
    expect(block).toContain('disabled={!dirty || hunkActions?.busy}');
    expect(block).toContain('title={t("把标记为回退的改动恢复成修改前的内容，其余改动保留")}');
    expect(block).toContain('{t("应用标记：保留 {0} 处，回退 {1} 处", keepCount, revertCount)}');
  });

  it("App 错误横幅的复制/详情/打开设置都走 kit，且可访问名不变", () => {
    const src = source("App.tsx");
    const banner = between(src, "function ErrorBanner(", "/** Stable empty fallbacks");
    expect(banner).not.toMatch(nativeButton);
    expect(banner).toContain('title={copied ? t("已复制") : t("复制错误信息")}');
    expect(banner).toContain('aria-expanded={expanded}');
    expect(banner).toContain('t("打开 API 设置")');
    expect(banner).toContain('t("打开运行时设置")');
    // 原本手搓的两处文案仍在，说明替换只换了控件物种，没换语义。
    expect(banner).toContain('{copied ? t("已复制") : t("复制")}');
    expect(banner).toContain('{expanded ? t("收起") : t("详情")}');
  });

  it("Composer 上下文 chip 的展开与 +N 都是 kit Button", () => {
    const src = source("components/Composer.tsx");
    const chips = between(
      src,
      "{(showAllContexts ? contexts : contexts.slice(0, CONTEXT_CHIP_MAX)).map((c) => {",
      "{expandedContext && (",
    );
    expect(chips).not.toMatch(nativeButton);
    expect(chips).toContain('variant="ghost"');
    expect(chips).toContain('aria-expanded={open}');
    expect(chips).toContain('title={open ? t("收起") : t("展开上下文")}');
    expect(chips).toContain('variant="canvas"');
    expect(chips).toContain('title={showAllContexts ? t("收起") : t("展开全部 {0} 张上下文卡", contexts.length)}');
  });

  it("MemoryCard 的事实展开/列表折叠都是 kit Button", () => {
    const src = source("components/MemoryCard.tsx");
    const factRow = between(src, "function FactRow(", "function MemoryFileCard(");
    expect(factRow).not.toMatch(nativeButton);
    expect(factRow).toContain('variant="ghost"');
    expect(factRow).toContain('aria-expanded={expanded}');
    expect(factRow).toContain('title={expanded ? t("收起全文") : t("展开全文")}');

    const factsSection = between(src, "const factsSection =", "return (");
    expect(factsSection).not.toMatch(nativeButton);
    expect(factsSection).toContain('aria-expanded={false}');
    expect(factsSection).toContain('aria-expanded={true}');
    expect(factsSection).toContain('t("{0} 条记忆", facts.length)');
    expect(factsSection).toContain('t("收起记忆列表")');
  });
});