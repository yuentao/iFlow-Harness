// Probe: is it safe to run `session/new` and `session/load` CONCURRENTLY on
// the same ACP client (same CLI process)?
//
// Why: the panel's restore does `await newSession(probe)` and then
// `await loadSession(target)` — strictly serial. The probe session only
// exists to obtain the CLI's `_meta`/`modes` (a `session/load` response on
// CLI 0.5.19 carries neither), so serializing them doubles the wall time of
// a restore. If the two calls are independent, they could run in parallel.
//
// What it checks (one CLI process, one JSON-RPC stream):
//   1. baseline   — session/new, then session/load (serial) + timings
//   2. concurrent — Promise.all([session/new, session/load]) + timings
//   3. integrity  — the loaded session still reports its own id, a second
//                   load still works, and the loaded session still answers a
//                   prompt (the CLI's session registry was not corrupted)
//   4. crosstalk  — no session/update notification of the concurrent phase
//                   carries the wrong session id
//
// Usage:
//   IFLOW_CLI_ENTRY=<path to bundle/entry.js> node test/fixtures/probe-restore-concurrency.mjs
//   IFLOW_PROBE_SKIP_PROMPT=1   skip the model call (needs credentials)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY =
  process.env.IFLOW_CLI_ENTRY ??
  "J:\\git\\iflow-harness\\vendor\\iflow-cli\\bundle\\entry.js";
const CWD = process.env.IFLOW_PROBE_CWD ?? path.resolve(here, "..", "..");
const SKIP_PROMPT = process.env.IFLOW_PROBE_SKIP_PROMPT === "1";

if (!existsSync(ENTRY)) {
  console.error(`[probe] CLI entry not found: ${ENTRY}`);
  console.error("[probe] set IFLOW_CLI_ENTRY to the vendored bundle/entry.js");
  process.exit(2);
}

/** One ACP client over the vendored CLI. */
function connect() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, "--experimental-acp", "--stream"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: CWD,
      env: { ...process.env, IFLOW_HARNESS: "1" },
    });
    let id = 0;
    const pending = new Map();
    /** session/update notifications, tagged with the session id. */
    const updates = [];
    const send = (method, params) => {
      const mid = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    };
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        }
        return;
      }
      if (msg.method === "session/update") {
        updates.push(msg.params?.sessionId ?? null);
        return;
      }
      if (msg.method && msg.id !== undefined) {
        // agent→client requests: answer harmlessly (permissions cancelled).
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n",
        );
      }
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const hard = setTimeout(() => {
      kill();
      reject(new Error("hard timeout 240s"));
    }, 240000);
    hard.unref?.();
    (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        clearTimeout(hard);
        resolve({ send, updates, kill });
      } catch (e) {
        clearTimeout(hard);
        kill();
        reject(e);
      }
    })();
  });
}

/** The CLI persists every ACP session under ~/.iflow/acp/sessions/<id>.json. */
function sessionFile(id) {
  return path.join(os.homedir(), ".iflow", "acp", "sessions", `${id}.json`);
}

/** Any previously persisted session — used when no model call is possible. */
function anyPersistedSession() {
  const dir = path.join(os.homedir(), ".iflow", "acp", "sessions");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return files.length ? path.basename(files[files.length - 1], ".json") : null;
  } catch {
    return null;
  }
}

const t0 = Date.now();
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`[probe] FAIL: ${msg}`);
};
const ok = (msg) => console.log(`[probe] ok: ${msg}`);

try {
  const { send, updates, kill } = await connect();
  try {
    // --- target session: create one, or fall back to an existing one --------
    let target = null;
    let targetIsFresh = false;
    if (!SKIP_PROMPT) {
      const created = await send("session/new", { cwd: CWD, mcpServers: [] });
      target = created.sessionId;
      try {
        const r = await send("session/prompt", {
          sessionId: target,
          prompt: [{ type: "text", text: "Reply with exactly: ok" }],
        });
        targetIsFresh = true;
        ok(`created a persistable session ${target} (stopReason=${r?.stopReason})`);
      } catch (e) {
        console.warn(`[probe] prompt failed (${e.message}) — falling back to an existing session`);
      }
      // The CLI writes the session file in the prompt's finally block; give it
      // a moment before checking.
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!target || !existsSync(sessionFile(target))) {
      target = anyPersistedSession();
      if (!target) {
        console.error("[probe] no persisted session available — cannot test session/load");
        process.exit(2);
      }
      ok(`using the existing persisted session ${target}`);
    }
    if (!targetIsFresh) {
      console.warn("[probe] running without a model call (no credentials / prompt skipped)");
    }

    // --- 1. baseline: serial new + load ------------------------------------
    // Warm-up round first: the FIRST session/new of a CLI process pays the
    // MCP discovery cost, so measuring the very first one would make the
    // serial variant look slower than it is.
    await send("session/new", { cwd: CWD, mcpServers: [] });
    await send("session/load", { cwd: CWD, mcpServers: [], sessionId: target });

    const b0 = Date.now();
    const probeNew = await send("session/new", { cwd: CWD, mcpServers: [] });
    const b1 = Date.now();
    const loadSeq = await send("session/load", { cwd: CWD, mcpServers: [], sessionId: target });
    const b2 = Date.now();
    const serialMs = b2 - b0;
    console.log(
      `[probe] serial   : session/new ${b1 - b0}ms, session/load ${b2 - b1}ms, total ${serialMs}ms`,
    );
    if (loadSeq.sessionId !== target) {
      fail(`serial session/load returned ${loadSeq.sessionId}, expected ${target}`);
    }
    const seqHasMeta = Boolean(loadSeq._meta);
    const seqHasModes = Boolean(loadSeq.modes);
    ok(
      `serial session/load ok (sessionId=${loadSeq.sessionId}, _meta=${seqHasMeta}, modes=${seqHasModes})`,
    );

    // --- 2. concurrent new + load ------------------------------------------
    updates.length = 0;
    const c0 = Date.now();
    const [newConcurrent, loadConcurrent] = await Promise.all([
      send("session/new", { cwd: CWD, mcpServers: [] }),
      send("session/load", { cwd: CWD, mcpServers: [], sessionId: target }),
    ]);
    const c1 = Date.now();
    const concurrentMs = c1 - c0;
    console.log(`[probe] concurrent: session/new + session/load in ${concurrentMs}ms (serial was ${serialMs}ms)`);
    if (loadConcurrent.sessionId !== target) {
      fail(`concurrent session/load returned ${loadConcurrent.sessionId}, expected ${target}`);
    }
    if (newConcurrent.sessionId === target) {
      fail("concurrent session/new returned the loaded session id — the two calls crossed");
    }
    if (!newConcurrent._meta) {
      fail("concurrent session/new carried no _meta (the panel needs it for the model list)");
    }
    const strayUpdates = updates.filter((id) => id !== null && id !== target && id !== newConcurrent.sessionId);
    if (strayUpdates.length) {
      fail(`crosstalk: ${strayUpdates.length} session/update notification(s) carried an unrelated session id`);
    }
    ok(
      `concurrent pair ok (new=${newConcurrent.sessionId}, loaded=${loadConcurrent.sessionId}, updates=${updates.length})`,
    );

    // --- 2b. alternate rounds (both variants measured warm) -----------------
    const b3 = Date.now();
    await send("session/new", { cwd: CWD, mcpServers: [] });
    await send("session/load", { cwd: CWD, mcpServers: [], sessionId: target });
    const serialMs2 = Date.now() - b3;
    const c2 = Date.now();
    await Promise.all([
      send("session/new", { cwd: CWD, mcpServers: [] }),
      send("session/load", { cwd: CWD, mcpServers: [], sessionId: target }),
    ]);
    const concurrentMs2 = Date.now() - c2;
    console.log(
      `[probe] round 2   : serial ${serialMs2}ms vs concurrent ${concurrentMs2}ms`,
    );
    console.log(
      `[probe] summary   : serial ${serialMs}ms/${serialMs2}ms, concurrent ${concurrentMs}ms/${concurrentMs2}ms`,
    );

    // --- 3. integrity after the concurrent pair ----------------------------
    const p0 = Date.now();
    const loadAgain = await send("session/load", { cwd: CWD, mcpServers: [], sessionId: target });
    const p1 = Date.now();
    console.log(`[probe] post-check: session/load after the concurrent pair took ${p1 - p0}ms`);
    if (loadAgain.sessionId !== target) {
      fail(`post-check session/load returned ${loadAgain.sessionId}, expected ${target}`);
    }
    if (Boolean(loadAgain.modes) !== seqHasModes || Boolean(loadAgain._meta) !== seqHasMeta) {
      fail(
        `post-check session/load shape differs from the serial baseline (_meta ${seqHasMeta}→${Boolean(loadAgain._meta)}, modes ${seqHasModes}→${Boolean(loadAgain.modes)})`,
      );
    }

    // --- 4. the loaded session still works ---------------------------------
    if (!SKIP_PROMPT) {
      const q0 = Date.now();
      try {
        const r = await send("session/prompt", {
          sessionId: target,
          prompt: [{ type: "text", text: "Reply with exactly: ok" }],
        });
        console.log(
          `[probe] post-check prompt on the loaded session ok in ${Date.now() - q0}ms (stopReason=${r?.stopReason})`,
        );
      } catch (e) {
        fail(`prompt on the loaded session failed after the concurrent pair: ${e.message}`);
      }
    }

    console.log(`[probe] total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (failures) {
      console.error(`[probe] FAIL (${failures} problem(s))`);
      process.exit(1);
    }
    console.log("[probe] PASS");
    process.exit(0);
  } finally {
    kill();
  }
} catch (e) {
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
}
