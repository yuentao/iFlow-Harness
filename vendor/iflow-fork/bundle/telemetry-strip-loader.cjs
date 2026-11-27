/**
 * telemetry-strip-loader.cjs
 *
 * Decision layer for the "Alibaba telemetry strip" MOD. This product ships
 * only API authentication, so none of the CLI's built-in analytics may leave
 * the machine. Verified against the CLI 0.5.19 fork bundle
 * (`vendor/iflow-fork/bundle/iflow.js`):
 *
 *   - `bqe()` — startup `cna` bootstrap: `fetch("https://log.mmstat.com/v.gif")`
 *     waits up to 3s for a Set-Cookie, and the caller then persists the value
 *     into `settings.cna`. Runs on EVERY startup, including `--experimental-acp`.
 *   - `vln({cna,userId,iFlowEnv})` — PV beacon: POST
 *     `https://log.mmstat.com/v.gif` unless `DISABLE_SEND_PV` is set.
 *   - `Q3e(event, payload)` → `JPr` — the AI-tracking transport: POST
 *     `${bte.endpoint}/${event}` with `bte.endpoint = "https://gm.mmstat.com"`.
 *     lifecycle/error/tool events all funnel through it (`fL.startSession`,
 *     `endSession`, `recordError`, `tun`, ...).
 *   - `kOt(config, ...)` — per-request entry point that sends the PV beacon and
 *     starts the AI-tracking session.
 *   - `DAe(config)` — OpenTelemetry SDK init. Its default endpoint is
 *     `Cut = "https://sunfire-ingestion-external.alibaba-inc.com"`
 *     (`telemetry?.otlpEndpoint ?? Cut`), and `enabled` defaults to TRUE, so a
 *     plain run exports traces/logs/metrics to Alibaba every 20s.
 *   - `LTe(apiKey)` (`fetchModels`) — GET
 *     `https://ducky.code.alibaba-inc.com/v1/models`. Reachable only from the
 *     Aone/IDEALAB auth branches of `getAvailableModels`; neutralised to the
 *     built-in fallback list so even that path cannot call out.
 *
 * All of these are HARD-CODED, non-user-configurable destinations (the OTLP
 * endpoint accepts an override, but its DEFAULT is Alibaba), so they are
 * removed. Everything user-configurable stays untouched: the profile
 * `baseUrl` (chat), MCP servers, `platform.iflow.cn` web-search/web-fetch
 * (user-triggered, requires a search key), and the iFlow-cloud plugin
 * download.
 *
 * Each patch is a cheap early return / guard at the function head — no
 * behaviour change beyond "do not call out". `LTe` returns the upstream
 * fallback list (`Ucu()`), which is already the function's own error path.
 *
 * PATCHES is the anchor table consumed by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`): each anchor must occur exactly ONCE and each
 * sentinel must be absent before injection (unique anchor + round-trip,
 * hard fail otherwise).
 *
 * Kill switch: `IFLOW_TELEMETRY_STRIP=0|false` restores the original
 * upstream behaviour (the guards all evaluate false).
 */

"use strict";

const ENV_SWITCH = "IFLOW_TELEMETRY_STRIP";
const LOADER_REF = 'require("./telemetry-strip-loader.cjs")';

/** True when telemetry stripping is active (default). */
function strip() {
  const value = process.env[ENV_SWITCH];
  return !(value === "0" || value === "false" || value === "FALSE");
}

const PATCHES = Object.freeze([
  {
    id: "cna-bootstrap",
    sentinel: LOADER_REF + '.strip())return;let A=new AbortController',
    anchor: "async function bqe(){let A=new AbortController,e=setTimeout(()=>A.abort(),3e3);",
    replacement: "async function bqe(){if(" + LOADER_REF + ".strip())return;let A=new AbortController,e=setTimeout(()=>A.abort(),3e3);",
  },
  {
    id: "pv-beacon",
    sentinel: LOADER_REF + '.strip())return;if(!(!A||process.env.DISABLE_SEND_PV))',
    anchor: "async function vln({cna:A,userId:e,iFlowEnv:t}){if(!(!A||process.env.DISABLE_SEND_PV))try{",
    replacement:
      "async function vln({cna:A,userId:e,iFlowEnv:t}){if(" + LOADER_REF +
      ".strip())return;if(!(!A||process.env.DISABLE_SEND_PV))try{",
  },
  {
    id: "ai-tracking-transport",
    sentinel: LOADER_REF + '.strip())return{success:!0};return NAo.record(A,e)',
    anchor: "async function Q3e(A,e){return NAo.record(A,e)}",
    replacement:
      "async function Q3e(A,e){if(" + LOADER_REF + ".strip())return{success:!0};return NAo.record(A,e)}",
  },
  {
    id: "otel-sdk-init",
    sentinel: LOADER_REF + '.strip())return;if(eie)return;',
    anchor: "function DAe(A){if(eie)return;",
    replacement: "function DAe(A){if(" + LOADER_REF + ".strip())return;if(eie)return;",
  },
  {
    id: "per-request-telemetry-entry",
    sentinel: LOADER_REF + '.strip())return;let r=wGe();try{let n=process.env.IFLOW_ENV||""',
    anchor: 'async function kOt(A,e,t){let r=wGe();try{let n=process.env.IFLOW_ENV||""',
    replacement:
      "async function kOt(A,e,t){if(" + LOADER_REF + ".strip())return;let r=wGe();try{let n=process.env.IFLOW_ENV||\"\"",
  },
  {
    id: "ducky-fetch-models",
    sentinel: LOADER_REF + '.strip())return Ucu();try{let e=await fetch("https://ducky.code.alibaba-inc.com/v1/models"',
    anchor: 'async function LTe(A){try{let e=await fetch("https://ducky.code.alibaba-inc.com/v1/models"',
    replacement:
      "async function LTe(A){if(" + LOADER_REF +
      '.strip())return Ucu();try{let e=await fetch("https://ducky.code.alibaba-inc.com/v1/models"',
  },
]);

module.exports = { ENV_SWITCH, strip, PATCHES };
