import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * 设置声明与 nls 一致性的「全覆盖」回归锁（针对陷阱 #14：空设置 / 文案漂移）。
 *
 * 与 `qq-settings-declared.test.ts` 的分工（采用覆盖全部项的方案 b）：
 * - QQ 专项钉住 9 个 iflow.qq.* 设置的**精确契约值**（type/default/range/enum 的具体值、
 *   文案措辞），是纵向的专项锁；
 * - 本测试钉住全部 43 个 iflow.* 设置的**结构完整性 + 双语 nls 键集合一致性 + 引用可达性**，
 *   是横向的全局锁。「两份 bundle 互为翻译键集合一致」本质上是全局不变量，必须覆盖含 QQ
 *   键的整份 bundle 才真正有效，因此 QQ 项在两边都出现是可接受的冗余：两边检查的维度不同，
 *   不会因同一原因同时失效而互相掩盖。
 *
 * 只读磁盘上的 package.json / 两份 nls，不依赖 VSCode 运行时。新增设置项时必须同步更新
 * ALL_KEYS 快照并补齐两份 nls，否则本测试会红——这是刻意的回归锁，不是可自动放过的软检查。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, SettingSchema> } };
};
const en = JSON.parse(readFileSync(path.join(root, "package.nls.json"), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(path.join(root, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;

interface SettingSchema {
  type: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumDescriptions?: string[];
  description?: string;
  markdownDescription?: string;
}

/** 全部 iflow.* 配置的键快照。增删设置项须显式更新这里并同步两份 nls。 */
const ALL_KEYS: string[] = [
  "iflow.nodePath",
  "iflow.warmStart",
  "iflow.soundFeedback",
  "iflow.auroraIntensity",
  "iflow.theme",
  "iflow.uiFontSize",
  "iflow.uiDensity",
  "iflow.restoreLastSession",
  "iflow.autoOpenPanel",
  "iflow.language",
  "iflow.superAgent.integration",
  "iflow.superAgent.maxConcurrent",
  "iflow.superAgent.maxAttempts",
  "iflow.superAgent.dependencyPolicy",
  "iflow.superAgent.fullTrust",
  "iflow.superAgent.keepWorktree",
  "iflow.superAgent.maxWorktrees",
  "iflow.superAgent.childToolAllowlist",
  "iflow.superAgent.childMcpServerAllowlist",
  "iflow.qq.enabled",
  "iflow.qq.allowedUsers",
  "iflow.qq.allowedGroups",
  "iflow.qq.workspace",
  "iflow.qq.remotePolicy",
  "iflow.qq.maxConcurrentTasks",
  "iflow.qq.rateLimitPerMin",
  "iflow.qq.resultDetail",
  "iflow.qq.autoMerge",
  "iflow.osNotifications",
  "iflow.contextWindowOverrides",
  "iflow.costTable",
  "iflow.thinkingModelRules",
  "iflow.autoTitle",
  "iflow.nextStepSuggestions",
  "iflow.autoCompressOnIdle",
  "iflow.autoMemoryCapture",
  "iflow.memoryExtractTimeoutSeconds",
  "iflow.memoryMaintenanceEnabled",
  "iflow.memoryMaintenanceIntervalDays",
  "iflow.memoryMaintenanceIdleMinutes",
  "iflow.memoryMaintenanceGlobalTokenBudget",
  "iflow.memoryMaintenanceProjectTokenBudget",
  "iflow.memoryMaintenanceStrategy",
  "iflow.nextStepTimeoutSeconds",
  "iflow.compressTimeoutSeconds",
  "iflow.autoCompressThresholdPercent",
  "iflow.checkpoints",
  "iflow.checkpointMaxFiles",
  "iflow.checkpointMaxFileMB",
  "iflow.checkpointDir",
  "iflow.checkpointMaxTurns",
  "iflow.checkpointMaxSizeMB",
];

const nlsKey = (raw: string): string => {
  expect(raw.startsWith("%") && raw.endsWith("%"), `应使用 %key% 占位: ${raw}`).toBe(true);
  return raw.slice(1, -1);
};

/** 一个配置项引用的全部 nls 键：description（或 markdownDescription）+ enumDescriptions。 */
const nlsKeysOf = (schema: SettingSchema): string[] => {
  const keys = [nlsKey(schema.description ?? schema.markdownDescription ?? "")];
  for (const raw of schema.enumDescriptions ?? []) keys.push(nlsKey(raw));
  return keys;
};

const assertNlsPresent = (key: string): void => {
  expect(typeof en[key], `英文 nls 缺少 ${key}`).toBe("string");
  expect(en[key]!.trim().length, `英文 nls 的 ${key} 为空`).toBeGreaterThan(0);
  expect(typeof zh[key], `中文 nls 缺少 ${key}`).toBe("string");
  expect(zh[key]!.trim().length, `中文 nls 的 ${key} 为空`).toBeGreaterThan(0);
};

describe("设置声明与 nls 一致性守卫（全部 iflow.* 配置）", () => {
  const props = pkg.contributes.configuration.properties;
  const declared = Object.keys(props).filter((k) => k.startsWith("iflow."));

  it("声明的 iflow.* 配置项与快照一致（增删须显式更新 ALL_KEYS）", () => {
    expect([...declared].sort()).toEqual([...ALL_KEYS].sort());
  });

  it.each(ALL_KEYS)("%s 声明了合法的 type", (key) => {
    const schema = props[key];
    expect(schema, `${key} 未声明`).toBeTruthy();
    expect(["boolean", "string", "number", "array", "object"]).toContain(schema!.type);
  });

  it("每个配置项都声明了 default（防止声明了却无默认值的空设置）", () => {
    for (const key of declared) {
      expect(Object.prototype.hasOwnProperty.call(props[key]!, "default"), `${key} 缺少 default`).toBe(true);
    }
  });

  it("数值项的 minimum / default / maximum 自洽", () => {
    for (const key of declared) {
      const schema = props[key]!;
      if (schema.type !== "number") continue;
      expect(typeof schema.minimum, `${key} 缺少 minimum`).toBe("number");
      expect(typeof schema.default, `${key} 的 default 非数值`).toBe("number");
      expect(schema.default as number).toBeGreaterThanOrEqual(schema.minimum!);
      // 部分 checkpoint 数值项只设 minimum、无 maximum，因此 maximum 是可选护栏。
      if (schema.maximum !== undefined) {
        expect(schema.minimum!).toBeLessThanOrEqual(schema.maximum);
        expect(schema.default as number).toBeLessThanOrEqual(schema.maximum);
      }
    }
  });

  it("枚举项 enum 非空且无重复；若声明 enumDescriptions 则与 enum 等长且都是 nls 键", () => {
    for (const key of declared) {
      const schema = props[key]!;
      if (!schema.enum) continue;
      expect(schema.enum.length, `${key} 的 enum 为空`).toBeGreaterThan(0);
      expect(new Set(schema.enum).size, `${key} 的 enum 有重复值`).toBe(schema.enum.length);
      // 现存多数 enum 项（theme / uiFontSize / language 等）只有 enum、没有逐项解释，
      // 故不强制「有 enum 必有 enumDescriptions」；一旦声明则必须结构正确。
      if (schema.enumDescriptions) {
        expect(schema.enumDescriptions, `${key} 的 enumDescriptions 长度`).toHaveLength(schema.enum.length);
        for (const raw of schema.enumDescriptions) nlsKey(raw);
      }
    }
  });

  it.each(ALL_KEYS)("%s 的 description 用 %%key%% 占位且中英 nls 均非空", (key) => {
    const schema = props[key]!;
    assertNlsPresent(nlsKey(schema.description ?? schema.markdownDescription ?? ""));
  });

  it("每个 enumDescription 的 nls 键在中英两份 bundle 都存在且非空", () => {
    const keys = new Set<string>();
    for (const key of declared) {
      for (const raw of props[key]!.enumDescriptions ?? []) keys.add(nlsKey(raw));
    }
    expect(keys.size, "至少应有枚举项的逐项解释 nls 键").toBeGreaterThan(0);
    for (const key of keys) assertNlsPresent(key);
  });

  it("两份 nls bundle 的键集合互为一致（整份 + iflow.configuration.* 子集）", () => {
    expect([...Object.keys(en)].sort()).toEqual([...Object.keys(zh)].sort());
    const enConf = Object.keys(en).filter((k) => k.startsWith("iflow.configuration."));
    const zhConf = Object.keys(zh).filter((k) => k.startsWith("iflow.configuration."));
    expect(enConf.sort()).toEqual(zhConf.sort());
  });

  it("配置引用的 nls 键加 configuration.title 恰好覆盖全部 iflow.configuration.* 键", () => {
    const referenced = new Set<string>();
    for (const key of declared) {
      for (const nls of nlsKeysOf(props[key]!)) referenced.add(nls);
    }
    // configuration.title 由 contributes.configuration.title 引用，而非某个 setting 的 description。
    referenced.add("iflow.configuration.title");
    const confKeys = Object.keys(en).filter((k) => k.startsWith("iflow.configuration."));
    expect([...referenced].sort()).toEqual(confKeys.sort());
  });
});
