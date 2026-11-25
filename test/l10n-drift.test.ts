import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - JS 脚本无声明文件，测试配置未包含 scripts 的 .d.ts
import { buildArtifacts, readSource } from "../scripts/gen-l10n.mjs";

type Value = string | { host: string; webview: string };

const root = path.resolve(import.meta.dirname, "..");
const wording =
  "Use only letters, digits, - and _ in the name, and start it with a letter or digit";

/** Extract the generated inline dictionary without importing the TS module. */
function inlineWebviewDict(i18nText: string): Record<string, string> {
  const start = i18nText.indexOf("const en: Record<string, string> = {");
  const open = i18nText.indexOf("{", start);
  const close = i18nText.indexOf("\n};", open);
  if (start < 0 || close < 0) throw new Error("generated i18n.ts has no `en` dictionary");
  return new Function(`return ${i18nText.slice(open, close + 2)}`)() as Record<string, string>;
}

describe("l10n single source", () => {
  it("regenerates both committed artifacts byte-for-byte", () => {
    const { bundleText, i18nText } = buildArtifacts(readSource());
    expect(bundleText).toBe(
      readFileSync(path.join(root, "l10n/bundle.l10n.en.json"), "utf8"),
    );
    expect(i18nText).toBe(readFileSync(path.join(root, "webview/src/i18n.ts"), "utf8"));
  });

  it("resolves the 5 historical conflicts to their agreed English text", () => {
    const source = readSource() as Record<string, Value>;
    const perTarget: Record<string, { host: string; webview: string }> = {
      生成中: { host: "generating", webview: "Generating" },
      正在压缩: { host: "compressing", webview: "Compressing" },
      出错: { host: "error", webview: "Error" },
      已停止: { host: "stopped", webview: "Stopped" },
    };
    for (const [key, expected] of Object.entries(perTarget)) {
      expect(source[key]).toEqual(expected);
    }
    expect(source["名称只能用字母、数字、- 和 _，并且要以字母或数字开头"]).toBe(wording);

    const { bundleText, i18nText } = buildArtifacts(source) as {
      bundleText: string;
      i18nText: string;
    };
    const host = JSON.parse(bundleText) as Record<string, string>;
    const webview = inlineWebviewDict(i18nText);
    expect(host["生成中"]).toBe("generating");
    expect(webview["生成中"]).toBe("Generating");
    expect(host["已停止"]).toBe("stopped");
    expect(webview["已停止"]).toBe("Stopped");
    expect(host["名称只能用字母、数字、- 和 _，并且要以字母或数字开头"]).toBe(wording);
    expect(webview["名称只能用字母、数字、- 和 _，并且要以字母或数字开头"]).toBe(wording);
  });

  it("allows differing host/webview English only for declared per-target keys", () => {
    const source = readSource() as Record<string, Value>;
    const overrides = new Set(
      Object.entries(source)
        .filter(([, value]) => typeof value !== "string")
        .map(([key]) => key),
    );
    expect([...overrides].sort()).toEqual(
      ["生成中", "正在压缩", "出错", "已停止"].sort(),
    );

    const { bundleText, i18nText } = buildArtifacts(source) as {
      bundleText: string;
      i18nText: string;
    };
    const host = JSON.parse(bundleText) as Record<string, string>;
    const webview = inlineWebviewDict(i18nText);
    expect(Object.keys(host)).toEqual(Object.keys(source));
    expect(Object.keys(webview)).toEqual(Object.keys(source));
    for (const key of Object.keys(host)) {
      if (host[key] !== webview[key]) expect(overrides.has(key)).toBe(true);
    }
  });
});