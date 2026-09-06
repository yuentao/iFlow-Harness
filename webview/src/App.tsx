import { useChat } from "./store";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ApprovalCard } from "./components/ApprovalCard";

export function App() {
  const state = useChat((s) => s.state);
  const send = useChat((s) => s.send);

  if (!state) return <div className="loading">连接中…</div>;

  return (
    <div className="app">
      <div className="topbar">
        <span className={`status-dot ${state.status}`} title={state.status} />
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
      </div>

      {state.errorMessage && <div className="error-banner">{state.errorMessage}</div>}

      <MessageList />
      {state.pendingApproval && <ApprovalCard approval={state.pendingApproval} />}
      <Composer />
    </div>
  );
}
