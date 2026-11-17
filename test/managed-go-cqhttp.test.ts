import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, type ManagedOneBotConfig } from "../src/qq/managed/provider.js";
import { GO_CQHTTP_VERSION, goCqhttpProvider } from "../src/qq/managed/go-cqhttp.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "managed-go-cqhttp-"));
  dirs.push(dir);
  return dir;
}

function config(overrides: Partial<ManagedOneBotConfig> = {}): ManagedOneBotConfig {
  return {
    installDir: tempDir(),
    platform: "linux",
    arch: "x64",
    port: 6700,
    accessToken: "secret-token-xyz",
    reversePostUrl: "http://127.0.0.1:3000/onebot",
    ...overrides,
  };
}

describe("go-cqhttp.writeConfig", () => {
  it("生成含 uin=0 / token / host+port / 反向上报 / 心跳的 config.yml", async () => {
    const cfg = config({ port: 6790 });
    const result = await goCqhttpProvider.writeConfig(cfg);

    expect(result.configPath).toBe(join(cfg.installDir, "config.yml"));
    expect(result.written).toEqual([result.configPath]);

    const yaml = readFileSync(result.configPath, "utf8");
    expect(yaml).toContain("uin: 0");
    expect(yaml).toContain("access-token");
    expect(yaml).toContain(cfg.accessToken);
    expect(yaml).toContain("host: 127.0.0.1");
    expect(yaml).toContain("port: 6790");
    expect(yaml).toContain(cfg.reversePostUrl);
    expect(yaml).toContain("type: string");
    expect(yaml).toContain("heartbeat:");
    expect(yaml).toContain("disabled: false");
  });

  it("token 不出现在返回值里，返回值只有 configPath / written", async () => {
    const cfg = config();
    const result = await goCqhttpProvider.writeConfig(cfg);
    expect(Object.keys(result).sort()).toEqual(["configPath", "written"]);
    expect(JSON.stringify(result)).not.toContain(cfg.accessToken);
  });

  it("已有 config.yml 不覆盖，written 为空且原内容原样保留", async () => {
    const cfg = config();
    const configPath = join(cfg.installDir, "config.yml");
    writeFileSync(configPath, "USER_OWNED_CONFIG\n", "utf8");

    const result = await goCqhttpProvider.writeConfig(cfg);
    expect(result.configPath).toBe(configPath);
    expect(result.written).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe("USER_OWNED_CONFIG\n");
  });
});

describe("go-cqhttp 下载 URL 与二进制相对路径", () => {
  // 2026-11-17 GitHub API + HEAD 实测：通用包资产名不带版本，仅 deb/rpm 带版本。
  const cases: Array<[NodeJS.Platform, string, string, string]> = [
    [
      "win32",
      "x64",
      "https://github.com/Mrs4s/go-cqhttp/releases/download/v1.2.0/go-cqhttp_windows_amd64.zip",
      "go-cqhttp.exe",
    ],
    [
      "linux",
      "x64",
      "https://github.com/Mrs4s/go-cqhttp/releases/download/v1.2.0/go-cqhttp_linux_amd64.tar.gz",
      "go-cqhttp",
    ],
    [
      "darwin",
      "arm64",
      "https://github.com/Mrs4s/go-cqhttp/releases/download/v1.2.0/go-cqhttp_darwin_arm64.tar.gz",
      "go-cqhttp",
    ],
  ];

  for (const [platform, arch, expectedUrl, binary] of cases) {
    it(`${platform}/${arch} 的 URL 与路径`, () => {
      const cfg = config({ platform, arch });
      expect(goCqhttpProvider.downloadUrl(cfg)).toBe(expectedUrl);
      expect(goCqhttpProvider.binaryRelativePath(cfg)).toBe(binary);
    });
  }

  it("资产名不含版本号（防回归：通用包资产名不带版本，仅 deb/rpm 带版本）", () => {
    for (const [platform, arch] of cases) {
      const url = goCqhttpProvider.downloadUrl(config({ platform, arch }));
      expect(url).not.toContain(`_${GO_CQHTTP_VERSION}_`);
      expect(url).not.toContain(`go-cqhttp_${GO_CQHTTP_VERSION}_`);
    }
  });

  it("不支持的平台抛错，不返回假装可用的 URL", () => {
    const cfg = config({ platform: "freebsd", arch: "x64" });
    expect(() => goCqhttpProvider.downloadUrl(cfg)).toThrow(/不支持/);
    expect(() => goCqhttpProvider.binaryRelativePath(cfg)).toThrow(/不支持/);
    expect(goCqhttpProvider.isSupported("freebsd", "x64")).toBe(false);
  });
});

describe("go-cqhttp 启动参数", () => {
  it("返回空参数数组（默认读取 cwd 下 config.yml）", () => {
    expect(goCqhttpProvider.buildArgs(config())).toEqual([]);
  });

  it("与 getProvider 取到的是同一个 provider", () => {
    expect(getProvider("go-cqhttp")).toBe(goCqhttpProvider);
  });
});
