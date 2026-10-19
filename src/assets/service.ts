import { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type {
  AssetKind,
  AssetScope,
  AssetUi,
  AssetsStateUi,
  HostToWebview,
} from "../../shared/messages.js";
import {
  displayPathFor,
  isWithin,
  memoryHome,
  readIfExists,
  sha256,
  statIfExists,
  writeAtomic,
} from "../memory/files.js";

/**
 * F4 host-side manager for the CLI's user-level assets (custom slash
 * commands, subagent definitions, skills). Directory/scan semantics mirror the
 * bundle-probed loaders (CLI 0.5.19, see shared/messages.ts#AssetUi contract
 * comment): commands recursive `** /*.{md,toml}` (name = rel path minus ext,
 * ":"-joined), agents TOP-LEVEL *.md, skills one-level `<dir>/SKILL.md` with
 * global winning over project by name.
 *
 * Write discipline (same as MemoryService): every write goes through one
 * promise chain; saves echo the sha256 the card read and refuse on mismatch;
 * only paths that resolve inside the six asset roots AND match the per-kind
 * file structure are writable — the WebView never gets an arbitrary
 * absolute path accepted, and neither does createAsset (the host builds the
 * path from validated kind/scope/name).
 */

export interface AssetsServiceOptions {
  log: { info(message: string): void; warn(message: string): void };
  /** Test hook: override the hardcoded `~/.iflow` home. */
  home?: string;
  getCwd: () => string | null;
  getWorkspaceRoots: () => string[];
  post: (message: HostToWebview) => void;
}

/** createAsset name rule: kebab/underscore/digit safe, no path chars. */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COMMAND_SCAN_CAP = 200;
const COMMAND_MAX_DEPTH = 8;

/**
 * Minimal frontmatter reader for DISPLAY ONLY (description chip, agent
 * tools). Not a YAML parser: the CLI's zod validation stays authoritative,
 * and anything misread only decorates a row. Scalars keep quotes stripped;
 * `- item` continuations collect under the previous key (so both
 * `allowed-tools: Read, Edit` and the list form render).
 */
function parseFrontmatter(text: string): { meta: Record<string, string[]>; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? "";
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: {}, body: text };
  const meta: Record<string, string[]> = {};
  let currentKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const listItem = /^\s+-\s+(.*\S)\s*$/.exec(line);
    if (listItem && currentKey !== null) {
      meta[currentKey]?.push(listItem[1]!.trim());
      continue;
    }
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    currentKey = match[1]!;
    const raw = match[2]!.trim();
    const value = /^["'](.*)["']$/.exec(raw);
    meta[currentKey] = raw === "" ? [] : [value ? value[1]! : raw];
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

function firstScalar(meta: Record<string, string[]>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const values = meta[key];
    if (values && values.length > 0 && values[0]!.trim()) return values[0]!.trim();
  }
  return null;
}

/** allowed-tools/tools: comma string or YAML list; `["*"]` passes through. */
function toolsList(meta: Record<string, string[]>): string[] | null {
  for (const key of ["allowed-tools", "tools", "allowedTools"]) {
    const values = meta[key];
    if (!values) continue;
    const items = values.flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => v !== "");
    if (items.length > 0) return items;
  }
  return null;
}

/** Command .md fallback: first `#` heading as description (CLI's l2u rule). */
function headingDescription(body: string): string | null {
  for (const line of body.split("\n")) {
    const match = /^#+\s+(.*\S)\s*$/.exec(line);
    if (match) return match[1]!.trim();
  }
  return null;
}

/** .toml description = "…" (display-only regex, not a TOML parser). */
function tomlDescription(text: string): string | null {
  const match = /\bdescription\s*=\s*"([^"]*)"/.exec(text);
  if (!match) return null;
  const desc = match[1]!.trim();
  return desc === "" ? null : desc;
}

export class AssetsService {
  private disposed = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: AssetsServiceOptions) {}

  private home(): string {
    return this.options.home ?? memoryHome();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The six roots the CLI scans (probed bundle joins): global per kind +
   * project per kind hung off the session cwd (CLI projectRoot). */
  private assetRoots(): Array<{ kind: AssetKind; scope: AssetScope; dir: string }> {
    const home = this.home();
    const roots: Array<{ kind: AssetKind; scope: AssetScope; dir: string }> = [
      { kind: "command", scope: "global", dir: path.join(home, "commands") },
      { kind: "agent", scope: "global", dir: path.join(home, "agents") },
      { kind: "skill", scope: "global", dir: path.join(home, "skills") },
    ];
    const cwd = this.options.getCwd();
    if (cwd) {
      const dot = path.join(cwd, ".iflow");
      roots.push(
        { kind: "command", scope: "project", dir: path.join(dot, "commands") },
        { kind: "agent", scope: "project", dir: path.join(dot, "agents") },
        { kind: "skill", scope: "project", dir: path.join(dot, "skills") },
      );
    }
    return roots;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(action, action);
    // Keep the chain alive regardless of this task's outcome while letting
    // the caller observe the task's own result/rejection.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private postError(message: string): void {
    this.options.log.warn(message);
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private listDir(dir: string): Promise<Dirent[]> {
    return readdir(dir, { withFileTypes: true }).catch((error) => {
      if ((error as unknown as { code?: string }).code === "ENOENT") return [];
      throw error;
    });
  }

  private async buildItem(
    kind: AssetKind,
    scope: AssetScope,
    file: string,
    name: string,
  ): Promise<AssetUi> {
    const content = await readIfExists(file);
    const info = await statIfExists(file);
    const text = content ?? "";
    const { meta, body } = parseFrontmatter(text);
    const description =
      kind === "command"
        ? path.extname(file).toLowerCase() === ".toml"
          ? tomlDescription(text)
          : firstScalar(meta, ["description"]) ?? headingDescription(body)
        : firstScalar(meta, ["description"]);
    return {
      kind,
      scope,
      name,
      path: file,
      displayPath: displayPathFor(file, this.options.getWorkspaceRoots(), this.home()),
      description,
      tools: kind === "agent" ? toolsList(meta) : null,
      bytes: info?.bytes ?? Buffer.byteLength(text, "utf8"),
      updatedAt: info?.mtimeMs ?? null,
      hash: content === null ? null : sha256(content),
      editable: true,
    };
  }

  /** Commands: recursive walk, cap-bounded; name = rel path minus extension
   * with segments ":"-joined (CLI FileCommandLoader rule). Symlinked
   * directories are NOT followed (the CLI glob uses follow:true — a cyclic
   * symlink chain would loop the scan, so we stay conservative). */
  private async scanCommands(root: { kind: AssetKind; scope: AssetScope; dir: string }): Promise<AssetUi[]> {
    const items: AssetUi[] = [];
    const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root.dir, rel: "", depth: 0 }];
    while (stack.length > 0 && items.length < COMMAND_SCAN_CAP) {
      const current = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await this.listDir(current.dir);
      } catch (error) {
        this.postError(`assets scan: ${current.dir}: ${(error as Error).message}`);
        continue;
      }
      for (const entry of entries) {
        const child = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth + 1 <= COMMAND_MAX_DEPTH) {
            stack.push({ dir: child, rel: path.join(current.rel, entry.name), depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== ".md" && ext !== ".toml") continue;
        const relName = path.join(current.rel, entry.name);
        const withoutExt = relName.slice(0, relName.length - ext.length);
        const name = withoutExt
          .split(path.sep)
          .map((segment) => segment.replaceAll(":", "_"))
          .join(":");
        items.push(await this.buildItem(root.kind, root.scope, child, name));
        if (items.length >= COMMAND_SCAN_CAP) break;
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Agents: TOP-LEVEL *.md only (AgentScanner scanDirectory, non-recursive).
   * CLI skips files missing agent-type/name frontmatter — mirrored. */
  private async scanAgents(root: { kind: AssetKind; scope: AssetScope; dir: string }): Promise<AssetUi[]> {
    const entries = await this.listDir(root.dir);
    const items: AssetUi[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const file = path.join(root.dir, entry.name);
      const content = await readIfExists(file);
      if (content === null) continue;
      const { meta } = parseFrontmatter(content);
      const agentName = firstScalar(meta, ["agent-type", "name", "agentType", "Name"]);
      if (!agentName) continue; // CLI: `missing agent-type or name …` → skipped
      items.push(await this.buildItem(root.kind, root.scope, file, entry.name.slice(0, -3)));
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Skills: one level deep `<dir>/SKILL.md`; CLI requires frontmatter name
   * (missing → skipped). Global-first Map semantics: a project skill whose
   * name matches a loaded global one is NOT loaded — we list it flagged. */
  private async scanSkills(root: { kind: AssetKind; scope: AssetScope; dir: string }): Promise<AssetUi[]> {
    const entries = await this.listDir(root.dir);
    const items: AssetUi[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.dir, entry.name, "SKILL.md");
      const content = await readIfExists(skillFile);
      if (content === null) continue;
      const { meta } = parseFrontmatter(content);
      const skillName = firstScalar(meta, ["name", "Name"]);
      if (!skillName) continue; // CLI: missing 'name' → null (not loaded)
      items.push(await this.buildItem(root.kind, root.scope, skillFile, entry.name));
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scanAll(): Promise<AssetsStateUi> {
    const roots = this.assetRoots();
    const commands: AssetUi[] = [];
    const agents: AssetUi[] = [];
    const skills: AssetUi[] = [];
    for (const root of roots) {
      if (root.kind === "command") commands.push(...(await this.scanCommands(root)));
      else if (root.kind === "agent") agents.push(...(await this.scanAgents(root)));
      else skills.push(...(await this.scanSkills(root)));
    }
    const globalSkillNames = new Set(
      skills.filter((s) => s.scope === "global").map((s) => s.name),
    );
    for (const skill of skills) {
      if (skill.scope === "project" && globalSkillNames.has(skill.name)) skill.shadowed = true;
    }
    return {
      home: this.home(),
      cwd: this.options.getCwd(),
      workspaceRoots: this.options.getWorkspaceRoots(),
      commands,
      agents,
      skills,
    };
  }

  async sendState(requestId?: number): Promise<void> {
    try {
      const state = await this.scanAll();
      if (this.disposed) return;
      this.options.post({ type: "assetsState", ...(requestId !== undefined ? { requestId } : {}), state });
    } catch (error) {
      if (this.disposed) return;
      this.options.post({
        type: "assetsState",
        ...(requestId !== undefined ? { requestId } : {}),
        state: {
          home: this.home(),
          cwd: this.options.getCwd(),
          workspaceRoots: this.options.getWorkspaceRoots(),
          commands: [],
          agents: [],
          skills: [],
          error: messageOf(error),
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Path resolution (the write/read boundary)
  // -------------------------------------------------------------------------

  /** Resolve a WebView-supplied path to a writable asset target: it must sit
   * inside one of the six roots AND match that kind's file structure
   * (command .md/.toml at any depth; agent top-level .md; skill one-level
   * `<dir>/SKILL.md`). Anything else is refused — the WebView
   * never gets an arbitrary absolute path accepted. */
  private async resolveTarget(file: string): Promise<
    { kind: AssetKind; scope: AssetScope; path: string } | null
  > {
    for (const root of this.assetRoots()) {
      if (!isWithin(root.dir, file)) continue;
      const rel = path.relative(root.dir, file);
      if (!rel || rel === ".") continue;
      const ext = path.extname(file).toLowerCase();
      switch (root.kind) {
        case "command":
          if (ext === ".md" || ext === ".toml") return { kind: "command", scope: root.scope, path: file };
          continue;
        case "agent":
          if (ext === ".md" && !path.dirname(rel)) return { kind: "agent", scope: root.scope, path: file };
          continue;
        case "skill": {
          const parts = rel.split(path.sep);
          if (parts.length === 2 && parts[1]!.toUpperCase() === "SKILL.MD") {
            return { kind: "skill", scope: root.scope, path: file };
          }
          continue;
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Read / write / delete
  // -------------------------------------------------------------------------

  async readFile(file: string, requestId?: number): Promise<void> {
    const target = await this.resolveTarget(file);
    if (!target) {
      this.options.post({
        type: "assetContent",
        path: file,
        content: "",
        hash: null,
        error: vscode.l10n.t("该路径不在可编辑资产范围内（命令/子代理/技能文件）"),
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return;
    }
    try {
      const content = await readIfExists(target.path);
      this.options.post({
        type: "assetContent",
        path: target.path,
        content: content ?? "",
        hash: content === null ? null : sha256(content),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    } catch (error) {
      this.options.post({
        type: "assetContent",
        path: file,
        content: "",
        hash: null,
        error: messageOf(error),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }
  }

  async saveFile(input: {
    path: string;
    content: string;
    expectedHash?: string | null;
    requestId?: number;
  }): Promise<void> {
    const target = await this.resolveTarget(input.path);
    if (!target) {
      this.options.post({
        type: "assetSaved",
        path: input.path,
        ok: false,
        error: vscode.l10n.t("该路径不在可编辑资产范围内（命令/子代理/技能文件）"),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      return;
    }
    await this.enqueue(async () => {
      const current = await readIfExists(target.path);
      const currentHash = current === null ? null : sha256(current);
      if (input.expectedHash !== undefined && input.expectedHash !== currentHash) {
        this.options.post({
          type: "assetSaved",
          path: target.path,
          ok: false,
          conflict: true,
          error: vscode.l10n.t("文件已在磁盘上发生变化，请重新加载后再保存"),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
        return;
      }
      try {
        await writeAtomic(target.path, input.content);
        this.options.log.info(`asset saved: ${target.path} (${input.content.length} chars)`);
        this.options.post({
          type: "assetSaved",
          path: target.path,
          ok: true,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
      } catch (error) {
        this.options.post({
          type: "assetSaved",
          path: target.path,
          ok: false,
          error: messageOf(error),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
      }
    });
  }

  /** Create a new asset file. The HOST builds the path from validated
   * kind/scope/name — a client-supplied new path is never trusted. An
   * existing target returns conflict (never silently overwrites). */
  async createFile(input: {
    kind: AssetKind;
    scope: AssetScope;
    name: string;
    content: string;
    requestId?: number;
  }): Promise<void> {
    const reply = (ok: boolean, extra: Record<string, unknown>) =>
      this.options.post({
        type: "assetSaved",
        path: String(extra.path ?? ""),
        ok,
        ...(extra.error !== undefined ? { error: String(extra.error) } : {}),
        ...(extra.conflict !== undefined ? { conflict: true } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
    if (!ASSET_NAME_RE.test(input.name)) {
      reply(false, { error: vscode.l10n.t("名称仅允许字母/数字/-/_（以字母或数字开头）") });
      return;
    }
    const root = this.assetRoots().find(
      (candidate) => candidate.kind === input.kind && candidate.scope === input.scope,
    );
    if (!root) {
      reply(false, { error: vscode.l10n.t("无项目上下文（未开会话）可创建项目资产") });
      return;
    }
    const file =
      input.kind === "skill"
        ? path.join(root.dir, input.name, "SKILL.md")
        : path.join(root.dir, `${input.name}.md`);
    await this.enqueue(async () => {
      const current = await readIfExists(file);
      if (current !== null) {
        reply(false, { path: file, conflict: true, error: vscode.l10n.t("同名资产已存在，请编辑它 instead") });
        return;
      }
      try {
        await writeAtomic(file, input.content);
        this.options.log.info(`asset created: ${file} (${input.content.length} chars)`);
        reply(true, { path: file });
      } catch (error) {
        reply(false, { path: file, error: messageOf(error) });
      }
    });
  }

  async deleteFile(file: string, requestId?: number): Promise<void> {
    const target = await this.resolveTarget(file);
    if (!target) {
      this.options.post({
        type: "assetDeleted",
        path: file,
        ok: false,
        error: vscode.l10n.t("该路径不在可编辑资产范围内（命令/子代理/技能文件）"),
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return;
    }
    await this.enqueue(async () => {
      try {
        await rm(target.path);
        // Skills: drop the skill directory when it ends up empty (SKILL.md
        // was its only entry). A non-empty dir (scripts/references) stays.
        if (target.kind === "skill") {
          // Drop the skill directory only when it has become empty — a skill
          // carrying scripts/references must keep its siblings (never recurse
          // into a non-empty skill dir).
          const parent = path.dirname(target.path);
          const remaining = await readdir(parent, { withFileTypes: true }).catch(() => null);
          if (remaining && remaining.length === 0) await rm(parent, { recursive: true });
        }
        this.options.log.info(`asset deleted: ${target.path}`);
        this.options.post({
          type: "assetDeleted",
          path: target.path,
          ok: true,
          ...(requestId !== undefined ? { requestId } : {}),
        });
      } catch (error) {
        this.options.post({
          type: "assetDeleted",
          path: file,
          ok: false,
          error: messageOf(error),
          ...(requestId !== undefined ? { requestId } : {}),
        });
      }
    });
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return vscode.l10n.t("错误：{0}", text);
}
