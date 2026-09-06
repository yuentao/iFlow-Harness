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
    window.setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: msg })), 60);
  };
  const demoBlocks: SessionState["blocks"] = [
    { kind: "user", text: "帮我看看这个仓库结构" },
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
        oldText: "const greeting = \"hello\";\nconst version = 1;\nexport function greet() {\n  return greeting;\n}\n",
        newText: "const greeting = \"hello, world\";\nconst version = 2;\nconst scope = \"demo\";\nexport function greet() {\n  return `${greeting} (v${version}, ${scope})`;\n}\n",
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
  };
  return {
    postMessage(msg) {
      const m = msg as WebviewToHost;
      if (m.type === "ready") {
        broadcast({
          type: "snapshot",
          state: {
            blocks: demoBlocks,
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            ...demoMeta,
            pendingApproval: demoApproval,
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
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "idle",
            errorMessage: null,
            stopReason: "end_turn",
            pendingApproval: activeApproval,
            ...demoMeta,
          },
        });
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
            pendingApproval: activeApproval,
            ...demoMeta,
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
          },
        });
        return;
      }
      if (m.type === "sendPrompt") {
        demoBlocks.push({ kind: "user", text: m.text });
        broadcast({
          type: "snapshot",
          state: {
            blocks: [...demoBlocks],
            status: "streaming",
            errorMessage: null,
            stopReason: null,
            ...demoMeta,
            pendingApproval: activeApproval,
          },
        });
        window.setTimeout(() => {
          demoBlocks.push({ kind: "text", text: `Echo（mock host）: ${m.text}` });
          broadcast({
            type: "snapshot",
            state: {
              blocks: [...demoBlocks],
              status: "idle",
              errorMessage: null,
              stopReason: "end_turn",
              ...demoMeta,
              pendingApproval: activeApproval,
            },
          });
        }, 500);
      }
    },
  };
}

const vscode: HostApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : createMockHost();

interface ChatStore {
  state: SessionState | null;
  applyHostMessage: (msg: HostToWebview) => void;
  send: (msg: WebviewToHost) => void;
}

export const useChat = create<ChatStore>((set) => ({
  state: null,
  applyHostMessage: (msg) => {
    if (msg.type === "snapshot") set({ state: msg.state });
  },
  send: (msg) => vscode.postMessage(msg),
}));

export function setupHostListener(): void {
  window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    useChat.getState().applyHostMessage(event.data);
  });
  useChat.getState().send({ type: "ready" });
}
