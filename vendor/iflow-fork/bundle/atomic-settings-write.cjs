"use strict";
// Atomic replacement for the vendored CLI's bare
// `writeFileSync(settingsPath, JSON.stringify(...), "utf-8")` inside saveSettings.
//
// The payload is written to a UNIQUE temp file in the same directory and then
// moved over the target with rename(). The target is NEVER unlinked first, so a
// concurrent reader sees either the old or the new complete content — never
// "no file at all" and never a half-written file. That is the root cause of the
// 竞态丢键 bug: a reader that saw the file missing treated the disk as empty
// and rewrote the whole settings object, dropping mcpServers / tokensLimit /
// language / approvalMode.
//
// Deliberately silent: the bundle speaks NDJSON on stdout for the ACP wire, so
// this module never console.log/warn/error. The caller's outer catch already
// keeps the upstream `console.error("Error saving user settings file:", e)`.

const fs = require("fs");

let tmpSeq = 0;

/** Transient "file is busy" backoff: 20 -> 600ms, ~1.13s total. */
const RETRY_DELAYS_MS = [20, 60, 150, 300, 600];
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const SLEEP_PARK = new Int32Array(new SharedArrayBuffer(4));

function uniqueTmpPath(file) {
  tmpSeq += 1;
  return `${file}.iflow-harness-tmp-${process.pid}-${Date.now()}-${tmpSeq}`;
}

function isRetryable(error) {
  const code = error && error.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_PARK, 0, 0, ms);
}

/**
 * Serialize `settings` and atomically replace `file`.
 *
 * @param {string} file      absolute path handed in by saveSettings (do NOT
 *                           re-resolve it — the CLI hard-codes homedir/.iflow
 *                           and ignores IFLOW_HOME)
 * @param {unknown} settings payload to serialize (already intercepted upstream)
 * @param {{fs?: object, delaysMs?: number[]}} [options] test seams only:
 *        `fs` fakes the I/O layer, `delaysMs` shortens the backoff to 0ms
 */
function writeAtomicSync(file, settings, options) {
  const io = (options && options.fs) || fs;
  const delays = (options && options.delaysMs) || RETRY_DELAYS_MS;
  const tmp = uniqueTmpPath(file);
  try {
    io.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        io.renameSync(tmp, file);
        return;
      } catch (error) {
        if (!isRetryable(error)) throw error;
        const delay = delays[attempt];
        if (delay === undefined) throw error; // exhausted: rethrow the ORIGINAL error
        sleepSync(delay);
      }
    }
  } catch (error) {
    // Best-effort cleanup of the temp file; never mask the original failure.
    try {
      if (io.existsSync(tmp)) io.unlinkSync(tmp);
    } catch {
      // nothing left to clean up
    }
    throw error;
  }
}

module.exports = { writeAtomicSync, uniqueTmpPath, isRetryable, RETRY_DELAYS_MS };
