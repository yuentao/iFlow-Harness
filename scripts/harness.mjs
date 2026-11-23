#!/usr/bin/env node
/**
 * M0 harness: drive the real iFlow CLI over ACP.
 *
 * Usage:
 *   node scripts/harness.mjs                 # handshake + session + prompt
 *   node scripts/harness.mjs --record        # also record the wire log to test/fixtures
 *   node scripts/harness.mjs --probe         # probe set_mode/set_model/set_think (no prompt)
 *   node scripts/harness.mjs --prompt "回复 OK"
 *   node scripts/harness.mjs --credentials ./creds.json
 *   IFLOW_CLI_ENTRY=<path> node scripts/harness.mjs
 *
 * Steps: initialize → [authenticate] → newSession → prompt("Say OK and nothing else.")
 * → print streaming updates → prompt response summary → dispose.
 * No tool calls are allowed (permission requests are denied), so the run is
 * safe and does not modify the workspace.
 *
 * Credentials (optional, highest priority first):
 *   1. `--credentials <file>` — JSON file:
 *        { "provider": "openai-compatible", "baseUrl": "...", "apiKey": "...", "model": "..." }
 *      (`modelName` is accepted as an alias of `model`.)
 *   2. Env vars: IFLOW_HARNESS_PROVIDER / IFLOW_HARNESS_BASE_URL /
 *      IFLOW_HARNESS_API_KEY / IFLOW_HARNESS_MODEL (provider defaults to
 *      `openai-compatible` when omitted).
 *   3. Neither — no authenticate call; the previous behavior is unchanged.
 *
 * When credentials are present they are pushed through ACP `authenticate`
 * ({ methodId: "openai-compatible", methodInfo: { apiKey, baseUrl, modelName } })
 * AFTER initialize and BEFORE session/new — the same wire shape the extension
 * uses (src/acp/auth.ts, src/panel/panel.ts). Credentials discipline: the API
 * key is never printed in full, never written to disk (recorded wire logs are
 * redacted), never copied out of the --credentials file, and the
 * IFLOW_HARNESS_* env vars are stripped from the CLI child's environment.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../dist/src/acp/client.js";
import { buildAcpCommand, resolveVendoredEntry } from "../dist/src/acp/cli-locator.js";
import { redactWireValue } from "../dist/src/panel/wire-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
/** Token following `--name`, as-is (original --prompt semantics). */
const rawFlagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
/** Token following `--name`, treating a missing or `--`-prefixed value as absent. */
const flagValue = (name) => {
  const value = rawFlagValue(name);
  return value !== undefined && !value.startsWith("--") ? value : undefined;
};

function printHelp() {
  console.log(`Usage: node scripts/harness.mjs [options]

Options:
  --prompt <text>       Prompt to send (default: "Reply with exactly: OK")
  --probe               Probe set_mode / set_model / set_think (no prompt sent)
  --record              Record the ACP wire log to test/fixtures (credentials redacted)
  --credentials <file>  JSON credentials:
                          { "provider": "openai-compatible", "baseUrl": "...",
                            "apiKey": "...", "model": "..." }
  -h, --help            Show this help

Environment:
  IFLOW_CLI_ENTRY         Override the vendored CLI entry (vendor-pruning checks)
  IFLOW_HARNESS_PROVIDER  openai-compatible (default when any env cred is set)
  IFLOW_HARNESS_BASE_URL  Endpoint, e.g. https://api.example.com/v1
  IFLOW_HARNESS_API_KEY   API key (never printed in full)
  IFLOW_HARNESS_MODEL     Model name

Credentials are optional. When present, the harness calls ACP \`authenticate\`
after initialize and before session/new; without them the flow is unchanged.
--credentials outranks the IFLOW_HARNESS_* env vars.`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
  process.exit(0);
}

const record = hasFlag("--record");
const probe = hasFlag("--probe");
const promptText = rawFlagValue("--prompt") ?? "Reply with exactly: OK";
const credentialsFile = flagValue("--credentials");

if (hasFlag("--credentials") && !credentialsFile) {
  console.error("[harness] FAIL: --credentials requires a JSON file path");
  process.exit(2);
}

// --- Credentials -------------------------------------------------------------

const SUPPORTED_PROVIDER = "openai-compatible";
const HARNESS_ENV_KEYS = [
  "IFLOW_HARNESS_PROVIDER",
  "IFLOW_HARNESS_BASE_URL",
  "IFLOW_HARNESS_API_KEY",
  "IFLOW_HARNESS_MODEL",
];

/** Display-safe rendering of a secret: first 4 chars + length, or `***`. */
function maskSecret(secret) {
  const value = String(secret ?? "");
  if (!value) return "***";
  if (value.length <= 8) return `*** (len=${value.length})`;
  return `${value.slice(0, 4)}… (len=${value.length})`;
}

/** Remove any literal occurrence of the API key (and sk-… shaped tokens) from text. */
function redactSecrets(text, apiKey) {
  let out = String(text ?? "");
  // Only literal-replace a reasonably long key: a 4-char key would rewrite
  // unrelated substrings (paths, model names) all over the output.
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join(maskSecret(apiKey));
  return out.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})\b/g, "«redacted»");
}

function normalizeCredentials(raw, origin) {
  const provider = String(raw.provider ?? SUPPORTED_PROVIDER).trim();
  const baseUrl = String(raw.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(raw.apiKey ?? "").trim();
  const modelName = String(raw.model ?? raw.modelName ?? "").trim();

  if (provider !== SUPPORTED_PROVIDER) {
    throw new Error(
      `${origin}: unsupported provider "${provider}" (only "${SUPPORTED_PROVIDER}" is supported)`,
    );
  }
  const missing = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!modelName) missing.push("model");
  if (missing.length > 0) throw new Error(`${origin}: missing ${missing.join(", ")}`);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`${origin}: baseUrl must start with http:// or https://`);
  }
  return { provider, baseUrl, apiKey, modelName, origin };
}

async function resolveCredentials() {
  if (credentialsFile) {
    const abs = path.resolve(process.cwd(), credentialsFile);
    let raw;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      throw new Error(`--credentials: cannot read ${abs}`);
    }
    // PowerShell's Set-Content -Encoding utf8 and some editors prepend a BOM;
    // JSON.parse rejects it, so strip one leading BOM before parsing.
    raw = raw.replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`--credentials: ${abs} is not valid JSON`);
    }
    return normalizeCredentials(parsed ?? {}, "--credentials");
  }

  const fromEnv = {
    provider: process.env.IFLOW_HARNESS_PROVIDER,
    baseUrl: process.env.IFLOW_HARNESS_BASE_URL,
    apiKey: process.env.IFLOW_HARNESS_API_KEY,
    model: process.env.IFLOW_HARNESS_MODEL,
  };
  if (HARNESS_ENV_KEYS.every((key) => !process.env[key])) return null;
  return normalizeCredentials(fromEnv, "env IFLOW_HARNESS_*");
}

let credentials;
try {
  credentials = await resolveCredentials();
} catch (error) {
  console.error(
    `[harness] FAIL: ${redactSecrets(error?.message ?? error, process.env.IFLOW_HARNESS_API_KEY)}`,
  );
  process.exit(2);
}

if (credentials) {
  console.log(
    `[harness] credentials: source=${credentials.origin} provider=${credentials.provider} ` +
      `baseUrl=${redactSecrets(credentials.baseUrl, credentials.apiKey)} ` +
      `model=${credentials.modelName} apiKey=${maskSecret(credentials.apiKey)}`,
  );
} else {
  console.log(
    "[harness] credentials: none (no --credentials / IFLOW_HARNESS_* env) — authenticate skipped",
  );
}

// The extension always runs the vendored fork; the harness mirrors that.
// IFLOW_CLI_ENTRY stays as an explicit override for vendor-pruning validation
// (point it at a pruned copy to prove the cut bundle still passes ACP).
let entry;
try {
  entry = process.env.IFLOW_CLI_ENTRY ?? resolveVendoredEntry(root);
} catch {
  console.error("[harness] FAIL: vendored CLI missing. Run `npm run vendor:cli` or set IFLOW_CLI_ENTRY.");
  process.exit(2);
}
console.log(`[harness] CLI entry: ${entry}`);

const { command, args: acpArgs } = buildAcpCommand(entry);

// Never forward harness credential env vars into the CLI child: AcpClient
// spreads process.env underneath options.env, and Node's spawn drops
// `undefined` values, so this keeps the key out of the child's environment.
const childEnv = Object.fromEntries(HARNESS_ENV_KEYS.map((key) => [key, undefined]));

const wire = [];
const wireTap = (direction, message) => {
  // Credentials redaction runs before the buffer: the wire carries
  // authenticate params with the raw API key, and --record writes to disk.
  if (record) wire.push({ t: Date.now(), dir: direction, msg: redactWireValue(message) });
};

// Flips right before our own teardown. dispose() kills the child through
// killTree → `taskkill /T /F` on Windows, which always reports exitCode=1
// regardless of the CLI's real status, so an exit observed after this flag
// turns true is expected and must not be reported as an agent crash.
let expectingExit = false;

const client = new AcpClient(
  { command, args: acpArgs, cwd: root, env: childEnv, wireTap },
  {
    onSessionUpdate: (n) => {
      const label = n.update?.sessionUpdate;
      if (label === "agent_message_chunk") {
        process.stdout.write(String(n.update.content?.text ?? ""));
      } else if (label === "agent_thought_chunk") {
        process.stdout.write(`[thought] ${String(n.update.content?.text ?? "").slice(0, 80)}\n`);
      } else if (label?.startsWith("tool_call")) {
        console.log(`\n[tool] ${label} ${n.update.toolName ?? ""} ${n.update.status ?? ""}`);
      } else {
        console.log(`\n[update] ${label ?? JSON.stringify(n.update).slice(0, 120)}`);
      }
    },
    // The CLI's stderr can echo the endpoint (and, if a key is embedded in a
    // URL, the key itself) — redact before forwarding.
    onStderr: (line) => console.error(`[stderr] ${redactSecrets(line, credentials?.apiKey)}`),
    // An exit we triggered ourselves is expected: report it as a teardown so
    // the taskkill-forced exitCode=1 is not mistaken for an agent crash.
    onExit: (code, signal) =>
      console.error(
        expectingExit
          ? `[harness] agent torn down (code=${code}, signal=${signal}) — expected (client.dispose())`
          : `[harness] agent exit code=${code} signal=${signal}`,
      ),
    onRequestPermission: async (req) => {
      console.log(`[harness] permission requested for tool=${req.toolCall?.toolName} → denied (safe mode)`);
      return { outcome: { outcome: "cancelled" } };
    },
  },
);

const summary = {
  startedAt: new Date().toISOString(),
  cliEntry: entry,
  cliVersion: null,
  protocolVersion: null,
  authMethods: [],
  authenticated: null,
  authMethodId: null,
  credentials: credentials
    ? {
        source: credentials.origin,
        provider: credentials.provider,
        baseUrl: redactSecrets(credentials.baseUrl, credentials.apiKey),
        modelName: credentials.modelName,
        apiKey: maskSecret(credentials.apiKey),
      }
    : null,
  agentCapabilities: null,
  agentInfo: null,
  sessionId: null,
  modes: null,
  currentModel: null,
  modelsCount: null,
  commandsCount: null,
  promptStopReason: null,
  messageText: "",
  errors: [],
};

try {
  const init = await client.connect();
  summary.protocolVersion = init.protocolVersion;
  summary.authMethods = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));
  summary.authenticated = init.isAuthenticated ?? null;
  summary.agentCapabilities = init.agentCapabilities ?? null;
  summary.agentInfo = init.agentInfo ?? null;
  summary.cliVersion = init.agentInfo?.version ?? null;
  console.log(`\n[harness] initialize OK: protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? "?"}`);
  console.log(`[harness] authMethods: ${summary.authMethods.map((m) => m.id).join(", ")}`);
  console.log(`[harness] isAuthenticated: ${init.isAuthenticated ?? "?"}`);

  // Credentials are pushed BEFORE session/new: the CLI applies the instance
  // authOptions to every new session config, which is exactly what makes
  // session/new stop failing with "Authentication required".
  if (credentials) {
    const tAuth = Date.now();
    console.log(`[harness] authenticate (${SUPPORTED_PROVIDER}) …`);
    try {
      const auth = await client.authenticate({
        methodId: SUPPORTED_PROVIDER,
        methodInfo: {
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
          modelName: credentials.modelName,
        },
      });
      summary.authMethodId = auth?.methodId ?? SUPPORTED_PROVIDER;
      console.log(`[harness] authenticate OK in ${Date.now() - tAuth}ms (methodId=${summary.authMethodId})`);
    } catch (error) {
      throw new Error(
        `authenticate failed: ${redactSecrets(error?.message ?? error, credentials.apiKey)}`,
      );
    }
  }

  const session = await client.newSession({ cwd: root, mcpServers: [] });
  summary.sessionId = session.sessionId;
  summary.modes = session.modes ?? null;
  summary.modelsCount = session._meta?.models?.availableModels?.length ?? 0;
  summary.currentModel = session._meta?.models?.currentModelId ?? null;
  summary.commandsCount = session._meta?.availableCommands?.length ?? 0;
  console.log(`[harness] session OK: ${session.sessionId}`);
  console.log(`[harness] modes: ${session.modes?.availableModes?.map((m) => m.id).join("/") ?? "?"} (current=${session.modes?.currentModeId})`);
  console.log(`[harness] models=${summary.modelsCount} slashCommands=${summary.commandsCount}`);

  if (probe) {
    // Wire-behavior probe for methods M0 marked "verify on wire".
    // No prompt is sent, so no tokens are consumed.
    console.log("\n[harness] === probe: set_mode ===");
    for (const modeId of ["smart", "default", "plan", "yolo"]) {
      try {
        const r = await client.setMode(session.sessionId, modeId);
        console.log(`[probe] set_mode(${modeId}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_mode(${modeId}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    console.log("\n[harness] === probe: set_model ===");
    const currentModel = session._meta?.models?.currentModelId;
    for (const modelId of [currentModel, "test-probe-nonexistent-model"].filter(Boolean)) {
      try {
        const r = await client.setModel(session.sessionId, modelId);
        console.log(`[probe] set_model(${modelId}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_model(${modelId}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    const firstCatalogModel = session._meta?.models?.availableModels?.[0]?.id;
    if (firstCatalogModel) {
      try {
        const r = await client.setModel(session.sessionId, firstCatalogModel);
        console.log(`[probe] set_model(${firstCatalogModel}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_model(${firstCatalogModel}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    console.log("\n[harness] === probe: set_think ===");
    try {
      const r = await client.setThink(session.sessionId, true, "think");
      console.log(`[probe] set_think(true) → ${JSON.stringify(r)}`);
    } catch (error) {
      console.log(`[probe] set_think(true) → ERROR ${JSON.stringify(error)}`);
    }
    summary.finishedAt = new Date().toISOString();
    console.log("\n[harness] probe complete");
    expectingExit = true;
    await client.dispose();
    process.exit(0);
  }

  console.log(`\n[harness] prompt: "${promptText}"\n--- agent output ---`);
  const result = await client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  summary.promptStopReason = result.stopReason;
  console.log(`\n--- end (stopReason=${result.stopReason}) ---`);
} catch (error) {
  const message = redactSecrets(error?.message ?? error, credentials?.apiKey);
  summary.errors.push(message);
  console.error(`\n[harness] FAIL:`, message);
} finally {
  expectingExit = true;
  await client.dispose();
}

summary.finishedAt = new Date().toISOString();
delete summary.messageText;

console.log("\n[harness] === M0 summary ===");
console.log(redactSecrets(JSON.stringify(summary, null, 2), credentials?.apiKey));

if (record) {
  const fixturesDir = path.join(root, "test", "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wireFile = path.join(fixturesDir, `acp-wire-${stamp}.ndjson`);
  // Belt and braces: redactWireValue already blanked credential-named fields,
  // and this literal pass covers a key embedded in any other string.
  const wireText = wire
    .map((e) => redactSecrets(JSON.stringify(e), credentials?.apiKey))
    .join("\n");
  await writeFile(wireFile, wireText + "\n", "utf8");
  await writeFile(
    path.join(fixturesDir, `m0-summary-${stamp}.json`),
    redactSecrets(JSON.stringify(summary, null, 2), credentials?.apiKey),
  );
  console.log(`[harness] fixture written: ${wireFile} (${wire.length} messages)`);
}

process.exit(summary.errors.length === 0 && summary.promptStopReason ? 0 : 1);
