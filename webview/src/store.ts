import { create } from "zustand";
import {
  applyBlockPatch,
  evictBlockPayloads,
  type ApprovalRule,
  type HostSettingsUi,
  type HostToWebview,
  type KnowledgeDocUi,
  type MemoryCandidateUi,
  type MemoryFileUi,
  type MemoryScope,
  type MemoryStateUi,
  type SessionState,
  type SessionSummaryUi,
  type UiDensity,
  type UiFontSize,
  type WebviewToHost,
} from "../../shared/messages";
import { collectTurnChanges } from "../../shared/turn-changes";

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
  restoreLastSession: false,
  autoOpenPanel: false,
  warmStart: true,
  soundFeedback: true,
  osNotifications: "approvals",
  language: "",
  defaultMode: "smart",
  approvalMode: "",
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
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    // Audio unavailable (headless/hostile env) — the cue is best-effort.
  }
}

/**
 * Synthesized cues:
 * - "done": rising two-tone chime (E5 → G5), short and positive.
 * - "error": falling double-buzz (A3 → F3, square), unmistakably wrong.
 * Volume kept low (0.08 peak); ~0.35s total, never overlaps the next turn.
 */
function playCue(kind: "done" | "error"): void {
  try {
    unlockAudio();
    if (!audioCtx) return; // AudioContext construction failed in unlockAudio
    const t = audioCtx.currentTime + 0.01;
    if (kind === "done") {
      blip(audioCtx, 659.25, t, 0.14, "sine", 0.08);
      blip(audioCtx, 783.99, t + 0.13, 0.2, "sine", 0.08);
    } else {
      blip(audioCtx, 220, t, 0.13, "square", 0.05);
      blip(audioCtx, 174.61, t + 0.15, 0.2, "square", 0.05);
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
    window.setTimeout(
      () => window.dispatchEvent(new MessageEvent("message", { data: { ...msg, locale: "zh-cn" } })),
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
  // Mock approval-policy table + 「始终允许」 draft (M4 P1-1), same shape as
  // the host's approvalPolicy message.
  let mockApprovalRules: ApprovalRule[] | undefined;
  let mockApprovalDraft: ApprovalRule | null | undefined;

  // Mock memory files (F3): enough to exercise the tab in a browser — one
  // global primary with structured facts, one project file, one legacy file.
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
    { kind: "thought", text: "用户想了解仓库结构，先列出目录。" },
    {
      kind: "tool",
      id: "demo-shell-block",
      toolCallId: "demo-shell",
      toolName: "run_shell_command",
      title: "run_shell_command",
      toolKind: "execute",
      status: "completed",
      input: 'npm run build 2>&1 | tail -20 && cd webview && npx tsc --noEmit',
      output: "Stdout: build ok\nStderr: (empty)\nExit Code: 0",
      truncatedChars: 4096,
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
      input: '{"pattern":"ToolBlock|toolName","path":"/repo/shared/messages.ts"}',
      output: "找到 14 个匹配",
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
      title: "Listing J:\\git\\iFlow-chat",
      toolKind: "read",
      status: "completed",
      output: "docs\niflow.js.original",
      locations: [{ path: "J:\\git\\iFlow-chat", line: null }],
      diff: null,
    },
    {
      kind: "tool",
      toolCallId: "demo-2",
      toolName: "edit_file",
      title: "Edit src/demo.ts",
      toolKind: "edit",
      status: "completed",
      output: "",
      locations: [{ path: "J:\\git\\iFlow-chat\\src\\demo.ts", line: 3 }],
      diff: {
        path: "J:\\git\\iFlow-chat\\src\\demo.ts",
        oldText: [
          'import { init } from "./core";',
          'const version = "1.0.0";',
          "const retries = 2;",
          "export function main() {",
          "  init(version);",
          '  log("started");',
          "}",
          "",
          "function log(msg: string) {",
          "  console.log(msg);",
          "}",
          "// end of file",
        ].join("\n"),
        newText: [
          'import { init } from "./core";',
          'const version = "1.0.0";',
          "const retries = 5;",
          "const timeoutMs = 3000;",
          "export function main() {",
          "  init(version);",
          '  log("started");',
          "}",
          "",
          "function log(msg: string) {",
          "  console.log(msg);",
          "}",
          "// end of file",
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
        { kind: "tool", toolCallId: "sa-1", toolName: "read_file", title: "Reading J:\\git\\iFlow-chat\\package.json", toolKind: "read", status: "completed", output: "", locations: [], diff: null },
        { kind: "tool", toolCallId: "sa-2", toolName: "run_shell_command", title: "Running: node --version; npm --version", toolKind: "execute", status: "completed", output: "", locations: [], diff: null },
      ],
    },
    {
      kind: "injected",
      notice: "本次请求自动注入了 6 项内容：系统提示词、全局记忆、1 个项目记忆文件、1 个知识库文档、1 个 MCP 服务器、1 个 MCP 服务器未连接",
      tokens: 31240,
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
        {
          kind: "mcp",
          label: "apipost-mcp",
          content:
            '{"name":"create_api","description":"Create an API endpoint","parameters":{"type":"object","properties":{"name":{"type":"string"}}}}\n' +
            '{"name":"update_api","description":"Modify an API endpoint","parameters":{"type":"object"}}\n' +
            '{"name":"list_projects","description":"List API projects","parameters":{"type":"object"}}',
        },
        { kind: "mcp", label: "exa", content: "", connected: false },
      ],
    },
    {
      kind: "compression",
      notice: "上下文已压缩：98134 → 7855 tokens",
      newTokenCount: 7855,
      summary:
        "This session is being continued from a previous conversation that ran out of context.\n\n按时间顺序分析这次对话：\n\n- 项目背景：Pandora 事件模块「个性化训练计划历史系统」，核心文件 `shared.js`（约 1160 行）、`create_tables.sql`、`models/index.js`。\n- 通知手机号绑定接口：登录接入链路误改为网页授权 OAuth2，需移除手机号绑定接口、移除 /auth/me。\n- 用户纠正：除了店员端接口都应该使用微信登录返回的 openid——session/token 机制要保留。",
    },
    {
      kind: "text",
      text: [
        "这是 **iFlow-chat** 仓库，包含 `docs/` 方案文档与 iFlow CLI 内核文件。\n\n- 需要我深入看某个部分吗？",
        "",
        "```json",
        '{',
        '  "name": "iflow-chat",',
        '  "version": "1.0.0",',
        '  "private": true,',
        '  "scripts": { "dev": "vite --port 5173" },',
        '  "retries": 3',
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
    { kind: "plan", id: "demo-plan", entries: [{ content: "M1 最小面板", status: "completed" }, { content: "M2 工具可视化 + 审批", status: "in_progress" }] },
  ];
  const demoApproval: SessionState["pendingApproval"] = {
    id: "perm-demo-1",
    toolName: "write_file",
    title: "Write config/settings.json",
    toolKind: "edit",
    locations: [{ path: "J:\\git\\iFlow-chat\\config\\settings.json", line: null }],
    options: [
      { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
      { optionId: "allow-always", name: "本次会话始终允许", kind: "allow_always" },
      { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
    ],
    // Mock the real host: 5-minute expiry window.
    deadline: Date.now() + 5 * 60_000,
    timeoutMs: 5 * 60_000,
  };
  // Demo plan-exit card: surfaced when the user switches to Plan mode in the
  // mock host (mirrors the real flow — plan mode → agent exits plan → card).
  // Markdown-heavy so the render/edit toggle in PlanExitCard is exercisable
  // in browser debug mode.
  const demoPlanExit: SessionState["pendingPlanExit"] = {
    id: "plan-demo-1",
    plan: [
      "## Token 计费追踪优化",
      "",
      "先改 **shared/session-state.ts**：",
      "",
      "1. `appendTokenUsage` 流式追加改为增量累加 token（替代失效缓存），使流式缓存索失效前刷新 BPE 量",
      "2. `upsertToolBlock` 仅内容变化才重算 token（纯态翻稳定缓存），消除工具更新的 BPE 热点",
      "3. `refreshSessionUsage(state)` 引用稳定（数值不变换对象引用）",
      "",
      "再改 **src/panel/store.ts**：",
      "",
      "- `streaming` 期间在 `pushSnapshot` 按 500ms 节流刷新 usage chip",
      "",
      "> 风险：`gpt-tokenizer` 计数是 O(size)，长会话注意节流。",
    ].join("\n"),
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
  const demoMeta = {
    sessionId: "mock-session",
    modes: { currentModeId: "smart", availableModes: [
      { id: "smart", name: "Smart" }, { id: "yolo", name: "YOLO" },
      { id: "default", name: "Default" }, { id: "plan", name: "Plan" },
    ] },
    commands: [
      { name: "init", description: "分析项目并创建或更新定制的 IFLOW.md 文件" },
      { name: "commit", description: "分析您的更改并创建有意义的提交消息" },
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
      inputTokens: 18432,
      outputTokens: 6421,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 24853,
      contextWindow: 200_000,
      contextUsed: 24853,
      estimated: false,
      breakdown: { user: 3211, assistant: 5120, tool: 14201, thought: 2321 },
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
    pendingPlanExit: null,
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
      { name: "BUZZ", source: "cli", baseUrl: "https://api.buzzgw.com/v1", modelName: "glm-5.3-flash-free", keyTail: "…mock", active: false },
      { name: "工作密钥", source: "extension", baseUrl: "https://api.example.com/v1", modelName: "deepseek-v4-pro", keyTail: "…9999", active: true },
    ],
    importable: [
      { name: "终端默认", baseUrl: "https://api.buzzgw.com/v1", modelName: "glm-5.3-flash-free", keyTail: "…mock" },
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
  return {
    postMessage(msg) {
      const m = msg as WebviewToHost;
      if (m.type === "ready") {
        broadcast({ type: "theme", kind: mockTheme });
        broadcast({ type: "hostSettings", ...mockHostSettings });
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
            { name, source: "extension", baseUrl: m.baseUrl, modelName: m.modelName, keyTail, active: true },
            ...authState.profiles
              .filter((p) => p.name !== name)
              .map((p) => ({ ...p, active: false })),
          ],
          importable: authState.importable.filter((c) => c.name !== name),
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
      if (m.type === "importCliCredentials") {
        const candidate = authState.importable.find((c) => c.name === m.name);
        if (!candidate) return;
        authState = {
          authenticated: true,
          needsSetup: false,
          saved: { baseUrl: candidate.baseUrl, modelName: candidate.modelName, keyTail: candidate.keyTail },
          profiles: [
            {
              name: candidate.name,
              source: "extension",
              baseUrl: candidate.baseUrl,
              modelName: candidate.modelName,
              keyTail: candidate.keyTail,
              active: true,
            },
            ...authState.profiles
              .filter((p) => p.name !== candidate.name)
              .map((p) => ({ ...p, active: false })),
          ],
          importable: authState.importable.filter((c) => c.name !== m.name),
          onboardingDismissed: authState.onboardingDismissed,
        };
        demoMeta.models = [
          { id: candidate.modelName, name: candidate.modelName },
          ...demoMeta.models.filter((x) => x.id !== candidate.modelName),
        ];
        demoMeta.currentModelId = candidate.modelName;
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
          importable: authState.importable,
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
            title: "Write config/settings.json",
            toolKind: "edit",
            status: "completed",
            output: "",
            locations: [{ path: "J:\\git\\iFlow-chat\\config\\settings.json", line: null }],
            diff: {
              path: "J:\\git\\iFlow-chat\\config\\settings.json",
              oldText: "{\n  \"theme\": \"light\"\n}\n",
              newText: "{\n  \"theme\": \"dark\",\n  \"telemetry\": false\n}\n",
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
      if (m.type === "respondPlanExit") {
        // Replan with edited text (reason): record the revision in the mock
        // transcript so the edited plan has a visible destination in demo.
        const replanNote = m.replan && m.reason ? `（修改：${m.reason.slice(0, 60)}${m.reason.length > 60 ? "…" : ""}）` : "";
        demoBlocks.push({
          kind: "text",
          text: `*plan exit — ${m.approved ? "已批准（mock）" : m.replan ? `已重新规划（mock）${replanNote}` : "已拒绝（mock）"}*`,
        });
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "streaming",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            pendingApproval: null,
            pendingPlanExit: null,
            auth: authState,
          },
        });
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
      if (m.type === "setMode") {
        // Mirrors real CLI behavior: respond with the new current mode.
        demoMeta.modes = {
          ...demoMeta.modes,
          currentModeId: m.modeId,
        };
        // Mock plan-exit demo: switching INTO Plan mode surfaces the demo
        // card (mirrors the real flow — plan mode → agent requests exit →
        // card). Switching out clears it.
        const showPlanCard = m.modeId === "plan";
        if (showPlanCard) {
          demoPlanExit.deadline = Date.now() + demoPlanExit.timeoutMs;
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
            pendingPlanExit: showPlanCard ? demoPlanExit : null,
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
      if (m.type === "listApprovalPolicy" || m.type === "saveApprovalPolicy" || m.type === "dismissApprovalRuleDraft") {
        if (m.type === "saveApprovalPolicy") mockApprovalRules = m.rules;
        if (m.type === "dismissApprovalRuleDraft") mockApprovalDraft = null;
        if (!mockApprovalRules) {
          mockApprovalRules = [
            { id: "rule-read-src", label: "允许读取 src 下文件", enabled: true, action: "allow", kinds: ["read"], path: "src/**", hits: 12 },
            { id: "deny-env", label: "拒绝读取 .env", enabled: true, action: "deny", path: "**/.env*" },
            { id: "ask-push", label: "git push 弹卡", enabled: false, action: "ask", commands: ["git"] },
          ];
          mockApprovalDraft = {
            id: `rule-draft-${Date.now().toString(36)}`,
            label: "允许执行 git status",
            enabled: true,
            action: "allow",
            kinds: ["execute"],
            commands: ["git"],
          };
        }
        const payload = {
          type: "approvalPolicy",
          rules: mockApprovalRules,
          projectRules: [{ id: "proj-lock", label: "项目：拒绝改 lock 文件", enabled: true, action: "deny", path: "**/package-lock.json" }],
          draft: mockApprovalDraft,
        };
        window.setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: payload })), 80);
        return;
      }
      if (m.type === "stopSubagent") {
        // The mock mirrors the agent-cancel Mod: only the targeted agent
        // stops; the parent turn keeps running with an interrupted result.
        // (No real subagent lifecycle here, so settle the demo turn.)
        demoBlocks.push({ kind: "text", text: "*（已停止该子代理，整轮继续，mock）*" });
        settleMockTurn();
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
 */
const EVICT_KEEP_BLOCKS = 200;

/** Apply the payload eviction to an incoming state; identity-stable pass. */
function evict(state: SessionState): SessionState {
  const blocks = evictBlockPayloads(state.blocks, EVICT_KEEP_BLOCKS);
  return blocks === state.blocks ? state : { ...state, blocks };
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentKey = "";
let lastSentAt = 0;
let lastResyncAt = 0;
let toastSeq = 0;

/** Ask the host for a full snapshot (P-1: a blockPatch we cannot anchor). */
function requestResync(): void {
  const now = Date.now();
  if (now - lastResyncAt < RESYNC_THROTTLE_MS) return;
  lastResyncAt = now;
  vscode.postMessage({ type: "ready" });
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
}

interface ChatStore {
  state: SessionState | null;
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
  /** Transient host notices (auto-dismissed); see applyHostMessage toast case. */
  toasts: ToastItem[];
  dismissToast: (id: number) => void;
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

import { setLocale } from "./i18n";

export const useChat = create<ChatStore>((set, get) => ({
  state: null,
  editorTheme: null,
  hostSettings: { ...DEFAULT_HOST_SETTINGS },
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
      // A pending switch is cleared as soon as the host confirms the value.
      const pending = get().pending;
      if (pending) {
        const confirmed =
          (pending.kind === "profile" &&
            msg.state.auth.profiles.find((p) => p.name === pending.target)?.active) ||
          (pending.kind === "model" && msg.state.currentModelId === pending.target) ||
          (pending.kind === "mode" && msg.state.modes?.currentModeId === pending.target) ||
          (pending.kind === "think" && msg.state.thinkLevel === pending.target);
        if (confirmed) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          set({ pending: null, state: evict(msg.state) });
          return;
        }
      }
      set({ state: evict(msg.state) });
      return;
    }
    if (msg.type === "blockPatch") {
      // P-1 incremental snapshot: merge the tail onto the anchored state, then
      // apply the piggybacked non-block metadata. An unanchorable patch (webview
      // booted without a snapshot, missed patch, out-of-bounds tail) triggers a
      // throttled full re-sync.
      const current = get().state;
      const blocks = applyBlockPatch(current, msg);
      if (!blocks) {
        requestResync();
        return;
      }
      const state: SessionState = evict({ ...msg.tail, blocks });
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
          set({ pending: null, state });
          return;
        }
      }
      set({ state });
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
      msg.type === "knowledgeJob" ||
      msg.type === "approvalPolicy" ||
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
  updateHostSetting: (patch) => {
    set((s) => ({ hostSettings: { ...s.hostSettings, ...patch } }));
    const next = get().hostSettings;
    applyUiScale(next.uiFontSize, next.uiDensity);
    get().send({ type: "setHostSettings", ...patch });
  },
  send: (msg) => {
    // Debounce: identical messages fired within the window (double-clicks on
    // send / revert / switch buttons) are dropped.
    const key = JSON.stringify(msg);
    const now = Date.now();
    if (key === lastSentKey && now - lastSentAt < SEND_DEBOUNCE_MS) return;
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
