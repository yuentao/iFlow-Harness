import { describe, it, expect } from "vitest";
import { decodeHtmlEntities, parseBingResults, parseDdgResults } from "../src/acp/web-search.js";

/** Trimmed shape of a Bing result page (the live layout is not pinned here —
 * only the block structure the parser keys on). */
const bingHtml = `
<html><body><ol>
<li class="b_algo">
  <h2><a href="https://example.test/glm-4-6" target="_blank"><strong>GLM-4.6</strong> context window</a></h2>
  <div class="b_caption"><p>GLM-4.6 offers a 200000 token context window and costs 0.6 / 2.4 per 1M tokens.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://example.test/deepseek">DeepSeek V3.2 pricing</a></h2>
  <div class="b_caption"><p>128K context, cheap.</p></div>
</li>
</ol></body></html>`;

const ddgHtml = `
<div class="result results_links results_links_deep web-result">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https://example.test/x">Example &amp; result</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https://example.test/x">Snippet text here</a>
</div>`;

describe("parseBingResults", () => {
  it("reads title, url and snippet per result block", () => {
    const hits = parseBingResults(bingHtml);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "GLM-4.6 context window",
      url: "https://example.test/glm-4-6",
      snippet: "GLM-4.6 offers a 200000 token context window and costs 0.6 / 2.4 per 1M tokens.",
    });
    expect(hits[1]?.url).toBe("https://example.test/deepseek");
  });

  it("honours the limit and the snippet cap", () => {
    expect(parseBingResults(bingHtml, 1)).toHaveLength(1);
    const capped = parseBingResults(bingHtml, 2, 10);
    expect(capped[0]?.snippet).toHaveLength(10);
  });

  it("returns nothing for a page without result blocks", () => {
    expect(parseBingResults("<html><body>no results</body></html>")).toEqual([]);
  });
});

describe("parseDdgResults", () => {
  it("reads the title link and snippet, un-escaping entities", () => {
    const hits = parseDdgResults(ddgHtml);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Example & result");
    expect(hits[0]?.snippet).toBe("Snippet text here");
    expect(hits[0]?.url).toContain("example.test/x");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the entities a result page actually contains", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;")).toBe('a & b <c> "d" \'e\'');
    expect(decodeHtmlEntities("&#x2F;slash")).toBe("/slash");
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });
});
