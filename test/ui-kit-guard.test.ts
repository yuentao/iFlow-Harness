// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../webview/src/components/ui";

/** jsdom ships neither ResizeObserver nor scrollIntoView; the Dropdown clamp
 * and menu-item focus only need the members to exist. */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
/** jsdom has no layout, so `offsetParent` is always null and the kit's
 * visibility filter (menu items, focusable scan) would drop everything. */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});

/**
 * UI-kit guard (M14 §4.5): the control family lives in `webview/src/components/ui.tsx`
 * and nowhere else. These assertions keep that invariant enforced instead of
 * documented — a new card that hand-rolls an `<input>` or re-declares the
 * primary gradient fails here, which is exactly the drift that made eight
 * buttons and two checkbox species diverge before the kit existed.
 */
const WEBVIEW_SRC = join(__dirname, "..", "webview", "src");

/** Where native form controls legitimately live. */
const CONTROL_HOME = "components/ui.tsx";

/** The composer textarea is a deliberate stage species (multiline prompt with
 * history recall, slash popup, IME-safe Enter): it stays outside the kit, but
 * it must stay *one* exception, not a pattern. */
const STAGE_TEXTAREA = "components/Composer.tsx";

function sourceFiles(): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push({ rel: relative(WEBVIEW_SRC, full).replace(/\\/g, "/"), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(WEBVIEW_SRC);
  return out;
}

const files = sourceFiles();

/** Strips comments so a doc comment mentioning a forbidden shape is not a hit. */
function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function violations(pattern: RegExp, allowed: (rel: string) => boolean): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (allowed(file.rel)) continue;
    const body = codeOnly(file.content);
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file.rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

describe("ui kit guard", () => {
  it("covers the webview sources", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.rel)).toContain("components/ui.tsx");
  });

  it("keeps native form controls inside ui.tsx", () => {
    const native = /<(input|textarea|select)\b|type="checkbox"|type="range"/;
    const hits = violations(native, (rel) => rel === CONTROL_HOME || rel === STAGE_TEXTAREA);
    expect(hits).toEqual([]);
  });

  it("keeps the composer textarea a single exception", () => {
    const stage = files.find((f) => f.rel === STAGE_TEXTAREA);
    expect(stage).toBeDefined();
    const count = codeOnly(stage!.content).split("\n").filter((line) => /<textarea\b/.test(line)).length;
    expect(count).toBe(1);
  });

  it("forbids accent-color tinting of native checkboxes", () => {
    expect(violations(/accent-\[/, () => false)).toEqual([]);
  });

  it("owns the primary gradient in ui.tsx", () => {
    expect(violations(/bg-gradient-to-b from-primary/, (rel) => rel === CONTROL_HOME)).toEqual([]);
  });

  it("owns the button base strings in ui.tsx", () => {
    // A re-declared `press inline-flex h-7/h-6` base is a divergent button.
    expect(violations(/press inline-flex h-[67]\b/, (rel) => rel === CONTROL_HOME)).toEqual([]);
  });

  it("forbids arbitrary font sizes and radii in components", () => {
    expect(violations(/text-\[\d+(\.\d+)?px\]|rounded-\[\d+(\.\d+)?px\]/, () => false)).toEqual([]);
  });

  it("keeps overlay menus on the float shadow token", () => {
    // `acrylic-pop` carries the panel-sized drop (negative spread), which
    // collapses on trigger-anchored overlays. Those must carry `shadow-float`
    // (the .acrylic-pop.shadow-float rule keeps the inset rim). Modal panels and
    // header pills are not trigger-anchored, so they keep the panel drop.
    const hits = violations(/acrylic-pop(?!.*shadow-float).*dropdown-in/, () => false);
    expect(hits).toEqual([]);
  });

  it("keeps button icons on the token tier", () => {
    // Control icons must come from ICON_INLINE; decorative glyphs (status dots,
    // inline captions) may still size themselves, so only the `icon=` prop of
    // the kit primitives is guarded.
    expect(violations(/icon=\{<\w+\s+className="size-3\.5/, (rel) => rel === CONTROL_HOME)).toEqual([]);
  });

  it("exposes the kit primitives components rely on", () => {
    const kit = files.find((f) => f.rel === CONTROL_HOME)!.content;
    const names = [
      "export function Button(",
      "export function IconButton(",
      "export function TextInput(",
      "export function CommitTextInput(",
      "export function CommitNumberInput(",
      "export function TextArea(",
      "export function CommitTextArea(",
      "export function LinesCommitTextArea(",
      "export function Select(",
      "export function SearchInput(",
      "export function Switch(",
      "export function Checkbox(",
      "export function ToggleChip(",
      "export function OptionGroup(",
      "export function OptionCard(",
      "export function Slider(",
      "export function Segmented<",
      "export function TabButton(",
      "export function rovingTabKeyDown<",
      "export function FloatPill(",
      "export function FloatChip(",
      "export function CountdownSeconds(",
      "export function ToastStack(",
      "export function Field(",
      "export function FieldLabel(",
      "export function ActionRow(",
      "export function ToolbarRow(",
      "export function SecondaryRow(",
      "export function Chip(",
      "export function HelpTip(",
      "export function ModalShell(",
      "export function ConfirmDialog(",
      "export function Dropdown(",
      "export function MenuItem(",
      "export function SettingsGroup(",
      "export function SettingsDisclosure(",
    ];
    expect(names.filter((name) => !kit.includes(name))).toEqual([]);
  });
});

/**
 * Behaviour half of the guard: the kit's `Select` must be an overlay menu
 * (Dropdown + MenuItem), not a native `<select>` — the OS popup ignores the
 * panel's overlay language and announces nothing about the current choice.
 */
describe("select overlay", () => {
  const OPTIONS = [
    { value: "allow", label: "自动允许" },
    { value: "deny", label: "自动拒绝" },
    { value: "ask", label: "弹卡确认" },
  ];

  it("opens an overlay menu whose active option is announced", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(createElement(Select, { ariaLabel: "动作", options: OPTIONS, value: "ask", onChange }));
    });

    const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");
    expect(trigger).toBeTruthy();
    expect(trigger!.getAttribute("aria-label")).toBe("动作");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    expect(trigger!.textContent).toContain("弹卡确认");
    // No native popup anywhere.
    expect(container.querySelector("select")).toBeNull();

    act(() => trigger!.click());

    const menu = container.querySelector<HTMLDivElement>("[role='menu']");
    expect(menu).toBeTruthy();
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    const items = [...menu!.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    expect(items.map((item) => item.textContent?.trim())).toEqual(["自动允许", "自动拒绝", "弹卡确认"]);
    expect(items.find((item) => item.getAttribute("aria-checked") === "true")?.textContent).toContain("弹卡确认");
    // Keyboard highlight starts on the active choice, not the first row.
    expect(document.activeElement).toBe(items[2]);

    act(() => {
      items[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(items[0]);

    act(() => items[1].click());
    expect(onChange).toHaveBeenCalledWith("deny");
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");

    act(() => root.unmount());
    container.remove();
  });
});
