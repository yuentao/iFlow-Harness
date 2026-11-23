// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement, useState, type ReactNode } from "react";
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

  it("keeps color utilities on tokens the theme defines", () => {
    // Tailwind emits NOTHING for an unknown color name — no error, no warning,
    // just a missing rule. `bg-canvas` (never defined in `@theme inline`) left
    // the floating super-agent board with no background at all, so the
    // transcript text underneath ghosted straight through it (b684a44).
    const themeColors = new Set(
      [...kitCss.matchAll(/--color-([a-z][a-z0-9-]*)\s*:/g)].map((match) => match[1]!),
    );
    expect(themeColors.has("card")).toBe(true);
    expect(themeColors.has("canvas")).toBe(false);

    // Utilities that share a color prefix but are not colors. Kept minimal: one
    // entry per name actually present in the sources today.
    const NOT_A_COLOR = new Set([
      // Tailwind's built-in color keywords.
      "transparent",
      "current",
      "white",
      "black",
      // Border side / width / box-sizing / style / outline reset.
      "b",
      "t",
      "l",
      "r",
      "y",
      "b-0",
      "box",
      "dashed",
      "none",
      // Table border model (`border-collapse`), not a color.
      "collapse",
      // Text alignment.
      "center",
      "left",
      "right",
      // Button variant name (`outline-primary` / `outline-danger`), not a utility.
      "danger",
    ]);
    const isNotColor = (name: string): boolean =>
      NOT_A_COLOR.has(name) || name.startsWith("ui-") || name.startsWith("gradient-");

    const hits: string[] = [];
    for (const file of files) {
      codeOnly(file.content)
        .split("\n")
        .forEach((line, i) => {
          const pattern = /(?<![A-Za-z0-9_-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to)-([a-z][a-z0-9-]*)/g;
          for (const match of line.matchAll(pattern)) {
            const name = match[1]!;
            if (isNotColor(name) || themeColors.has(name)) continue;
            hits.push(`${file.rel}:${i + 1}: ${match[0]}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("keeps overlay menus on the float shadow token", () => {
    // `acrylic-pop` carries the panel-sized drop (negative spread), which
    // collapses on trigger-anchored overlays. Those must carry `shadow-float`
    // (the .acrylic-pop.shadow-float rule keeps the inset rim). Modal panels and
    // header pills are not trigger-anchored, so they keep the panel drop.
    const hits = violations(/acrylic-pop(?!.*shadow-float).*dropdown-in/, () => false);
    expect(hits).toEqual([]);
  });

  it("lifts only the card-lift row whose dropdown is open", () => {
    // .card-lift:hover's transform (0.25s transition) makes each row a
    // stacking context; an absolute z-30 menu inside one row is then painted
    // under later sibling rows. Chrome 157 headless + CDP (elementFromPoint
    // over the menu/next-row overlap on McpCard's server list) reproduced it:
    // the next row covered the open menu for the whole transition window.
    expect(kitCss).toMatch(
      /\.card-lift:has\(\[role="?menu"?\]\)\s*\{[^}]*position:\s*relative[^}]*z-index:\s*20/,
    );
    // The lift hinges on role="menu" being emitted ONLY while a Dropdown is
    // open and ONLY from ui.tsx. Dropping the attribute (or duplicating it on
    // a permanently mounted node) silently disables the rule or lifts every
    // row. codeOnly keeps the JSX attribute, not a doc-comment mention.
    const kit = files.find((f) => f.rel === CONTROL_HOME)!.content;
    expect(codeOnly(kit)).toContain('role="menu"');
    expect(violations(/role="menu"/, (rel) => rel === CONTROL_HOME)).toEqual([]);
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

  it("keeps the revealable credential field full width", () => {
    // Regression guard for the collapsed API Key field: the reveal toggle is
    // absolutely positioned inside a wrapper div, so the input stops being a
    // flex item of the surrounding Field and falls back to the browser's
    // intrinsic `size=20` width (≈190px). Wrapper and input must both claim
    // the full width, otherwise the placeholder is clipped and the eye button
    // hangs outside the field.
    const kit = codeOnly(files.find((f) => f.rel === CONTROL_HOME)!.content);
    const start = kit.indexOf("export function TextInput(");
    expect(start).toBeGreaterThan(-1);
    const body = kit.slice(start, kit.indexOf("export function CommitTextInput(", start));
    const branch = body.slice(body.indexOf("if (!revealable) return field;"));
    expect(branch).toContain("relative w-full");
    expect(body).toMatch(/revealable \? "[^"]*w-full[^"]*"/);
  });

  it("keeps the settings nav rail scrollable", () => {
    // The settings nav rail (4 groups / 9 tabs) used to be `shrink-0` +
    // `overflow-visible`: on a short or narrow screen it was clipped by the
    // modal's own `overflow:hidden` and the bottom groups (e.g. 「运行与数据」)
    // were unreachable. It must stay shrinkable and scrollable vertically;
    // the wide layout only keeps the horizontal `shrink-0`.
    const settings = files.find((f) => f.rel === "components/SettingsModal.tsx")!.content;
    const navStart = settings.indexOf("<nav");
    expect(navStart).toBeGreaterThan(-1);
    const navBlock = settings.slice(navStart, settings.indexOf("</nav>", navStart));
    const navClass = navBlock.match(/className="([^"]*)"/)?.[1] ?? "";
    expect(navClass).toContain("min-h-0");
    expect(navClass).toContain("overflow-y-auto");
    expect(navClass).not.toContain("overflow-visible");
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
      "export function DisclosureButton(",
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
      "export function Chip(",
      "export function HelpTip(",
      "export function ModalShell(",
      "export function ConfirmDialog(",
      "export function ImageLightbox(",
      "export function Dropdown(",
      "export function MenuItem(",
      "export function SettingsGroup(",
      "export function SettingsRow(",
      "export function SettingsDisclosure(",
      "export const WARNING_SOFT =",
      "export const DANGER_SOFT =",
    ];
    expect(names.filter((name) => !kit.includes(name))).toEqual([]);
  });

  it("declares field focus rings by hand (Tailwind emits no shadow variant)", () => {
    // Tailwind v4 parses `shadow-focus` as a shadow-COLOR modifier, so the
    // `focus:shadow-focus` / `focus-within:shadow-focus-soft` classes on kit
    // fields are empty in the built CSS. These unlayered escaped selectors are
    // the only thing that makes keyboard focus visible; keep them present.
    expect(kitCss.includes(".focus\\:shadow-focus:focus")).toBe(true);
    expect(kitCss.includes(".focus-within\\:shadow-focus-soft:focus-within")).toBe(true);
  });

  it("keeps the light-theme border a faint hairline (no heavy frames)", () => {
    // User feedback 2026-11-20: darkening --border to 0.64 (WCAG 1.4.11)
    // made every chip/card/overlay read as a heavy frame — the model chip
    // (model + usage bar + chevron) got an obvious outline. The light theme
    // must stay a faint hairline again; resting boundaries come from surface
    // fills, keyboard focus from --shadow-focus, text contrast from the
    // foreground tokens — none of which depend on this value. Lock it light
    // so a future "darken the border" change cannot silently regress.
    // The first --border in the sheet is the light :root one (dark theme is
    // defined later behind prefers-color-scheme).
    const lightBorder = kitCss.match(/--border:\s*oklch\(\s*([\d.]+)/);
    expect(lightBorder).not.toBeNull();
    expect(Number(lightBorder![1])).toBeGreaterThanOrEqual(0.85);
  });

  it("uses one close label for every dismiss affordance", () => {
    // ModalShell's X is a dismissal, not a collapse. The toast X already uses
    // t("关闭") (Dismiss); a second Collapse-labelled X read as "Collapse" in
    // English. t("收起") stays for real folding (SettingsDisclosure / board).
    const kit = files.find((f) => f.rel === CONTROL_HOME)!.content;
    const shell = kit.slice(kit.indexOf("export function ModalShell("), kit.indexOf("export function useCountdown("));
    expect(shell).toContain('label={t("关闭")}');
    expect(shell).not.toContain('t("收起")');
  });

  it("keeps dialog chrome on kit button primitives", () => {
    // ModalShell's header cluster and ConfirmDialog's action row used to
    // hand-roll buttons (18×18 glyph buttons, bespoke 24px action strings).
    // They must use the kit's IconButton / Button so height, radius, focus
    // ring and disabled state stay single-sourced.
    const kit = files.find((f) => f.rel === CONTROL_HOME)!.content;
    const modal = kit.slice(kit.indexOf("export function ModalShell("), kit.indexOf("export function useCountdown("));
    const confirm = kit.slice(kit.indexOf("export function ConfirmDialog("), kit.indexOf("const MENU_VIEWPORT_MARGIN"));
    expect(modal).not.toMatch(/<button\b/);
    expect(confirm).not.toMatch(/<button\b/);
    expect(confirm).toContain("data-autofocus");
    expect(confirm).toContain("<Button");
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

    // jsdom has no layout: pin the trigger wrapper to a realistic field width
    // so the width policy (min = trigger, max = 28rem / viewport) is asserted
    // against real numbers instead of the 0×0 default rect.
    const wrapper = trigger!.parentElement!.parentElement as HTMLElement;
    const anchorRect = {
      x: 120,
      y: 100,
      left: 120,
      top: 100,
      right: 340,
      bottom: 128,
      width: 220,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect;
    wrapper.getBoundingClientRect = () => anchorRect;

    act(() => trigger!.click());

    // The menu is portaled to <body>: fixed positioning escapes the settings
    // card's overflow-hidden / the settings body's scroll container.
    const menu = document.body.querySelector<HTMLDivElement>("[role='menu']");
    expect(menu).toBeTruthy();
    expect(menu!.parentElement).toBe(document.body);
    expect(container.contains(menu!)).toBe(false);
    expect(menu!.style.position).toBe("fixed");
    // Width policy: content-sized (long descriptions wrap at a readable
    // width rather than being squeezed into the 220px trigger column), never
    // narrower than the trigger.
    expect(menu!.style.width).toBe("max-content");
    expect(menu!.style.minWidth).toBe("220px");
    const maxWidth = Number.parseInt(menu!.style.maxWidth, 10);
    expect(maxWidth).toBeGreaterThanOrEqual(300);
    expect(maxWidth).toBeLessThanOrEqual(448);
    // Height cap with internal scrolling keeps a long menu inside the viewport.
    expect(Number.parseInt(menu!.style.maxHeight, 10)).toBeGreaterThan(0);
    expect(menu!.className).toContain("overflow-y-auto");
    // Material + entrance animation preserved (guard asserts shadow-float).
    expect(menu!.className).toContain("acrylic-pop");
    expect(menu!.className).toContain("shadow-float");
    expect(menu!.className).toContain("dropdown-in");
    // Placed just below the trigger (fixed coordinates, not wrapper-relative).
    expect(menu!.style.left).toBe("120px");
    expect(menu!.style.top).toBe("132px");

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
    expect(document.body.querySelector("[role='menu']")).toBeNull();
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");

    act(() => root.unmount());
    container.remove();
  });

  it("updates the trigger label on selection and returns focus on Escape", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Controlled(): ReactNode {
      const [value, setValue] = useState("ask");
      return createElement(Select, { ariaLabel: "动作", options: OPTIONS, value, onChange: setValue });
    }

    act(() => {
      root.render(createElement(Controlled));
    });

    const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    act(() => trigger.click());
    expect(document.activeElement).not.toBe(trigger);

    // Escape closes only the menu (document capture listener) and hands focus
    // back to the trigger instead of dropping it to <body>.
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    const items = [...document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    act(() => items[1]!.click());
    expect(trigger.textContent).toContain("自动拒绝");
    expect(document.body.querySelector("[role='menu']")).toBeNull();

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
    // The revealable branch wraps the input in a div, so the input is no
    // longer a flex item of the surrounding Field and would collapse to the
    // browser's intrinsic width — the placeholder gets clipped and the
    // absolute eye toggle detaches from the field.
    expect(input.className).toContain("w-full");
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-label='显示密码']");
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("title")).toBe("显示密码");
    // The toggle must live in the input's own wrapper, not float away.
    expect(toggle!.parentElement).toBe(input.parentElement);
    expect(input.parentElement!.className).toContain("relative");
    expect(input.parentElement!.className).toContain("w-full");

    act(() => toggle!.click());
    expect(input.type).toBe("text");
    expect(container.querySelector("button[aria-label='隐藏密码']")).toBeTruthy();
    expect(container.querySelector("button[aria-label='显示密码']")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
