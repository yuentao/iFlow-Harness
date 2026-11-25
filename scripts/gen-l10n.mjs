#!/usr/bin/env node
/**
 * Generate both English l10n artifacts from the single source of truth.
 *
 * Source: l10n/source.en.json — maps Chinese `t()` keys to English text.
 *   - normal entry:  "键": "English"
 *   - per-target override (display conventions differ between host and webview):
 *                    "键": { "host": "english", "webview": "Title Case" }
 *
 * Targets:
 *   - l10n/bundle.l10n.en.json  (read by VS Code runtime for vscode.l10n.t)
 *   - webview/src/i18n.ts       (inline `en` dictionary used by webview t())
 *
 * Usage:
 *   node scripts/gen-l10n.mjs            # write both generated artifacts
 *   node scripts/gen-l10n.mjs --check    # generate into a temp dir and diff; non-zero on drift
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "l10n/source.en.json");
const BUNDLE = path.join(ROOT, "l10n/bundle.l10n.en.json");
const I18N = path.join(ROOT, "webview/src/i18n.ts");

/** Header + runtime scaffolding of i18n.ts; only the `en` object is generated. */
const I18N_HEAD = `/**
 * Webview i18n: Chinese is the source language; an English dictionary is
 * provided for en locales. \`t()\` falls back to the key itself for any other
 * locale, so nothing breaks when a new language hasn't been translated yet.
 * The locale arrives with every host snapshot (\`vscode.env.language\`); the
 * mock host fixes it to zh-cn.
 *
 * AUTO-GENERATED from l10n/source.en.json by scripts/gen-l10n.mjs.
 * Do not edit by hand; run \`npm run l10n:gen\` after changing the source.
 */

export type Locale = string | undefined;

let current: Locale = undefined;

export function setLocale(locale: Locale): void {
  current = locale;
}

function isEnglish(): boolean {
  return (current ?? "zh-cn").toLowerCase().startsWith("en");
}

const en: Record<string, string> = {
`;

const I18N_TAIL = `};

export function t(message: string, ...args: Array<string | number>): string {
  let out = isEnglish() ? (en[message] ?? message) : message;
  for (let i = 0; i < args.length; i++) {
    out = out.replaceAll(\`{\${i}}\`, String(args[i]));
  }
  return out;
}
`;

export function readSource() {
  const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.host === "string" &&
      typeof value.webview === "string"
    ) {
      continue;
    }
    throw new Error(
      `l10n/source.en.json: invalid value for ${JSON.stringify(key)}; expected a string or { host, webview }`,
    );
  }
  return source;
}

/** Build the exact bytes of both generated artifacts from the source object. */
export function buildArtifacts(source) {
  const host = {};
  const webview = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      host[key] = value;
      webview[key] = value;
    } else {
      host[key] = value.host;
      webview[key] = value.webview;
    }
  }

  const bundleText = JSON.stringify(host, null, 2) + "\n";
  const entries = Object.entries(webview).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`,
  );
  const i18nText = I18N_HEAD + entries.join("") + I18N_TAIL;
  return { bundleText, i18nText };
}

function generate() {
  const source = readSource();
  const { bundleText, i18nText } = buildArtifacts(source);
  fs.writeFileSync(BUNDLE, bundleText);
  fs.writeFileSync(I18N, i18nText);
  console.log(`generated l10n/bundle.l10n.en.json (${Object.keys(source).length} keys)`);
  console.log(`generated webview/src/i18n.ts (${Object.keys(source).length} keys)`);
}

/** Normalize line endings so a CRLF checkout cannot cause a false drift. */
const normalizeEol = (text) => text.replace(/\r\n/g, "\n");

function check() {
  const { bundleText, i18nText } = buildArtifacts(readSource());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-l10n-"));
  let drifted = false;
  try {
    const bundleTmp = path.join(tmp, "bundle.l10n.en.json");
    const i18nTmp = path.join(tmp, "i18n.ts");
    fs.writeFileSync(bundleTmp, bundleText);
    fs.writeFileSync(i18nTmp, i18nText);
    for (const [label, generated, committed] of [
      ["l10n/bundle.l10n.en.json", bundleTmp, BUNDLE],
      ["webview/src/i18n.ts", i18nTmp, I18N],
    ]) {
      const actual = fs.existsSync(committed) ? fs.readFileSync(committed, "utf8") : "<missing>";
      if (normalizeEol(fs.readFileSync(generated, "utf8")) !== normalizeEol(actual)) {
        console.error(`l10n drift detected in ${label}; run \`npm run l10n:gen\`.`);
        drifted = true;
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (drifted) process.exitCode = 1;
  else console.log("l10n artifacts match the single source");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  if (process.argv.includes("--check")) check();
  else generate();
}
