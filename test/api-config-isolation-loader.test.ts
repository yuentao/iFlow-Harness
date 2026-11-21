import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SavePayload {
  path: string;
  settings: Record<string, unknown>;
}

interface Loader {
  intercept(payload: SavePayload): SavePayload | undefined | null;
  STRIP_KEYS: string[];
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/api-config-isolation-loader.cjs") as Loader;

const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HARNESS = process.env.IFLOW_HARNESS;
const ORIGINAL_ISOLATION = process.env.IFLOW_API_ISOLATION;

let home: string;
let settingsPath: string;

function writeDisk(value: unknown): void {
  writeFileSync(settingsPath, JSON.stringify(value), "utf-8");
}

function resetEnv(): void {
  if (ORIGINAL_HARNESS === undefined) delete process.env.IFLOW_HARNESS;
  else process.env.IFLOW_HARNESS = ORIGINAL_HARNESS;
  if (ORIGINAL_ISOLATION === undefined) delete process.env.IFLOW_API_ISOLATION;
  else process.env.IFLOW_API_ISOLATION = ORIGINAL_ISOLATION;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "iflow-api-iso-"));
  mkdirSync(join(home, ".iflow"), { recursive: true });
  settingsPath = join(home, ".iflow", "settings.json");
  // The loader mirrors the CLI's hard-coded `homedir()` resolution.
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.IFLOW_HARNESS = "1";
  delete process.env.IFLOW_API_ISOLATION;
});

afterEach(() => {
  resetEnv();
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe("api-config-isolation-loader", () => {
  it("keeps the on-disk apiProfiles instead of the stale in-memory catalogue", () => {
    const edited = {
      B: { baseUrl: "https://b.example/v1", apiKey: "sk-new", modelName: "m-new" },
    };
    writeDisk({ apiProfiles: edited, language: "zh-cn" });

    const out = loader.intercept({
      path: settingsPath,
      settings: {
        apiProfiles: {
          B: { baseUrl: "https://b.example/v1", apiKey: "sk-old", modelName: "m-old" },
        },
        language: "en",
        mcpServers: { demo: { command: "npx" } },
      },
    });

    expect(out).toBeDefined();
    const settings = out!.settings;
    expect(settings.apiProfiles).toEqual(edited);
    expect(JSON.stringify(settings.apiProfiles)).not.toContain("sk-old");
    // Rule 1 — the disk is authoritative for the protected keys: `language`
    // keeps the on-disk value, and a payload-only `mcpServers` (the disk has
    // none) is not written back.
    expect(settings.language).toBe("zh-cn");
    expect(settings).not.toHaveProperty("mcpServers");
  });

  it("never writes in-memory apiProfiles when the disk has no such key", () => {
    writeDisk({ language: "en" });

    const out = loader.intercept({
      path: settingsPath,
      settings: {
        apiProfiles: { deleted: { baseUrl: "https://gone.example/v1" } },
        language: "en",
      },
    });

    expect(out).toBeDefined();
    expect(out!.settings).not.toHaveProperty("apiProfiles");
    expect(out!.settings.language).toBe("en");
  });

  it("preserves a disk-only apiProfiles even when the payload lacks the key", () => {
    const onDisk = { only: { baseUrl: "https://only.example/v1" } };
    writeDisk({ apiProfiles: onDisk });

    const out = loader.intercept({
      path: settingsPath,
      settings: { language: "en" },
    });

    expect(out).toBeDefined();
    expect(out!.settings.apiProfiles).toEqual(onDisk);
    // Rule 1 — `language` is an authoritative-disk key now: with no on-disk
    // value there is nothing to re-inject, so the child's snapshot value is
    // deliberately not written back (same semantics as apiProfiles).
    expect(out!.settings).not.toHaveProperty("language");
  });

  it("returns undefined when the MOD is disabled or harness mode is off", () => {
    writeDisk({ apiProfiles: { B: { baseUrl: "https://b.example/v1" } } });
    const payload = {
      path: settingsPath,
      settings: { apiProfiles: { B: { baseUrl: "https://stale.example/v1" } } },
    };

    process.env.IFLOW_API_ISOLATION = "0";
    expect(loader.intercept(payload)).toBeUndefined();

    delete process.env.IFLOW_API_ISOLATION;
    delete process.env.IFLOW_HARNESS;
    expect(loader.intercept(payload)).toBeUndefined();
  });

  it("ignores writes that target a non user-level settings file", () => {
    const other = join(home, "other", "settings.json");
    mkdirSync(join(home, "other"), { recursive: true });
    writeFileSync(other, JSON.stringify({ apiProfiles: { B: { baseUrl: "https://b.example/v1" } } }));

    const out = loader.intercept({
      path: other,
      settings: { apiProfiles: { B: { baseUrl: "https://stale.example/v1" } } },
    });

    expect(out).toBeUndefined();
  });

  it("still keeps currentApiProfile from disk", () => {
    writeDisk({ currentApiProfile: "disk-profile", apiProfiles: { disk: {} } });

    const out = loader.intercept({
      path: settingsPath,
      settings: { currentApiProfile: "memory-profile", apiProfiles: { memory: {} } },
    });

    expect(out).toBeDefined();
    expect(out!.settings.currentApiProfile).toBe("disk-profile");
    expect(out!.settings.apiProfiles).toEqual({ disk: {} });
  });

  it("keeps a disk-only tokensLimit that the child payload does not carry", () => {
    // The whole-file overwrite used to drop the user's tokensLimit, so the
    // CLI fell back to its hard-coded 128000 ceiling (auto-compress
    // threshold 0.8 * 128000 = 102400) and every sub-session was compressed
    // on start (baseline ~103000).
    writeDisk({ tokensLimit: 1000000, language: "zh-cn" });

    const out = loader.intercept({
      path: settingsPath,
      settings: { language: "zh-cn" },
    });

    expect(out).toBeDefined();
    expect(out!.settings.tokensLimit).toBe(1000000);
  });

  it("keeps the on-disk mcpServers catalogue over the stale child payload", () => {
    const onDisk = {
      alpha: { command: "npx", args: ["-y", "alpha"] },
      beta: { command: "npx", args: ["-y", "beta"] },
      gamma: { command: "npx", args: ["-y", "gamma"] },
      delta: { command: "npx", args: ["-y", "delta"] },
      epsilon: { command: "npx", args: ["-y", "epsilon"] },
    };
    writeDisk({ mcpServers: onDisk });

    const out = loader.intercept({
      path: settingsPath,
      settings: { mcpServers: { alpha: { command: "npx", args: ["-y", "alpha"] } } },
    });

    expect(out).toBeDefined();
    expect(Object.keys(out!.settings.mcpServers as Record<string, unknown>)).toHaveLength(5);
    expect(out!.settings.mcpServers).toEqual(onDisk);
  });

  it("keeps the panel-owned keys on disk while the CLI's own keys stay authoritative", () => {
    const diskApiProfiles = {
      A: { baseUrl: "https://a.example/v1", apiKey: "sk-disk-a" },
    };
    writeDisk({
      apiKey: "sk-disk",
      baseUrl: "https://disk.example/v1",
      currentApiProfile: "disk-profile",
      apiProfiles: diskApiProfiles,
      searchApiKey: "disk-search",
      selectedAuthType: "openai-compatible",
      modelName: "disk-model",
      outputTokensLimit: 32000,
    });

    const out = loader.intercept({
      path: settingsPath,
      settings: {
        apiKey: "sk-memory",
        baseUrl: "https://memory.example/v1",
        currentApiProfile: "memory-profile",
        apiProfiles: { A: { baseUrl: "https://a.example/v1", apiKey: "sk-memory-a" } },
        searchApiKey: "memory-search",
        selectedAuthType: "memory",
        modelName: "memory-model",
        outputTokensLimit: 8000,
        // Not a protected key: the CLI's own value must survive Rule 2.
        theme: "dark",
      },
    });

    expect(out).toBeDefined();
    const settings = out!.settings;
    expect(settings.apiKey).toBe("sk-disk");
    expect(settings.baseUrl).toBe("https://disk.example/v1");
    expect(settings.currentApiProfile).toBe("disk-profile");
    expect(settings.apiProfiles).toEqual(diskApiProfiles);
    expect(settings.searchApiKey).toBe("disk-search");
    expect(settings.selectedAuthType).toBe("openai-compatible");
    expect(settings.modelName).toBe("disk-model");
    expect(settings.outputTokensLimit).toBe(32000);
    expect(settings.theme).toBe("dark");
  });

  it("preserves disk-only keys the CLI schema does not know about", () => {
    writeDisk({ modOwnedKey: { enabled: true }, language: "zh-cn" });

    const out = loader.intercept({
      path: settingsPath,
      settings: { language: "zh-cn" },
    });

    expect(out).toBeDefined();
    expect(out!.settings.modOwnedKey).toEqual({ enabled: true });
  });
});
