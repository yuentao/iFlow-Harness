# iFlow Harness for VSCode

**心流·驭光** — iFlow CLI 的 VSCode 图形前端：通过 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动本地 iFlow CLI，在侧边栏完成对话、工具审批、代码评审与文件修改的完整 agent 工作流。

界面随 VSCode 显示语言自动切换：中文界面显示「心流·驭光」，英文界面显示 "iFlow Harness"。

## 功能

- **流式对话**：思考过程折叠、Markdown 渲染、中断/停止
- **工具可视化**：工具调用卡片、结构化 Diff、一键 Revert、VSCode 原生 Diff 视图（Open Diff）
- **审批流**：default/smart 等权限模式下的请求卡片（允许一次/始终允许/拒绝），超时自动拒绝
- **@文件补全**：输入框 `@` 触发工作区文件模糊搜索，键盘选择插入
- **选区上下文**：编辑器右键 Ask iFlow（直接提问）/ Add to iFlow Context（注入输入框待编辑）
- **图片输入**：粘贴/拖入图片作为附件，对话中缩略图回显，点击在 VSCode 内置预览打开
- **会话管理**：多会话切换、重启 VSCode 后恢复上次会话、无标题会话自动以首条消息命名
- **API 配置**：OpenAI 兼容凭据（SecretStorage 加密存储，不落盘明文），多 Profile 切换自动重认证，模型列表实时查询当前 endpoint（不使用硬编码目录）
- **Chat Participant**：VSCode Chat 中 `@iflow` 纯文本通道，审批等富交互仍在侧边栏
- **状态栏**：agent 状态（就绪/生成中/等待审批/错误）与当前模型一目了然，点击聚焦面板
- **中英双语**：UI 随 VSCode 显示语言自动切换（目前支持 zh-cn / en）

## 前置要求

- VSCode ^1.90.0
- 已安装 [iFlow CLI](https://www.npmjs.com/package/@iflow-ai/iflow-cli)（扩展会自动探测 PATH 与常见安装位置；也可在设置中指定）

## 扩展设置

| 设置项 | 说明 |
|---|---|
| `iflow.cliPath` | iFlow CLI bundle `entry.js` 路径（留空自动探测） |
| `iflow.defaultMode` | 新会话默认权限模式：`smart` / `yolo` / `default` / `plan` |
| `iflow.nodePath` | 启动 CLI 使用的自定义 Node.js 可执行文件 |
| `iflow.idleTimeoutMinutes` | CLI 进程空闲多少分钟后回收 |

## 使用

1. 安装扩展后点击活动栏「心流·驭光」图标打开面板（状态栏也会显示连接状态）
2. 首次使用按提示配置 API 凭据（OpenAI 兼容地址 + Key + 模型名），或直接切换 CLI 已有的配置
3. 输入消息开始对话；工具调用会在面板中请求审批，diff 卡片支持 Open Diff 与 Revert
4. Chat 视图中 `@iflow <问题>` 可走纯文本通道快速提问

## 开发

```bash
npm install
npm run build      # tsc 类型产出 + esbuild 打包 host + vite 构建 webview
npm run typecheck  # host 侧类型检查
npm test           # vitest（60 用例，含 mock ACP agent 集成测试，不依赖真实 CLI/API）
npm run harness    # 驱动真实 CLI 走 ACP 全流程（--record 录制 wire 日志）
npm run package    # 产出 .vsix
```

- webview 侧类型检查：`cd webview && npx tsc --noEmit`
- 浏览器调试 webview：`webview/dist` 用任意静态服务器打开即可（内置 mock host）
- 新增 UI 文案请走 i18n：host 用 `vscode.l10n.t`（英文加 `l10n/bundle.l10n.en.json`），manifest 用 `%key%`（补 `package.nls*.json`），webview 用 `src/i18n.ts` 字典

架构与约定详见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)