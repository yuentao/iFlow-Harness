/**
 * 上下文窗口覆写行的纯逻辑（shared/context-window-overrides.ts）。
 *
 * 这一层是设置页结构化编辑器与运行时解析器之间的共同基准：两边必须用
 * 同一套判定，否则用户在设置页看到的「有效」和运行时实际生效的会不一致。
 */
import { describe, expect, it } from "vitest";
import {
  formatContextWindowRow,
  normalizeContextWindowRows,
  parseContextWindowRow,
  validateContextWindowDraft,
} from "../shared/context-window-overrides";

describe("上下文窗口覆写行", () => {
  it("解析 模型名=数值 并归一化模型名", () => {
    expect(parseContextWindowRow("auto/deepseek-v4.1-flash=960000")).toEqual({
      model: "deepseek-v4.1-flash",
      window: 960000,
      raw: "auto/deepseek-v4.1-flash=960000",
    });
    expect(parseContextWindowRow("DeepSeek-V4=1000000")?.model).toBe("deepseek-v4");
  });

  it("把带单位的值判为无效（运行时会把它们静默丢弃）", () => {
    expect(parseContextWindowRow("deepseek=960K")).toBeNull();
    expect(parseContextWindowRow("deepseek=1.5M")).toBeNull();
    expect(parseContextWindowRow("deepseek=abc")).toBeNull();
    expect(parseContextWindowRow("deepseek=0")).toBeNull();
    expect(parseContextWindowRow("deepseek=-1")).toBeNull();
    expect(parseContextWindowRow("no-equals-sign")).toBeNull();
    expect(parseContextWindowRow("=960000")).toBeNull();
  });

  it("新增行校验：模型名非空、窗口为正整数", () => {
    expect(validateContextWindowDraft("", "960000")).toEqual({ ok: false, reason: "model" });
    expect(validateContextWindowDraft("deepseek", "960K")).toEqual({ ok: false, reason: "window" });
    expect(validateContextWindowDraft("deepseek", "960000.5")).toEqual({ ok: false, reason: "window" });
    expect(validateContextWindowDraft("deepseek", "")).toEqual({ ok: false, reason: "window" });
    expect(validateContextWindowDraft("auto/deepseek-v4.1-flash", "960000")).toEqual({
      ok: true,
      row: "deepseek-v4.1-flash=960000",
    });
  });

  it("归一化整张表：可解析的行改写成规范形式，不可解析的行逐字保留", () => {
    expect(
      normalizeContextWindowRows(["auto/deepseek-v4.1-flash=960000", "glm-4.6=200000", "broken=960K"]),
    ).toEqual(["deepseek-v4.1-flash=960000", "glm-4.6=200000", "broken=960K"]);
    expect(formatContextWindowRow("auto/GLM-4.6", 200000.9)).toBe("glm-4.6=200000");
  });
});
