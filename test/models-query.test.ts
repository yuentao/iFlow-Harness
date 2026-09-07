import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeModelsUrl,
  parseModelsResponse,
  readActiveEndpoint,
} from "../src/acp/models-query";

const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-models-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function settingsFile(content: unknown): string {
  const file = path.join(tempDir, `settings-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

describe("normalizeModelsUrl", () => {
  it("appends /models once, trimming trailing slashes", () => {
    expect(normalizeModelsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models");
  });

  it("is idempotent when baseUrl already ends with /models", () => {
    expect(normalizeModelsUrl("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("defaults to https when the user-typed baseUrl omits the scheme", () => {
    expect(normalizeModelsUrl("api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("  api.example.com/v1  ")).toBe("https://api.example.com/v1/models");
  });

  it("keeps an explicit http:// scheme (local endpoints)", () => {
    expect(normalizeModelsUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1/models");
  });
});

describe("parseModelsResponse", () => {
  it("parses the OpenAI {data:[{id}]} shape and dedupes", () => {
    expect(
      parseModelsResponse({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }, {}] }),
    ).toEqual(["m1", "m2"]);
  });

  it("accepts the {models:[...]} alt shape with id or name", () => {
    expect(parseModelsResponse({ models: [{ name: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("returns [] for malformed payloads", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: "nope" })).toEqual([]);
    expect(parseModelsResponse([1, 2])).toEqual([]);
  });
});

describe("readActiveEndpoint", () => {
  it("uses the current profile's baseUrl/apiKey/modelName", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "BUZZ",
      apiProfiles: {
        BUZZ: { baseUrl: "https://buzz.example.com/v1", apiKey: "sk-buzz", modelName: "glm-x" },
        Other: { baseUrl: "https://other.example.com/v1", apiKey: "sk-o", modelName: "m-o" },
      },
    });
    expect(readActiveEndpoint(file)).toEqual({
      baseUrl: "https://buzz.example.com/v1",
      apiKey: "sk-buzz",
      modelName: "glm-x",
    });
  });

  it("falls back to top-level fields when no profile is active", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    });
    expect(readActiveEndpoint(file)).toEqual({
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    });
  });

  it("returns null for non-openai-compatible auth or missing credentials", () => {
    expect(readActiveEndpoint(settingsFile({ selectedAuthType: "iflow" }))).toBeNull();
    expect(readActiveEndpoint(settingsFile({ selectedAuthType: "openai-compatible" }))).toBeNull();
    expect(readActiveEndpoint(path.join(tempDir, "missing.json"))).toBeNull();
  });
});
