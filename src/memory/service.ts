import { readdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type {
  Block,
  HostToWebview,
  InjectedContextItem,
  KnowledgeDocUi,
  KnowledgeStateUi,
  MemoryCandidateUi,
  MemoryFileUi,
  MemoryScope,
  MemoryStateUi,
} from "../../shared/messages.js";
import { estimateTokens } from "../../shared/session-state.js";
import { discoverMemoryFiles, type DiscoveredMemoryFile } from "./discovery.js";
import { buildExtractionPrompt, parseCandidates } from "./extract.js";
import {
  appendFact,
  deleteFacts,
  isWithin,
  MEMORY_MARKER,
  memoryHome,
  parseFacts,
  readIfExists,
  resolveContextFileNames,
  sha256,
  statIfExists,
  writeAtomic,
} from "./files.js";
import {
  KNOWLEDGE_DIR,
  KNOWLEDGE_INDEX,
  buildChangedKeyExcerpts,
  buildIncrementalKnowledgePrompt,
  buildKnowledgePrompt,
  buildKnowledgeSources,
  buildWorkspaceDigest,
  buildWorkspaceTreeSummary,
  diffKnowledgeSources,
  hasKnowledgeChanges,
  parseKnowledgeManifest,
  readManagedKnowledgeImports,
  sanitizeGeneratedMarkdown,
  setManagedKnowledgeBlock,
  type KnowledgeManifest,
  type WorkspaceScan,
} from "./knowledge.js";

export interface MemoryServiceOptions {
  log: { info(message: string): void; warn(message: string): void };
  /** Test hook: override the hardcoded `~/.iflow` memory home. */
  home?: string;
  getCwd: () => string | null;
  getWorkspaceRoots: () => string[];
  /** CLI settings.json `contextFileName` (string or array). */
  getContextFileName: () => string | string[] | null;
  /** `iflow.autoMemoryCapture` at call time (VSCode configuration is truth). */
  isAutoCaptureEnabled: () => boolean;
  /** One direct endpoint completion for extraction (never the CLI agent). */
  runPrompt: (prompt: string) => Promise<string | null>;
  /** Current session id, used to drop stale extraction results. */
  getSessionId: () => string | null;
  /** Workspace scan for knowledge generation (panel uses findFiles). */
  scanWorkspace: () => Promise<WorkspaceScan>;
  /** Read one workspace file for the digest (absolute path). */
  readWorkspaceFile: (file: string) => Promise<string | null>;
  /** One direct completion for the knowledge index (longer ceiling). */
  runKnowledgePrompt: (prompt: string) => Promise<string | null>;
  /** Model name recorded in the manifest. */
  getModelName: () => string | null;
  post: (message: HostToWebview) => void;
  /** Prefer SessionStore.sendToast (assigns toastId so action clicks can
   * dismiss immediately); the direct `post` toast is the fallback. */
  sendToast?: (
    level: "info" | "warning" | "error",
    message: string,
    opts?: {
      durationMs?: number;
      sticky?: boolean;
      action?: { actionId: string; label: string };
      displayOnly?: boolean;
      persistent?: boolean;
    },
  ) => unknown;
  /** Remove a previously posted toast (host-assigned id). */
  dismissToast?: (toastId: number) => void;
  openFile: (file: string) => void;
}

export interface MemoryWriteResult {
  ok: boolean;
  path: string;
  conflict?: boolean;
  error?: string;
}

/** Minimum gap between automatic extractions (one per ~2 minutes at most). */
const EXTRACT_MIN_INTERVAL_MS = 2 * 60_000;

const PROJECT_TEMPLATE = `# 项目记忆

## 项目约定

## 已知陷阱

${MEMORY_MARKER}
`;

/**
 * F3 Phase 1 host-side memory manager. Owns file discovery, reads/writes and
 * the WebView reply contract. Kept out of panel.ts (already ~7k lines): the
 * panel only passes cwd / workspace roots / settings and forwards messages.
 *
 * Write discipline:
 *   - every write is serialized through one promise chain (a save and a
 *     quick-add cannot interleave inside one temp+rename sequence);
 *   - saveMemoryFile echoes the sha256 the card read and refuses on mismatch;
 *   - only paths discovered by the loader are writable (the WebView never
 *     supplies an arbitrary absolute path for a write).
 */
export class MemoryService {
  private disposed = false;
  private writeChain: Promise<void> = Promise.resolve();
  /** Manifest has its own chain: knowledge generation is long-running and is
   * NOT inside `enqueue`, while injection toggles (which sync source stats)
   * are. A shared manifest chain keeps read-modify-write atomic without
   * blocking memory writes for the whole model call. */
  private manifestChain: Promise<void> = Promise.resolve();
  private discovered: DiscoveredMemoryFile[] = [];
  /** path → (content hash, token estimate). Large AGENTS.md files are
   * re-tokenized only when their content actually changes. */
  private readonly tokenCache = new Map<string, { hash: string; tokens: number }>();
  private extractBusy = false;
  private lastExtractAt = 0;
  /** Candidate batch awaiting the user's review (never written automatically). */
  private pendingCandidates: { sessionId: string | null; candidates: MemoryCandidateUi[] } | null = null;
  /** Host-assigned id of the sticky candidate toast (null when absent). */
  private toastId: number | null = null;
  private knowledgeJob: string | null = null;

  constructor(private readonly options: MemoryServiceOptions) {}

  private home(): string {
    return this.options.home ?? memoryHome();
  }

  /** Session swap: drop file discovery + pending candidates + rate-limit
   * state so a fresh session can extract immediately. */
  invalidate(): void {
    this.invalidateDiscovery();
    this.pendingCandidates = null;
    this.dismissCandidateToast();
    this.lastExtractAt = 0;
  }

  /** Remove the sticky candidate toast from the webview (idempotent). */
  private dismissCandidateToast(): void {
    if (this.toastId === null) return;
    this.options.dismissToast?.(this.toastId);
    this.toastId = null;
  }

  /** Loading pill for the in-flight turn-end extraction: displayOnly (the
   * wait is not an interaction) + persistent (the WebView must not auto-drop
   * it while the model call runs). Returns the host id for the finally
   * dismissal; null on the direct-post fallback, which the WebView ages
   * normally — same shape as the candidate toast's fallback. */
  private sendExtractingToast(): number | null {
    const message = vscode.l10n.t("正在提取长期记忆候选…");
    if (this.options.sendToast) {
      const toastId = this.options.sendToast("info", message, { displayOnly: true, persistent: true });
      return typeof toastId === "number" ? toastId : null;
    }
    this.options.post({ type: "toast", level: "info", message, displayOnly: true, persistent: true });
    return null;
  }

  private clearExtractingToast(toastId: number | null): void {
    if (toastId === null) return;
    this.options.dismissToast?.(toastId);
  }

  /** File-set changed but the session did not (e.g. a project memory file was
   * just created): keep pending candidates untouched. */
  private invalidateDiscovery(): void {
    this.discovered = [];
  }

  dispose(): void {
    this.disposed = true;
    this.discovered = [];
    this.tokenCache.clear();
    this.pendingCandidates = null;
    this.dismissCandidateToast();
  }

  async sendState(requestId?: number): Promise<void> {
    try {
      const state = await this.buildState();
      if (this.disposed) return;
      this.options.post({ type: "memoryState", ...(requestId !== undefined ? { requestId } : {}), state });
    } catch (error) {
      if (this.disposed) return;
      this.options.post({
        type: "memoryState",
        ...(requestId !== undefined ? { requestId } : {}),
        state: {
          home: this.home(),
          cwd: this.options.getCwd(),
          workspaceRoots: this.options.getWorkspaceRoots(),
          files: [],
          globalPrimary: null,
          projectPrimary: null,
          error: messageOf(error),
        },
      });
    }
  }

  /**
   * Disk-side fallback for the auto-injected-context card (used when the
   * bundled CLI does not carry the acp-context-report Mod). Only files the
   * loader actually reads are returned; `memory.md` is deliberately excluded.
   */
  async injectedContextItems(): Promise<InjectedContextItem[]> {
    const files = await this.discover();
    const items: InjectedContextItem[] = [];
    for (const file of files) {
      if (!file.injected || !file.exists) continue;
      const content = await readIfExists(file.path);
      if (content === null) continue;
      if (file.role === "legacy") continue;
      items.push({
        kind: file.scope === "global" ? "memory" : "context-file",
        label:
          file.scope === "global"
            ? vscode.l10n.t("记忆（{0}）", file.displayPath)
            : path.basename(file.path),
        path: file.path,
        content,
      });
    }
    return items;
  }

  async readFile(file: string): Promise<void> {
    const target = await this.resolveTarget(file);
    if (!target) {
      this.options.post({
        type: "memoryFileContent",
        path: file,
        content: "",
        hash: null,
        error: vscode.l10n.t("该文件不在可编辑的记忆列表中"),
      });
      return;
    }
    try {
      const content = await readIfExists(target.path);
      this.options.post({
        type: "memoryFileContent",
        path: target.path,
        content: content ?? "",
        hash: content === null ? null : sha256(content),
      });
    } catch (error) {
      this.options.post({
        type: "memoryFileContent",
        path: file,
        content: "",
        hash: null,
        error: messageOf(error),
      });
    }
  }

  async saveFile(input: { path: string; content: string; expectedHash?: string | null }): Promise<void> {
    const target = await this.resolveTarget(input.path);
    if (!target) {
      this.postSaveError(input.path, vscode.l10n.t("该文件不在可编辑的记忆列表中"));
      return;
    }
    if (!target.editable) {
      this.postSaveError(input.path, vscode.l10n.t("该文件是只读的（位于工作区之外）"));
      return;
    }
    await this.enqueue(async () => {
      const current = await readIfExists(target.path);
      const currentHash = current === null ? null : sha256(current);
      if (input.expectedHash !== undefined && input.expectedHash !== currentHash) {
        const file = await this.buildFileUi(target);
        this.options.post({
          type: "memorySaved",
          path: target.path,
          ok: false,
          conflict: true,
          ...(file ? { file } : {}),
          error: vscode.l10n.t("文件已在磁盘上发生变化，请重新加载后再保存"),
        });
        return;
      }
      try {
        await writeAtomic(target.path, input.content);
        target.exists = true;
        const file = await this.buildFileUi(target);
        this.options.post({
          type: "memorySaved",
          path: target.path,
          ok: true,
          ...(file ? { file } : {}),
        });
        this.options.log.info(`memory saved: ${target.path} (${input.content.length} chars)`);
      } catch (error) {
        this.postSaveError(target.path, messageOf(error));
      }
    });
  }

  async appendFact(input: {
    scope: MemoryScope;
    fact: string;
    path?: string;
    requestId?: number;
  }): Promise<MemoryWriteResult> {
    const fact = input.fact.trim();
    if (!fact) {
      const error = vscode.l10n.t("记忆内容不能为空");
      this.postSaveError(input.path ?? "", error, input.requestId);
      return { ok: false, path: input.path ?? "", error };
    }
    const target = input.path
      ? await this.resolveTarget(input.path)
      : await this.primaryTarget(input.scope);
    if (!target) {
      const error =
        input.scope === "project"
          ? vscode.l10n.t("没有可用的项目目录，无法写入项目记忆")
          : vscode.l10n.t("没有可用的全局记忆文件");
      this.postSaveError(input.path ?? "", error, input.requestId);
      return { ok: false, path: input.path ?? "", error };
    }
    if (!target.editable) {
      const error = vscode.l10n.t("该文件是只读的（位于工作区之外）");
      this.postSaveError(target.path, error, input.requestId);
      return { ok: false, path: target.path, error };
    }
    return this.enqueue(async () => {
      try {
        const current = (await readIfExists(target.path)) ?? "";
        const next = appendFact(current, fact);
        await writeAtomic(target.path, next);
        target.exists = true;
        const file = await this.buildFileUi(target);
        this.options.post({
          type: "memorySaved",
          path: target.path,
          ok: true,
          ...(file ? { file } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
        this.options.log.info(`memory fact appended: ${target.path}`);
        return { ok: true, path: target.path };
      } catch (error) {
        const message = messageOf(error);
        this.postSaveError(target.path, message, input.requestId);
        return { ok: false, path: target.path, error: message };
      }
    });
  }

  async deleteFacts(input: { path: string; factIds: readonly string[] }): Promise<void> {
    const target = await this.resolveTarget(input.path);
    if (!target || !target.editable) {
      this.postSaveError(input.path, vscode.l10n.t("该文件不可编辑"));
      return;
    }
    await this.enqueue(async () => {
      try {
        const current = (await readIfExists(target.path)) ?? "";
        const next = deleteFacts(current, input.factIds);
        if (next !== current) await writeAtomic(target.path, next);
        const file = await this.buildFileUi(target);
        this.options.post({
          type: "memorySaved",
          path: target.path,
          ok: true,
          ...(file ? { file } : {}),
        });
      } catch (error) {
        this.postSaveError(target.path, messageOf(error));
      }
    });
  }

  async createProjectMemory(fileName: "AGENTS.md" | "IFLOW.md"): Promise<void> {
    if (fileName !== "AGENTS.md" && fileName !== "IFLOW.md") return;
    const cwd = this.options.getCwd() ?? this.options.getWorkspaceRoots()[0] ?? null;
    if (!cwd) {
      this.postSaveError("", vscode.l10n.t("没有打开的工作区，无法创建项目记忆"));
      return;
    }
    const target = path.join(cwd, fileName);
    await this.enqueue(async () => {
      try {
        const existing = await readIfExists(target);
        if (existing === null) {
          await writeAtomic(target, PROJECT_TEMPLATE);
          this.options.log.info(`project memory created: ${target}`);
        }
        this.invalidateDiscovery();
        await this.sendState();
      } catch (error) {
        this.postSaveError(target, messageOf(error));
      }
    });
  }

  async openFile(file: string): Promise<void> {
    const target = await this.resolveTarget(file);
    if (!target) return;
    this.options.openFile(target.path);
  }

  /**
   * Turn-end auto-extraction. Gated by `iflow.autoMemoryCapture`, a 2-minute
   * interval, a single in-flight extraction, and the originating session id
   * (a session switch drops the result). The model output is parsed strictly
   * and only stored as pending candidates — nothing is written until the user
   * confirms in the review dialog.
   */
  async maybeExtract(sessionId: string, blocks: readonly Block[]): Promise<void> {
    if (this.disposed || this.extractBusy) return;
    if (!this.options.isAutoCaptureEnabled()) return;
    if (this.options.getSessionId() !== sessionId) return;
    if (Date.now() - this.lastExtractAt < EXTRACT_MIN_INTERVAL_MS) return;
    if (!blocks.some((block) => block.kind === "text" || block.kind === "user")) return;
    this.extractBusy = true;
    this.lastExtractAt = Date.now();
    const extractingToastId = this.sendExtractingToast();
    try {
      const existing = await this.collectExistingFacts();
      const prompt = buildExtractionPrompt(blocks, existing, { maxInputChars: 6_000 });
      const raw = await this.options.runPrompt(prompt);
      if (!raw || this.disposed || this.options.getSessionId() !== sessionId) return;
      const allowProject = Boolean(this.options.getCwd() ?? this.options.getWorkspaceRoots()[0]);
      const candidates = parseCandidates(raw, { existingFacts: existing, allowProject });
      if (candidates.length === 0) {
        this.options.log.info("memory extraction produced no candidates");
        return;
      }
      this.pendingCandidates = { sessionId, candidates };
      const message = vscode.l10n.t("发现 {0} 条可记忆内容，是否追加到记忆？", candidates.length);
      const action = { actionId: "memory-review", label: vscode.l10n.t("追加记忆") };
      this.dismissCandidateToast();
      if (this.options.sendToast) {
        const toastId = this.options.sendToast("info", message, { sticky: true, action });
        if (typeof toastId === "number") this.toastId = toastId;
      } else {
        this.options.post({ type: "toast", level: "info", message, sticky: true, action });
      }
      this.options.log.info(`memory extraction: ${candidates.length} candidates`);
    } catch (error) {
      this.options.log.warn(`memory extraction failed: ${messageOf(error)}`);
    } finally {
      this.extractBusy = false;
      this.clearExtractingToast(extractingToastId);
    }
  }

  /** Toast action: show the pending candidate batch in the review dialog. */
  reviewCandidates(): void {
    const pending = this.pendingCandidates;
    if (!pending) return;
    const current = this.options.getSessionId();
    if (pending.sessionId && current !== pending.sessionId) {
      this.pendingCandidates = null;
      this.dismissCandidateToast();
      return;
    }
    this.options.post({
      type: "memoryCandidates",
      sessionId: pending.sessionId,
      candidates: pending.candidates,
    });
  }

  /** Review dialog save: write every selected candidate, then refresh state. */
  async applyCandidates(
    candidates: readonly MemoryCandidateUi[],
    sessionId: string | null,
  ): Promise<void> {
    if (this.pendingCandidates?.sessionId && sessionId !== this.pendingCandidates.sessionId) {
      this.pendingCandidates = null;
      this.options.post({
        type: "toast",
        level: "warning",
        message: vscode.l10n.t("会话已切换，记忆候选已丢弃"),
      });
      return;
    }
    const valid = candidates.filter(
      (candidate) =>
        typeof candidate?.text === "string" &&
        candidate.text.trim().length >= 5 &&
        candidate.text.trim().length <= 300 &&
        (candidate.scope === "global" || candidate.scope === "project"),
    );
    if (valid.length === 0) {
      this.pendingCandidates = null;
      return;
    }
    let saved = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const candidate of valid) {
      const result = await this.appendFact({
        scope: candidate.scope,
        fact: candidate.text,
      });
      if (result.ok) saved++;
      else {
        failed++;
        firstError ??= result.error;
      }
    }
    this.pendingCandidates = null;
    if (saved > 0) {
      this.options.post({
        type: "toast",
        level: failed > 0 ? "warning" : "info",
        message:
          failed > 0
            ? vscode.l10n.t("已添加 {0} 条记忆，{1} 条失败：{2}", saved, failed, firstError ?? "")
            : vscode.l10n.t("已添加 {0} 条记忆（新会话生效）", saved),
      });
    } else {
      this.options.post({
        type: "toast",
        level: "warning",
        message: vscode.l10n.t("记忆写入失败：{0}", firstError ?? ""),
      });
    }
    await this.sendState();
  }

  dismissCandidates(_sessionId: string | null): void {
    this.pendingCandidates = null;
    this.toastId = null;
  }

  private async collectExistingFacts(): Promise<string[]> {
    const files = await this.discover();
    const facts: string[] = [];
    for (const file of files) {
      if (!file.exists) continue;
      const content = await readIfExists(file.path);
      if (!content) continue;
      for (const fact of parseFacts(content)) facts.push(fact.text);
      if (facts.length >= 60) break;
    }
    return facts.slice(0, 60);
  }

  // --- F3 Phase 3: project knowledge -----------------------------------------

  private projectRoot(): string | null {
    const cwd = this.options.getCwd();
    const roots = this.options.getWorkspaceRoots().map((root) => path.resolve(root));
    if (cwd) {
      const containing = roots.find((root) => isWithin(root, cwd));
      return path.resolve(containing ?? cwd);
    }
    return roots[0] ?? null;
  }

  /** The file the CLI's `contextFileName` setting designates for a new project
   * memory. Never hardcode AGENTS.md: a custom contextFileName (CLAUDE.md,
   * .iflow/INSTRUCTIONS.md, …) would otherwise be silently ignored by the CLI. */
  private defaultProjectMemoryFile(root: string): string {
    const names = resolveContextFileNames(this.options.getContextFileName());
    return path.join(root, names[0] ?? "AGENTS.md");
  }

  private pathKey(file: string): string {
    const normalized = path.normalize(path.resolve(file));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  /** Every project memory file the CLI will load: primary, additional
   * ancestors and recursively discovered hierarchy files. */
  private async projectMemoryFiles(root: string): Promise<string[]> {
    const files = await this.discover();
    const paths = new Map<string, string>();
    for (const file of files) {
      if (file.scope !== "project" || !file.exists || !file.editable) continue;
      paths.set(this.pathKey(file.path), file.path);
    }
    const fallback = this.defaultProjectMemoryFile(root);
    if ((await readIfExists(fallback)) !== null) {
      paths.set(this.pathKey(fallback), fallback);
    }
    return [...paths.values()];
  }

  private async findExistingPrimaryMemory(root: string): Promise<string | null> {
    const files = await this.discover();
    const primary = files.find(
      (file) => file.scope === "project" && file.role === "primary" && file.exists && file.editable,
    );
    if (primary) return primary.path;
    const fallback = this.defaultProjectMemoryFile(root);
    return (await readIfExists(fallback)) === null ? null : fallback;
  }

  private async memoryFileForKnowledge(root: string): Promise<string> {
    const existing = await this.findExistingPrimaryMemory(root);
    if (existing) return existing;
    const target = this.defaultProjectMemoryFile(root);
    if ((await readIfExists(target)) === null) await writeAtomic(target, "# 项目记忆\n\n");
    return target;
  }

  private importPathFor(memoryFile: string, docPath: string): string {
    const rel = path.relative(path.dirname(memoryFile), docPath).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  private normalizeImport(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  }

  /** @imports resolve relative to the MEMORY FILE's directory. A workspace-
   * relative spelling is only valid when that file sits at the workspace root;
   * accepting it everywhere would mark a nested file's broken import as live. */
  private knowledgeImportMatches(
    memoryFile: string,
    docPath: string,
    root: string,
    imports: ReadonlySet<string>,
  ): boolean {
    if (imports.has(this.normalizeImport(this.importPathFor(memoryFile, docPath)))) return true;
    if (this.pathKey(path.dirname(memoryFile)) === this.pathKey(root)) {
      return imports.has(this.normalizeImport(path.relative(root, docPath)));
    }
    return false;
  }

  async generateKnowledge(
    jobId: string,
    mode: "incremental" | "full" = "incremental",
  ): Promise<void> {
    if (this.disposed) return;
    if (this.knowledgeJob) {
      this.postKnowledgeJob(jobId, "error", vscode.l10n.t("已有知识生成任务进行中"));
      return;
    }
    const root = this.projectRoot();
    if (!root) {
      this.postKnowledgeJob(jobId, "error", vscode.l10n.t("没有打开的工作区，无法生成项目知识"));
      return;
    }
    this.knowledgeJob = jobId;
    try {
      this.postKnowledgeJob(jobId, "scanning");
      const scan = await this.options.scanWorkspace();
      const files = scan.files;
      const truncated = scan.truncated === true;
      if (files.length === 0) throw new Error(vscode.l10n.t("工作区中没有可分析的文件"));
      const sources = buildKnowledgeSources(files);
      const dir = path.join(root, KNOWLEDGE_DIR);
      const indexPath = path.join(dir, KNOWLEDGE_INDEX);
      const manifestPath = path.join(dir, "manifest.json");
      const previousManifest = parseKnowledgeManifest(await readIfExists(manifestPath));
      const previousIndex = await readIfExists(indexPath);
      const previousDoc = previousManifest?.docs.find((doc) => doc.path === KNOWLEDGE_INDEX);
      const previousIndexHash = previousIndex === null ? null : sha256(previousIndex);
      const abortMessage = vscode.l10n.t(
        "知识索引缺少有效清单或已被手动修改，请点击「全量重建」确认覆盖",
      );
      let baselineAbort = false;
      let forceFullNotice: string | null = null;
      if (mode === "incremental") {
        if (previousIndex !== null) {
          if (previousManifest === null) {
            // An index without a manifest may be user-created; never overwrite
            // it from the incremental path.
            baselineAbort = true;
          } else if (previousManifest.version < 2) {
            if (previousDoc !== undefined && previousDoc.hash === previousIndexHash) {
              forceFullNotice = vscode.l10n.t("升级知识清单，执行一次全量生成");
            } else {
              baselineAbort = true;
            }
          } else if (
            previousDoc === undefined ||
            previousDoc.hash !== previousIndexHash ||
            previousManifest.sources.length === 0
          ) {
            // v2 manifest but index hash drifted (manual edit) or the snapshot
            // is incomplete: require an explicit full rebuild.
            baselineAbort = true;
          } else if (previousManifest.truncated) {
            forceFullNotice = vscode.l10n.t("上次扫描未完整，改为全量生成");
          }
        } else {
          forceFullNotice = vscode.l10n.t("没有可用的增量基线，改为全量生成");
        }
        if (truncated && !baselineAbort) {
          forceFullNotice = vscode.l10n.t("工作区文件超过扫描上限，已改为全量生成");
        }
      }

      if (baselineAbort) {
        this.postKnowledgeJob(jobId, "error", abortMessage);
        this.options.post({ type: "toast", level: "warning", message: abortMessage });
        this.knowledgeJob = null;
        await this.sendState();
        return;
      }
      if (forceFullNotice) {
        this.options.post({ type: "toast", level: "info", message: forceFullNotice });
      }

      const canIncremental =
        mode === "incremental" &&
        !truncated &&
        !baselineAbort &&
        !forceFullNotice &&
        previousManifest !== null &&
        previousManifest.version >= 2 &&
        previousManifest.sources.length > 0 &&
        previousIndex !== null &&
        previousDoc !== undefined &&
        previousDoc.hash === previousIndexHash;

      let markdown: string | null = null;
      let usedMode: "full" | "incremental" = "full";
      let fallbackNotice: string | null = null;

      if (canIncremental && previousManifest && previousIndex) {
        const change = diffKnowledgeSources(previousManifest.sources, sources);
        if (!hasKnowledgeChanges(change)) {
          // Pure no-op: do not re-add an import the user deliberately removed
          // via 「取消注入」; that toggle is the explicit repair path.
          this.postKnowledgeJob(jobId, "done", vscode.l10n.t("知识库已是最新"));
          this.knowledgeJob = null;
          this.options.post({
            type: "toast",
            level: "info",
            message: vscode.l10n.t("知识库已是最新，无需更新"),
          });
          await this.sendState();
          return;
        }
        this.postKnowledgeJob(
          jobId,
          "summarizing",
          vscode.l10n.t("检测到 {0} 个文件变化", change.added.length + change.modified.length + change.deleted.length),
        );
        const tree = buildWorkspaceTreeSummary(files);
        const excerpts = await buildChangedKeyExcerpts(
          files,
          change,
          (file) => this.options.readWorkspaceFile(file),
        );
        const raw = await this.options.runKnowledgePrompt(
          buildIncrementalKnowledgePrompt(previousIndex, change, tree, excerpts),
        );
        if (raw && raw.trim().length >= 200 && raw.includes("##")) {
          markdown = sanitizeGeneratedMarkdown(raw);
          usedMode = "incremental";
        } else {
          this.options.log.warn("incremental knowledge output invalid — falling back to full generation");
          fallbackNotice = vscode.l10n.t("增量刷新失败，回退全量生成…");
          this.postKnowledgeJob(jobId, "summarizing", fallbackNotice);
        }
      }

      if (!markdown) {
        const digest = await buildWorkspaceDigest(
          files,
          (file) => this.options.readWorkspaceFile(file),
          { truncated },
        );
        if (this.disposed) return;
        this.postKnowledgeJob(jobId, "summarizing", fallbackNotice ?? undefined);
        const raw = await this.options.runKnowledgePrompt(buildKnowledgePrompt(digest));
        if (!raw) throw new Error(vscode.l10n.t("模型未返回知识索引"));
        markdown = sanitizeGeneratedMarkdown(raw);
        usedMode = "full";
      }

      if (this.disposed) return;
      this.postKnowledgeJob(jobId, "writing");
      await writeAtomic(indexPath, markdown);
      // Write the import BEFORE the manifest so its own mtime lands in the
      // snapshot; otherwise the next incremental refresh always sees the
      // memory file as modified (self-trigger).
      const importedFile = await this.ensureKnowledgeImport(root, indexPath);
      if (importedFile) {
        const info = await statIfExists(importedFile);
        const rel = this.sourceRel(root, importedFile);
        if (info && rel) {
          const existing = sources.findIndex((source) => source.rel === rel);
          const entry = { rel, size: info.bytes, mtimeMs: info.mtimeMs };
          if (existing >= 0) sources[existing] = entry;
          else sources.push(entry);
          sources.sort((a, b) => a.rel.localeCompare(b.rel));
        }
      }
      const hash = sha256(markdown);
      const tokens = estimateTokens(markdown);
      const manifest: KnowledgeManifest = {
        version: 2,
        generatedAt: new Date().toISOString(),
        model: this.options.getModelName(),
        mode: usedMode,
        docs: [{ path: KNOWLEDGE_INDEX, hash, tokens }],
        sources,
        ...(truncated ? { truncated: true } : {}),
      };
      await this.enqueueManifest(async () => {
        await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      });
      this.invalidateDiscovery();
      this.postKnowledgeJob(jobId, "done");
      // Clear BEFORE the state push: knowledgeState derives `generating` from
      // this field, and a stale true would re-lock the success UI forever.
      this.knowledgeJob = null;
      this.options.post({
        type: "toast",
        level: "info",
        message:
          usedMode === "incremental"
            ? vscode.l10n.t("项目知识已增量更新（{0} tokens）", tokens)
            : vscode.l10n.t("项目知识已生成（{0} tokens）", tokens),
      });
      this.options.log.info(`knowledge ${usedMode}: ${indexPath} (${tokens} tokens)`);
      await this.sendState();
    } catch (error) {
      if (this.disposed) return;
      const message = messageOf(error);
      this.options.log.warn(`knowledge generation failed: ${message}`);
      this.postKnowledgeJob(jobId, "error", message);
      this.options.post({
        type: "toast",
        level: "warning",
        message: vscode.l10n.t("项目知识生成失败：{0}", message),
      });
      this.knowledgeJob = null;
      await this.sendState();
    } finally {
      this.knowledgeJob = null;
    }
  }

  async setKnowledgeInjection(docPath: string, injected: boolean): Promise<void> {
    const root = this.projectRoot();
    if (!root) {
      await this.sendState();
      return;
    }
    const dir = path.join(root, KNOWLEDGE_DIR);
    const resolved = path.resolve(docPath);
    if (!isWithin(dir, resolved) || !resolved.endsWith(".md")) {
      this.options.post({
        type: "toast",
        level: "warning",
        message: vscode.l10n.t("该文件不在项目知识目录中"),
      });
      await this.sendState();
      return;
    }
    if (injected && (await readIfExists(resolved)) === null) {
      this.options.post({
        type: "toast",
        level: "warning",
        message: vscode.l10n.t("知识文件不存在，请先重新生成"),
      });
      await this.sendState();
      return;
    }
    await this.enqueue(async () => {
      try {
        const memoryFiles = await this.projectMemoryFiles(root);
        const changedPaths: string[] = [];
        if (injected) {
          for (const memoryFile of memoryFiles) {
            const content = (await readIfExists(memoryFile)) ?? "";
            const imports = new Set(
              readManagedKnowledgeImports(content).map((imp) => this.normalizeImport(imp)),
            );
            if (this.knowledgeImportMatches(memoryFile, resolved, root, imports)) {
              await this.sendState();
              return;
            }
          }
          const memoryFile = await this.memoryFileForKnowledge(root);
          const current = (await readIfExists(memoryFile)) ?? "";
          const target = this.importPathFor(memoryFile, resolved);
          const imports = readManagedKnowledgeImports(current);
          if (!imports.some((imp) => this.normalizeImport(imp) === this.normalizeImport(target))) {
            imports.push(target);
          }
          await writeAtomic(memoryFile, setManagedKnowledgeBlock(current, imports));
          changedPaths.push(memoryFile);
        } else {
          let changed = false;
          for (const memoryFile of memoryFiles) {
            const current = (await readIfExists(memoryFile)) ?? "";
            const target = this.normalizeImport(this.importPathFor(memoryFile, resolved));
            const imports = readManagedKnowledgeImports(current);
            const isRootMemory = this.pathKey(path.dirname(memoryFile)) === this.pathKey(root);
            const workspaceRelative = this.normalizeImport(path.relative(root, resolved));
            const next = imports.filter((imp) => {
              const normalized = this.normalizeImport(imp);
              return (
                normalized !== target &&
                !(isRootMemory && normalized === workspaceRelative)
              );
            });
            if (next.length !== imports.length) {
              await writeAtomic(memoryFile, setManagedKnowledgeBlock(current, next));
              changedPaths.push(memoryFile);
              changed = true;
            }
          }
          if (!changed) {
            await this.sendState();
            return;
          }
        }
        await this.syncManifestSources(root, changedPaths);
        this.invalidateDiscovery();
        await this.sendState();
        this.options.post({
          type: "toast",
          level: "info",
          message: injected
            ? vscode.l10n.t("已注入项目知识（新会话生效）")
            : vscode.l10n.t("已取消项目知识注入"),
        });
      } catch (error) {
        this.options.post({
          type: "toast",
          level: "warning",
          message: vscode.l10n.t("更新知识注入失败：{0}", messageOf(error)),
        });
        await this.sendState();
      }
    });
  }

  async openKnowledgeFile(file: string): Promise<void> {
    const root = this.projectRoot();
    if (!root) return;
    const dir = path.join(root, KNOWLEDGE_DIR);
    const resolved = path.resolve(file);
    if (!isWithin(dir, resolved)) return;
    this.options.openFile(resolved);
  }

  private async knowledgeState(): Promise<KnowledgeStateUi> {
    const root = this.projectRoot();
    if (!root) {
      return { dir: "", index: null, docs: [], managedBy: null, injectedTokens: 0 };
    }
    const dir = path.join(root, KNOWLEDGE_DIR);
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    } catch {
      /* no knowledge yet */
    }
    const manifest = parseKnowledgeManifest(
      await readIfExists(path.join(dir, "manifest.json")),
    );
    const memoryFiles = await this.projectMemoryFiles(root);
    const importSets = new Map<string, Set<string>>();
    for (const memoryFile of memoryFiles) {
      const content = (await readIfExists(memoryFile)) ?? "";
      importSets.set(
        this.pathKey(memoryFile),
        new Set(readManagedKnowledgeImports(content).map((imp) => this.normalizeImport(imp))),
      );
    }
    const primary = await this.findExistingPrimaryMemory(root);
    const docs: KnowledgeDocUi[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const [content, info] = await Promise.all([readIfExists(file), statIfExists(file)]);
      if (content === null) continue;
      const relFromRoot = path.relative(root, file).replace(/\\/g, "/");
      const injected = memoryFiles.some((memoryFile) => {
        const imports = importSets.get(this.pathKey(memoryFile));
        if (!imports) return false;
        return this.knowledgeImportMatches(memoryFile, file, root, imports);
      });
      const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
      docs.push({
        path: file,
        displayPath: relFromRoot,
        title: heading || name.replace(/\.md$/i, ""),
        injected,
        bytes: Buffer.byteLength(content, "utf8"),
        tokens: estimateTokens(content),
        updatedAt: info?.mtimeMs ?? null,
        hash: sha256(content),
      });
    }
    const isIndex = (doc: KnowledgeDocUi): boolean => path.basename(doc.path) === KNOWLEDGE_INDEX;
    docs.sort((a, b) => {
      const ai = isIndex(a) ? 0 : 1;
      const bi = isIndex(b) ? 0 : 1;
      return ai - bi || a.displayPath.localeCompare(b.displayPath);
    });
    const managedBy =
      memoryFiles.find((file) => (importSets.get(this.pathKey(file))?.size ?? 0) > 0) ?? primary ?? null;
    return {
      dir,
      index: docs.find(isIndex) ?? null,
      docs,
      managedBy,
      injectedTokens: docs.filter((doc) => doc.injected).reduce((sum, doc) => sum + doc.tokens, 0),
      generating: Boolean(this.knowledgeJob),
      ...(manifest
        ? {
            manifest: {
              generatedAt: manifest.generatedAt,
              mode: manifest.mode,
              sourceCount: manifest.sources.length,
              ...(manifest.truncated ? { truncated: true } : {}),
            },
          }
        : {}),
    };
  }

  /** Returns the memory file it wrote, or null when the import already exists. */
  private async ensureKnowledgeImport(root: string, docPath: string): Promise<string | null> {
    const existingFiles = await this.projectMemoryFiles(root);
    for (const memoryFile of existingFiles) {
      const content = (await readIfExists(memoryFile)) ?? "";
      const imports = new Set(
        readManagedKnowledgeImports(content).map((imp) => this.normalizeImport(imp)),
      );
      if (this.knowledgeImportMatches(memoryFile, docPath, root, imports)) return null;
    }
    const memoryFile = await this.memoryFileForKnowledge(root);
    const current = (await readIfExists(memoryFile)) ?? "";
    const imports = readManagedKnowledgeImports(current);
    const target = this.importPathFor(memoryFile, docPath);
    if (!imports.some((imp) => this.normalizeImport(imp) === this.normalizeImport(target))) {
      imports.push(target);
    }
    await writeAtomic(memoryFile, setManagedKnowledgeBlock(current, imports));
    return memoryFile;
  }

  /** Keep the manifest's source fingerprints in sync after our own writes to
   * project memory files: otherwise the next incremental refresh always sees
   * AGENTS.md/IFLOW.md as modified (self-trigger). */
  /** A source path is only trackable when the workspace scan actually sees it;
   * `.iflow/` is excluded from the scan, so a custom contextFileName inside it
   * must not be added (it would look deleted on every refresh). */
  private sourceRel(root: string, file: string): string | null {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || rel.startsWith(".iflow/")) return null;
    return rel;
  }

  private async syncManifestSources(root: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.enqueueManifest(async () => {
      const dir = path.join(root, KNOWLEDGE_DIR);
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = parseKnowledgeManifest(await readIfExists(manifestPath));
      if (!manifest || manifest.version < 2) return;
      const byRel = new Map(manifest.sources.map((source) => [source.rel, source]));
      for (const file of paths) {
        const info = await statIfExists(file);
        const rel = this.sourceRel(root, file);
        if (!info || !rel) continue;
        byRel.set(rel, { rel, size: info.bytes, mtimeMs: info.mtimeMs });
      }
      manifest.sources = [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
  }

  private postKnowledgeJob(
    jobId: string,
    stage: "scanning" | "summarizing" | "writing" | "done" | "error",
    message?: string,
  ): void {
    this.options.post({
      type: "knowledgeJob",
      jobId,
      stage,
      ...(message ? { message } : {}),
    });
  }

  private async buildState(): Promise<MemoryStateUi> {
    const files = await this.discover();
    const ui = (
      await Promise.all(
        files.map(async (file) => {
          if (!file.exists) return this.placeholderUi(file);
          return (await this.buildFileUi(file)) ?? this.placeholderUi(file);
        }),
      )
    ).filter((file): file is MemoryFileUi => file !== null);
    const globalPrimary = ui.find((f) => f.scope === "global" && f.role === "primary")?.path ?? null;
    const projectPrimary = ui.find((f) => f.scope === "project" && f.role === "primary")?.path ?? null;
    return {
      home: this.home(),
      cwd: this.options.getCwd(),
      workspaceRoots: this.options.getWorkspaceRoots(),
      files: ui,
      globalPrimary,
      projectPrimary,
      knowledge: await this.knowledgeState(),
    };
  }

  private async discover(): Promise<DiscoveredMemoryFile[]> {
    if (this.discovered.length > 0) return this.discovered;
    this.discovered = await discoverMemoryFiles({
      cwd: this.options.getCwd(),
      workspaceRoots: this.options.getWorkspaceRoots(),
      contextFileName: this.options.getContextFileName(),
      ...(this.options.home ? { home: this.options.home } : {}),
    });
    return this.discovered;
  }

  private async buildFileUi(file: DiscoveredMemoryFile): Promise<MemoryFileUi | null> {
    if (!file.exists) return this.placeholderUi(file);
    const [content, info] = await Promise.all([readIfExists(file.path), statIfExists(file.path)]);
    if (content === null) return this.placeholderUi(file);
    const hash = sha256(content);
    const cached = this.tokenCache.get(file.path);
    const tokens = cached?.hash === hash ? cached.tokens : estimateTokens(content);
    if (cached?.hash !== hash) this.tokenCache.set(file.path, { hash, tokens });
    return {
      path: file.path,
      displayPath: file.displayPath,
      scope: file.scope,
      role: file.role,
      exists: true,
      editable: file.editable,
      injected: file.injected,
      bytes: Buffer.byteLength(content, "utf8"),
      tokens,
      updatedAt: info?.mtimeMs ?? null,
      hash,
      facts: parseFacts(content).map((fact) => ({ id: fact.id, text: fact.text })),
    };
  }

  private placeholderUi(file: DiscoveredMemoryFile): MemoryFileUi {
    return {
      path: file.path,
      displayPath: file.displayPath,
      scope: file.scope,
      role: file.role,
      exists: false,
      editable: file.editable,
      injected: false,
      bytes: 0,
      tokens: 0,
      updatedAt: null,
      hash: null,
      facts: [],
    };
  }

  private async resolveTarget(file: string): Promise<DiscoveredMemoryFile | null> {
    const resolved = path.resolve(file);
    const files = await this.discover();
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return (
      files.find((entry) => {
        const p = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
        return p === key;
      }) ?? null
    );
  }

  private async primaryTarget(scope: MemoryScope): Promise<DiscoveredMemoryFile | null> {
    const files = await this.discover();
    if (scope === "global") {
      return files.find((f) => f.scope === "global" && f.role === "primary") ?? null;
    }
    return files.find((f) => f.scope === "project" && f.role === "primary") ?? null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    // Keep the chain alive regardless of this task's outcome while letting the
    // caller observe the task's own result/rejection.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueueManifest<T>(task: () => Promise<T>): Promise<T> {
    const run = this.manifestChain.then(task, task);
    this.manifestChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private postSaveError(file: string, error: string, requestId?: number): void {
    this.options.post({
      type: "memorySaved",
      path: file,
      ok: false,
      error,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exposed for tests: the exact template written by createProjectMemory. */
export const PROJECT_MEMORY_TEMPLATE = PROJECT_TEMPLATE;
