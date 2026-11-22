import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliTokensLimitEnv, resolveCliTokensLimit, tokensLimitEnvFromSettings } from "../src/acp/cli-tokens-limit.js";
import { parseContextWindowOverrides } from "../shared/context-window.js";

/**
 * 上下文窗口的端到端对齐：宿主解析出的窗口是 CLI 的唯一权威。
 *
 * CLI 内部 `JR(model, limit)` 的优先级是 env → settings.json 顶层 → 精确模型表
 * → 模式表（deepseek 的 default 分支只有 65k）→ 兜底 128k。宿主侧把这条链
 * 收敛成自己的五档权威（user override → active profile → settings 顶层 → 内建
 * 对照表 → 无依据不推），并用 `IFLOW_TOKENS_LIMIT` env 推给 CLI。
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