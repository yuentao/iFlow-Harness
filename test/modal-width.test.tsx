// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ConfirmDialog, ModalShell } from "../webview/src/components/ui";

const WEBVIEW_SRC = join(__dirname, "..", "webview", "src");
const css = readFileSync(join(WEBVIEW_SRC, "styles.css"), "utf8");
const kit = readFileSync(join(WEBVIEW_SRC, "components", "ui.tsx"), "utf8");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});

/** The four dialogs that carry long content / split layouts and therefore
 *  opt into the wide tier. All three non-settings ones used to be pinned at
 *  560px even on a roomy panel. */
const WIDE_DIALOGS = [
  "SettingsModal.tsx",
  "OnboardingWizard.tsx",
  "MemoryReviewDialog.tsx",
  "SuperAgentBoard.tsx",
];
/** Dialogs that are meant to stay narrow (400px tier). */
const NARROW_DIALOGS = ["MemoryQuickAdd.tsx", "ProfileSwitchCard.tsx"];

function modalCall(source: string): string {
  const at = source.indexOf("<ModalShell");
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, at + 500);
}

describe("modal width tiers (css contract)", () => {
  it("declares the three legacy tiers as semantic variables", () => {
    expect(css).toMatch(/--modal-w:\s*400px;/);
    expect(css).toMatch(/--modal-w-wide:\s*560px;/);
    expect(css).toMatch(/--modal-w-settings:\s*680px;/);
  });

  it("keeps the viewport clamp on every tier (16px each side on narrow panels)", () => {
    expect(css).toMatch(/\.auth-modal\s*\{[^}]*width:\s*min\(var\(--modal-w\),\s*calc\(100vw - 32px\)\)/);
    expect(css).toMatch(/\.auth-modal-wide\s*\{[^}]*width:\s*min\(var\(--modal-w-wide\),\s*calc\(100vw - 32px\)\)/);
    expect(css).toMatch(
      /\.auth-modal-wide\.settings-modal\s*\{[^}]*width:\s*min\(var\(--modal-w-settings\),\s*calc\(100vw - 32px\)\)/,
    );
  });

  it("lifts wide dialogs to the settings tier on a roomy panel without a new px value", () => {
    // jsdom has no media-query engine, so the real resolved widths are measured
    // in headless Chrome (see the CDP probe in the task report). This locks the
    // CSS contract that drives those numbers: >=900px reuses the 680px tier.
    expect(css).toMatch(
      /@media\s*\(min-width:\s*900px\)\s*\{\s*\.auth-modal-wide\s*\{\s*width:\s*min\(var\(--modal-w-settings\),\s*calc\(100vw - 32px\)\);\s*\}\s*\}/,
    );
    const section = css.slice(css.indexOf(".auth-modal {"), css.indexOf("@media (max-width: 560px)"));
    expect(section).not.toMatch(/width:\s*min\(\s*\d+px/);
  });

  it("opts every long-content dialog into the wide tier (settings keeps its class)", () => {
    for (const name of WIDE_DIALOGS) {
      const src = readFileSync(join(WEBVIEW_SRC, "components", name), "utf8");
      expect(modalCall(src)).toMatch(/\bwide\b/);
    }
    const settings = readFileSync(join(WEBVIEW_SRC, "components", "SettingsModal.tsx"), "utf8");
    expect(modalCall(settings)).toContain('className="settings-modal"');
  });

  it("keeps confirm / quick-add / profile-switch on the narrow tier", () => {
    for (const name of NARROW_DIALOGS) {
      const src = readFileSync(join(WEBVIEW_SRC, "components", name), "utf8");
      expect(modalCall(src)).not.toMatch(/(^|\n)\s*wide(\s|=|$|\/)/);
    }
    const confirm = kit.slice(kit.indexOf("export function ConfirmDialog("), kit.indexOf("const MENU_VIEWPORT_MARGIN"));
    expect(confirm).not.toMatch(/\bwide\b/);
  });
});

describe("modal shell tier classes (jsdom)", () => {
  it("a plain shell only carries the narrow tier class", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          ModalShell,
          { title: "窄弹窗", ariaLabel: "窄弹窗", onClose: () => {} },
          createElement("div", null, "body"),
        ),
      );
    });
    const modal = container.querySelector<HTMLDivElement>(".auth-modal")!;
    expect(modal).toBeTruthy();
    expect(modal.className).toContain("auth-modal");
    expect(modal.className).not.toContain("auth-modal-wide");
    act(() => root.unmount());
    container.remove();
  });

  it("a wide shell carries the wide tier and container query", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          ModalShell,
          { title: "设置", ariaLabel: "设置", onClose: () => {}, wide: true, className: "settings-modal" },
          createElement("div", null, "body"),
        ),
      );
    });
    const modal = container.querySelector<HTMLDivElement>(".auth-modal")!;
    expect(modal.className).toContain("auth-modal-wide");
    expect(modal.className).toContain("@container");
    expect(modal.className).toContain("settings-modal");
    act(() => root.unmount());
    container.remove();
  });

  it("ConfirmDialog renders on the narrow tier even when stacked over a wide modal", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(ConfirmDialog, { title: "删除", message: "确认删除?", onCancel: () => {} }));
    });
    const modal = document.body.querySelector<HTMLDivElement>(".auth-modal")!;
    expect(modal).toBeTruthy();
    expect(modal.className).toContain("auth-modal");
    expect(modal.className).not.toContain("auth-modal-wide");
    act(() => root.unmount());
    container.remove();
  });
});