import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression locks for the telemetry-strip MOD (`telemetry-strip-loader.cjs`).
 *
 * The loader is injected into `bundle/iflow.js` by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`) at vendoring time. This test pins:
 *   - the committed snapshot is still un-patched and every anchor is unique;
 *   - the patch table round-trips (one sentinel each) and guards exactly the
 *     six telemetry sinks (cna fetch, PV beacon, AI-tracking transport, OTEL
 *     SDK init, per-request entry, ducky model list);
 *   - the kill switch (`IFLOW_TELEMETRY_STRIP=0|false`) turns the guard off.
 */

interface Patch {
  id: string;
  anchor: string;
  replacement: string;
  sentinel: string;
}

interface Loader {
  ENV_SWITCH: string;
  strip(): boolean;
  PATCHES: Patch[];
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/telemetry-strip-loader.cjs") as Loader;

const BUNDLE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "iflow.js");
const LOADER_FILE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "telemetry-strip-loader.cjs");

const ORIGINAL_SWITCH = process.env.IFLOW_TELEMETRY_STRIP;

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
  if (ORIGINAL_SWITCH === undefined) delete process.env.IFLOW_TELEMETRY_STRIP;
  else process.env.IFLOW_TELEMETRY_STRIP = ORIGINAL_SWITCH;
});

describe("telemetry-strip-loader: bundle wiring", () => {
  it("ships the loader next to the bundle and documents the kill switch", () => {
    expect(existsSync(LOADER_FILE)).toBe(true);
    expect(readFileSync(LOADER_FILE, "utf-8")).toContain("IFLOW_TELEMETRY_STRIP");
    expect(loader.ENV_SWITCH).toBe("IFLOW_TELEMETRY_STRIP");
  });

  it("targets exactly the known telemetry sinks", () => {
    expect(loader.PATCHES.map((p) => p.id).sort()).toEqual(
      [
        "ai-tracking-transport",
        "cna-bootstrap",
        "ducky-fetch-models",
        "otel-sdk-init",
        "per-request-telemetry-entry",
        "pv-beacon",
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

  it("round-trips and guards every outbound telemetry call site", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);
    // cna bootstrap (log.mmstat.com)
    expect(patched).toContain('async function bqe(){if(require("./telemetry-strip-loader.cjs").strip())return;');
    // PV beacon (log.mmstat.com)
    expect(patched).toContain('require("./telemetry-strip-loader.cjs").strip())return;if(!(!A||process.env.DISABLE_SEND_PV))');
    // AI tracking transport (gm.mmstat.com)
    expect(patched).toContain('async function Q3e(A,e){if(require("./telemetry-strip-loader.cjs").strip())return{success:!0};');
    // OpenTelemetry SDK init (default endpoint sunfire-ingestion-external.alibaba-inc.com)
    expect(patched).toContain('function DAe(A){if(require("./telemetry-strip-loader.cjs").strip())return;');
    // per-request telemetry entry
    expect(patched).toContain('async function kOt(A,e,t){if(require("./telemetry-strip-loader.cjs").strip())return;');
    // ducky model list -> upstream fallback list, no fetch
    expect(patched).toContain('if(require("./telemetry-strip-loader.cjs").strip())return Ucu();try{let e=await fetch("https://ducky.code.alibaba-inc.com/v1/models"');
    // The fallback list still exists (the guard returns a real value, not null).
    expect(patched).toContain("function Ucu(){return[new KN({id:\"ide-whale/qwen3-coder\"");
  });

  it("does not touch user-configurable endpoints or the chat path", () => {
    const patched = applyPatches(readFileSync(BUNDLE, "utf-8"), loader.PATCHES);
    // Chat to the user's profile baseUrl is untouched (the body still builds
    // `${f}/chat/completions` from `this.baseUrl`).
    expect(patched).toContain("await fetch(`${f}/chat/completions`");
    // MCP config plumbing is untouched.
    expect(patched).toContain("addMcpServer(e,t){this.mcpServers||(this.mcpServers={}),this.mcpServers[e]=t}");
    // The web-search tool (user-triggered, searchApiKey-gated) is untouched.
    expect(patched).toContain("https://platform.iflow.cn/api/search/webSearch");
  });
});

describe("telemetry-strip-loader: kill switch", () => {
  it("strips by default", () => {
    delete process.env.IFLOW_TELEMETRY_STRIP;
    expect(loader.strip()).toBe(true);
  });

  for (const value of ["0", "false", "FALSE"]) {
    it(`IFLOW_TELEMETRY_STRIP=${value} restores upstream behaviour`, () => {
      process.env.IFLOW_TELEMETRY_STRIP = value;
      expect(loader.strip()).toBe(false);
    });
  }

  it("treats an empty or truthy value as active", () => {
    process.env.IFLOW_TELEMETRY_STRIP = "";
    expect(loader.strip()).toBe(true);
    process.env.IFLOW_TELEMETRY_STRIP = "1";
    expect(loader.strip()).toBe(true);
  });
});
