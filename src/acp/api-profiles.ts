/**
 * Kernel-side API profile store — the panel's single persistence authority.
 *
 * The panel's API configuration lives in the Core's user settings file
 * (`~/.iflow/settings.json`) under `apiProfiles` / `currentApiProfile`, not in
 * VSCode SecretStorage. SecretStorage keeps only the runtime cache used for
 * hot re-authentication and the source of the one-time migration below.
 *
 * Every write is a read-modify-write that touches ONLY the `apiProfiles` (or
 * `currentApiProfile`) key, so `mcpServers`, `language`, `approvalMode` and any
 * field written by the CLI or another tool survive untouched. Writes go
 * through {@link updateCliSettings}, i.e. a temp file + rename (atomic on
 * Windows and POSIX).
 */

import { existsSync } from "node:fs";
import type { ProfileMap } from "./auth.js";
import { readCliSettings, settingsFilePath, updateCliSettings } from "./models-query.js";

/** Complete profiles from `apiProfiles`; entries missing any of the three
 * credential fields are skipped (never fabricated). */
export function readKernelApiProfiles(settingsPath?: string): ProfileMap {
  const settings = readCliSettings(settingsPath);
  const out: ProfileMap = {};
  for (const [rawName, profile] of Object.entries(settings?.apiProfiles ?? {})) {
    const name = rawName.trim();
    const baseUrl = profile?.baseUrl?.trim();
    const apiKey = profile?.apiKey?.trim();
    const modelName = profile?.modelName?.trim();
    if (!name || !baseUrl || !apiKey || !modelName) continue;
    out[name] = { baseUrl, apiKey, modelName };
  }
  return out;
}

/**
 * Upsert one profile. A missing file is created; an EXISTING but unparseable
 * file is left alone (returns false) — we never overwrite content we could not
 * read.
 *
 * The entry is updated IN PLACE: the CLI writes per-profile metadata into
 * `apiProfiles` itself (`selectedAuthType`, `tokensLimit`, `expiryDays`,
 * `balanceProvider`, `_lastModified`, `expiryStartDate`, …). Replacing the
 * whole object with our three fields silently dropped that data (user-reported
 * "编辑后配置像没保存"), so only the three editable fields are overwritten.
 */
export function writeKernelApiProfile(
  name: string,
  creds: { baseUrl: string; apiKey: string; modelName: string },
  settingsPath?: string,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const file = settingsPath ?? settingsFilePath();
  const existing = readCliSettings(file)?.apiProfiles ?? {};
  const profiles = { ...existing };
  const previous = existing[trimmed];
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  profiles[trimmed] = {
    ...base,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    modelName: creds.modelName,
  };
  return updateCliSettings({ apiProfiles: profiles }, file, { createIfMissing: true });
}

/** Remove one profile. A missing file (nothing to delete) counts as success;
 * an existing but unparseable file returns false. */
export function deleteKernelApiProfile(name: string, settingsPath?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const file = settingsPath ?? settingsFilePath();
  const settings = readCliSettings(file);
  if (!settings) return !existsSync(file);
  const profiles = { ...(settings.apiProfiles ?? {}) };
  if (!Object.hasOwn(profiles, trimmed)) return true;
  delete profiles[trimmed];
  return updateCliSettings({ apiProfiles: profiles }, file);
}

/** Point the Core's `currentApiProfile` at `name`, or drop the key when null. */
export function setKernelActiveProfile(name: string | null, settingsPath?: string): boolean {
  const file = settingsPath ?? settingsFilePath();
  return updateCliSettings(
    { currentApiProfile: name?.trim() || undefined },
    file,
    { createIfMissing: true },
  );
}

/**
 * One-time upgrade path: copy SecretStorage-only profiles into the kernel
 * file so users who configured the panel before this change keep their
 * profiles. Entries whose name already exists in `apiProfiles` are NEVER
 * overwritten (the kernel file is the authority); a write failure is logged
 * and swallowed — the SecretStorage record still works as the runtime cache.
 * Returns the names actually written.
 */
export function migrateKernelApiProfiles(legacy: ProfileMap, settingsPath?: string): string[] {
  const file = settingsPath ?? settingsFilePath();
  const settings = readCliSettings(file);
  const existing = settings?.apiProfiles ?? {};
  const taken = new Set(Object.keys(existing).map((key) => key.trim()));
  const additions: ProfileMap = {};
  const migrated: string[] = [];
  for (const [rawName, creds] of Object.entries(legacy)) {
    const name = rawName.trim();
    if (!name || taken.has(name) || additions[name]) continue;
    if (!creds.baseUrl || !creds.apiKey || !creds.modelName) continue;
    additions[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    migrated.push(name);
  }
  if (migrated.length === 0) return [];
  const ok = updateCliSettings(
    { apiProfiles: { ...existing, ...additions } },
    file,
    { createIfMissing: true },
  );
  if (!ok) {
    console.warn(`[iflow-harness] failed to migrate ${migrated.length} API profile(s) into ${file}`);
    return [];
  }
  return migrated;
}
