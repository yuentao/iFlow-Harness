import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression locks for the internal-host-strip MOD
 * (`internal-host-strip-loader.cjs`).
 *
 * The loader is injected into `bundle/iflow.js` by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`) at vendoring time. This test pins:
 *   - the committed snapshot is still un-patched and every anchor is unique;
 *   - the patch table round-trips (one sentinel each) and guards every
 *     hard-coded iFlow cloud host:
 *       cloud.iflow.cn   -> plugin download no-op
 *       platform.iflow.cn-> built-in web tools unregistered
 *       iflow.cn         -> OAuth user-info / token exchange / ad-phrases
 *       apis.iflow.cn    -> default base URL scrubbed + explicit baseUrl required
 *   - the user's explicit baseUrl / chat path stays untouched;
 *   - the kill switch (`IFLOW_INTERNAL_HOST_STRIP=0|false`) restores upstream
 *     behaviour.
 */

interface Patch {
  id: string;
  anchor: string;
  replacement: string;
  sentinel: string;
}

interface ToolLike {
  name?: string;
}

interface Loader {
  ENV_SWITCH: string;
  WEB_TOOL_NAMES: readonly string[];
  strip(): boolean;
  allowWebTools(): boolean;
  filterWebTools(tools: unknown): ToolLike[];
  scrubDefaultBaseUrl(original: unknown): unknown;
  requireBaseUrl(cfg: unknown): void;
  PATCHES: Patch[];
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/internal-host-strip-loader.cjs") as Loader;

const BUNDLE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "iflow.js");
const LOADER_FILE = join(
  process.cwd(),
  "vendor",
  "iflow-fork",
  "bundle",
  "internal-host-strip-loader.cjs",
);

const ORIGINAL_SWITCH = process.env.IFLOW_INTERNAL_HOST_STRIP;

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

/** Reproduce `applyLoaderPatches`' per-patch contract. */
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
  if (ORIGINAL_SWITCH === undefined) delete process.env.IFLOW_INTERNAL_HOST_STRIP;
  else process.env.IFLOW_INTERNAL_HOST_STRIP = ORIGINAL_SWITCH;
});

describe("internal-host-strip-loader: bundle wiring", () => {
  it("ships the loader next to the bundle and documents the kill switch", () => {
    expect(existsSync(LOADER_FILE)).toBe(true);
    expect(readFileSync(LOADER_FILE, "utf-8")).toContain("IFLOW_INTERNAL_HOST_STRIP");
    expect(loader.ENV_SWITCH).toBe("IFLOW_INTERNAL_HOST_STRIP");
  });

  it("targets exactly the known internal-host sites", () => {
    expect(loader.PATCHES.map((p) => p.id).sort()).toEqual(
      [
        "ad-phrases",
        "default-base-url",
        "oauth-token-exchange",
        "oauth-token-refresh",
        "oauth-userinfo",
        "plugin-download",
        "require-base-url-iflow",
        "require-base-url-openai",
        "task-subagent-web-tools",
        "web-fetch-register",
        "web-search-register",
      ].sort(),
    );
  });

  it("declares unique ids/anchors and leaves the committed snapshot un-patched", () => {
    const ids = loader.PATCHES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = loader.PATCHES.map((p) => p.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    const bundle = readFileSync(BUNDLE, "utf-8");
    for (const patch of loader.PATCHES) {
      expect(countOccurrences(bundle, patch.anchor), patch.id).toBe(1);
      expect(countOccurrences(bundle, patch.sentinel), patch.id).toBe(0);
    }
  });

  it("round-trips and removes every hard-coded internal-host call path", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);

    // cloud.iflow.cn — plugin download becomes a no-op with an explicit error.
    expect(patched).toContain(
      'async function oMi(){if(require("./internal-host-strip-loader.cjs").strip()){console.error("[internal-host-strip] IDE plugin download',
    );

    // platform.iflow.cn — both built-in web tools are dropped at the registry.
    expect(patched).toContain(
      'require("./internal-host-strip-loader.cjs").allowWebTools()?t(qD,this):null',
    );
    expect(patched).toContain(
      'require("./internal-host-strip-loader.cjs").allowWebTools()?(bB()==="aone"?t(j0e,this):t(u3,this)):null',
    );
    // Task sub-agent tool list filtered as well.
    expect(patched).toContain(
      '...require("./internal-host-strip-loader.cjs").filterWebTools([new hA(this.config)',
    );

    // apis.iflow.cn — no default base URL left; a missing baseUrl throws.
    expect(patched).not.toContain('Iie="https://apis.iflow.cn/v1"');
    expect(patched).toContain(
      'Iie=require("./internal-host-strip-loader.cjs").scrubDefaultBaseUrl("https://apis.iflow.cn/v1")',
    );
    expect(patched).toContain(
      'if(u.baseUrl=o||Iie,require("./internal-host-strip-loader.cjs").requireBaseUrl(u),',
    );
    expect(patched).toContain(
      "requireBaseUrl(u),u)}",
    );

    // iflow.cn — user-info returns {}, token exchange throws, ad-phrases local.
    expect(patched).toContain(
      'async function pEt(A){if(require("./internal-host-strip-loader.cjs").strip())return{};',
    );
    expect(patched).toContain('iFlow OAuth token exchange is disabled');
    expect(patched).toContain('iFlow OAuth token refresh is disabled');
    expect(patched).toContain(
      'async fetchRemotePhrases(){if(require("./internal-host-strip-loader.cjs").strip())return this.getValidPhrases();',
    );
  });

  it("does not touch user-configurable endpoints or the chat path", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);
    // The chat request still builds `${f}/chat/completions` from the profile baseUrl.
    expect(patched).toContain("await fetch(`${f}/chat/completions`");
    // The platform URLs remain as data (only the registration is gated).
    expect(patched).toContain("https://platform.iflow.cn/api/search/webSearch");
    // MCP config plumbing untouched.
    expect(patched).toContain("addMcpServer(e,t){this.mcpServers||(this.mcpServers={}),this.mcpServers[e]=t}");
  });
});

describe("internal-host-strip-loader: switches", () => {
  it("is active by default", () => {
    delete process.env.IFLOW_INTERNAL_HOST_STRIP;
    expect(loader.strip()).toBe(true);
    expect(loader.allowWebTools()).toBe(false);
  });

  for (const value of ["0", "false", "FALSE"]) {
    it(`IFLOW_INTERNAL_HOST_STRIP=${value} restores upstream behaviour`, () => {
      process.env.IFLOW_INTERNAL_HOST_STRIP = value;
      expect(loader.strip()).toBe(false);
      expect(loader.allowWebTools()).toBe(true);
      expect(loader.scrubDefaultBaseUrl("https://apis.iflow.cn/v1")).toBe(
        "https://apis.iflow.cn/v1",
      );
      expect(() => loader.requireBaseUrl({ authType: "openai-compatible" })).not.toThrow();
    });
  }

  it("treats an empty or truthy value as active", () => {
    process.env.IFLOW_INTERNAL_HOST_STRIP = "";
    expect(loader.strip()).toBe(true);
    process.env.IFLOW_INTERNAL_HOST_STRIP = "1";
    expect(loader.strip()).toBe(true);
  });
});

describe("internal-host-strip-loader: decisions", () => {
  it("scrubs the default base URL when active", () => {
    delete process.env.IFLOW_INTERNAL_HOST_STRIP;
    expect(loader.scrubDefaultBaseUrl("https://apis.iflow.cn/v1")).toBe("");
  });

  it("keeps a user-supplied baseUrl untouched", () => {
    delete process.env.IFLOW_INTERNAL_HOST_STRIP;
    // An explicit apis.iflow.cn baseUrl is still allowed: the strip only
    // removes DEFAULTS, never a value the user asked for.
    expect(() =>
      loader.requireBaseUrl({ authType: "openai-compatible", baseUrl: "https://apis.iflow.cn/v1" }),
    ).not.toThrow();
    expect(() =>
      loader.requireBaseUrl({ authType: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1" }),
    ).not.toThrow();
  });

  it("throws a clear error when no baseUrl is available", () => {
    delete process.env.IFLOW_INTERNAL_HOST_STRIP;
    expect(() => loader.requireBaseUrl({ authType: "openai-compatible" })).toThrow(/baseUrl/i);
    expect(() => loader.requireBaseUrl({ authType: "iflow", baseUrl: "  " })).toThrow(/baseUrl/i);
    expect(() => loader.requireBaseUrl(null)).not.toThrow();
  });

  it("filters built-in web tools by name", () => {
    delete process.env.IFLOW_INTERNAL_HOST_STRIP;
    const tools = [
      { name: "read_file" },
      { name: "web_search" },
      { name: "web_fetch" },
      { name: "xinliu_web_search" },
      { name: "task" },
    ];
    expect(loader.filterWebTools(tools).map((t) => t.name)).toEqual(["read_file", "task"]);
    expect(loader.filterWebTools(null)).toEqual([]);
    process.env.IFLOW_INTERNAL_HOST_STRIP = "0";
    expect(loader.filterWebTools(tools)).toHaveLength(5);
  });
});
