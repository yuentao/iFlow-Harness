import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { setupHostListener, useChat } from "./store";
import "./styles.css";

setupHostListener();

// Overlay scrollbars: keep the thumb hidden until the user actually scrolls.
// Scroll events do not bubble, so listen in the capture phase; the debounce
// covers element-level and document-level scrollers alike.
let scrollIdleTimer: number | undefined;
document.addEventListener(
  "scroll",
  () => {
    const root = document.documentElement;
    // The class stays on for the whole 700ms idle window, so nearly every
    // scroll event would re-add a class that is already there — a redundant
    // DOM mutation per event. Check first and only write on the transition.
    if (!root.classList.contains("scrolling")) root.classList.add("scrolling");
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      root.classList.remove("scrolling");
    }, 700);
  },
  { capture: true, passive: true },
);

// Wire behavior (probed, browser): Ctrl/Cmd+A inside a webview panel runs the
// browser's select-all and sweeps the entire transcript into one selection.
// Block it globally, but let inputs (composer textarea etc.) keep native
// select-all so users can still select their own draft text.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    const el = e.target as HTMLElement | null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el?.isContentEditable) {
      return;
    }
    e.preventDefault();
  }
});

/**
 * Thin wrapper owning the page-level self-heal anchor. Previously the root
 * boundary had no resetKey, so a page-level render throw stayed up even as
 * the host pushed new snapshots (the inline boundary had one). Subscribing
 * only this wrapper keeps `<App />` element identity stable across retries;
 * ErrorBoundary throttles same-error repeats, so a permanently bad block
 * cannot spin at the host's patch frequency.
 */
function RootBoundary({ children }: { children: ReactNode }) {
  const state = useChat((s) => s.state);
  return (
    <ErrorBoundary variant="page" resetKey={state}>
      {children}
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(
  <RootBoundary>
    <App />
  </RootBoundary>,
);