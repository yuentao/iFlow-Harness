/**
 * memory-scope-loader.cjs
 *
 * Decision layer for the memory-scope MOD: `save_memory` gains an optional
 * `scope` parameter so a fact can be written to the PROJECT memory file
 * instead of the global one.
 *
 * Background (verified in the CLI 0.5.19 fork bundle,
 * `vendor/iflow-fork/bundle/iflow.js`):
 *
 *   The built-in tool is `cA = class Eo extends Li` with
 *   `static Name = jzn.name` ("save_memory") and a single schema field
 *   `fact`. It ALWAYS writes to `Nz()`:
 *
 *     Nz() = path.join(Tn(), Xce())
 *
 *   `Tn()` is the global iFlow dir — `process.env.IFLOW_HOME` when set,
 *   otherwise `os.homedir()/.iflow` (NOT hard-coded homedir, and it does not
 *   read a project `.iflow/`). `Xce()` is the FIRST entry of the settings
 *   `contextFileName` (string or array; `Jce()`/`Xce()`/`Lz()`), defaulting to
 *   `uU = ["AGENTS.md", "IFLOW.md"]` → `AGENTS.md`. So the only writable
 *   target upstream is the global `~/.iflow/AGENTS.md`; a fact that only holds
 *   for one repository has nowhere to go and pollutes every other project.
 *
 * What this MOD changes — and what it deliberately does not:
 *
 *   - Tool NAME stays `save_memory` (the anchor REPLACES the upstream class
 *     instead of registering a second one, so there is exactly one tool).
 *   - The schema keeps `fact` (string, required, upstream wording) and adds an
 *     OPTIONAL `scope` enum `["global", "project"]`. Omitting `scope` means
 *     `global`, which is byte-for-byte the upstream behaviour — so an old
 *     prompt that never learned about `scope` keeps working unchanged.
 *   - Target selection is the ONLY branch:
 *       global  -> path.join(Tn(), contextFileName)        (upstream path)
 *       project -> path.join(config.getWorkingDir(), contextFileName)
 *     `config.getWorkingDir()` is the session cwd (`Config.getWorkingDir()`
 *     returns `this.cwd`, set from the ACP `session/new` cwd).
 *
 *   - The WRITE ITSELF is not re-implemented. The anchor hands this module the
 *     upstream tool class (`upstream`) and every append goes through
 *     `upstream.performAddMemoryEntry(fact, target, io)` — the exact function
 *     the unpatched tool calls. That is what makes the on-disk bytes identical:
 *     the `## iFlow Added Memories` header, the `- <fact>` bullet, the
 *     `Qzn()` separator rule and the "insert before the next `## ` heading"
 *     splice all stay upstream's code. Duplicating them here by hand would
 *     also duplicate a checkout-dependent detail: the rules live in template
 *     literals with literal newlines, so a Windows checkout runs them with
 *     CRLF and a POSIX checkout with LF. Delegation is immune to that.
 *     If the upstream class is missing or no longer exposes
 *     `performAddMemoryEntry`, `create()` returns null and the call site
 *     registers the ORIGINAL tool — a silent, byte-for-byte fallback.
 *
 * Safety:
 *   - `contextFileName` is read from `<global dir>/settings.json`
 *     (`contextFileName`, string or array, first non-empty entry; anything
 *     unreadable / malformed falls back to `AGENTS.md`). Reading it from the
 *     same base dir `Tn()` uses keeps the loader consistent when a harness or
 *     CI run points `IFLOW_HOME` somewhere else.
 *   - A `project` target is REJECTED when the file name is absolute or
 *     contains a `..` segment, and again when the resolved path escapes
 *     `config.getWorkingDir()`. The error text is written for the model.
 *   - The project root is expected to exist (the CLI runs there); only the
 *     file's directory is created, exactly like upstream.
 *
 * Return value: the model is told WHICH scope was written and the file NAME
 * (never the full absolute path), plus the reminder that memory is loaded at
 * `session/new` / `session/load`, so a new fact only reaches the context in a
 * new session or after a session restore.
 *
 * Kill switch: `IFLOW_MEMORY_SCOPE=0|false` makes `create()` return the
 * upstream class, restoring the original single-argument tool.
 *
 * NOTE: this module MUST NOT write to stdout — in ACP mode stdout carries the
 * NDJSON protocol stream and a stray line corrupts the wire. No console.
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const TOOL_NAME = "save_memory";
const DISPLAY_NAME = "Save Memory";
const MEMORY_MARKER = "## iFlow Added Memories";
const DEFAULT_CONTEXT_FILE = "AGENTS.md";
const ENV_SWITCH = "IFLOW_MEMORY_SCOPE";
// Bundle enum value (verified: `(function(A){A.ProceedOnce="proceed_once",
// A.ProceedAlways="proceed_always",...})(cn||(cn={}))`). Only used to decide
// whether to remember the confirmed target; an unknown value simply leaves the
// allowlist empty (one extra confirmation, never a broken flow).
const PROCEED_ALWAYS = "proceed_always";

/** `IFLOW_MEMORY_SCOPE=0|false` -> keep the upstream single-argument tool. */
function isDisabledByEnv(env) {
  const raw = (env || process.env)[ENV_SWITCH];
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false";
}

/**
 * The global iFlow dir, mirroring the bundle's `Tn()`: `IFLOW_HOME` wins,
 * otherwise `homedir()/.iflow` (tmpdir fallback when homedir is unusable).
 */
function globalBaseDir() {
  const fromEnv = process.env.IFLOW_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.normalize(fromEnv.trim());
  const home = os.homedir();
  return home ? path.join(home, ".iflow") : path.join(os.tmpdir(), ".iflow");
}

/**
 * First `contextFileName` from `<baseDir>/settings.json`, mirroring the
 * bundle's `Jce()` + `Xce()`: a string is trimmed and used as-is, an array
 * contributes its first non-empty entry, everything else (missing file,
 * unreadable file, malformed JSON, empty value) falls back to `AGENTS.md`.
 */
function readContextFileName(baseDir) {
  try {
    const text = fs.readFileSync(path.join(baseDir, "settings.json"), "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_CONTEXT_FILE;
    const value = parsed.contextFileName;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) return entry.trim();
      }
      return DEFAULT_CONTEXT_FILE;
    }
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {
    // absent / unreadable / invalid JSON -> upstream default
  }
  return DEFAULT_CONTEXT_FILE;
}

/** A context file name must be a plain relative path with no `..` segment. */
function isSafeContextFileName(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  if (path.isAbsolute(name)) return false;
  if (/^[A-Za-z]:/.test(name)) return false; // Windows drive-relative / absolute
  const segments = name.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every((s) => s !== "..");
}

/** `~`-relative (global) or cwd-relative (project) display form. */
function shortenForDisplay(target, cwd) {
  try {
    if (cwd) {
      const rel = path.relative(cwd, target);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
    }
    const home = os.homedir();
    if (home && target.startsWith(home)) return target.replace(home, "~");
  } catch {
    // fall through to the raw path
  }
  return target;
}

/** Read a file, treating "missing" as empty (upstream `readMemoryFileContent`). */
async function readTextOrEmpty(file) {
  try {
    return await fsp.readFile(file, "utf-8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

const REAL_IO = {
  readFile: fsp.readFile,
  writeFile: fsp.writeFile,
  mkdir: fsp.mkdir,
};

/**
 * Run upstream's append algorithm against an in-memory buffer, so the diff
 * preview and the real write are produced by the SAME code (no drift).
 */
async function computeNewContent(append, fact, current) {
  let buffer = current;
  const io = {
    mkdir: async () => {},
    readFile: async () => buffer,
    writeFile: async (_file, data) => {
      buffer = data;
    },
  };
  await append(fact, path.join(os.tmpdir(), "iflow-memory-preview"), io);
  return buffer;
}

/**
 * @param {{base: Function, kinds?: object, icons?: object, types?: object,
 *          upstream?: Function}} bag
 *   `base` is the tool base class (`Li`), `kinds`/`icons`/`types` the bundle
 *   enums, `upstream` the ORIGINAL `save_memory` class (`cA`) whose
 *   `performAddMemoryEntry` performs every write.
 * @returns {Function|null} the replacement tool class, the upstream class when
 *   the MOD is switched off, or null when the input is unusable (the call site
 *   then registers the upstream tool unchanged).
 */
function create(bag) {
  if (!bag || typeof bag.base !== "function") return null;
  const Base = bag.base;
  const kinds = bag.kinds || {};
  const icons = bag.icons || {};
  const types = bag.types || {};
  const upstream = typeof bag.upstream === "function" ? bag.upstream : null;

  if (isDisabledByEnv()) return upstream;

  // Without the upstream writer we cannot promise byte-identical files; decline
  // and let the call site keep the original tool.
  if (!upstream || typeof upstream.performAddMemoryEntry !== "function") return null;

  const append = (fact, target, io) => upstream.performAddMemoryEntry(fact, target, io);

  const T_OBJECT = types.OBJECT || "OBJECT";
  const T_STRING = types.STRING || "STRING";

  const DESCRIPTION =
    "Saves a specific piece of information or fact to long-term memory. Use this when the user explicitly asks " +
    "you to remember something, or when they state a clear, concise fact that seems important to retain for " +
    "future interactions. `scope` selects where the fact lands: \"global\" (default) for a personal preference " +
    "or environment fact that applies to every project, \"project\" for a fact that only holds for the current " +
    "repository.";

  const LONG_DESCRIPTION = [
    "Saves a specific piece of information or fact to long-term memory.",
    "",
    "Use this tool:",
    "",
    "- When the user explicitly asks you to remember something (e.g., \"Remember that I like pineapple on pizza\", \"Please save this: my cat's name is Whiskers\").",
    "- When the user states a clear, concise fact about themselves, their preferences, or their environment that seems important for you to retain for future interactions to provide a more personalized and effective assistance.",
    "",
    "Do NOT use this tool:",
    "",
    "- To remember conversational context that is only relevant for the current session.",
    "- To save long, complex, or rambling pieces of text. The fact should be relatively short and to the point.",
    "- If you are unsure whether the information is a fact worth remembering long-term. If in doubt, you can ask the user, \"Should I remember that for you?\"",
    "",
    "## Parameters",
    "",
    "- `fact` (string, required): The specific fact or piece of information to remember. This should be a clear, self-contained statement. For example, if the user says \"My favorite color is blue\", the fact would be \"My favorite color is blue\".",
    "- `scope` (string, optional): Where to store the fact. `global` (the default) is for personal, long-lived preferences that should follow the user across every project. `project` is for facts that are only true for the current repository (build commands, local conventions, environment quirks). Omit it to keep the historical global behaviour.",
    "",
    "## Notes",
    "",
    "- The fact is appended under the `## iFlow Added Memories` section of the memory file.",
    "- Memory is loaded when a session is created or restored, so a fact saved now becomes visible to the model in a NEW session (or after restoring this one); it is not retroactively injected into the running conversation.",
  ].join("\n");

  /**
   * Resolve the write target for a call. Returns `{scope, path, fileName, cwd}`
   * or `{error}` (a message meant for the model). `cwd` is the project root for
   * `project` scope ("" for global) and only feeds the display shortening.
   */
  function resolveTarget(rawScope, config) {
    const baseDir = globalBaseDir();
    const fileName = readContextFileName(baseDir);
    const scope = typeof rawScope === "string" && rawScope.trim().toLowerCase() === "project"
      ? "project"
      : "global";
    if (scope === "global") {
      return { scope, path: path.join(baseDir, fileName), fileName, cwd: "" };
    }
    let cwd = "";
    try {
      cwd = typeof config?.getWorkingDir === "function" ? String(config.getWorkingDir() || "") : "";
    } catch {
      cwd = "";
    }
    if (!cwd) {
      return { error: "无法确定当前项目目录（会话工作目录不可用），因此不能写入项目记忆。请改用 scope=\"global\" 或检查会话配置。" };
    }
    if (!isSafeContextFileName(fileName)) {
      return { error: `记忆文件名不合法（"${fileName}"）：项目记忆只接受不含 ".." 段、非绝对路径的相对文件名。请修正 ~/.iflow/settings.json 的 contextFileName。` };
    }
    const resolved = path.resolve(cwd, fileName);
    const rel = path.relative(cwd, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `记忆文件目标超出了当前项目目录（"${fileName}"），已拒绝写入。项目记忆只能落在当前仓库内。` };
    }
    return { scope, path: resolved, fileName, cwd };
  }

  function failure(message) {
    return {
      llmContent: JSON.stringify({ success: false, error: message }),
      returnDisplay: `Error: ${message}`,
    };
  }

  class SaveMemoryTool extends Base {
    static allowlist = new Set();
    static Name = TOOL_NAME;
    static DisplayName = DISPLAY_NAME;

    constructor(config) {
      super(
        TOOL_NAME,
        DISPLAY_NAME,
        DESCRIPTION,
        icons.LightBulb || "lightBulb",
        kinds.Edit || "edit",
        {
          type: T_OBJECT,
          properties: {
            fact: {
              type: T_STRING,
              description:
                "The specific fact or piece of information to remember. Should be a clear, self-contained statement.",
            },
            scope: {
              type: T_STRING,
              enum: ["global", "project"],
              description:
                "Where to store the fact. \"global\" (default) = a personal, long-lived preference that applies to every project. \"project\" = a fact that only holds for the current repository (build/test commands, local conventions, environment quirks).",
            },
          },
          required: ["fact"],
        },
      );
      this.config = config;
    }

    getDescription(args) {
      try {
        const target = resolveTarget(args && args.scope, this.config);
        if (target.error) return `in ${DEFAULT_CONTEXT_FILE} (invalid target)`;
        return `in ${shortenForDisplay(target.path, target.cwd)}`;
      } catch {
        return `in ${DEFAULT_CONTEXT_FILE}`;
      }
    }

    async shouldConfirmExecute(args) {
      const target = resolveTarget(args && args.scope, this.config);
      // An invalid target is reported by execute(); do not build a diff for it.
      if (target.error) return false;
      if (SaveMemoryTool.allowlist.has(target.path)) return false;
      const fact = args && args.fact;
      if (typeof fact !== "string" || fact.trim() === "") return false;
      const originalContent = await readTextOrEmpty(target.path);
      const newContent = await computeNewContent(append, fact, originalContent);
      return {
        type: "edit",
        title: `Confirm Memory Save: ${shortenForDisplay(target.path, target.cwd)}`,
        fileName: target.path,
        originalContent,
        newContent,
        onConfirm: async (choice) => {
          if (choice === PROCEED_ALWAYS) SaveMemoryTool.allowlist.add(target.path);
        },
      };
    }

    async execute(args, _abortSignal, _updateOutput) {
      const fact = args && args.fact;
      if (typeof fact !== "string" || fact.trim() === "") {
        return failure('参数 "fact" 必须是非空字符串。');
      }
      const target = resolveTarget(args && args.scope, this.config);
      if (target.error) return failure(target.error);

      try {
        if (args && args.modified_by_user && args.modified_content !== undefined) {
          await fsp.mkdir(path.dirname(target.path), { recursive: true });
          await fsp.writeFile(target.path, args.modified_content, "utf-8");
          const message = `已更新${scopeLabel(target.scope)}记忆文件 ${target.fileName}。新内容需要新会话或恢复会话后才会进入上下文。`;
          return { llmContent: JSON.stringify({ success: true, scope: target.scope, message }), returnDisplay: message };
        }

        await append(fact, target.path, REAL_IO);
        const message =
          `已保存到${scopeLabel(target.scope)}记忆（${target.fileName}）。` +
          "新事实需要新会话或恢复会话后才会进入上下文。";
        return {
          llmContent: JSON.stringify({ success: true, scope: target.scope, file: target.fileName, message }),
          returnDisplay: message,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return failure(`保存记忆失败：${detail}`);
      }
    }

    getModifyContext(args) {
      return {
        getFilePath: () => {
          const target = resolveTarget(args && args.scope, this.config);
          return target.error ? path.join(globalBaseDir(), DEFAULT_CONTEXT_FILE) : target.path;
        },
        getCurrentContent: async () => {
          const target = resolveTarget(args && args.scope, this.config);
          if (target.error) return "";
          return readTextOrEmpty(target.path);
        },
        getProposedContent: async () => {
          const target = resolveTarget(args && args.scope, this.config);
          if (target.error) return "";
          const current = await readTextOrEmpty(target.path);
          return computeNewContent(append, (args && args.fact) || "", current);
        },
        createUpdatedParams: (current, newContent, original) => ({
          ...original,
          modified_by_user: true,
          modified_content: newContent,
        }),
      };
    }
  }

  function scopeLabel(scope) {
    return scope === "project" ? "项目" : "全局";
  }

  return SaveMemoryTool;
}

module.exports = { create, MEMORY_MARKER, DEFAULT_CONTEXT_FILE, ENV_SWITCH, TOOL_NAME };