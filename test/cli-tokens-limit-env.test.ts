import { describe, it, expect } from "vitest";
import {
  cliTokensLimitEnv,
  effectiveCliTokensLimit,
  type TokensLimitHolder,
} from "../src/acp/cli-tokens-limit.js";

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
