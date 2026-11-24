import { countTokens as gptCountTokens } from "gpt-tokenizer";

/**
 * 记忆整理引擎（纯逻辑核心）。
 *
 * 纪律：
 *  - 本文件在 `shared/` 下：零 VSCode 依赖、零 `src/` 依赖，宿主与 webview 都能加载。
 *  - 全部是纯函数：只读入字符串/数字，只返回新字符串或计划；不读写文件、不读时钟
 *    （`now` 一律由调用方传入）。
 *  - 记忆文件格式由 CLI 的加载器直接读取，**不能改**。整理只允许动
 *    `## iFlow Added Memories` 托管区块内的 `- ` 事实条目；代码围栏（``` 与 ~~~）内的行、
 *    `@path` 导入行、其它 `## ` 区块一律原样保留。
 *
 * 与 `src/memory/*` 的关系（shared 不能 import src，规则在此镜像一份）：
 *  - `normalizeFactText` 与 `src/memory/extract.ts` 的 `normalizeFact` 逐字一致；
 *  - 托管区块边界、`- text` 条目格式、围栏跳过逻辑对齐 `src/memory/files.ts`
 *    的 `parseFacts` 与 `src/memory/service.ts` 的 `scanBullets`；
 *  - 归档区格式对齐 `src/memory/service.ts` 的 `## Archived Memories`。
 */

/** 托管区块标题（与 `src/memory/files.ts` 的 MEMORY_MARKER 同值）。 */
const MANAGED_MARKER = "## iFlow Added Memories";
/** 归档区块标题（与 `src/memory/service.ts` 的 ARCHIVED_MARKER 同值）。 */
const ARCHIVED_MARKER = "## Archived Memories";
/** 围栏起始行：三反引号或三波浪号。 */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
/** 二级标题（托管区块与归档区块的结束边界）。 */
const SECTION_HEADING = /^## /;
const MANAGED_HEADING = new RegExp(`^${MANAGED_MARKER}[ \\t]*$`);

/** 托管区块内的一条事实。 */
export interface ManagedFact {
  /** 在整个 markdown 中的零基行号（与 files.ts 的 parseFacts 同口径）。 */
  line: number;
  /** 去掉 `- ` 前缀并 trim 后的事实文本。 */
  text: string;
  /** 归一化文本的确定性指纹，用于去重。 */
  fingerprint: string;
}

/**
 * 整理动作。`merge` / `normalize` 目前不由 `planCuration` 生成：语义合并与措辞
 * 改写留给模型层，这里只保证 `applyCurationPlan` 能安全执行它们。
 */
export type CurationAction =
  | { kind: "dedupe"; keepLine: number; dropLines: number[] }
  | { kind: "merge"; targetLine: number; mergeLines: number[]; mergedText: string }
  | { kind: "archive"; lines: number[] }
  | { kind: "normalize"; line: number; nextText: string };

/**
 * 整理计划。token 口径是**托管区块**（`## iFlow Added Memories` 起至下一个 `## `），
 * 不含归档区：整理要压低的是注入模型的活动记忆，归档区只是留档。
 */
export interface CurationPlan {
  actions: CurationAction[];
  beforeTokens: number;
  afterTokens: number;
  estimatedSaving: number;
  droppedFacts: number;
  mergedFacts: number;
  archivedFacts: number;
}

export interface CurateOptions {
  /** 托管区块的 token 预算；超出时按「先删重复、再归档低价值」生成 archive 动作。 */
  budgetTokens?: number;
  /**
   * 归档阈值：`useCount` 低于该值的事实视为低价值，优先归档。不传则所有事实同权，
   * 只按文本信息量与出现顺序排序。useCount 来自维护侧车元数据，由调用方通过
   * `planCuration` 的第三个参数传入（shared 不读文件）。
   */
  archiveBelowUseCount?: number;
}

/** 整理调度状态（持久化由调用方负责）。 */
export interface ScheduleState {
  /** 上次成功整理的时间（ISO 字符串）。 */
  lastRunAt?: string;
  /** 下次计划整理的时间（ISO 字符串）。 */
  nextPlanAt?: string;
  /** 连续失败次数；调用方可用它做退避，本模块不参与判定。 */
  failureCount: number;
}

/**
 * 事实归一化 —— **必须与 `src/memory/extract.ts` 的 `normalizeFact` 保持逐字一致**
 * （shared 不能依赖 src，所以规则在这里镜像一份；改一处就要改另一处）。
 * 只用于比较/指纹，永不写回文件。
 */
export function normalizeFactText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[，。；、,.!?！？;:："'“”‘’()（）【】\[\]]/g, "")
    .trim();
}

/**
 * 事实指纹：对归一化文本做 FNV-1a 64 位哈希，输出 16 位十六进制。
 *
 * 自实现而不是引 node:crypto —— `shared/` 保持零 Node 内置依赖（webview 也能加载）。
 * 归一化先行，所以 `Use  pnpm.` 与 `- use pnpm` 落在同一个指纹上；纯函数、跨平台确定。
 */
export function factFingerprint(text: string): string {
  const normalized = normalizeFactText(text);
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  // for...of 按码点迭代，代理对（emoji 等）不会被拆成两半。
  for (const char of normalized) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 托管区块标题所在行；找不到返回 -1。 */
function findManagedStart(lines: readonly string[]): number {
  return lines.findIndex((line) => MANAGED_HEADING.test(line));
}

/** 从 `from` 起第一个 `## ` 标题行；没有则返回行数。 */
function findSectionEnd(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (SECTION_HEADING.test(lines[i] ?? "")) return i;
  }
  return lines.length;
}

/**
 * 只解析托管区块内、围栏外的 `- ` 事实条目。
 *
 * 跳过：代码围栏（``` / ~~~，关闭围栏要求同字符且不短于开启围栏）、`@path` 导入行、
 * 其它 `## ` 区块。行号是**整个 markdown** 的零基行号，可直接回写。
 */
export function parseManagedFacts(markdown: string): ManagedFact[] {
  const lines = markdown.split("\n");
  const start = findManagedStart(lines);
  if (start === -1) return [];
  const end = findSectionEnd(lines, start + 1);

  const facts: ManagedFact[] = [];
  let fenceChar = "";
  let fenceLength = 0;
  let inFence = false;

  for (let i = start + 1; i < end; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "";
      const char = marker.charAt(0);
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLength = marker.length;
      } else if (char === fenceChar && marker.length >= fenceLength) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    // @path 导入行不是事实（即使它被写成 `- @file`）。
    if (line.trimStart().startsWith("@")) continue;
    const match = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const text = (match[1] ?? "").trim();
    if (!text || text.startsWith("@")) continue;
    facts.push({ line: i, text, fingerprint: factFingerprint(text) });
  }
  return facts;
}

/** 托管区块的文本（含标题行，trimEnd）；无托管区块返回空串。 */
function managedSectionText(markdown: string): string {
  const lines = markdown.split("\n");
  const start = findManagedStart(lines);
  if (start === -1) return "";
  const end = findSectionEnd(lines, start + 1);
  return lines.slice(start, end).join("\n").trimEnd();
}

/** CJK 友好的兜底估算，仅在 gpt-tokenizer 不可用时使用（对齐 session-state.ts）。 */
function heuristicTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\u3040-\u30ff\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

/** markdown 的 token 估算（gpt-tokenizer o200k_base，失败时退回 CJK 启发式）。 */
export function estimateMarkdownTokens(markdown: string): number {
  if (!markdown) return 0;
  try {
    return gptCountTokens(markdown);
  } catch {
    return heuristicTokens(markdown);
  }
}

/**
 * 归档优先级：低价值在前。
 *
 * 1) 有 `archiveBelowUseCount` 且该事实 useCount 达到阈值 → 排后（尽量不归档常用事实）；
 * 2) useCount 升序（用得少先归档）；
 * 3) 归一化文本长度升序（越短信息量越低）；
 * 4) 行号升序（同龄同长时先归档更早出现、更可能过时的条目）。
 */
function rankArchiveCandidates(
  facts: readonly ManagedFact[],
  archiveBelowUseCount: number | undefined,
  usageByFingerprint: Readonly<Record<string, number>>,
): ManagedFact[] {
  const scored = facts.map((fact) => {
    const useCount = usageByFingerprint[fact.fingerprint] ?? 0;
    const tier = archiveBelowUseCount !== undefined && useCount >= archiveBelowUseCount ? 1 : 0;
    return { fact, useCount, tier, value: normalizeFactText(fact.text).length };
  });
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.useCount - b.useCount ||
      a.value - b.value ||
      a.fact.line - b.fact.line,
  );
  return scored.map((entry) => entry.fact);
}

/** 统计计划里各动作影响的条目数。 */
function countActions(actions: readonly CurationAction[]): {
  droppedFacts: number;
  mergedFacts: number;
  archivedFacts: number;
} {
  let droppedFacts = 0;
  let mergedFacts = 0;
  let archivedFacts = 0;
  for (const action of actions) {
    switch (action.kind) {
      case "dedupe":
        droppedFacts += action.dropLines.length;
        break;
      case "merge":
        mergedFacts += action.mergeLines.length;
        break;
      case "archive":
        archivedFacts += action.lines.length;
        break;
      case "normalize":
        break;
    }
  }
  return { droppedFacts, mergedFacts, archivedFacts };
}

/**
 * 生成整理计划（不执行）。
 *
 * 顺序：先按指纹去重（保留最早一条；归一化后为空的事实整条删除），若给了
 * `budgetTokens` 且托管区块超预算，再按归档优先级逐条 archive，直到压回预算内。
 * 不做语义合并 —— 那需要模型判断，`merge` 动作留给模型层构造。
 *
 * @param usageByFingerprint 可选的 useCount 表（指纹 → 次数），来自维护侧车元数据；
 *   不传时所有事实按 0 次计，只按信息量与出现顺序排序。
 */
export function planCuration(
  markdown: string,
  opts: CurateOptions = {},
  usageByFingerprint: Readonly<Record<string, number>> = {},
): CurationPlan {
  const facts = parseManagedFacts(markdown);
  const beforeTokens = estimateMarkdownTokens(managedSectionText(markdown));

  const actions: CurationAction[] = [];
  const groups = new Map<string, ManagedFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.fingerprint);
    if (group) group.push(fact);
    else groups.set(fact.fingerprint, [fact]);
  }

  const consumed = new Set<number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.line - b.line);
    const keep = ordered[0];
    if (!keep) continue;
    const empty = normalizeFactText(keep.text).length === 0;
    if (empty) {
      // 归一化后为空（只剩标点/空白）：整组删除。keepLine 也放进 dropLines，
      // 表示「这一组不留幸存者」——applyCurationPlan 对此有明确语义。
      const all = ordered.map((fact) => fact.line);
      actions.push({ kind: "dedupe", keepLine: keep.line, dropLines: all });
      for (const line of all) consumed.add(line);
      continue;
    }
    if (ordered.length === 1) continue;
    const drops = ordered.slice(1).map((fact) => fact.line);
    actions.push({ kind: "dedupe", keepLine: keep.line, dropLines: drops });
    for (const line of drops) consumed.add(line);
  }

  const plan: CurationPlan = {
    actions,
    beforeTokens,
    afterTokens: beforeTokens,
    estimatedSaving: 0,
    droppedFacts: 0,
    mergedFacts: 0,
    archivedFacts: 0,
  };

  const budget = opts.budgetTokens;
  if (budget !== undefined && Number.isFinite(budget)) {
    const candidates = rankArchiveCandidates(
      facts.filter((fact) => !consumed.has(fact.line)),
      opts.archiveBelowUseCount,
      usageByFingerprint,
    );
    let applied = applyCurationPlan(markdown, plan);
    let liveTokens = estimateMarkdownTokens(managedSectionText(applied));
    for (const candidate of candidates) {
      if (liveTokens <= budget) break;
      plan.actions.push({ kind: "archive", lines: [candidate.line] });
      applied = applyCurationPlan(markdown, plan);
      liveTokens = estimateMarkdownTokens(managedSectionText(applied));
    }
  }

  const finalMarkdown = applyCurationPlan(markdown, plan);
  const afterTokens = estimateMarkdownTokens(managedSectionText(finalMarkdown));
  const counts = countActions(plan.actions);
  return {
    ...plan,
    afterTokens,
    estimatedSaving: Math.max(0, beforeTokens - afterTokens),
    droppedFacts: counts.droppedFacts,
    mergedFacts: counts.mergedFacts,
    archivedFacts: counts.archivedFacts,
  };
}

/** 把归档条目追加到文件末尾的 `## Archived Memories` 区块，绝不改写已有内容。 */
function appendArchivedSection(content: string, facts: readonly string[]): string {
  if (facts.length === 0) return content;
  const bullets = facts.map((fact) => `- ${fact}`).join("\n");
  const heading = /^## Archived Memories[ \t]*$/m.exec(content);
  if (!heading) {
    // 只追加、不裁剪：原有内容逐字保留（含末尾换行）。
    const separator =
      content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}${ARCHIVED_MARKER}\n${bullets}\n`;
  }
  const sectionStart = heading.index + heading[0].length;
  let sectionEnd = content.indexOf("\n## ", sectionStart);
  if (sectionEnd === -1) sectionEnd = content.length;
  const before = content.slice(0, sectionEnd);
  const after = content.slice(sectionEnd);
  const prefix = before.endsWith("\n") ? "" : "\n";
  if (!after) return `${before}${prefix}${bullets}\n`;
  // after 以 "\n## " 开头：bullets 后直接接上换行即可。
  return `${before}${prefix}${bullets}${after}`;
}

/**
 * 纯函数应用计划，返回新 markdown。
 *
 * 安全语义：所有动作都按**原始**行号定位并逐条校验当前文本 ——
 * 行号越界、该行已不是事实、指纹不再匹配时跳过该动作（或该行），绝不抛错，
 * 也绝不误删别的行。dedupe 的 `keepLine` 若同时出现在 `dropLines` 里，表示整组删除。
 */
export function applyCurationPlan(markdown: string, plan: CurationPlan): string {
  if (plan.actions.length === 0) return markdown;
  const lines = markdown.split("\n");
  const start = findManagedStart(lines);
  if (start === -1) return markdown;

  const facts = new Map<number, ManagedFact>();
  const prefixes = new Map<number, string>();
  for (const fact of parseManagedFacts(markdown)) {
    facts.set(fact.line, fact);
    const raw = lines[fact.line] ?? "";
    prefixes.set(fact.line, /^(\s*-\s+)/.exec(raw)?.[1] ?? "- ");
  }

  const removed = new Set<number>();
  const replaced = new Map<number, string>();
  const archived: string[] = [];
  let changed = false;

  for (const action of plan.actions) {
    switch (action.kind) {
      case "dedupe": {
        const keep = facts.get(action.keepLine);
        if (!keep) break;
        for (const line of action.dropLines) {
          const drop = facts.get(line);
          // 文本已变（指纹不同）或该行已不是事实：安全跳过这一行。
          if (!drop || drop.fingerprint !== keep.fingerprint) continue;
          removed.add(line);
          changed = true;
        }
        break;
      }
      case "archive": {
        for (const line of action.lines) {
          const fact = facts.get(line);
          if (!fact) continue;
          removed.add(line);
          archived.push(fact.text);
          changed = true;
        }
        break;
      }
      case "normalize": {
        const fact = facts.get(action.line);
        const next = action.nextText.trim();
        if (!fact || !next) break;
        const prefix = prefixes.get(action.line) ?? "- ";
        if (`${prefix}${next}` === lines[action.line]) break;
        replaced.set(action.line, `${prefix}${next}`);
        changed = true;
        break;
      }
      case "merge": {
        const target = facts.get(action.targetLine);
        const merged = action.mergedText.trim();
        if (!target || !merged) break;
        const mergeLines = action.mergeLines.filter((line) => line !== action.targetLine);
        // 合并是原子的：任一行不匹配就整条跳过，避免留下半合并状态。
        if (mergeLines.length !== action.mergeLines.length) break;
        if (mergeLines.some((line) => !facts.has(line))) break;
        replaced.set(action.targetLine, `${prefixes.get(action.targetLine) ?? "- "}${merged}`);
        for (const line of mergeLines) removed.add(line);
        changed = true;
        break;
      }
    }
  }

  if (!changed) return markdown;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue;
    out.push(replaced.get(i) ?? lines[i] ?? "");
  }
  const result = out.join("\n");
  return archived.length > 0 ? appendArchivedSection(result, archived) : result;
}

/** 把 ISO 时间或 Date 解析成毫秒；解析失败返回 NaN。 */
function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * 是否该跑一次整理：**容量超预算**或**距上次运行 ≥ intervalDays** 都返回 true。
 *
 * - 预算超了不等周期（记忆已经开始挤占上下文）；
 * - 从未运行过（lastRunAt 缺失/非法）→ true；
 * - `now` 非法 → false（无法判定，宁可不跑）；`intervalDays` 为负按 0 处理。
 */
export function shouldRunCuration(
  state: ScheduleState,
  now: Date | string,
  intervalDays: number,
  currentTokens: number,
  budgetTokens?: number,
): boolean {
  if (budgetTokens !== undefined && Number.isFinite(budgetTokens) && currentTokens > budgetTokens) {
    return true;
  }
  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) return false;
  const lastMs = state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN;
  if (!Number.isFinite(lastMs)) return true;
  const intervalMs = Math.max(0, intervalDays) * 24 * 60 * 60 * 1000;
  return nowMs - lastMs >= intervalMs;
}

/**
 * 下次计划整理时间 = 上次运行 + intervalDays。lastRunAt 缺失/非法时返回空串
 * （调用方视为「立即可以跑」）。
 */
export function computeNextPlanAt(lastRunAt: string | undefined, intervalDays: number): string {
  const lastMs = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  if (!Number.isFinite(lastMs)) return "";
  const intervalMs = Math.max(0, intervalDays) * 24 * 60 * 60 * 1000;
  return new Date(lastMs + intervalMs).toISOString();
}
