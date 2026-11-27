import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QQ_SETTING_KEYS,
  applyQqSettingsPatch,
  createShadowedOverrideNotice,
  createVscodeQqSettingsIo,
  ensureBridgeSecrets,
  findShadowedWorkspaceKeys,
  pickQqSettingValue,
  readEffectiveQqSettings,
  readQqSettings,
  type QqSettingScopes,
  type QqSettingsIo,
} from "../src/qq/settings-host.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import type { QqSettingsUi } from "../shared/messages.js";
import {
  enableConfigUpdateRecording,
  getConfigUpdates,
  resetConfigScopeValues,
  resetConfigUpdates,
  resetWorkspaceFoldersStub,
  setConfigScopeValues,
  setWorkspaceFolders,
} from "./vscode-stub.js";
import * as vscode from "vscode";

/** 完整默认值（与 shared/messages.ts 的 pickQqSettingsUi 默认一致）。 */
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

/** 纯内存假 IO：记录写入次数与 secret 读写，不依赖 vscode。 */
class MemoryIo implements QqSettingsIo {
  readonly settings: Record<string, unknown>;
  /** 可选的逐键作用域值：填了就按「Global 优先」解析（模拟真实 VSCode）。 */
  readonly scopes = new Map<string, QqSettingScopes>();
  readonly secrets = new Map<string, string>();
  readonly writes: Record<string, unknown>[] = [];
  readonly secretReads: string[] = [];
  readonly secretWrites: string[] = [];
  readonly secretDeletes: string[] = [];

  constructor(
    settings: Record<string, unknown> = {},
    secrets: Record<string, string> = {},
  ) {
    this.settings = { ...settings };
    for (const [key, value] of Object.entries(secrets)) {
      this.secrets.set(key, value);
    }
  }

  readAll(): Record<string, unknown> {
    return { ...this.settings };
  }

  inspect(key: string): QqSettingScopes | undefined {
    return this.scopes.get(key);
  }

  async writeAll(patch: Record<string, unknown>): Promise<void> {
    this.writes.push({ ...patch });
    Object.assign(this.settings, patch);
  }

  async getSecret(key: string): Promise<string | undefined> {
    this.secretReads.push(key);
    return this.secrets.get(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secretWrites.push(key);
    this.secrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.secretDeletes.push(key);
    this.secrets.delete(key);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readQqSettings", () => {
  it("空配置返回默认值", async () => {
    const io = new MemoryIo();
    await expect(readQqSettings(io)).resolves.toEqual(DEFAULTS);
  });

  it("只读 app-secret 并投影成 hasAppSecret 布尔", async () => {
    const io = new MemoryIo({}, { [QQ_SECRET_KEYS.appSecret]: "sec-123" });
    const ui = await readQqSettings(io);

    expect(ui.hasAppSecret).toBe(true);
    // 只探测 UI 需要感知的扫码凭据；内部自举密钥不读。
    expect(io.secretReads).toEqual([QQ_SECRET_KEYS.appSecret]);
    expect(io.secretReads).not.toContain(QQ_SECRET_KEYS.bridgeToken);
    expect(io.secretReads).not.toContain(QQ_SECRET_KEYS.signingSecret);
  });

  it("纯空白或缺失的 secret 视为未配置", async () => {
    const io = new MemoryIo({}, { [QQ_SECRET_KEYS.appSecret]: "   " });
    const ui = await readQqSettings(io);
    expect(ui.hasAppSecret).toBe(false);
  });

  it("原始脏值按 pickQqSettingsUi 归一（字符串 trim / 数字裁剪 / 枚举回退）", async () => {
    const io = new MemoryIo({
      enabled: "true",
      adapter: "legacy",
      endpoint: "  http://127.0.0.1:3000  ",
      bridgePort: 70000.4,
      allowedUsers: [" 10001 ", "10001", ""],
      remotePolicy: "yolo",
      maxConcurrentTasks: 0,
      rateLimitPerMin: 4.6,
      resultDetail: "compact",
      autoMerge: 1,
    });
    const ui = await readQqSettings(io);

    expect(ui.enabled).toBe(false);
    expect(ui.allowedUsers).toEqual([{ openid: "10001" }]);
    expect(ui.remotePolicy).toBe("supervised");
    expect(ui.maxConcurrentTasks).toBe(1);
    expect(ui.rateLimitPerMin).toBe(5);
    expect(ui.resultDetail).toBe("standard");
    expect(ui.autoMerge).toBe(false);
  });

  it("白名单兼容旧 string[] 与新的 { openid, note } 条目", async () => {
    const io = new MemoryIo({
      allowedUsers: ["legacy-openid", { openid: "user-2", note: "同事" }],
      allowedGroups: [{ openid: "group-9" }],
    });
    const ui = await readQqSettings(io);
    expect(ui.allowedUsers).toEqual([
      { openid: "legacy-openid" },
      { openid: "user-2", note: "同事" },
    ]);
    expect(ui.allowedGroups).toEqual([{ openid: "group-9" }]);
  });

  it("返回值不含凭据明文", async () => {
    const io = new MemoryIo(
      {},
      {
        [QQ_SECRET_KEYS.appSecret]: "plain-app-secret",
      },
    );
    const ui = await readQqSettings(io);
    const serialized = JSON.stringify(ui);
    expect(serialized).not.toContain("plain-app-secret");
    expect(Object.keys(ui)).not.toContain("appSecret");
  });
});

describe("applyQqSettingsPatch", () => {
  it("白名单键写入，非白名单键进 ignored 且不落盘", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      enabled: true,
      allowedUsers: ["10001"],
      ...({
        botToken: "should-not-write",
        adapter: "qqbot",
      } as unknown as Partial<QqSettingsUi>),
    });

    expect(result.applied).toEqual(["enabled", "allowedUsers"]);
    expect(result.ignored).toEqual(["botToken", "adapter"]);
    expect(io.writes).toEqual([{ enabled: true, allowedUsers: ["10001"] }]);
    expect(io.settings).not.toHaveProperty("botToken");
    expect(io.settings).not.toHaveProperty("adapter");
  });

  it("hasAppSecret 是派生字段，必须进 ignored", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      hasAppSecret: false,
    });

    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual(["hasAppSecret"]);
    // 没有可写键时不触发写入。
    expect(io.writes).toEqual([]);
  });

  it("undefined 表示本次不改：既不写也不进 ignored", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, { enabled: undefined, workspace: undefined });

    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it("数字先取整再 clamp 到允许范围", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      maxConcurrentTasks: 0,
      rateLimitPerMin: 4.6,
    });

    expect(result.applied).toEqual(["maxConcurrentTasks", "rateLimitPerMin"]);
    expect(result.ignored).toEqual([]);
    expect(io.writes).toEqual([
      { maxConcurrentTasks: 1, rateLimitPerMin: 5 },
    ]);

    const low = new MemoryIo();
    await applyQqSettingsPatch(low, { maxConcurrentTasks: 99, rateLimitPerMin: 99 });
    expect(low.settings).toEqual({ maxConcurrentTasks: 10, rateLimitPerMin: 60 });
  });

  it("数字类型不符 / 非有限值整键拒绝（不写脏值）", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      maxConcurrentTasks: Number.NaN,
      rateLimitPerMin: Number.POSITIVE_INFINITY,
    } as unknown as Partial<QqSettingsUi>);

    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual(["maxConcurrentTasks", "rateLimitPerMin"]);
    expect(io.writes).toEqual([]);
  });

  it("非法枚举进 ignored；合法枚举 trim 后写入", async () => {
    const bad = new MemoryIo();
    const rejected = await applyQqSettingsPatch(bad, {
      remotePolicy: "yolo",
      resultDetail: "compact",
    } as unknown as Partial<QqSettingsUi>);
    expect(rejected.applied).toEqual([]);
    expect(rejected.ignored).toEqual(["remotePolicy", "resultDetail"]);
    expect(bad.writes).toEqual([]);

    const good = new MemoryIo();
    const accepted = await applyQqSettingsPatch(good, {
      remotePolicy: "readonly",
      resultDetail: " full ",
    } as unknown as Partial<QqSettingsUi>);
    expect(accepted.applied).toEqual(["remotePolicy", "resultDetail"]);
    expect(good.settings).toEqual({
      remotePolicy: "readonly",
      resultDetail: "full",
    });
  });

  it("布尔与字符串类型不符进 ignored；字符串按原值写", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      enabled: "true",
      autoMerge: 1,
      workspace: " J:/work/qq ",
    } as unknown as Partial<QqSettingsUi>);

    expect(result.applied).toEqual(["workspace"]);
    expect(result.ignored).toEqual(["enabled", "autoMerge"]);
    expect(io.settings).toEqual({ workspace: " J:/work/qq " });
  });

  it("白名单写入按 openid 归一（trim + 去重保首次顺序）；空 id / 非字符串项整键拒绝", async () => {
    const ok = new MemoryIo();
    const accepted = await applyQqSettingsPatch(ok, {
      allowedUsers: [" 10001 ", "10001", "10002"],
    });
    expect(accepted.applied).toEqual(["allowedUsers"]);
    expect(ok.settings.allowedUsers).toEqual(["10001", "10002"]);

    const bad = new MemoryIo();
    const rejected = await applyQqSettingsPatch(bad, {
      allowedGroups: ["1", 2, null],
    } as unknown as Partial<QqSettingsUi>);
    expect(rejected.applied).toEqual([]);
    expect(rejected.ignored).toEqual(["allowedGroups"]);
    expect(bad.writes).toEqual([]);

    // 空 / 纯空白的 openid 与对象缺 openid 同待遇：整键拒绝，不写半截脏值。
    const blank = new MemoryIo();
    const rejectedBlank = await applyQqSettingsPatch(blank, {
      allowedUsers: ["ok-id", "   "],
    });
    expect(rejectedBlank.applied).toEqual([]);
    expect(rejectedBlank.ignored).toEqual(["allowedUsers"]);
    expect(blank.writes).toEqual([]);
  });

  it("备注条目写成 { openid, note }，没备注的条目仍是裸字符串", async () => {
    const io = new MemoryIo();
    const result = await applyQqSettingsPatch(io, {
      allowedUsers: [
        { openid: "user-with-note", note: " 同事 " },
        { openid: "user-plain" },
        "legacy-id",
      ],
    });

    expect(result.applied).toEqual(["allowedUsers"]);
    // 写入值里绝不含脱敏星号：脱敏只是 UI 展示层的事。
    expect(JSON.stringify(io.settings.allowedUsers)).not.toContain("*");
    expect(io.settings.allowedUsers).toEqual([
      { openid: "user-with-note", note: "同事" },
      "user-plain",
      "legacy-id",
    ]);
  });

  it("清空备注写回裸字符串（旧的 string[] 形状）", async () => {
    const io = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }],
    });
    await applyQqSettingsPatch(io, { allowedUsers: [{ openid: "user-1" }] });
    expect(io.settings.allowedUsers).toEqual(["user-1"]);
  });

  it("备注语义守卫：裸字符串保留盘上备注，对象缺 note / 空 note 都清空", async () => {
    // 裸字符串 = 「只关心 id」：盘上备注必须保留。
    const bare = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }],
    });
    await applyQqSettingsPatch(bare, { allowedUsers: ["user-1"] });
    expect(bare.settings.allowedUsers).toEqual([{ openid: "user-1", note: "同事" }]);

    // 对象条目 = note 是权威值：缺省即清空。
    const omitted = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }],
    });
    await applyQqSettingsPatch(omitted, { allowedUsers: [{ openid: "user-1" }] });
    expect(omitted.settings.allowedUsers).toEqual(["user-1"]);

    // 对象条目 = note 是权威值：空串同样清空。
    const blankNote = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }],
    });
    await applyQqSettingsPatch(blankNote, {
      allowedUsers: [{ openid: "user-1", note: "  " }],
    });
    expect(blankNote.settings.allowedUsers).toEqual(["user-1"]);
  });

  it("对象条目的显式 note 覆盖盘上旧备注；其它条目不受影响", async () => {
    const io = new MemoryIo({
      allowedUsers: [
        { openid: "user-1", note: "同事" },
        { openid: "user-2", note: "运维" },
        "user-3",
      ],
    });
    await applyQqSettingsPatch(io, {
      allowedUsers: [
        { openid: "user-1", note: "运维同事" },
        { openid: "user-2", note: "运维" },
        "user-3",
      ],
    });
    expect(io.settings.allowedUsers).toEqual([
      { openid: "user-1", note: "运维同事" },
      { openid: "user-2", note: "运维" },
      "user-3",
    ]);
  });

  it("只追加 openid 的补丁（宿主内部路径）保留磁盘上已有备注", async () => {
    const io = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }, "user-2"],
    });
    await applyQqSettingsPatch(io, {
      allowedUsers: ["user-1", "user-2", "user-3"],
    });
    expect(io.settings.allowedUsers).toEqual([
      { openid: "user-1", note: "同事" },
      "user-2",
      "user-3",
    ]);
    // 读回时备注仍在，新追加的条目没有备注。
    const ui = await readQqSettings(io);
    expect(ui.allowedUsers).toEqual([
      { openid: "user-1", note: "同事" },
      { openid: "user-2" },
      { openid: "user-3" },
    ]);
  });

  it("群备注写入 / 清空与用户备注互不影响，读回保持", async () => {
    const io = new MemoryIo({
      allowedUsers: [{ openid: "user-1", note: "同事" }],
      allowedGroups: [{ openid: "group-1", note: "测试群" }, "group-2"],
    });

    // 改群备注 + 新增带备注的群：只写 allowedGroups，用户列表原封不动。
    await applyQqSettingsPatch(io, {
      allowedGroups: [
        { openid: "group-1", note: " 运营群 " },
        { openid: "group-3", note: "新群" },
        "group-2",
      ],
    });
    expect(io.settings.allowedGroups).toEqual([
      { openid: "group-1", note: "运营群" },
      { openid: "group-3", note: "新群" },
      "group-2",
    ]);
    expect(io.settings.allowedUsers).toEqual([{ openid: "user-1", note: "同事" }]);

    // 清空某条群备注：退回裸字符串；其它群与用户列表不受影响。
    await applyQqSettingsPatch(io, {
      allowedGroups: [{ openid: "group-1" }, { openid: "group-3", note: "新群" }, "group-2"],
    });
    expect(io.settings.allowedGroups).toEqual([
      "group-1",
      { openid: "group-3", note: "新群" },
      "group-2",
    ]);
    expect(io.settings.allowedUsers).toEqual([{ openid: "user-1", note: "同事" }]);

    // 重开设置页（读回）：群备注在，无备注条目是裸字符串形状。
    const ui = await readQqSettings(io);
    expect(ui.allowedGroups).toEqual([
      { openid: "group-1" },
      { openid: "group-3", note: "新群" },
      { openid: "group-2" },
    ]);
    expect(ui.allowedUsers).toEqual([{ openid: "user-1", note: "同事" }]);
  });

  it("只追加裸 id 的群补丁保留磁盘上的群备注（与用户列表同口径）", async () => {
    const io = new MemoryIo({
      allowedGroups: [{ openid: "group-1", note: "测试群" }],
    });
    await applyQqSettingsPatch(io, { allowedGroups: ["group-1", "group-2"] });
    expect(io.settings.allowedGroups).toEqual([
      { openid: "group-1", note: "测试群" },
      "group-2",
    ]);
  });

  it("9 个设置键均已覆盖，且不含派生字段与已移除的遗留键", () => {
    expect(QQ_SETTING_KEYS).toHaveLength(9);
    expect(QQ_SETTING_KEYS).not.toContain("hasAppSecret");
    expect(QQ_SETTING_KEYS).not.toContain("adapter");
    expect(QQ_SETTING_KEYS).not.toContain("endpoint");
    expect(QQ_SETTING_KEYS).not.toContain("bridgePort");
  });
});

describe("ensureBridgeSecrets", () => {
  it("首次生成 32 字节 hex 并写入两个内部密钥", async () => {
    const io = new MemoryIo();
    const result = await ensureBridgeSecrets(io);

    expect(result.bridgeToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bridgeToken).not.toBe(result.hmacSecret);
    expect(io.secrets.get(QQ_SECRET_KEYS.bridgeToken)).toBe(result.bridgeToken);
    expect(io.secrets.get(QQ_SECRET_KEYS.signingSecret)).toBe(result.hmacSecret);
    expect(io.secretWrites.sort()).toEqual(
      [QQ_SECRET_KEYS.signingSecret, QQ_SECRET_KEYS.bridgeToken].sort(),
    );
  });

  it("幂等：已有值原样复用，不重复生成 / 写入", async () => {
    const io = new MemoryIo(
      {},
      {
        [QQ_SECRET_KEYS.bridgeToken]: "existing-bridge",
        [QQ_SECRET_KEYS.signingSecret]: "existing-hmac",
      },
    );

    const first = await ensureBridgeSecrets(io);
    const second = await ensureBridgeSecrets(io);

    expect(first).toEqual({ bridgeToken: "existing-bridge", hmacSecret: "existing-hmac" });
    expect(second).toEqual(first);
    expect(io.secretWrites).toEqual([]);
  });

  it("第二次调用返回同一组值（生成一次）", async () => {
    const io = new MemoryIo();
    const first = await ensureBridgeSecrets(io);
    const second = await ensureBridgeSecrets(io);

    expect(second).toEqual(first);
    expect(io.secretWrites).toHaveLength(2);
  });

  it("注入 rng 时可确定性生成", async () => {
    const io = new MemoryIo();
    const result = await ensureBridgeSecrets(io, () => 0.5);

    expect(result.bridgeToken).toBe("8".repeat(64));
    expect(result.hmacSecret).toBe("8".repeat(64));
  });

  it("不打印任何日志（不泄漏密钥）", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const io = new MemoryIo();
    await ensureBridgeSecrets(io);

    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("createVscodeQqSettingsIo 写入作用域", () => {
  const secrets = {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  };
  const original = vscode.workspace.getConfiguration;
  afterEach(() => {
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = original;
  });

  it("写入落 Global；没有工作区覆盖时不碰 Workspace（无工作区也不抛错）", async () => {
    const calls: Array<{ key: string; value: unknown; target: number | undefined }> = [];
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
      get: () => undefined,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown, target?: number) => {
        if (target === vscode.ConfigurationTarget.Workspace) {
          // 真实 VSCode 在没打开工作区时的行为。
          throw new Error("Unable to write to Workspace Settings because no workspace is opened.");
        }
        calls.push({ key, value, target });
      },
    });

    const io = createVscodeQqSettingsIo(secrets);
    await expect(io.writeAll({ enabled: true, maxConcurrentTasks: 3 })).resolves.toBeUndefined();

    expect(calls).toEqual([
      { key: "enabled", value: true, target: vscode.ConfigurationTarget.Global },
      { key: "maxConcurrentTasks", value: 3, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("存量 Workspace 覆盖在写 Global 后同一次操作里被单键清掉", async () => {
    const calls: Array<{ key: string; value: unknown; target: number | undefined }> = [];
    const workspaceValues: Record<string, unknown> = { enabled: true };
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
      get: () => undefined,
      inspect: (key: string) => ({ workspaceValue: workspaceValues[key] }),
      update: async (key: string, value: unknown, target?: number) => {
        calls.push({ key, value, target });
        if (target === vscode.ConfigurationTarget.Workspace) delete workspaceValues[key];
      },
    });

    const io = createVscodeQqSettingsIo(secrets);
    await io.writeAll({ enabled: false, autoMerge: false });

    expect(calls).toEqual([
      { key: "enabled", value: false, target: vscode.ConfigurationTarget.Global },
      { key: "enabled", value: undefined, target: vscode.ConfigurationTarget.Workspace },
      { key: "autoMerge", value: false, target: vscode.ConfigurationTarget.Global },
    ]);
    expect(workspaceValues.enabled).toBeUndefined();
  });
});

describe("createVscodeQqSettingsIo", () => {
  it("用注入的 SecretStorage 代理读写删", async () => {
    const stored = new Map<string, string>([["k", "v"]]);
    const secrets = {
      get: async (key: string) => stored.get(key),
      store: async (key: string, value: string) => {
        stored.set(key, value);
      },
      delete: async (key: string) => {
        stored.delete(key);
      },
    };

    const io = createVscodeQqSettingsIo(secrets);

    await expect(io.getSecret("k")).resolves.toBe("v");
    await io.setSecret("k", "v2");
    expect(stored.get("k")).toBe("v2");
    await io.deleteSecret("k");
    expect(stored.has("k")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 读侧作用域优先级（Global 优先）
// ---------------------------------------------------------------------------

describe("pickQqSettingValue：单键生效值", () => {
  it("Global 有值且工作区也有不同值 → 读到 Global", () => {
    expect(
      pickQqSettingValue({
        globalValue: true,
        workspaceValue: false,
        workspaceFolderValues: [false],
      }),
    ).toBe(true);
  });

  it("Global 缺失、工作区有旧值 → 读到工作区（旧值不丢）", () => {
    expect(pickQqSettingValue({ workspaceValue: "trusted" })).toBe("trusted");
    // 多根：Global / 工作区都缺失时按根顺序回退到 folder 级旧值。
    expect(pickQqSettingValue({ workspaceFolderValues: [undefined, "full"] })).toBe("full");
  });

  it("分层值全缺失 → 用声明默认值", () => {
    expect(pickQqSettingValue({ defaultValue: 6 })).toBe(6);
    expect(pickQqSettingValue(undefined)).toBeUndefined();
  });

  it("显式 false / 0 / 空串不会被当成缺失", () => {
    expect(pickQqSettingValue({ globalValue: false, workspaceValue: true })).toBe(false);
    expect(pickQqSettingValue({ globalValue: 0, defaultValue: 6 })).toBe(0);
    expect(pickQqSettingValue({ globalValue: "", workspaceValue: "x" })).toBe("");
  });
});

describe("readEffectiveQqSettings：9 键生效值", () => {
  it("有 inspect 能力时逐键 Global 优先；无旧值时读默认值", () => {
    const io = new MemoryIo();
    io.scopes.set("enabled", { globalValue: true, workspaceValue: false });
    io.scopes.set("resultDetail", { defaultValue: "full" });
    const io2 = new MemoryIo();
    io2.scopes.set("resultDetail", { defaultValue: "full" });

    const raw = readEffectiveQqSettings(io);
    expect(raw.enabled).toBe(true);
    expect(readEffectiveQqSettings(io2).resultDetail).toBe("full");
  });

  it("IO 没有 inspect 能力时退回 readAll（旧 fake 兼容）", () => {
    const io: QqSettingsIo = {
      readAll: () => ({ enabled: true }),
      writeAll: async () => undefined,
      getSecret: async () => undefined,
      setSecret: async () => undefined,
      deleteSecret: async () => undefined,
    };
    expect(readEffectiveQqSettings(io)).toEqual({ enabled: true });
    expect(findShadowedWorkspaceKeys(io)).toEqual([]);
  });
});

describe("readQqSettings 读侧 Global 优先（真实 vscode IO）", () => {
  const secrets = {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  };
  const original = vscode.workspace.getConfiguration;
  afterEach(() => {
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = original;
    resetConfigScopeValues();
    resetWorkspaceFoldersStub();
    resetConfigUpdates();
  });

  it("Global 有值、Workspace 也有不同值 → 读到 Global", async () => {
    setConfigScopeValues({ enabled: { global: true, workspace: false } });
    const io = createVscodeQqSettingsIo(secrets);
    await expect(readQqSettings(io)).resolves.toMatchObject({ enabled: true });
    // 合并读（原生 folder > workspace > global）仍是 false：证明优先级在本层改写。
    expect(io.readAll().enabled).toBe(false);
  });

  it("Global 缺失、Workspace 有旧值 → 读到 Workspace（旧值不丢）", async () => {
    setConfigScopeValues({ remotePolicy: { workspace: "trusted" } });
    const io = createVscodeQqSettingsIo(secrets);
    await expect(readQqSettings(io)).resolves.toMatchObject({ remotePolicy: "trusted" });
  });

  it("多根：Global / Workspace 都缺失时回退到 folder 级旧值", async () => {
    setWorkspaceFolders([{ uri: { fsPath: "J:/root-a" } }, { uri: { fsPath: "J:/root-b" } }]);
    setConfigScopeValues({ resultDetail: { folders: { "J:/root-b": "full" } } });
    const io = createVscodeQqSettingsIo(secrets);
    await expect(readQqSettings(io)).resolves.toMatchObject({ resultDetail: "full" });
    expect(findShadowedWorkspaceKeys(io)).toEqual([]);
  });

  it("分层全缺失 → 读到声明默认值（get() 的默认层）", async () => {
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
      get: (key: string) =>
        ({ enabled: false, resultDetail: "summary" } as Record<string, unknown>)[key],
      inspect: () => ({
        globalValue: undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
      update: async () => {
        throw new Error("read-only");
      },
    });
    const io = createVscodeQqSettingsIo(secrets);
    await expect(readQqSettings(io)).resolves.toMatchObject({
      enabled: false,
      resultDetail: "summary",
    });
  });

  it("读取 / 检测路径零写入：不调用 update，也不订阅配置变更事件", async () => {
    enableConfigUpdateRecording();
    const onDidChange = vi.spyOn(vscode.workspace, "onDidChangeConfiguration");
    setConfigScopeValues({
      enabled: { global: true, workspace: false },
      remotePolicy: { workspace: "trusted" },
    });
    const io = createVscodeQqSettingsIo(secrets);

    await readQqSettings(io);
    expect(findShadowedWorkspaceKeys(io)).toEqual(["enabled"]);

    expect(getConfigUpdates()).toEqual([]);
    expect(onDidChange).not.toHaveBeenCalled();
  });
});

describe("findShadowedWorkspaceKeys / createShadowedOverrideNotice", () => {
  it("列出被 Global 压住的旧工作区 / folder 级覆盖；无残留返回空", () => {
    const io = new MemoryIo();
    io.scopes.set("enabled", { globalValue: true, workspaceValue: false });
    io.scopes.set("autoMerge", { globalValue: true, workspaceFolderValues: [false] });
    io.scopes.set("remotePolicy", { globalValue: "trusted" }); // 无旧值：不算残留
    io.scopes.set("resultDetail", { workspaceValue: "full" }); // Global 缺失：旧值仍生效

    expect(findShadowedWorkspaceKeys(io)).toEqual(["enabled", "autoMerge"]);
    expect(findShadowedWorkspaceKeys(new MemoryIo())).toEqual([]);
  });

  it("幂等：连续两次探测只提示一次；无残留时不消耗这次机会", () => {
    const notify = vi.fn();
    const notice = createShadowedOverrideNotice(notify);
    const io = new MemoryIo();
    io.scopes.set("enabled", { globalValue: true, workspaceValue: false });

    // 先探一次空的：不提示，也不消耗机会。
    expect(notice(new MemoryIo())).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    expect(notice(io)).toEqual(["enabled"]);
    expect(notice(io)).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(["enabled"]);
  });

  it("检测只读：不触发 writeAll / update", () => {
    const io = new MemoryIo();
    io.scopes.set("enabled", { globalValue: true, workspaceValue: false });
    const notice = createShadowedOverrideNotice(() => undefined);

    findShadowedWorkspaceKeys(io);
    notice(io);

    expect(io.writes).toEqual([]);
  });
});
