# iFlow Harness for VSCode

**心流·驭光** — iFlow CLI 的 VSCode 图形前端：通过 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动本地 iFlow CLI，在侧边栏完成对话、工具审批、代码评审与文件修改的完整 agent 工作流。

## 功能

- **流式对话**：思考过程折叠、Markdown 渲染、中断/停止
- **工具可视化**：工具调用卡片、结构化 Diff、一键 Revert、VSCode 原生 Diff 视图
- **审批流**：default/smart 模式下的权限请求卡片（允许一次/始终允许/拒绝）
- **@文件补全**：输入框 `@` 触发工作区文件模糊搜索
- **选区上下文**：编辑器右键 Ask iFlow / Add to iFlow Context
- **图片输入**：粘贴/拖入图片作为附件，对话中缩略图回显
- **会话管理**：多会话切换、重启 VSCode 后恢复上次会话
- **API 配置**：OpenAI 兼容凭据（SecretStorage 存储），多 Profile 切换，模型列表实时查询
- **Chat Participant**：VSCode Chat 中 `@iflow` 纯文本通道
- **状态栏**：agent 状态（就绪/生成中/等待审批/错误）与当前模型一目了然

## 前置要求

- VSCode ^1.90.0
- 已安装 [iFlow CLI](https://www.npmjs.com/package/@iflow-ai/iflow-cli)（扩展会自动探测；也可在设置中指定 `iflow.cliPath`）

## 使用

1. 安装扩展后打开侧边栏 iFlow Harness 面板
2. 首次使用按提示配置 API 凭据（或使用 CLI 已有配置）
3. 输入消息开始对话；工具调用会在面板中请求审批

## 开发

```bash
npm install
npm run build     # host bundle + webview
npm test          # vitest
npm run package   # 产出 .vsix
```

## License

[MIT](LICENSE)
