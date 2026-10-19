import { describe, expect, it } from "vitest";
import { classifyErrorAdvice } from "../shared/error-advice";

describe("classifyErrorAdvice (3.6)", () => {
  it("classifies the bundled-CLI-missing banner as cli → runtime settings", () => {
    const advice = classifyErrorAdvice(
      "内置 iFlow CLI 缺失，扩展包不完整，请重新安装：ENOENT: no such file or directory",
    );
    expect(advice).not.toBeNull();
    expect(advice!.kind).toBe("cli");
    expect(advice!.openSettingsTab).toBe("runtime");
  });

  it("classifies raw loader ENOENT on the vendored entry as cli", () => {
    expect(classifyErrorAdvice("Cannot find module '.../vendor/iflow-cli/bundle/entry.js'")?.kind).toBe("cli");
  });

  it("classifies 401/403 and key/balance wording as auth → api settings", () => {
    for (const message of [
      "Request failed with status code 401",
      "invalid_api_key: The API key provided",
      "Incorrect API key provided",
      "permission_error: This API key lacks access",
      "余额不足，请充值后重试",
      "API 密钥已过期",
    ]) {
      const advice = classifyErrorAdvice(message);
      expect(advice, message)?.toMatchObject({ kind: "auth", openSettingsTab: "api" });
    }
  });

  it("classifies delisted/unsupported models as model → api settings", () => {
    expect(classifyErrorAdvice("model_not_found: The model gpt-9 does not exist")?.kind).toBe("model");
    expect(classifyErrorAdvice("Current model 'x' does not support thinking mode")?.kind).toBe("model");
    expect(classifyErrorAdvice("模型 deepseek-v2 已下架")?.kind).toBe("model");
  });

  it("classifies transport failures as network (no settings tab)", () => {
    for (const message of [
      "fetch failed: connect ECONNREFUSED 127.0.0.1:443",
      "read ECONNRESET",
      "connect ETIMEDOUT",
      "网络超时，请检查代理设置",
    ]) {
      const advice = classifyErrorAdvice(message);
      expect(advice, message)?.toMatchObject({ kind: "network" });
      expect(advice!.openSettingsTab).toBeUndefined();
    }
  });

  it("overflow and rateLimit rank above the generic buckets", () => {
    // A 429 that also mentions "model" must not fall into the model bucket.
    expect(classifyErrorAdvice("429 too many requests for model gpt-9")?.kind).toBe("rateLimit");
    expect(classifyErrorAdvice("当前模型已达到平台速率限制")?.kind).toBe("rateLimit");
    expect(classifyErrorAdvice("maximum context length exceeded")?.kind).toBe("overflow");
    expect(classifyErrorAdvice("上下文长度超出模型上限")?.kind).toBe("overflow");
  });

  it("returns null for unrecognized messages (never a wrong guess)", () => {
    expect(classifyErrorAdvice("")).toBeNull();
    expect(classifyErrorAdvice("Something went wrong in the tool loop")).toBeNull();
  });
});
