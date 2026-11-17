import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QQ_SETTING_KEYS,
  applyQqSettingsPatch,
  createVscodeQqSettingsIo,
  ensureBridgeSecrets,
  readQqSettings,
  type QqSettingsIo,
} from "../src/qq/settings-host.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import type { QqSettingsUi } from "../shared/messages.js";

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
    expect(ui.allowedUsers).toEqual(["10001"]);
    expect(ui.remotePolicy).toBe("supervised");
    expect(ui.maxConcurrentTasks).toBe(1);
    expect(ui.rateLimitPerMin).toBe(5);
    expect(ui.resultDetail).toBe("standard");
    expect(ui.autoMerge).toBe(false);
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

  it("白名单数组按原值浅拷贝写入；含非字符串项则整键拒绝", async () => {
    const ok = new MemoryIo();
    const accepted = await applyQqSettingsPatch(ok, {
      allowedUsers: [" 10001 ", "10001", "10002"],
    });
    expect(accepted.applied).toEqual(["allowedUsers"]);
    expect(ok.settings.allowedUsers).toEqual([" 10001 ", "10001", "10002"]);

    const bad = new MemoryIo();
    const rejected = await applyQqSettingsPatch(bad, {
      allowedGroups: ["1", 2, null],
    } as unknown as Partial<QqSettingsUi>);
    expect(rejected.applied).toEqual([]);
    expect(rejected.ignored).toEqual(["allowedGroups"]);
    expect(bad.writes).toEqual([]);
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
