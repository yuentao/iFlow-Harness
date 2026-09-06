import { useState } from "react";
import { useChat } from "./store";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";
import { AuthCard } from "./components/AuthCard";

export function App() {
  const state = useChat((s) => s.state);
  const send = useChat((s) => s.send);
  const [configOpen, setConfigOpen] = useState(false);

  if (!state) return <div className="loading">连接中…（iFlow CLI 启动可能需要十几秒，配置了多个 MCP server 时更久）</div>;

  const showAuthCard = state.auth.needsSetup || configOpen;

  return (
    <div className="app">
      <div className="topbar">
        <span className={`status-dot ${state.status}`} title={state.status} />
        {state.sessions.length > 0 && (
          <select
            className="session-select"
            value={state.activeSessionId ?? ""}
            onChange={(e) => send({ type: "loadSession", sessionId: e.target.value })}
            title="历史会话（选择后恢复该会话上下文）"
          >
            {state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId) && (
              <option value={state.activeSessionId}>当前会话</option>
            )}
            {state.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        {state.auth.profiles.length > 1 && (
          <select
            className="profile-select"
            value={state.auth.profiles.find((p) => p.active)?.name ?? ""}
            onChange={(e) => send({ type: "activateProfile", name: e.target.value })}
            title="API 配置（点击切换后重新认证）"
          >
            {state.auth.profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {state.modes && (
          <select
            className="mode-select"
            value={state.modes.currentModeId}
            onChange={(e) => send({ type: "setMode", modeId: e.target.value })}
            title="权限模式"
          >
            {state.modes.availableModes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {state.models.length > 0 && (
          <select
            className="model-select"
            value={state.currentModelId ?? ""}
            onChange={(e) => send({ type: "setModel", modelId: e.target.value })}
            title="模型"
          >
            {state.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn new-session" title="新会话" onClick={() => send({ type: "newSession" })}>
          ＋
        </button>
        <button
          className={`btn auth-gear${state.auth.authenticated ? "" : " attention"}`}
          title="API 凭据配置"
          onClick={() => setConfigOpen((v) => !v)}
        >
          ⚙
        </button>
      </div>

      {state.errorMessage && <div className="error-banner">{state.errorMessage}</div>}

      <MessageList />
      {showAuthCard && (
        <AuthCard auth={state.auth} editable={configOpen} onDismiss={() => setConfigOpen(false)} />
      )}
      {state.pendingApproval && <ApprovalCard approval={state.pendingApproval} />}
      <Composer />
    </div>
  );
}
