/**
 * M1 P0-5 — OS-level notification gating (pure, unit-testable).
 *
 * The trigger decision is "is the user looking at the panel?": the host
 * judges via the webview panel's `visible` state (NOT document.hidden — the
 * webview keeps `retainContextWhenHidden`, so its document never reports
 * hidden). A notification fires only when all gates pass:
 *
 *   setting  — `iflow.osNotifications`: off / approvals (default) / all
 *   visibility — the user is NOT watching (panel visible AND window focused
 *              — a watching user already sees the card; a visible panel in an
 *              unfocused window counts as away, see `isUserWatching`)
 *   focus    — turnDone additionally requires the window unfocused (roadmap
 *              trigger 3 is "整轮完成且窗口失焦": a finished turn must not
 *              ping a user who is merely reading code in another editor tab
 *              of a focused window). The blocking events (approval / question
 *              / plan) ignore focus — the agent is stuck waiting, so even a
 *              focused window with a hidden panel earns the interrupt.
 *   throttle — the same event kind at most once per window (a burst of
 *              parallel tool approvals must not stack 10 native toasts)
 *
 * The gate is a pure state machine over a `lastFiredAt` record so the host
 * stays thin and the semantics are pinned by unit tests.
 */

export type OsNotifyEvent = "approval" | "question" | "plan" | "longTool" | "turnDone";

/** Same-kind burst suppression window. */
export const OS_NOTIFY_THROTTLE_MS = 5_000;

/** Events the `approvals` (default) tier covers: an agent is BLOCKED on the
 * user until answered, so these are the ones worth interrupting for. */
const APPROVAL_TIER: ReadonlySet<OsNotifyEvent> = new Set<OsNotifyEvent>(["approval", "question", "plan"]);

/** Setting tier allows this event kind? The `setting` values are the
 * `iflow.osNotifications` manifest enum: `off` / `approvals` / `all`. */
export function osNotifyAllowed(event: OsNotifyEvent, setting: string): boolean {
  if (setting === "all") return true;
  if (setting === "approvals") return APPROVAL_TIER.has(event);
  return false; // "off" and any unknown value
}

export interface OsNotifyGate {
  /** Per-event-kind epoch-ms of the last fired notification. */
  lastFiredAt: Partial<Record<OsNotifyEvent, number>>;
}

export function initOsNotifyGate(): OsNotifyGate {
  return { lastFiredAt: {} };
}

/**
 * The "is the user looking at the panel?" judgement gating the OS-notification
 * trigger (roadmap P0-5). Watching = panel visible AND the window focused: the
 * panel keeps `retainContextWhenHidden`, so a user who switches to another app
 * leaves `visible` true while nobody is looking — treating visible alone as
 * "watching" silenced the away-user toast (1.5.0 regression, fixed by adding
 * the focus term). Panel visible + focused is the only state where the card
 * flip is self-evident.
 *
 * History: cd1c406 merged this predicate with the sound-cue gate so a
 * completion never toasted AND chimed; together with the call-site
 * exclusivity that left the chime reachable only in hidden-panel+focused-
 * window — users reported the cue as vanished (2026-10-13), so the chime went
 * back to universal and this predicate now gates ONLY the native toast.
 */
export function isUserWatching(panelVisible: boolean, windowFocused: boolean): boolean {
  return panelVisible && windowFocused;
}

/**
 * Decide whether an OS notification fires. When it does, returns the updated
 * gate (caller stores it); otherwise returns the gate untouched. The
 * visible-panel check lives here too so the whole policy is one function.
 */
export function gateOsNotification(args: {
  event: OsNotifyEvent;
  setting: string;
  panelVisible: boolean;
  /** `vscode.window.state.focused` — consulted by the watching gate (a
   * visible panel in an unfocused window is NOT being watched, see
   * `isUserWatching`) and additionally required to be false by `turnDone`
   * (see the focus gate in the module docstring). */
  windowFocused: boolean;
  nowMs: number;
  gate: OsNotifyGate;
}): { fire: boolean; gate: OsNotifyGate } {
  if (isUserWatching(args.panelVisible, args.windowFocused)) return { fire: false, gate: args.gate };
  if (!osNotifyAllowed(args.event, args.setting)) return { fire: false, gate: args.gate };
  if (args.event === "turnDone" && args.windowFocused) return { fire: false, gate: args.gate };
  const last = args.gate.lastFiredAt[args.event];
  if (last !== undefined && args.nowMs - last < OS_NOTIFY_THROTTLE_MS) {
    return { fire: false, gate: args.gate };
  }
  return {
    fire: true,
    gate: { lastFiredAt: { ...args.gate.lastFiredAt, [args.event]: args.nowMs } },
  };
}
