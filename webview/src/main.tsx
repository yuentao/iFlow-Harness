import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { setupHostListener } from "./store";
import "./styles.css";

setupHostListener();

// Overlay scrollbars: keep the thumb hidden until the user actually scrolls.
// Scroll events do not bubble, so listen in the capture phase; the debounce
// covers element-level and document-level scrollers alike.
let scrollIdleTimer: number | undefined;
document.addEventListener(
  "scroll",
  () => {
    document.documentElement.classList.add("scrolling");
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("scrolling");
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

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary variant="page">
    <App />
  </ErrorBoundary>,
);
