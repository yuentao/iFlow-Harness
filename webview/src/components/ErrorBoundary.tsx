import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { t } from "../i18n";

interface Props {
  children: ReactNode;
  /**
   * Self-heal anchor: when this value changes identity (a new snapshot /
   * blockPatch landed) while the fallback is showing, retry rendering once.
   * Streaming white-outs are usually caused by one transient chunk of content,
   * so the next patch normally renders fine — without this the user had to
   * close and reopen the panel tab to get the UI back.
   */
  resetKey?: unknown;
  /** "page" = full-screen fallback (root boundary); "inline" = a card that
   * keeps the surrounding layout (header / composer) mounted. */
  variant?: "page" | "inline";
}

interface State {
  error: Error | null;
}

/**
 * Render-phase error boundary. Without one, ANY throw during render/commit
 * (e.g. markdown parsing a pathological streaming chunk) unmounts the whole
 * React tree — the panel collapses to the bare body gradient until the webview
 * reloads ("生成中整屏空白，重开标签页才恢复"). The boundary keeps the app
 * alive, logs the stack to the console (webview devtools) for root-cause
 * follow-up, and retries automatically when `resetKey` changes (next host
 * update) or the user presses 重试.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the full trace in the console so the exact throw site can be
    // reproduced from a webview-devtools screenshot next time it happens.
    console.error("[iflow] render error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const retry = (
      <button
        onClick={this.reset}
        className="card-lift press inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-3 py-1.5 text-[12px] font-medium text-foreground shadow-card transition-colors hover:bg-surface-2"
      >
        <RotateCcw className="size-3.5" /> {t("重试")}
      </button>
    );
    if (this.props.variant === "page") {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="size-7 text-warning" />
          <div className="text-[14px] font-semibold text-foreground">{t("界面渲染异常")}</div>
          <p className="max-w-[320px] text-[11.5px] leading-relaxed text-muted-foreground">
            {t("界面渲染时遇到异常。重新载入面板即可恢复；也可以直接重试。")}
          </p>
          {retry}
        </div>
      );
    }
    return (
      <div className="relative min-h-0 flex-1">
        <div className="stream-in mx-auto mt-6 flex max-w-[420px] flex-col items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-5 text-center">
          <AlertTriangle className="size-5 text-warning" />
          <div className="text-[13px] font-semibold text-foreground">{t("消息区渲染异常")}</div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            {t("内容渲染时遇到异常，将在下一次更新时自动重试。")}
          </p>
          {retry}
        </div>
      </div>
    );
  }
}
