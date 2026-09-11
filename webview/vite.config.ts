import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  },
});