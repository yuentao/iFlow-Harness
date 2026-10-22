import * as http from "node:http";
import * as https from "node:https";
import { decodeResponseText, extractHtmlText } from "../../shared/context-source.js";

/**
 * Host-side web search for the 「联网补充模型数据」 flow.
 *
 * Why not the CLI's own `web_search` tool: the bundled CLI only exposes it
 * when `getSearchApiKey()` is truthy (bundle: `getFunctionDeclarations`
 * filters `web_search`/`web_fetch` out otherwise) — and the bundled build
 * carries no search backend for third-party gateway keys (probed 2026-10-23:
 * `~/.iflow/settings.json` has `searchApiKey: ""`, so the tool is not even in
 * the tool list, and the bundle has no bing/ddg fallback). Running the
 * metadata task on a CLI agent session therefore burned a full agent turn
 * (measured: 56,287 input tokens for a trivial prompt — 39,992 of them the
 * system prompt + project memory, 12,160 the tool schemas) and still returned
 * nothing.
 *
 * So the panel searches itself and hands the snippets to a plain completion
 * (`streamChatCompletion`): no system prompt, no tool schemas, no project
 * memory — a few thousand tokens instead of 56k.
 *
 * Transport is raw node:http(s) like models-query.ts: the VSCode extension
 * host patches global fetch with a proxy agent that throws on SOCKS /
 * scheme-less system proxies (pitfall #2).
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  /** Per-request ceiling. */
  timeoutMs?: number;
  /** Max hits per engine. */
  limit?: number;
  /** Per-snippet character cap. */
  snippetChars?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 4;
const DEFAULT_SNIPPET_CHARS = 320;
const MAX_REDIRECTS = 3;
/** Byte cap per fetched page (a pricing page is far below this). */
const MAX_PAGE_BYTES = 2_000_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
  "#47": "/",
};

/** Decode the handful of entities a search result page actually contains. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const known = ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Bing result blocks: `<li class="b_algo">` → title link + caption
 * paragraph. Parsing is pure so it can be pinned by unit tests against a
 * saved fixture instead of a live page.
 */
export function parseBingResults(html: string, limit = DEFAULT_LIMIT, snippetChars = DEFAULT_SNIPPET_CHARS): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const blocks = html.split(/class="b_algo"/).slice(1);
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeHtmlEntities(link[1] ?? "");
    const title = stripTags(link[2] ?? "");
    if (!url || !title) continue;
    const caption = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = caption ? stripTags(caption[1] ?? "").slice(0, snippetChars) : "";
    hits.push({ title, url, snippet });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** DuckDuckGo's HTML endpoint: `result__a` links + `result__snippet`. */
export function parseDdgResults(html: string, limit = DEFAULT_LIMIT, snippetChars = DEFAULT_SNIPPET_CHARS): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  const sources = blocks.length > 0 ? blocks : html.split(/class="result__a"/).slice(1);
  for (const block of sources) {
    const link = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const rawUrl = decodeHtmlEntities(link[1] ?? "");
    const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const title = stripTags(link[2] ?? "");
    if (!url || !title) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    hits.push({
      title,
      url,
      snippet: snippet ? stripTags(snippet[1] ?? "").slice(0, snippetChars) : "",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** One HTTP GET, following up to MAX_REDIRECTS redirects. "" on any failure. */
function fetchText(url: string, timeoutMs: number, redirectsLeft = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done("");
      return;
    }
    const transport = target.protocol === "http:" ? http : https;
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            done("");
            return;
          }
          const next = new URL(res.headers.location, target).toString();
          void fetchText(next, timeoutMs, redirectsLeft - 1).then(done);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          done("");
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => done(""));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => done(""));
    req.end();
  });
}

/**
 * Search the web for one query. Engine chain: Bing first, DuckDuckGo as the
 * fallback (DDG's HTML endpoint is unreachable from mainland China — probed
 * 2026-10-23: timeout; Bing's cn endpoint answered with 10 result blocks).
 * Returns [] when every engine failed — the caller decides what to do.
 */
/**
 * Fetch one page and reduce it to plain text. The metadata flow reads the
 * documentation/pricing pages the search found: the context-window and price
 * figures live in the page body (the pricing table is usually far below the
 * fold), not in the search snippet. Returns "" on any failure.
 */
export async function fetchPageText(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? 60_000;
  const response = await fetchBytes(url, timeoutMs);
  if (!response) return "";
  const decoded = decodeResponseText(response.bytes, response.contentType);
  const contentType = response.contentType.toLowerCase();
  const text = contentType.includes("html") ? extractHtmlText(decoded) : decoded;
  return text.slice(0, maxChars);
}

interface PageResponse {
  bytes: Buffer;
  contentType: string;
}

/** One HTTP GET as bytes, following up to MAX_REDIRECTS redirects. */
function fetchBytes(url: string, timeoutMs: number, redirectsLeft = MAX_REDIRECTS): Promise<PageResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: PageResponse | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done(null);
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      done(null);
      return;
    }
    const transport = target.protocol === "http:" ? http : https;
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          // identity: some servers gzip by default even unasked, and the raw
          // bytes would decode to binary garbage below.
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            done(null);
            return;
          }
          const next = new URL(res.headers.location, target).toString();
          void fetchBytes(next, timeoutMs, redirectsLeft - 1).then(done);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_PAGE_BYTES) chunks.push(chunk);
          else res.resume();
        });
        res.on("end", () =>
          done({
            bytes: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
        res.on("error", () => done(null));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });
}

export async function searchWeb(query: string, opts: WebSearchOptions = {}): Promise<WebSearchHit[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const engines: Array<{ url: string; parse: (html: string) => WebSearchHit[] }> = [
    {
      // cn.bing.com WITHOUT `ensearch`: probed 2026-10-23 — `www.bing.com`
      // redirects here anyway, and adding `ensearch=0` makes every query
      // return the same six brand-card results (vendor homepage, Baidu
      // Baike, app download, GitHub org, App Store, Hugging Face) regardless
      // of the query text, while the bare endpoint returns genuinely
      // query-dependent results ("deepseek api pricing" → the official
      // pricing page on the first hit).
      url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
      parse: (html) => parseBingResults(html, limit, snippetChars),
    },
    {
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parse: (html) => parseDdgResults(html, limit, snippetChars),
    },
  ];
  for (const engine of engines) {
    const html = await fetchText(engine.url, timeoutMs);
    if (!html) continue;
    const hits = engine.parse(html);
    if (hits.length > 0) return hits;
  }
  return [];
}
