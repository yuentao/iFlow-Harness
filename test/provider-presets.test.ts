import { describe, expect, it } from "vitest";
import { matchProviderPreset, PROVIDER_PRESETS } from "../shared/provider-presets";

describe("provider presets", () => {
  it("keeps ids and endpoints unique", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    const endpoints = PROVIDER_PRESETS.map((preset) =>
      preset.baseUrl.trim().replace(/\/+$/, "").toLowerCase(),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it("uses shareable http(s) links and non-empty guidance text", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.label.trim()).not.toBe("");
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      if (preset.keyUrl) expect(preset.keyUrl).toMatch(/^https:\/\//);
      if (preset.docsUrl) expect(preset.docsUrl).toMatch(/^https:\/\//);
      expect(preset.note.trim()).not.toBe("");
    }
  });

  it("matches an existing base URL ignoring trailing slashes and case", () => {
    expect(matchProviderPreset("https://api.deepseek.com/")?.id).toBe("deepseek");
    expect(matchProviderPreset("  HTTP://127.0.0.1:11434/v1  ")?.id).toBe("ollama");
    expect(matchProviderPreset("https://unknown.example.com/v1")).toBeNull();
    expect(matchProviderPreset("")).toBeNull();
  });

  it("does not list the discontinued iFlow open platform", () => {
    expect(PROVIDER_PRESETS.some((preset) => preset.id === "iflow")).toBe(false);
    expect(PROVIDER_PRESETS.some((preset) => preset.baseUrl.includes("apis.iflow.cn"))).toBe(false);
  });
});
