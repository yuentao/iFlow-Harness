import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { t } from "../i18n";
import { Button, ICON_DISPLAY, ICON_INLINE } from "./ui";

interface Props {
  children: ReactNode;
  /**
   * Self-heal anchor: when this value changes identity (a new snapshot /
   * blockPatch landed) while the fallback is showing, retry rendering once.
   * Streaming white-outs are usually caused by one transient chunk of content,
   * so the next patch normally renders fine — without this the user had to
   * close and reopen the panel tab to get the UI back. Repeated failures of
   * the same error are throttled (see RETRY_COOLDOWN_MS) so a permanently bad
   * block cannot spin at the host's patch frequency.
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

/** The host flushes blockPatch at ~80ms (12.5/s). A bad block that survives
 * every patch used to clear-and-rethrow at that rate, flooding console.error.
 * Throttle same-error retries/logs to one per window: a genuinely new throw,
 * a healed render, or a manual 重试 still goes through immediately, so the
 * self-heal ability is kept. */
const RETRY_COOLDOWN_MS = 1500;
const LOG_THROTTLE_MS = 1500;

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private lastResetAt = 0;
  private lastLogAt = 0;
  private lastLogKey = "";
  private consecutiveFailures = 0;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.consecutiveFailures += 1;
    const key = `${error.name}:${error.message}`;
    const now = Date.now();
    // Keep the full trace in the console so the exact throw site can be
    // reproduced from a webview-devtools screenshot next time it happens —
    // but once per signature per window, not once per host patch.
    if (key !== this.lastLogKey || now - this.lastLogAt >= LOG_THROTTLE_MS) {
      console.error("[iflow] render error:", error, info.componentStack);
      this.lastLogAt = now;
      this.lastLogKey = key;
    }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error === null) {
      // A retry healed the render — a future, unrelated throw retries at once.
      this.consecutiveFailures = 0;
      return;
    }
    if (prev.resetKey === this.props.resetKey) return;
    const now = Date.now();
    if (this.consecutiveFailures > 0 && now - this.lastResetAt < RETRY_COOLDOWN_MS) return;
    this.lastResetAt = now;
    this.setState({ error: null });
  }

  private reset = (): void => {
    this.consecutiveFailures = 0;
    this.lastLogKey = "";
    this.lastResetAt = 0;
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    // The retry wears the surface it sits on: the inline card is an amber
    // notice (warning tone), the full-page fallback is neutral (canvas).
    const retry = (variant: "canvas" | "warning-soft") => (
      <Button variant={variant} icon={<RotateCcw className={ICON_INLINE} />} onClick={this.reset}>
        {t("重试")}
      </Button>
    );
    if (this.props.variant === "page") {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="size-7 text-warning" />
          <div className="text-ui-title font-semibold text-foreground">{t("界面出错了")}</div>
          <p className="max-w-[320px] text-ui-caption leading-relaxed text-muted-foreground">
            {t("重新载入面板即可恢复；也可以直接重试。")}
          </p>
          {retry("canvas")}
        </div>
      );
    }
    return (
      <div className="relative min-h-0 flex-1">
        <div className="stream-in mx-auto mt-6 flex max-w-[420px] flex-col items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-5 text-center">
          <AlertTriangle className={`${ICON_DISPLAY} text-warning`} />
          <div className="text-ui-body font-semibold text-foreground">{t("这段内容显示不出来")}</div>
          <p className="text-ui-caption leading-relaxed text-muted-foreground">
            {t("这段内容没能显示出来，下次更新时会自动重试。")}
          </p>
          {retry("warning-soft")}
        </div>
      </div>
    );
  }
}