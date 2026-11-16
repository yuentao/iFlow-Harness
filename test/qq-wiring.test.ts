import { describe, expect, it } from "vitest";
import type { QqConfig } from "../src/qq/config.js";
import {
  generateBindCode,
  isBindCodeValid,
  isTerminalSuperStatus,
  QQ_BIND_CODE_LENGTH,
  QQ_BIND_CODE_TTL_MS,
  shouldRestartOnPatch,
} from "../src/qq/wiring.js";

/** 一份完整配置（只用于 shouldRestartOnPatch 的比较基准）。 */
function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    adapter: "onebot",
    endpoint: "http://127.0.0.1:3000/",
    bridgePort: 0,
    allowedUsers: ["10001"],
    allowedGroups: [],
    workspace: "",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 6,
    resultDetail: "standard",
    autoMerge: false,
    ...overrides,
  };
}

describe("generateBindCode", () => {
  it("生成 6 位大写字母数字，并在 5 分钟后过期", () => {
    const now = 1_700_000_000_000;
    // 0.0 → A；0.5 → S（18/36）；0.9999 → 9
    const samples = [0, 0.5, 0.9999, 0.25, 0.75, 0.1];
    let cursor = 0;
    const rng = () => samples[cursor++ % samples.length]!;
    const bind = generateBindCode(rng, now);
    expect(bind.code).toHaveLength(QQ_BIND_CODE_LENGTH);
    expect(bind.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(bind.expiresAt).toBe(now + QQ_BIND_CODE_TTL_MS);
    expect(bind.code[0]).toBe("A");
    expect(bind.code[1]).toBe("S");
    expect(bind.code[2]).toBe("9");
  });

  it("脏随机源（NaN / 负数 / 超过 1）不会产出空码或越界", () => {
    const values = [Number.NaN, -5, 5, Number.POSITIVE_INFINITY];
    let cursor = 0;
    const code = generateBindCode(() => values[cursor++ % values.length]!, 0).code;
    expect(code).toHaveLength(QQ_BIND_CODE_LENGTH);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("默认参数在真实随机源下依然合法", () => {
    const code = generateBindCode().code;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });
});

describe("isBindCodeValid", () => {
  const now = 1_000_000;
  const bind = { code: "AB12CD", expiresAt: now + 1_000 };

  it("码匹配且未过期 → true", () => {
    expect(isBindCodeValid(bind, "AB12CD", now)).toBe(true);
  });

  it("小写 / 前后空白输入也接受（用户手打）", () => {
    expect(isBindCodeValid(bind, " ab12cd ", now)).toBe(true);
  });

  it("过期（含恰好到期）→ false", () => {
    expect(isBindCodeValid(bind, "AB12CD", now + 999)).toBe(true);
    expect(isBindCodeValid(bind, "AB12CD", now + 1_000)).toBe(false);
    expect(isBindCodeValid(bind, "AB12CD", now + 5_000)).toBe(false);
  });

  it("码不匹配 / 空码 / 没有记录 → false", () => {
    expect(isBindCodeValid(bind, "AB12CE", now)).toBe(false);
    expect(isBindCodeValid(bind, "", now)).toBe(false);
    expect(isBindCodeValid(bind, "   ", now)).toBe(false);
    expect(isBindCodeValid(undefined, "AB12CD", now)).toBe(false);
    expect(isBindCodeValid({ code: "", expiresAt: now + 1_000 }, "", now)).toBe(false);
  });

  it("过期时间不是有限数 → false（脏归档不能成为永久有效的码）", () => {
    expect(isBindCodeValid({ code: "AB12CD", expiresAt: Number.NaN }, "AB12CD", now)).toBe(false);
  });
});

describe("isTerminalSuperStatus", () => {
  it("只认三个终态", () => {
    expect(isTerminalSuperStatus("completed")).toBe(true);
    expect(isTerminalSuperStatus("failed")).toBe(true);
    expect(isTerminalSuperStatus("cancelled")).toBe(true);
  });

  it("运行态 / 未知值 / 缺省都不是终态", () => {
    expect(isTerminalSuperStatus("preparing")).toBe(false);
    expect(isTerminalSuperStatus("running")).toBe(false);
    expect(isTerminalSuperStatus("awaiting_input")).toBe(false);
    expect(isTerminalSuperStatus("merged")).toBe(false);
    expect(isTerminalSuperStatus("")).toBe(false);
    expect(isTerminalSuperStatus(undefined)).toBe(false);
    expect(isTerminalSuperStatus(null)).toBe(false);
  });
});

describe("shouldRestartOnPatch", () => {
  it("连接类字段变化 → true", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { enabled: false })).toBe(true);
    expect(shouldRestartOnPatch(prev, { adapter: "qqbot" })).toBe(true);
    expect(shouldRestartOnPatch(prev, { endpoint: "http://127.0.0.1:5700/" })).toBe(true);
    expect(shouldRestartOnPatch(prev, { bridgePort: 3100 })).toBe(true);
  });

  it("连接类字段同值 → false（不做无谓的 bridge 重启）", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { enabled: true, adapter: "onebot" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { endpoint: prev.endpoint, bridgePort: 0 })).toBe(false);
  });

  it("热更新字段 → false", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { allowedUsers: ["10002"] })).toBe(false);
    expect(shouldRestartOnPatch(prev, { allowedGroups: ["123456"] })).toBe(false);
    expect(shouldRestartOnPatch(prev, { workspace: "J:\\git\\proj" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { remotePolicy: "readonly" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { maxConcurrentTasks: 5 })).toBe(false);
    expect(shouldRestartOnPatch(prev, { rateLimitPerMin: 20 })).toBe(false);
    expect(shouldRestartOnPatch(prev, { resultDetail: "full" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { autoMerge: true })).toBe(false);
  });

  it("undefined 表示本次不改", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { enabled: undefined })).toBe(false);
    expect(shouldRestartOnPatch(prev, { enabled: undefined, endpoint: prev.endpoint })).toBe(false);
  });

  it("没有快照时有连接类改动 → true；空补丁 → false", () => {
    expect(shouldRestartOnPatch(undefined, { enabled: true })).toBe(true);
    expect(shouldRestartOnPatch(undefined, { allowedUsers: [] })).toBe(false);
    expect(shouldRestartOnPatch(undefined, {})).toBe(false);
    expect(shouldRestartOnPatch(makeConfig(), null)).toBe(false);
  });
});
