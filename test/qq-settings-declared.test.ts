import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * QQ 远程任务的 9 项设置声明。这些断言把设置项钉在磁盘上：键名、类型、
 * 默认值、取值范围，以及每个 nls 键在英文与中文两份 bundle 里都存在且非空
 * —— 漂移会让设置项静默失色。描述文案同时受「如实」约束：不得再声称
 * 「只声明、未接线」，且未实现的能力必须写明会被拒绝。
 *
 * 阶段4 移除了历史遗留的 adapter / endpoint / bridgePort 三项设置，
 * 通道恒走 QQBot，声明里不再有它们。
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
  items?: { type?: string | string[]; anyOf?: Array<{ type?: string }> };
  description?: string;
  markdownDescription?: string;
}

interface Spec {
  key: string;
  type: "boolean" | "string" | "number" | "array";
  default: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  /** array 设置允许的元素类型（联合格式时多于一项）。 */
  itemTypes?: string[];
}

const SPECS: Spec[] = [
  { key: "iflow.qq.enabled", type: "boolean", default: false },
  {
    key: "iflow.qq.allowedUsers",
    type: "array",
    default: [],
    itemTypes: ["string", "object"],
  },
  {
    key: "iflow.qq.allowedGroups",
    type: "array",
    default: [],
    itemTypes: ["string", "object"],
  },
  { key: "iflow.qq.workspace", type: "string", default: "" },
  {
    key: "iflow.qq.remotePolicy",
    type: "string",
    default: "supervised",
    enum: ["readonly", "supervised", "trusted"],
  },
  { key: "iflow.qq.maxConcurrentTasks", type: "number", default: 2, minimum: 1, maximum: 10 },
  { key: "iflow.qq.rateLimitPerMin", type: "number", default: 6, minimum: 1, maximum: 60 },
  {
    key: "iflow.qq.resultDetail",
    type: "string",
    default: "standard",
    enum: ["summary", "standard", "full"],
  },
  { key: "iflow.qq.autoMerge", type: "boolean", default: false },
];

const nlsKey = (raw: string): string => {
  expect(raw.startsWith("%") && raw.endsWith("%"), `应使用 %key% 占位: ${raw}`).toBe(true);
  return raw.slice(1, -1);
};

describe("QQ 远程任务设置声明 (Wave2-B)", () => {
  const props = pkg.contributes.configuration.properties;
  const qqKeys = Object.keys(props).filter((k) => k.startsWith("iflow.qq."));

  it("恰好声明 9 项 iflow.qq.* 设置", () => {
    expect(qqKeys.sort()).toEqual(SPECS.map((s) => s.key).sort());
  });

  it.each(SPECS)("$key 的类型 / 默认值 / 取值范围与约定一致", (spec) => {
    const schema = props[spec.key];
    expect(schema, `${spec.key} 未声明`).toBeTruthy();
    expect(schema.type).toBe(spec.type);
    expect(schema.default).toEqual(spec.default);
    if (spec.minimum !== undefined) expect(schema.minimum).toBe(spec.minimum);
    if (spec.maximum !== undefined) expect(schema.maximum).toBe(spec.maximum);
    if (spec.enum) expect(schema.enum).toEqual(spec.enum);
    if (spec.itemTypes) {
      const items = schema.items;
      const declared = Array.isArray(items?.type)
        ? items!.type
        : (items?.anyOf ?? []).map((branch) => branch.type);
      expect(declared).toEqual(spec.itemTypes);
    }
  });

  it.each(SPECS)("$key 的 description 用 %key% 占位", (spec) => {
    const schema = props[spec.key]!;
    const raw = schema.description ?? schema.markdownDescription ?? "";
    const expected = `${spec.key.replace(/^iflow\./, "iflow.configuration.")}.description`;
    expect(nlsKey(raw)).toBe(expected);
  });

  it("枚举设置逐项解释（enumDescriptions 与 enum 等长且都是 nls 键）", () => {
    for (const key of ["iflow.qq.remotePolicy", "iflow.qq.resultDetail"]) {
      const schema = props[key]!;
      expect(schema.enumDescriptions, `${key} 缺少 enumDescriptions`).toHaveLength(schema.enum!.length);
      for (const raw of schema.enumDescriptions!) nlsKey(raw);
    }
  });

  it("每个 description / enumDescription 的 nls 键在中英两份 bundle 里都存在且非空", () => {
    const keys = new Set<string>();
    for (const key of qqKeys) {
      const schema = props[key]!;
      keys.add(nlsKey(schema.description ?? schema.markdownDescription ?? ""));
      for (const raw of schema.enumDescriptions ?? []) keys.add(nlsKey(raw));
    }
    // 9 个 description + 6 个枚举项解释（remotePolicy 3 + resultDetail 3）。
    expect(keys.size).toBe(15);
    for (const key of keys) {
      expect(typeof en[key], `英文 nls 缺少 ${key}`).toBe("string");
      expect(en[key]!.trim().length, `英文 nls 的 ${key} 为空`).toBeGreaterThan(0);
      expect(typeof zh[key], `中文 nls 缺少 ${key}`).toBe("string");
      expect(zh[key]!.trim().length, `中文 nls 的 ${key} 为空`).toBeGreaterThan(0);
    }
  });

  it("supervised 策略写明「QQ 审批 + 5 分钟未响应按拒绝」", () => {
    const zhText = zh["iflow.configuration.qq.remotePolicy.supervised"] ?? "";
    expect(zhText).toContain("审批");
    expect(zhText).toContain("5 分钟");
    expect(zhText).toContain("拒绝");

    const enText = en["iflow.configuration.qq.remotePolicy.supervised"] ?? "";
    expect(enText).toContain("approval");
    expect(enText).toContain("5 minutes");
    expect(enText).toContain("denial");
  });

  it("描述如实：不再声称「仅声明 / 尚未接线」", () => {
    const staleZh = ["仅声明", "尚未接线"];
    const staleEn = ["only declares", "not wired", "nothing is wired"];
    for (const key of Object.keys(zh).filter((k) => k.startsWith("iflow.configuration.qq."))) {
      for (const phrase of staleZh) {
        expect(zh[key], `中文 nls 的 ${key} 仍含陈旧表述「${phrase}」`).not.toContain(phrase);
      }
    }
    for (const key of Object.keys(en).filter((k) => k.startsWith("iflow.configuration.qq."))) {
      const lowered = en[key]!.toLowerCase();
      for (const phrase of staleEn) {
        expect(lowered, `英文 nls 的 ${key} 仍含陈旧表述「${phrase}」`).not.toContain(phrase);
      }
    }

    // workspace 只支持当前工作区根：描述必须说清楚「指向其他根会拒绝启动」。
    const zhWorkspace = zh["iflow.configuration.qq.workspace.description"] ?? "";
    expect(zhWorkspace).toContain("当前工作区根");
    expect(zhWorkspace).toContain("拒绝启动");
    const enWorkspace = en["iflow.configuration.qq.workspace.description"] ?? "";
    expect(enWorkspace).toContain("current workspace root");
    expect(enWorkspace).toContain("refuse");
  });
});