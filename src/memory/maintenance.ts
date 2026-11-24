import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MemoryScope } from "../../shared/messages.js";
import {
  applyCurationPlan,
  estimateMarkdownTokens,
  parseManagedFacts,
  planCuration,
  type CurationAction,
  type CurationPlan,
} from "../../shared/memory-curate.js";
import {
  suggestionsToActions,
  type MergeSuggestion,
  type RejectedMerge,
} from "./curate-llm.js";
import { createBackup } from "./backup.js";
import {
  factFingerprint as metaFactFingerprint,
  loadMeta,
  maintenanceDir,
  pruneMeta,
  saveMeta,
  touchFact,
  type MemoryMaintenanceMeta,
} from "./maintenance-meta.js";

/**
 * 记忆整理编排核心。
 *
 * 职责边界：
 *  - 本文件只做「读 → 规划 → 备份 → 写 → 记账」的编排，具体 I/O 全部通过
 *    `MaintenanceDeps` 注入 —— 这样调度器 / 测试可以给一份假实现，不需要 VSCode、
 *    不需要真实文件系统（备份、meta、events 仍然落在 `deps.home` 下）。
 *  - 纯逻辑（解析、去重、归档、token 估算、调度判定）在 `shared/memory-curate.ts`，
 *    这里不重复实现，只负责把文件内容喂进去、把结果写回去。
 *  - 任何单个文件的失败都不影响其它文件：读失败 / 写冲突 / token 未下降都只把该
 *    文件记为对应状态，整轮整理仍然产出一份报告。
 *
 * 安全约束：
 *  - 写入必须带 `expectedHash`（调用方读到的内容哈希）；写函数抛
 *    `MaintenanceConflictError`（或任何 `conflict === true` 的错误）即视为「文件被
 *    其他程序改动」，该文件跳过、原文件一字不动。
 *  - 备份在写入之前创建；备份失败只记日志，不阻断写入（`createBackup` 本身不抛错）。
 *  - `events.ndjson` 只是审计日志：写失败只记日志，绝不影响整理结果。
 */

/** 全局记忆文件的默认 token 预算（托管区块）。 */
export const DEFAULT_GLOBAL_BUDGET_TOKENS = 4_000;
/** 项目记忆文件的默认单文件 token 预算（托管区块）。 */
export const DEFAULT_PROJECT_BUDGET_TOKENS = 2_500;
/** 审计日志文件名（位于 `<home>/memory-maintenance/`）。 */
export const MAINTENANCE_EVENTS_FILE = "events.ndjson";

export type MaintenanceLogLevel = "info" | "warn" | "error";

/** 待整理文件。`kind` 与 discovery 的 role 对齐（"primary" / "hierarchy" …），
 * 本模块不解释它，只透传给调用方日志 / UI。 */
export interface MaintenanceFileRef {
  path: string;
  scope: MemoryScope;
  kind: string;
}

export interface MaintenanceFileContent {
  content: string;
  /** 读到的内容哈希；原样回传给 `writeFile` 做乐观并发校验。 */
  hash: string;
}

export interface MaintenanceBudgets {
  global?: number;
  project?: number;
}

/**
 * 依赖注入接口。生产环境由 panel 侧适配器实现（读取 discovery 结果、走
 * `MemoryService.saveFile` 的 expectedHash 通道）；测试给假实现。
 */
export interface MaintenanceDeps {
  /** 只返回**已存在**、可整理的文件（缺失文件的占位不该出现在这里）。 */
  listFiles(): Promise<readonly MaintenanceFileRef[]>;
  readFile(filePath: string): Promise<MaintenanceFileContent>;
  /**
   * 写回整理后的内容。`expectedHash` 是读到的旧内容哈希；实现方必须在哈希不匹配时
   * 抛出 `MaintenanceConflictError`（或带 `conflict: true` 的错误），而不是覆盖。
   */
  writeFile(filePath: string, content: string, expectedHash: string): Promise<void>;
  /** 记忆 home（`~/.iflow`）：备份、meta、events 都放在这里。 */
  home: string;
  now(): Date;
  log?(level: MaintenanceLogLevel, message: string, detail?: unknown): void;
  /** 覆盖默认预算（global 4000 / project 单文件 2500）。 */
  budgets?: MaintenanceBudgets;
  /** 归档阈值：useCount 低于该值的事实优先归档（见 planCuration）。 */
  archiveBelowUseCount?: number;
  /**
   * token 计量函数（测试接缝）。默认 `estimateMarkdownTokens`，作用于托管区块文本。
   * 注入它可以避免测试依赖真实分词器，也能确定性地构造「token 未下降」场景。
   */
  measureTokens?(markdown: string): number;
  /**
   * L2 语义合并（可选）。调用方负责「分批 + 调模型 + 解析」，编排层只消费结果：
   * 返回通过校验的 `suggestions` 与被拒清单 `rejected`。不传则行为与纯 L1 完全一致。
   *
   * 只会在 `dryRun` 为假（apply 策略）且该文件 L1 之后仍有 ≥2 条事实时调用。
   */
  suggestMerges?(facts: string[]): Promise<{
    suggestions: MergeSuggestion[];
    rejected: RejectedMerge[];
  }>;
  /**
   * 只报告不写盘（`memoryMaintenanceStrategy === "report"`）。为真时绝不调用
   * `suggestMerges`（避免用户只想看报告却烧 token），并在报告里标注 L2 已跳过。
   */
  dryRun?(): boolean;
}

/** 写入时检测到文件被其他程序改动。适配器可直接抛本类，或抛任何 `conflict === true` 的错误。 */
export class MaintenanceConflictError extends Error {
  readonly conflict = true;
  constructor(message = "记忆文件已被其他程序改动，已跳过本次整理") {
    super(message);
    this.name = "MaintenanceConflictError";
  }
}

export type MaintenanceFileStatus = "applied" | "skipped" | "conflict" | "error";

/**
 * 单文件的 L2 语义合并状态：
 *  - `disabled`：未注入 `suggestMerges`，或 L1 之后不足 2 条事实（纯 L1）；
 *  - `skipped-report`：report 策略，刻意跳过 L2（不烧 token）；
 *  - `ran`：调用了 `suggestMerges`（可能一条建议也没通过校验）；
 *  - `failed`：`suggestMerges` 抛错，该文件降级为 L1。
 */
export type MaintenanceL2State = "disabled" | "skipped-report" | "ran" | "failed";

/** 一条被拒的 L2 建议摘要（用于 events.ndjson 观察模型幻觉率）。 */
export interface MaintenanceRejectedMerge {
  reason: string;
  /** 模型输出片段的截断摘要（单行、限长）。 */
  suggestion: string;
}

export interface MaintenanceFileReport {
  path: string;
  scope: MemoryScope;
  beforeTokens: number;
  afterTokens: number;
  dropped: number;
  merged: number;
  archived: number;
  status: MaintenanceFileStatus;
  reason?: string;
  /** L2 语义合并状态；`disabled` 时省略（与纯 L1 报告逐字一致）。 */
  l2?: MaintenanceL2State;
  /** 本文件被拒的 L2 建议；为空时省略。 */
  rejectedMerges?: MaintenanceRejectedMerge[];
}

export interface MaintenanceReport {
  /** ISO 时间（来自 `deps.now()`）。 */
  at: string;
  trigger: string;
  files: MaintenanceFileReport[];
  totalBeforeTokens: number;
  totalAfterTokens: number;
  savedTokens: number;
  backupsCreated: number;
}

const MANAGED_HEADING = /^## iFlow Added Memories[ \t]*$/;
const SECTION_HEADING = /^## /;

/**
 * 托管区块文本（含标题行，trimEnd）。与 `shared/memory-curate.ts` 的
 * `managedSectionText` 逐字同口径：整理压低的是注入模型的活动记忆，不含归档区。
 */
function managedSectionText(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => MANAGED_HEADING.test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_HEADING.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

function factsOf(markdown: string): string[] {
  return parseManagedFacts(markdown).map((fact) => fact.text);
}

/**
 * 把侧车元数据的 sha256 指纹映射到 `planCuration` 使用的 FNV 指纹上。
 *
 * 两套指纹各有用途：shared 的指纹不依赖 Node（webview 也能算），侧车用 sha256。
 * 这里以事实文本为桥，按 shared 解析出的每条事实去查侧车的 useCount。
 */
function usageFor(markdown: string, meta: MemoryMaintenanceMeta): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const fact of parseManagedFacts(markdown)) {
    const useCount = meta.facts[metaFactFingerprint(fact.text)]?.useCount;
    if (typeof useCount === "number") usage[fact.fingerprint] = useCount;
  }
  return usage;
}

function budgetFor(scope: MemoryScope, budgets: MaintenanceBudgets | undefined): number {
  const fallback = scope === "global" ? DEFAULT_GLOBAL_BUDGET_TOKENS : DEFAULT_PROJECT_BUDGET_TOKENS;
  const override = scope === "global" ? budgets?.global : budgets?.project;
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? override
    : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { conflict?: unknown; name?: unknown };
  return (
    record.conflict === true ||
    record.name === "MemoryConflictError" ||
    record.name === "MaintenanceConflictError"
  );
}

function annotateL2(
  entry: MaintenanceFileReport,
  l2: MaintenanceL2State,
  rejectedMerges: readonly MaintenanceRejectedMerge[],
): MaintenanceFileReport {
  const next: MaintenanceFileReport = { ...entry };
  if (l2 !== "disabled") next.l2 = l2;
  if (rejectedMerges.length > 0) next.rejectedMerges = [...rejectedMerges];
  return next;
}

function skippedEntry(
  file: MaintenanceFileRef,
  tokens: number,
  reason: string,
  l2: MaintenanceL2State = "disabled",
  rejectedMerges: readonly MaintenanceRejectedMerge[] = [],
): MaintenanceFileReport {
  return annotateL2(
    {
      path: file.path,
      scope: file.scope,
      beforeTokens: tokens,
      afterTokens: tokens,
      dropped: 0,
      merged: 0,
      archived: 0,
      status: "skipped",
      reason,
    },
    l2,
    rejectedMerges,
  );
}

/** 被拒建议摘要的最大长度（单行、限长，避免把整段模型输出写进审计日志）。 */
const MAX_REJECTED_SUMMARY = 200;

/**
 * 收集 L1 动作会触及的所有行号。L2 的 merge 一旦涉及这些行就必须丢弃 ——
 * `applyCurationPlan` 对同一行的 dedupe / archive 与 merge 同时生效时语义不明确
 * （removed 优先，merge 的替换被吞掉），宁可放弃一条合并建议。
 */
function occupiedLines(actions: readonly CurationAction[]): Set<number> {
  const occupied = new Set<number>();
  for (const action of actions) {
    switch (action.kind) {
      case "dedupe":
        occupied.add(action.keepLine);
        for (const line of action.dropLines) occupied.add(line);
        break;
      case "archive":
        for (const line of action.lines) occupied.add(line);
        break;
      case "normalize":
        occupied.add(action.line);
        break;
      case "merge":
        occupied.add(action.targetLine);
        for (const line of action.mergeLines) occupied.add(line);
        break;
    }
  }
  return occupied;
}

/** 把模型输出片段压成一行并截断，用于 events.ndjson 里的 rejected 摘要。 */
function summarizeSuggestion(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REJECTED_SUMMARY ? `${flat.slice(0, MAX_REJECTED_SUMMARY)}…` : flat;
}

interface L2Outcome {
  actions: CurationAction[];
  rejected: MaintenanceRejectedMerge[];
  state: MaintenanceL2State;
}

/**
 * 跑一次可选的 L2 语义合并，并把建议转成 `merge` 动作。
 *
 * 只消费调用方（panel）的 `suggestMerges` 结果：分批、调模型、解析都在那边。
 * 本函数负责三件事：
 *  1. 闸门：未注入依赖 → `disabled`；report 策略 → `skipped-report`（绝不烧 token）；
 *     托管事实不足 2 条 → `disabled`；
 *  2. 冲突：与 L1 动作（以及先加入的 L2 merge）抢同一行的建议整条丢弃并记 rejected；
 *  3. 失败隔离：`suggestMerges` 抛错只把本文件降级为 L1（`failed`），不影响其它文件。
 */
async function planSemanticMerges(
  deps: MaintenanceDeps,
  content: string,
  l1Actions: readonly CurationAction[],
): Promise<L2Outcome> {
  const suggest = deps.suggestMerges;
  if (!suggest) return { actions: [], rejected: [], state: "disabled" };

  const facts = parseManagedFacts(content);
  if (facts.length < 2) return { actions: [], rejected: [], state: "disabled" };
  // report 策略：用户只想看报告，绝不调用模型烧 token。
  if (deps.dryRun?.()) return { actions: [], rejected: [], state: "skipped-report" };

  let result: Awaited<ReturnType<NonNullable<MaintenanceDeps["suggestMerges"]>>>;
  try {
    result = await suggest(facts.map((fact) => fact.text));
  } catch (error) {
    deps.log?.("warn", "L2 语义合并失败，本文件降级为 L1", error);
    return { actions: [], rejected: [], state: "failed" };
  }

  const rejected: MaintenanceRejectedMerge[] = result.rejected.map((item) => ({
    reason: item.reason,
    suggestion: summarizeSuggestion(item.suggestion),
  }));

  const occupied = occupiedLines(l1Actions);
  const actions: CurationAction[] = [];
  for (const suggestion of result.suggestions) {
    const mapped = suggestionsToActions([suggestion], facts);
    if (mapped.length === 0) {
      // keep / absorb 无法在托管事实里逐字定位：不产生动作，但记一条 rejected
      // 便于观察模型幻觉（调用方本应已过滤，这里再兜一层）。
      rejected.push({
        reason: "keep/absorb 无法在托管事实中定位",
        suggestion: summarizeSuggestion(suggestion),
      });
      continue;
    }
    for (const action of mapped) {
      if (action.kind !== "merge") continue;
      const lines = [action.targetLine, ...action.mergeLines];
      const clash = lines.find((line) => occupied.has(line));
      if (clash !== undefined) {
        rejected.push({
          reason: `与已有动作冲突（行 ${clash}）`,
          suggestion: summarizeSuggestion({
            targetLine: action.targetLine,
            mergeLines: action.mergeLines,
            mergedText: action.mergedText,
          }),
        });
        continue;
      }
      actions.push(action);
      // 同一条 L2 merge 也不能与后来的 L2 merge 抢行。
      for (const line of lines) occupied.add(line);
    }
  }
  return { actions, rejected, state: "ran" };
}

/** 追加一行 JSON 审计记录。写失败只记日志。 */
async function appendEvent(deps: MaintenanceDeps, report: MaintenanceReport): Promise<void> {
  let applied = 0;
  let skipped = 0;
  let conflict = 0;
  let failed = 0;
  for (const file of report.files) {
    switch (file.status) {
      case "applied":
        applied++;
        break;
      case "skipped":
        skipped++;
        break;
      case "conflict":
        conflict++;
        break;
      case "error":
        failed++;
        break;
    }
  }
  const line = JSON.stringify({
    at: report.at,
    trigger: report.trigger,
    files: report.files.length,
    applied,
    skipped,
    conflict,
    error: failed,
    totalBeforeTokens: report.totalBeforeTokens,
    totalAfterTokens: report.totalAfterTokens,
    savedTokens: report.savedTokens,
    backupsCreated: report.backupsCreated,
  });
  try {
    const dir = maintenanceDir(deps.home);
    await mkdir(dir, { recursive: true });
    const eventsPath = path.join(dir, MAINTENANCE_EVENTS_FILE);
    await appendFile(eventsPath, `${line}\n`, "utf8");
    // L2 被拒建议逐条落盘：字段 at / path / reason / suggestion（已截断），
    // 用于观察模型幻觉率。写失败同样只记日志。
    for (const file of report.files) {
      for (const rejected of file.rejectedMerges ?? []) {
        const rejectedLine = JSON.stringify({
          at: report.at,
          path: file.path,
          reason: rejected.reason,
          suggestion: rejected.suggestion,
        });
        await appendFile(eventsPath, `${rejectedLine}\n`, "utf8");
      }
    }
  } catch (error) {
    deps.log?.("warn", "记忆整理审计日志写入失败", error);
  }
}

/**
 * 跑一轮记忆整理。
 *
 * 只会在 `deps.listFiles()` 抛错时向外抛（调度器据此累计失败次数）；单个文件的
 * 读 / 写失败都被收敛进报告。`trigger` 只用于审计（"manual" / "scheduled" …）。
 */
export async function runMaintenance(
  deps: MaintenanceDeps,
  trigger: string,
): Promise<MaintenanceReport> {
  const at = deps.now();
  const atIso = at.toISOString();
  const measure = deps.measureTokens ?? estimateMarkdownTokens;

  const files = await deps.listFiles();
  let meta = await loadMeta(deps.home);

  const entries: MaintenanceFileReport[] = [];
  const liveTexts: string[] = [];
  let backupsCreated = 0;
  let backupTick = 0;
  let totalBeforeTokens = 0;
  let totalAfterTokens = 0;

  for (const file of files) {
    let content: string;
    let hash: string;
    try {
      const read = await deps.readFile(file.path);
      content = read.content;
      hash = read.hash;
    } catch (error) {
      deps.log?.("warn", `记忆文件读取失败：${file.path}`, error);
      entries.push({
        path: file.path,
        scope: file.scope,
        beforeTokens: 0,
        afterTokens: 0,
        dropped: 0,
        merged: 0,
        archived: 0,
        status: "error",
        reason: messageOf(error),
      });
      continue;
    }

    const beforeTokens = measure(managedSectionText(content));
    const plan = planCuration(
      content,
      {
        budgetTokens: budgetFor(file.scope, deps.budgets),
        archiveBelowUseCount: deps.archiveBelowUseCount,
      },
      usageFor(content, meta),
    );

    // L2 语义合并：在 L1 计划之后、写盘之前。`applyCurationPlan` 的所有动作都按
    // **原始**行号定位（removed/replaced 集合最后统一组装，行号全程不位移），所以
    // merge 动作直接追加在 dedupe/archive 之后是安全的，无需两步走重新解析。
    const l2 = await planSemanticMerges(deps, content, plan.actions);
    const l2MergedFacts = l2.actions.reduce(
      (sum, action) => sum + (action.kind === "merge" ? action.mergeLines.length : 0),
      0,
    );
    const combinedPlan: CurationPlan =
      l2.actions.length > 0
        ? { ...plan, actions: [...plan.actions, ...l2.actions], mergedFacts: plan.mergedFacts + l2MergedFacts }
        : plan;

    if (combinedPlan.actions.length === 0) {
      liveTexts.push(...factsOf(content));
      entries.push(skippedEntry(file, beforeTokens, "no-actions", l2.state, l2.rejected));
      totalBeforeTokens += beforeTokens;
      totalAfterTokens += beforeTokens;
      continue;
    }

    // 备份在写入之前：每个文件的备份时间戳加一个毫秒偏移，避免同名文件在同一
    // 毫秒内互相覆盖（备份 id = 时间戳 + basename）。
    const backup = await createBackup(deps.home, file.path, content, new Date(at.getTime() + backupTick));
    backupTick++;
    if (backup.backupPath !== null) {
      backupsCreated++;
    } else {
      deps.log?.("warn", `记忆文件备份失败：${file.path}`, backup.error);
    }

    const nextContent = applyCurationPlan(content, combinedPlan);
    if (nextContent === content) {
      liveTexts.push(...factsOf(content));
      entries.push(skippedEntry(file, beforeTokens, "no-change", l2.state, l2.rejected));
      totalBeforeTokens += beforeTokens;
      totalAfterTokens += beforeTokens;
      continue;
    }

    const afterTokens = measure(managedSectionText(nextContent));
    if (afterTokens >= beforeTokens) {
      deps.log?.("warn", `记忆整理放弃：token 未下降 ${file.path}`, {
        beforeTokens,
        afterTokens,
      });
      liveTexts.push(...factsOf(content));
      entries.push(skippedEntry(file, beforeTokens, "tokens-not-reduced", l2.state, l2.rejected));
      totalBeforeTokens += beforeTokens;
      totalAfterTokens += beforeTokens;
      continue;
    }

    try {
      await deps.writeFile(file.path, nextContent, hash);
    } catch (error) {
      const conflict = isConflictError(error);
      deps.log?.(
        conflict ? "info" : "warn",
        `记忆文件${conflict ? "写入冲突" : "写入失败"}：${file.path}`,
        error,
      );
      liveTexts.push(...factsOf(content));
      entries.push(
        annotateL2(
          {
            path: file.path,
            scope: file.scope,
            beforeTokens,
            afterTokens: beforeTokens,
            dropped: 0,
            merged: 0,
            archived: 0,
            status: conflict ? "conflict" : "error",
            reason: messageOf(error),
          },
          l2.state,
          l2.rejected,
        ),
      );
      totalBeforeTokens += beforeTokens;
      totalAfterTokens += beforeTokens;
      continue;
    }

    liveTexts.push(...factsOf(nextContent));
    entries.push(
      annotateL2(
        {
          path: file.path,
          scope: file.scope,
          beforeTokens,
          afterTokens,
          dropped: combinedPlan.droppedFacts,
          merged: combinedPlan.mergedFacts,
          archived: combinedPlan.archivedFacts,
          status: "applied",
        },
        l2.state,
        l2.rejected,
      ),
    );
    totalBeforeTokens += beforeTokens;
    totalAfterTokens += afterTokens;
  }

  // 侧车元数据：先按「所有文件里仍然存在的事实」清掉已删除项，再给每条活跃事实
  // 记一次观察（useCount 是「该事实在多少轮整理中存活」的活跃度信号）。
  meta = pruneMeta(meta, liveTexts);
  for (const text of liveTexts) meta = touchFact(meta, text, atIso);
  try {
    await saveMeta(deps.home, meta);
  } catch (error) {
    deps.log?.("warn", "记忆整理元数据写入失败", error);
  }

  const report: MaintenanceReport = {
    at: atIso,
    trigger,
    files: entries,
    totalBeforeTokens,
    totalAfterTokens,
    savedTokens: Math.max(0, totalBeforeTokens - totalAfterTokens),
    backupsCreated,
  };
  await appendEvent(deps, report);
  return report;
}
