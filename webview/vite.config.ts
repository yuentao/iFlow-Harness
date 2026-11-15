import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vendor chunk split.
 *
 * Vite 8 bundles with rolldown, so the chunking knob lives under
 * `build.rolldownOptions.output` (rolldown accepts the classic
 * `manualChunks` function; `build.rollupOptions` is only a deprecated
 * alias in Vite 8). The webview entry chunk was 923 kB (285 kB gzip),
 * which tripped the 500 kB `chunkSizeWarningLimit` warning on every build.
 *
 * The split is deliberately "vendor only": react/react-dom stay in the
 * initial graph (the panel renders nothing without them), and the heavy
 * third-party stacks get their own stable chunks so that app-code edits no
 * longer invalidate the whole bundle.
 *
 * NOTE: these chunks stay STATICALLY imported by the entry (the entry
 * chunk imports them), so they are still part of the first-paint graph —
 * splitting only makes every chunk smaller, it does not defer any code.
 * The panel therefore still loads all of them before the first paint.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, RegExp]> = [
  // React runtime + scheduler — first paint is impossible without it.
  ["vendor-react", /[\\/]node_modules[\\/](react|react-dom|scheduler|js-tokens)[\\/]/],
  // marked + highlight.js/lib/common (pulls ~40 grammars).
  ["vendor-markdown", /[\\/]node_modules[\\/](marked|highlight\.js)[\\/]/],
  // DOMPurify — markdown sanitizer.
  ["vendor-sanitize", /[\\/]node_modules[\\/]dompurify[\\/]/],
  // lucide-react — tree-shaken icon set (92 icons in use).
  ["vendor-icons", /[\\/]node_modules[\\/]lucide-react[\\/]/],
];

function manualChunkName(id: string): string | undefined {
  for (const [name, pattern] of VENDOR_CHUNKS) {
    if (pattern.test(id)) return name;
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    /* Explicit modern Chromium CSS target: without it esbuild's CSS minifier
       folds `backdrop-filter` into its `-webkit-` alias (and the webview's
       Chromium ignores the prefixed form), silently killing the acrylic blur.
       chrome111 also covers oklch() / color-mix() used across the theme. */
    cssTarget: "chrome111",
    /* After the vendor split below the webview's own code peaks at 486 kB
       (under Vite's default 500 kB line). The one chunk still above it is
       the anonymous lazy chunk holding @mermaid-js/parser (662 kB) — a
       single upstream file that cannot be split further and is only reached
       through the lazy `import("mermaid")` path, never on the first paint.
       (Naming that chunk via manualChunks was tried and rejected: rolldown
       then hoists it into the entry chunk's static import graph.) The limit
       is raised just enough to keep that one lazy chunk from warning on
       every build. */
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        manualChunks: manualChunkName,
      },
    },
  },
});