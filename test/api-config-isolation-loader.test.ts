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
    // Non-panel fields keep the child's values.
    expect(settings.language).toBe("en");
    expect(settings.mcpServers).toEqual({ demo: { command: "npx" } });
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
    expect(out!.settings.language).toBe("en");
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
});
