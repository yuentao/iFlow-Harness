import { describe, expect, it } from "vitest";
import type { QqConfig } from "../src/qq/config.js";
import {
  isTerminalSuperStatus,
  planQqWorkspaceChange,
  qqWorkspaceRootsChanged,
  shouldRestartOnPatch,
} from "../src/qq/wiring.js";

/** 一份完整配置（只用于 shouldRestartOnPatch 的比较基准）。 */
function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
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

describe("isTerminalSuperStatus", () => {
  it("标准终态与上游别名都判终态（大小写/空白不敏感）", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "done",
      "error",
      "aborted",
      "interrupted",
      "merged",
      " COMPLETED ",
    ]) {
      expect(isTerminalSuperStatus(status)).toBe(true);
    }
  });

  it("运行态 / 未知值 / 缺省都不是终态", () => {
    expect(isTerminalSuperStatus("preparing")).toBe(false);
    expect(isTerminalSuperStatus("running")).toBe(false);
    expect(isTerminalSuperStatus("awaiting_input")).toBe(false);
    expect(isTerminalSuperStatus("")).toBe(false);
    expect(isTerminalSuperStatus("???")).toBe(false);
    expect(isTerminalSuperStatus(undefined)).toBe(false);
    expect(isTerminalSuperStatus(null)).toBe(false);
  });
});

describe("shouldRestartOnPatch", () => {
  it("唯一连接类字段 enabled 变化 → true", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { enabled: false })).toBe(true);
  });

  it("enabled 同值 → false（不做无谓的重启）", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { enabled: true })).toBe(false);
  });

  it("已移除的 adapter / endpoint / bridgePort 键不再触发重启", () => {
    const prev = makeConfig();
    expect(shouldRestartOnPatch(prev, { adapter: "qqbot" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { endpoint: "http://127.0.0.1:5700/" })).toBe(false);
    expect(shouldRestartOnPatch(prev, { bridgePort: 3100 })).toBe(false);
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
  });

  it("没有快照时有连接类改动 → true；空补丁 → false", () => {
    expect(shouldRestartOnPatch(undefined, { enabled: true })).toBe(true);
    expect(shouldRestartOnPatch(undefined, { allowedUsers: [] })).toBe(false);
    expect(shouldRestartOnPatch(undefined, {})).toBe(false);
    expect(shouldRestartOnPatch(makeConfig(), null)).toBe(false);
  });
});

describe("工作区根集合变化", () => {
  it("根集合逐项相同 → false（大小写 / 尾分隔符归一）", () => {
    expect(qqWorkspaceRootsChanged(["J:\\git\\a"], ["j:\\git\\a"])).toBe(false);
    expect(qqWorkspaceRootsChanged(["J:\\git\\a\\"], ["J:\\git\\a"])).toBe(false);
    expect(qqWorkspaceRootsChanged([], [])).toBe(false);
    expect(qqWorkspaceRootsChanged(undefined, [])).toBe(false);
    expect(qqWorkspaceRootsChanged(null, [])).toBe(false);
  });

  it("增删 / 换根 → true", () => {
    expect(qqWorkspaceRootsChanged([], ["J:\\git\\a"])).toBe(true);
    expect(qqWorkspaceRootsChanged(["J:\\git\\a"], [])).toBe(true);
    expect(qqWorkspaceRootsChanged(["J:\\git\\a"], ["J:\\git\\b"])).toBe(true);
    expect(
      qqWorkspaceRootsChanged(["J:\\git\\a"], ["J:\\git\\a", "J:\\git\\b"]),
    ).toBe(true);
  });

  it("顺序变化也算变化（roots[0] 决定 cwd）", () => {
    expect(
      qqWorkspaceRootsChanged(["J:\\git\\a", "J:\\git\\b"], ["J:\\git\\b", "J:\\git\\a"]),
    ).toBe(true);
  });

  it("根没变 → noop（不打断在跑的通道）", () => {
    expect(
      planQqWorkspaceChange({
        previousRoots: ["J:\\git\\a"],
        nextRoots: ["J:\\git\\a"],
        running: true,
      }),
    ).toBe("noop");
  });

  it("有现场 → restart（旧连接先释放，再按新根重建）", () => {
    expect(
      planQqWorkspaceChange({
        previousRoots: ["J:\\git\\a"],
        nextRoots: ["J:\\git\\b"],
        running: true,
      }),
    ).toBe("restart");
  });

  it("没有现场 → start（空窗口打开文件夹后按新工作区补起）", () => {
    expect(
      planQqWorkspaceChange({
        previousRoots: [],
        nextRoots: ["J:\\git\\b"],
        running: false,
      }),
    ).toBe("start");
  });
});
