import { describe, expect, it } from "vitest";
import {
  pickQqSettingsUi,
  type HostToWebview,
  type QqSettingsUi,
  type WebviewToHost,
} from "../shared/messages.js";

const SECRETS_OFF = { hasBotToken: false, hasAppSecret: false };

/** 完整默认值（与 src/qq/config.ts 的 DEFAULTS 保持一致）。 */
const DEFAULTS: QqSettingsUi = {
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
  hasBotToken: false,
  hasAppSecret: false,
};

describe("pickQqSettingsUi", () => {
  it("空输入返回宿主默认值", () => {
    expect(pickQqSettingsUi({}, SECRETS_OFF)).toEqual(DEFAULTS);
  });

  it("非对象输入按空对象处理（不抛错）", () => {
    expect(pickQqSettingsUi(null as unknown as Record<string, unknown>, SECRETS_OFF)).toEqual(
      DEFAULTS,
    );
    expect(
      pickQqSettingsUi(["enabled"] as unknown as Record<string, unknown>, SECRETS_OFF),
    ).toEqual(DEFAULTS);
  });

  it("非法枚举回退默认值", () => {
    const ui = pickQqSettingsUi(
      { adapter: "napcat", remotePolicy: "yolo", resultDetail: "compact" },
      SECRETS_OFF,
    );
    expect(ui.adapter).toBe("onebot");
    expect(ui.remotePolicy).toBe("supervised");
    expect(ui.resultDetail).toBe("standard");
  });

  it("合法枚举原样保留（含 readonly / summary / full）", () => {
    const ui = pickQqSettingsUi(
      { adapter: " qqbot ", remotePolicy: "readonly", resultDetail: "full" },
      SECRETS_OFF,
    );
    expect(ui.adapter).toBe("qqbot");
    expect(ui.remotePolicy).toBe("readonly");
    expect(ui.resultDetail).toBe("full");
  });

  it("数字先取整再裁剪到允许范围（与 src/qq/config.ts 的 RANGES 同口径）", () => {
    const ui = pickQqSettingsUi(
      { bridgePort: 70000.4, maxConcurrentTasks: 0, rateLimitPerMin: 4.6 },
      SECRETS_OFF,
    );
    expect(ui.bridgePort).toBe(65535);
    expect(ui.maxConcurrentTasks).toBe(1);
    expect(ui.rateLimitPerMin).toBe(5);

    const low = pickQqSettingsUi(
      { bridgePort: -3, maxConcurrentTasks: 99, rateLimitPerMin: 0 },
      SECRETS_OFF,
    );
    expect(low.bridgePort).toBe(0);
    expect(low.maxConcurrentTasks).toBe(10);
    expect(low.rateLimitPerMin).toBe(1);
  });

  it("数字类型不符 / 非有限值回退默认值", () => {
    const ui = pickQqSettingsUi(
      {
        bridgePort: "3000",
        maxConcurrentTasks: Number.NaN,
        rateLimitPerMin: Number.POSITIVE_INFINITY,
      },
      SECRETS_OFF,
    );
    expect(ui.bridgePort).toBe(0);
    expect(ui.maxConcurrentTasks).toBe(2);
    expect(ui.rateLimitPerMin).toBe(6);
  });

  it("字符串 trim，布尔类型不符回退默认值", () => {
    const ui = pickQqSettingsUi(
      { enabled: "true", endpoint: "  http://127.0.0.1:3000  ", workspace: "  ", autoMerge: 1 },
      SECRETS_OFF,
    );
    expect(ui.enabled).toBe(false);
    expect(ui.endpoint).toBe("http://127.0.0.1:3000");
    expect(ui.workspace).toBe("");
    expect(ui.autoMerge).toBe(false);
  });

  it("白名单去空白、去空项、去重（保持首次出现顺序），非字符串项跳过", () => {
    const ui = pickQqSettingsUi(
      {
        allowedUsers: [" 123 ", "123", "", "456", 789, null],
        allowedGroups: "not-an-array",
      },
      SECRETS_OFF,
    );
    expect(ui.allowedUsers).toEqual(["123", "456"]);
    expect(ui.allowedGroups).toEqual([]);
  });

  it("has* 只透传布尔投影，返回值不含任何 secret 明文键", () => {
    const ui = pickQqSettingsUi(
      // 即便输入里混进明文凭据，也不能进入返回值。
      { botToken: "secret-token", appSecret: "secret-app", enabled: true },
      { hasBotToken: true, hasAppSecret: false },
    );
    expect(ui.hasBotToken).toBe(true);
    expect(ui.hasAppSecret).toBe(false);
    expect(ui.enabled).toBe(true);

    const keys = Object.keys(ui);
    expect(keys).not.toContain("botToken");
    expect(keys).not.toContain("appSecret");
    expect(keys.sort()).toEqual(
      [
        "adapter",
        "allowedGroups",
        "allowedUsers",
        "autoMerge",
        "bridgePort",
        "enabled",
        "endpoint",
        "hasAppSecret",
        "hasBotToken",
        "maxConcurrentTasks",
        "rateLimitPerMin",
        "remotePolicy",
        "resultDetail",
        "workspace",
      ].sort(),
    );
    expect(JSON.stringify(ui)).not.toContain("secret-token");
    expect(JSON.stringify(ui)).not.toContain("secret-app");
  });
});

describe("QQ 设置消息契约", () => {
  it("HostToWebview 含 qqSettings / qqStatus，且保留 qqBindCode 与 qqConfigAction", () => {
    const settings: HostToWebview = {
      type: "qqSettings",
      values: pickQqSettingsUi({}, { hasBotToken: true, hasAppSecret: true }),
    };
    const status: HostToWebview = { type: "qqStatus", connected: false, detail: "连接被拒绝" };
    const bindCode: HostToWebview = { type: "qqBindCode", code: "K7Q2", expiresAt: 1 };
    const configAction: HostToWebview = { type: "qqConfigAction", action: "testConnection" };

    expect(settings.type).toBe("qqSettings");
    expect(settings.values.hasBotToken).toBe(true);
    expect(status.type).toBe("qqStatus");
    expect(bindCode.code).toBe("K7Q2");
    expect(configAction.action).toBe("testConnection");
  });

  it("WebviewToHost 含 qqSettingsPatch / qqSecretsWrite，且保留 qqTaskAction", () => {
    const patch: WebviewToHost = {
      type: "qqSettingsPatch",
      patch: { enabled: true, adapter: "qqbot", maxConcurrentTasks: 4 },
    };
    /** 空串表示清空该凭据；只在用户真的输入新值时带字段。 */
    const write: WebviewToHost = { type: "qqSecretsWrite", botToken: "" };
    const clearBoth: WebviewToHost = { type: "qqSecretsWrite" };
    const taskAction: WebviewToHost = { type: "qqTaskAction", taskId: "T-1", action: "refresh" };

    expect(patch.type).toBe("qqSettingsPatch");
    expect(patch.patch.adapter).toBe("qqbot");
    expect(write.botToken).toBe("");
    expect(clearBoth.appSecret).toBeUndefined();
    expect(taskAction.action).toBe("refresh");
  });

  it("qqSettingsPatch 的补丁只允许设置字段（类型层面 Partial<QqSettingsUi>）", () => {
    const ui = pickQqSettingsUi({}, SECRETS_OFF);
    const patch: Partial<QqSettingsUi> = { resultDetail: "summary", autoMerge: true };
    const merged: QqSettingsUi = { ...ui, ...patch };
    expect(merged.resultDetail).toBe("summary");
    expect(merged.autoMerge).toBe(true);
  });
});
