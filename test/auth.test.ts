import { describe, it, expect } from "vitest";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  validateCredentials,
  loadProfiles,
  saveProfiles,
  getActiveProfileName,
  setActiveProfileName,
  maskKey,
  type SecretStore,
} from "../src/acp/auth";

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async store(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe("credentials storage", () => {
  it("round-trips save/load and returns null when empty", async () => {
    const store = memoryStore();
    expect(await loadCredentials(store)).toBeNull();
    await saveCredentials(store, { baseUrl: "https://api.example.com/v1", apiKey: "sk-abc", modelName: "glm-5" });
    expect(await loadCredentials(store)).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-abc",
      modelName: "glm-5",
    });
    await clearCredentials(store);
    expect(await loadCredentials(store)).toBeNull();
  });

  it("returns null for malformed payloads", async () => {
    const store = memoryStore();
    await store.store("iflow.openai-compatible", "{not json");
    expect(await loadCredentials(store)).toBeNull();
    await store.store("iflow.openai-compatible", JSON.stringify({ baseUrl: "x" }));
    expect(await loadCredentials(store)).toBeNull();
  });
});

describe("validateCredentials", () => {
  it("trims values and strips trailing slashes from baseUrl", () => {
    const result = validateCredentials({ baseUrl: "https://api.example.com/v1/", apiKey: " sk ", modelName: " m " });
    expect(result).toEqual({
      ok: true,
      value: { baseUrl: "https://api.example.com/v1", apiKey: "sk", modelName: "m" },
    });
  });

  it("rejects bad baseUrl and empty fields", () => {
    expect(validateCredentials({ baseUrl: "ftp://x", apiKey: "k", modelName: "m" }).ok).toBe(false);
    expect(validateCredentials({ baseUrl: "", apiKey: "k", modelName: "m" }).ok).toBe(false);
    expect(validateCredentials({ baseUrl: "https://x", apiKey: "", modelName: "m" }).ok).toBe(false);
    expect(validateCredentials({ baseUrl: "https://x", apiKey: "k", modelName: "" }).ok).toBe(false);
  });
});

describe("api profiles (multi-config)", () => {
  it("round-trips profiles and drops malformed entries", async () => {
    const store = memoryStore();
    expect(await loadProfiles(store)).toEqual({});
    await saveProfiles(store, {
      A: { baseUrl: "https://a.com/v1", apiKey: "sk-a", modelName: "m-a" },
      B: { baseUrl: "https://b.com/v1", apiKey: "sk-b", modelName: "m-b" },
      "": { baseUrl: "https://c.com/v1", apiKey: "sk-c", modelName: "m-c" },
      Broken: { baseUrl: "https://d.com/v1" },
    });
    const profiles = await loadProfiles(store);
    expect(Object.keys(profiles).sort()).toEqual(["A", "B"]);
    expect(profiles.A).toEqual({ baseUrl: "https://a.com/v1", apiKey: "sk-a", modelName: "m-a" });
  });

  it("tracks the active profile name", async () => {
    const store = memoryStore();
    expect(await getActiveProfileName(store)).toBeNull();
    await setActiveProfileName(store, "A");
    expect(await getActiveProfileName(store)).toBe("A");
  });

  it("masks keys to their last 4 characters", () => {
    expect(maskKey("sk-12345678")).toBe("…5678");
    expect(maskKey("abc")).toBe("…");
  });
});
