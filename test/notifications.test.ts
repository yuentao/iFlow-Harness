import { describe, it, expect } from "vitest";
import {
  OS_NOTIFY_THROTTLE_MS,
  gateOsNotification,
  initOsNotifyGate,
  isUserWatching,
  osNotifyAllowed,
} from "../shared/notifications.js";

describe("osNotifyAllowed", () => {
  it("off blocks every event kind", () => {
    for (const event of ["approval", "question", "plan", "longTool", "turnDone", "turnFailed"] as const) {
      expect(osNotifyAllowed(event, "off")).toBe(false);
    }
  });

  it("approvals covers only the agent-blocking events", () => {
    expect(osNotifyAllowed("approval", "approvals")).toBe(true);
    expect(osNotifyAllowed("question", "approvals")).toBe(true);
    expect(osNotifyAllowed("plan", "approvals")).toBe(true);
    // A hard failure is an attention event for away users by default (the
    // queue pauses and retry decisions are theirs), like the blocking trio.
    expect(osNotifyAllowed("turnFailed", "approvals")).toBe(true);
    expect(osNotifyAllowed("longTool", "approvals")).toBe(false);
    expect(osNotifyAllowed("turnDone", "approvals")).toBe(false);
  });

  it("all covers everything", () => {
    for (const event of ["approval", "question", "plan", "longTool", "turnDone", "turnFailed"] as const) {
      expect(osNotifyAllowed(event, "all")).toBe(true);
    }
  });

  it("an unknown setting value fails closed", () => {
    expect(osNotifyAllowed("approval", "everything")).toBe(false);
    expect(osNotifyAllowed("approval", "")).toBe(false);
  });
});

describe("isUserWatching", () => {
  it("requires both panel visibility and window focus", () => {
    expect(isUserWatching(true, true)).toBe(true);
    expect(isUserWatching(true, false)).toBe(false);
    expect(isUserWatching(false, true)).toBe(false);
    expect(isUserWatching(false, false)).toBe(false);
  });
});

describe("gateOsNotification", () => {
  it("never fires while the panel is visible and the window is focused", () => {
    const gate = initOsNotifyGate();
    const out = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: true,
      windowFocused: true,
      nowMs: 1000,
      gate,
    });
    expect(out.fire).toBe(false);
    expect(out.gate).toBe(gate); // untouched, same reference
  });

  it("fires for a visible panel when its window is unfocused", () => {
    const out = gateOsNotification({
      event: "approval",
      setting: "approvals",
      panelVisible: true,
      windowFocused: false,
      nowMs: 1000,
      gate: initOsNotifyGate(),
    });
    expect(out.fire).toBe(true);
  });

  it("fires when hidden and the setting allows it, stamping the gate", () => {
    const out = gateOsNotification({
      event: "approval",
      setting: "approvals",
      panelVisible: false,
      windowFocused: true,
      nowMs: 1000,
      gate: initOsNotifyGate(),
    });
    expect(out.fire).toBe(true);
    expect(out.gate.lastFiredAt.approval).toBe(1000);
  });

  it("turnDone additionally requires an unfocused window (roadmap trigger 3)", () => {
    const gate = initOsNotifyGate();
    const focused = gateOsNotification({
      event: "turnDone",
      setting: "all",
      panelVisible: false,
      windowFocused: true,
      nowMs: 0,
      gate,
    });
    expect(focused.fire).toBe(false);
    expect(focused.gate).toBe(gate); // nothing stamped by the blocked call
    const unfocused = gateOsNotification({
      event: "turnDone",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate: initOsNotifyGate(),
    });
    expect(unfocused.fire).toBe(true);
  });

  it("blocking events ignore window focus — the agent is stuck", () => {
    for (const event of ["approval", "question", "plan"] as const) {
      const out = gateOsNotification({
        event,
        setting: "approvals",
        panelVisible: false,
        windowFocused: true,
        nowMs: 0,
        gate: initOsNotifyGate(),
      });
      expect(out.fire).toBe(true);
    }
  });

  it("longTool ignores window focus (only turnDone is focus-gated)", () => {
    const out = gateOsNotification({
      event: "longTool",
      setting: "all",
      panelVisible: false,
      windowFocused: true,
      nowMs: 0,
      gate: initOsNotifyGate(),
    });
    expect(out.fire).toBe(true);
  });

  it("throttles the same event kind within the window", () => {
    const first = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate: initOsNotifyGate(),
    });
    expect(first.fire).toBe(true);
    const second = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: OS_NOTIFY_THROTTLE_MS - 1,
      gate: first.gate,
    });
    expect(second.fire).toBe(false);
  });

  it("fires again once the throttle window has elapsed", () => {
    const first = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate: initOsNotifyGate(),
    });
    const second = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: OS_NOTIFY_THROTTLE_MS,
      gate: first.gate,
    });
    expect(second.fire).toBe(true);
    expect(second.gate.lastFiredAt.approval).toBe(OS_NOTIFY_THROTTLE_MS);
  });

  it("throttles per event kind, not globally", () => {
    const first = gateOsNotification({
      event: "approval",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate: initOsNotifyGate(),
    });
    const other = gateOsNotification({
      event: "question",
      setting: "all",
      panelVisible: false,
      windowFocused: false,
      nowMs: 100,
      gate: first.gate,
    });
    expect(other.fire).toBe(true);
    expect(other.gate.lastFiredAt).toEqual({ approval: 0, question: 100 });
  });

  it("does not consume the gate when the setting rejects the event", () => {
    const gate = initOsNotifyGate();
    const out = gateOsNotification({
      event: "longTool",
      setting: "approvals",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate,
    });
    expect(out.fire).toBe(false);
    expect(out.gate).toBe(gate);
    // The next call at the same timestamp still fires (nothing was stamped).
    expect(
      gateOsNotification({
        event: "longTool",
        setting: "all",
        panelVisible: false,
        windowFocused: false,
        nowMs: 0,
        gate,
      }).fire,
    ).toBe(true);
  });

  it("never fires for a blocked setting", () => {
    const gate = initOsNotifyGate();
    const out = gateOsNotification({
      event: "approval",
      setting: "off",
      panelVisible: false,
      windowFocused: false,
      nowMs: 0,
      gate,
    });
    expect(out.fire).toBe(false);
    expect(out.gate).toBe(gate);
  });
});