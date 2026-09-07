/**
 * Read the topmost section of CHANGELOG.md and emit GitHub Actions outputs.
 *
 * Output:
 *   version — the release version (first "## [x.y.z]" heading)
 *   notes   — the body of that section (release summary)
 *
 * Exits non-zero when no version entry is found, failing the pipeline.
 */
import { readFileSync, appendFileSync } from "node:fs";

const text = readFileSync("CHANGELOG.md", "utf8");
// Index-based slicing: a multiline lookahead with `$` would stop at the first
// line under the `m` flag, truncating multi-line notes.
const heading = /^##\s+\[?(\d+\.\d+\.\d+)\]?[^\n]*\n\n?/m.exec(text);
if (!heading) {
  console.error("CHANGELOG.md: 未找到版本条目（需要 '## [x.y.z] - 日期' 标题）");
  process.exit(1);
}
const version = heading[1];
const bodyStart = heading.index + heading[0].length;
const nextHeading = text.indexOf("\n## ", bodyStart);
const bodyEnd = nextHeading === -1 ? text.length : nextHeading;
const notes = text.slice(bodyStart, bodyEnd).trim();
if (!notes) {
  console.error(`CHANGELOG.md: 版本 ${version} 没有更新摘要`);
  process.exit(1);
}

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `version=${version}\n`);
  // Multiline output via heredoc delimiter.
  appendFileSync(out, `notes<<CHANGELOG_NOTES_EOF\n${notes}\nCHANGELOG_NOTES_EOF\n`);
}
console.log(`version=${version}`);
console.log(`notes: ${notes.split("\n").length} line(s)`);
