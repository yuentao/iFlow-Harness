/**
 * 子会话工具 / MCP 白名单纯逻辑：默认不限制、工具白名单进 settings、
 * MCP 白名单在 spawn 层与 broker 实际服务器名取交集。
 */
import { describe, it, expect } from "vitest";
import {
  buildChildSessionSettings,
  effectiveMcpServerNames,
  normalizeAllowlist,
} from "../shared/super-tool-policy.js";

describe("normalizeAllowlist", () => {
  it("缺省与空数组都归一成空数组", () => {
    expect(normalizeAllowlist(undefined)).toEqual([]);
    expect(normalizeAllowlist([])).toEqual([]);
  });

  it("trim、去空串、去重并保持顺序", () => {
    expect(normalizeAllowlist(["  read_file ", "", "read_file", "  ", "run_shell_command"])).toEqual([
      "read_file",
      "run_shell_command",
    ]);
  });

  it("忽略非字符串脏值", () => {
    expect(normalizeAllowlist(["ok", null as unknown as string, 42 as unknown as string])).toEqual(["ok"]);
  });
});

describe("buildChildSessionSettings", () => {
  it("两个白名单都空时不传 settings（保持既有子会话行为）", () => {
    expect(buildChildSessionSettings(undefined, undefined)).toBeUndefined();
    expect(buildChildSessionSettings([], [])).toBeUndefined();
    expect(buildChildSessionSettings(["  ", ""], ["  "])).toBeUndefined();
  });

  it("工具白名单非空时只写 allowed_tools", () => {
    expect(buildChildSessionSettings(["read_file", "write_file"], undefined)).toEqual({
      allowed_tools: ["read_file", "write_file"],
    });
  });

  it("工具白名单先归一化再写入", () => {
    expect(buildChildSessionSettings([" read_file ", "", "read_file"], undefined)).toEqual({
      allowed_tools: ["read_file"],
    });
  });

  it("仅 MCP 白名单非空时返回空 settings（工具仍全开）", () => {
    expect(buildChildSessionSettings(undefined, ["bing-search"])).toEqual({});
  });

  it("两者都配置时只把工具白名单写进 settings", () => {
    expect(buildChildSessionSettings(["read_file"], ["bing-search"])).toEqual({
      allowed_tools: ["read_file"],
    });
  });

  it("绝不写 disallowed_tools（避免误把子会话工具关掉）", () => {
    const settings = buildChildSessionSettings(["read_file"], undefined);
    expect(settings).not.toHaveProperty("disallowed_tools");
  });
});

describe("effectiveMcpServerNames", () => {
  it("白名单为空时不附加 MCP 过滤参数", () => {
    expect(effectiveMcpServerNames(undefined, ["bing-search"])).toBeUndefined();
    expect(effectiveMcpServerNames([], ["bing-search"])).toBeUndefined();
    expect(effectiveMcpServerNames(["  "], undefined)).toBeUndefined();
  });

  it("返回白名单与 broker 实际服务器名的交集", () => {
    expect(effectiveMcpServerNames(["bing-search", "ddg-search", "not-there"], ["bing-search", "exa"])).toEqual([
      "bing-search",
    ]);
  });

  it("交错与重复的名字归一化后再取交集，顺序跟白名单", () => {
    expect(
      effectiveMcpServerNames(
        [" bing-search ", "exa", "bing-search", ""],
        ["exa", "bing-search"],
      ),
    ).toEqual(["bing-search", "exa"]);
  });

  it("交集为空返回空数组（buildAcpCommand 会翻成无 MCP 哨兵）", () => {
    expect(effectiveMcpServerNames(["not-there"], ["bing-search"])).toEqual([]);
    expect(effectiveMcpServerNames(["bing-search"], undefined)).toEqual([]);
  });
});
