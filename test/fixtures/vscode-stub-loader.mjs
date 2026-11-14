/**
 * Node 侧的 "vscode" 模块替身 —— 同时充当 ESM 解析钩子。
 *
 * 背景：`shared/session-state.ts` 只用到 `vscode.l10n.t`（用户可见文案的
 * 本地化），因此 `dist/src/panel/super-agent.js` 这条链在纯 Node 下会因
 * 解析不到 "vscode" 而失败。仓库里的 vitest 用 `test/vscode-stub.ts` 别名解
 * 决同样的问题；脚本环境没有别名机制，就用一个 resolve 钩子把 "vscode"
 * 指向本文件 —— 本文件同时导出 `l10n`，一次解决两件事。
 *
 * 用法（脚本内）：
 *   import { register } from "node:module";
 *   register(new URL("./vscode-stub-loader.mjs", import.meta.url).href);
 *   const { SuperAgentManager } = await import("../../dist/src/panel/super-agent.js");
 */

/** ESM 解析钩子：把裸标识符 "vscode" 导向本文件。 */
export function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { url: new URL("./vscode-stub-loader.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

/**
 * 恒等翻译 + `{0}` 索引替换 —— 与 `test/vscode-stub.ts` 的 l10n 实现同源
 * （源语言是中文，消息表即恒等）。
 */
export const l10n = {
  t: (message, ...args) =>
    args.length === 0
      ? message
      : message.replace(/\{(\d+)\}/g, (m, i) => {
          const v = args[Number(i)];
          return v === undefined ? m : String(v);
        }),
};
