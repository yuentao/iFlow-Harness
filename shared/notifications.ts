/**
 * M1 P0-5 — OS-level notification gating (pure, unit-testable).
 *
 * The trigger decision is "is the user looking at the panel?": the host
 * judges via the webview panel's `visible` state (NOT document.hidden — the
 * webview keeps `retainContextWhenHidden`, so its document never reports
 * hidden). A notification fires only when all three gates pass:
 *
 *   setting  — `iflow.osNotifications`: off / approvals (default) / all
 *   visibility — panel not visible (a visible panel already shows the card)
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
 * Decide whether an OS notification fires. When it does, returns the updated
 * gate (caller stores it); otherwise returns the gate untouched. The
 * visible-panel check lives here too so the whole policy is one function.
 */
export function gateOsNotification(args: {
  event: OsNotifyEvent;
  setting: string;
  panelVisible: boolean;
  nowMs: number;
  gate: OsNotifyGate;
}): { fire: boolean; gate: OsNotifyGate } {
  if (args.panelVisible) return { fire: false, gate: args.gate };
  if (!osNotifyAllowed(args.event, args.setting)) return { fire: false, gate: args.gate };
  const last = args.gate.lastFiredAt[args.event];
  if (last !== undefined && args.nowMs - last < OS_NOTIFY_THROTTLE_MS) {
    return { fire: false, gate: args.gate };
  }
  return {
    fire: true,
    gate: { lastFiredAt: { ...args.gate.lastFiredAt, [args.event]: args.nowMs } },
  };
}
