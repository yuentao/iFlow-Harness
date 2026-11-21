/**
 * shouldRetrySuperFailure —— 失败重试决策的纯函数约束。
 *
 * 规则只有一条：retryable 且 attempts < maxAttempts 才重试。四类失败 ×
 * 上限边界全覆盖，确保宿主接线后不会把「被中断 / 等人 / 终态失败」误重试。
 */
import { describe, it, expect } from "vitest";
import { shouldRetrySuperFailure, type SuperFailureKind } from "../shared/super-agent.js";

describe("shouldRetrySuperFailure · 失败重试决策", () => {
  it("retryable 且未到上限时重试", () => {
    expect(shouldRetrySuperFailure("retryable", 1, 3)).toBe(true);
    expect(shouldRetrySuperFailure("retryable", 2, 3)).toBe(true);
    expect(shouldRetrySuperFailure("retryable", 0, 1)).toBe(true);
  });

  it("retryable 到达或超过上限时不再重试", () => {
    expect(shouldRetrySuperFailure("retryable", 3, 3)).toBe(false);
    expect(shouldRetrySuperFailure("retryable", 4, 3)).toBe(false);
    expect(shouldRetrySuperFailure("retryable", 100, 100)).toBe(false);
  });

  it("terminal / blocked / interrupted 在任何次数下都不重试", () => {
    const nonRetryable: SuperFailureKind[] = ["terminal", "blocked", "interrupted"];
    for (const kind of nonRetryable) {
      expect(shouldRetrySuperFailure(kind, 1, 3)).toBe(false);
      expect(shouldRetrySuperFailure(kind, 2, 3)).toBe(false);
      expect(shouldRetrySuperFailure(kind, 3, 3)).toBe(false);
      expect(shouldRetrySuperFailure(kind, 0, 100)).toBe(false);
    }
  });

  it("上限为 0 / 负数时不重试（保守退化）", () => {
    expect(shouldRetrySuperFailure("retryable", 0, 0)).toBe(false);
    expect(shouldRetrySuperFailure("retryable", 1, 0)).toBe(false);
    expect(shouldRetrySuperFailure("retryable", 0, -1)).toBe(false);
    expect(shouldRetrySuperFailure("terminal", 0, -1)).toBe(false);
  });

  it("非有限数入参不重试", () => {
    expect(shouldRetrySuperFailure("retryable", Number.NaN, 3)).toBe(false);
    expect(shouldRetrySuperFailure("retryable", 1, Number.NaN)).toBe(false);
  });
});
