/**
 * internal-host-strip-loader.cjs
 *
 * Decision layer for the "internal iFlow host strip" MOD. The harness product
 * only ever talks to the provider the user configured, so the CLI's built-in
 * iFlow cloud hosts must not be baked into the kernel:
 *
 *   - `cloud.iflow.cn` — `oMi()` downloads an IntelliJ plugin zip
 *     (`/iflow-cli/idea-plugin/iflow-idea-0.0.5.zip`) and extracts it into
 *     every installed JetBrains IDE. Exposed as `autoInstallIdePlugin()`.
 *     Removed: no-op + explicit error, zero network.
 *   - `platform.iflow.cn` — the two BUILT-IN web tools
 *     (`web_search` -> `/api/search/webSearch`, `web_fetch` ->
 *     `/api/search/webFetch`). They are registered from the platform variants
 *     `u3` / `qD` (and `hA` for Task sub-agents). Removed at the REGISTRY
 *     level (`allowWebTools()` / `filterWebTools()`): the model never sees a
 *     tool that cannot work, and no call site can reach the host.
 *   - `iflow.cn` — OAuth token exchange / user-info. Already unreachable
 *     through the OAuth strip, but the `iflow` auth type can still drive the
 *     token exchange in `KOt`; every outbound iflow.cn call is short-circuited
 *     here (user-info returns `{}`, token exchange throws), zero network.
 *   - `iflow.cn/cli/ad-phrases` — remote TUI tip phrases; returns the local
 *     list instead.
 *   - `apis.iflow.cn` — the hard-coded DEFAULT base URL (`Iie`, exported as
 *     `DEFAULT_IFLOW_BASE_URL`). Removed: the constant becomes an empty string,
 *     and `KOt()` now THROWS a clear error when a session would end up without
 *     a base URL. It never falls back to a written-down iFlow host.
 *
 * What this MOD deliberately does NOT touch (per product decision):
 *   - a user's EXPLICIT `baseUrl` (from ACP `authenticate` or settings) — even
 *     when it points at `https://apis.iflow.cn/v1`. Requests go out unchanged.
 *   - user-configured MCP servers, the chat request path, `ducky.code...`
 *     (Aone, unreachable), and the host-side Bing/DDG search in the extension.
 *   - the `apis.iflow.cn` URLs inside the multimodal/JSON-repair/Chinese-detect
 *     helpers: those branches only run when the user's own `baseUrl` contains
 *     `apis.iflow.cn` (i.e. the user asked for that host).
 *
 * PATCHES is the anchor table consumed by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`). Each anchor must occur exactly ONCE in the minified
 * bundle and each sentinel must be absent before injection — the vendoring step
 * does a round-trip check and FAILS HARD when either invariant breaks.
 *
 * Kill switch: `IFLOW_INTERNAL_HOST_STRIP=0|false` restores the original
 * upstream behaviour (the guards all evaluate false; the default base URL is
 * returned unchanged).
 */

"use strict";

const ENV_SWITCH = "IFLOW_INTERNAL_HOST_STRIP";
const LOADER_REF = 'require("./internal-host-strip-loader.cjs")';

/** Built-in web tool names hidden from the registry while the strip is on. */
const WEB_TOOL_NAMES = Object.freeze(["web_search", "web_fetch", "xinliu_web_search", "xinliu_web_fetch"]);

/** True when the internal-host strip is active (default). */
function strip() {
  const value = process.env[ENV_SWITCH];
  return !(value === "0" || value === "false" || value === "FALSE");
}

/** Registry gate: may the built-in platform web tools be registered? */
function allowWebTools() {
  return !strip();
}

/**
 * Filter for an array of tool INSTANCES (the Task tool's sub-agent list).
 * Returns the list unchanged when the strip is off; drops every built-in web
 * tool when it is on.
 */
function filterWebTools(tools) {
  if (!Array.isArray(tools)) return [];
  if (!strip()) return tools;
  return tools.filter((tool) => !WEB_TOOL_NAMES.includes(tool && tool.name));
}

/**
 * Scrub a hard-coded default base URL. Returns the original value when the
 * strip is off (faithful upstream behaviour), and an empty string when on, so
 * no code path can silently fall back to the iFlow cloud host.
 */
function scrubDefaultBaseUrl(original) {
  return strip() ? "" : original;
}

/**
 * Fail fast when a session would be built without any base URL. Called from
 * `KOt()` right before the content-generator config is returned. Explicit
 * (user-supplied) base URLs are untouched — this only fires when the value is
 * empty, i.e. exactly the case where upstream used to fall back to
 * `https://apis.iflow.cn/v1`.
 */
function requireBaseUrl(cfg) {
  if (!strip() || !cfg) return;
  const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "";
  if (baseUrl) return;
  throw new Error(
    'Missing baseUrl for authType "' +
      String(cfg.authType || "unknown") +
      '": the built-in CLI no longer ships any iFlow cloud default ' +
      "(cloud.iflow.cn / platform.iflow.cn / iflow.cn / apis.iflow.cn). " +
      "Provide an explicit baseUrl via the ACP `authenticate` call or settings.",
  );
}

const PATCHES = Object.freeze([
  {
    id: "plugin-download",
    sentinel: LOADER_REF + '.strip()){console.error("[internal-host-strip] IDE',
    anchor: "async function oMi(){try{let A=vru();",
    replacement:
      "async function oMi(){if(" +
      LOADER_REF +
      '.strip()){console.error("[internal-host-strip] IDE plugin download from cloud.iflow.cn is disabled");return!1}try{let A=vru();',
  },
  {
    id: "web-fetch-register",
    sentinel: LOADER_REF + ".allowWebTools()?t(qD,this):null",
    anchor: "t($ut,this),t(qD,this),t(wS,this)",
    replacement: "t($ut,this)," + LOADER_REF + ".allowWebTools()?t(qD,this):null,t(wS,this)",
  },
  {
    id: "web-search-register",
    sentinel: LOADER_REF + '.allowWebTools()?(bB()==="aone"?t(j0e,this):t(u3,this)):null',
    anchor: 'bB()==="aone"?t(j0e,this):t(u3,this)',
    replacement:
      LOADER_REF + '.allowWebTools()?(bB()==="aone"?t(j0e,this):t(u3,this)):null',
  },
  {
    id: "task-subagent-web-tools",
    sentinel: LOADER_REF + ".filterWebTools([new hA(this.config)",
    anchor: 'new hA(this.config),bB()==="aone"?new j0e(this.config):new u3(this.config)',
    replacement:
      "..." +
      LOADER_REF +
      '.filterWebTools([new hA(this.config),bB()==="aone"?new j0e(this.config):new u3(this.config)])',
  },
  {
    id: "default-base-url",
    sentinel:
      LOADER_REF + '.scrubDefaultBaseUrl("https://apis.iflow.cn/v1"),Rqe="https://ducky.code.alibaba-inc.com/v1/openai"',
    anchor: 'Iie="https://apis.iflow.cn/v1",Rqe="https://ducky.code.alibaba-inc.com/v1/openai"',
    replacement:
      'Iie=' +
      LOADER_REF +
      '.scrubDefaultBaseUrl("https://apis.iflow.cn/v1"),Rqe="https://ducky.code.alibaba-inc.com/v1/openai"',
  },
  {
    id: "require-base-url-iflow",
    sentinel: LOADER_REF + '.requireBaseUrl(u),u.multimodalModelName="qwen3-vl-plus"',
    anchor: 'if(u.baseUrl=o||Iie,u.multimodalModelName="qwen3-vl-plus",',
    replacement:
      'if(u.baseUrl=o||Iie,' + LOADER_REF + '.requireBaseUrl(u),u.multimodalModelName="qwen3-vl-plus",',
  },
  {
    id: "require-base-url-openai",
    sentinel: LOADER_REF + ".requireBaseUrl(u),u)}",
    anchor: "[...A6,Kt.OPENAI_COMPATIBLE].includes(e)&&a&&(u.apiKey=a,u.baseUrl=o,u.model=l),u)}",
    replacement:
      "[...A6,Kt.OPENAI_COMPATIBLE].includes(e)&&a&&(u.apiKey=a,u.baseUrl=o,u.model=l)," +
      LOADER_REF +
      ".requireBaseUrl(u),u)}",
  },
  {
    id: "oauth-userinfo",
    sentinel: LOADER_REF + ".strip())return{};let e=[1e3,2e3,3e3];",
    anchor: "async function pEt(A){let e=[1e3,2e3,3e3];",
    replacement: "async function pEt(A){if(" + LOADER_REF + ".strip())return{};let e=[1e3,2e3,3e3];",
  },
  {
    id: "oauth-token-exchange",
    sentinel: LOADER_REF + '.strip())throw new Error("iFlow OAuth token exchange',
    anchor: 'async function fAo(A,e){let t=await fetch("https://iflow.cn/oauth/token",{method:"POST"',
    replacement:
      "async function fAo(A,e){if(" +
      LOADER_REF +
      '.strip())throw new Error("iFlow OAuth token exchange is disabled (iflow.cn internal host removed)");let t=await fetch("https://iflow.cn/oauth/token",{method:"POST"',
  },
  {
    id: "oauth-token-refresh",
    sentinel: LOADER_REF + '.strip())throw new Error("iFlow OAuth token refresh',
    anchor: 'async function hEt(A){let e=await fetch("https://iflow.cn/oauth/token",{method:"POST"',
    replacement:
      "async function hEt(A){if(" +
      LOADER_REF +
      '.strip())throw new Error("iFlow OAuth token refresh is disabled (iflow.cn internal host removed)");let e=await fetch("https://iflow.cn/oauth/token",{method:"POST"',
  },
  {
    id: "ad-phrases",
    sentinel: LOADER_REF + ".strip())return this.getValidPhrases();try{let e=Date.now();",
    anchor: "async fetchRemotePhrases(){try{let e=Date.now();",
    replacement:
      "async fetchRemotePhrases(){if(" + LOADER_REF + ".strip())return this.getValidPhrases();try{let e=Date.now();",
  },
]);

module.exports = {
  ENV_SWITCH,
  WEB_TOOL_NAMES,
  strip,
  allowWebTools,
  filterWebTools,
  scrubDefaultBaseUrl,
  requireBaseUrl,
  PATCHES,
};
