import { create } from "zustand";
import {
  applyBlockPatch,
  type HostToWebview,
  type SessionState,
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
  // Mock editor theme: read the OS preference so browser verification can
  // exercise both paths.
  const mockTheme: "dark" | "light" = window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  const demoBlocks: SessionState["blocks"] = [
    {
      // Mirrors the editor right-click "加入 iFlow 上下文" draft so the
      // user-bubble code-context styling (styles.css) is visible in mock mode.
      kind: "user",
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
      entries: [
        { kind: "tool", toolCallId: "sa-1", toolName: "read_file", title: "Reading J:\\git\\iFlow-chat\\package.json", toolKind: "read", status: "completed", output: "", locations: [], diff: null },
        { kind: "tool", toolCallId: "sa-2", toolName: "run_shell_command", title: "Running: node --version; npm --version", toolKind: "execute", status: "completed", output: "", locations: [], diff: null },
      ],
    },
    {
      kind: "compression",
      notice: "上下文已压缩：98134 → 7855 tokens",
      summary:
        "This session is being continued from a previous conversation that ran out of context.\n\n按时间顺序分析这次对话：\n\n- 项目背景：Pandora 事件模块「个性化训练计划历史系统」，核心文件 `shared.js`（约 1160 行）、`create_tables.sql`、`models/index.js`。\n- 通知手机号绑定接口：登录接入链路误改为网页授权 OAuth2，需移除手机号绑定接口、移除 /auth/me。\n- 用户纠正：除了店员端接口都应该使用微信登录返回的 openid——session/token 机制要保留。",
    },
    { kind: "text", text: "这是 **iFlow-chat** 仓库，包含 `docs/` 方案文档与 iFlow CLI 内核文件。\n\n- 需要我深入看某个部分吗？" },
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
  };
  // Mirrors real host semantics: the approval card is consumed once answered;
  // mode/model switches must NOT clear it.
  let activeApproval: SessionState["pendingApproval"] = demoApproval;
  /**
   * Reproduces the real wire timeline: sendPrompt → streaming → permission
   * request arrives mid-flight → user answers → response continues → idle.
   */
  function sendPromptFlow(text: string): void {
    demoBlocks.push({ kind: "user", text });
    // Real host behavior: the newest session gets labeled by its first prompt.
    const current = demoMeta.sessions.find((s) => s.id === demoMeta.activeSessionId);
    if (current && (current.label === "（无标题会话）" || demoMeta.sessions[0] === current)) {
      demoMeta.sessions = [
        { ...current, label: text.slice(0, 60) },
        ...demoMeta.sessions.filter((s) => s.id !== current.id),
      ];
    }
    broadcast({
      type: "snapshot",
      state: {
        blocks: [...demoBlocks],
        status: "streaming",
        errorMessage: null,
        stopReason: null,
        ...demoMeta,
        pendingApproval: null,
        auth: authState,
      },
    });
    // Mid-stream permission request (agent blocks waiting for the answer).
    window.setTimeout(() => {
      activeApproval = demoApproval;
      broadcast({
        type: "snapshot",
        state: {
          blocks: [...demoBlocks],
          status: "streaming",
          errorMessage: null,
          stopReason: null,
          ...demoMeta,
          pendingApproval: activeApproval,
          auth: authState,
        },
      });
    }, 400);
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
    // M4 demo: two persisted sessions; switching restores a short transcript.
    sessions: [
      { id: "mock-session", label: "帮我看看这个仓库结构", updatedAt: Date.now() },
      { id: "mock-session-old", label: "上次的重构讨论", updatedAt: Date.now() - 86_400_000 },
    ],
    activeSessionId: "mock-session",
    // SessionState requires this since the questions feature; the mock never
    // opens a question prompt, so every demo snapshot carries `null`.
    pendingQuestions: null,
    replaying: false,
    initializing: false,
  };
  // M3 demo: start unauthenticated so the setup banner shows; saved state
  // mirrors what the real host stores (masked, never the raw key).
  let authState: SessionState["auth"] = {
    authenticated: false,
    needsSetup: true,
    saved: null,
    profiles: [
      { name: "BUZZ", source: "cli", baseUrl: "https://api.buzzgw.com/v1", modelName: "glm-5.3-flash-free", keyTail: "…mock", active: false },
      { name: "工作密钥", source: "extension", baseUrl: "https://api.example.com/v1", modelName: "deepseek-v4-pro", keyTail: "…9999", active: true },
    ],
  };
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
        const activated = authState.profiles.find((p) => p.name === m.name);
        authState = {
          ...authState,
          authenticated: true,
          needsSetup: false,
          profiles: authState.profiles.map((p) => ({ ...p, active: p.name === m.name })),
        };
        if (activated) {
          // Switching profiles re-queries /models on the new endpoint.
          demoMeta.models = [
            { id: activated.modelName, name: activated.modelName },
            ...demoMeta.models.filter((x) => x.id !== activated.modelName),
          ];
          demoMeta.currentModelId = activated.modelName;
        }
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
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "streaming",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            pendingApproval: null,
            auth: authState,
          },
        });
        window.setTimeout(() => {
          demoBlocks.push({ kind: "text", text: "工具执行完成（mock host）" });
          playCue("done"); // mirror the real host's turn-finished cue
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
      if (m.type === "setMode") {
        // Mirrors real CLI behavior: respond with the new current mode.
        demoMeta.modes = {
          ...demoMeta.modes,
          currentModeId: m.modeId,
        };
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
      if (m.type === "cancel") {
        // Mirror the real host: stop → idle with stopReason "cancelled", and
        // the pending permission request is settled (cancelled) by the CLI.
        activeApproval = null;
        demoBlocks.push({ kind: "text", text: "*（已停止生成，mock）*" });
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "cancelled",
            ...demoMeta,
            pendingApproval: activeApproval,
            auth: authState,
          },
        });
        return;
      }
      if (m.type === "sendPrompt") {
        // Mirror the real host: the code-context card is assembled into the
        // user turn (fenced block ahead of the typed text).
        const cc = m.codeContext;
        const full = cc
          ? [`关于 \`${cc.path}:${cc.range}\`：`, "", "```", cc.code, "```", m.text].filter(Boolean).join("\n\n")
          : m.text;
        sendPromptFlow(full);
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

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentKey = "";
let lastSentAt = 0;
let lastResyncAt = 0;

/** Ask the host for a full snapshot (P-1: a blockPatch we cannot anchor). */
function requestResync(): void {
  const now = Date.now();
  if (now - lastResyncAt < RESYNC_THROTTLE_MS) return;
  lastResyncAt = now;
  vscode.postMessage({ type: "ready" });
}

interface ChatStore {
  state: SessionState | null;
  /** Latest editor theme from the host; null until the first `theme` message. */
  editorTheme: "light" | "dark" | null;
  /** Optimistic switch lock, null when idle (see PendingOp). */
  pending: PendingOp | null;
  applyHostMessage: (msg: HostToWebview) => void;
  beginPending: (kind: PendingOpKind, target: string) => void;
  send: (msg: WebviewToHost) => void;
}

import { setLocale } from "./i18n";

export const useChat = create<ChatStore>((set, get) => ({
  state: null,
  editorTheme: null,
  pending: null,
  applyHostMessage: (msg) => {
    // Snapshot & blockPatch update the store. Other message kinds (fileList,
    // setDraft) are consumed by their own window-level listeners — Composer
    // registers those itself, so no re-dispatch happens here.
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
          set({ pending: null, state: msg.state });
          return;
        }
      }
      set({ state: msg.state });
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
      const state: SessionState = { ...msg.tail, blocks };
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
      return;
    }
    if (msg.type === "playSound") {
      playCue(msg.kind);
      return;
    }
    // Consumed by their own window-level listeners (Composer registers those
    // itself) — reaching here is normal, not an unknown-message tripwire.
    // (setDraft is also Composer-consumed but only exists on the wire, not in
    // the HostToWebview union.)
    if (msg.type === "fileList" || msg.type === "stagedFiles" || msg.type === "filesPicked") {
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
  send: (msg) => {
    // Debounce: identical messages fired within the window (double-clicks on
    // send / revert / switch buttons) are dropped.
    const key = JSON.stringify(msg);
    const now = Date.now();
    if (key === lastSentKey && now - lastSentAt < SEND_DEBOUNCE_MS) return;
    lastSentKey = key;
    lastSentAt = now;
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
