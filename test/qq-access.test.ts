import { describe, expect, it } from "vitest";
import {
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
