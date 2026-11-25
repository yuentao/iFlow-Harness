import { create } from "zustand";
import {
  applyBlockPatch,
  EVICT_KEEP_BLOCKS,
  evictBlockPayloads,
  sanitizeTranscriptBlocks,
  type Block,
  type ContextWindowOverridesUi,
  type HostSettingsUi,
  type HostToWebview,
  type KnowledgeDocUi,
  type MemoryCandidateUi,
  type MemoryFileUi,
  type MemoryScope,
  type MemoryStateUi,
  type ModelMetadataStateUi,
  type QqSettingsUi,
  type SessionState,
  type SessionSummaryUi,
  type UiDensity,
  type UiFontSize,
  type WebviewToHost,
  pickQqSettingsUi,
} from "../../shared/messages";
import { normalizeModelId } from "../../shared/context-window";
import { collectTurnChanges } from "../../shared/turn-changes";
import type { SuperSessionUi } from "../../shared/super-agent";

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

interface HostApi {
  postMessage: (msg: unknown) => void;
}

/**
 * `iflow.uiFontSize` / `iflow.uiDensity` → CSS multipliers.
 *
 * Text sizes come from the semantic ramp in styles.css (title 16 / body 14 /
 * label 13 / caption 12 / micro 11), each multiplied by `--ui-font-scale`.
 * Standard is the 1.0 baseline; compact and large preserve the previous
 * effective sizes without producing fractional author px. Density scales
 * Tailwind's `--spacing` token instead.
 */
const UI_FONT_SCALES: Record<UiFontSize, number> = { compact: 0.92, standard: 1, large: 1.1 };
const UI_DENSITY_SCALES: Record<UiDensity, number> = {
  compact: 0.92,
  standard: 1,
  comfortable: 1.12,
};

/**
 * Keep only the transcripts of child sessions that still exist. The board and
 * `state.superSessions` share one source of truth, so a cleaned-up child's
 * transcript must not linger in the webview heap.
 */
function pruneSuperTranscripts(
  transcripts: Record<string, Block[]>,
  sessions: SuperSessionUi[] | undefined,
): Record<string, Block[]> {
  if (!sessions || sessions.length === 0) {
    return Object.keys(transcripts).length === 0 ? transcripts : {};
  }
  const keep = new Set(sessions.map((s) => s.id));
  let changed = false;
  const next: Record<string, Block[]> = {};
  for (const [id, blocks] of Object.entries(transcripts)) {
    if (keep.has(id)) next[id] = blocks;
    else changed = true;
  }
  return changed ? next : transcripts;
}

function applyUiScale(fontSize: UiFontSize, density: UiDensity): void {
  const style = document.documentElement.style;
  style.setProperty("--ui-font-scale", String(UI_FONT_SCALES[fontSize] ?? UI_FONT_SCALES.standard));
  style.setProperty("--ui-density", String(UI_DENSITY_SCALES[density] ?? UI_DENSITY_SCALES.standard));
}

/** Package-default mirror used before the first hostSettings message and by
 * the browser mock (the host pushes the effective values on ready). */
const DEFAULT_HOST_SETTINGS: HostSettingsUi = {
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: true,
  autoTitle: true,
  efficiencyMode: "steady",
  memoryExtractTimeoutSeconds: 90,
  memoryMaintenanceEnabled: false,
  memoryMaintenanceIntervalDays: 7,
  memoryMaintenanceIdleMinutes: 15,
  memoryMaintenanceGlobalTokenBudget: 4000,
  memoryMaintenanceProjectTokenBudget: 2500,
  memoryMaintenanceTotalTokenBudget: 12000,
  memoryMaintenanceStrategy: "report",
  nextStepTimeoutSeconds: 25,
  compressTimeoutSeconds: 0,
  autoCompressThresholdPercent: 95,
  restoreLastSession: false,
  autoOpenPanel: false,
  warmStart: true,
  soundFeedback: true,
  osNotifications: "approvals",
  language: "",
  theme: "auto",
  auroraIntensity: 35,
  uiFontSize: "standard",
  uiDensity: "standard",
  nodePath: "",
  checkpoints: true,
  checkpointMaxFiles: 50_000,
  checkpointMaxFileMB: 300,
  checkpointDir: "",
  checkpointMaxTurns: 0,
  checkpointMaxSizeMB: 0,
  contextWindowOverrides: [],
  costTable: [],
  thinkingModelRules: [],
  superAgentMaxConcurrent: 5,
  superAgentMaxAttempts: 2,
  superAgentDependencyPolicy: "block",
  superAgentIntegration: "merge",
  superAgentMaxWorktrees: 10,
  superAgentKeepWorktree: false,
  superAgentFullTrust: false,
};

// --- turn-finished / turn-failed sound cues (Web Audio, no asset files) ------

let audioCtx: AudioContext | null = null;

/** One envelope-shaped oscillator blip. */
function blip(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  type: OscillatorType,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  // Quick attack, exponential decay — reads as a UI cue, not an alarm.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
  // Release the graph nodes once the oscillator finishes. Without this every
  // cue leaves an osc+gain pair connected to the destination for the lifetime
  // of the AudioContext, which accumulates over a long webview session.
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Autoplay-policy unlock: create/resume the AudioContext inside a user
 * gesture. An AudioContext lazily created at cue time (turn end — focus is
 * typically in the editor, not this webview) starts "suspended" and its
 * resume() never settles without a gesture, so the cue stays silent. Creating
 * it during any click/keypress in the panel leaves it "running" for good;
 * the gesture listeners are attached once in setupHostListener.
 */
function unlockAudio(): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
  } catch {
    // Audio unavailable (headless/hostile env) — the cue is best-effort.
  }
}

/**
 * Synthesized cues — three distinct subjects, three distinct sounds:
 * - "done": rising two-tone chime (E5 → G5), short and positive. A real turn
 *   finished (user turn, or the main session's Super Agent report turn).
 * - "error": falling double-buzz (A3 → F3, square), unmistakably wrong.
 * - "child": ONE child session settled — a single low, short, quiet note
 *   (D5 sine, 0.11s, peak 0.06). Deliberately lighter than "done": one child
 *   finishing is progress, not the whole task finishing, and users asked for
 *   the two to be tellable apart by ear alone.
 * Volume kept low (≤0.08 peak); ~0.35s total, never overlaps the next turn.
 */
function playCue(kind: "done" | "error" | "child"): void {
  try {
    unlockAudio();
    const ctx = audioCtx;
    if (!ctx || ctx.state === "closed") return; // Audio unavailable / closed
    // Scheduling while the context is "suspended" pins notes to a frozen
    // currentTime and they never sound even after a later resume. Schedule
    // only once the context is actually running; the gesture pre-unlock in
    // setupHostListener normally makes this a no-op, but turn-end cues can
    // still arrive before the first gesture inside the webview.
    const schedule = () => {
      try {
        const t = ctx.currentTime + 0.01;
        if (kind === "done") {
          blip(ctx, 659.25, t, 0.14, "sine", 0.08);
          blip(ctx, 783.99, t + 0.13, 0.2, "sine", 0.08);
        } else if (kind === "child") {
          blip(ctx, 587.33, t, 0.11, "sine", 0.06);
        } else {
          blip(ctx, 220, t, 0.13, "square", 0.05);
          blip(ctx, 174.61, t + 0.15, 0.2, "square", 0.05);
        }
      } catch {
        // Audio unavailable (headless/hostile env) — the cue is best-effort.
      }
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(schedule).catch(() => {});
    } else {
      schedule();
    }
  } catch {
    // Audio unavailable (headless/hostile env) — the cue is best-effort.
  }
}

/**
 * Dev/browser fallback when running the webview outside VSCode (e.g. a static
 * server for UI iteration): a tiny mock host that answers `ready` with a demo
 * snapshot and echoes prompts. Real VSCode webviews always provide the API.
 */
function createMockHost(): HostApi {
  const broadcast = (msg: HostToWebview) => {
    // postMessage structured-clones every payload; the mock dispatches a plain
    // object, so nested arrays would keep their identity and zustand's
    // reference equality would skip the re-render. Clone the projections we
    // mutate in place (the Super Agent board is the only one today).
    const payload: HostToWebview =
      msg.type === "snapshot" && msg.state
        ? { ...msg, state: { ...msg.state, superSessions: msg.state.superSessions ? [...msg.state.superSessions] : undefined } }
        : msg;
    window.setTimeout(
      () => window.dispatchEvent(new MessageEvent("message", { data: { ...payload, locale: "zh-cn" } })),
      60,
    );
  };
  /** requestId → pending mock-rewrite timer (cancelEnhance clears it). */
  const mockEnhanceTimers = new Map<number, number>();
  // Mock editor theme: read the OS preference so browser verification can
  // exercise both paths.
  const mockTheme: "dark" | "light" = window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  // Mock MCP dicts: one per scope, lazily seeded on first read and replaced
  // wholesale on save (mirrors the host's replace semantics). The project dict
  // deliberately re-declares `chrome-devtools` so the browser demo exercises
  // the CLI's merge rule (workspace overrides user for the same name).
  let mockMcpGlobal: Record<string, unknown> | undefined;
  let mockMcpProject: Record<string, unknown> | undefined;
  const seedMockMcp = (): void => {
    mockMcpGlobal ??= {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      "remote-example": { url: "https://mcp.example.com/mcp", type: "http" },
    };
    mockMcpProject ??= {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--isolated"] },
    };
  };
  /** Mirrors the real host's mirrored extension settings (default on). */
  const mockHostSettings: HostSettingsUi = { ...DEFAULT_HOST_SETTINGS };
  /** Mock of the host's context-window-override channel (rows + the current
   * model's built-in window, so the browser preview can try the suggestion). */
  let mockContextWindowOverrides: ContextWindowOverridesUi = {
    overrides: [],
    currentModelId: "gemini-2.5-pro",
    builtinWindow: 1_048_576,
  };
  /** 「联网补充模型数据」 mock: one in-flight timer (cancel clears it). */
  let mockMetadataTimer: number | null = null;
  /**
   * 残留清单新协议（`superResidueList` ↔ `superResidueHandle`）的 mock 令牌：
   * 每次请求换发，消费一次即作废 —— 与宿主的一次性 confirmToken 同语义。
   */
  let mockResidueSeq = 0;
  let mockResidueToken: string | null = null;
  // Mock QQ settings (browser preview): the QQ tab renders straight from
  // `qqSettings`, so seed the access-control tables with real entries —
  // two users with notes plus one without (exercises the masked fallback)
  // and one group with a note. Deleting a row in the preview pushes a
  // `qqSettingsPatch` back, which empties that list and shows its empty state.
  let mockQqSettings: QqSettingsUi = pickQqSettingsUi(
    {
      enabled: true,
      workspace: "C:\\mock\\workspace",
      allowedUsers: [
        { openid: "D754A1B2C3D4E5F6A7B88D11", note: "我的手机（私聊）" },
        { openid: "A1B2C3D4E5F6A7B8C9D0E1F2", note: "同事小林" },
        { openid: "9F8E7D6C5B4A3928F0E1D2C3" },
      ],
      allowedGroups: [{ openid: "123456789", note: "项目讨论群" }],
      remotePolicy: "supervised",
      maxConcurrentTasks: 2,
      rateLimitPerMin: 6,
      resultDetail: "standard",
      autoMerge: false,
    },
    { hasAppSecret: true },
  );

  // Mock memory files (F3): enough to exercise the tab in a browser — one
  // global primary with structured facts, one project file, one legacy file.
  const mockTakeoverToastId = 990_001;
  const mockMemoryHome = "C:\\Users\\mock\\.iflow";
  const mockMemoryRoot = "C:\\mock\\workspace";
  const mockMemoryContent = new Map<string, string>([
    [
      `${mockMemoryHome}\\AGENTS.md`,
      "# 用户记忆\n\n## 偏好\n\n## iFlow Added Memories\n- 回答使用中文\n- 先给出结论再展开\n",
    ],
    [
      `${mockMemoryRoot}\\AGENTS.md`,
      "# 项目记忆\n\n## 项目约定\n\n## 已知陷阱\n\n## iFlow Added Memories\n- 运行 npm test 验证改动\n",
    ],
    [`${mockMemoryHome}\\memory.md`, "# 旧版记忆\n\n- 这是不会注入的遗留内容\n"],
  ]);
  let mockKnowledgeDocs: KnowledgeDocUi[] = [];
  let mockMemoryFiles: MemoryFileUi[] = [
    {
      path: `${mockMemoryHome}\\AGENTS.md`,
      displayPath: "~/.iflow/AGENTS.md",
      scope: "global",
      role: "primary",
      exists: true,
      editable: true,
      injected: true,
      bytes: 70,
      tokens: 30,
      updatedAt: Date.now(),
      hash: null,
      facts: [
        { id: "3:aaa", text: "回答使用中文" },
        { id: "4:bbb", text: "先给出结论再展开" },
        {
          id: "6:ccc",
          text: "验证流程：`npx vitest run <测试文件>` 跑定向单测，`npm run typecheck` 分别检查 host 与 webview，`npm test` 跑全量；提交前按此顺序验证并在汇报中列出结果。任何「CLI 行为」的假设都应在代码注释里标注验证来源（版本 + 实测方式）。",
        },
        {
          id: "7:ddd",
          text: "陷阱：切换 provider 预设时，若新预设没有推荐模型，不能继承上一个网关的模型名，否则出现「新端点 + 旧模型」错配。全局快捷键在隐藏卡片、SELECT 聚焦或事件已 defaultPrevented 时不得响应。",
        },
      ],
    },
    {
      path: `${mockMemoryRoot}\\AGENTS.md`,
      displayPath: "AGENTS.md",
      scope: "project",
      role: "primary",
      exists: true,
      editable: true,
      injected: true,
      bytes: 80,
      tokens: 36,
      updatedAt: Date.now(),
      hash: null,
      facts: [{ id: "5:ccc", text: "运行 npm test 验证改动" }],
    },
    {
      path: `${mockMemoryHome}\\memory.md`,
      displayPath: "~/.iflow/memory.md",
      scope: "global",
      role: "legacy",
      exists: true,
      editable: true,
      injected: false,
      bytes: 40,
      tokens: 18,
      updatedAt: Date.now(),
      hash: null,
      facts: [],
    },
  ];
  function mockMemoryState(): MemoryStateUi {
    return {
      home: mockMemoryHome,
      cwd: mockMemoryRoot,
      workspaceRoots: [mockMemoryRoot],
      files: mockMemoryFiles,
      globalPrimary:
        mockMemoryFiles.find((f) => f.scope === "global" && f.role === "primary")?.path ?? null,
      projectPrimary:
        mockMemoryFiles.find((f) => f.scope === "project" && f.role === "primary")?.path ?? null,
      knowledge: {
        dir: `${mockMemoryRoot}\\.iflow\\knowledge`,
        index: mockKnowledgeDocs.find((doc) => doc.path.endsWith("index.md")) ?? null,
        docs: mockKnowledgeDocs,
        managedBy: `${mockMemoryRoot}\\AGENTS.md`,
        injectedTokens: mockKnowledgeDocs
          .filter((doc) => doc.injected)
          .reduce((sum, doc) => sum + doc.tokens, 0),
      },
    };
  }
  function mockFileFor(path: string): MemoryFileUi | undefined {
    return mockMemoryFiles.find((f) => f.path === path);
  }
  function mockMemorySaved(
    file: MemoryFileUi,
    path = file.path,
    requestId?: number,
  ): HostToWebview {
    mockMemoryFiles = mockMemoryFiles.map((f) => (f.path === file.path ? file : f));
    return {
      type: "memorySaved",
      path,
      ok: true,
      file,
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }
  function mockAppendFact(scope: MemoryScope, fact: string, path?: string): MemoryFileUi | undefined {
    const target =
      (path ? mockFileFor(path) : undefined) ??
      mockMemoryFiles.find((f) => f.scope === scope && f.role === "primary");
    if (!target) return undefined;
    const content = mockMemoryContent.get(target.path) ?? "";
    const next = content.includes("## iFlow Added Memories")
      ? `${content.trimEnd()}\n- ${fact.trim()}\n`
      : `${content.trimEnd()}\n\n## iFlow Added Memories\n- ${fact.trim()}\n`;
    mockMemoryContent.set(target.path, next);
    const file: MemoryFileUi = {
      ...target,
      exists: true,
      bytes: next.length,
      tokens: Math.max(1, Math.ceil(next.length / 4)),
      updatedAt: Date.now(),
      facts: [...(target.facts ?? []), { id: `${Date.now()}:mock`, text: fact.trim() }],
    };
    return file;
  }
  const demoBlocks: SessionState["blocks"] = [
    {
      // Mirrors the editor right-click "加入 iFlow 上下文" draft so the
      // user-bubble code-context styling (styles.css) is visible in mock mode.
      kind: "user",
      id: "demo-u1",
      text: [
        "关于 `src/panel/panel.ts:120-145`：",
        "",
        "```ts",
        "function pushSnapshot(state: SessionState): void {",
        "  state.blocks = next.blocks; // full swap, identity changes",
        "  state.status = next.status;",
        "  state.blockVersion = ++version;",
        "}",
        "```",
        "",
      ].join("\n"),
    },
    {
      kind: "user",
      id: "demo-u2",
      text: "帮我看看这个仓库结构",
      images: [
        "data:image/svg+xml;base64," +
          btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="64" height="64" rx="12" fill="url(#g)"/></svg>',
          ),
      ],
    },
    {
      kind: "thought",
      // Demo thought carries a fence: the card renders code with syntax colors
      // on a transparent plate and soft-wrapped lines, so the mock snapshot
      // shows that treatment.
      text: "用户想了解仓库结构，先列出目录。\n\n```tsx\nconst rows = items.map((item) => ({ key: item.id, label: item.displayPath, value: item.path }));\n```",
    },
    {
      kind: "tool",
      id: "demo-shell-block",
      toolCallId: "demo-shell",
      toolName: "run_shell_command",
      title: "run_shell_command",
      toolKind: "execute",
      status: "in_progress",
      input: "npm run webview:serve",
      output: Array.from({ length: 80 }, (_, i) => `VITE v8.0.0  ready in ${120 + i} ms`).join("\n"),
      locations: [],
      diff: null,
    },
    {
      kind: "tool",
      toolCallId: "demo-search",
      toolName: "search_file_content",
      title: "search_file_content",
      toolKind: "search",
      status: "completed",
      input: '{"pattern":"refreshSessionUsage","path":"j:\\\\git\\\\iflow-harness\\\\src\\\\panel\\\\store.ts"}',
      output: "找到 6 个匹配",
      locations: [],
      diff: null,
    },
    {
      kind: "tool",
      toolCallId: "demo-mcp",
      toolName: "firecrawl__web_fetch",
      title: "firecrawl__web_fetch",
      toolKind: "other",
      status: "completed",
      input: '{"url":"https://mcp.dev/introduction"}',
      output: "Fetched 12,480 chars",
      locations: [],
      diff: null,
    },
    {
      kind: "tool",
      toolCallId: "demo-1",
      toolName: "list_directory",
      title: "Listing j:\\git\\iflow-harness",
      toolKind: "read",
      status: "completed",
      output: "AGENTS.md\nCHANGELOG.md\nREADME.md\npackage.json\nshared\nsrc\nwebview",
      locations: [{ path: "j:\\git\\iflow-harness", line: null }],
      diff: null,
    },
    {
      kind: "tool",
      toolCallId: "demo-2",
      toolName: "edit_file",
      title: "Edit src/panel/store.ts",
      toolKind: "edit",
      status: "completed",
      output: "",
      locations: [{ path: "j:\\git\\iflow-harness\\src\\panel\\store.ts", line: 212 }],
      diff: {
        path: "j:\\git\\iflow-harness\\src\\panel\\store.ts",
        oldText: [
          "export function refreshSessionUsage(state: SessionState): void {",
          "  const usage = estimateUsage(state);",
          "  state.usage = usage;",
          "  state.usageEstimated = true;",
          "  pushSnapshot(state);",
          "}",
          "",
          "// 流式期间按 500ms 节流刷新，避免逐 token 重算 BPE。",
        ].join("\n"),
        newText: [
          "export function refreshSessionUsage(state: SessionState): void {",
          "  const usage = estimateUsage(state);",
          "  // 数值不变时保持引用稳定，省掉一次整树重渲染。",
          "  if (usage.totalTokens === state.usage?.totalTokens) return;",
          "  state.usage = usage;",
          "  state.usageEstimated = true;",
          "  pushSnapshot(state);",
          "}",
          "",
          "// 流式期间按 500ms 节流刷新，避免逐 token 重算 BPE。",
        ].join("\n"),
      },
    },
    {
      kind: "subagent",
      agentId: "demo-agent-1",
      taskToolCallId: "demo-task-1",
      title: "Launch agent(general-purpose): 读取 package.json 的 name",
      status: "completed",
      agentType: "general-purpose",
      tokens: 150,
      startedAt: Date.now() - 12_000,
      completedAt: Date.now() - 2_000,
      entries: [
        { kind: "subagent", id: "demo-child", agentId: "demo-child", taskToolCallId: "demo-child-task", title: "Launch agent(explore-agent): package metadata", status: "completed", agentType: "explore-agent", tokens: 50, startedAt: Date.now() - 8_000, completedAt: Date.now() - 3_000, entries: [{ kind: "text", text: "Package metadata checked.", tokens: 50 }] },
        { kind: "tool", toolCallId: "sa-1", toolName: "read_file", title: "Reading j:\\git\\iflow-harness\\package.json", toolKind: "read", status: "completed", output: "", locations: [], diff: null },
        { kind: "tool", toolCallId: "sa-2", toolName: "run_shell_command", title: "Running: node --version; npm --version", toolKind: "execute", status: "completed", output: "", locations: [], diff: null },
      ],
    },
    {
      kind: "injected",
      notice: "这次请求还自动带上了 4 项内容：系统提示词、全局记忆、1 个项目记忆文件、1 个知识库文档",
      tokens: 31320,
      items: [
        {
          kind: "system",
          label: "系统提示词",
          content:
            "You are iFlow CLI, an interactive CLI agent...\n（mock：核心提示词，完整正文由 acp-context-report Mod 捕获）",
        },
        {
          kind: "memory",
          label: "全局记忆",
          path: "C:\\Users\\mock\\.iflow\\AGENTS.md",
          content: "## iFlow Added Memories\n- 偏好中文回复，代码注释用英文。\n（mock：全局记忆正文）",
        },
        {
          kind: "context-file",
          label: "AGENTS.md",
          path: "J:\\git\\iflow-harness\\AGENTS.md",
          content: "# AGENTS.md\n\n项目概览…（mock：项目记忆正文）",
        },
        {
          kind: "knowledge",
          label: "项目知识库",
          path: "J:\\git\\iflow-harness\\.iflow\\knowledge\\index.md",
          content: "# 项目知识索引\n\n## 概览\n…（mock：知识库正文，由 @.iflow/knowledge/index.md 展开）",
        },
      ],
    },
    {
      kind: "compression",
      notice: "上下文已压缩：98134 → 7855 tokens",
      newTokenCount: 7855,
      summary:
        "This session is being continued from a previous conversation that ran out of context.\n\n按时间顺序分析这次对话：\n\n- 任务背景：把自绘控件收敛到 `webview/src/components/ui.tsx`（控件之家），涉及 `MessageList`、`SettingsModal`、`Composer` 三个调用点。",
    },
    {
      kind: "text",
      text: [
        "这是 **iflow-harness** 仓库：`src/` 是扩展宿主，`shared/` 是纯 reducer，`webview/` 是 React 界面，执行体为内置裁剪版内核。\n\n- 需要我深入看某个部分吗？",
        "",
        "```json",
        '{',
        '  "name": "iflow-harness",',
        '  "version": "2.0.0",',
        '  "main": "./dist/extension.cjs",',
        '  "scripts": { "build": "npm run icon && tsc && node esbuild.mjs && vite build webview" }',
        '}',
        "```",
        "",
        "```python",
        "def fib(n: int) -> int:",
        '    """返回第 n 个斐波那契数。"""',
        "    if n < 2:  # 递归出口",
        "        return n",
        "    return fib(n - 1) + fib(n - 2)",
        "```",
      ].join("\n"),
    },
    {
      kind: "text",
      // Mock a delegation turn: one ```super-agent block carrying THREE task
      // briefs. The transcript renders each brief as its own card (the mock
      // host is the frontend's dev surface, so browser iteration needs a
      // sample that exercises the split-card layout).
      text: [
        "这三个任务书我拆给三个超流体并行做：",
        "",
        "```super-agent",
        JSON.stringify(
          {
            tasks: [
              {
                title: "修复登录跳转",
                task: [
                  "修好 src/auth.ts 的登录跳转：redirect 分支的条件写反了，401 回跳到登录页而不是首页。",
                  "",
                  "具体步骤：",
                  "1. 读 src/auth.ts，找到 redirect 判断那一行，把条件改成 authError.code === 401。",
                  "2. 补一个覆盖 401 回跳的单测（test/auth.test.ts），断言回跳目标 URL。",
                  "3. 跑 npx vitest run test/auth.test.ts 与 npm run typecheck 验证。",
                  "",
                  "约束：不要顺手重构 auth.ts 的其它逻辑，改动越少越好。",
                ].join("\n"),
                attachments: [{ path: "src/auth.ts" }],
              },
              {
                title: "补 README 的登录章节",
                task: "更新 README 的登录章节，说明 API Profile 的切换方式与凭据只存在 SecretStorage。",
                attachments: [{ path: "README.md" }],
              },
              {
                title: "核对 CI 脚本",
                task: "确认 release workflow 与 CHANGELOG 顶部版本一致，并跑一遍 npm run typecheck。",
                attachments: [{ path: ".github/workflows/release.yml" }],
              },
            ],
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    },
    {
      kind: "text",
      // Single-task delegation sample: exercises the "one card, no 1/1 chip"
      // branch in SuperDirectiveCard (the 3-task block above only covers the
      // batch layout).
      text: [
        "这一件只需要一个超流体：",
        "",
        "```super-agent",
        JSON.stringify(
          {
            tasks: [
              {
                title: "只跑一次 typecheck",
                task: "在仓库根目录运行 npm run typecheck，把真实输出（通过/失败与错误行）如实汇报。",
              },
            ],
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    },
    {
      kind: "text",
      // CommonMark 合法、但旧切分器不认的围栏形态：收栏带 2 空格缩进。
      // marked 会把它渲染成 language-super-agent 代码块，所以浏览器验收需要
      // 这份样本确认它同样出任务卡（而不是一堵 JSON 墙）。
      text: [
        "缩进围栏的委派块也要出卡片：",
        "",
        "  ```super-agent",
        JSON.stringify(
          {
            tasks: [
              {
                title: "缩进围栏任务",
                task: "这条任务书的开栏与收栏都带 2 空格缩进（CommonMark 允许最多 3 个空格）。",
              },
            ],
          },
          null,
          2,
        ),
        "  ```",
      ].join("\n"),
    },
    { kind: "plan", id: "demo-plan", entries: [{ content: "M1 最小面板", status: "completed" }, { content: "M2 工具可视化 + 审批", status: "in_progress" }] },
  ];
  const demoApproval: SessionState["pendingApproval"] = {
    id: "perm-demo-1",
    toolName: "write_file",
    title: "Write webview/src/components/ui.tsx",
    toolKind: "edit",
    locations: [{ path: "j:\\git\\iflow-harness\\webview\\src\\components\\ui.tsx", line: null }],
    options: [
      { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
      { optionId: "allow-always", name: "本次会话始终允许", kind: "allow_always" },
      { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
    ],
    // Mock the real host: 5-minute expiry window.
    deadline: Date.now() + 5 * 60_000,
    timeoutMs: 5 * 60_000,
  };
  const demoQuestions: SessionState["pendingQuestions"] = {
    id: "question-demo-1",
    // 30s answer window for the demo.
    deadline: Date.now() + 30_000,
    timeoutMs: 30_000,
    questions: [
      {
        header: "方案",
        question: "你希望用哪种方案实现？",
        multiSelect: false,
        options: [
          { label: "方案 A", description: "基于现有组件改造，改动小、风险低" },
          { label: "方案 B", description: "全新重写，结构更清晰但工作量大" },
          { label: "暂不决定", description: "先讨论更多细节再选" },
        ],
      },
      {
        header: "范围",
        question: "本次改动覆盖范围？",
        multiSelect: true,
        options: [
          { label: "前端", description: "仅 webview 界面层" },
          { label: "后端", description: "host 与 ACP 协议层" },
          { label: "测试", description: "补充 vitest 用例" },
        ],
      },
    ],
  };
  // Mirrors real host semantics: the approval card is consumed once answered;
  // mode/model switches must NOT clear it.
  let activeApproval: SessionState["pendingApproval"] = demoApproval;
  /**
   * M2 P0-3 mock queue: entries typed while the demo turn streams. The mock
   * settles the turn (approval answer OR a 6s fallback) and then dispatches
   * the head, mirroring the host's queue lifecycle for browser iteration.
   */
  const mockQueue: Array<{ id: string; text: string; attachments: string[]; enqueuedAt: number }> = [];
  let mockQueuePaused = false;
  let mockTurnEndTimer: number | null = null;
  let mockQueueSeq = 0;
  /** Current demo turn status — the sendPrompt handler enqueues while it is
   * "streaming" (mirrors the host's queue gate). */
  let mockStatus: "streaming" | "idle" = "idle";
  function broadcastDemo(status: "streaming" | "idle", stopReason: SessionState["stopReason"]): void {
    mockStatus = status;
    broadcast({
      type: "snapshot",
      state: {
        blocks: [...demoBlocks],
        status,
        errorMessage: null,
        stopReason,
        ...demoMeta,
        queue: [...mockQueue],
        queuePaused: mockQueuePaused,
        pendingApproval: activeApproval,
        auth: authState,
      },
    });
  }
  const mockNextSteps = ["继续实现上下文压缩", "运行测试", "查看改动"];
  function settleMockTurn(): void {
    if (mockTurnEndTimer !== null) {
      window.clearTimeout(mockTurnEndTimer);
      mockTurnEndTimer = null;
    }
    demoMeta.nextStepSuggestions = mockHostSettings.nextStepSuggestions ? [...mockNextSteps] : [];
    if (mockQueuePaused || mockQueue.length === 0) {
      broadcastDemo("idle", "end_turn");
      return;
    }
    const head = mockQueue.shift()!;
    broadcastDemo("idle", "end_turn");
    window.setTimeout(() => sendPromptFlow(head.text), 120);
  }
  /**
   * Reproduces the real wire timeline: sendPrompt → streaming → permission
   * request arrives mid-flight → user answers → response continues → idle.
   */
  function sendPromptFlow(text: string, images?: string[]): void {
    // Mirror beginUserPrompt (shared/session-state.ts): images ride the user
    // block as data URLs, exactly like panel.ts sendPrompt assembles them.
    demoBlocks.push(
      images && images.length > 0
        ? { kind: "user", id: `demo-u-${Date.now()}`, text, images }
        : { kind: "user", id: `demo-u-${Date.now()}`, text },
    );
    demoMeta.nextStepSuggestions = [];
    // Real host behavior: the newest session gets labeled by its first prompt.
    const current = demoMeta.sessions.find((s) => s.id === demoMeta.activeSessionId);
    if (current && (current.label === "（无标题会话）" || demoMeta.sessions[0] === current)) {
      demoMeta.sessions = [
        { ...current, label: text.slice(0, 60) },
        ...demoMeta.sessions.filter((s) => s.id !== current.id),
      ];
    }
    broadcastDemo("streaming", null);
    // Mid-stream permission request (agent blocks waiting for the answer).
    window.setTimeout(() => {
      activeApproval = demoApproval;
      broadcastDemo("streaming", null);
    }, 400);
    // Fallback settle (M2): if the demo approval card is never answered, the
    // turn still lands idle after 6s so the queue strip / steer flow stays
    // exercisable in browser debug mode.
    if (mockTurnEndTimer !== null) window.clearTimeout(mockTurnEndTimer);
    mockTurnEndTimer = window.setTimeout(() => {
      activeApproval = null;
      settleMockTurn();
    }, 6_000);
  }
  /**
   * Super Agent demo children — one running, one waiting for the user, one
   * finished. Mirrors the real host projection so the board can be exercised
   * in browser debug mode (the mock host is the frontend's dev surface).
   */
  const demoSuperSessions: SuperSessionUi[] = [
    {
      id: "super-demo-1",
      title: "修复登录跳转",
      task: "修复 src/auth.ts 的登录跳转逻辑并补一个单测",
      status: "running",
      runId: "run-auth-fix",
      wave: 0,
      attempts: 2,
      maxAttempts: 3,
      statusDetail: "第 2 次尝试：正在补 401 回跳单测",
      diagnostics: [
        {
          at: Date.now() - 65_000,
          kind: "spawn",
          level: "info",
          message: "已派发：修复 src/auth.ts 的登录跳转",
        },
        {
          at: Date.now() - 62_000,
          kind: "session",
          level: "info",
          message: "超流体已启动，模型 glm-5.3-flash-free",
        },
        {
          at: Date.now() - 18_000,
          kind: "retry",
          level: "warn",
          message: "网关瞬时超时，自动重试第 2 次",
          detail: "工具调用 read_file 超时后自动重试；最大尝试 3 次",
        },
        {
          at: Date.now() - 8_000,
          kind: "report",
          level: "info",
          message: "已定位 redirect 条件写反，正在补 401 回跳单测",
        },
      ],
      isolation: {
        kind: "git_worktree",
        path: "C:/Users/demo/.vscode-iflow/super-worktrees/api-a1b2c3d/fix-login-x7",
        branch: "iflow/super/fix-login-x7",
        baseRef: "a1b2c3d",
      },
      createdAt: Date.now() - 65_000,
      updatedAt: Date.now() - 2_000,
      startedAt: Date.now() - 62_000,
      model: "glm-5.3-flash-free",
      progress:
        "已定位到 src/auth.ts 的 redirect 分支条件写反了。\n正在补一个覆盖 401 回跳的单测。",
      reports: [
        { state: "progress", summary: "读取 src/auth.ts 与相关单测", at: Date.now() - 50_000 },
      ],
    },
    {
      id: "super-demo-2",
      title: "补充会话状态单测",
      task: "为 shared/session-state.ts 的 reducer 补一组单测",
      status: "awaiting_input",
      statusDetail: "等待选择单测覆盖范围",
      diagnostics: [
        {
          at: Date.now() - 120_000,
          kind: "spawn",
          level: "info",
          message: "已派发：补会话状态单测",
        },
        {
          at: Date.now() - 118_000,
          kind: "session",
          level: "info",
          message: "超流体已启动",
        },
        {
          at: Date.now() - 20_000,
          kind: "blocked",
          level: "warn",
          message: "等待用户回答测试范围",
        },
      ],
      isolation: {
        kind: "git_worktree",
        path: "C:/Users/demo/.vscode-iflow/super-worktrees/api-a1b2c3d/add-tests-k3",
        branch: "iflow/super/add-tests-k3",
        baseRef: "a1b2c3d",
      },
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 20_000,
      startedAt: Date.now() - 118_000,
      pending: {
        kind: "question",
        requestId: "super-demo-2-question-1",
        questions: [
          {
            header: "测试范围",
            question: "这一组单测要覆盖压缩卡还是只覆盖用量估算？",
            multiSelect: false,
            options: [
              { label: "只覆盖用量估算", description: "范围小、跑得快" },
              { label: "连压缩卡一起覆盖", description: "更完整，但要多写夹具" },
            ],
          },
        ],
        deadline: Date.now() + 240_000,
        timeoutMs: 300_000,
      },
      reports: [],
    },
    {
      id: "super-demo-3",
      title: "梳理依赖",
      task: "梳理 package.json 的依赖，找出冗余项",
      status: "completed",
      runId: "run-docs-batch",
      wave: 0,
      batch: 1,
      diagnostics: [
        {
          at: Date.now() - 300_000,
          kind: "spawn",
          level: "info",
          message: "已派发：梳理依赖（批次 1）",
        },
        {
          at: Date.now() - 298_000,
          kind: "session",
          level: "info",
          message: "超流体已启动，模型 deepseek-v4-pro",
        },
        {
          at: Date.now() - 190_000,
          kind: "report",
          level: "info",
          message: "已扫描 package.json 与 node_modules 引用",
        },
        {
          at: Date.now() - 180_000,
          kind: "merge",
          level: "info",
          message: "分支已自动合并到 main",
          detail: "iflow/super/deps-m2 → main",
        },
      ],
      isolation: {
        kind: "git_worktree",
        path: "C:/Users/demo/.vscode-iflow/super-worktrees/api-a1b2c3d/deps-m2",
        branch: "iflow/super/deps-m2",
        baseRef: "a1b2c3d",
      },
      createdAt: Date.now() - 300_000,
      updatedAt: Date.now() - 180_000,
      startedAt: Date.now() - 298_000,
      endedAt: Date.now() - 180_000,
      summary: "已梳理依赖：未发现冗余项；gpt-tokenizer 与 cytoscape 均为运行时必需。",
      model: "deepseek-v4-pro",
      progress: "依赖梳理完成：未发现冗余项。",
      tokens: {
        input: 18_420,
        output: 2_140,
        cachedRead: 6_000,
        estimatedCost: 0.0227,
        authoritative: true,
      },
      integration: {
        mode: "merge",
        state: "merged",
        detail: "已合入 main",
        at: Date.now() - 179_000,
      },
      reports: [
        {
          state: "progress",
          summary: "已扫描 package.json 与 node_modules 引用",
          at: Date.now() - 260_000,
        },
        {
          state: "ready",
          summary: "已梳理依赖：未发现冗余项。",
          at: Date.now() - 180_000,
        },
      ],
    },
    {
      id: "super-demo-4",
      title: "整理文档配图",
      task: "把 docs/images 里的截图按章节重命名",
      status: "completed",
      runId: "run-docs-batch",
      wave: 1,
      batch: 2,
      diagnostics: [
        {
          at: Date.now() - 420_000,
          kind: "spawn",
          level: "info",
          message: "已派发：整理文档配图（批次 2）",
        },
        {
          at: Date.now() - 418_000,
          kind: "session",
          level: "info",
          message: "超流体已启动（仅目录隔离）",
        },
        {
          at: Date.now() - 400_000,
          kind: "report",
          level: "info",
          message: "已按章节重命名 12 张截图",
        },
      ],
      isolation: {
        kind: "directory",
        path: "C:/Users/demo/.vscode-iflow/super-dirs/docs-m4",
        note: "当前目录不是 git 仓库，仅目录隔离",
      },
      createdAt: Date.now() - 420_000,
      updatedAt: Date.now() - 400_000,
      startedAt: Date.now() - 418_000,
      endedAt: Date.now() - 400_000,
      summary: "已按章节重命名 12 张截图；没有删改任何文件内容。",
      model: "glm-5.3-flash-free",
      progress: "已按章节重命名 12 张截图。",
      tokens: {
        input: 7_300,
        output: 880,
        estimatedCost: 0.0083,
        authoritative: true,
      },
      reports: [],
    },
    {
      id: "super-demo-5",
      title: "重构 MCP 配置解析",
      task: "把 shared/mcp-catalog.ts 的解析逻辑拆成可单测的小函数",
      status: "failed",
      runId: "run-auth-fix",
      wave: 1,
      dependsOn: ["修复登录跳转"],
      attempts: 2,
      maxAttempts: 3,
      lastError: {
        kind: "retryable",
        message: "内核退出（code=1）：解析 MCP 配置缺少必填字段",
        at: Date.now() - 500_000,
      },
      statusDetail: "上游登录修复未完成，本轮解析逻辑重构中止",
      diagnostics: [
        {
          at: Date.now() - 540_000,
          kind: "spawn",
          level: "info",
          message: "已派发：重构 MCP 配置解析（依赖「修复登录跳转」）",
        },
        {
          at: Date.now() - 538_000,
          kind: "session",
          level: "info",
          message: "超流体已启动",
        },
        {
          at: Date.now() - 516_000,
          kind: "retry",
          level: "warn",
          message: "第 2 次尝试",
          detail: "上一次在读取 shared/mcp-catalog.ts 时中断",
        },
        {
          at: Date.now() - 500_000,
          kind: "error",
          level: "error",
          message: "内核退出（code=1）：解析 MCP 配置缺少必填字段",
          detail: "lastError.kind=retryable，可在看板点「重试」",
        },
      ],
      isolation: {
        kind: "git_worktree",
        path: "C:/Users/demo/.vscode-iflow/super-worktrees/api-a1b2c3d/mcp-parse-r8",
        branch: "iflow/super/mcp-parse-r8",
        baseRef: "a1b2c3d",
      },
      createdAt: Date.now() - 540_000,
      updatedAt: Date.now() - 500_000,
      startedAt: Date.now() - 538_000,
      endedAt: Date.now() - 500_000,
      error: "超流体内核退出（code=1）",
      reports: [],
    },
  ];

  /**
   * Live-pane fixture for browser verification. The pane renders with the
   * flat chrome variant, so the demo buffer needs the block kinds that used to
   * carry a card surface: reasoning, a completed replace with a structured
   * diff, and a still-running shell command.
   */
  const demoSuperTranscripts: Record<string, Block[]> = {
    "super-demo-1": [
      {
        kind: "text",
        id: "demo-super-text-1",
        text: "已定位到 src/auth.ts 的 redirect 分支条件写反了，先修这一处，再补一个 401 回跳的单测。",
      },
      {
        kind: "thought",
        id: "demo-super-thought-1",
        text: "先确认 redirect 的判断条件：401 应该回跳到登录页，当前实现把状态码比较写反了；改完再跑一次单测确认没有回归。",
      },
      {
        kind: "tool",
        id: "demo-super-tool-1",
        toolCallId: "demo-super-call-1",
        toolName: "replace",
        title: "替换内容",
        toolKind: "edit",
        status: "completed",
        output: "已应用 1 处改动",
        locations: [{ path: "src/auth.ts" }],
        diff: {
          path: "src/auth.ts",
          oldText: "  if (status === 401) {\n    return redirectToLogin();\n  }\n  return next();",
          newText: "  if (status !== 401) {\n    return next();\n  }\n  return redirectToLogin();",
        },
      },
      {
        kind: "tool",
        id: "demo-super-tool-2",
        toolCallId: "demo-super-call-2",
        toolName: "run_shell_command",
        title: "run_shell_command",
        toolKind: "execute",
        status: "in_progress",
        input: "npx vitest run test/auth.test.ts",
        output: " RUN  v5.0.0 test/auth.test.ts\n\n ✓ test/auth.test.ts (6 tests) 412ms",
        locations: [],
        diff: null,
      },
      {
        kind: "tool",
        id: "demo-super-tool-3",
        toolCallId: "demo-super-call-3",
        toolName: "run_shell_command",
        title: "run_shell_command",
        toolKind: "execute",
        status: "completed",
        input:
          "npx vitest run test/session-state.test.ts --reporter=verbose --silent=false --bail=0 --pool=threads --poolOptions.threads.singleThread=false",
        output:
          " RUN  v5.0.0 test/session-state.test.ts\n\n ✓ applySessionUpdate > 追加文本块 (3)\n ✓ applySessionUpdate > 工具块更新 (5)\n ✓ block ids > 回填唯一 id (4)\n\n Test Files  1 passed (1)\n      Tests  16 passed (16)",
        locations: [],
        diff: null,
      },
    ],
    "super-demo-2": [
      {
        kind: "text",
        id: "demo-super-text-2",
        text: "读完了 shared/session-state.ts 的 reducer 与现有用例，正在确认这组单测的覆盖范围。",
      },
    ],
  };

  const demoMeta = {
    sessionId: "mock-session",
    superSessions: demoSuperSessions,
    // 多仓库协作：demo 根集合（真实宿主会覆盖）。selected 与 applied 故意不同，
    // 让「新会话生效」提示在 mock 里可见。
    workspaceRoots: {
      roots: [
        { path: "J:\\git\\iflow-harness", name: "iflow-harness" },
        { path: "J:\\git\\iflow-fork", name: "iflow-fork" },
      ],
      selected: ["J:\\git\\iflow-harness", "J:\\git\\iflow-fork"],
      applied: ["J:\\git\\iflow-harness"],
      pendingChange: true,
    },
    qqTasks: [] as SessionState["qqTasks"],
    modes: { currentModeId: "smart", availableModes: [
      { id: "smart", name: "Smart" }, { id: "yolo", name: "YOLO" },
      { id: "default", name: "Default" },
    ] },
    commands: [
      { name: "init", description: "分析项目并创建或更新定制的 IFLOW.md 文件" },
      { name: "commit", description: "分析您的更改并创建有意义的提交消息" },
    ],
    // Skills the CLI reports on session/new (`_meta.availableSkills`) — the
    // composer turns each into a `/skill <name>` slash entry. The long name
    // mirrors real skill names (the popup must stay one row per entry).
    skills: [
      { name: "pdf", description: "读取与生成 PDF 文档", scope: "global" },
      { name: "xlsx", description: "读取与生成 Excel 表格", scope: "global" },
      {
        name: "code-review",
        description:
          "Systematic code review patterns covering security, performance, maintainability, correctness, and testing — with severity levels and structured feedback guidance.",
        scope: "global",
      },
    ],
    // Mirrors a live GET {baseUrl}/models response (ids only).
    models: [
      { id: "glm-5.3-flash-free", name: "glm-5.3-flash-free" },
      { id: "glm-5", name: "glm-5" },
      { id: "deepseek-v3.2-chat", name: "deepseek-v3.2-chat" },
      { id: "kimi-k2.5", name: "kimi-k2.5" },
      { id: "claude-opus-5", name: "claude-opus-5" },
    ],
    currentModelId: "glm-5.3-flash-free",
    thinkLevel: "auto" as SessionState["thinkLevel"],
    // Demo token usage (mirrors the host-estimated SessionUsageUi shape) so
    // the usage chip next to the model dropdown is visible in mock mode.
    usage: {
      inputTokens: 48732,
      outputTokens: 7441,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 56173,
      contextWindow: 200_000,
      contextUsed: 56173,
      estimated: false,
      // The fixed prefill the model carries on every request (system prompt /
      // memory / tool declarations) is part of the occupancy, not of the
      // conversation — it mirrors the injected card's own token total below
      // (the host measures both from the same context report).
      prefillTokens: 31320,
      breakdown: { user: 3211, assistant: 5120, tool: 14201, thought: 2321, prefill: 31320 },
      estimatedCost: 0.0271,
    },
    // M4 demo: two persisted sessions; switching restores a short transcript.
    // The old one ships archived so the switcher's collapsed section is
    // visible in mock mode (M4 P1-8).
    sessions: [
      { id: "mock-session", label: "帮我看看这个仓库结构", updatedAt: Date.now() },
      { id: "mock-session-old", label: "上次的重构讨论", updatedAt: Date.now() - 86_400_000, archived: true },
    ] as SessionSummaryUi[],
    activeSessionId: "mock-session",
    // Demo: surface the question card so the option-description UI is visible
    // in browser debug mode.
    pendingQuestions: demoQuestions as SessionState["pendingQuestions"],
    pendingProfileSwitch: null as SessionState["pendingProfileSwitch"],
    replaying: false,
    initializing: false,
    compressing: false,
    nextStepSuggestions: [...mockNextSteps],
  };
  // M3 demo: start unauthenticated so the setup banner shows; saved state
  // mirrors what the real host stores (masked, never the raw key).
  let authState: SessionState["auth"] = {
    authenticated: true,
    needsSetup: false,
    saved: { baseUrl: "https://api.example.com/v1", modelName: "deepseek-v4-pro", keyTail: "...9999" },
    profiles: [
      { name: "BUZZ", baseUrl: "https://api.buzzgw.com/v1", modelName: "glm-5.3-flash-free", keyTail: "…mock", active: false },
      { name: "工作密钥", baseUrl: "https://api.example.com/v1", modelName: "deepseek-v4-pro", keyTail: "…9999", active: true },
    ],
    onboardingDismissed: false,
  };
  /** The profile named in the open switch dialog (respondProfileSwitch target). */
  let pendingSwitchTarget: string | null = null;
  /** Apply a profile switch and broadcast the snapshot (shared by the
   * dialog-answer path and the no-session fast path). `keepSession=false`
   * mirrors the real host's new-session flow (transcript cleared); `true`
   * mirrors the seamless in-place reload (transcript untouched). */
  function applyProfileSwitch(name: string, keepSession: boolean): void {
    const activated = authState.profiles.find((p) => p.name === name);
    authState = {
      ...authState,
      authenticated: true,
      needsSetup: false,
      profiles: authState.profiles.map((p) => ({ ...p, active: p.name === name })),
    };
    if (activated) {
      // Switching profiles re-queries /models on the new endpoint.
      demoMeta.models = [
        { id: activated.modelName, name: activated.modelName },
        ...demoMeta.models.filter((x) => x.id !== activated.modelName),
      ];
      demoMeta.currentModelId = activated.modelName;
    }
    if (!keepSession) demoBlocks.length = 0;
    broadcast({
      type: "snapshot",
      state: {
        blocks: [...demoBlocks],
        status: "idle",
        errorMessage: null,
        stopReason: "end_turn",
        ...demoMeta,
        pendingApproval: null,
        auth: authState,
      },
    });
  }
  // Mirrors the host's connectEpoch counter so the splash can be exercised
  // outside VSCode: restartCli re-enters `connecting` with a bumped epoch,
  // then the "fresh Core" finishes booting and the panel comes back.
  let mockConnectEpoch = 0;
  return {
    postMessage(msg) {
      const m = msg as WebviewToHost;
      if (m.type === "restartCli") {
        broadcast({
          type: "snapshot",
          state: {
            blocks: [],
            status: "connecting",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            connectEpoch: mockConnectEpoch + 1,
            pendingApproval: null,
            auth: authState,
          },
        });
        mockConnectEpoch += 1;
        setTimeout(() => {
          broadcast({
            type: "snapshot",
            state: {
              blocks: demoBlocks,
              status: "idle",
              errorMessage: null,
              stopReason: "end_turn",
              ...demoMeta,
              connectEpoch: mockConnectEpoch,
              pendingApproval: null,
              auth: authState,
            },
          });
        }, 1500);
        return;
      }
      if (m.type === "ready") {
        broadcast({ type: "theme", kind: mockTheme });
        broadcast({ type: "hostSettings", ...mockHostSettings });
        broadcast({ type: "contextWindowOverrides", ...mockContextWindowOverrides });
        // QQ channels are independent of the transcript snapshot (the real
        // host pushes them separately), so the mock must seed them too —
        // otherwise the settings hub's QQ tab renders empty tables.
        broadcast({ type: "qqSettings", values: mockQqSettings });
        broadcast({ type: "qqStatus", connected: false });
        broadcast({ type: "qqTakeoverState", active: false });
        broadcast({
          type: "snapshot",
          state: {
            blocks: demoBlocks,
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "qqTakeover") {
        broadcast({ type: "qqTakeoverState", active: m.action === "start" });
        if (m.action === "start") {
          broadcast({
            type: "toast",
            level: "info",
            message: "远程接管中…",
            toastId: mockTakeoverToastId,
            persistent: true,
            displayOnly: true,
          });
        } else {
          broadcast({ type: "dismissToast", toastId: mockTakeoverToastId });
        }
        return;
      }
      if (m.type === "qqSettingsPatch") {
        mockQqSettings = pickQqSettingsUi(
          { ...mockQqSettings, ...m.patch } as Record<string, unknown>,
          { hasAppSecret: mockQqSettings.hasAppSecret },
        );
        broadcast({ type: "qqSettings", values: mockQqSettings });
        return;
      }
      if (m.type === "requestTurnChanges") {
        broadcast({
          type: "turnChanges",
          sessionId: m.sessionId,
          userBlockId: m.userBlockId,
          requestId: m.requestId,
          records:
            m.sessionId === demoMeta.activeSessionId
              ? collectTurnChanges(demoBlocks, m.userBlockId)
              : [],
          unavailable: false,
        });
        return;
      }
      if (m.type === "setHostSettings") {
        const { type, ...patch } = m;
        void type;
        Object.assign(mockHostSettings, patch);
        if (m.nextStepSuggestions === false) {
          demoMeta.nextStepSuggestions = [];
          broadcast({
            type: "snapshot",
            state: {
              blocks: [...demoBlocks],
              status: mockStatus,
              errorMessage: null,
              stopReason: mockStatus === "idle" ? "end_turn" : null,
              ...demoMeta,
              pendingApproval: activeApproval,
              auth: authState,
            },
          });
        }
        applyUiScale(mockHostSettings.uiFontSize, mockHostSettings.uiDensity);
        broadcast({ type: "hostSettings", ...mockHostSettings });
        return;
      }
      if (m.type === "setContextWindowOverrides") {
        mockContextWindowOverrides = { ...mockContextWindowOverrides, overrides: [...m.overrides] };
        mockHostSettings.contextWindowOverrides = [...m.overrides];
        broadcast({ type: "contextWindowOverrides", ...mockContextWindowOverrides });
        return;
      }
      if (m.type === "saveAuth") {
        // P3: empty apiKey means "keep the stored one" — preserve its masked tail.
        const keyTail = m.apiKey
          ? m.apiKey.length > 4
            ? `…${m.apiKey.slice(-4)}`
            : "…"
          : authState.saved?.keyTail ?? "…";
        const name = m.profileName?.trim() || m.modelName;
        authState = {
          authenticated: true,
          needsSetup: false,
          saved: { baseUrl: m.baseUrl, modelName: m.modelName, keyTail },
          profiles: [
            { name, baseUrl: m.baseUrl, modelName: m.modelName, keyTail, active: true },
            ...authState.profiles
              .filter((p) => p.name !== name)
              .map((p) => ({ ...p, active: false })),
          ],
          onboardingDismissed: authState.onboardingDismissed,
        };
        // The new profile's model becomes the session's current model; the
        // model list refreshes like a live /models query on the new endpoint.
        demoMeta.models = [
          { id: m.modelName, name: m.modelName },
          ...demoMeta.models.filter((x) => x.id !== m.modelName),
        ];
        demoMeta.currentModelId = m.modelName;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "setOnboardingDismissed") {
        authState = { ...authState, onboardingDismissed: m.dismissed };
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "clearAuth") {
        authState = {
          authenticated: false,
          needsSetup: true,
          saved: null,
          profiles: authState.profiles.map((p) => ({ ...p, active: false })),
          onboardingDismissed: authState.onboardingDismissed,
        };
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "activateProfile") {
        // Mirror the real host: with a live session the switch first asks
        // how the conversation survives (custom dialog → respondProfileSwitch);
        // without one it proceeds directly (initial connect).
        if (demoMeta.activeSessionId) {
          pendingSwitchTarget = m.name;
          demoMeta.pendingProfileSwitch = { id: `pswitch-demo-${Date.now()}`, profileName: m.name };
          broadcast({
            type: "snapshot",
            state: {
              blocks: [...demoBlocks],
              status: "idle",
              errorMessage: null,
              stopReason: "end_turn",
              ...demoMeta,
              pendingApproval: null,
              auth: authState,
            },
          });
          return;
        }
        applyProfileSwitch(m.name, true);
        return;
      }
      if (m.type === "respondProfileSwitch") {
        demoMeta.pendingProfileSwitch = null;
        // null = cancel the entire switch: snapshot with the dialog cleared,
        // nothing else touched (active profile stays where it was).
        if (m.keepSession !== null && pendingSwitchTarget) {
          applyProfileSwitch(pendingSwitchTarget, m.keepSession === true);
        } else {
          broadcast({
            type: "snapshot",
            state: {
              blocks: [...demoBlocks],
              status: "idle",
              errorMessage: null,
              stopReason: "end_turn",
              ...demoMeta,
              pendingApproval: null,
              auth: authState,
            },
          });
        }
        pendingSwitchTarget = null;
        return;
      }
      if (m.type === "deleteProfile") {
        authState = {
          ...authState,
          profiles: authState.profiles.filter((p) => p.name !== m.name),
        };
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "profileDeleteResult", name: m.name, ok: true } }),
        );
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "answerQuestions") {
        // Mirror the real host: answering clears the card. demoMeta carries
        // pendingQuestions, so the mutation must land on demoMeta itself —
        // every broadcast spreads it back otherwise and the composer stays
        // busy forever.
        demoMeta.pendingQuestions = null;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "respondApproval") {
        activeApproval = null;
        const approved = m.optionId !== null && m.optionId.startsWith("allow");
        demoBlocks.push({ kind: "text", text: `*write_file — ${approved ? "已允许" : m.optionId === null ? "已取消" : "已拒绝"}（mock）*` });
        if (approved) {
          demoBlocks.push({
            kind: "tool",
            toolCallId: "demo-3",
            toolName: "write_file",
            title: "Write scripts/iflow-defaults/web-search.json",
            toolKind: "edit",
            status: "completed",
            output: "",
            locations: [{ path: "j:\\git\\iflow-harness\\scripts\\iflow-defaults\\web-search.json", line: null }],
            diff: {
              path: "j:\\git\\iflow-harness\\scripts\\iflow-defaults\\web-search.json",
              oldText: '{\n  "engines": ["iflow", "bing", "ddg"]\n}\n',
              newText: '{\n  "engines": ["bing", "ddg"]\n}\n',
            },
          });
        }
        // Answer received → agent keeps working (still streaming) until done.
        broadcastDemo("streaming", null);
        window.setTimeout(() => {
          demoBlocks.push({ kind: "text", text: "工具执行完成（mock host）" });
          playCue("done"); // mirror the real host's turn-finished cue
          activeApproval = null;
          settleMockTurn();
        }, 600);
        return;
      }
      if (m.type === "revertTool") {
        for (const block of demoBlocks) {
          if (block.kind === "tool" && block.toolCallId === m.toolCallId) {
            // C4: revert is orthogonal to status — the tool succeeded.
            block.reverted = true;
            block.output = "[已回退（mock）]";
          }
        }
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "applyHunkSelection") {
        for (const block of demoBlocks) {
          if (block.kind === "tool" && block.toolCallId === m.toolCallId) {
            block.hunkDecisions = [...m.keep];
            block.partiallyReverted = m.keep.some((k) => !k);
            block.output = `[逐块回退（mock）：保留 ${m.keep.filter(Boolean).length} · 回退 ${m.keep.filter((k) => !k).length}]`;
          }
        }
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "setModel") {
        demoMeta.currentModelId = m.modelId;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "setThink") {
        demoMeta.thinkLevel = m.level;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "newSession") {
        demoBlocks.length = 0;
        const id = `mock-session-${Date.now()}`;
        demoMeta.sessions = [{ id, label: "（无标题会话）", updatedAt: Date.now() }, ...demoMeta.sessions];
        demoMeta.activeSessionId = id;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [],
            status: "idle",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "loadSession") {
        // Mock restore: swap in a short "recovered" transcript for the pick.
        demoBlocks.length = 0;
        demoBlocks.push(
          { kind: "user", text: "（mock 恢复）上次讨论到哪里了？" },
          { kind: "text", text: "这是通过 `session/load` 恢复的历史会话内容。" },
          ...Array.from({ length: 12 }, (_, i) => ({
            kind: "text" as const,
            text: `第 ${i + 1} 条历史消息，用于验证恢复后自动滚动到底部。`,
          })),
        );
        demoMeta.activeSessionId = m.sessionId;
        demoMeta.replaying = true;
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            // Real host behavior: beginReplay() reports status "streaming"
            // while the session loads.
            status: "streaming",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        window.setTimeout(() => {
          demoMeta.replaying = false;
          broadcast({
            type: "snapshot",
            state: {
              blocks: [...demoBlocks],
              status: "idle",
              errorMessage: null,
              stopReason: "end_turn",
              ...demoMeta,
              pendingApproval: activeApproval,
              auth: authState,
            },
          });
        }, 700);
        return;
      }
      if (m.type === "togglePlanItem") {
        // Mirror the real host's setPlanEntryStatus: flip pending↔completed,
        // in_progress stays the agent's claim, stale ids drop silently.
        const block = demoBlocks.find((b) => b.kind === "plan" && b.id === m.blockId);
        if (block && block.kind === "plan") {
          const entry = block.entries[m.index];
          if (entry && entry.status !== "in_progress") {
            block.entries = block.entries.map((e, j) =>
              j === m.index ? { ...e, status: e.status === "completed" ? "pending" : "completed" } : e,
            );
            broadcast({
              type: "snapshot",
              state: {
                blocks: [...demoBlocks],
                status: "idle",
                errorMessage: null,
                stopReason: "end_turn",
                ...demoMeta,
                pendingApproval: activeApproval,
                auth: authState,
              },
            });
          }
        }
        return;
      }
      if (m.type === "deleteUserMessage") {
        // Mirror the real host: delete the user block AND everything after it.
        const idx = demoBlocks.findIndex((b) => b.kind === "user" && b.id === m.blockId);
        if (idx >= 0) demoBlocks.splice(idx);
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "deleteSession") {
        demoMeta.sessions = demoMeta.sessions.filter((s) => s.id !== m.sessionId);
        if (demoMeta.activeSessionId === m.sessionId) {
          demoMeta.activeSessionId = demoMeta.sessions[0]?.id ?? null;
          demoBlocks.length = 0;
          demoBlocks.push({ kind: "text", text: "已删除该会话（mock）" });
        }
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "setSessionFlags") {
        // M4 P1-8 mock: flip pinned/archived on the demo index (false deletes
        // the property, mirroring the host's clean-index rule).
        demoMeta.sessions = demoMeta.sessions.map((s) => {
          if (s.id !== m.sessionId) return s;
          const next = { ...s };
          if (m.pinned) next.pinned = true;
          else delete next.pinned;
          if (m.archived) next.archived = true;
          else delete next.archived;
          return next;
        });
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "renameSession") {
        demoMeta.sessions = demoMeta.sessions.map((s) =>
          s.id === m.sessionId ? { ...s, label: m.label.trim() || s.label } : s,
        );
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "searchFiles") {
        // Demo workspace listing for the @-mention popup.
        const demo = [
          "src/App.tsx",
          "src/components/Composer.tsx",
          "src/components/MessageList.tsx",
          "src/store.ts",
          "src/main.tsx",
          "shared/messages.ts",
          "shared/session-state.ts",
          "package.json",
          "docs/plan.md",
          "README.md",
        ];
        const q = m.query.trim().toLowerCase();
        const hits = demo.filter((p) => p.toLowerCase().includes(q)).slice(0, 12).map((path) => ({ path }));
        window.setTimeout(
          () => window.dispatchEvent(new MessageEvent("message", { data: { type: "fileList", requestId: m.requestId, hits } })),
          50,
        );
        return;
      }
      if (m.type === "stageFiles") {
        // Mock staging: pretend the bytes landed in a temp dir.
        const paths = m.files.map((f) => `C:\\mock\\attachments\\${f.name}`);
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", { data: { type: "stagedFiles", requestId: m.requestId, paths } }),
            ),
          80,
        );
        return;
      }
      if (m.type === "pickAttachments") {
        // Mock picker: one image attachment + one real-path file attachment.
        const png1x1 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  type: "filesPicked",
                  images: [{ name: "picked.png", data: png1x1, mimeType: "image/png" }],
                  files: [{ name: "report.pdf", path: "C:\\mock\\docs\\report.pdf" }],
                },
              }),
            ),
          80,
        );
        return;
      }
      if (m.type === "toastAction" && m.actionId === "memory-review") {
        const candidates: MemoryCandidateUi[] = [
          {
            id: "mock-cand-1",
            text: "偏好：回答先给结论，再展开细节",
            scope: "global",
            category: "preference",
            confidence: 0.92,
          },
          {
            id: "mock-cand-2",
            text: "项目约定：提交前运行 npm run typecheck",
            scope: "project",
            category: "convention",
            confidence: 0.86,
          },
        ];
        broadcast({ type: "memoryCandidates", sessionId: "mock-session", candidates });
        return;
      }
      if (m.type === "listMemory") {
        broadcast({ type: "memoryState", state: mockMemoryState() });
        return;
      }
      if (m.type === "readMemoryFile") {
        const file = mockFileFor(m.path);
        broadcast({
          type: "memoryFileContent",
          path: m.path,
          content: mockMemoryContent.get(m.path) ?? "",
          hash: file ? file.hash : null,
        });
        return;
      }
      if (m.type === "saveMemoryFile") {
        const file = mockFileFor(m.path);
        if (!file) {
          broadcast({ type: "memorySaved", path: m.path, ok: false, error: "mock: file not found" });
          return;
        }
        mockMemoryContent.set(m.path, m.content);
        const facts = m.content
          .split("\n")
          .filter((line) => /^\s*-\s+/.test(line))
          .map((line, index) => ({ id: `${index}:mock`, text: line.replace(/^\s*-\s+/, "").trim() }));
        broadcast(
          mockMemorySaved({
            ...file,
            exists: true,
            bytes: m.content.length,
            tokens: Math.max(1, Math.ceil(m.content.length / 4)),
            updatedAt: Date.now(),
            facts,
          }),
        );
        return;
      }
      if (m.type === "appendMemoryFact") {
        const file = mockAppendFact(m.scope, m.fact, m.path);
        if (file) broadcast(mockMemorySaved(file, file.path, m.requestId));
        else {
          broadcast({
            type: "memorySaved",
            path: m.path ?? "",
            ok: false,
            error: "mock: no target",
            ...(m.requestId !== undefined ? { requestId: m.requestId } : {}),
          });
        }
        return;
      }
      if (m.type === "deleteMemoryFacts") {
        const file = mockFileFor(m.path);
        if (!file) return;
        const removed = new Set(m.factIds);
        const facts = (file.facts ?? []).filter((fact) => !removed.has(fact.id));
        const removedTexts = new Set(
          (file.facts ?? []).filter((fact) => removed.has(fact.id)).map((fact) => `- ${fact.text}`),
        );
        const content = (mockMemoryContent.get(m.path) ?? "")
          .split("\n")
          .filter((line) => !removedTexts.has(line.trim()))
          .join("\n");
        mockMemoryContent.set(m.path, content);
        broadcast(
          mockMemorySaved({
            ...file,
            bytes: content.length,
            tokens: Math.max(0, Math.ceil(content.length / 4)),
            facts,
          }),
        );
        return;
      }
      if (m.type === "applyMemoryCandidates") {
        for (const candidate of m.candidates) mockAppendFact(candidate.scope, candidate.text);
        broadcast({ type: "memoryState", state: mockMemoryState() });
        return;
      }
      if (m.type === "dismissMemoryCandidates") return;
      if (m.type === "createProjectMemory") {
        const target = `${mockMemoryRoot}\\${m.fileName}`;
        if (!mockFileFor(target)) {
          const content = `# 项目记忆\n\n## 项目约定\n\n## 已知陷阱\n\n## iFlow Added Memories\n`;
          mockMemoryContent.set(target, content);
          mockMemoryFiles = [
            ...mockMemoryFiles.map((file) =>
              file.scope === "project" ? { ...file, role: "additional" as const } : file,
            ),
            {
              path: target,
              displayPath: m.fileName,
              scope: "project",
              role: "primary",
              exists: true,
              editable: true,
              injected: true,
              bytes: content.length,
              tokens: Math.ceil(content.length / 4),
              updatedAt: Date.now(),
              hash: null,
              facts: [],
            },
          ];
        }
        broadcast({ type: "memoryState", state: mockMemoryState() });
        return;
      }
      if (m.type === "openMemoryFile") return;
      if (m.type === "openKnowledgeFile") return;
      if (m.type === "generateKnowledge") {
        const jobId = m.jobId;
        broadcast({ type: "knowledgeJob", jobId, stage: "scanning" });
        window.setTimeout(() => broadcast({ type: "knowledgeJob", jobId, stage: "summarizing" }), 120);
        window.setTimeout(() => {
          broadcast({ type: "knowledgeJob", jobId, stage: "writing" });
          const content = "# 项目知识索引\n\n## 概览\n\nmock：由工作区摘要生成的项目知识索引。\n\n## 常用命令\n\n- npm test\n";
          mockKnowledgeDocs = [
            {
              path: `${mockMemoryRoot}\\.iflow\\knowledge\\index.md`,
              displayPath: ".iflow/knowledge/index.md",
              title: "项目知识索引",
              injected: true,
              bytes: content.length,
              tokens: Math.ceil(content.length / 4),
              updatedAt: Date.now(),
              hash: null,
            },
          ];
          const projectFile = `${mockMemoryRoot}\\AGENTS.md`;
          const current = mockMemoryContent.get(projectFile) ?? "";
          if (!current.includes("iflow-harness:knowledge:start")) {
            mockMemoryContent.set(
              projectFile,
              `${current.trimEnd()}\n\n<!-- iflow-harness:knowledge:start -->\n## 项目知识库\n@.iflow/knowledge/index.md\n<!-- iflow-harness:knowledge:end -->\n`,
            );
          }
          broadcast({ type: "knowledgeJob", jobId, stage: "done" });
          broadcast({ type: "memoryState", state: mockMemoryState() });
        }, 260);
        return;
      }
      if (m.type === "setKnowledgeInjection") {
        mockKnowledgeDocs = mockKnowledgeDocs.map((doc) =>
          doc.path === m.path ? { ...doc, injected: m.injected } : doc,
        );
        broadcast({ type: "memoryState", state: mockMemoryState() });
        return;
      }
      if (m.type === "listMcpServers" || m.type === "saveMcpServers") {
        seedMockMcp();
        if (m.type === "saveMcpServers") {
          if (m.scope === "global") mockMcpGlobal = m.servers;
          else mockMcpProject = m.servers;
        }
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  type: "mcpServers",
                  global: mockMcpGlobal ?? {},
                  project: mockMcpProject ?? {},
                },
              }),
            ),
          80,
        );
        return;
      }
      if (m.type === "mcpStatus") {
        seedMockMcp();
        // The CLI connects the MERGED view (a project entry overrides the
        // global one of the same name), so the mock status covers exactly that.
        const servers = { ...(mockMcpGlobal ?? {}), ...(mockMcpProject ?? {}) };
        // Mirrors the real host's scope annotation (models-query#mcpScopeOf):
        // the status report carries merged names only, the scope is disk truth.
        const scopeOf = (name: string): "global" | "project" | "both" | undefined => {
          const inGlobal = mockMcpGlobal !== undefined && Object.hasOwn(mockMcpGlobal, name);
          const inProject = mockMcpProject !== undefined && Object.hasOwn(mockMcpProject, name);
          if (inGlobal && inProject) return "both";
          if (inProject) return "project";
          if (inGlobal) return "global";
          return undefined;
        };
        const statusServers: Record<string, unknown> = {};
        for (const [name, rawConfig] of Object.entries(servers)) {
          const config = rawConfig as Record<string, unknown> | undefined;
          const connected = config?.command !== undefined && Object.keys(statusServers).length === 0;
          statusServers[name] = connected
            ? {
                status: "connected",
                toolCount: 2,
                promptCount: 1,
                tools: [
                  { name: "navigate", description: "Navigate to a URL", schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
                  { name: "click", description: "Click an element", schema: { type: "object", properties: { selector: { type: "string" } } } },
                ],
                prompts: [{ name: "help", description: "Usage help" }],
                contextTokens: 180,
                scope: scopeOf(name),
              }
            : {
                status: "disconnected",
                toolCount: 0,
                promptCount: 0,
                tools: [],
                prompts: [],
                error: "spawn ENOENT: command not found",
                errorKind: "spawn_failed",
                contextTokens: 0,
                scope: scopeOf(name),
              };
        }
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent(
                "message",
                { data: { type: "mcpStatus", status: { discoveryState: "completed", servers: statusServers } } },
              ),
            ),
          80,
        );
        return;
      }
      if (m.type === "listAssets") {
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent(
                "message",
                {
                  data: {
                    type: "assetsState",
                    requestId: m.requestId,
                    state: {
                      home: "C:\\Users\\demo\\.iflow",
                      cwd: "C:\\demo\\project",
                      workspaceRoots: ["C:\\demo\\project"],
                      commands: [
                        {
                          kind: "command",
                          scope: "global",
                          name: "fix-tests",
                          path: "C:\\Users\\demo\\.iflow\\commands\\fix-tests.md",
                          displayPath: "~/.iflow/commands/fix-tests.md",
                          description: "Run the tests and fix any failures",
                          tools: null,
                          bytes: 512,
                          updatedAt: Date.now() - 86_400_000,
                          hash: "a1b2c3",
                          editable: true,
                        },
                      ],
                      agents: [
                        {
                          kind: "agent",
                          scope: "project",
                          name: "docs-writer",
                          path: "C:\\demo\\project\\.iflow\\agents\\docs-writer.md",
                          displayPath: ".iflow/agents/docs-writer.md",
                          description: "Writes and reviews docs pages",
                          tools: ["Read", "WriteFile"],
                          bytes: 1024,
                          updatedAt: Date.now() - 3_600_000,
                          hash: "d4e5f6",
                          editable: true,
                        },
                      ],
                      skills: [
                        {
                          kind: "skill",
                          scope: "global",
                          name: "pdf-forms",
                          path: "C:\\Users\\demo\\.iflow\\skills\\pdf-forms\\SKILL.md",
                          displayPath: "~/.iflow/skills/pdf-forms/SKILL.md",
                          description: "Fill and flatten PDF forms",
                          tools: null,
                          bytes: 2048,
                          updatedAt: Date.now() - 7_776_000,
                          hash: "0f9e8d",
                          editable: true,
                        },
                      ],
                    },
                  },
                },
              ),
            ),
          80,
        );
        return;
      }
      if (m.type === "readAsset") {
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent(
                "message",
                {
                  data: {
                    type: "assetContent",
                    path: m.path,
                    content: "---\ndescription: Demo asset\n---\n\nDemo content.\n",
                    hash: "a1b2c3",
                    requestId: m.requestId,
                  },
                },
              ),
            ),
          80,
        );
        return;
      }
      if (m.type === "saveAsset" || m.type === "createAsset") {
        const savedPath = m.type === "saveAsset" ? m.path : "";
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent(
                "message",
                { data: { type: "assetSaved", path: savedPath, ok: true, requestId: m.requestId } },
              ),
            ),
          80,
        );
        return;
      }
      if (m.type === "deleteAsset") {
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", { data: { type: "assetDeleted", path: m.path, ok: true, requestId: m.requestId } }),
            ),
          80,
        );
        return;
      }
      if (m.type === "generateAsset") {
        // Canned draft per kind (the real host streams this from the gateway);
        // the requirement is echoed so the browser demo shows the fill-in.
        const name = m.name.trim() || "generated";
        const req = m.requirement.trim() || "（未填写需求）";
        const body =
          m.kind === "command"
            ? `---\ndescription: ${req}\n---\n\n请针对以下需求执行：${req}\n\n参数：{{args}}\n`
            : m.kind === "agent"
              ? `---\nname: ${name}\ndescription: ${req}\nallowed-tools: Read, Grep, Glob\n---\n\n你是「${name}」子代理。职责：${req}\n`
              : `---\nname: ${name}\ndescription: ${req}\n---\n\n# ${name}\n\n适用场景：${req}\n\n## 步骤\n\n1. 确认输入\n2. 执行\n3. 汇报结果\n`;
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", {
                data: { type: "assetGenerated", requestId: m.requestId, content: body },
              }),
            ),
          400,
        );
        return;
      }
      if (m.type === "stopSubagent") {
        // The mock mirrors the agent-cancel Mod: only the targeted agent
        // stops; the parent turn keeps running with an interrupted result.
        // (No real subagent lifecycle here, so settle the demo turn.)
        demoBlocks.push({ kind: "text", text: "*（已停止该进程内子代理，整轮继续，mock）*" });
        settleMockTurn();
        return;
      }
      if (m.type === "superAgent") {
        // Super Agent board actions. The real host owns the child sessions;
        // the mock mutates the same projection so the board's interactions
        // are exercisable in browser debug mode.
        if (m.action === "transcript") {
          // The live pane asks for the full buffer on first open; reply with
          // the same `superTranscript {from:0}` shape the host sends.
          const sessionId = m.sessionId;
          if (!sessionId) return;
          broadcast({
            type: "superTranscript",
            sessionId,
            from: 0,
            blocks: demoSuperTranscripts[sessionId] ?? [],
          });
          return;
        }
        // demo 模式没有真实宿主，判定卡死与中断在可见效果上一致（取消目标会话）；
        // 真实宿主的「先记 timeout 诊断」只在扩展进程里发生。
        if (m.action === "cancel" || m.action === "stuck") {
          const target = demoSuperSessions.find((s) => s.id === m.sessionId);
          if (target) {
            target.status = "cancelled";
            target.pending = undefined;
            target.endedAt = Date.now();
            target.updatedAt = Date.now();
          }
        } else if (m.action === "cancelAll") {
          for (const session of demoSuperSessions) {
            if (session.status === "running" || session.status === "preparing" || session.status === "awaiting_input") {
              session.status = "cancelled";
              session.pending = undefined;
              session.endedAt = Date.now();
              session.updatedAt = Date.now();
            }
          }
        } else if (m.action === "respond") {
          const target = demoSuperSessions.find((s) => s.id === m.sessionId);
          if (target?.pending) {
            target.pending = undefined;
            target.status = "running";
            target.updatedAt = Date.now();
          }
        } else if (m.action === "retry") {
          const target = demoSuperSessions.find((s) => s.id === m.sessionId);
          if (target && (target.status === "failed" || target.status === "cancelled")) {
            target.status = "running";
            target.attempts = (target.attempts ?? 1) + 1;
            target.error = undefined;
            target.summary = undefined;
            target.pending = undefined;
            target.integration = undefined;
            target.endedAt = undefined;
            target.startedAt = Date.now();
            target.updatedAt = Date.now();
          }
        } else if (m.action === "cleanup") {
          // Mirror the real host's async cleanup (dispose → worktree → git
          // probe → emit) with a short delay, so the webview's optimistic
          // 「清理中」 state is observable in the standalone demo.
          const id = m.sessionId;
          window.setTimeout(() => {
            const index = demoSuperSessions.findIndex((s) => s.id === id);
            if (index >= 0) demoSuperSessions.splice(index, 1);
            broadcastDemo(mockStatus, null);
          }, 900);
          return;
        } else if (m.action === "merge") {
          // Mirror the real host: the click becomes a request that dispatches
          // a merge child session running asynchronously in the main
          // workspace. The request block lands immediately, but the result is
          // delayed so the webview's optimistic 「合并中」 state is observable
          // in the standalone demo (a synchronous write-back would make the
          // in-progress state flash by unseen).
          demoBlocks.push({
            kind: "user",
            text: "请把超流体的分支合并到当前分支（mock 请求，由智能体执行）",
          });
          broadcastDemo(mockStatus, null);
          const id = m.sessionId;
          window.setTimeout(() => {
            const target = demoSuperSessions.find((s) => s.id === id);
            if (target) {
              target.integration = {
                mode: "merge",
                state: "merged",
                detail: "智能体已合入 main",
                at: Date.now(),
              };
              target.updatedAt = Date.now();
            }
            demoBlocks.push({ kind: "text", text: "*（已让智能体合并超流体分支，mock）*" });
            broadcastDemo(mockStatus, null);
          }, 1500);
          return;
        }
        broadcastDemo(mockStatus, null);
        return;
      }
      if (m.type === "requestSuperResidueList") {
        // 新协议 demo：从同一批 demoSuperSessions 派生「失败/中断 + git
        // worktree + 有分支 + 未成功合并」的残留条目，回包带请求 id 与一次性
        // 令牌（每次请求换发）。
        mockResidueSeq += 1;
        const token = `mock-residue-list-${mockResidueSeq}`;
        mockResidueToken = token;
        const branches = demoSuperSessions
          .filter((s) => {
            const state = s.integration?.state;
            return (
              (s.status === "failed" || s.status === "cancelled") &&
              s.isolation.kind === "git_worktree" &&
              !!s.isolation.branch &&
              state !== "merged" &&
              state !== "pr_created" &&
              state !== "not_needed"
            );
          })
          .map((s) => ({
            sessionId: s.id,
            branch: s.isolation.branch ?? "",
            worktree: s.isolation.path,
            title: s.title,
            mainSessionId: demoMeta.activeSessionId,
            unmerged: true,
            worktreeExists: true,
          }));
        const requestId = m.requestId;
        window.setTimeout(
          () => broadcast({ type: "superResidueList", requestId, branches, confirmToken: token }),
          80,
        );
        return;
      }
      if (m.type === "superResidueHandle") {
        // 一次性令牌：与宿主一样，校验不过如实提示并拒绝；通过即作废。
        if (!mockResidueToken || m.confirmToken !== mockResidueToken) {
          broadcast({ type: "toast", level: "warning", message: "残留清单已过期，请重新获取后再操作" });
          return;
        }
        mockResidueToken = null;
        const ids = new Set(m.sessionIds);
        if (m.action === "merge") {
          for (const session of demoSuperSessions) {
            if (!ids.has(session.id)) continue;
            session.integration = {
              mode: "merge",
              state: "merged",
              detail: "智能体已合入 main（mock）",
              at: Date.now(),
            };
            session.updatedAt = Date.now();
          }
        } else {
          for (let i = demoSuperSessions.length - 1; i >= 0; i -= 1) {
            if (ids.has(demoSuperSessions[i]!.id)) demoSuperSessions.splice(i, 1);
          }
        }
        window.setTimeout(() => broadcastDemo(mockStatus, null), 300);
        return;
      }
      if (m.type === "cancel") {
        // Mirror the real host: stop → idle with stopReason "cancelled", the
        // pending permission request is settled, and the queue keeps
        // steering (the host drains it on the cancelled path too).
        activeApproval = null;
        demoBlocks.push({ kind: "text", text: "*（已停止生成，mock）*" });
        settleMockTurn();
        return;
      }
      if (m.type === "enhancePrompt") {
        // Mock enhancement: echo a "structured" rewrite after a beat so the
        // composer fill-back flow is testable in browser debug mode.
        const enhanced = `${m.text.trim()}\n\n（目标：明确预期产出；约束：列出边界；验收：给出可验证标准。）`;
        const timer = window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", { data: { type: "enhancedPrompt", requestId: m.requestId, text: enhanced } }),
            ),
          300,
        );
        mockEnhanceTimers.set(m.requestId, timer);
        return;
      }
      if (m.type === "fetchModelMetadata") {
        // Mock web-search metadata fetch: searching → canned rows appended to
        // the three tables (the real host dedups against existing rows and
        // only appends validated ones), then done with the counts.
        broadcast({ type: "modelMetadataState", state: "searching" });
        if (mockMetadataTimer) window.clearTimeout(mockMetadataTimer);
        mockMetadataTimer = window.setTimeout(() => {
          mockMetadataTimer = null;
          // Same dedup rule as the host: a model already present in the table
          // is never appended twice (repeated clicks would otherwise stack
          // identical rows).
          const seenWindows = new Set(
            mockHostSettings.contextWindowOverrides.map((row) => normalizeModelId(row.split("=")[0])),
          );
          const windowRows = ["glm-4.6=200000", "deepseek-v3.2-ex=128000"].filter((row) => {
            const key = normalizeModelId(row.split("=")[0]);
            if (!key || seenWindows.has(key)) return false;
            seenWindows.add(key);
            return true;
          });
          const seenCosts = new Set(mockHostSettings.costTable.map((row) => normalizeModelId(row.split("=")[0])));
          const costRows = ["glm-4.6=0.6,2.4"].filter((row) => {
            const key = normalizeModelId(row.split("=")[0]);
            if (!key || seenCosts.has(key)) return false;
            seenCosts.add(key);
            return true;
          });
          const rulePattern = "^glm-4\\.6$";
          const ruleCovered = mockHostSettings.thinkingModelRules.some(
            (rule) => rule.supportsThinking && new RegExp(rule.pattern, "i").test("glm-4.6"),
          );
          mockHostSettings.contextWindowOverrides = [...mockHostSettings.contextWindowOverrides, ...windowRows];
          mockHostSettings.costTable = [...mockHostSettings.costTable, ...costRows];
          if (!ruleCovered) {
            mockHostSettings.thinkingModelRules = [
              ...mockHostSettings.thinkingModelRules,
              { pattern: rulePattern, supportsThinking: true },
            ];
          }
          broadcast({ type: "hostSettings", ...mockHostSettings });
          broadcast({
            type: "modelMetadataState",
            state: "done",
            added: {
              windows: windowRows.length,
              costs: costRows.length,
              rules: ruleCovered ? 0 : 1,
            },
          });
        }, 900);
        return;
      }
      if (m.type === "cancelModelMetadata") {
        if (mockMetadataTimer) {
          window.clearTimeout(mockMetadataTimer);
          mockMetadataTimer = null;
        }
        broadcast({ type: "modelMetadataState", state: "idle" });
        return;
      }
      if (m.type === "cancelEnhance") {
        // Mirror the real host: an aborted enhancement never replies.
        const timer = mockEnhanceTimers.get(m.requestId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          mockEnhanceTimers.delete(m.requestId);
        }
        return;
      }
      if (m.type === "sendPrompt") {
        // Mirror the real host: context cards are assembled into the user turn
        // (titled fenced sections ahead of the typed text).
        const ctxs = m.contexts ?? [];
        const prefix = ctxs
          .map((c) => [`关于 \`${c.label}\`（${c.detail}）：`, "", "```text", c.content, "```"].join("\n"))
          .join("\n\n");
        const full = [prefix, m.text].filter(Boolean).join("\n\n");
        // M2 P0-3: a turn streaming → enqueue instead of send (mirrors host).
        if (mockStatus === "streaming") {
          mockQueue.push({
            id: `mq-${++mockQueueSeq}`,
            text: full,
            attachments: (m.files ?? []).map((f) => f.name),
            enqueuedAt: Date.now(),
          });
          broadcastDemo(mockStatus, null);
          return;
        }
        sendPromptFlow(
          full,
          m.images?.map((img) => `data:${img.mimeType};base64,${img.data}`),
        );
        return;
      }
      if (m.type === "queueAction") {
        // M2 P0-3 mock: mirror the host queue ops on the projection.
        if (m.action === "clear") {
          mockQueue.length = 0;
          mockQueuePaused = false;
        } else if (m.action === "resume") {
          mockQueuePaused = false;
        } else if (m.action === "delete" && m.id) {
          const i = mockQueue.findIndex((q) => q.id === m.id);
          if (i >= 0) mockQueue.splice(i, 1);
        } else if (m.action === "move" && m.id && m.delta) {
          const from = mockQueue.findIndex((q) => q.id === m.id);
          const to = Math.min(mockQueue.length - 1, Math.max(0, from + m.delta));
          if (from >= 0 && to !== from) {
            const [mv] = mockQueue.splice(from, 1);
            if (mv) mockQueue.splice(to, 0, mv);
          }
        } else if (m.action === "edit" && m.id) {
          const i = mockQueue.findIndex((q) => q.id === m.id);
          if (i >= 0) {
            const [entry] = mockQueue.splice(i, 1);
            if (entry) {
              window.setTimeout(
                () => window.dispatchEvent(new MessageEvent("message", { data: { type: "queueEdited", requestId: m.requestId ?? 0, text: entry.text } })),
                30,
              );
            }
          }
        } else if (m.action === "sendNow" && m.id) {
          const i = mockQueue.findIndex((q) => q.id === m.id);
          if (i >= 0) {
            const [entry] = mockQueue.splice(i, 1);
            mockQueuePaused = false;
            if (entry) window.setTimeout(() => sendPromptFlow(entry.text), 60);
          }
        }
        broadcastDemo(mockStatus, null);
        return;
      }
      if (m.type === "resolveContext") {
        // M2 P0-4 mock: fabricate a plausible card body per kind.
        const bodies: Record<string, { label: string; detail: string; content: string }> = {
          folder: { label: m.query || "./", detail: "3 个子项", content: "- src/\n- package.json\n- README.md" },
          problems: { label: "工作区诊断", detail: "2 条", content: "src/App.tsx:\n  [错误] L10: 未找到名称 foo" },
          git: { label: "工作区 Git", detail: "status + diff", content: "状态（git status --porcelain）：\n  M src/App.tsx" },
          terminal: { label: "终端最近输出", detail: "2 条命令", content: "$ npm run dev\n（J:\\proj · 仍在运行）\nVITE v8 ready in 320 ms\n\n---\n\n$ npm test\n（退出码 0）\nTests  32 passed" },
          url: { label: m.query, detail: "example.com", content: "示例网页正文（mock 抓取）" },
        };
        const b = bodies[m.kind] ?? { label: m.query, detail: "", content: "" };
        window.setTimeout(
          () => window.dispatchEvent(new MessageEvent("message", { data: { type: "contextResolved", requestId: m.requestId, kind: m.kind, ...b } })),
          80,
        );
        return;
      }
      if (m.type === "regenerate") {
        // Dev/browser preview only: the real host re-runs the last user turn
        // through the CLI. The mock has no agent backend, so acknowledge with
        // a toast instead of leaving the button dead (see the tripwire below).
        broadcast({ type: "toast", level: "info", message: "预览模式：已模拟重新生成（mock host）", durationMs: 2000 });
        return;
      }
      if (m.type === "editAndResend") {
        // Dev/browser preview only: the real host truncates the turn, restores
        // its checkpoint snapshot and re-sends `text` as a fresh prompt. The
        // mock cannot touch CLI history, so just echo a toast.
        broadcast({ type: "toast", level: "info", message: "预览模式：已模拟编辑并重新发送（mock host）", durationMs: 2000 });
        return;
      }
      if (m.type === "openLocation") {
        // Dev/browser preview only: no editor host can open a file in the
        // static preview (the real host sends no wire ack either), so log the
        // request for debugging and consume it silently.
        console.info(`[iflow] mock host: openLocation ${m.path}${m.line != null ? `:${m.line}` : ""}`);
        return;
      }
      // Dev/browser preview only: the real host handles every wire message,
      // but the mock implements just the subset needed for UI iteration.
      // Without a tripwire a missing handler looks like a dead button.
      console.warn(`[iflow] mock host: unhandled webview message: ${(m as { type?: string }).type}`);
    },
  };
}

const vscode: HostApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : createMockHost();

/**
 * An optimistic switch lock: set the moment the user clicks profile / model /
 * mode switch, cleared when the host's snapshot confirms the new value (or
 * after a failsafe timeout). While a lock is held every switch control is
 * disabled, so overlapping switches can't race the in-flight one.
 */
export type PendingOpKind = "profile" | "model" | "mode" | "think";

interface PendingOp {
  kind: PendingOpKind;
  target: string;
}

/** Debounce window for identical outgoing messages (double-click guard). */
const SEND_DEBOUNCE_MS = 400;
/** Failsafe: drop the switch lock even if the host never confirms. */
const PENDING_TIMEOUT_MS = 10_000;
/** Min interval between full re-sync requests (unanchorable blockPatch). */
const RESYNC_THROTTLE_MS = 1_000;
/**
 * Long-session memory bound (2026-10): the block-count cap of the webview's
 * fully-kept transcript tail. Must exceed MessageList's MAX_WINDOW (120
 * mounted blocks) so every mounted card of a NORMAL session has its payload.
 * The count cap alone is not a memory bound — a probed bloat session had 249
 * blocks but 23.4MB of payload (590KB tool diffs), so `evictBlockPayloads`
 * also enforces a char BUDGET over the tail (EVICT_BUDGET_CHARS, with
 * EVICT_MIN_KEEP newest blocks floored) and whichever cap binds first wins.
 * Older blocks' heavy content (tool output/diff, thought text, images,
 * compression summaries) is released and rendered with a "released" marker;
 * the host state stays complete regardless (revert / export / persistence
 * read the host, not this projection).
 *
 * `EVICT_KEEP_BLOCKS` lives in `shared/messages` so the host-side child
 * transcript (SuperAgentManager) trims with exactly the same window.
 */

/**
 * Eviction memo: input blocks array → evicted blocks array.
 *
 * `evictBlockPayloads` is a PURE function of the blocks array (both caps are
 * constants here) and it is idempotent + identity-stable: nothing to release
 * → the SAME array comes back. So the result of one pass can be reused for
 * the same array — the store runs the eviction after every snapshot/patch,
 * and a metadata-only patch (`applyBlockPatch` hands back `current.blocks`
 * untouched) now hits this memo instead of re-walking the tail and
 * re-copying the array.
 *
 * WeakMap: the entry dies with the array it describes, so nothing outlives
 * the transcript it belongs to. Blocks are immutable in the webview (the
 * reducer always creates new objects), so an array's contents — and hence its
 * eviction result — never change under us.
 */
const evictMemo = new WeakMap<readonly Block[], Block[]>();

/** Apply the payload eviction to an incoming state; identity-stable pass. */
function evict(state: SessionState): SessionState {
  const memo = evictMemo.get(state.blocks);
  if (memo !== undefined) {
    return memo === state.blocks ? state : { ...state, blocks: memo };
  }
  const blocks = evictBlockPayloads(state.blocks, EVICT_KEEP_BLOCKS);
  evictMemo.set(state.blocks, blocks);
  return blocks === state.blocks ? state : { ...state, blocks };
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentKey = "";
let lastSentAt = 0;
let lastResyncAt = 0;
/** At most one trailing resync per throttle window: a patch burst inside the
 * window collapses onto this single timer instead of dropping the requests. */
let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;
/**
 * 残留清单请求序号：`requestSuperResidueList` 每次自增，生成唯一的
 * `requestId`。宿主把同一个 id 原样回显在 `superResidueList` 里，webview
 * 只接受与最近一次请求配对的回包 —— 迟到的旧回包不能覆盖新清单。
 */
let superResidueRequestSeq = 0;
/** Lifetime of a WebView-local notice (UI-audit 4.9: transient, ~4s). */
const LOCAL_TOAST_MS = 4000;

/** Actually post `ready` and (re)arm the throttle window. */
function fireResync(): void {
  resyncTimer = null;
  lastResyncAt = Date.now();
  vscode.postMessage({ type: "ready" });
}

/**
 * Ask the host for a full snapshot (P-1: a blockPatch we cannot anchor).
 *
 * Throttle with a TRAILING edge: the first request after a quiet window fires
 * immediately (startup behaviour unchanged). Requests that arrive inside the
 * window no longer get silently dropped — they schedule one deferred resync at
 * the window boundary. Without this, an unanchorable patch early in startup (or
 * after a missed patch) left the transcript stale with no recovery. The whole
 * burst collapses onto that single timer, so the host never sees a storm.
 */
function requestResync(): void {
  const remaining = RESYNC_THROTTLE_MS - (Date.now() - lastResyncAt);
  if (remaining <= 0) {
    if (resyncTimer !== null) {
      clearTimeout(resyncTimer);
      resyncTimer = null;
    }
    fireResync();
    return;
  }
  // Inside the window: one trailing timer is enough. Further requests ride
  // along with it — no new timer, no extra `ready`.
  if (resyncTimer === null) {
    resyncTimer = setTimeout(fireResync, remaining);
  }
}

/** Transient host notice (rate-limit retry / context-overflow compress). */
export interface ToastItem {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
  /** When set, the WebView renders a live countdown to this absolute epoch-ms
   * deadline (host clock), so the UI stays in sync with the host's actual wait. */
  countdownDeadline?: number;
  /** Host marks the pill display-only: rendered without click-to-dismiss. */
  displayOnly?: boolean;
  /** Host-assigned id (matches the wire `toastId`); used by `dismissToast`. */
  toastId?: number;
  /** Host owns this pill's lifetime (auto-compress notice): never auto-dismissed
   * by the WebView — removed only when the host sends `dismissToast`. */
  persistent?: boolean;
  /** No auto-dismiss timer, but the user may close it locally (auto-memory
   * candidate notice). Distinct from `persistent`, which renders non-clickable. */
  sticky?: boolean;
  /** M1 P0-6: inline action button (e.g. 立即压缩 on the context-warning
   * pill). Clicking sends `toastAction` with the actionId + host toastId. */
  action?: { actionId: string; label: string };
  /** Decision-card notices (auto-memory candidates) list what would be written
   * before the review dialog opens; absent = plain pill. */
  preview?: { text: string; scope: "global" | "project" }[];
}

interface ChatStore {
  state: SessionState | null;
  /**
   * Live transcripts of the main session's child sessions, keyed by child id.
   *
   * They ride their OWN `superTranscript` channel (never the main `blocks`),
   * so the detail pane renders the exact same block components as the main
   * transcript without breaking the blockPatch anchor. Pruned to the
   * sessions that still exist on every snapshot / patch.
   */
  superTranscripts: Record<string, Block[]>;
  /**
   * 新建会话时 host 检测到跨历史会话 Super Agent 残留，请求 webview 弹出
   * 二次确认框。整条消息（含组装好的 title/message/按钮文案）原样存下，
   * webview 只渲染不改写。null = 当前没有待确认请求。
   */
  superResidueConfirm: Extract<HostToWebview, { type: "superResidueConfirm" }> | null;
  /** 回答残留清空确认框：清空展示态并只回传一次 respondSuperResidueConfirm。 */
  respondSuperResidueConfirm: (confirmed: boolean) => void;
  /**
   * 残留分支清单的新协议回包（`superResidueList`）。
   *
   * 只保存与最近一次 `requestSuperResidueList` 的 `requestId` 配对的回包：
   * 清单 + 一次性 `confirmToken`。批量合并/丢弃必须原样回传该令牌，宿主
   * 校验不过即拒绝（二次确认）；每次下发换发新令牌，旧令牌立即失效。
   */
  superResidueList: Extract<HostToWebview, { type: "superResidueList" }> | null;
  /** 最近一次 `requestSuperResidueList` 的 requestId；null = 从未请求。 */
  superResidueRequestId: string | null;
  /** 清单请求在飞（刷新按钮 / 首屏加载态）。 */
  superResidueLoading: boolean;
  /** 请求宿主重新枚举残留分支清单（自增 requestId）。 */
  requestSuperResidueList: () => void;
  /**
   * 批量处置选中的残留分支：`sessionIds` 引用清单条目（孤儿项回退到宿主键）。
   * 令牌缺失/过期时如实提示并自动重新请求，不静默失败。
   */
  handleSuperResidueAction: (
    action: "merge" | "discard",
    sessionIds: string[],
  ) => void;
  /**
   * QQ 远程任务设置快照（Wave3-C）。独立于 `state`：`snapshot` / `blockPatch`
   * 只换转录与会话元数据，绝不覆盖它。默认值由 `pickQqSettingsUi` 归一，
   * 因此首帧就能渲染完整表单（凭据只有「已配置」布尔）。
   */
  qqSettings: QqSettingsUi;
  /** 最近一次连接检查 / 适配器状态回执；null = 尚未收到。 */
  qqStatus: { connected: boolean; detail?: string } | null;
  /**
   * 远程接续开关的 webview 内存态（host 经 `qqTakeoverState` 回推）。true = 当前
   * 会话被远程接管：Composer 所有干预入口与审批/提问卡决策按钮冻结，转录保持
   * 只读可滚动。不进 snapshot / blockPatch，webview 重连即回到 false。
   */
  remoteTakeover: boolean;
  /**
   * QQ 授权模型：白名单外的人发来消息时留下的待审核记录（宿主每次全量重发，
   * 这里直接替换）。顺序由宿主按 `lastSeenAt` 倒序保证。
   */
  qqPendingUsers: Extract<HostToWebview, { type: "qqPendingUsers" }>["users"];
  /**
   * 一键接入：QQ 官方机器人扫码授权二维码回执。独立于 `state`，
   * `snapshot` / `blockPatch` 绝不覆盖；`dataUrl` 经 `isQrDataUrl` 护栏后才
   * 能由 QqSettings 送进 `<img src>`。null = 当前没有二维码。
   */
  qqLoginQr: Extract<HostToWebview, { type: "qqLoginQr" }> | null;
  /**
   * 一键接入：QQ 官方机器人准备/配置/启动/授权各阶段的进度回执。
   * 同样独立于 `state`，不被快照覆盖。null = 尚未开始接入。
   */
  qqManagedStatus: Extract<HostToWebview, { type: "qqManagedStatus" }> | null;
  /** Latest editor theme from the host; null until the first `theme` message. */
  editorTheme: "light" | "dark" | null;
  /**
   * Host-owned extension settings mirrored for the settings panel. VSCode
   * configuration is the source of truth; the host pushes the effective
   * values on ready and after every change. The optimistic local write in
   * `updateHostSetting` keeps the switch responsive while the round trip runs.
   */
  hostSettings: HostSettingsUi;
  updateHostSetting: (patch: Partial<HostSettingsUi>) => void;
  /**
   * 上下文窗口覆写的当前视图（设置页结构化编辑器的数据源）：原始覆写行 +
   * 当前会话模型 + 该模型在内建表里的窗口（给「一键预填」用）。
   *
   * 宿主在 webview 就绪时推一次、每次写入成功后推一次；null = 还没收到
   * （设置页此时显示空列表，等首次推送即可）。
   */
  contextWindowOverridesView: ContextWindowOverridesUi | null;
  /** Lifecycle of the settings-panel 「联网补充模型数据」 web-search fetch
   * (see `modelMetadataState`). WebView-local mirror of the host lane: the
   * button shows the spinner while `searching` and the inline error on
   * `error`; appended rows arrive via the following `hostSettings` refresh. */
  modelMetadata: ModelMetadataStateUi;
  /** Transient host notices (auto-dismissed); see applyHostMessage toast case. */
  toasts: ToastItem[];
  dismissToast: (id: number) => void;
  /** WebView-local transient notice. UI-audit 4.6: the composer's inline note
   * was a fourth notification surface next to host toasts / the error pill /
   * the auth banner — local notices now ride the same toast stack, so there is
   * one place to look. Auto-dismissed after LOCAL_TOAST_MS. */
  notify: (message: string, level?: ToastItem["level"]) => void;
  /** Optimistic switch lock, null when idle (see PendingOp). */
  pending: PendingOp | null;
  /**
   * Bumped on every outgoing sendPrompt. MessageList subscribes to force
   * scroll-to-bottom on send: the RO follow intentionally stays off while
   * the user is scrolled up, but sending is an explicit "take me to the
   * live turn" intent (mainstream chat behavior — ChatGPT/Copilot do the
   * same), and the image-attach flow regularly happens from a scrolled-up
   * position, which read as "image messages don't auto-scroll".
   */
  promptSeq: number;
  /** True once the transcript is scrolled under the header (scrollTop above a
   * threshold) — the header renders a bottom shadow only while it overlaps
   * messages. Updated at the 0-crossing only, so scrolling doesn't re-render
   * the header per pixel. */
  headerScrolled: boolean;
  setHeaderScrolled: (scrolled: boolean) => void;
  /**
   * M1 P1-3 Focus view: collapse tool / thought / system blocks and render
   * only user + assistant text. Pure webview-local rendering state (the host
   * transcript stays complete) — toggled from the header or Ctrl/Cmd+Alt+F.
   */
  focusMode: boolean;
  toggleFocusMode: () => void;
  /**
   * P0-4: one-shot "fill the composer" request (empty-state example chips).
   * The seq lets the Composer's effect fire on repeated requests with the
   * SAME text; null = nothing pending. Composer clears it after consuming.
   */
  composerDraftRequest: { text: string; seq: number } | null;
  requestDraft: (text: string) => void;
  clearDraftRequest: (seq: number) => void;
  /** F3 Phase 2: message action "记住这条" opens the quick-add dialog with
   * this text. Null = dialog closed. */
  memoryDraftRequest: { text: string; seq: number } | null;
  requestMemoryDraft: (text: string) => void;
  clearMemoryDraft: (seq: number) => void;
  applyHostMessage: (msg: HostToWebview) => void;
  beginPending: (kind: PendingOpKind, target: string) => void;
  /** Drop the optimistic switch lock (cancelled switch, aborted dialog). */
  clearPending: () => void;
  send: (msg: WebviewToHost) => void;
}

import { setLocale, t } from "./i18n";

export const useChat = create<ChatStore>((set, get) => ({
  state: null,
  qqSettings: pickQqSettingsUi({}, { hasAppSecret: false }),
  qqStatus: null,
  remoteTakeover: false,
  qqPendingUsers: [],
  qqLoginQr: null,
  qqManagedStatus: null,
  superTranscripts: {},
  superResidueConfirm: null,
  superResidueList: null,
  superResidueRequestId: null,
  superResidueLoading: false,
  editorTheme: null,
  hostSettings: { ...DEFAULT_HOST_SETTINGS },
  contextWindowOverridesView: null,
  modelMetadata: { state: "idle" },
  pending: null,
  promptSeq: 0,
  headerScrolled: false,
  setHeaderScrolled: (scrolled) => set({ headerScrolled: scrolled }),
  focusMode: false,
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  composerDraftRequest: null,
  requestDraft: (text) =>
    set((s) => ({
      composerDraftRequest: { text, seq: (s.composerDraftRequest?.seq ?? 0) + 1 },
    })),
  clearDraftRequest: (seq) =>
    set((s) => (s.composerDraftRequest?.seq === seq ? { composerDraftRequest: null } : s)),
  memoryDraftRequest: null,
  requestMemoryDraft: (text) =>
    set((s) => ({
      memoryDraftRequest: { text, seq: (s.memoryDraftRequest?.seq ?? 0) + 1 },
    })),
  clearMemoryDraft: (seq) =>
    set((s) => (s.memoryDraftRequest?.seq === seq ? { memoryDraftRequest: null } : s)),
  toasts: [],
  applyHostMessage: (msg) => {
    // Snapshot & blockPatch update the store. Other message kinds (fileList,
    // stagedFiles, filesPicked) are consumed by their own window-level
    // listeners — Composer registers those itself, so no re-dispatch happens here.
    if (msg.type === "snapshot") {
      setLocale(msg.locale);
      // Same normalization as the superTranscript path: old-wire snapshots can
      // carry blocks missing required fields (e.g. a text block with no
      // `text`), which makes BlockView's `block.text.trim()` throw at render
      // time and bubbles up to the page-level boundary. Valid arrays keep
      // their identity, so memoized selectors are unaffected.
      const state = evict({ ...msg.state, blocks: sanitizeTranscriptBlocks(msg.state.blocks) });
      const superTranscripts = pruneSuperTranscripts(
        get().superTranscripts,
        state.superSessions,
      );
      // A pending switch is cleared as soon as the host confirms the value.
      const pending = get().pending;
      if (pending) {
        const confirmed =
          (pending.kind === "profile" &&
            state.auth.profiles.find((p) => p.name === pending.target)?.active) ||
          (pending.kind === "model" && state.currentModelId === pending.target) ||
          (pending.kind === "mode" && state.modes?.currentModeId === pending.target) ||
          (pending.kind === "think" && state.thinkLevel === pending.target);
        if (confirmed) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          set({ pending: null, state, superTranscripts });
          return;
        }
      }
      set({ state, superTranscripts });
      return;
    }
    if (msg.type === "blockPatch") {
      // P-1 incremental snapshot: merge the tail onto the anchored state, then
      // apply the piggybacked non-block metadata. An unanchorable patch (webview
      // booted without a snapshot, missed patch, out-of-bounds tail) triggers a
      // throttled full re-sync.
      const current = get().state;
      const patched = applyBlockPatch(current, msg);
      if (!patched) {
        requestResync();
        return;
      }
      const blocks = sanitizeTranscriptBlocks(patched);
      const state: SessionState = evict({ ...msg.tail, blocks });
      const superTranscripts = pruneSuperTranscripts(
        get().superTranscripts,
        state.superSessions,
      );
      const pending = get().pending;
      if (pending) {
        const confirmed =
          (pending.kind === "profile" &&
            state.auth.profiles.find((p) => p.name === pending.target)?.active) ||
          (pending.kind === "model" && state.currentModelId === pending.target) ||
          (pending.kind === "mode" && state.modes?.currentModeId === pending.target) ||
          (pending.kind === "think" && state.thinkLevel === pending.target);
        if (confirmed) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          set({ pending: null, state, superTranscripts });
          return;
        }
      }
      set({ state, superTranscripts });
      return;
    }
    if (msg.type === "superTranscript") {
      set((s) => {
        const prev = s.superTranscripts[msg.sessionId] ?? [];
        if (msg.from > 0 && msg.from > prev.length) {
          // A patch was missed (should not happen with ordered postMessage):
          // ask for the full transcript; the reply comes back with from = 0.
          get().send({ type: "superAgent", action: "transcript", sessionId: msg.sessionId });
          return s;
        }
        const merged =
          msg.from <= 0 ? msg.blocks : [...prev.slice(0, msg.from), ...msg.blocks];
        // 历史转录快照 / 旧版 wire 可能带缺字段的畸形块（见 shared 的
        // sanitizeTranscriptBlocks 注释）。「查看实时进度」把这块数组原样喂给
        // BlockView，任一畸形块都会在渲染期抛错、冒泡成 page 级白屏。入站时
        // 先规范化：合法块 identity 不变，畸形块被修补或丢弃。
        const safe = sanitizeTranscriptBlocks(merged);
        // Same payload budget as the main transcript: a long-running child can
        // accumulate large tool outputs, and the detail pane only mounts a
        // window of blocks at a time.
        const capped = evictBlockPayloads(safe, EVICT_KEEP_BLOCKS);
        return { superTranscripts: { ...s.superTranscripts, [msg.sessionId]: capped } };
      });
      return;
    }
    if (msg.type === "superResidueConfirm") {
      // 宿主组装好的文案（含警示）原样存入，SuperResidueConfirmDialog 读取它
      // 弹出阻断式确认框；answer 后由 respondSuperResidueConfirm 清空。
      set({ superResidueConfirm: msg });
      return;
    }
    if (msg.type === "superResidueList") {
      // 只认领最近一次请求的回包：requestId 不匹配说明是迟到的旧清单
      // （刷新期间到达），用它覆盖会把旧令牌塞回视图，下一次操作被宿主拒绝。
      if (get().superResidueRequestId !== msg.requestId) return;
      set({ superResidueList: msg, superResidueLoading: false });
      return;
    }
    if (msg.type === "qqSettings") {
      set({ qqSettings: msg.values });
      return;
    }
    if (msg.type === "qqStatus") {
      set({ qqStatus: { connected: msg.connected, detail: msg.detail } });
      return;
    }
    if (msg.type === "qqTakeoverState") {
      // 远程接续是 host 权威的纯内存态：按回推值同步按钮与冻结门，不写快照。
      set({ remoteTakeover: msg.active });
      return;
    }
    if (msg.type === "qqPendingUsers") {
      // 授权模型：宿主每次全量重发（新增 / 放行 / 拒绝都会推），直接替换。
      set({ qqPendingUsers: msg.users });
      return;
    }
    if (msg.type === "qqLoginQr") {
      // 一键托管的二维码回执走独立通道，快照不覆盖。dataUrl 的合法性由
      // QqSettings 在送进 <img> 前用 isQrDataUrl 自检（防御恶意 host 消息）。
      set({ qqLoginQr: msg });
      return;
    }
    if (msg.type === "qqManagedStatus") {
      set({ qqManagedStatus: msg });
      return;
    }
    if (msg.type === "hostSettings") {
      const { type, ...settings } = msg;
      void type;
      const uiFontSize = settings.uiFontSize ?? "standard";
      const uiDensity = settings.uiDensity ?? "standard";
      applyUiScale(uiFontSize, uiDensity);
      set((s) => ({ hostSettings: { ...s.hostSettings, ...settings, uiFontSize, uiDensity } }));
      // One-shot migration: the old theme toggle stored the choice in
      // localStorage. Now it is a synced setting; hand the legacy value to
      // the host once and clear the key so it never overrides a config edit.
      try {
        const legacy = window.localStorage.getItem("iflow-theme");
        if (legacy) {
          window.localStorage.removeItem("iflow-theme");
          if (settings.theme === "auto" && (legacy === "light" || legacy === "dark")) {
            get().updateHostSetting({ theme: legacy });
          }
        }
      } catch {
        // localStorage can be unavailable in hardened webviews.
      }
      return;
    }
    if (msg.type === "contextWindowOverrides") {
      // The structured 「上下文窗口覆写」 editor's data source: the current
      // rows plus the current model's built-in window (for its one-click
      // suggestion). Full replacement — the host always sends the whole table.
      set({
        contextWindowOverridesView: {
          overrides: [...msg.overrides],
          ...(msg.currentModelId ? { currentModelId: msg.currentModelId } : {}),
          ...(msg.builtinWindow !== undefined ? { builtinWindow: msg.builtinWindow } : {}),
        },
      });
      return;
    }
    if (msg.type === "modelMetadataState") {
      set({ modelMetadata: { state: msg.state, added: msg.added, error: msg.error } });
      return;
    }
    if (msg.type === "theme") {
      set({ editorTheme: msg.kind });
      if (msg.auroraIntensity !== undefined) {
        const pct = Math.min(100, Math.max(0, msg.auroraIntensity));
        document.documentElement.style.setProperty("--aurora-opacity", String(pct / 100));
      }
      return;
    }
    if (msg.type === "playSound") {
      playCue(msg.kind);
      return;
    }
    if (msg.type === "toast") {
      const id = ++toastSeq;
      const countdownDeadline = msg.countdownDeadline;
      const persistent = msg.persistent === true;
      const sticky = msg.sticky === true;
      set((s) => ({
        toasts: [
          ...s.toasts,
          {
            id,
            level: msg.level,
            message: msg.message,
            countdownDeadline,
            displayOnly: msg.displayOnly,
            toastId: msg.toastId,
            persistent,
            sticky,
            action: msg.action,
            preview: msg.preview,
          },
        ],
      }));
      // Persistent pills are host-owned (e.g. the auto-compress notice): they
      // stay until the host sends `dismissToast`. Sticky pills (auto-memory
      // candidates) also stay, but the user may close them locally. Countdown
      // toasts live until the host's deadline; others get a clamped default
      // lifetime (5s, host may extend to 15s).
      if (!persistent && !sticky) {
        const duration = countdownDeadline !== undefined
          ? Math.max(0, countdownDeadline - Date.now())
          : Math.min(Math.max(msg.durationMs ?? 5000, 2000), 15_000);
        setTimeout(() => get().dismissToast(id), duration);
      }
      return;
    }
    if (msg.type === "dismissToast") {
      // Host ids and WebView-local ids are separate sequences — match on the
      // stored `toastId`, not the local one.
      set((s) => ({ toasts: s.toasts.filter((t) => t.toastId !== msg.toastId) }));
      return;
    }
    // Consumed by their own window-level listeners (Composer registers those
    // itself) — reaching here is normal, not an unknown-message tripwire.
    if (
      msg.type === "fileList" ||
      msg.type === "stagedFiles" ||
      msg.type === "filesPicked" ||
      msg.type === "mcpServers" ||
      msg.type === "mcpStatus" ||
      msg.type === "assetsState" ||
      msg.type === "assetContent" ||
      msg.type === "assetSaved" ||
      msg.type === "assetDeleted" ||
      msg.type === "assetGenerated" ||
      msg.type === "memoryState" ||
      msg.type === "memorySaved" ||
      msg.type === "memoryFileContent" ||
      msg.type === "memoryCandidates" ||
      msg.type === "memoryCurated" ||
      msg.type === "knowledgeJob" ||
      msg.type === "profileDeleteResult" ||
      msg.type === "saveAuthResult" ||
      msg.type === "enhancedPrompt" ||
      msg.type === "queueEdited" ||
      msg.type === "contextResolved" ||
      msg.type === "turnChanges" ||
      msg.type === "turnFileReverted"
    ) {
      return;
    }
    // Version-mismatch tripwire: a host/webview pair built from different
    // commits silently drops unknown message kinds (e.g. a pre-P-1 webview
    // ignoring blockPatch) — the exact "blocks disappear" bug. Surface it.
    console.warn(`[iflow] unknown host message: ${(msg as { type?: string }).type}`);
  },
  respondSuperResidueConfirm: (confirmed) => {
    const request = get().superResidueConfirm;
    if (!request) return;
    // Clear synchronously BEFORE sending: a second click / Esc-on-backdrop
    // racing the re-render must not post a second answer. The host also
    // de-dupes by requestId, but the webview never relies on that.
    set({ superResidueConfirm: null });
    get().send({ type: "respondSuperResidueConfirm", requestId: request.requestId, confirmed });
    // 这条确认框也服务于「丢弃残留」：确认后宿主的清单已经变了，刷新一次
    // 让看板显示真实结果（清空并新建那条流程没有请求过清单，不会触发）。
    if (confirmed && get().superResidueRequestId !== null) get().requestSuperResidueList();
  },
  requestSuperResidueList: () => {
    const requestId = `webview-residue-${++superResidueRequestSeq}`;
    set({ superResidueRequestId: requestId, superResidueLoading: true });
    get().send({ type: "requestSuperResidueList", requestId });
  },
  handleSuperResidueAction: (action, sessionIds) => {
    const ids = sessionIds.filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return;
    const list = get().superResidueList;
    if (!list || !list.confirmToken) {
      // 没有令牌 = 用户还没拿到清单（或回包被丢弃）：如实提示并重新请求，
      // 绝不发一条注定被宿主拒绝的处置消息。
      get().notify(t("残留清单已过期，正在重新获取"), "warning");
      get().requestSuperResidueList();
      return;
    }
    get().send({
      type: "superResidueHandle",
      action,
      sessionIds: ids,
      confirmToken: list.confirmToken,
    });
    // 令牌是一次性的：宿主消费后旧令牌立即失效。先清掉本地令牌（保留清单
    // 行让视图不闪空），再立刻换发新清单 —— 刷新回包到达前的第二次点击会
    // 走「令牌缺失」分支重新请求，而不是拿死令牌再发一条被宿主拒绝的消息。
    set({ superResidueList: { ...list, confirmToken: "" } });
    get().requestSuperResidueList();
  },
  beginPending: (kind, target) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    set({ pending: { kind, target } });
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      set({ pending: null });
    }, PENDING_TIMEOUT_MS);
  },
  clearPending: () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    set({ pending: null });
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  notify: (message, level = "info") => {
    // Local notices share the host toast stack (one notification surface) and
    // the same id sequence, so dismissToast works for both.
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, level, message }] }));
    setTimeout(() => get().dismissToast(id), LOCAL_TOAST_MS);
  },
  updateHostSetting: (patch) => {
    set((s) => ({ hostSettings: { ...s.hostSettings, ...patch } }));
    const next = get().hostSettings;
    applyUiScale(next.uiFontSize, next.uiDensity);
    get().send({ type: "setHostSettings", ...patch });
  },
  send: (msg) => {
    // Debounce: identical messages fired within the window (double-clicks on
    // send / revert / switch buttons) are dropped. `cancel` is exempt — it is
    // the user's Stop click, and silently swallowing it is the "clicking Stop
    // does nothing" bug class. The host already sends at most one
    // `session/cancel` per in-flight request (`sendTurnCancel`), so letting
    // every click through cannot turn into a cancel storm.
    const key = JSON.stringify(msg);
    const now = Date.now();
    if (msg.type !== "cancel" && key === lastSentKey && now - lastSentAt < SEND_DEBOUNCE_MS) return;
    lastSentKey = key;
    lastSentAt = now;
    if (msg.type === "sendPrompt") {
      // Signal MessageList to jump to the bottom (see promptSeq on ChatStore).
      set({ promptSeq: get().promptSeq + 1 });
    }
    vscode.postMessage(msg);
  },
}));

export function setupHostListener(): void {
  window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    useChat.getState().applyHostMessage(event.data);
  });
  // Pre-unlock Web Audio inside user gestures (see unlockAudio): without this
  // the turn-end cue is created suspended and stays silent whenever focus has
  // moved back to the editor — the exact "sound only plays sometimes" bug.
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);
  useChat.getState().send({ type: "ready" });
}
