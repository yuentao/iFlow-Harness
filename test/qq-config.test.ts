import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  QQ_RESERVED_BRIDGE_PORTS,
  QQ_SECRET_KEYS,
  buildBridgeEnv,
  normalizeQqConfig,
  validateQqConfig,
  type QqConfig,
  type QqConfigIssue,
} from "../src/qq/config.js";

/** 与 config.ts 的权威默认值一致（测试独立写一份，防止实现悄悄改默认值不被发现）。 */
const DEFAULTS: QqConfig = {
  enabled: false,
  adapter: "onebot",
  endpoint: "",
  bridgePort: 0,
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

/** 一条「已启用且配置完整」的基线（endpoint + 用户白名单齐全）。 */
function makeEnabled(overrides: Partial<QqConfig> = {}): QqConfig {
  return makeConfig({
    enabled: true,
    endpoint: "http://127.0.0.1:3000/",
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

  it("字符串 trim，白名单数组去空白 / 去空项 / 去重并保持首次出现顺序", () => {
    const { config, warnings } = normalizeQqConfig({
      endpoint: "  http://127.0.0.1:3000/  ",
      workspace: "  J:/work/qq  ",
      allowedUsers: [" 10001 ", "10001", "", "   ", "10002"],
      allowedGroups: [" 20002 ", "20002"],
    });
    expect(config.endpoint).toBe("http://127.0.0.1:3000/");
    expect(config.workspace).toBe("J:/work/qq");
    expect(config.allowedUsers).toEqual(["10001", "10002"]);
    expect(config.allowedGroups).toEqual(["20002"]);
    expect(warnings).toEqual([]);
  });

  it("白名单里的非字符串项被跳过并汇总告警", () => {
    const { config, warnings } = normalizeQqConfig({
      allowedUsers: ["10001", 10002, null, true, { qq: 3 }],
    });
    expect(config.allowedUsers).toEqual(["10001"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("iflow.qq.allowedUsers");
    expect(warnings[0]).toContain("4 个非字符串项");
  });

  it("数字项先四舍五入取整，越界再裁剪到允许范围", () => {
    const rounded = normalizeQqConfig({ maxConcurrentTasks: 3.6 });
    expect(rounded.config.maxConcurrentTasks).toBe(4);
    expect(rounded.warnings).toHaveLength(1);
    expect(rounded.warnings[0]).toContain("iflow.qq.maxConcurrentTasks");

    const clamped = normalizeQqConfig({
      maxConcurrentTasks: 99,
      rateLimitPerMin: 0.2,
      bridgePort: -5,
    });
    expect(clamped.config.maxConcurrentTasks).toBe(10);
    // 0.2 先四舍五入为 0，再被下限夹到 1。
    expect(clamped.config.rateLimitPerMin).toBe(1);
    expect(clamped.config.bridgePort).toBe(0);
    expect(clamped.warnings).toHaveLength(3);

    const high = normalizeQqConfig({ bridgePort: 65535.7 });
    expect(high.config.bridgePort).toBe(65535);
    expect(high.warnings).toHaveLength(1);
  });

  it("数字项类型不符 / 非有限数回退默认值并告警", () => {
    const { config, warnings } = normalizeQqConfig({
      maxConcurrentTasks: "3",
      rateLimitPerMin: null,
      bridgePort: Number.NaN,
    });
    expect(config.maxConcurrentTasks).toBe(2);
    expect(config.rateLimitPerMin).toBe(6);
    expect(config.bridgePort).toBe(0);
    expect(warnings).toHaveLength(3);
  });

  it("adapter=qqbot 归一化后保留", () => {
    const { config, warnings } = normalizeQqConfig({ adapter: "qqbot" });
    expect(config.adapter).toBe("qqbot");
    expect(warnings).toEqual([]);
  });

  it("adapter=official（废弃枚举值）回退 onebot 并告警", () => {
    const { config, warnings } = normalizeQqConfig({ adapter: "official" });
    expect(config.adapter).toBe("onebot");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("iflow.qq.adapter");
    expect(warnings[0]).toContain("onebot / qqbot");
  });

  it("非法枚举值回退默认值并告警，合法值允许首尾空白", () => {
    const invalid = normalizeQqConfig({
      adapter: "napcat",
      remotePolicy: "yolo",
      resultDetail: "verbose",
    });
    expect(invalid.config.adapter).toBe("onebot");
    expect(invalid.config.remotePolicy).toBe("supervised");
    expect(invalid.config.resultDetail).toBe("standard");
    expect(invalid.warnings).toHaveLength(3);
    expect(invalid.warnings.join("\n")).toContain("iflow.qq.adapter");
    expect(invalid.warnings.join("\n")).toContain("iflow.qq.remotePolicy");
    expect(invalid.warnings.join("\n")).toContain("iflow.qq.resultDetail");

    const trimmed = normalizeQqConfig({
      adapter: "  onebot ",
      remotePolicy: " trusted ",
      resultDetail: " full ",
    });
    expect(trimmed.config.adapter).toBe("onebot");
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
      endpoint: 3000,
      autoMerge: 1,
      allowedGroups: "20002",
    });
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBe("");
    expect(config.autoMerge).toBe(false);
    expect(config.allowedGroups).toEqual([]);
    expect(warnings).toHaveLength(4);
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

  it("启用但缺 endpoint 与白名单时报两个 error", () => {
    const issues = validateQqConfig(makeConfig({ enabled: true }));
    expect(codes(issues)).toEqual(["endpoint_required", "allowlist_empty"]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("启用且 endpoint 与白名单齐全时无 issue", () => {
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

  it("bridgePort 命中 OneBot 后端默认端口时报 warning，其他端口不报", () => {
    for (const port of QQ_RESERVED_BRIDGE_PORTS) {
      const issues = validateQqConfig(makeConfig({ bridgePort: port }));
      expect(codes(issues)).toEqual(["bridge_port_conflict"]);
      expect(issues[0]?.severity).toBe("warning");
    }
    expect(validateQqConfig(makeConfig({ bridgePort: 0 }))).toEqual([]);
    expect(validateQqConfig(makeConfig({ bridgePort: 12345 }))).toEqual([]);
  });

  it("remotePolicy=trusted 报免确认 warning", () => {
    const issues = validateQqConfig(makeConfig({ remotePolicy: "trusted" }));
    expect(codes(issues)).toEqual(["trusted_policy"]);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("多个问题同时返回", () => {
    const issues = validateQqConfig(
      makeEnabled({
        endpoint: "",
        allowedUsers: [],
        remotePolicy: "trusted",
        bridgePort: 5700,
      }),
    );
    expect(codes(issues)).toEqual([
      "endpoint_required",
      "allowlist_empty",
      "bridge_port_conflict",
      "trusted_policy",
    ]);
  });
});

describe("buildBridgeEnv", () => {
  it("只产出 bridge 约定的 7 个键，且值全部是字符串", () => {
    const env = buildBridgeEnv(makeConfig({ endpoint: "http://127.0.0.1:3000/" }), {
      hostPort: 43123,
      bridgeToken: "bridge-token",
      hmacSecret: "hmac-secret",
      onebotToken: "onebot-token",
      incomingPort: 43124,
      incomingToken: "incoming-token",
    });

    expect(env).toEqual({
      IFLOW_QQ_HOST_PORT: "43123",
      IFLOW_QQ_BRIDGE_TOKEN: "bridge-token",
      IFLOW_QQ_HMAC_SECRET: "hmac-secret",
      IFLOW_QQ_ONEBOT_URL: "http://127.0.0.1:3000/",
      IFLOW_QQ_ONEBOT_TOKEN: "onebot-token",
      IFLOW_QQ_INCOMING_PORT: "43124",
      IFLOW_QQ_INCOMING_TOKEN: "incoming-token",
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "IFLOW_QQ_HOST_PORT",
        "IFLOW_QQ_BRIDGE_TOKEN",
        "IFLOW_QQ_HMAC_SECRET",
        "IFLOW_QQ_ONEBOT_URL",
        "IFLOW_QQ_ONEBOT_TOKEN",
        "IFLOW_QQ_INCOMING_PORT",
        "IFLOW_QQ_INCOMING_TOKEN",
      ].sort(),
    );
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });

  it("显式 onebotUrl 覆盖 config.endpoint", () => {
    const env = buildBridgeEnv(makeConfig({ endpoint: "http://127.0.0.1:3000/" }), {
      hostPort: 1,
      bridgeToken: "b",
      hmacSecret: "h",
      onebotToken: "o",
      onebotUrl: "http://10.0.0.2:5700/",
      incomingPort: 2,
      incomingToken: "i",
    });
    expect(env.IFLOW_QQ_ONEBOT_URL).toBe("http://10.0.0.2:5700/");
  });

  it("不把配置里的其他字段（含策略 / 白名单）塞进环境变量", () => {
    const env = buildBridgeEnv(
      makeEnabled({ adapter: "qqbot", autoMerge: true, resultDetail: "full" }),
      {
        hostPort: 1,
        bridgeToken: "b",
        hmacSecret: "h",
        onebotToken: "o",
        incomingPort: 2,
        incomingToken: "i",
      },
    );
    expect(env).not.toHaveProperty("IFLOW_QQ_AUTO_MERGE");
    expect(env).not.toHaveProperty("IFLOW_QQ_RESULT_DETAIL");
    expect(env).not.toHaveProperty("IFLOW_QQ_ALLOWED_USERS");
    expect(Object.keys(env)).toHaveLength(7);
  });
});

describe("QQ_SECRET_KEYS", () => {
  it("四个键名互不相同且都限定在 iflow.qq 命名空间", () => {
    expect(Object.keys(QQ_SECRET_KEYS).sort()).toEqual([
      "appSecret",
      "botToken",
      "bridgeToken",
      "signingSecret",
    ]);
    const values = Object.values(QQ_SECRET_KEYS);
    expect(new Set(values).size).toBe(4);
    expect(values.every((value) => value.startsWith("iflow.qq."))).toBe(true);
  });
});
