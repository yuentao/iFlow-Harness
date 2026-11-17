import { describe, expect, it } from "vitest";
import {
  pickQqSettingsUi,
  type HostToWebview,
  type QqSettingsUi,
  type WebviewToHost,
} from "../shared/messages.js";

const SECRETS_OFF = { hasAppSecret: false };

/** 完整默认值（与 src/qq/config.ts 的 DEFAULTS 保持一致）。 */
const DEFAULTS: QqSettingsUi = {
  enabled: false,
  allowedUsers: [],
  allowedGroups: [],
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
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
      { remotePolicy: "yolo", resultDetail: "compact" },
      SECRETS_OFF,
    );
    expect(ui.remotePolicy).toBe("supervised");
    expect(ui.resultDetail).toBe("standard");
  });

  it("合法枚举原样保留（含 readonly / summary / full）", () => {
    const ui = pickQqSettingsUi(
      { remotePolicy: " readonly ", resultDetail: " full " },
      SECRETS_OFF,
    );
    expect(ui.remotePolicy).toBe("readonly");
    expect(ui.resultDetail).toBe("full");
  });

  it("数字先取整再裁剪到允许范围（与 src/qq/config.ts 的 RANGES 同口径）", () => {
    const ui = pickQqSettingsUi(
      { maxConcurrentTasks: 0, rateLimitPerMin: 4.6 },
      SECRETS_OFF,
    );
    expect(ui.maxConcurrentTasks).toBe(1);
    expect(ui.rateLimitPerMin).toBe(5);

    const low = pickQqSettingsUi(
      { maxConcurrentTasks: 99, rateLimitPerMin: 0 },
      SECRETS_OFF,
    );
    expect(low.maxConcurrentTasks).toBe(10);
    expect(low.rateLimitPerMin).toBe(1);
  });

  it("数字类型不符 / 非有限值回退默认值", () => {
    const ui = pickQqSettingsUi(
      {
        maxConcurrentTasks: Number.NaN,
        rateLimitPerMin: Number.POSITIVE_INFINITY,
      },
      SECRETS_OFF,
    );
    expect(ui.maxConcurrentTasks).toBe(2);
    expect(ui.rateLimitPerMin).toBe(6);
  });

  it("字符串 trim，布尔类型不符回退默认值", () => {
    const ui = pickQqSettingsUi(
      { enabled: "true", workspace: "  ", autoMerge: 1 },
      SECRETS_OFF,
    );
    expect(ui.enabled).toBe(false);
    expect(ui.workspace).toBe("");
    expect(ui.autoMerge).toBe(false);
  });

  it("白名单去空白、去空项、去重（保持首次出现顺序），非法项跳过", () => {
    const ui = pickQqSettingsUi(
      {
        allowedUsers: [" 123 ", "123", "", "456", 789, null],
        allowedGroups: "not-an-array",
      },
      SECRETS_OFF,
    );
    expect(ui.allowedUsers).toEqual([{ openid: "123" }, { openid: "456" }]);
    expect(ui.allowedGroups).toEqual([]);
  });

  it("白名单兼容旧的裸字符串与新的 { openid, note } 条目（用户与群同口径）", () => {
    const ui = pickQqSettingsUi(
      {
        allowedUsers: [
          "legacy-openid",
          { openid: " user-2 ", note: " 同事 " },
          { openid: "user-3", note: "   " },
          { openid: "", note: "空 openid" },
        ],
        allowedGroups: [
          "12345678",
          { openid: " group-2 ", note: " 测试群 " },
          { openid: "group-3", note: "" },
        ],
      },
      SECRETS_OFF,
    );
    expect(ui.allowedUsers).toEqual([
      { openid: "legacy-openid" },
      { openid: "user-2", note: "同事" },
      { openid: "user-3" },
    ]);
    expect(ui.allowedGroups).toEqual([
      { openid: "12345678" },
      { openid: "group-2", note: "测试群" },
      { openid: "group-3" },
    ]);
  });

  it("hasAppSecret 只透传布尔投影，返回值不含任何 secret 明文键", () => {
    const ui = pickQqSettingsUi(
      // 即便输入里混进明文凭据，也不能进入返回值。
      { botToken: "secret-token", appSecret: "secret-app", enabled: true },
      { hasAppSecret: true },
    );
    expect(ui.hasAppSecret).toBe(true);
    expect(ui.enabled).toBe(true);

    const keys = Object.keys(ui);
    expect(keys).not.toContain("botToken");
    expect(keys).not.toContain("appSecret");
    expect(keys.sort()).toEqual(
      [
        "allowedGroups",
        "allowedUsers",
        "autoMerge",
        "enabled",
        "hasAppSecret",
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
  it("HostToWebview 含 qqSettings / qqStatus / qqPendingUsers", () => {
    const settings: HostToWebview = {
      type: "qqSettings",
      values: pickQqSettingsUi({}, { hasAppSecret: true }),
    };
    const status: HostToWebview = { type: "qqStatus", connected: false, detail: "连接被拒绝" };
    const pending: HostToWebview = {
      type: "qqPendingUsers",
      users: [
        {
          openid: "open-1",
          firstSeenAt: 1,
          lastSeenAt: 2,
          count: 1,
          preview: "帮我跑个测试",
          chatType: "private",
        },
      ],
    };

    // 方向断言：qqConfigAction 是 webview → 宿主的请求，宿主 → webview 的联合
    // 里必须解析为 never。若哪天又被写回 HostToWebview，这里的类型条件会变成
    // false，赋值给 `true` 会在 tsc 下报错。
    type HostConfigAction = Extract<HostToWebview, { type: "qqConfigAction" }>;
    const hostHasNoConfigAction: [HostConfigAction] extends [never] ? true : false = true;
    expect(hostHasNoConfigAction).toBe(true);

    expect(settings.type).toBe("qqSettings");
    expect(settings.values.hasAppSecret).toBe(true);
    expect(status.type).toBe("qqStatus");
    expect(pending.users[0]?.openid).toBe("open-1");

    // 配对码消息已随授权模型移除：宿主联合里不得再出现 qqBindCode。
    type BindCodeMessage = Extract<HostToWebview, { type: "qqBindCode" }>;
    const noBindCode: [BindCodeMessage] extends [never] ? true : false = true;
    expect(noBindCode).toBe(true);
  });

  it("WebviewToHost 含 qqSettingsPatch / qqConfigAction，且保留 qqTaskAction", () => {
    const patch: WebviewToHost = {
      type: "qqSettingsPatch",
      patch: { enabled: true, maxConcurrentTasks: 4 },
    };
    const taskAction: WebviewToHost = { type: "qqTaskAction", taskId: "T-1", action: "refresh" };
    const configAction: WebviewToHost = { type: "qqConfigAction", action: "testConnection" };

    // 手填凭据通道已移除：消息联合里不得再出现 qqSecretsWrite。
    type SecretsWrite = Extract<WebviewToHost, { type: "qqSecretsWrite" }>;
    const noSecretsWrite: [SecretsWrite] extends [never] ? true : false = true;
    expect(noSecretsWrite).toBe(true);

    expect(patch.type).toBe("qqSettingsPatch");
    expect(patch.patch.enabled).toBe(true);
    expect(taskAction.action).toBe("refresh");
    expect(configAction.action).toBe("testConnection");
  });

  it("qqSettingsPatch 的补丁只允许设置字段（类型层面 Partial<QqSettingsUi>）", () => {
    const ui = pickQqSettingsUi({}, SECRETS_OFF);
    const patch: Partial<QqSettingsUi> = { resultDetail: "summary", autoMerge: true };
    const merged: QqSettingsUi = { ...ui, ...patch };
    expect(merged.resultDetail).toBe("summary");
    expect(merged.autoMerge).toBe(true);
  });
});
