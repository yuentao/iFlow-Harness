import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - JS 脚本无声明文件，测试配置未包含 scripts 的 .d.ts
import { readSource } from "../scripts/gen-l10n.mjs";

/**
 * Key 对账：源码里出现的每个 `t()` / `l10n.t()` 字面量 key 都必须登记在单一源
 * `l10n/source.en.json`，且单一源里不应留下完全无人引用的死 key。
 *
 * 这里用一个很小的词法扫描器而不是正则，因为正则分不清「注释里的示例调用」、
 * 「字符串里的引号」与「正则字面量」：注释里的 `t("…")` 会被当成真实调用
 * （假缺失），`x.split("//")` 会被当成注释起点而吞掉后面的代码。扫描器会跳过
 * 注释 / 正则，只保留标识符、字符串与模板字符串三类 token；模板字符串 `${…}`
 * 里的表达式会递归扫描，因此「模板里再调 t()」的写法也不会漏。
 *
 * 动态 key（首参是变量、拼接或带插值的模板）按设计**不参与缺失判定**：它们
 * 本来就不该进字典（字典以字面量 key 索引），强行报缺失只会误伤。
 *
 * 死 key 方向的判定是保守的：key 只要作为任意字符串字面量（含模板插值归一成
 * `{0}` 的形态）在扫描范围内出现过就算被引用 —— 宁可漏报也不误报。
 */

const root = path.resolve(import.meta.dirname, "..");
const SCAN_DIRS = ["src", "webview/src", "shared"];
/** 生成产物不是引用点：它包含全部 key，扫进来死 key 判定会恒为 0。 */
const GENERATED_WEBVIEW_I18N = path.resolve(root, "webview", "src", "i18n.ts");

type Token =
  | { kind: "ident"; value: string; start: number }
  | { kind: "string"; value: string; start: number }
  | { kind: "template"; value: string; interpolated: boolean; start: number }
  | { kind: "punct"; value: string; start: number }
  | { kind: "value"; start: number };

/** 这些关键字之后出现的 `/` 是正则字面量的起点，而不是除号。 */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "delete",
  "void",
  "new",
  "do",
  "else",
  "yield",
  "await",
]);

/** 读一个转义序列；`start` 指向反斜杠。返回解码值与此后的位置。 */
function readEscape(text: string, start: number): { value: string; next: number } {
  const ch = text[start + 1] ?? "";
  switch (ch) {
    case "n":
      return { value: "\n", next: start + 2 };
    case "t":
      return { value: "\t", next: start + 2 };
    case "r":
      return { value: "\r", next: start + 2 };
    case "b":
      return { value: "\b", next: start + 2 };
    case "f":
      return { value: "\f", next: start + 2 };
    case "v":
      return { value: "\v", next: start + 2 };
    case "0":
      return { value: "\0", next: start + 2 };
    case "x": {
      const hex = text.slice(start + 2, start + 4);
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), next: start + 4 };
    }
    case "u": {
      if (text[start + 2] === "{") {
        const close = text.indexOf("}", start + 3);
        const hex = text.slice(start + 3, close < 0 ? undefined : close);
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: close + 1 };
      }
      const hex = text.slice(start + 2, start + 6);
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), next: start + 6 };
    }
    case "\n":
      return { value: "", next: start + 2 };
    default:
      return { value: ch, next: start + 2 };
  }
}

function readQuoted(
  text: string,
  start: number,
  to: number,
): { value: string; next: number } {
  const quote = text[start] ?? "";
  let j = start + 1;
  let value = "";
  while (j < to) {
    const c = text[j] ?? "";
    if (c === "\\") {
      const escape = readEscape(text, j);
      value += escape.value;
      j = escape.next;
      continue;
    }
    if (c === quote) return { value, next: j + 1 };
    value += c;
    j++;
  }
  return { value, next: j };
}

/** `start` 指向 `${` 之后；返回匹配的 `}` 之后的位置。 */
function skipInterpolation(text: string, start: number, to: number): number {
  let depth = 1;
  let j = start;
  while (j < to) {
    const c = text[j] ?? "";
    if (c === '"' || c === "'") {
      j = readQuoted(text, j, to).next;
      continue;
    }
    if (c === "`") {
      j = readTemplate(text, j, to).next;
      continue;
    }
    if (c === "/" && text[j + 1] === "/") {
      while (j < to && text[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < to && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

function readTemplate(
  text: string,
  start: number,
  to: number,
): { value: string; interpolated: boolean; next: number } {
  let j = start + 1;
  let value = "";
  let interpolated = false;
  let slot = 0;
  while (j < to) {
    const c = text[j] ?? "";
    if (c === "\\") {
      const escape = readEscape(text, j);
      value += escape.value;
      j = escape.next;
      continue;
    }
    if (c === "`") return { value, interpolated, next: j + 1 };
    if (c === "$" && text[j + 1] === "{") {
      interpolated = true;
      value += `{${slot++}}`;
      j = skipInterpolation(text, j + 2, to);
      continue;
    }
    value += c;
    j++;
  }
  return { value, interpolated, next: j };
}

/**
 * 扫描 `[from, to)` 区间。模板字符串 `${…}` 内的表达式会递归 tokenize 并追加
 * 到结果里（顺序上排在模板 token 之后，足以让 `t("…")` 的相邻性判定成立）。
 */
function tokenize(text: string, from = 0, to = text.length): Token[] {
  const tokens: Token[] = [];
  let i = from;
  const regexAllowed = (): boolean => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "punct") return !")]}".includes(last.value);
    if (last.kind === "ident") return REGEX_KEYWORDS.has(last.value);
    return false;
  };
  while (i < to) {
    const c = text[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < to && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < to && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < to) {
        const d = text[j] ?? "";
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
        j++;
      }
      j++;
      while (j < to && /[a-z]/i.test(text[j] ?? "")) j++;
      tokens.push({ kind: "value", start: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const { value, next } = readQuoted(text, i, to);
      tokens.push({ kind: "string", value, start: i });
      i = next;
      continue;
    }
    if (c === "`") {
      const start = i;
      let j = i + 1;
      let value = "";
      let interpolated = false;
      let slot = 0;
      const nested: Token[] = [];
      while (j < to) {
        const d = text[j] ?? "";
        if (d === "\\") {
          const escape = readEscape(text, j);
          value += escape.value;
          j = escape.next;
          continue;
        }
        if (d === "`") {
          j++;
          break;
        }
        if (d === "$" && text[j + 1] === "{") {
          interpolated = true;
          value += `{${slot++}}`;
          const end = skipInterpolation(text, j + 2, to);
          nested.push(...tokenize(text, j + 2, Math.max(j + 2, end - 1)));
          j = end;
          continue;
        }
        value += d;
        j++;
      }
      tokens.push({ kind: "template", value, interpolated, start });
      tokens.push(...nested);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < to && /[\w$]/.test(text[j] ?? "")) j++;
      tokens.push({ kind: "ident", value: text.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < to && /[\w.]/.test(text[j] ?? "")) j++;
      tokens.push({ kind: "value", start: i });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: c, start: i });
    i++;
  }
  return tokens;
}

/** 该 `t` 标识符是否是一次翻译调用的被调用者。 */
function isTranslationCallee(tokens: Token[], index: number): boolean {
  const prev = tokens[index - 1];
  if (prev?.kind === "punct" && prev.value === ".") {
    const receiver = tokens[index - 2];
    return receiver?.kind === "ident" && receiver.value === "l10n";
  }
  if (!prev) return true;
  if (prev.kind === "punct") return true;
  if (prev.kind === "ident") return REGEX_KEYWORDS.has(prev.value);
  return false;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        if (path.resolve(full) === GENERATED_WEBVIEW_I18N) continue;
        out.push(full);
      }
    }
  };
  for (const dir of SCAN_DIRS) visit(path.join(root, dir));
  return out;
}

interface ScanResult {
  /** 字面量翻译 key 及其位置。 */
  callKeys: Array<{ key: string; where: string }>;
  /** 扫描范围内出现过的全部字符串 / 模板字符串值（插值归一为 {0}）。 */
  literals: Set<string>;
}

function scan(): ScanResult {
  const callKeys: Array<{ key: string; where: string }> = [];
  const literals = new Set<string>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const tokens = tokenize(text);
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    for (const token of tokens) {
      if (token.kind === "string" || token.kind === "template") literals.add(token.value);
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token?.kind !== "ident" || token.value !== "t") continue;
      if (!isTranslationCallee(tokens, i)) continue;
      const open = tokens[i + 1];
      if (open?.kind !== "punct" || open.value !== "(") continue;
      const arg = tokens[i + 2];
      if (!arg) continue;
      const after = tokens[i + 3];
      const closesFirstArg =
        after?.kind === "punct" && (after.value === "," || after.value === ")");
      if (!closesFirstArg) continue;
      const key =
        arg.kind === "string"
          ? arg.value
          : arg.kind === "template" && !arg.interpolated
            ? arg.value
            : null;
      if (key === null) continue;
      callKeys.push({ key, where: `${relative}:${lineOf(arg.start)}` });
    }
  }
  return { callKeys, literals };
}

describe("l10n key coverage against the single source", () => {
  it("every literal t() / l10n.t() key is registered in l10n/source.en.json", () => {
    const source = readSource() as Record<string, unknown>;
    const { callKeys } = scan();
    const missing = callKeys
      .filter(({ key }) => !(key in source))
      .map(({ key, where }) => `${JSON.stringify(key)} at ${where}`);
    expect(missing).toEqual([]);
  });

  it("l10n/source.en.json has no dead key nobody references", () => {
    const source = readSource() as Record<string, unknown>;
    const { literals } = scan();
    const dead = Object.keys(source).filter((key) => !literals.has(key));
    expect(dead).toEqual([]);
  });
});