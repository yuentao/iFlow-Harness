/**
 * api-config-isolation-loader.cjs
 *
 * Decision layer for the api-config-isolation-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   The core settings module resolves the USER settings file as
 *   `eJ = join(homedir(), ".iflow", "settings.json")` hard-coded to homedir
 *   (it does NOT honour IFLOW_HOME). `saveSettings` (BMi) is the single
 *   choke point every `settings.setValue("User", ...)` funnels through, and
 *   it serialises the WHOLE in-memory User settings back to that shared
 *   file. When the iFlow-harness VSCode extension authenticates the child
 *   CLI (openai-compatible creds), the pushed apiKey/baseUrl/modelName get
 *   persisted into the shared ~/.iflow/settings.json — leaking the panel's
 *   API config to every other process (terminal CLI, other editors).
 *
 * The patched saveSettings() body requires this module and calls
 * intercept(t) with the {path, settings} payload:
 *   - returns undefined                  -> write proceeds untouched
 *   - returns a new {path, settings}     -> that object is written instead
 *   - returns null                       -> the write is skipped
 * Loader missing / throwing -> the original behaviour is preserved (safe
 * fallback, same discipline as mcp-background-loader).
 *
 *   2026-11-22 — a THIRD reason to return null was added: the on-disk
 *   settings.json EXISTS but cannot be read or parsed. The CLI's own
 *   saveSettings writes the whole file with a non-atomic writeFileSync, so a
 *   crash mid-write leaves a half file; the old code caught the parse error
 *   and continued with an EMPTY disk view, which stripped every STRIP_KEYS
 *   entry and made the whole-file rewrite delete the user's mcpServers /
 *   tokensLimit / language / approvalMode / compressionTokenThreshold /
 *   contextWindowLength / apiProfiles for good ("竞态丢键"). A file that is
 *   genuinely absent still yields an empty view (nothing to protect yet);
 *   an unreadable / corrupt one now SKIPS the write instead.
 *
 * Isolation semantics (harness mode only):
 *   The panel-owned fields (selectedAuthType, apiKey, baseUrl, searchApiKey,
 *   modelName, currentApiProfile, apiProfiles) are NEVER written from the
 *   child's memory. Instead whatever value the file on disk ALREADY has for
 *   those keys is preserved verbatim — so terminal users' credentials survive
 *   untouched (a plain delete would wipe them) while the panel's credentials
 *   never leak. `apiProfiles` belongs to the same set: the panel is its only
 *   author, while the CLI only round-trips the snapshot it read at process
 *   start — so a saveSettings triggered by hot re-authentication would write
 *   that stale catalogue back and silently revert (or resurrect) profiles the
 *   panel just edited/deleted. Because saveSettings rewrites the whole file,
 *   the disk value must be re-injected whenever it exists; when the disk has
 *   no such key we must NOT write the in-memory value either (that would
 *   revive a profile the panel already deleted).
 *
 *   2026-11-21 — the protected set was WIDENED and a disk-first fallback was
 *   added. saveSettings() rewrites the WHOLE file from the child's
 *   process-start snapshot, so every key that is not in STRIP_KEYS gets
 *   reverted to that stale snapshot on every authenticate(). That wiped the
 *   user's `tokensLimit` (the CLI then fell back to its hard-coded 128000
 *   ceiling, so the auto-compress threshold collapsed to 0.8 * 128000 =
 *   102400 and every super-agent sub-session was compressed the moment it
 *   started — the sub-session baseline is ~103000), and it also wiped
 *   `mcpServers` / `language` / `approvalMode` / `contextFileName` /
 *   `compressionTokenThreshold` / `contextWindowLength` / `outputTokensLimit`.
 *   The super-agent host
 *   spawns AND authenticates one CLI per sub-session
 *   (src/panel/super-agent-host.ts), so the overwrite fired once per
 *   sub-session.
 *
 *   Rule 1 — STRIP_KEYS is the authoritative-disk set: for those keys the
 *   on-disk value always wins, and it is re-injected even when the child's
 *   payload does not carry the key at all.
 *   Rule 2 — disk-first fallback for everything else: a key that exists on
 *   disk but NOT in the child's payload keeps its disk value instead of
 *   being dropped by the schema-normalised whole-file write. This keeps
 *   Mod-owned keys (and any key the CLI's settings schema does not know
 *   about) alive. It never overrides a key the payload does carry — the
 *   CLI's own edits still win, except for the Rule 1 keys above.
 *
 *   Keep this list in sync with the extension's settings surface. Whenever
 *   the vendored snapshot under vendor/iflow-fork/ is regenerated from the
 *   upstream fork (`npm run vendor:cli`), this loader must be re-synced from
 *   the iFlow-Mods source (`api-config-isolation-refactor`) — otherwise the
 *   whole-file overwrite comes back and the context-window / MCP keys are
 *   wiped again.
 *
 * Scope:
 *   - Active ONLY when IFLOW_HARNESS is truthy (set by the harness
 *     extension's spawn env) AND the write target is exactly the user-level
 *     ~/.iflow/settings.json. Project-level settings writes and every other
 *     process keep the upstream behaviour.
 *   - IFLOW_API_ISOLATION=0|false explicitly disables the MOD (restores
 *     upstream behaviour).
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

// Rule 1 — the authoritative-disk set. For every key listed here the value
// already on disk wins; the child's process-start snapshot never overwrites
// it (the list grew on 2026-11-21: the snapshot rewrite used to wipe the
// user's tokensLimit / mcpServers / language / approvalMode /
// contextFileName / compressionTokenThreshold / contextWindowLength /
// outputTokensLimit).
const STRIP_KEYS = [
  "selectedAuthType",
  "apiKey",
  "baseUrl",
  "searchApiKey",
  "modelName",
  "currentApiProfile",
  "apiProfiles",
  "mcpServers",
  "language",
  "approvalMode",
  "contextFileName",
  "tokensLimit",
  "compressionTokenThreshold",
  "contextWindowLength",
  "outputTokensLimit",
];

function isDisabledByEnv() {
  const v = process.env.IFLOW_API_ISOLATION;
  return typeof v === "string" && ["0", "false"].includes(v.trim().toLowerCase());
}

function isHarnessMode() {
  const v = process.env.IFLOW_HARNESS;
  return typeof v === "string" && v !== "" && !["0", "false"].includes(v.trim().toLowerCase());
}

// The exact user-settings path the CLI's core module writes (its own
// resolution is hard-coded homedir, mirrored here).
function userSettingsPath() {
  const path = require("node:path");
  const os = require("node:os");
  return path.join(os.homedir(), ".iflow", "settings.json");
}

function isUserSettingsFile(p) {
  if (typeof p !== "string" || !p) return false;
  const path = require("node:path");
  try {
    return path.resolve(p) === userSettingsPath();
  } catch {
    return false;
  }
}

/**
 * Read the on-disk settings the isolation rules are computed from.
 *
 * The two "no usable disk view" situations MUST NOT be conflated:
 *
 *   - the file genuinely does not exist (first run, nothing to protect yet)
 *     -> an empty view is the correct baseline;
 *   - the file EXISTS but cannot be read (permissions, transient IO error)
 *     or does not contain valid JSON (a torn write: the CLI's own
 *     saveSettings writes the WHOLE file with a NON-atomic writeFileSync,
 *     so a crash mid-write leaves a half file behind)
 *     -> the disk view is UNKNOWN, not empty.
 *
 * The second case is the dangerous one. Treating it as "the disk is empty"
 * turns the isolation rules into a data-destruction machine: every
 * STRIP_KEYS entry (mcpServers, tokensLimit, language, approvalMode,
 * compressionTokenThreshold, contextWindowLength, apiProfiles ...) would be
 * stripped from the empty view and the CLI's whole-file rewrite would then
 * delete those keys from the user's settings.json FOREVER — the very bug
 * this loader exists to prevent.
 *
 * @param {string} file the user settings.json path
 * @returns {object | null} the parsed disk object ({} when the file is
 *   genuinely absent) or null when the file exists but cannot be trusted —
 *   the caller must then SKIP the write instead of pretending it is empty.
 */
function readDiskSettings(file) {
  const fs = require("node:fs");
  // Genuinely absent (first run): an empty view is the correct baseline.
  if (!fs.existsSync(file)) return {};
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    // Vanished between the existence check and the read -> genuinely absent.
    if (error && error.code === "ENOENT") return {};
    return null; // unreadable for any other reason (permissions, IO error)
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // torn write / invalid JSON
  }
  // Valid JSON but not a settings object (`null`, `[]`, `123`, ...).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * @param {{path: string, settings: object}} t the saveSettings payload
 * @returns {undefined | {path: string, settings: object} | null}
 *   undefined = untouched, object = write this instead, null = skip write
 */
function intercept(t) {
  if (isDisabledByEnv() || !isHarnessMode()) return undefined;
  if (!t || typeof t !== "object" || !isUserSettingsFile(t.path)) return undefined;
  const s = t.settings;
  if (!s || typeof s !== "object") return undefined;
  // Preserve the on-disk values of the panel-owned keys (terminal users'
  // creds survive verbatim); drop them from the child's memory view.
  const disk = readDiskSettings(t.path);
  // The file exists but is unreadable or corrupt (torn write). We do NOT
  // know what is on disk, so we must NOT strip anything: returning null
  // SKIPS this write (the loader contract) and leaves the file exactly as
  // it is. A skipped update is a lost update at worst; treating the disk
  // as empty is permanent data loss.
  if (disk === null) return null;
  // Nothing to isolate: neither the payload nor the disk carries a
  // panel-owned key. The disk side matters because saveSettings overwrites
  // the whole file — a disk-only apiProfiles (created by the panel after the
  // CLI started) must still be re-injected.
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const touchesPanelField = STRIP_KEYS.some((k) => k in s || has(disk, k));
  // Rule 2 — disk-only keys (Mod-owned, or unknown to the CLI's settings
  // schema) must survive the schema-normalised whole-file write as well.
  const diskOnlyKeys = Object.keys(disk).filter((k) => !has(s, k));
  if (!touchesPanelField && diskOnlyKeys.length === 0) return undefined;
  const merged = {};
  for (const k of Object.keys(s)) {
    if (!STRIP_KEYS.includes(k)) merged[k] = s[k];
  }
  // Rule 1 — re-inject the authoritative disk values.
  for (const k of STRIP_KEYS) {
    if (has(disk, k)) merged[k] = disk[k];
  }
  // Rule 2 — keep the disk-only keys the child's payload does not carry.
  // Never overrides a key the payload does carry: the CLI's own edits win.
  for (const k of diskOnlyKeys) merged[k] = disk[k];
  return { path: t.path, settings: merged };
}

module.exports = { intercept, STRIP_KEYS };