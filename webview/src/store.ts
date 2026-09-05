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
    },
    { kind: "text", text: "这是 **iFlow-chat** 仓库，包含 `docs/` 方案文档与 iFlow CLI 内核文件。\n\n- 需要我深入看某个部分吗？" },
    { kind: "plan", entries: [{ content: "M1 最小面板", status: "in_progress" }, { content: "M2 工具可视化", status: "pending" }] },
  ];
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
    models: [
      { id: "glm-5.3-flash-free", name: "GLM-5.3 Flash", thinking: true },
      { id: "deepseek-v3.2-chat", name: "DeepSeek-V3.2" },
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
