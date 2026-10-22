// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Select, TextArea, TextInput } from "../webview/src/components/ui";

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
/** React 19 refuses `act()` unless the environment declares itself act-capable. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

/** The kit stylesheet is the single home for browser-chrome resets (spin
 * buttons, autofill tint, caret/selection) and the grip species. */
const kitCss = readFileSync(join(WEBVIEW_SRC, "styles.css"), "utf8");

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

  it("resets the browser's field chrome in the kit stylesheet", () => {
    // Chromium paints decorations a class string cannot override; the kit owns
    // them in styles.css so no field can fall back to browser styling.
    expect(kitCss).toMatch(/input\[type="number"\]::-webkit-inner-spin-button/);
    expect(kitCss).toMatch(/input:-webkit-autofill/);
    expect(kitCss).toMatch(/caret-color:\s*var\(--primary\)/);
    expect(kitCss).toMatch(/textarea::selection/);
    expect(kitCss).toMatch(/\.ui-resize\s*\{/);
  });

  it("neutralises VSCode's injected webview code defaults", () => {
    // VSCode wraps every webview in its own template stylesheet that tints bare
    // `code` with --vscode-textPreformat-* (and `pre code` only resets the
    // padding). Those rules are unlayered, so they out-rank Tailwind utilities
    // no matter the specificity: the kit resets them unlayered, and a surface
    // that wants its own tint must declare it in a custom class.
    expect(kitCss).toMatch(/body\s+code\s*\{[^}]*background-color:\s*transparent/);
    expect(kitCss).toMatch(/\.approval-target\s*\{[^}]*background:\s*var\(--editor\)/);
    // The inline-code pill is the other tinted `code` species: rewritten as a
    // utility it would silently lose to `body code` (layered < unlayered). Its
    // text color must be stated too — the injected default is reset to inherit.
    expect(kitCss).toMatch(/\.md :not\(pre\) > code\s*\{[^}]*background:/);
    expect(kitCss).toMatch(/\.md :not\(pre\) > code\s*\{[^}]*color:\s*var\(--color-info\)/);
    // The de-pill'd pseudo code block keeps the same reference color, so the
    // two mono species never diverge.
    expect(kitCss).toMatch(/\.md \.code-lines code\s*\{[^}]*color:\s*var\(--color-info\)/);
    const approval = files.find((f) => f.rel === "components/ApprovalCard.tsx")!.content;
    expect(approval).toContain('className="approval-target');
    expect(approval).not.toMatch(/<code[^>]*bg-editor/);
    // Any new `<code className="bg-*">` would read as a tint that VSCode's
    // injected defaults silently overwrite.
    const tintHits = violations(/<code[^>]*\bbg-/, () => false);
    expect(tintHits).toEqual([]);
  });

  it("keeps multiline resizing owned by the kit grip", () => {
    // Call sites must not re-declare a browser resize affordance.
    const hits = violations(/resize-(none|y|x|both)/, (rel) => rel === CONTROL_HOME || rel === STAGE_TEXTAREA);
    expect(hits).toEqual([]);
    const kit = files.find((f) => f.rel === CONTROL_HOME)!.content;
    expect(kit).toContain("resize-none");
    expect(kit).toContain("ui-resize");
    // The grip rides a grid overlay (`content-start`), so it stays on the
    // textarea's own corner even when an outer grid stretches the wrapper.
    expect(kit).toContain("content-start");
  });

  it("keeps the button family single-line", () => {
    // Button is a fixed-height species (28/24px). A two-line body (icon +
    // title + description) belongs to OptionCard / MenuItem — padding
    // overrides on a fixed-height button make the content overflow its own
    // border (the profile-switch dialog did exactly that).
    const hits: string[] = [];
    for (const file of files) {
      if (file.rel === CONTROL_HOME) continue;
      const lines = codeOnly(file.content).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/<Button[\s>]/.test(lines[i] ?? "")) continue;
        let body = "";
        for (let j = i; j < Math.min(lines.length, i + 12); j++) {
          const line = lines[j] ?? "";
          body += `${line}\n`;
          if (line.includes("/>") || line.includes("</Button>")) break;
        }
        for (const line of body.split("\n")) {
          if (/className=/.test(line) && /\bpy-/.test(line)) {
            hits.push(`${file.rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("keeps credential fields on the kit reveal toggle", () => {
    // Chromium's password reveal button cannot be restyled, so any password
    // field must opt into the kit's `revealable` toggle.
    const hits: string[] = [];
    for (const file of files) {
      if (file.rel === CONTROL_HOME) continue;
      const lines = codeOnly(file.content).split("\n");
      lines.forEach((line, i) => {
        if (!/type="password"/.test(line)) return;
        if (!lines.slice(i, i + 4).join("\n").includes("revealable")) {
          hits.push(`${file.rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
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
      "export const WARNING_SOFT =",
      "export const DANGER_SOFT =",
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

/**
 * Behaviour half: multiline fields resize with the kit grip (Chromium's corner
 * handle is suppressed via `resize-none`), and credential fields reveal through
 * the kit icon button instead of the browser's unstyleable toggle.
 */
describe("field chrome", () => {
  it("resizes with the kit grip instead of the browser handle", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(createElement(TextArea, { "aria-label": "记忆文件内容", value: "正文", onChange: () => {} }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.className).toContain("resize-none");
    const grip = container.querySelector<HTMLDivElement>(".ui-resize");
    expect(grip).toBeTruthy();
    expect(grip!.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      grip!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 100 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 140 }));
    });
    // jsdom reports a 0-height rect, so the clamp floor (40px) is the result.
    expect(textarea.style.height).toBe("40px");

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 200 }));
    });
    expect(textarea.style.height).toBe("40px");

    act(() => root.unmount());
    container.remove();
  });

  it("reveals a credential field through the kit toggle", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(TextInput, {
          type: "password",
          revealable: true,
          "aria-label": "API Key",
          value: "sk-secret",
          onChange: () => {},
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("password");
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-label='显示密码']");
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("title")).toBe("显示密码");

    act(() => toggle!.click());
    expect(input.type).toBe("text");
    expect(container.querySelector("button[aria-label='隐藏密码']")).toBeTruthy();
    expect(container.querySelector("button[aria-label='显示密码']")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
