import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  applyThinkingRules,
  cliImportCandidates,
  mergeThinkingRulesIntoFile,
  normalizeModelsUrl,
  parseModelsResponse,
  projectSettingsFor,
  projectSettingsFilePath,
  readActiveEndpoint,
  readMcpServers,
  resolveActiveProfileName,
  retireStaleOAuthCreds,
  sanitizeThinkingRules,
  settingsFilePath,
  thinkingForModelRules,
  updateCliSettings,
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

describe("resolveActiveProfileName", () => {
  it("prefers the extension record (isolated home: SecretStorage is the authority)", () => {
    expect(
      resolveActiveProfileName({ currentApiProfile: "商汤" }, "BUZZ"),
    ).toBe("BUZZ");
  });

  it("falls back to the CLI pointer when the extension has no record", () => {
    expect(resolveActiveProfileName({ currentApiProfile: "商汤" }, null)).toBe("商汤");
    expect(resolveActiveProfileName({ currentApiProfile: "  " }, "BUZZ")).toBe("BUZZ");
    expect(resolveActiveProfileName({}, "BUZZ")).toBe("BUZZ");
  });

  it("returns null when neither source knows an active profile", () => {
    expect(resolveActiveProfileName({}, null)).toBeNull();
    expect(resolveActiveProfileName(null, null)).toBeNull();
  });

  it("falls back when there is no settings file at all", () => {
    expect(resolveActiveProfileName(null, "BUZZ")).toBe("BUZZ");
  });
});

describe("updateCliSettings", () => {
  it("merges a multi-key patch and preserves every other field", () => {
    const file = settingsFile({
      selectedAuthType: "openai-compatible",
      modelName: "keep-me",
      language: "zh-CN",
      apiProfiles: { P: { baseUrl: "https://a/v1", apiKey: "sk-a", modelName: "m" } },
    });
    expect(
      updateCliSettings(
        {
          language: "en-US",
          approvalMode: "smart",
          mcpServers: { figma: { command: "npx", args: ["-y", "figma-mcp"] } },
        },
        file,
      ),
    ).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.language).toBe("en-US");
    expect(after.approvalMode).toBe("smart");
    expect(after.mcpServers.figma.args).toEqual(["-y", "figma-mcp"]);
    // Untouched fields survive the read-modify-write.
    expect(after.modelName).toBe("keep-me");
    expect(after.selectedAuthType).toBe("openai-compatible");
    expect(after.apiProfiles.P.baseUrl).toBe("https://a/v1");
    expect(existsSync(`${file}.iflow-harness-tmp`)).toBe(false);
  });

  it("returns false for a missing/unreadable settings file", () => {
    expect(updateCliSettings({ language: "zh-CN" }, path.join(tempDir, "missing.json"))).toBe(false);
  });
});

describe("project-scope MCP settings", () => {
  const unique = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2)}`;

  it("points at <cwd>/.iflow/settings.json, and nowhere when cwd IS the home dir", () => {
    const cwd = path.join(tempDir, unique("ws"));
    expect(projectSettingsFilePath(cwd)).toBe(path.join(cwd, ".iflow", "settings.json"));
    expect(projectSettingsFor(cwd)).toBe(path.join(cwd, ".iflow", "settings.json"));
    expect(projectSettingsFor(null)).toBeNull();
    // The CLI skips its Workspace file there too; without the guard we would
    // write a "project" settings.json into the user's home directory.
    expect(projectSettingsFor(homedir())).toBeNull();
  });

  it("creates the project file (and its .iflow dir) only with createIfMissing", () => {
    const file = projectSettingsFilePath(path.join(tempDir, unique("proj")));
    expect(existsSync(file)).toBe(false);
    expect(updateCliSettings({ mcpServers: { a: { command: "node" } } }, file)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(
      updateCliSettings({ mcpServers: { a: { command: "node" } } }, file, { createIfMissing: true }),
    ).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.a.command).toBe("node");
    expect(existsSync(`${file}.iflow-harness-tmp`)).toBe(false);
  });

  it("never clobbers a file that exists but cannot be parsed", () => {
    const broken = path.join(tempDir, `${unique("broken")}.json`);
    writeFileSync(broken, "{oops", "utf8");
    expect(updateCliSettings({ mcpServers: {} }, broken, { createIfMissing: true })).toBe(false);
    expect(readFileSync(broken, "utf8")).toBe("{oops");
    expect(readMcpServers(broken)).toBeNull();
  });

  it("reads one scope's dict: absent file is empty, broken file is null", () => {
    expect(readMcpServers(null)).toEqual({});
    expect(readMcpServers(path.join(tempDir, "absent.json"))).toEqual({});
    expect(readMcpServers(settingsFile({ mcpServers: { a: { command: "node" } }, language: "zh-CN" }))).toEqual({
      a: { command: "node" },
    });
    // A settings file without the field is an empty dict, not an error.
    expect(readMcpServers(settingsFile({ language: "zh-CN" }))).toEqual({});
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

describe("cliImportCandidates", () => {
  it("returns named profiles that have all three fields", () => {
    const candidates = cliImportCandidates(
      {
        apiProfiles: {
          work: { baseUrl: "https://a.example.com/v1", apiKey: "sk-a", modelName: "m-a" },
          incomplete: { baseUrl: "https://b.example.com/v1", apiKey: "sk-b" },
        },
      },
      [],
    );
    expect(candidates).toEqual([
      { name: "work", baseUrl: "https://a.example.com/v1", apiKey: "sk-a", modelName: "m-a" },
    ]);
  });

  it("skips profiles shadowed by an extension-owned name", () => {
    const candidates = cliImportCandidates(
      {
        apiProfiles: {
          work: { baseUrl: "https://a.example.com/v1", apiKey: "sk-a", modelName: "m-a" },
        },
      },
      ["work"],
    );
    expect(candidates).toEqual([]);
  });

  it("includes the top-level endpoint only for openai-compatible auth", () => {
    const settings = {
      selectedAuthType: "openai-compatible",
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    };
    expect(cliImportCandidates(settings, [])).toEqual([
      { name: "m-top", baseUrl: "https://top.example.com/v1", apiKey: "sk-top", modelName: "m-top" },
    ]);
    expect(cliImportCandidates({ ...settings, selectedAuthType: "iflow" }, [])).toEqual([]);
  });

  it("names the top-level candidate after currentApiProfile", () => {
    const settings = {
      selectedAuthType: "openai-compatible",
      currentApiProfile: "终端默认",
      baseUrl: "https://top.example.com/v1",
      apiKey: "sk-top",
      modelName: "m-top",
    };
    expect(cliImportCandidates(settings, [])[0]?.name).toBe("终端默认");
  });

  it("dedupes the same credential set, preferring the named profile", () => {
    const raw = { baseUrl: "https://a.example.com/v1", apiKey: "sk-a", modelName: "m-a" };
    const candidates = cliImportCandidates(
      {
        selectedAuthType: "openai-compatible",
        currentApiProfile: "work",
        apiProfiles: { work: raw },
        ...raw,
      },
      [],
    );
    expect(candidates).toEqual([{ name: "work", ...raw }]);
  });

  it("returns no candidates without settings", () => {
    expect(cliImportCandidates(null, [])).toEqual([]);
  });
});

describe("retireStaleOAuthCreds", () => {
  it("archives an expired token aside (reversibly) and reports the archive path", () => {
    const file = settingsFile({ access_token: "dead", expiry_date: 1000 });
    const archived = retireStaleOAuthCreds(2000, file);
    expect(archived).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
    // Reversible: the content survives in the archive.
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).access_token).toBe("dead");
  });

  it("leaves a token with a future expiry_date untouched", () => {
    const file = settingsFile({ access_token: "alive", expiry_date: 99999999999999 });
    expect(retireStaleOAuthCreds(1000, file)).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it("archives a cache without an expiry field (getTokenInfo would still stall)", () => {
    const file = settingsFile({ access_token: "no-expiry" });
    expect(retireStaleOAuthCreds(1000, file)).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
  });

  it("overwrites a previous .bak archive (rename replaces the target file)", () => {
    const file = settingsFile({ access_token: "fresh-stale", expiry_date: 0 });
    writeFileSync(`${file}.bak`, "previous archive", "utf8");
    expect(retireStaleOAuthCreds(5000, file)).toBe(`${file}.bak`);
    expect(existsSync(file)).toBe(false);
    // The new archive replaced the old one — previous content was stale too.
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).access_token).toBe("fresh-stale");
  });

  it("returns null for missing or unparseable files (no stall, no touch)", () => {
    expect(retireStaleOAuthCreds(1000, path.join(tempDir, "missing-oauth.json"))).toBeNull();
    const corrupt = path.join(tempDir, "corrupt-oauth.json");
    writeFileSync(corrupt, "{not json", "utf8");
    expect(retireStaleOAuthCreds(1000, corrupt)).toBeNull();
    expect(existsSync(corrupt)).toBe(true);
  });
});

describe("sanitizeThinkingRules", () => {
  it("drops junk entries and dedupes by pattern (first wins)", () => {
    expect(
      sanitizeThinkingRules([
        { pattern: "glm-", supportsThinking: true },
        { pattern: "  ", supportsThinking: true },
        { pattern: "no-flag" },
        { pattern: "glm-", supportsThinking: false },
        { pattern: "[", supportsThinking: true },
        "junk",
      ]),
    ).toEqual([{ pattern: "glm-", supportsThinking: true }]);
  });

  it("filters unknown levels and clamps maxThinkingTokens", () => {
    expect(
      sanitizeThinkingRules([
        {
          pattern: "x",
          supportsThinking: true,
          supportedReasoningLevels: ["low", "ultra", "high"],
          maxThinkingTokens: 1234.7,
        },
      ]),
    ).toEqual([
      {
        pattern: "x",
        supportsThinking: true,
        supportedReasoningLevels: ["low", "high"],
        maxThinkingTokens: 1234,
      },
    ]);
  });
});

describe("thinkingForModelRules", () => {
  it("first match wins, case-insensitively (loader semantics)", () => {
    const rules = [
      { pattern: "glm-", supportsThinking: true },
      { pattern: "GLM-4", supportsThinking: false },
    ];
    expect(thinkingForModelRules("GLM-4.6-air", rules)).toBe(true);
  });

  it("a supportsThinking:false rule gives positive evidence", () => {
    expect(thinkingForModelRules("PandoraCoder", [{ pattern: "PandoraCoder", supportsThinking: false }])).toBe(false);
  });

  it("returns undefined when nothing matches (unknown, not unsupported)", () => {
    expect(thinkingForModelRules("mystery-model", [{ pattern: "^o[34]", supportsThinking: true }])).toBeUndefined();
  });
});

describe("mergeThinkingRulesIntoFile", () => {
  it("appends missing patterns and preserves other keys/rules", () => {
    const existing = {
      version: 1,
      modelAliases: { a: "b" },
      models: [{ pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { x: 1 } } }],
    };
    const merged = mergeThinkingRulesIntoFile(existing, [{ pattern: "deepseek-r1", supportsThinking: true }]);
    expect(merged!.file.modelAliases).toEqual({ a: "b" });
    expect(merged!.added).toBe(1);
    expect(merged!.changed).toBe(0);
    expect(merged!.file.models).toEqual([
      { pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { x: 1 } } },
      { pattern: "deepseek-r1", supportsThinking: true },
    ]);
  });

  it("updates gate-only entries in place only when fields differ", () => {
    const existing = { models: [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low"] }] };
    const same = mergeThinkingRulesIntoFile(existing, [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low"] }]);
    expect(same!.added + same!.changed).toBe(0);
    const edited = mergeThinkingRulesIntoFile(existing, [{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low", "high"] }]);
    expect(edited!.changed).toBe(1);
    expect(edited!.file.models).toEqual([{ pattern: "x", supportsThinking: true, supportedReasoningLevels: ["low", "high"] }]);
    // Loader-default levels equivalence: absent array == ["low","medium","high"].
    const defaulted = mergeThinkingRulesIntoFile(
      { models: [{ pattern: "y", supportsThinking: true }] },
      [{ pattern: "y", supportsThinking: true, supportedReasoningLevels: ["low", "medium", "high"] }],
    );
    expect(defaulted!.added + defaulted!.changed).toBe(0);
  });

  it("never touches DSL-bearing entries with the same pattern (no append, no replace)", () => {
    const existing = { models: [{ pattern: "glm-", supportsThinking: true, nonThinkingRequest: { delete: ["thinking"] } }] };
    const merged = mergeThinkingRulesIntoFile(existing, [{ pattern: "glm-", supportsThinking: false }]);
    expect(merged!.added + merged!.changed).toBe(0);
    expect(merged!.file.models).toEqual(existing.models);
  });

  it("returns null for non-object existing content (caller must not write)", () => {
    expect(mergeThinkingRulesIntoFile("not json", [{ pattern: "x", supportsThinking: true }])).toBeNull();
    expect(mergeThinkingRulesIntoFile([{ a: 1 }], [{ pattern: "x", supportsThinking: true }])).toBeNull();
  });
});

describe("applyThinkingRules", () => {
  it("creates a missing file carrying the sanitized rules", () => {
    const file = path.join(tempDir, "thinking-create.json");
    const result = applyThinkingRules([{ pattern: "^o[34]", supportsThinking: true }], file);
    expect(result).toEqual({ added: 1, changed: 0, created: true });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.models).toEqual([{ pattern: "^o[34]", supportsThinking: true }]);
  });

  it("merges into an existing template-like file, preserving its rules and keys", () => {
    const file = path.join(tempDir, "thinking-merge.json");
    writeFileSync(
      file,
      JSON.stringify({ description: "tpl", version: 1, models: [{ pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { a: 1 } } }] }),
      "utf8",
    );
    const result = applyThinkingRules(
      sanitizeThinkingRules([{ pattern: "deepseek-(r1|reasoner)", supportsThinking: true }]),
      file,
    );
    expect(result).toEqual({ added: 1, changed: 0, created: false });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.description).toBe("tpl");
    expect(written.models).toEqual([
      { pattern: "glm-", supportsThinking: true, thinkingRequest: { set: { a: 1 } } },
      { pattern: "deepseek-(r1|reasoner)", supportsThinking: true },
    ]);
  });

  it("skips unparseable existing JSON without touching the file", () => {
    const file = path.join(tempDir, "thinking-corrupt.json");
    writeFileSync(file, "{not json", "utf8");
    const result = applyThinkingRules([{ pattern: "x", supportsThinking: true }], file);
    expect(result.skippedInvalid).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("is a no-op when already in sync (no write churn on repeat connects)", () => {
    const file = path.join(tempDir, "thinking-sync.json");
    const rules = [{ pattern: "x", supportsThinking: true }];
    writeFileSync(file, JSON.stringify({ models: rules }), "utf8");
    const result = applyThinkingRules(rules, file);
    expect(result).toEqual({ added: 0, changed: 0, created: false });
  });

  it("returns zeros for empty incoming (caller skips)", () => {
    expect(applyThinkingRules([], path.join(tempDir, "thinking-none.json"))).toEqual({ added: 0, changed: 0, created: false });
  });
});
