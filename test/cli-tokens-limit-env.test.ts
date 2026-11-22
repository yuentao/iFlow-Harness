import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliTokensLimitEnv, resolveCliTokensLimit, resolveTokensLimitLookupKey, tokensLimitEnvFromSettings } from "../src/acp/cli-tokens-limit.js";
import { parseContextWindowOverrides } from "../shared/context-window.js";

/**
 * 上下文窗口的端到端对齐：宿主解析出的窗口是 CLI 的唯一权威。
 *
 * CLI 内部 `JR(model, limit)` 的优先级是 env → context-window-loader（读
 * ~/.iflow/settings.json 顶层 tokensLimit）→ 精确模型表（**只有 9 个 gemini
 * 键**）→ 模式表（deepseek 的 default 分支只有 65k）→ 兜底 128k。宿主侧把
 * 这条链收敛成自己的五档权威（user override → active profile → settings 顶层
 * → 内建对照表 → 无依据不推），并用 `IFLOW_TOKENS_LIMIT` env 推给 CLI。
 *
 * 查表用的模型键走一条降级链（store 的 currentModelId → pendingSwitchModel
 * → workspaceModelId() → 内核 profile 的 modelName → 全空不推）：spawn env 在
 * `session/new` 返回之前构造，冷启动时 currentModelId 还是 null，不兜底就会
 * 让用户的 override 与内建表双双落空。
 *
 * 本文件逐档验证 resolver 的判定与 env 的产出；每一档都用**显式传入的
 * settingsPath**，因此完全不依赖开发机上的 ~/.iflow/settings.json。
 */
const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-tokens-limit-"));
const originalIflowHome = process.env.IFLOW_HOME;
// 内核 settings.json 的默认路径由 IFLOW_HOME 决定：指向临时目录，本文件因此
// 绝不依赖开发机上的 ~/.iflow/settings.json。
beforeAll(() => {
  process.env.IFLOW_HOME = tempDir;
});
afterAll(() => {
  if (originalIflowHome === undefined) delete process.env.IFLOW_HOME;
  else process.env.IFLOW_HOME = originalIflowHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function settingsFile(name: string, content: Record<string, unknown>): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

/** 一个不存在的 settings 路径 —— readCliSettings 返回 null（无 profile/顶层值）。 */
const missingSettings = path.join(tempDir, "no-such-settings.json");

describe("resolveCliTokensLimit — 五档权威链", () => {
  it("1) user override 命中 → 推该值（并压过 profile / settings 顶层）", () => {
    const settingsPath = settingsFile("user-wins.json", {
      currentApiProfile: "main",
      apiProfiles: { main: { tokensLimit: 128000 } },
      tokensLimit: 200000,
    });
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    const resolved = resolveCliTokensLimit({
      modelId: "auto/deepseek-v4.1-flash",
      overrides,
      settingsPath,
    });
    expect(resolved).toEqual({ limit: 960000, source: "user" });
    expect(
      tokensLimitEnvFromSettings({ modelId: "auto/deepseek-v4.1-flash", overrides, settingsPath }),
    ).toEqual({ IFLOW_TOKENS_LIMIT: "960000" });
  });

  it("2) user override 未命中当前模型 → 不推（内建表也未命中时）", () => {
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    const resolved = resolveCliTokensLimit({
      modelId: "totally-unknown-model",
      overrides,
      settingsPath: missingSettings,
    });
    expect(resolved).toEqual({ limit: undefined, source: undefined });
    const env = tokensLimitEnvFromSettings({
      modelId: "totally-unknown-model",
      overrides,
      settingsPath: missingSettings,
    });
    expect(env).toEqual({});
    expect("IFLOW_TOKENS_LIMIT" in env).toBe(false);
  });

  it("3) activeProfile.tokensLimit 命中 → 推（压过 settings 顶层）", () => {
    const settingsPath = settingsFile("profile.json", {
      currentApiProfile: "main",
      apiProfiles: { main: { tokensLimit: 128000 } },
      tokensLimit: 200000,
    });
    const resolved = resolveCliTokensLimit({ modelId: "unknown-model", settingsPath });
    expect(resolved).toEqual({ limit: 128000, source: "profile" });
    expect(tokensLimitEnvFromSettings({ modelId: "unknown-model", settingsPath })).toEqual({
      IFLOW_TOKENS_LIMIT: "128000",
    });
  });

  it("4) settings.json 顶层 tokensLimit 命中 → 推", () => {
    const settingsPath = settingsFile("toplevel.json", { tokensLimit: 200000 });
    const resolved = resolveCliTokensLimit({ modelId: "unknown-model", settingsPath });
    expect(resolved).toEqual({ limit: 200000, source: "settings" });
    expect(tokensLimitEnvFromSettings({ modelId: "unknown-model", settingsPath })).toEqual({
      IFLOW_TOKENS_LIMIT: "200000",
    });
  });

  it("5) 内建对照表命中 → 推（CLI 自己的表缺这个模型时才由宿主补位）", () => {
    const resolved = resolveCliTokensLimit({
      modelId: "auto/deepseek-v4.1-flash",
      settingsPath: missingSettings,
    });
    expect(resolved).toEqual({ limit: 1_000_000, source: "builtin-table" });
    expect(
      tokensLimitEnvFromSettings({ modelId: "auto/deepseek-v4.1-flash", settingsPath: missingSettings }),
    ).toEqual({ IFLOW_TOKENS_LIMIT: "1000000" });
  });

  it("6) 全不命中 → 不推（env 里不得出现 IFLOW_TOKENS_LIMIT，绝不推兜底估算）", () => {
    const resolved = resolveCliTokensLimit({
      modelId: "totally-unknown-model",
      settingsPath: missingSettings,
    });
    expect(resolved.limit).toBeUndefined();
    expect(resolved.source).toBeUndefined();
    const env = tokensLimitEnvFromSettings({
      modelId: "totally-unknown-model",
      settingsPath: missingSettings,
    });
    expect(env).toEqual({});
    expect("IFLOW_TOKENS_LIMIT" in env).toBe(false);
  });

  it("7) key 归一化：auto/deepseek-v4.1-flash 与 deepseek-v4.1-flash 命中同一条 override", () => {
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    const withPrefix = resolveCliTokensLimit({
      modelId: "auto/deepseek-v4.1-flash",
      overrides,
      settingsPath: missingSettings,
    });
    const withoutPrefix = resolveCliTokensLimit({
      modelId: "deepseek-v4.1-flash",
      overrides,
      settingsPath: missingSettings,
    });
    expect(withPrefix).toEqual({ limit: 960000, source: "user" });
    expect(withoutPrefix).toEqual(withPrefix);
    // override 的键本身写成带前缀的形式，同样归一化到同一条。
    const prefixedOverride = parseContextWindowOverrides(["auto/deepseek-v4.1-flash=960000"]);
    expect(
      resolveCliTokensLimit({
        modelId: "deepseek-v4.1-flash",
        overrides: prefixedOverride,
        settingsPath: missingSettings,
      }),
    ).toEqual(withPrefix);
  });

  it("非正整数 / 非数字的 profile、settings、override 值一律视为缺失", () => {
    const settingsPath = settingsFile("garbage.json", {
      currentApiProfile: "main",
      apiProfiles: { main: { tokensLimit: -1 } },
      tokensLimit: "200000",
    });
    const resolved = resolveCliTokensLimit({ modelId: "unknown-model", settingsPath });
    expect(resolved).toEqual({ limit: undefined, source: undefined });
  });
});

describe("cliTokensLimitEnv", () => {
  it("只对正整数写入 IFLOW_TOKENS_LIMIT", () => {
    expect(cliTokensLimitEnv(1_000_000)).toEqual({ IFLOW_TOKENS_LIMIT: "1000000" });
    expect(cliTokensLimitEnv(128000)).toEqual({ IFLOW_TOKENS_LIMIT: "128000" });
  });

  it("undefined / 0 / 负数 / 非整数一律不写该键", () => {
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const env = cliTokensLimitEnv(bad);
      expect(env).toEqual({});
      expect("IFLOW_TOKENS_LIMIT" in env).toBe(false);
    }
  });
});

/**
 * 冷启动兜底：查表键的降级链。
 *
 * spawn env 是在 CLI 的 `session/new` 返回**之前**构造的，所以扩展刚激活
 * （或刚新建会话）时 store 的 `currentModelId` 还是 null —— 用户的
 * `iflow.contextWindowOverrides` 与宿主内建表都会「命不中」，CLI 于是退回
 * 自己的 65k deepseek 默认值（正是「每轮都触发上下文自动压缩」的根因）。
 *
 * 兜底链（只用于**查表**，绝不影响 `set_model` 的原样透传）：
 *   store 的 currentModelId → pendingSwitchModel → workspaceModelId()
 *   → 内核 profile 的 modelName → 全空则**不推**。
 *
 * 链是「取第一个非空的键」，不是「逐个试直到命中」：键一旦确定就只查它，
 * 绝不把另一个模型的窗口套到当前模型上。
 */
describe("冷启动兜底 · 查表键降级链", () => {
  /** 一个带 modelName 的内核 active profile（附加字段用于测档位顺序）。 */
  function profileSettings(
    modelName: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      currentApiProfile: "main",
      apiProfiles: { main: { modelName, ...extra } },
    };
  }

  it("currentModelId 为 null、内核 profile 的 modelName 命中用户 override", () => {
    const settingsPath = settingsFile(
      "coldstart-override.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    expect(resolveCliTokensLimit({ modelId: null, overrides, settingsPath })).toEqual({
      limit: 960000,
      source: "user",
    });
    expect(tokensLimitEnvFromSettings({ modelId: null, overrides, settingsPath })).toEqual({
      IFLOW_TOKENS_LIMIT: "960000",
    });
  });

  it("currentModelId 为 null、内核 profile 的 modelName 命中内建对照表", () => {
    const settingsPath = settingsFile(
      "coldstart-builtin.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    expect(resolveCliTokensLimit({ modelId: null, settingsPath })).toEqual({
      limit: 1_000_000,
      source: "builtin-table",
    });
    expect(tokensLimitEnvFromSettings({ modelId: null, settingsPath })).toEqual({
      IFLOW_TOKENS_LIMIT: "1000000",
    });
  });

  it("pendingSwitchModel（第 2 级）压过 workspaceModelId 与内核 profile 的 modelName", () => {
    const settingsPath = settingsFile(
      "coldstart-pending.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    const overrides = parseContextWindowOverrides(["pending-model=111000"]);
    expect(
      resolveCliTokensLimit({
        modelId: null,
        pendingSwitchModel: "pending-model",
        workspaceModelId: "workspace-model",
        settingsPath,
        overrides,
      }),
    ).toEqual({ limit: 111000, source: "user" });
  });

  it("workspaceModelId（第 3 级）压过内核 profile 的 modelName", () => {
    const settingsPath = settingsFile(
      "coldstart-workspace.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    const overrides = parseContextWindowOverrides(["workspace-model=222000"]);
    expect(
      resolveCliTokensLimit({
        modelId: null,
        workspaceModelId: "workspace-model",
        settingsPath,
        overrides,
      }),
    ).toEqual({ limit: 222000, source: "user" });
  });

  it("store 的 currentModelId（第 1 级）压过所有兜底", () => {
    const settingsPath = settingsFile(
      "coldstart-store-wins.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    const overrides = parseContextWindowOverrides([
      "deepseek-v4.1-flash=960000",
      "store-model=333000",
    ]);
    expect(
      resolveCliTokensLimit({
        modelId: "store-model",
        pendingSwitchModel: "pending-model",
        workspaceModelId: "workspace-model",
        settingsPath,
        overrides,
      }),
    ).toEqual({ limit: 333000, source: "user" });
  });

  it("全部拿不到 → 不推（绝不退化成猜测的默认值）", () => {
    expect(resolveCliTokensLimit({ modelId: null, settingsPath: missingSettings })).toEqual({
      limit: undefined,
      source: undefined,
    });
    expect(
      tokensLimitEnvFromSettings({ modelId: null, settingsPath: missingSettings }),
    ).toEqual({});
  });

  it("档位顺序不被打乱：profile 显式 tokensLimit 仍压过内建表命中", () => {
    const settingsPath = settingsFile(
      "coldstart-order.json",
      profileSettings("auto/deepseek-v4.1-flash", { tokensLimit: 128000 }),
    );
    // 冷启动（currentModelId 为 null）下，内核 profile 的 tokensLimit 仍然
    // 先于内建表的 1M 命中 —— 五档链的语义没被兜底改动。
    expect(resolveCliTokensLimit({ modelId: null, settingsPath })).toEqual({
      limit: 128000,
      source: "profile",
    });
  });

  it("settings 顶层 tokensLimit 仍压过内建表命中", () => {
    const settingsPath = settingsFile("coldstart-settings-top.json", {
      tokensLimit: 200000,
      currentApiProfile: "main",
      apiProfiles: { main: { modelName: "auto/deepseek-v4.1-flash" } },
    });
    expect(resolveCliTokensLimit({ modelId: null, settingsPath })).toEqual({
      limit: 200000,
      source: "settings",
    });
  });

  it("resolveTokensLimitLookupKey：按降级链取键，全空时为 null", () => {
    const settingsPath = settingsFile(
      "coldstart-key.json",
      profileSettings("auto/deepseek-v4.1-flash"),
    );
    expect(
      resolveTokensLimitLookupKey({ modelId: null, settingsPath }),
    ).toBe("auto/deepseek-v4.1-flash");
    expect(
      resolveTokensLimitLookupKey({
        modelId: null,
        pendingSwitchModel: "pending-model",
        settingsPath,
      }),
    ).toBe("pending-model");
    expect(
      resolveTokensLimitLookupKey({
        modelId: null,
        workspaceModelId: "workspace-model",
        settingsPath,
      }),
    ).toBe("workspace-model");
    expect(resolveTokensLimitLookupKey({ modelId: "store-model", settingsPath })).toBe(
      "store-model",
    );
    expect(
      resolveTokensLimitLookupKey({ modelId: null, settingsPath: missingSettings }),
    ).toBeNull();
  });
});