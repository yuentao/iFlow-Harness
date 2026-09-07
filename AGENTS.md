# AGENTS.md — iFlow Harness 开发上下文

> 本文件供 AI 代理（与新人）快速获得本仓库的开发上下文。默认交流语言为中文。

## 项目概述

**iFlow Harness（心流·驭光）** 是 iFlow CLI 的 VSCode 图形智能体前端：通过 **ACP（Agent Client Protocol，NDJSON over stdio 的 LSP 风格 JSON-RPC）** 驱动本地 `iflow --experimental-acp` 进程，在侧边栏 WebView 中提供完整的 agent 工作流——流式对话、工具调用可视化、Diff 审批与 Revert、会话管理、API Profile 管理、@文件补全、图片输入、状态栏、Chat Participant（`@iflow`）。

里程碑 M0（协议验证）→ M6（发布打包）已全部完成。

### 技术栈

- **Host 侧**：TypeScript（Node16 ESM 源码，esbuild 打包为 `dist/extension.cjs` CJS，`external: ["vscode"]`）
- **WebView**：React 19 + Vite + zustand（构建产物 `webview/dist/`，宿主读取 `index.html` 并重写资源 URI + 注入 CSP/nonce）
- **测试**：Vitest（5 个测试文件，60 用例，含 mock ACP agent 集成测试）
- **打包**：@vscode/vsce（`--no-dependencies`，依赖已全量 bundle）

## 目录结构

```
src/
  extension.ts          # 扩展入口：命令注册、chat participant、选区命令
  panel/
    panel.ts            # ChatPanel（webview provider、状态栏、审批、diff/revert、
                        #   profile 切换、会话恢复、openImage 临时文件预览）
    store.ts            # SessionStore：持有 SessionState，节流推送 snapshot（含 locale）
  acp/
    jsonrpc.ts          # NDJSON JSON-RPC 帧解析（纯函数）
    protocol.ts         # ACP wire 类型（与 CLI 0.5.19 实测对齐，iFlow 扩展有注释标记）
    client.ts           # AcpClient：子进程管理、握手、prompt 流、权限请求回调
    cli-locator.ts      # 跨平台 CLI 定位（env → where/which shim → npm root → 常见路径）
    models-query.ts     # 直连 endpoint /models 查询（绕过 VSCode 代理补丁）
    auth.ts             # openai-compatible 凭据（SecretStorage）读写
shared/
  messages.ts           # Host↔Webview 消息类型 + SessionState/UI 类型（双方共用）
  session-state.ts      # 纯函数 reducer（applySessionUpdate / beginUserPrompt 等），
                        #   host 与 vitest 共用；webview 不跑协议逻辑
webview/
  src/App.tsx           # 顶栏（会话/Profile/模式/模型下拉）+ 布局
  src/i18n.ts           # webview 字典：中文为源语言，en 表翻译；locale 来自 snapshot
  src/store.ts          # zustand store + mock host（脱离 VSCode 可在浏览器调试）
  src/components/       # MessageList / Composer / ApprovalCard / AuthCard / DiffView / Markdown
l10n/                  # bundle.l10n.en.json（host 中文源 → 英文）
package.nls*.json      # manifest NLS（默认英文 + zh-cn）
test/                  # vitest：jsonrpc/acp-client/auth/models-query/session-state
                       #   + mock-acp-agent.mjs（可编程 mock）+ vscode-stub.ts
scripts/harness.mjs    # M0 手动 harness：驱动真实 CLI 全流程（--record 录制 wire 日志）
docs/                  # 规划方案与里程碑（历史记录）
```

## 常用命令

```bash
npm run build      # tsc 产出类型 + esbuild 打包 host + vite 构建 webview（= 完整构建）
npm run typecheck  # host 侧 tsc --noEmit（webview 另有独立 tsconfig：webview/ 内 npx tsc --noEmit）
npm test           # vitest run（全量 60 用例，不依赖真实 CLI / API）
npm run harness    # 驱动真实 CLI：握手 → newSession → prompt → 流式输出
                   #   （--record 录制 wire 日志到 test/fixtures；IFLOW_CLI_ENTRY 可指定 entry.js）
npm run package    # build + vsce package --no-dependencies → iflow-harness-<version>.vsix
npm run webview:dev  # vite watch 构建 webview
```

调试：F5（`.vscode/launch.json`）启动 Extension Development Host。macOS 上无 python/curl 部分版本，起本地静态服务器请用 node。

## 架构要点（改动前必读）

1. **状态单向流**：协议状态只存在于 host（`SessionStore`）；webview 是投影，只渲染 snapshot、发 `WebviewToHost` 消息。不要把协议逻辑搬进 webview。
2. **reducer 纯函数**：会话状态变更一律走 `shared/session-state.ts` 的纯函数（host 与单测共用），`panel/store.ts` 只做节流与推送。
3. **模型列表只信 endpoint 实时查询**（用户明确要求）：`panel.ts#queryLiveModels` → `models-query.ts`，查询失败返回空列表，**绝不回退** CLI `_meta` 硬编码目录。
4. **模型查询必须绕过 VSCode 的 fetch 代理补丁**：扩展宿主的全局 `fetch` 被 vscode-proxy-agent 接管，系统代理为 SOCKS/无协议时会抛 `Invalid URL protocol`。`models-query.ts` 因此用 `node:https/http` 原生直连——不要改回全局 fetch。
5. **webview iframe 沙箱没有 `allow-popups`**：任何"打开外部内容"都要经 host（如图片预览走 `openImage` 消息 → host 写临时文件 → `vscode.open`），禁止 `window.open`。
6. **新增 UI 字符串必须走 i18n**：
   - host：`vscode.l10n.t("中文源串")`，英文翻译加进 `l10n/bundle.l10n.en.json`（key 必须与源串完全一致，`{0}` 占位）
   - manifest：`package.json` 用 `%key%`，`package.nls.json`（en）+ `package.nls.zh-cn.json`（zh）
   - webview：`import { t } from "../i18n"`，英文加进 `webview/src/i18n.ts` 的 `en` 表；locale 由 host 随 snapshot 下发（`vscode.env.language`），mock host 固定 zh-cn
   - 产品名：中文界面「心流·驭光」，英文界面 "iFlow Harness"，不要中英并排
7. **vitest 的 vscode 依赖**：`shared/session-state.ts` 运行时 import `vscode.l10n`，由 `vitest.config.ts` alias 到 `test/vscode-stub.ts`（恒等翻译）。新的 shared 模块如需 vscode API 同样走这个 stub。
8. **ACP 协议是 experimental**：wire 类型以 `scripts/harness.mjs --record` 的实测为准；iFlow 私有扩展在 `protocol.ts` 中有注释标记。
9. **webview 调试**：`webview/dist` 用 node 起静态服务器即可在浏览器跑 mock host（无需 VSCode），frontend 验证可用此路径。

## 测试约定

- 单测在 `test/*.test.ts`，mock agent（`test/mock-acp-agent.mjs`）通过 `ACP_MOCK_MODE` 脚本化事件序列（慢速流/崩溃/权限拒绝）。
- reducer 纯函数直接断言状态变更；wire 层用 fixture 回放。
- 改动后跑 `npm run typecheck && npm test && npm run build`；涉及 webview 时另跑 `cd webview && npx tsc --noEmit`。
- UI 交互改动应做浏览器验证（node 静态服务器 + Playwright/浏览器工具）。

## 提交约定

提交信息为中文一句话，动词开头、说明"为什么/做了什么"：

```
新增 会话持久化与历史会话切换恢复
修复 模型列表查询在系统代理环境下失败
优化 扩展品牌命名为 iFlow Harness（心流·驭光）
文档 VSCode 扩展规划方案
```

一次提交一个完整主题；`package-lock.json` 与 `package.json` 同步提交；`*.vsix`、`dist/`、`webview/dist/` 不入库（.gitignore 已覆盖）。

## 环境备注（macOS 开发机）

- 不可用：`rg`、`gh`、`wget`、`ffmpeg`；`python3` 时有时无（起静态服务用 node）
- CLI 通过 nvmd 管理的 Node 运行；`cli-locator.ts` 已覆盖 macOS（symlink → realpath 到 entry.js）
