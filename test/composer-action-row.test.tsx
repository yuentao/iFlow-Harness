// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import type { ModelInfoUi, SessionState } from "../shared/messages";

/**
 * Regression lock for the composer's bottom action row.
 *
 * User report (2026-11-20): 「底部栏 hover 时上边缘被裁切掉一点点」 — the model
 * trigger, the prompt-enhance wand and the attachment button lost their top
 * border row while hovered.
 *
 * Root cause (measured in Chromium via CDP, forced `:hover`): the canvas
 * buttons carry `card-lift`, which lifts the button by 1px on hover
 * (`translateY(-1px)`), and the row's two collapse zones wrapped them in
 * `overflow: hidden`. The hidden box is exactly as tall as the 28px button
 * row, so the lifted button's top border row (y 850) fell outside the clip
 * edge (y 851) and was sliced away.
 *
 * The zones now clip horizontally only (`overflow-x: clip` +
 * `overflow-y: visible`), which keeps the takeover collapse wipe intact while
 * letting the lift — and the canvas buttons' card shadow — paint outside the
 * box. `overflow-x: hidden` is NOT an equivalent: Chromium forces the
 * vertical axis to `auto` there, which re-introduces the clip.
 *
 * jsdom has no layout, so the invariant is locked on the class shape: no
 * ancestor of a bottom-row control may declare a vertical-clipping overflow
 * utility, and the zone must keep a horizontal clip for the collapse.
 */

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  state: undefined as SessionState | undefined,
}));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(
      selector: (s: {
        state: SessionState | undefined;
        pending: null;
        send: typeof mocked.send;
        beginPending: ReturnType<typeof vi.fn>;
        notify: typeof mocked.notify;
      }) => T,
    ) => selector({ state: mocked.state, pending: null, send: mocked.send, beginPending: vi.fn(), notify: mocked.notify }),
    { getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }) },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s, modeDisplay: () => ({ label: "mode", desc: "" }) }));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    // Only the trigger matters here; the menu body is a render prop and must
    // not be rendered as a React child.
    Dropdown: ({ trigger }: { trigger: (open: boolean) => ReactNode }) => <>{trigger(false)}</>,
    fuzzyScore: () => 0,
  };
});

let root: Root;
let container: HTMLDivElement;

const MODELS: ModelInfoUi[] = [{ id: "demo-model", name: "演示模型" }];

function makeState(): SessionState {
  return {
    blocks: [],
    status: "idle",
    errorMessage: null,
    stopReason: null,
    sessionId: "s1",
    activeSessionId: "s1",
    modes: null,
    commands: [],
    models: MODELS,
    currentModelId: "demo-model",
    pendingApproval: null,
    pendingQuestions: null,
    auth: {
      authenticated: true,
      needsSetup: false,
      saved: null,
      profiles: [],
      onboardingDismissed: false,
    },
    sessions: [],
    replaying: false,
    initializing: false,
  } as SessionState;
}

/**
 * Tailwind overflow utilities that clip the VERTICAL axis — the axis the
 * `card-lift` hover rise travels along. `overflow-x-hidden` is on the list
 * because Chromium recomputes the vertical axis to `auto` for that pairing,
 * which clips (and scrolls) the rise away just like `overflow: hidden`.
 */
const VERTICAL_CLIPPERS = [
  "overflow-hidden",
  "overflow-y-hidden",
  "overflow-auto",
  "overflow-y-auto",
  "overflow-clip",
  "overflow-y-clip",
  "overflow-x-hidden",
];

/** Horizontal clipping utilities — the takeover collapse needs one of them. */
const HORIZONTAL_CLIPPERS = ["overflow-hidden", "overflow-x-hidden", "overflow-clip", "overflow-x-clip"];

function classListOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function ancestorsOf(el: Element): Element[] {
  const out: Element[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) out.push(p);
  return out;
}

/** The composer root — the outermost element the component renders. */
function composerRoot(): HTMLElement {
  return container.querySelector<HTMLElement>(".acrylic")!;
}

function bottomRowControls(): Array<{ label: string; el: Element }> {
  const wanted: Array<[string, string]> = [
    ["模型", 'button[title="模型"]'],
    ["增强提示词", 'button[aria-label="增强提示词"]'],
    ["添加附件", 'button[aria-label="添加附件"]'],
  ];
  const found: Array<{ label: string; el: Element }> = [];
  for (const [label, selector] of wanted) {
    const el = container.querySelector(selector);
    if (el) found.push({ label, el });
  }
  return found;
}

function render(): void {
  act(() => root.render(<Composer />));
}

function type(text: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocked.state = makeState();
  mocked.send.mockReset();
  mocked.notify.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("composer bottom action row", () => {
  it("renders the three reported controls", () => {
    render();
    type("写点东西");
    const labels = bottomRowControls().map((c) => c.label);
    expect(labels).toEqual(["模型", "增强提示词", "添加附件"]);
  });

  it("never clips the hover rise of a bottom-row control", () => {
    render();
    type("写点东西");
    const root_ = composerRoot();
    for (const { label, el } of bottomRowControls()) {
      for (const ancestor of ancestorsOf(el)) {
        if (!root_.contains(ancestor) && ancestor !== root_) continue;
        const classes = classListOf(ancestor);
        for (const clipper of VERTICAL_CLIPPERS) {
          expect(
            classes.includes(clipper),
            `${label}: ancestor <${ancestor.tagName.toLowerCase()} class="${classes.join(" ")}"> clips vertically via "${clipper}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the horizontal clip that the takeover collapse relies on", () => {
    render();
    type("写点东西");
    const root_ = composerRoot();
    const zones = bottomRowControls().map((c) =>
      ancestorsOf(c.el).find((a) => a !== root_ && classListOf(a).some((c) => c.startsWith("overflow-"))),
    );
    // Both zones exist (model zone + action zone) and each keeps a horizontal
    // clip so the remote-takeover collapse still wipes the row away.
    expect(zones.every(Boolean)).toBe(true);
    for (const zone of zones) {
      const classes = classListOf(zone!);
      expect(
        HORIZONTAL_CLIPPERS.some((c) => classes.includes(c)),
        `zone class="${classes.join(" ")}" lost its horizontal clip`,
      ).toBe(true);
      // …and it is the `clip` flavour, so the vertical axis stays `visible`
      // (Chromium recomputes `overflow-y` to `auto` for `overflow-x: hidden`).
      expect(classes.includes("overflow-x-clip")).toBe(true);
      expect(classes.includes("overflow-y-visible")).toBe(true);
    }
  });
});
