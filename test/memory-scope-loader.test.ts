import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Guard rails for the memory-scope MOD (`memory-scope-loader.cjs`).
 *
 * The real write path is upstream's `performAddMemoryEntry`, so this test does
 * NOT re-verify the byte layout of `## iFlow Added Memories` (that lives in the
 * bundle and is covered by test/memory-files.test.ts on the host side). What is
 * verified here:
 *   - the anchor in `bundle/iflow.js` exists exactly once and registers the
 *     loader with the upstream tool class;
 *   - the loader file is present and exports `create`;
 *   - the schema keeps `fact` required and adds an optional `scope` enum;
 *   - target selection: global -> $IFLOW_HOME/<contextFileName>, project ->
 *     cwd/<contextFileName>, `..`/absolute names rejected, settings.json
 *     missing -> AGENTS.md;
 *   - `IFLOW_MEMORY_SCOPE=0` returns the upstream class, and a missing
 *     upstream writer makes `create()` decline (call site keeps the original).
 */

interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

interface ToolLike {
  schema: ToolSchema;
  execute(
    args: Record<string, unknown>,
    signal: unknown,
    update: unknown,
  ): Promise<{ llmContent: string; returnDisplay: string }>;
  shouldConfirmExecute(
    args: Record<string, unknown>,
  ): Promise<false | { type: string; fileName: string; originalContent: string; newContent: string }>;
}

interface ToolClass {
  new (config: unknown): ToolLike;
  Name: string;
}

interface Loader {
  create(bag: Record<string, unknown>): ToolClass | null;
  MEMORY_MARKER: string;
  DEFAULT_CONTEXT_FILE: string;
  ENV_SWITCH: string;
  TOOL_NAME: string;
}

const require = createRequire(import.meta.url);
const loader = require("../vendor/iflow-fork/bundle/memory-scope-loader.cjs") as Loader;

const BUNDLE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "iflow.js");
const LOADER_FILE = join(process.cwd(), "vendor", "iflow-fork", "bundle", "memory-scope-loader.cjs");

const ORIGINAL_IFLOW_HOME = process.env.IFLOW_HOME;
const ORIGINAL_SWITCH = process.env.IFLOW_MEMORY_SCOPE;

let root: string;
let globalDir: string;
let projectDir: string;

/** Minimal stand-in for the bundle's tool base class (`Li`). */
class FakeBase {
  name: string;
  description: string;
  parameterSchema: ToolSchema["parameters"];
  constructor(
    name: string,
    _displayName: string,
    description: string,
    _icon: string,
    _kind: string,
    schema: ToolSchema["parameters"],
  ) {
    this.name = name;
    this.description = description;
    this.parameterSchema = schema;
  }
  get schema(): ToolSchema {
    return { name: this.name, description: this.description, parameters: this.parameterSchema };
  }
}

/**
 * Stand-in for the upstream `save_memory` class. It only needs
 * `performAddMemoryEntry`; the append rule is the LF flavour of upstream's
 * algorithm (identical text, checkout-independent newlines).
 */
class FakeUpstream {
  static Name = "save_memory";
  static writes: string[] = [];
  static async performAddMemoryEntry(
    fact: string,
    target: string,
    io: {
      mkdir(dir: string, opts: { recursive: boolean }): Promise<unknown>;
      readFile(file: string, enc: string): Promise<string>;
      writeFile(file: string, data: string, enc: string): Promise<unknown>;
    },
  ): Promise<void> {
    FakeUpstream.writes.push(target);
    const bullet = `- ${fact.trim().replace(/^(-+\s*)+/, "").trim()}`;
    await io.mkdir(join(target, ".."), { recursive: true });
    let content = "";
    try {
      content = await io.readFile(target, "utf-8");
    } catch {
      content = "";
    }
    const marker = "## iFlow Added Memories";
    const at = content.indexOf(marker);
    if (at === -1) {
      content += `${marker}\n${bullet}\n`;
    } else {
      const start = at + marker.length;
      let end = content.indexOf("\n## ", start);
      if (end === -1) end = content.length;
      const before = content.slice(0, start).trimEnd();
      const section = `${content.slice(start, end).trimEnd()}\n${bullet}`;
      const after = content.slice(end);
      content = `${before}\n${section.trimStart()}\n${after}`.trimEnd() + "\n";
    }
    await io.writeFile(target, content, "utf-8");
  }
}

function makeTool(upstream: unknown = FakeUpstream): ToolLike {
  const cls = loader.create({
    base: FakeBase,
    kinds: { Edit: "edit" },
    icons: { LightBulb: "lightBulb" },
    types: { OBJECT: "OBJECT", STRING: "STRING" },
    upstream,
  });
  expect(cls).not.toBeNull();
  return new (cls as ToolClass)({ getWorkingDir: () => projectDir });
}

function writeSettings(value: unknown): void {
  writeFileSync(join(globalDir, "settings.json"), JSON.stringify(value), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iflow-memory-scope-"));
  globalDir = join(root, ".iflow");
  projectDir = join(root, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // The loader mirrors the bundle's `Tn()`: IFLOW_HOME wins over homedir.
  process.env.IFLOW_HOME = globalDir;
  delete process.env.IFLOW_MEMORY_SCOPE;
  FakeUpstream.writes = [];
});

afterEach(() => {
  if (ORIGINAL_IFLOW_HOME === undefined) delete process.env.IFLOW_HOME;
  else process.env.IFLOW_HOME = ORIGINAL_IFLOW_HOME;
  if (ORIGINAL_SWITCH === undefined) delete process.env.IFLOW_MEMORY_SCOPE;
  else process.env.IFLOW_MEMORY_SCOPE = ORIGINAL_SWITCH;
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("memory-scope-loader: bundle wiring", () => {
  it("registers exactly one anchor and no bare `t(cA),` remains", () => {
    const bundle = readFileSync(BUNDLE, "utf-8");
    const anchor = bundle.indexOf("./memory-scope-loader.cjs");
    expect(anchor).toBeGreaterThan(-1);
    expect(bundle.indexOf("./memory-scope-loader.cjs", anchor + 1)).toBe(-1);
    // The anchor must hand the upstream tool class in, otherwise the write path
    // cannot stay byte-identical.
    expect(bundle.slice(anchor, anchor + 400)).toContain("upstream:cA");
    // Exactly one registration site: the raw `t(cA),` must be gone.
    expect(bundle.split("t(cA),").length - 1).toBe(0);
  });

  it("ships the loader file next to the bundle", () => {
    expect(existsSync(LOADER_FILE)).toBe(true);
    const source = readFileSync(LOADER_FILE, "utf-8");
    // The kill switch must stay documented in code, not only in the docs.
    expect(source).toContain("IFLOW_MEMORY_SCOPE");
  });

  it("keeps the upstream tool name so the anchor replaces instead of duplicates", () => {
    const tool = makeTool();
    expect(tool.schema.name).toBe("save_memory");
    expect(loader.TOOL_NAME).toBe("save_memory");
  });
});

describe("memory-scope-loader: schema", () => {
  it("keeps `fact` required and adds an optional scope enum", () => {
    const { parameters } = makeTool().schema;
    expect(parameters.required).toEqual(["fact"]);
    expect(parameters.properties.fact?.type).toBe("STRING");
    expect(parameters.properties.scope?.type).toBe("STRING");
    expect(parameters.properties.scope?.enum).toEqual(["global", "project"]);
    expect(parameters.properties.scope?.description).toContain("global");
    expect(parameters.properties.scope?.description).toContain("project");
  });
});

describe("memory-scope-loader: target selection", () => {
  it("writes to the global memory file by default (no scope)", async () => {
    const result = await makeTool().execute({ fact: "likes tea" }, null, null);
    expect(result.returnDisplay).toContain("全局");
    expect(FakeUpstream.writes).toEqual([join(globalDir, "AGENTS.md")]);
    expect(readFileSync(join(globalDir, "AGENTS.md"), "utf-8")).toContain("- likes tea");
    // Never leak the absolute path into the model-facing message.
    expect(result.returnDisplay).not.toContain(globalDir);
    expect(result.llmContent).toContain('"scope":"global"');
  });

  it("writes to the project memory file for scope=project", async () => {
    const result = await makeTool().execute({ fact: "uses pnpm", scope: "project" }, null, null);
    expect(result.returnDisplay).toContain("项目");
    expect(FakeUpstream.writes).toEqual([join(projectDir, "AGENTS.md")]);
    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf-8")).toContain("- uses pnpm");
    expect(existsSync(join(globalDir, "AGENTS.md"))).toBe(false);
  });

  it("treats an unknown scope value as global (backward compatible)", async () => {
    await makeTool().execute({ fact: "x", scope: "nonsense" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(globalDir, "AGENTS.md")]);
  });

  it("follows the first contextFileName from settings.json (array form)", async () => {
    writeSettings({ contextFileName: ["PROJECT_NOTES.md", "AGENTS.md"] });
    await makeTool().execute({ fact: "note", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(projectDir, "PROJECT_NOTES.md")]);
  });

  it("follows a string contextFileName", async () => {
    writeSettings({ contextFileName: "IFLOW.md" });
    await makeTool().execute({ fact: "note" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(globalDir, "IFLOW.md")]);
  });

  it("falls back to AGENTS.md when settings.json is missing", async () => {
    expect(existsSync(join(globalDir, "settings.json"))).toBe(false);
    await makeTool().execute({ fact: "note" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(globalDir, "AGENTS.md")]);
    expect(loader.DEFAULT_CONTEXT_FILE).toBe("AGENTS.md");
  });

  it("falls back to AGENTS.md when settings.json is malformed", async () => {
    writeFileSync(join(globalDir, "settings.json"), "{ not json", "utf-8");
    await makeTool().execute({ fact: "note" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(globalDir, "AGENTS.md")]);
  });
});

describe("memory-scope-loader: project target safety", () => {
  it("rejects a contextFileName containing `..`", async () => {
    writeSettings({ contextFileName: "../escape.md" });
    const result = await makeTool().execute({ fact: "bad", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([]);
    expect(result.returnDisplay).toContain("Error");
    expect(result.llmContent).toContain('"success":false');
  });

  it("rejects an absolute contextFileName", async () => {
    writeSettings({ contextFileName: join(root, "outside.md") });
    const result = await makeTool().execute({ fact: "bad", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([]);
    expect(result.llmContent).toContain('"success":false');
  });

  it("rejects a nested relative name that escapes the project root", async () => {
    writeSettings({ contextFileName: "sub/../../outside.md" });
    const result = await makeTool().execute({ fact: "bad", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([]);
    expect(result.llmContent).toContain('"success":false');
  });

  it("allows a nested relative name that stays inside the project", async () => {
    writeSettings({ contextFileName: "docs/AGENTS.md" });
    await makeTool().execute({ fact: "ok", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([join(projectDir, "docs", "AGENTS.md")]);
  });

  it("reports an error when the working directory is unavailable", async () => {
    const cls = loader.create({
      base: FakeBase,
      kinds: { Edit: "edit" },
      icons: { LightBulb: "lightBulb" },
      types: { OBJECT: "OBJECT", STRING: "STRING" },
      upstream: FakeUpstream,
    }) as ToolClass;
    const tool = new cls({ getWorkingDir: () => "" });
    const result = await tool.execute({ fact: "x", scope: "project" }, null, null);
    expect(FakeUpstream.writes).toEqual([]);
    expect(result.llmContent).toContain('"success":false');
  });

  it("rejects an empty fact before touching the filesystem", async () => {
    const result = await makeTool().execute({ fact: "   " }, null, null);
    expect(FakeUpstream.writes).toEqual([]);
    expect(result.llmContent).toContain('"success":false');
  });
});

describe("memory-scope-loader: confirmation preview", () => {
  it("builds the preview with the same append code as the real write", async () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "# Project\n\nSome text\n", "utf-8");
    const tool = makeTool();
    const details = await tool.shouldConfirmExecute({ fact: "remember me", scope: "project" });
    expect(details).not.toBe(false);
    if (details === false) return;
    expect(details.type).toBe("edit");
    expect(details.fileName).toBe(join(projectDir, "AGENTS.md"));
    expect(details.originalContent).toBe("# Project\n\nSome text\n");
    expect(details.newContent).toContain("- remember me");
    expect(details.newContent).toContain("## iFlow Added Memories");
  });

  it("does not build a preview for an unsafe target", async () => {
    writeSettings({ contextFileName: "../escape.md" });
    const details = await makeTool().shouldConfirmExecute({ fact: "x", scope: "project" });
    expect(details).toBe(false);
  });
});

describe("memory-scope-loader: switches and fallbacks", () => {
  it("IFLOW_MEMORY_SCOPE=0 restores the upstream tool class", () => {
    process.env.IFLOW_MEMORY_SCOPE = "0";
    const cls = loader.create({
      base: FakeBase,
      kinds: {},
      icons: {},
      types: {},
      upstream: FakeUpstream,
    });
    expect(cls).toBe(FakeUpstream);
  });

  it("IFLOW_MEMORY_SCOPE=false also restores the upstream tool class", () => {
    process.env.IFLOW_MEMORY_SCOPE = "false";
    expect(
      loader.create({ base: FakeBase, kinds: {}, icons: {}, types: {}, upstream: FakeUpstream }),
    ).toBe(FakeUpstream);
  });

  it("declines when the upstream writer is unavailable so the call site keeps it", () => {
    expect(loader.create({ base: FakeBase, kinds: {}, icons: {}, types: {} })).toBeNull();
    // A class without performAddMemoryEntry is just as unusable.
    expect(
      loader.create({ base: FakeBase, kinds: {}, icons: {}, types: {}, upstream: class {} }),
    ).toBeNull();
  });

  it("declines when the base class is not a constructor", () => {
    expect(loader.create({ base: null, upstream: FakeUpstream })).toBeNull();
  });
});
