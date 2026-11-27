/**
 * oauth-strip-loader.cjs
 *
 * Decision layer for the "OAuth strip" MOD. iFlow-Harness authenticates the
 * built-in CLI exclusively through API credentials (the ACP `authenticate`
 * call with methodId `openai-compatible`), so the fork's own iFlow/Google
 * OAuth login is dead weight. Worse, it is actively harmful:
 *
 *   - `BOe(methodId, config)` (= `restoreOauthClient`) is called from the ACP
 *     `authenticate` handler for EVERY method. It reads
 *     `<global>/.iflow/oauth_creds.json` and, unless the method is
 *     `oauth-iflow`, validates the access token against Google
 *     (`OAuth2Client.getTokenInfo` → https://oauth2.googleapis.com/tokeninfo).
 *     An expired/stale creds file makes even an `openai-compatible` login
 *     block for ~64s before falling back.
 *   - `initialize` calls `POe` (validateOAuthToken) when the persisted
 *     `selectedAuthType` is `oauth-iflow`/`oauth-aone`, which hits the same
 *     Google endpoint.
 *   - `Config.refreshAuth(oauth-iflow, ...)` can clear
 *     `oauth_creds.json` (`clearCachedCredentialFile`) and start an
 *     interactive browser login (`kG` → `mAo`), which never returns in a
 *     headless ACP child.
 *
 * What this MOD changes — and what it deliberately does not:
 *
 *   - Every OAuth entry point is short-circuited BEFORE any network:
 *       `restoreOauthClient`  -> false   (upstream fallback = "no creds")
 *       `validateOAuthToken`  -> false   (upstream returns false too)
 *       `blockOauth`          -> kG throws a SERVER_OAUTH2_REQUIRED error
 *                                without building an OAuth2Client
 *       `allowStartupOauth`   -> false   (skips the pre-ACP kG warm-up)
 *   - `normalizeAuthType` / `normalize` map a stale `selectedAuthType`
 *     (`oauth-iflow`/`oauth-aone`) onto `openai-compatible`, so a settings
 *     file left over from the old login neither crashes `session/new` nor
 *     dead-locks on a browser prompt.
 *   - `blockCredentialClear` makes `clearCachedCredentialFile` a no-op so the
 *     account-migration branch in `refreshAuth` can NEVER delete
 *     `~/.iflow/oauth_creds.json`.
 *   - `openai-compatible` + `methodInfo` are untouched: for that method the
 *     upstream `BOe` already returned false, so returning false keeps the
 *     request byte-identical while removing the accidental Google probe.
 *   - Nothing here deletes or rewrites `oauth_creds.json`; the file is only
 *     ever READ by the untouched `vso()` user-info helper.
 *
 * PATCHES is the anchor table consumed by `scripts/vendor-cli.mjs`
 * (`applyLoaderPatches`). Each anchor must occur exactly ONCE in the minified
 * bundle and each `sentinel` must be absent before injection — the vendoring
 * step does a round-trip check and FAILS HARD when either invariant breaks.
 *
 * Kill switch: `IFLOW_OAUTH_STRIP=0|false` restores the original upstream
 * behaviour (the anchors still point at this module, but every function
 * delegates to the upstream implementation passed in by the call site).
 */

"use strict";

const ENV_SWITCH = "IFLOW_OAUTH_STRIP";
const API_METHOD = "openai-compatible";
const OAUTH_METHODS = Object.freeze(["oauth-iflow", "oauth-aone"]);

function disabled() {
  const value = process.env[ENV_SWITCH];
  return value === "0" || value === "false" || value === "FALSE";
}

/** True when the strip is active (default) and OAuth must stay unreachable. */
function enabled() {
  return !disabled();
}

function isOauthMethod(value) {
  return OAUTH_METHODS.includes(value);
}

/**
 * Called at the top of the ACP `authenticate` handler.
 * Returns `null` when the requested method is untouched (so the caller keeps
 * `t`/`n` as-is), or `{ methodId, authType }` when a stale OAuth method must
 * be normalised onto API auth.
 */
function normalize(methodId, authType) {
  if (!enabled()) return null;
  if (!isOauthMethod(methodId) && !isOauthMethod(authType)) return null;
  return { methodId: API_METHOD, authType: API_METHOD };
}

/** Replaces `BOe(methodId, config)`: never builds an OAuth2Client when active. */
function restoreOauthClient(methodId, config, upstream) {
  if (!enabled()) return upstream(methodId, config);
  return false;
}

/** Replaces `POe(methodId, config)` in `initialize`: no Google tokeninfo. */
function validateOAuthToken(methodId, config, upstream) {
  if (!enabled()) return upstream(methodId, config);
  return false;
}

/** Replaces `Config.refreshAuth`'s auth-type parameter. */
function normalizeAuthType(authType) {
  if (!enabled()) return authType;
  return isOauthMethod(authType) ? API_METHOD : authType;
}

/** Guard for `clearCachedCredentialFile` (must never unlink oauth_creds.json). */
function blockCredentialClear() {
  return enabled();
}

/** Guard for `getOauthClient` (kG): fail fast instead of launching a login. */
function blockOauth() {
  return enabled();
}

/** Guard for the pre-ACP `kG` warm-up branch. */
function allowStartupOauth() {
  return !enabled();
}

const LOADER_REF = 'require("./oauth-strip-loader.cjs")';

const PATCHES = Object.freeze([
  {
    id: "authenticate-normalize",
    sentinel: "let _osr=" + LOADER_REF + ".normalize",
    anchor: "async authenticate(e){let t=e.methodId,r=e.methodInfo,n=qe.nativeEnum(Kt).parse(t);",
    replacement:
      "async authenticate(e){let t=e.methodId,r=e.methodInfo,n=qe.nativeEnum(Kt).parse(t);" +
      "{let _osr=" + LOADER_REF + ".normalize(t,n);if(_osr){t=_osr.methodId;n=_osr.authType}}",
  },
  {
    id: "authenticate-restore-oauth-client",
    sentinel: LOADER_REF + ".restoreOauthClient",
    anchor: "if(await BOe(t,this.config)){",
    replacement: "if(await " + LOADER_REF + ".restoreOauthClient(t,this.config,BOe)){",
  },
  {
    id: "initialize-validate-oauth-token",
    sentinel: LOADER_REF + ".validateOAuthToken",
    anchor: "(n=await POe(r,this.config))",
    replacement: "(n=await " + LOADER_REF + ".validateOAuthToken(r,this.config,POe))",
  },
  {
    id: "refresh-auth-normalize",
    sentinel: LOADER_REF + ".normalizeAuthType",
    anchor:
      "async refreshAuth(e,t,r){if(this.contentGeneratorConfig?.authType===Kt.LOGIN_WITH_IFLOW&&e!==Kt.LOGIN_WITH_IFLOW){",
    replacement:
      "async refreshAuth(e,t,r){e=" + LOADER_REF +
      ".normalizeAuthType(e);if(this.contentGeneratorConfig?.authType===Kt.LOGIN_WITH_IFLOW&&e!==Kt.LOGIN_WITH_IFLOW){",
  },
  {
    id: "block-credential-clear",
    sentinel: LOADER_REF + ".blockCredentialClear",
    anchor: "async function RG(){try{await MC.rm(wp.getOAuthCredsPath(),{force:!0})",
    replacement: "async function RG(){if(" + LOADER_REF + ".blockCredentialClear())return;try{await MC.rm(wp.getOAuthCredsPath(),{force:!0})",
  },
  {
    id: "block-startup-oauth",
    sentinel: LOADER_REF + ".allowStartupOauth",
    anchor: "if(e.merged.selectedAuthType===Kt.LOGIN_WITH_IFLOW&&o.isBrowserLaunchSuppressed())",
    replacement: "if(" + LOADER_REF + ".allowStartupOauth()&&e.merged.selectedAuthType===Kt.LOGIN_WITH_IFLOW&&o.isBrowserLaunchSuppressed())",
  },
  {
    id: "block-get-oauth-client",
    sentinel: LOADER_REF + ".blockOauth",
    anchor: "async function kG(A,e,t){if(!EB.has(A)){",
    replacement:
      "async function kG(A,e,t){if(" + LOADER_REF +
      '.blockOauth())throw new Error("SERVER_OAUTH2_REQUIRED: iFlow OAuth login removed");if(!EB.has(A)){',
  },
]);

module.exports = {
  ENV_SWITCH,
  API_METHOD,
  OAUTH_METHODS,
  enabled,
  disabled,
  normalize,
  restoreOauthClient,
  validateOAuthToken,
  normalizeAuthType,
  blockCredentialClear,
  blockOauth,
  allowStartupOauth,
  PATCHES,
};
