import { describe, it, expect } from "vitest";
import {
  getProvider,
  type ManagedProviderId,
  type ManagedOneBotConfig,
} from "../src/qq/managed/provider.js";

const base: ManagedOneBotConfig = {
  installDir: "C:/tmp/managed",
  platform: "win32",
  arch: "x64",
  port: 6700,
  accessToken: "token-must-not-leak",
  reversePostUrl: "http://127.0.0.1:3000/onebot",
};

describe("getProvider", () => {
  it("返回 go-cqhttp 实现且元数据自洽", () => {
    const provider = getProvider("go-cqhttp");
    expect(provider.id).toBe("go-cqhttp");
    expect(provider.displayName).toBe("go-cqhttp");
    expect(provider.isSupported("win32", "x64")).toBe(true);
  });

  it("napcat 是占位实现：可获取但明确不支持、调用即抛错", async () => {
    const provider = getProvider("napcat");
    expect(provider.id).toBe("napcat");
    expect(provider.displayName).toContain("尚未实现");
    expect(provider.isSupported("win32", "x64")).toBe(false);
    expect(provider.isSupported("linux", "x64")).toBe(false);
    expect(() => provider.downloadUrl(base)).toThrow(/尚未实现/);
    expect(() => provider.binaryRelativePath(base)).toThrow(/尚未实现/);
    expect(() => provider.loginProbeUrl(base)).toThrow(/尚未实现/);
    expect(() => provider.buildArgs(base)).toThrow(/尚未实现/);
    await expect(provider.writeConfig(base)).rejects.toThrow(/尚未实现/);
  });

  it("未知 id 抛错而不是静默返回 undefined", () => {
    expect(() => getProvider("not-a-provider" as ManagedProviderId)).toThrow(/未知/);
  });
});

describe("go-cqhttp 支持矩阵", () => {
  const provider = getProvider("go-cqhttp");
  const cases: Array<[NodeJS.Platform, string, boolean]> = [
    ["win32", "x64", true],
    ["linux", "x64", true],
    ["darwin", "arm64", true],
    ["win32", "arm64", false],
    ["linux", "arm64", false],
    ["darwin", "x64", false],
    ["freebsd", "x64", false],
    ["win32", "ia32", false],
  ];

  for (const [platform, arch, supported] of cases) {
    it(`${platform}/${arch} → ${supported}`, () => {
      expect(provider.isSupported(platform, arch)).toBe(supported);
    });
  }
});

describe("loginProbeUrl", () => {
  it("端口正确且指向 /get_login_info", () => {
    const provider = getProvider("go-cqhttp");
    expect(provider.loginProbeUrl({ ...base, port: 12345 })).toBe(
      "http://127.0.0.1:12345/get_login_info",
    );
    expect(provider.loginProbeUrl({ ...base, port: 1 })).toBe(
      "http://127.0.0.1:1/get_login_info",
    );
  });
});
