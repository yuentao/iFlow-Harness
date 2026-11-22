import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cliTokensLimitEnv,
  effectiveCliTokensLimit,
  tokensLimitEnvFromSettings,
  type TokensLimitHolder,
} from "../src/acp/cli-tokens-limit.js";
import { parseContextWindowOverrides, resolveContextWindowWithSource } from "../shared/context-window.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-tokens-limit-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function settingsFile(name: string, content: Record<string, unknown>): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

function env(effective: number | undefined): NodeJS.ProcessEnv {
  return { IFLOW_HARNESS: "1", ...cliTokensLimitEnv(effective) };
}

describe("effectiveCliTokensLimit", () => {
  it("prefers the active profile's positive tokensLimit", () => {
    const profile: TokensLimitHolder = { tokensLimit: 1000000 };
    const settings: TokensLimitHolder = { tokensLimit: 128000 };
    expect(effectiveCliTokensLimit(profile, settings)).toBe(1000000);
  });

  it("uses the settings top-level tokensLimit when the profile has none", () => {
    expect(effectiveCliTokensLimit({}, { tokensLimit: 1000000 })).toBe(1000000);
  });

  it("returns undefined when neither side has a value", () => {
    expect(effectiveCliTokensLimit({}, {})).toBeUndefined();
    expect(effectiveCliTokensLimit(null, null)).toBeUndefined();
  });

  it("treats non-positive, non-integer and non-number profile values as absent", () => {
    for (const bad of [0, -1, -1000000, 1.5, NaN, Infinity, "1000000", null, true]) {
      expect(effectiveCliTokensLimit({ tokensLimit: bad }, { tokensLimit: 1000000 })).toBe(1000000);
      expect(effectiveCliTokensLimit({ tokensLimit: bad }, {})).toBeUndefined();
    }
  });

  it("respects a smaller active-profile limit (e.g. 私有 = 128000)", () => {
    expect(effectiveCliTokensLimit({ tokensLimit: 128000 }, { tokensLimit: 1000000 })).toBe(128000);
  });
});

describe("cliTokensLimitEnv", () => {
  it("sets IFLOW_TOKENS_LIMIT=1000000 for a 1000000 effective limit", () => {
    const effective = effectiveCliTokensLimit({ tokensLimit: 1000000 }, {});
    expect(effective).toBe(1000000);
    expect(env(effective)).toEqual({ IFLOW_HARNESS: "1", IFLOW_TOKENS_LIMIT: "1000000" });
  });

  it("does not set the env key when effective is undefined", () => {
    const effective = effectiveCliTokensLimit({}, {});
    expect(effective).toBeUndefined();
    expect(env(effective)).toEqual({ IFLOW_HARNESS: "1" });
    expect("IFLOW_TOKENS_LIMIT" in env(effective)).toBe(false);
  });

  it("sets the profile's 128000 limit as a string", () => {
    const effective = effectiveCliTokensLimit({ tokensLimit: 128000 }, {});
    expect(env(effective)).toEqual({ IFLOW_HARNESS: "1", IFLOW_TOKENS_LIMIT: "128000" });
  });
});

describe("tokensLimitEnvFromSettings", () => {
  const settingsPath = settingsFile("settings.json", {
    currentApiProfile: "main",
    apiProfiles: { main: { tokensLimit: 128000 } },
    tokensLimit: 200000,
  });

  it("keeps the settings-derived value when no overrideWindow is passed", () => {
    expect(tokensLimitEnvFromSettings(settingsPath)).toEqual({ IFLOW_TOKENS_LIMIT: "128000" });
  });

  it("prefers a valid overrideWindow over both settings sources", () => {
    expect(tokensLimitEnvFromSettings(settingsPath, 960000)).toEqual({ IFLOW_TOKENS_LIMIT: "960000" });
    expect(tokensLimitEnvFromSettings(settingsPath, 1000)).toEqual({ IFLOW_TOKENS_LIMIT: "1000" });
  });

  it("falls back to settings for 0, negative, non-integer, non-finite and non-number overrides", () => {
    const bads: unknown[] = [0, -1, -960000, 1.5, NaN, Infinity, "960000", null, undefined];
    for (const bad of bads) {
      expect(tokensLimitEnvFromSettings(settingsPath, bad as number | undefined)).toEqual({
        IFLOW_TOKENS_LIMIT: "128000",
      });
    }
  });

  it("returns an empty patch for a missing settings file unless a valid override is supplied", () => {
    const missing = path.join(tempDir, "missing.json");
    expect(tokensLimitEnvFromSettings(missing)).toEqual({});
    expect(tokensLimitEnvFromSettings(missing, -1)).toEqual({});
    expect(tokensLimitEnvFromSettings(missing, 960000)).toEqual({ IFLOW_TOKENS_LIMIT: "960000" });
  });

  it("bridges hy4flash-free=960000 from context-window overrides into IFLOW_TOKENS_LIMIT", () => {
    const overrides = parseContextWindowOverrides(["hy4flash-free=960000"]);
    const resolved = resolveContextWindowWithSource("hy4flash-free", overrides);
    expect(resolved).toEqual({ window: 960000, estimated: false, source: "user" });
    const overrideWindow = resolved.source === "user" ? (resolved.window ?? undefined) : undefined;
    expect(tokensLimitEnvFromSettings(settingsPath, overrideWindow)).toEqual({
      IFLOW_TOKENS_LIMIT: "960000",
    });
  });

  it("does not forward builtin-table or fallback windows (UI-only estimates)", () => {
    const builtin = resolveContextWindowWithSource("gpt-4o", {});
    expect(builtin.source).toBe("builtin-table");
    const fallback = resolveContextWindowWithSource("totally-unknown-model", {});
    expect(fallback.source).toBe("fallback-estimate");
    for (const resolved of [builtin, fallback]) {
      // Mirrors the panel guard: only source === "user" is forwarded.
      const overrideWindow = resolved.source === "user" ? (resolved.window ?? undefined) : undefined;
      expect(overrideWindow).toBeUndefined();
      expect(tokensLimitEnvFromSettings(settingsPath, overrideWindow)).toEqual({
        IFLOW_TOKENS_LIMIT: "128000",
      });
    }
  });
});
