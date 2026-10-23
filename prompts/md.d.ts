/**
 * Prompt templates are imported as plain text. The host bundle inlines them via
 * esbuild's `loader: { ".md": "text" }`; vitest mirrors the same contract in
 * `vitest.config.ts`. This declaration only exists to satisfy tsc (Node16
 * resolution cannot type a `.md` import on its own).
 */
declare module "*.md" {
  const text: string;
  export default text;
}
