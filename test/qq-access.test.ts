import { describe, expect, it } from "vitest";
import {
  isValidQqId,
  maskQqOpenId,
  normalizeQqAllowEntries,
  normalizeQqAllowEntry,
  serializeQqAllowEntries,
} from "../shared/qq-access.js";

describe("maskQqOpenId", () => {
  it("正常长度：前 4 位 + 固定 8 个星号 + 后 4 位", () => {
    expect(maskQqOpenId("D754D2240C503C2ABE2B236DC1E78D11")).toBe("D754********8D11");
    expect(maskQqOpenId("ABCDEF0123456789ABCDEF0123456789")).toBe("ABCD********6789");
  });

  it("星号个数恒为 8，不随原始长度变化（不能用星号推断长度）", () => {
    const short = maskQqOpenId("0123456789");
    const long = maskQqOpenId("0123456789abcdef0123456789abcdef");
    expect(short.split("*").length - 1).toBe(8);
    expect(long.split("*").length - 1).toBe(8);
  });

  it("长度不超过 8 的异常值整体覆盖，绝不原样返回", () => {
    for (const raw of ["1", "1234", "12345678", " abcdef "]) {
      const masked = maskQqOpenId(raw);
      expect(masked).toBe("********");
      expect(masked).not.toContain(raw.trim());
    }
  });

  it("空串 / 纯空白 / undefined / null 安全返回空串", () => {
    expect(maskQqOpenId("")).toBe("");
    expect(maskQqOpenId("   ")).toBe("");
    expect(maskQqOpenId(undefined)).toBe("");
    expect(maskQqOpenId(null)).toBe("");
  });
});

describe("normalizeQqAllowEntry", () => {
  it("接受裸字符串与对象，trim 备注；空备注等于没有备注", () => {
    expect(normalizeQqAllowEntry(" id-1 ")).toEqual({ openid: "id-1" });
    expect(normalizeQqAllowEntry({ openid: " id-2 ", note: " 同事 " })).toEqual({
      openid: "id-2",
      note: "同事",
    });
    expect(normalizeQqAllowEntry({ openid: "id-3", note: "   " })).toEqual({ openid: "id-3" });
  });

  it("结构非法的值返回 null（不猜测）", () => {
    expect(normalizeQqAllowEntry("")).toBeNull();
    expect(normalizeQqAllowEntry("   ")).toBeNull();
    expect(normalizeQqAllowEntry({ openid: "" })).toBeNull();
    expect(normalizeQqAllowEntry({ openid: 123 })).toBeNull();
    expect(normalizeQqAllowEntry(null)).toBeNull();
    expect(normalizeQqAllowEntry(42)).toBeNull();
    expect(normalizeQqAllowEntry(["id"])).toBeNull();
  });
});

describe("normalizeQqAllowEntries", () => {
  it("兼容旧的裸字符串数组与新对象条目，按 openid 去重且保持首次出现顺序", () => {
    expect(
      normalizeQqAllowEntries([
        " legacy ",
        { openid: "user-2", note: "同事" },
        "legacy",
        { openid: "user-3" },
        null,
        7,
      ]),
    ).toEqual([{ openid: "legacy" }, { openid: "user-2", note: "同事" }, { openid: "user-3" }]);
  });

  it("非数组输入返回空列表", () => {
    expect(normalizeQqAllowEntries(undefined)).toEqual([]);
    expect(normalizeQqAllowEntries("id-1")).toEqual([]);
    expect(normalizeQqAllowEntries({ openid: "id-1" })).toEqual([]);
  });
});

describe("归一函数的合法性防线（Host 读/写路径共用）", () => {
  it("normalizeQqAllowEntry 拒绝脱敏串 / 内部空白 / 超长 / 过短 / 非法字符", () => {
    // 这些值过去只有 webview UI 的 isValidQqId 会挡；手改 settings.json、
    // 历史脏配置、未来的 Host API 都能绕过面板写进白名单。归一函数现在
    // 统一挡住，读写两条路径共用这一道防线。
    expect(normalizeQqAllowEntry("D754********8D11")).toBeNull();
    expect(normalizeQqAllowEntry({ openid: "D754********8D11", note: "同事" })).toBeNull();
    expect(normalizeQqAllowEntry("********")).toBeNull();
    expect(normalizeQqAllowEntry("D754 D224")).toBeNull();
    expect(normalizeQqAllowEntry({ openid: "user\t2" })).toBeNull();
    expect(normalizeQqAllowEntry("a".repeat(65))).toBeNull();
    expect(normalizeQqAllowEntry("abc")).toBeNull();
    expect(normalizeQqAllowEntry("群1234")).toBeNull();
    expect(normalizeQqAllowEntry("user@example.com")).toBeNull();
  });

  it("首尾空白 trim 后合法仍接受（先 trim 再校验，不误杀正常复制的 id）", () => {
    expect(normalizeQqAllowEntry(" D754D2240C503C2ABE2B236DC1E78D11 ")).toEqual({
      openid: "D754D2240C503C2ABE2B236DC1E78D11",
    });
    expect(normalizeQqAllowEntry({ openid: " user-2 ", note: " 同事 " })).toEqual({
      openid: "user-2",
      note: "同事",
    });
  });

  it("normalizeQqAllowEntries 过滤历史脏配置，只保留合法条目", () => {
    const entries = normalizeQqAllowEntries([
      "10001",
      "D754********8D11", // 脱敏串
      { openid: "user-2 ", note: "同事" }, // trim 后合法
      { openid: "  ", note: "空 id" },
      "   ",
      "abc", // 过短
      { openid: "a".repeat(65) }, // 超长
      "群1234", // 非法字符
    ]);
    expect(entries).toEqual([{ openid: "10001" }, { openid: "user-2", note: "同事" }]);
  });
});

describe("serializeQqAllowEntries", () => {
  it("有备注写对象、没备注写裸字符串（写路径里绝不出现脱敏星号）", () => {
    const stored = serializeQqAllowEntries([
      { openid: "user-1", note: " 同事 " },
      { openid: "user-2" },
      { openid: "user-3", note: "" },
    ]);
    expect(stored).toEqual([{ openid: "user-1", note: "同事" }, "user-2", "user-3"]);
    expect(JSON.stringify(stored)).not.toContain("*");
  });

  it("8 位群号脱敏后只剩余星号：备注是唯一可辨识信息，存储仍沿用联合格式", () => {
    // 群号常见 8 位左右，脱敏后恒为 8 个 `*`，同列表内多个群无法靠 id 区分。
    expect(maskQqOpenId("12345678")).toBe("********");
    expect(
      serializeQqAllowEntries([
        { openid: "12345678" },
        { openid: "87654321", note: "测试群" },
      ]),
    ).toEqual(["12345678", { openid: "87654321", note: "测试群" }]);
  });
});

describe("isValidQqId", () => {
  it("接受典型 openid 与数字群号，以及含 _ / - 的 id", () => {
    for (const value of [
      "D754D2240C503C2ABE2B236DC1E78D11",
      "ABCDEF0123456789ABCDEF0123456789",
      "12345678",
      "1234567890",
      "2283901234",
      "user-2",
      "open_1",
      "a-b_C9",
    ]) {
      expect(isValidQqId(value), value).toBe(true);
    }
  });

  it("拒绝从界面复制来的脱敏串（含星号，永远匹配不上）", () => {
    expect(isValidQqId("D754********8D11")).toBe(false);
    expect(isValidQqId("********")).toBe(false);
    expect(isValidQqId("1234********7890")).toBe(false);
  });

  it("拒绝含空白 / 空串 / 纯空白", () => {
    expect(isValidQqId(" D754D2240C503C2ABE2B236DC1E78D11")).toBe(false);
    expect(isValidQqId("D754D2240C503C2ABE2B236DC1E78D11 ")).toBe(false);
    expect(isValidQqId("D754 D224")).toBe(false);
    expect(isValidQqId("D754\tD224")).toBe(false);
    expect(isValidQqId("D754\nD224")).toBe(false);
    expect(isValidQqId("")).toBe(false);
    expect(isValidQqId("   ")).toBe(false);
  });

  it("拒绝过短 / 超长 / 其它字符与非字符串", () => {
    expect(isValidQqId("abc")).toBe(false);
    expect(isValidQqId("a".repeat(65))).toBe(false);
    expect(isValidQqId("abc@example.com")).toBe(false);
    expect(isValidQqId("群1234")).toBe(false);
    expect(isValidQqId("１２３４")).toBe(false);
    expect(isValidQqId(12345678)).toBe(false);
    expect(isValidQqId(undefined)).toBe(false);
    expect(isValidQqId(null)).toBe(false);
    // 上限本身是合法的（64 位），别把边界判成非法。
    expect(isValidQqId("a".repeat(64))).toBe(true);
  });
});
