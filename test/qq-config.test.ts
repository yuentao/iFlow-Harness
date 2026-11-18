import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  QQ_SECRET_KEYS,
  checkQqStartupGate,
  isWorkspaceCompatible,
  normalizeQqConfig,
  validateQqConfig,
  type QqConfig,
  type QqConfigIssue,
} from "../src/qq/config.js";

/** 与 config.ts 的权威默认值一致（测试独立写一份，防止实现悄悄改默认值不被发现）。 */
const DEFAULTS: QqConfig = {
  enabled: false,
  route: "child",
  allowedUsers: [],
  allowedGroups: [],
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
};

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    ...DEFAULTS,
    allowedUsers: [...DEFAULTS.allowedUsers],
    allowedGroups: [...DEFAULTS.allowedGroups],
    ...overrides,
  };
}

/** 一条「已启用且白名单齐全」的基线。 */
function makeEnabled(overrides: Partial<QqConfig> = {}): QqConfig {
  return makeConfig({
    enabled: true,
    allowedUsers: ["10001"],
    ...overrides,
  });
}

function codes(issues: QqConfigIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("normalizeQqConfig", () => {
  it("空对象返回默认值且不产生 warning", () => {
    const { config, warnings } = normalizeQqConfig({});
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
  });

  it("已移除的 adapter / endpoint / bridgePort 键被忽略，不进配置也不产 warning", () => {
    const { config, warnings } = normalizeQqConfig({
      adapter: "legacy",
      endpoint: "http://127.0.0.1:3000/",
      bridgePort: 3000,
    });
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
  });

  it("字符串 trim，白名单数组去空白 / 去空项 / 去重并保持首次出现顺序", () => {
    const { config, warnings } = normalizeQqConfig({
      workspace: "  J:/work/qq  ",
      allowedUsers: [" 10001 ", "10001", "", "   ", "10002"],
      allowedGroups: [" 20002 ", "20002"],
    });
    expect(config.workspace).toBe("J:/work/qq");
    expect(config.allowedUsers).toEqual(["10001", "10002"]);
    expect(config.allowedGroups).toEqual(["20002"]);
    expect(warnings).toEqual([]);
  });

  it("白名单里的无效条目被跳过并汇总告警", () => {
    const { config, warnings } = normalizeQqConfig({
      allowedUsers: ["10001", 10002, null, true, { qq: 3 }],
    });
    expect(config.allowedUsers).toEqual(["10001"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("iflow.qq.allowedUsers");
    expect(warnings[0]).toContain("4 个无效条目");
  });

  it("白名单历史脏配置（脱敏串 / 非法字符 / 超长 / 过短）在读路径被过滤，只留合法 openid", () => {
    // 这些脏值过去只靠 webview UI 的 isValidQqId 挡住；手改 settings.json
    // 或历史遗留配置能绕过面板。归一函数现在统一挡住，读路径随之过滤 ——
    // 否则运行期精确匹配永远命不中真实用户，表现为「配了却静默失效」。
    const { config } = normalizeQqConfig({
      allowedUsers: [
        "10001",
        "D754********8D11", // 脱敏串（含 *）
        { openid: "user-2 ", note: "同事" }, // 首尾空格 trim 后合法
        { openid: "a".repeat(65) }, // 超长
        "abc", // 过短
        "群1234", // 非法字符
      ],
      allowedGroups: ["D754********8D11", "20002"],
    });
    expect(config.allowedUsers).toEqual(["10001", "user-2"]);
    expect(config.allowedGroups).toEqual(["20002"]);
  });

  it("带备注的 { openid, note } 条目只取完整 openid（运行期匹配不认备注/脱敏）", () => {
    const { config, warnings } = normalizeQqConfig({
      allowedUsers: [
        { openid: "D754D2240C503C2ABE2B236DC1E78D11", note: "同事" },
        { openid: " user-2 " },
      ],
      allowedGroups: [{ openid: "group-1", note: "测试群" }],
    });
    expect(config.allowedUsers).toEqual(["D754D2240C503C2ABE2B236DC1E78D11", "user-2"]);
    expect(config.allowedGroups).toEqual(["group-1"]);
    expect(warnings).toEqual([]);
  });

  it("数字项先四舍五入取整，越界再裁剪到允许范围", () => {
    const rounded = normalizeQqConfig({ maxConcurrentTasks: 3.6 });
    expect(rounded.config.maxConcurrentTasks).toBe(4);
    expect(rounded.warnings).toHaveLength(1);
    expect(rounded.warnings[0]).toContain("iflow.qq.maxConcurrentTasks");

    const clamped = normalizeQqConfig({
      maxConcurrentTasks: 99,
      rateLimitPerMin: 0.2,
    });
    expect(clamped.config.maxConcurrentTasks).toBe(10);
    // 0.2 先四舍五入为 0，再被下限夹到 1。
    expect(clamped.config.rateLimitPerMin).toBe(1);
    expect(clamped.warnings).toHaveLength(2);

    const high = normalizeQqConfig({ rateLimitPerMin: 60.7 });
    expect(high.config.rateLimitPerMin).toBe(60);
    expect(high.warnings).toHaveLength(1);
  });

  it("数字项类型不符 / 非有限数回退默认值并告警", () => {
    const { config, warnings } = normalizeQqConfig({
      maxConcurrentTasks: "3",
      rateLimitPerMin: Number.NaN,
    });
    expect(config.maxConcurrentTasks).toBe(2);
    expect(config.rateLimitPerMin).toBe(6);
    expect(warnings).toHaveLength(2);
  });

  it("非法枚举值回退默认值并告警，合法值允许首尾空白", () => {
    const invalid = normalizeQqConfig({
      remotePolicy: "yolo",
      resultDetail: "verbose",
    });
    expect(invalid.config.remotePolicy).toBe("supervised");
    expect(invalid.config.resultDetail).toBe("standard");
    expect(invalid.warnings).toHaveLength(2);
    expect(invalid.warnings.join("\n")).toContain("iflow.qq.remotePolicy");
    expect(invalid.warnings.join("\n")).toContain("iflow.qq.resultDetail");

    const trimmed = normalizeQqConfig({
      remotePolicy: " trusted ",
      resultDetail: " full ",
    });
    expect(trimmed.config.remotePolicy).toBe("trusted");
    expect(trimmed.config.resultDetail).toBe("full");
    expect(trimmed.warnings).toEqual([]);
  });

  it("remotePolicy=readonly 归一化后保留，且不产生免确认 warning", () => {
    const { config, warnings } = normalizeQqConfig({ remotePolicy: "readonly" });
    expect(config.remotePolicy).toBe("readonly");
    expect(warnings).toEqual([]);
    expect(validateQqConfig(config)).toEqual([]);
  });

  it("旧枚举值 resultDetail=detailed 回退 standard 并告警", () => {
    const { config, warnings } = normalizeQqConfig({ resultDetail: "detailed" });
    expect(config.resultDetail).toBe("standard");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("iflow.qq.resultDetail");
    expect(warnings[0]).toContain("summary / standard / full");
  });

  it("字符串 / 布尔 / 数组类型不符都回退默认值并告警", () => {
    const { config, warnings } = normalizeQqConfig({
      enabled: "true",
      autoMerge: 1,
      allowedGroups: "20002",
    });
    expect(config.enabled).toBe(false);
    expect(config.autoMerge).toBe(false);
    expect(config.allowedGroups).toEqual([]);
    expect(warnings).toHaveLength(3);
  });

  it("未知字段被忽略", () => {
    const { config, warnings } = normalizeQqConfig({ unknownKey: "x", other: 42 });
    expect(config).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
  });
});

describe("validateQqConfig", () => {
  it("默认（未启用）配置没有任何 issue", () => {
    expect(validateQqConfig(makeConfig())).toEqual([]);
  });

  it("启用但白名单为空时报 allowlist_empty（warning，不拦启动）", () => {
    const issues = validateQqConfig(makeConfig({ enabled: true }));
    expect(codes(issues)).toEqual(["allowlist_empty"]);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("启用且白名单齐全时无 issue", () => {
    expect(validateQqConfig(makeEnabled())).toEqual([]);
  });

  it("只有群白名单也算有白名单", () => {
    const issues = validateQqConfig(
      makeEnabled({ allowedUsers: [], allowedGroups: ["20002"] }),
    );
    expect(issues).toEqual([]);
  });

  it("workspace 非绝对路径报 warning，且不再做 roots 检查", () => {
    const root = path.resolve(".");
    const issues = validateQqConfig(makeConfig({ workspace: "relative/nested" }), [root]);
    expect(codes(issues)).toEqual(["workspace_relative"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("workspace 落在 roots 之内时通过，落在 roots 之外报 error", () => {
    const root = path.resolve(".");
    const inside = path.join(root, "packages", "qq");
    expect(validateQqConfig(makeConfig({ workspace: inside }), [root])).toEqual([]);
    expect(validateQqConfig(makeConfig({ workspace: root }), [root])).toEqual([]);

    const outside = path.resolve(root, "..", "qq-elsewhere");
    const issues = validateQqConfig(makeConfig({ workspace: outside }), [root]);
    expect(codes(issues)).toEqual(["workspace_not_in_roots"]);
    expect(issues[0]?.severity).toBe("error");
  });

  it("不传 roots 时跳过 workspace 归属检查", () => {
    const outside = path.resolve(path.resolve("."), "..", "qq-elsewhere");
    expect(validateQqConfig(makeConfig({ workspace: outside }))).toEqual([]);
  });

  it("remotePolicy=trusted 报免确认 warning", () => {
    const issues = validateQqConfig(makeConfig({ remotePolicy: "trusted" }));
    expect(codes(issues)).toEqual(["trusted_policy"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("多个问题同时返回", () => {
    const issues = validateQqConfig(
      makeEnabled({
        allowedUsers: [],
        remotePolicy: "trusted",
      }),
    );
    expect(codes(issues)).toEqual(["allowlist_empty", "trusted_policy"]);
  });
});

describe("启动门控（checkQqStartupGate）", () => {
  const root = path.resolve(".");

  it("workspace 留空时门控通过", () => {
    expect(checkQqStartupGate(makeEnabled(), root)).toEqual([]);
    expect(isWorkspaceCompatible(makeConfig({ workspace: "   " }), root)).toBe(true);
  });

  it("workspace 等于当前工作区根时门控通过（忽略大小写与尾部分隔符）", () => {
    expect(checkQqStartupGate(makeEnabled({ workspace: root }), root)).toEqual([]);
    const variant = process.platform === "win32" ? root.toUpperCase() : root;
    expect(isWorkspaceCompatible(makeConfig({ workspace: root }), root)).toBe(true);
    expect(isWorkspaceCompatible(makeConfig({ workspace: variant }), root)).toBe(true);
    expect(isWorkspaceCompatible(makeConfig({ workspace: `${root}${path.sep}` }), root)).toBe(
      true,
    );
  });

  it("workspace 指向其他根或当前根的子目录时报 workspace_not_active_root", () => {
    const otherRoot = path.resolve(root, "..", "qq-elsewhere");
    for (const workspace of [otherRoot, path.join(root, "packages", "qq")]) {
      const issues = checkQqStartupGate(makeEnabled({ workspace }), root);
      expect(codes(issues)).toEqual(["workspace_not_active_root"]);
      expect(issues[0]?.severity).toBe("error");
      expect(issues[0]?.message).toContain("当前工作区");
    }
  });

  it("没有激活工作区根时任何非空 workspace 都不兼容", () => {
    expect(isWorkspaceCompatible(makeConfig({ workspace: root }), undefined)).toBe(false);
    expect(isWorkspaceCompatible(makeConfig({ workspace: root }), null)).toBe(false);
    expect(isWorkspaceCompatible(makeConfig({ workspace: root }), "")).toBe(false);
    // 留空仍兼容：任务就是落在当前（不存在的）工作区上，交给后续启动失败。
    expect(isWorkspaceCompatible(makeConfig({ workspace: "" }), undefined)).toBe(true);
  });

  it("workspace 不匹配时只报 workspace_not_active_root", () => {
    const issues = checkQqStartupGate(
      makeEnabled({ workspace: path.resolve(root, "..", "qq-elsewhere") }),
      root,
    );
    expect(codes(issues)).toEqual(["workspace_not_active_root"]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });
});

describe("QQ_SECRET_KEYS", () => {
  it("三个键名互不相同且都限定在 iflow.qq 命名空间", () => {
    expect(Object.keys(QQ_SECRET_KEYS).sort()).toEqual([
      "appSecret",
      "bridgeToken",
      "signingSecret",
    ]);
    const values = Object.values(QQ_SECRET_KEYS);
    expect(new Set(values).size).toBe(3);
    expect(values.every((value) => value.startsWith("iflow.qq."))).toBe(true);
  });
});