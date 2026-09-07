import { create } from "zustand";
import type { HostToWebview, SessionState, WebviewToHost } from "../../shared/messages";

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

interface HostApi {
  postMessage: (msg: unknown) => void;
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
            block.status = "failed";
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
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
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
      if (m.type === "sendPrompt") {
        sendPromptFlow(m.text);
      }
    },
  };
}

const vscode: HostApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : createMockHost();

interface ChatStore {
  state: SessionState | null;
  /** Latest editor theme from the host; null until the first `theme` message. */
  editorTheme: "light" | "dark" | null;
  applyHostMessage: (msg: HostToWebview) => void;
  send: (msg: WebviewToHost) => void;
}

import { setLocale } from "./i18n";

export const useChat = create<ChatStore>((set) => ({
  state: null,
  editorTheme: null,
  applyHostMessage: (msg) => {
    // Only the snapshot updates the store. Other message kinds (fileList,
    // setDraft) are consumed by their own window-level listeners — Composer
    // registers those itself, so no re-dispatch happens here.
    if (msg.type === "snapshot") {
      setLocale(msg.locale);
      set({ state: msg.state });
      return;
    }
    if (msg.type === "theme") {
      set({ editorTheme: msg.kind });
    }
  },
  send: (msg) => vscode.postMessage(msg),
}));

export function setupHostListener(): void {
  window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    useChat.getState().applyHostMessage(event.data);
  });
  useChat.getState().send({ type: "ready" });
}
