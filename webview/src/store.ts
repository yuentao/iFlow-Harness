import { create } from "zustand";
import {
  applyBlockPatch,
  evictBlockPayloads,
  type ApprovalRule,
  type HostToWebview,
  type SessionState,
  type SessionSummaryUi,
  type WebviewToHost,
} from "../../shared/messages";

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

interface HostApi {
  postMessage: (msg: unknown) => void;
}

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
  // Mock MCP dict: lazily seeded on first read, replaced wholesale on save
  // (mirrors the host's replace semantics).
  let mockMcpServers: Record<string, unknown> | undefined;
  // Mock approval-policy table + 「始终允许」 draft (M4 P1-1), same shape as
  // the host's approvalPolicy message.
  let mockApprovalRules: ApprovalRule[] | undefined;
  let mockApprovalDraft: ApprovalRule | null | undefined;
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
    { kind: "plan", entries: [{ content: "M1 最小面板", status: "completed" }, { content: "M2 工具可视化 + 审批", status: "in_progress" }] },
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
  function settleMockTurn(): void {
    if (mockTurnEndTimer !== null) {
      window.clearTimeout(mockTurnEndTimer);
      mockTurnEndTimer = null;
    }
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
      if (m.type === "clearAuth") {
        authState = {
          authenticated: false,
          needsSetup: true,
          saved: null,
          profiles: authState.profiles.map((p) => ({ ...p, active: false })),
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
      if (m.type === "listMcpServers") {
        const reply = (servers: Record<string, unknown>) =>
          window.setTimeout(
            () => window.dispatchEvent(new MessageEvent("message", { data: { type: "mcpServers", servers } })),
            80,
          );
        reply(mockMcpServers ?? (mockMcpServers = {
          "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
          "remote-example": { url: "https://mcp.example.com/mcp", type: "http" },
        }));
        return;
      }
      if (m.type === "saveMcpServers") {
        mockMcpServers = m.servers;
        window.setTimeout(
          () =>
            window.dispatchEvent(
              new MessageEvent("message", { data: { type: "mcpServers", servers: mockMcpServers ?? {} } }),
            ),
          80,
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
export type PendingOpKind = "profile" | "model" | "mode";

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
 * Long-session memory bound (2026-10): the webview keeps FULL payloads only
 * for this many transcript-tail blocks; older blocks' heavy content (tool
 * output/diff, thought text, images, compression summaries) is released by
 * `evictBlockPayloads` and rendered with a "released" marker. Must exceed
 * MessageList's MAX_WINDOW (120 mounted blocks) so every mounted card always
 * has its payload; the host state stays complete regardless (revert /
 * export / persistence read the host, not this projection).
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
  /** M1 P0-6: inline action button (e.g. 立即压缩 on the context-warning
   * pill). Clicking sends `toastAction` with the actionId + host toastId. */
  action?: { actionId: string; label: string };
}

interface ChatStore {
  state: SessionState | null;
  /** Latest editor theme from the host; null until the first `theme` message. */
  editorTheme: "light" | "dark" | null;
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
  applyHostMessage: (msg: HostToWebview) => void;
  beginPending: (kind: PendingOpKind, target: string) => void;
  send: (msg: WebviewToHost) => void;
}

import { setLocale } from "./i18n";

export const useChat = create<ChatStore>((set, get) => ({
  state: null,
  editorTheme: null,
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
          (pending.kind === "mode" && msg.state.modes?.currentModeId === pending.target);
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
          (pending.kind === "mode" && state.modes?.currentModeId === pending.target);
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
          },
        ],
      }));
      // Persistent pills are host-owned (e.g. the auto-compress notice): they
      // stay until the host sends `dismissToast`. Countdown toasts live until
      // the host's deadline; others get a clamped default lifetime (5s, host
      // may extend to 15s).
      if (!persistent) {
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
      msg.type === "approvalPolicy" ||
      msg.type === "enhancedPrompt" ||
      msg.type === "queueEdited" ||
      msg.type === "contextResolved"
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
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
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
