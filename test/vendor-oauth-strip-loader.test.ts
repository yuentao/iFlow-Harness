import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression locks for the OAuth-strip MOD (`oauth-strip-loader.cjs`).
 *
 * The loader is injected into `bundle/iflow.js` by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`) at vendoring time, using the loader's `PATCHES`
 * table. This test pins the invariants that make that injection safe:
 *   - every anchor occurs exactly once in the committed snapshot, and its
 *     sentinel is absent (so the snapshot stays un-patched on disk);
 *   - applying the table round-trips to exactly one sentinel per patch and
 *     one unique replacement, and removes the raw OAuth call sites;
 *   - the kill switch (`IFLOW_OAUTH_STRIP=0|false`) restores upstream
 *     semantics for every exported decision function.
 */

interface Patch {
  id: string;
  anchor: string;
  replacement: string;
  sentinel: string;
}

interface Loader {
  ENV_SWITCH: string;
  API_METHOD: string;
  OAUTH_METHODS: readonly string[];
  enabled(): boolean;
  disabled(): boolean;
  normalize(methodId: unknown, authType: unknown): { methodId: string; authType: string } | null;
  restoreOauthClient(methodId: unknown, config: unknown, upstream: (...a: unknown[]) => unknown): unknown;
  validateOAuthToken(methodId: unknown, config: unknown, upstream: (...a: unknown[]) => unknown): unknown;
  normalizeAuthType(authType: unknown): unknown;
  blockCredentialClear(): boolean;
  blockOauth(): boolean;
  allowStartupOauth(): boolean;
  PATCHES: Patch[];
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/oauth-strip-loader.cjs") as Loader;

const BUNDLE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "iflow.js");
const LOADER_FILE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "oauth-strip-loader.cjs");

const ORIGINAL_SWITCH = process.env.IFLOW_OAUTH_STRIP;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) {
    count++;
    at += needle.length;
  }
  return count;
}

/** Reproduce `applyLoaderPatches`' per-patch contract (anchor unique → replace → sentinel unique). */
function applyPatches(source: string, patches: Patch[]): string {
  for (const patch of patches) {
    expect(countOccurrences(source, patch.anchor), `anchor ${patch.id}`).toBe(1);
    expect(countOccurrences(source, patch.sentinel), `sentinel pre ${patch.id}`).toBe(0);
    source = source.replace(patch.anchor, patch.replacement);
    expect(countOccurrences(source, patch.sentinel), `sentinel post ${patch.id}`).toBe(1);
    expect(countOccurrences(source, patch.replacement), `replacement ${patch.id}`).toBe(1);
  }
  return source;
}

afterEach(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env.IFLOW_OAUTH_STRIP;
  else process.env.IFLOW_OAUTH_STRIP = ORIGINAL_SWITCH;
});

describe("oauth-strip-loader: bundle wiring", () => {
  it("ships the loader next to the bundle and documents the kill switch", () => {
    expect(existsSync(LOADER_FILE)).toBe(true);
    const source = readFileSync(LOADER_FILE, "utf-8");
    expect(source).toContain("IFLOW_OAUTH_STRIP");
    expect(loader.ENV_SWITCH).toBe("IFLOW_OAUTH_STRIP");
  });

  it("declares unique patch ids and unique anchors", () => {
    const ids = loader.PATCHES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = loader.PATCHES.map((p) => p.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    const bundle = readFileSync(BUNDLE, "utf-8");
    for (const patch of loader.PATCHES) {
      expect(countOccurrences(bundle, patch.anchor), patch.id).toBe(1);
      // The committed snapshot must stay UN-patched: injection happens at vendoring.
      expect(countOccurrences(bundle, patch.sentinel), patch.id).toBe(0);
    }
  });

  it("round-trips and removes every raw OAuth call site", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);
    // Raw call sites are gone.
    expect(patched).not.toContain("if(await BOe(t,this.config)){");
    expect(patched).not.toContain("(n=await POe(r,this.config))");
    // Guarded replacements are present.
    expect(patched).toContain('require("./oauth-strip-loader.cjs").restoreOauthClient(t,this.config,BOe)');
    expect(patched).toContain('require("./oauth-strip-loader.cjs").validateOAuthToken(r,this.config,POe)');
    expect(patched).toContain('require("./oauth-strip-loader.cjs").blockCredentialClear())return;try{await MC.rm(wp.getOAuthCredsPath()');
    expect(patched).toContain('require("./oauth-strip-loader.cjs").normalizeAuthType(e)');
    expect(patched).toContain('require("./oauth-strip-loader.cjs").allowStartupOauth()&&e.merged.selectedAuthType===Kt.LOGIN_WITH_IFLOW');
    expect(patched).toContain('require("./oauth-strip-loader.cjs").blockOauth())throw new Error("SERVER_OAUTH2_REQUIRED');
  });

  it("never removes or rewrites the oauth_creds.json read path", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);
    // The read-only user-info helper stays untouched (no deletion / write).
    expect(patched).toContain("async function vso(){try{let A=wp.getOAuthCredsPath()");
    // The deletion is still there but guarded — the only change is unreachable-when-active.
    expect(patched).toContain("MC.rm(wp.getOAuthCredsPath(),{force:!0})");
    expect(countOccurrences(patched, "MC.rm(wp.getOAuthCredsPath()")).toBe(1);
  });
});

describe("oauth-strip-loader: default (strip active)", () => {
  it("is enabled unless explicitly switched off", () => {
    delete process.env.IFLOW_OAUTH_STRIP;
    expect(loader.enabled()).toBe(true);
    expect(loader.disabled()).toBe(false);
  });

  it("normalizes a stale OAuth method onto API auth", () => {
    expect(loader.normalize("oauth-iflow", "oauth-iflow")).toEqual({
      methodId: "openai-compatible",
      authType: "openai-compatible",
    });
    expect(loader.normalize("oauth-aone", "oauth-aone")).toEqual({
      methodId: "openai-compatible",
      authType: "openai-compatible",
    });
    expect(loader.normalize("openai-compatible", "openai-compatible")).toBeNull();
    expect(loader.normalize("iflow", "iflow")).toBeNull();
  });

  it("makes every OAuth entry point unreachable without calling upstream", () => {
    let called = 0;
    const upstream = () => {
      called++;
      return true;
    };
    expect(loader.restoreOauthClient("oauth-iflow", {}, upstream)).toBe(false);
    expect(loader.validateOAuthToken("oauth-iflow", {}, upstream)).toBe(false);
    expect(called).toBe(0);
    expect(loader.blockCredentialClear()).toBe(true);
    expect(loader.blockOauth()).toBe(true);
    expect(loader.allowStartupOauth()).toBe(false);
  });

  it("maps refreshAuth's authType to openai-compatible", () => {
    expect(loader.normalizeAuthType("oauth-iflow")).toBe("openai-compatible");
    expect(loader.normalizeAuthType("oauth-aone")).toBe("openai-compatible");
    expect(loader.normalizeAuthType("openai-compatible")).toBe("openai-compatible");
    expect(loader.normalizeAuthType("iflow")).toBe("iflow");
  });
});

describe("oauth-strip-loader: kill switch", () => {
  for (const value of ["0", "false", "FALSE"]) {
    it(`IFLOW_OAUTH_STRIP=${value} restores upstream behaviour`, () => {
      process.env.IFLOW_OAUTH_STRIP = value;
      expect(loader.enabled()).toBe(false);
      expect(loader.normalize("oauth-iflow", "oauth-iflow")).toBeNull();
      expect(loader.normalizeAuthType("oauth-iflow")).toBe("oauth-iflow");
      expect(loader.blockCredentialClear()).toBe(false);
      expect(loader.blockOauth()).toBe(false);
      expect(loader.allowStartupOauth()).toBe(true);

      const upstream = (methodId: unknown) => ({ upstream: true, methodId });
      expect(loader.restoreOauthClient("oauth-iflow", {}, upstream)).toEqual({
        upstream: true,
        methodId: "oauth-iflow",
      });
      expect(loader.validateOAuthToken("oauth-aone", {}, upstream)).toEqual({
        upstream: true,
        methodId: "oauth-aone",
      });
    });
  }
});
