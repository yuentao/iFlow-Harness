/**
 * 任务书正文（super-agent 委派卡里的 `task` 字段）的结构化解析。
 *
 * 模型写的任务书常常是一整段「文字墙」：段落不分明、「(1)(2)(3)」挤在同一行、
 * 文件路径与函数名混在中文里没有视觉区分。直接 whitespace-pre-wrap 铺开，
 * 用户看到的就是一堵墙（用户原话：任务书卡片中的文本需要进行格式化，看起来乱糟糟的）。
 *
 * 这里把正文切成**块**（段落 / 项目符号 / 编号项 / 引用 / 标题 / 代码块），
 * 块内再切成**行内片段**（普通文本 / 行内代码），交给卡片渲染。
 *
 * 纯函数、无副作用、不碰 DOM —— 可直接单测。
 */

/**
 * 行内片段：普通文本、一段行内代码，或一段加粗文本。
 *
 * `strong` 的 `text` 是内层纯文本（长度统计/折叠预算用），`inlines` 是内层
 * **再次切分**后的片段 —— 加粗里的路径与行内代码仍然分别渲染，不会被并成一坨。
 */
export type SuperTaskInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string; inlines: SuperTaskInline[] };

/** 任务书正文的一个块。 */
export type SuperTaskBlock =
  | { kind: "paragraph"; inlines: SuperTaskInline[] }
  | { kind: "bullet"; inlines: SuperTaskInline[] }
  /** 编号项：`marker` 是原文里的标记（如 “(1)”），`label` 是序号数字（用于徽标）。 */
  | { kind: "ordered"; marker: string; label: string; inlines: SuperTaskInline[] }
  | { kind: "quote"; inlines: SuperTaskInline[] }
  | { kind: "heading"; level: number; inlines: SuperTaskInline[] }
  | { kind: "code"; lang: string; text: string };

/**
 * 行内代码的扩展名白名单。
 *
 * 只认「看起来就是代码文件」的扩展名：像 `e.g`、`1.0.5`、`U.S.` 这类带点的普通
 * 词不能被误标成代码（它们的白名单命中不到），而 `src/panel/panel.ts`、
 * `README.md`、`a.test.tsx` 会被认出来。
 */
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "xml",
  "sql",
  "txt",
  "ini",
  "env",
  "lock",
]);

/** URL：整段保持普通文本，绝不被切成代码片段（否则链接会碎成几段）。 */
const URL_STICKY = /https?:\/\/\S+|www\.[^\s]+/y;
/** 反引号包裹的行内代码（单/双反引号都认；内容不跨行）。 */
const BACKTICK_STICKY = /(`+)([^`\n]+?)\1/y;
/** 路径 / 文件名：斜杠分段 + 一个扩展名。 */
const PATH_STICKY = /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]{1,8}/y;
/** 标识符调用：reportPrompt(entries)、SuperReportBuffer.takeSettled(sessions)。 */
const CALL_STICKY = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()\n]*\)/y;
/**
 * 行内加粗：`**…**`。
 *
 * 内容必须非空、首尾非空白、内部不含同种标记、且不跨行 —— 未闭合的 `**`
 * （模型写到一半、或正文里本来就有一个星号）匹配不到，按普通文本原样保留。
 */
const BOLD_STAR_STICKY = /\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/y;
/** 行内加粗：`__…__`（标识符里的双下划线由 isWordChar 守卫挡掉）。 */
const BOLD_UNDERSCORE_STICKY = /__([^\s_](?:[^_\n]*[^\s_])?)__/y;

/** 行首项目符号：`- ` / `* ` / `• `（`**加粗**` 不会被误判：后面不是空白）。 */
const BULLET_RE = /^\s*[-*•]\s+/;
/**
 * 行首编号项：`1. ` / `1) ` / `(1) ` / `（1）`。
 *
 * 行首的编号由这里处理；**同一行里**挤着的编号（“(1) …(2) …”）由
 * splitEnumeration 处理 —— 两者合起来覆盖模型写任务书的两种习惯。
 */
const ORDERED_RE = /^\s*(?:[（(]\s*(\d{1,2})\s*[)）]|(\d{1,2})[.)])\s+/;
/** 行首引用：`> `。 */
const QUOTE_RE = /^\s*>\s?/;
/** Markdown 标题：`## 目标`。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/**
 * 中文方括号小节：行首 `【前置检查（重要，先做）】`。
 *
 * 模型写任务书常用这种「小节标题」而不是 markdown 标题。只有**行首**算标题；
 * 行中出现的 `【…】`（“说明【重要】这一段”）是普通文字，不切。方括号后面若还
 * 跟着正文，正文另起段落 —— 绝不把字丢掉。
 */
const SECTION_RE = /^\s*【([^【】\n]+)】\s*(.*)$/;
/** 代码围栏开头。 */
const FENCE_RE = /^\s*```(.*)$/;
/** 代码围栏收尾（裸 ```）。 */
const FENCE_CLOSE_RE = /^\s*```\s*$/;

/** 括号枚举标记：`(1)` / `（1）`。 */
const ENUM_STRONG_RE = /[（(]\s*(\d{1,2})\s*[)）]/g;
/**
 * 裸序号标记：`1)`。
 *
 * 只在**行首**才算 —— 正文里的「缺省 0）」这类括号不是枚举。行首的 `1)` 列表
 * 是模型常用的另一种写法。
 */
const ENUM_WEAK_RE = /(?:^|\n)([ \t]*)(\d{1,2})\)/g;

/** 标识符字符：出现在标记前说明它属于上一个词（foo(1) 是调用，不是枚举）。 */
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

interface EnumMarker {
  start: number;
  end: number;
  label: string;
  raw: string;
}

/**
 * 找出正文里的枚举标记。
 *
 * 强标记（带括号）全文有效；弱标记（裸 `1)`）只在行首有效。两者都要求标记前
 * 不是标识符字符、标记后也不是 —— 否则 `foo(1)`、`(1)abc` 这类会被误判。
 */
function findEnumMarkers(text: string): EnumMarker[] {
  const markers: EnumMarker[] = [];

  ENUM_STRONG_RE.lastIndex = 0;
  let match = ENUM_STRONG_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    const end = ENUM_STRONG_RE.lastIndex;
    const before = start > 0 ? (text[start - 1] ?? "") : "";
    const after = end < text.length ? (text[end] ?? "") : "";
    if (!IDENT_CHAR_RE.test(before) && !IDENT_CHAR_RE.test(after)) {
      markers.push({ start, end, label: match[1] ?? "", raw: match[0] });
    }
    match = ENUM_STRONG_RE.exec(text);
  }

  ENUM_WEAK_RE.lastIndex = 0;
  match = ENUM_WEAK_RE.exec(text);
  while (match !== null) {
    const raw = match[0];
    const digits = match[2] ?? "";
    // raw 以 “)” 结尾，数字紧挨着它，所以数字起点 = raw.length - digits.length - 1。
    const start = match.index + raw.length - digits.length - 1;
    const end = match.index + raw.length;
    const after = end < text.length ? (text[end] ?? "") : "";
    if (!IDENT_CHAR_RE.test(after)) {
      markers.push({ start, end, label: digits, raw: digits + ")" });
    }
    match = ENUM_WEAK_RE.exec(text);
  }

  markers.sort((a, b) => a.start - b.start);
  // 去掉重叠（理论上强标记与弱标记不会交叠，保险起见）。
  const cleaned: EnumMarker[] = [];
  for (const marker of markers) {
    const last = cleaned[cleaned.length - 1];
    if (last && marker.start < last.end) continue;
    cleaned.push(marker);
  }
  return cleaned;
}

/**
 * 把一段正文按**行内枚举**切开。
 *
 * 这是任务书可读性的关键：模型常把 “(1) …(2) …(8) …” 挤在同一行里，行首规则
 * 救不了这种情况。只有出现 ≥2 个标记、且序号严格递增时才切 —— 否则正文里
 * 偶然出现的括号（“共 3 个（第 2 项）”）会把段落切碎。
 */
function splitEnumeration(
  text: string,
): Array<{ kind: "paragraph" | "ordered"; text: string; marker?: string; label?: string }> {
  const markers = findEnumMarkers(text);
  if (markers.length < 2) return [{ kind: "paragraph", text }];

  let increasing = true;
  for (let i = 1; i < markers.length; i++) {
    const previous = Number(markers[i - 1]?.label ?? "0");
    const current = Number(markers[i]?.label ?? "0");
    if (!(current > previous)) {
      increasing = false;
      break;
    }
  }
  if (!increasing) return [{ kind: "paragraph", text }];

  const parts: Array<{ kind: "paragraph" | "ordered"; text: string; marker?: string; label?: string }> = [];
  const preamble = text.slice(0, markers[0]?.start ?? 0).trim();
  if (preamble) parts.push({ kind: "paragraph", text: preamble });
  markers.forEach((marker, index) => {
    const end = index + 1 < markers.length ? (markers[index + 1]?.start ?? text.length) : text.length;
    const body = text.slice(marker.end, end).trim();
    if (!body) return;
    parts.push({ kind: "ordered", text: body, marker: marker.raw, label: marker.label });
  });
  return parts.length > 0 ? parts : [{ kind: "paragraph", text }];
}

/** 文件名/路径是否算「代码」：扩展名在白名单里才算。 */
function isCodePath(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = token.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return false;
  return CODE_EXTENSIONS.has(ext);
}

/** 标识符字符：`my__var__name` 里的双下划线不是加粗标记。 */
const WORD_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * 把一段文字切成行内片段（普通文本 / 行内代码 / 加粗）。
 *
 * 扫描是**从左到右逐位置**的：每个位置依次试加粗 → URL → 反引号 → 路径 →
 * 标识符调用，命中的才被切成对应片段，其余原样累加为普通文本（空白因此完整
 * 保留）。加粗的内层会**再切一次**，所以 `**先跑 `npm test`**` 里的行内代码
 * 仍然成立。
 */
export function splitSuperTaskInlines(text: string): SuperTaskInline[] {
  const inlines: SuperTaskInline[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = (): void => {
    if (!plain) return;
    inlines.push({ kind: "text", text: plain });
    plain = "";
  };

  while (index < text.length) {
    // 加粗：`**…**` / `__…__`（未闭合时匹配不到，按普通文本留下）。
    BOLD_STAR_STICKY.lastIndex = index;
    const boldStar = BOLD_STAR_STICKY.exec(text);
    if (boldStar) {
      const inner = boldStar[1] ?? "";
      const innerInlines = splitSuperTaskInlines(inner);
      flushPlain();
      inlines.push({
        kind: "strong",
        text: innerInlines.map((inline) => inline.text).join(""),
        inlines: innerInlines,
      });
      index += boldStar[0].length;
      continue;
    }
    BOLD_UNDERSCORE_STICKY.lastIndex = index;
    const boldUnderscore = BOLD_UNDERSCORE_STICKY.exec(text);
    const before = index > 0 ? (text[index - 1] ?? "") : "";
    if (boldUnderscore && !WORD_CHAR_RE.test(before)) {
      const inner = boldUnderscore[1] ?? "";
      const innerInlines = splitSuperTaskInlines(inner);
      flushPlain();
      inlines.push({
        kind: "strong",
        text: innerInlines.map((inline) => inline.text).join(""),
        inlines: innerInlines,
      });
      index += boldUnderscore[0].length;
      continue;
    }
    // URL：整段保持普通文本。
    URL_STICKY.lastIndex = index;
    const url = URL_STICKY.exec(text);
    if (url) {
      plain += url[0];
      index += url[0].length;
      continue;
    }
    // 反引号：行内代码。
    BACKTICK_STICKY.lastIndex = index;
    const tick = BACKTICK_STICKY.exec(text);
    if (tick) {
      flushPlain();
      inlines.push({ kind: "code", text: tick[2] ?? "" });
      index += tick[0].length;
      continue;
    }
    // 路径 / 文件名。
    PATH_STICKY.lastIndex = index;
    const path = PATH_STICKY.exec(text);
    if (path && isCodePath(path[0])) {
      flushPlain();
      inlines.push({ kind: "code", text: path[0] });
      index += path[0].length;
      continue;
    }
    // 标识符调用。
    CALL_STICKY.lastIndex = index;
    const call = CALL_STICKY.exec(text);
    if (call) {
      flushPlain();
      inlines.push({ kind: "code", text: call[0] });
      index += call[0].length;
      continue;
    }
    plain += text[index];
    index += 1;
  }

  flushPlain();
  return inlines;
}

/**
 * 把任务书正文解析成块序列。
 *
 * 规则：
 *  - 空行分段 → 段落；
 *  - 行首 `-` / `*` / `•` → 项目符号项；
 *  - 行首 `>` → 引用；
 *  - 行首 `#` → 标题；
 *  - ``` 围栏 → 代码块（未闭合时按「到文末为止」处理，不吞掉后面的正文）；
 *  - 其余行 → 段落 / 上一项的续行（缩进行视为续行）；
 *  - 段落内部再按**行内枚举** `(1)(2)(3)` 切开（见 splitEnumeration）。
 */
export function parseSuperTaskText(text: string): SuperTaskBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SuperTaskBlock[] = [];

  let bufferKind: "paragraph" | "bullet" | "quote" | "ordered" | null = null;
  let bufferLines: string[] = [];
  let bufferMarker = "";
  let bufferLabel = "";

  const flush = (): void => {
    if (bufferKind === null) return;
    const kind = bufferKind;
    const marker = bufferMarker;
    const label = bufferLabel;
    const body = bufferLines.join("\n").trim();
    bufferKind = null;
    bufferLines = [];
    bufferMarker = "";
    bufferLabel = "";
    if (!body) return;
    if (kind === "paragraph") {
      for (const part of splitEnumeration(body)) {
        blocks.push(
          part.kind === "ordered"
            ? {
                kind: "ordered",
                marker: part.marker ?? part.label ?? "",
                label: part.label ?? "",
                inlines: splitSuperTaskInlines(part.text),
              }
            : { kind: "paragraph", inlines: splitSuperTaskInlines(part.text) },
        );
      }
      return;
    }
    if (kind === "ordered") {
      blocks.push({ kind: "ordered", marker, label, inlines: splitSuperTaskInlines(body) });
      return;
    }
    blocks.push({ kind, inlines: splitSuperTaskInlines(body) });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    // 代码围栏
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const lang = (fence[1] ?? "").trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (FENCE_CLOSE_RE.test(current)) {
          index += 1;
          break;
        }
        codeLines.push(current);
        index += 1;
      }
      blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    // 空行：分段
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inlines: splitSuperTaskInlines((heading[2] ?? "").trim()),
      });
      index += 1;
      continue;
    }

    // 行首中文方括号小节：【前置检查（重要，先做）】
    const section = SECTION_RE.exec(line);
    if (section) {
      flush();
      blocks.push({
        kind: "heading",
        level: 2,
        inlines: splitSuperTaskInlines((section[1] ?? "").trim()),
      });
      const rest = (section[2] ?? "").trim();
      index += 1;
      // 方括号后面还跟着正文：另起一段接上，绝不吞字。
      if (rest) {
        bufferKind = "paragraph";
        bufferLines = [rest];
      }
      continue;
    }

    // 引用
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      if (bufferKind !== "quote") {
        flush();
        bufferKind = "quote";
        bufferLines = [];
      }
      bufferLines.push(line.slice(quote[0].length));
      index += 1;
      continue;
    }

    // 项目符号
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flush();
      bufferKind = "bullet";
      bufferLines = [line.slice(bullet[0].length)];
      index += 1;
      continue;
    }

    // 编号项（行首）
    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flush();
      bufferKind = "ordered";
      bufferMarker = ordered[0].trim();
      bufferLabel = ordered[1] ?? ordered[2] ?? "";
      bufferLines = [line.slice(ordered[0].length)];
      index += 1;
      continue;
    }

    // 普通行：段落，或上一项的续行（缩进续行）
    const indented = /^\s/.test(line);
    if (bufferKind === "bullet" || bufferKind === "quote" || bufferKind === "ordered") {
      if (indented) {
        bufferLines.push(line.trim());
        index += 1;
        continue;
      }
      flush();
    }
    if (bufferKind === null) {
      bufferKind = "paragraph";
      bufferLines = [];
    }
    bufferLines.push(line);
    index += 1;
  }

  flush();
  return blocks;
}

/** 块的纯文本长度（用于折叠预算）。 */
function blockLength(block: SuperTaskBlock): number {
  if (block.kind === "code") return block.text.length;
  return block.inlines.reduce((sum, inline) => sum + inline.text.length, 0);
}

/** 在句子边界处收尾：优先切在句号/分号/换行处，避免半句被截断得太难看。 */
function cutAtBoundary(text: string, limit: number): string {
  const head = text.slice(0, limit);
  const boundary = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("；"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf("\n"),
    head.lastIndexOf(". "),
  );
  if (boundary > limit * 0.5) return head.slice(0, boundary + 1);
  return head;
}

/** 折叠预览的结果。 */
export interface SuperTaskPreview {
  /** 要渲染的块（每块都完整，除非 cutText）。 */
  blocks: SuperTaskBlock[];
  /** 还有内容没给出来。 */
  truncated: boolean;
  /**
   * 末块正文**本身**被切开了（末尾已带省略号）。
   *
   * 与「后面还有别的块」是两种情况：后者不该在末块尾巴上补省略号（那会让一段
   * 完整的文字看起来像半句），由卡片另外画一条「还有更多」的提示。
   */
  cutText: boolean;
  /** 折叠态没展示出来的正文字数（不截断时为 0），用于「还有 N 字」提示。 */
  hiddenChars: number;
}

/**
 * 折叠态的预览：按**块**给出一段可读的截断，而不是把整段文字 line-clamp 成
 * 半截句子。超预算时切在块边界；第一块就超预算时切在句子边界，并补一个省略号。
 *
 * 短任务书（总长不超预算）**整段读完**：不切、不加省略号，折叠态与展开态一致
 * —— 没有内容可省时就不该摆一个「展开」按钮。
 */
export function previewSuperTaskBlocks(
  blocks: SuperTaskBlock[],
  budget: number,
  maxBlocks: number,
): SuperTaskPreview {
  const total = blocks.reduce((sum, block) => sum + blockLength(block), 0);
  if (total <= budget) return { blocks, truncated: false, cutText: false, hiddenChars: 0 };

  const out: SuperTaskBlock[] = [];
  let used = 0;
  /** 已给出的块合计字数（含末尾省略号），用于算「还有 N 字」。 */
  const shownChars = (): number => out.reduce((sum, block) => sum + blockLength(block), 0);

  for (const block of blocks) {
    const length = blockLength(block);
    if (used + length <= budget && out.length < maxBlocks) {
      out.push(block);
      used += length;
      continue;
    }
    if (out.length === 0) {
      // 第一块就超预算：切在句子边界，末尾补省略号。
      const cut =
        block.kind === "code"
          ? { ...block, text: `${cutAtBoundary(block.text, budget)}…` }
          : { ...block, inlines: cutInlines(block.inlines, budget) };
      out.push(cut);
      return {
        blocks: out,
        truncated: true,
        cutText: true,
        hiddenChars: Math.max(0, total - shownChars()),
      };
    }
    // 块边界截断：给出去的块都是完整的，由卡片另外提示「还有更多」。
    return {
      blocks: out,
      truncated: true,
      cutText: false,
      hiddenChars: Math.max(0, total - shownChars()),
    };
  }

  return { blocks: out, truncated: false, cutText: false, hiddenChars: 0 };
}

/** 按字符预算截断行内片段。 */
function cutInlines(inlines: SuperTaskInline[], budget: number): SuperTaskInline[] {
  const out: SuperTaskInline[] = [];
  let used = 0;
  for (const inline of inlines) {
    if (used >= budget) break;
    const remain = budget - used;
    if (inline.text.length <= remain) {
      out.push(inline);
      used += inline.text.length;
      continue;
    }
    const cut = `${cutAtBoundary(inline.text, remain)}…`;
    out.push(
      inline.kind === "strong"
        ? { kind: "strong", text: cut, inlines: splitSuperTaskInlines(cut) }
        : { kind: inline.kind, text: cut },
    );
    used += remain;
    break;
  }
  return out;
}
