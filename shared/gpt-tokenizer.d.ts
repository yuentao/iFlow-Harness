// Ambient module declaration for `gpt-tokenizer` (v4 ships no TypeScript types).
// We only use the default o200k_base encoding's token counting.
declare module "gpt-tokenizer" {
  export function encode(text: string, allowedSpecial?: string[]): number[];
  export function decode(tokens: number[]): string;
  export function countTokens(text: string): number;
  export function isWithinTokenLimit(text: string, limit: number): boolean | undefined;
}
