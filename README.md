# iFlow Harness for VSCode

**心流·驭光** — iFlow CLI 的 VSCode 图形前端：通过 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动本地 iFlow CLI，在编辑器标签页里完成对话、工具审批、代码评审与文件修改的完整 agent 工作流。

![面板总览](docs/images/panel-light.png)

## 亮点

- **开箱即用**：扩展内置定制裁剪版 iFlow CLI（`vendor/iflow-cli`），未安装 CLI 的机器装上就能用（VSIX 约 20MB）——内置 fork 是面板唯一的执行体，不探测、不使用本机安装的 CLI，定制 loader 补丁保证 agent 行为一致
- **模型兼容增强**：内置 CLI 外挂一组定制 Mod/loader——按模型配置输出 token 上限、真实上下文窗口计算、Kimi 采样参数规范化、多模态视觉路由、思考参数规则、MCP 后台发现与跨会话连接池、slash 压缩落盘、按 agentId 停止子代理、权威上下文占用上报、API 配置隔离（面板凭据不泄漏进共享 settings.json）；默认规则随扩展分发、连接前自动种到 `~/.iflow/`（永不覆盖已有配置），编辑 JSON 即可自定义模型行为，Mod 可用 [iFlow-Mod-Builder](https://github.com/yuentao/iFlow-Mod-Builder) 图形化打包
- **完整 agent 工作流**：流式对话、工具审批、行号 Diff（含逐块 hunk 保留/回退）、Plan 计划确认卡（可编辑重规划）、交互式提问卡、子代理进度卡片、消息排队与打断发送（Steer）
- **可回退的长任务**：轮级 Checkpoint 影子快照支持「回滚到此轮」（文件 / 对话 / 两者），编辑旧消息重发自动先恢复该轮快照；速率限制递增退避自动重试、上下文溢出自动压缩并重发——限流与长上下文都不再中断任务
- **细粒度自动审批**：Cline 式审批策略规则表（工具类别 / 路径 glob / 命令首词 / 工具名维度），破坏性命令硬否决永不自动放行；审批卡一键「始终允许」即生成规则
- **凭据与审批安全**：API Key 只存 VSCode SecretStorage（不落盘明文、不打日志），面板配置与终端 CLI 隔离；审批默认拒绝、5 分钟超时自动拒答；Webview 走 nonce CSP + DOMPurify 净化
- **零等待热切换**：切换 API Profile 热重认证免重启 CLI（可选保留当前会话原地重载）；`iflow.warmStart` 窗口打开即后台预热，首次打开面板无需等待
- **精致界面**：Win12 风格亚克力材质、深浅色主题跟随编辑器、可调极光背景、Mermaid 图表渲染、超长会话离屏渲染流畅不卡

## 功能

**对话与生成**

- 流式对话：思考过程折叠、Markdown 渲染（代码块语法高亮 + Mermaid 图表）、一键中断
- 消息排队与打断发送：生成中继续输入即入队（上限 10 条），队列条支持编辑 / 删除 / 上下移 / 立即发送（打断当前轮）；本轮失败自动暂停队列
- 子代理卡片：按类型着色、步骤进度、嵌套子代理、token 与耗时统计
- 提问卡：agent 发起 `ask_user_question` 时渲染交互卡，支持单选 / 多选 / 自由文本，选项自带说明；超时按「未回答」自动继续
- Plan 模式审批：agent 提交计划时弹出确认卡，可在卡内编辑计划并「重新规划」回传修订文本
- 消息操作：重新生成、复制、编辑旧消息重发（自动先恢复该轮 Checkpoint 再截断重发）
- 用量与成本：会话累计 token 消耗（末次请求上下文为权威值，其余真实 BPE 估算），输入 / 输出分列、上下文占用百分比与成本估算实时刷新
- 自动恢复：速率限制递增退避重试，上下文溢出自动压缩并重发原 prompt，等待过程以倒计时 toast 呈现
- 会话管理：历史搜索 / 切换 / 置顶 / 归档 / 删除（两步确认）、重启后自动恢复、AI 自动标题
- 提示音与系统通知：完成 / 失败音效（Web Audio 合成），面板不可见时按策略发 OS 通知

![子代理卡片](docs/images/subagent-card.png)

**工具与审批**

![审批卡片](docs/images/approval-dark.png)

- 工具调用卡片：类型、状态、位置、输出结构化展示
- 行号 Diff 视图：每个 hunk 可单独保留 / 回退，提交后按保留块确定性写盘；支持一键整文件 Revert 与 VSCode 原生并排对比（Open Diff）
- 审批流：请求卡片（允许一次 / 始终允许 / 拒绝），5 分钟超时自动拒绝并带存活看门狗解锁输入
- 审批策略规则表：设置页可视化编辑规则并预览命中，allow 规则对破坏性命令（`rm` / `git push` 等）硬否决降级为询问卡

![逐块 Diff 与 hunk 开关](docs/images/diff-hunk.png)

![审批策略规则表](docs/images/approval-policy.png)

**Checkpoint 与工作区回退**

- 每轮对话前把工作区快照到独立的影子 git 仓库（绝不触碰你自己的 `.git`，非 git 目录同样可用）
- 用户气泡「回滚到此轮」三档恢复：仅文件 / 仅对话 / 文件+对话；编辑器未保存修改与整仓覆盖双重复确认
- 快照容量可治理：文件数 / 单文件大小 / 轮数 / 总体积上限，超限自动关闭或清理

**上下文与输入**

- `@` 上下文源：`@文件` 工作区模糊搜索、`@/` 文件夹搜索、`@problems` 注入工作区诊断、`@git` 注入 status+diff、`@url:` 抓取网页正文
- 选区上下文：编辑器右键 Ask iFlow（直接提问）/ 加入 iFlow 上下文（生成代码上下文卡，发送时前置到 prompt，可移除、多卡并存）
- 附件：粘贴 / 拖拽 / OS 文件选择器多路径添加，图片缩略图回显并可预览（>5MB 图片自动降级为文件附件）
- 提示词增强：一键将草稿改写为更清晰的请求
- Chat Participant：VSCode Chat 中 `@iflow` 纯文本通道，富交互仍在面板内

![提问卡（单选/多选）](docs/images/question-card.png)

![Plan 计划确认卡](docs/images/plan-card.png)

**会话与配置**

- 会话导出：Markdown / JSON / 脱敏 ACP 通信日志（命令面板）
- API 配置：OpenAI 兼容凭据存 SecretStorage，多 Profile 热重认证免重启 CLI；切换时可选择保留当前会话原地重载
- MCP 服务器管理：设置页直接查看 / 增删改 `~/.iflow/settings.json` 的 mcpServers（JSON 编辑 + 校验 + 原子写回），一键热重启生效

![设置弹窗](docs/images/settings-modal.png)

- 模型列表实时查询当前 endpoint 的 `/models`，下拉模糊搜索；模型下架时显式回退并提示，绝不静默用错模型
- 主题：深 / 浅色切换，默认跟随编辑器主题；Focus 视图只看对话
- 状态栏：agent 状态（连接中 / 就绪 / 生成中 / 等待审批 / 出错）与当前模型一目了然，点击打开面板

![深色主题](docs/images/panel-dark.png)

## 前置要求

- VSCode `^1.90.0`
- 无需单独安装 iFlow CLI：扩展内置定制 fork（`vendor/iflow-cli`），它是面板唯一的执行体——本机安装的 CLI 不会被探测或使用
- 可用的 OpenAI 兼容 API 端点（baseUrl + apiKey + modelName）

## 扩展设置

**面板行为**

| 设置项 | 说明 |
|---|---|
| `iflow.defaultMode` | 新会话默认权限模式：`smart` / `yolo` / `default` / `plan` |
| `iflow.warmStart` | 窗口打开时后台预热 CLI，首次打开面板无需等待（默认开启，每窗口约 100MB 内存） |
| `iflow.autoOpenPanel` | VSCode 启动时自动打开聊天面板 |
| `iflow.restoreLastSession` | 面板启动时恢复上次使用的会话（无可恢复记录自动回退新建） |
| `iflow.autoTitle` | 会话首轮完成后生成 AI 简短标题 |
| `iflow.soundFeedback` | 对话完成 / 失败时播放提示音（默认开启） |
| `iflow.osNotifications` | 面板不可见时的系统通知：`off` / `approvals`（默认）/ `all` |
| `iflow.auroraIntensity` | 背景极光光斑强度（0–100，默认 35） |

**Checkpoint（轮级快照与回退）**

| 设置项 | 说明 |
|---|---|
| `iflow.checkpoints` | 每轮对话前快照工作区到影子 git 仓库（默认开启） |
| `iflow.checkpointMaxFiles` | 工作区文件数超过该上限时关闭快照（默认 50000） |
| `iflow.checkpointMaxFileMB` | 跳过大于该尺寸（MB）的文件，0 = 不限 |
| `iflow.checkpointDir` | 快照仓库自定义根目录，留空用默认存储位置 |
| `iflow.checkpointMaxTurns` | 每会话最多保留的快照轮数，0 = 不限 |
| `iflow.checkpointMaxSizeMB` | 快照仓库总体积上限（MB），0 = 不限 |

**用量与 CLI**

| 设置项 | 说明 |
|---|---|
| `iflow.contextWindowOverrides` | 模型上下文窗口覆写，每行 `模型名=token数` |
| `iflow.costTable` | 成本估算单价表，每行 `模型名=输入价,输出价`（USD/百万 token） |
| `iflow.nodePath` | 启动 CLI 使用的自定义 Node.js 可执行文件 |
| `iflow.language` / `iflow.approvalMode` | 写入 `~/.iflow/settings.json` 的 CLI 界面语言 / 默认审批模式（留空不干预），重启 CLI 后生效 |

## 使用

1. 安装扩展后，点击状态栏右侧的 iFlow 状态项打开面板（也可用编辑器标签栏图标或命令面板 `iFlow: 打开聊天面板`）；面板是独立编辑器标签页，宽度可自由拖拽
2. 首次使用按提示配置 API 凭据（OpenAI 兼容地址 + Key + 模型名），或切换 CLI 已有的配置
3. 输入消息开始对话；生成中可以继续输入排队、「立即发送」打断当前轮；工具调用会在面板中请求审批，Diff 卡片支持逐块保留/回退与 Open Diff；用户气泡可回滚到此轮、编辑重发
4. 输入框 `@` 触发文件 / 文件夹 / 诊断 / git / 网页上下文；Chat 视图中 `@iflow <问题>` 走纯文本通道快速提问

> **安全与信任边界**：iFlow 的执行类工具（`run_shell_command` 等）运行在本机真实 shell 中，可以读写会话目录之外的任意路径——审批卡是「告知 + 同意」，不是沙箱隔离。请在信任的项目中使用；处理不信任的代码库时，建议在容器 / 虚拟机中运行 VSCode。扩展侧的 `fs/read_text_file` / `fs/write_text_file` 回调已做目录边界校验（允许范围 = 会话目录 + 所有已打开工作区根；`..` 上逃与指向范围外的绝对路径会被拒绝），但这只封住了协议层通道，不替代操作系统级隔离。

## 开发

```bash
npm install
npm run build         # icon + tsc 类型产出 + esbuild 打包 host + vite 构建 webview
npm run typecheck     # host 与 webview 双侧类型检查
npm test              # vitest（30 文件 / 557 用例，含 mock ACP agent 集成测试，不依赖真实 CLI/API）
npm run harness       # 驱动真实 CLI 走 ACP 全流程（--record 录制 wire 日志、--probe 探方法行为）
npm run vendor:cli    # 拉取并裁剪 iFlow CLI 到 vendor/（package 时自动执行）
npm run defaults:sync # 同步本机 ~/.iflow/ 默认规则到 scripts/iflow-defaults/（发布前）
npm run package       # vendor:cli + build + vsce 打包 → .vsix（含内置 CLI）
```

- F5 调试：`.vscode/launch.json` 提供扩展调试配置（Extension Development Host）；启动前先 `npm run build`，且本地至少跑过一次 `npm run vendor:cli`（`main` 指向 `./dist/extension.cjs`，内置 CLI 缺失扩展会直接报错）
- 浏览器调试 webview：`npx vite build webview` 后用任意静态服务器打开 `webview/dist`（内置 mock host，含审批 / 提问 / Plan 卡与用量演示，无需 VSCode）
- webview 增量构建：`npm run webview:dev`；webview 侧类型检查：`cd webview && npx tsc --noEmit`
- 新增 UI 文案请走 i18n：host 用 `vscode.l10n.t`（英文加 `l10n/bundle.l10n.en.json`），manifest 用 `%key%`（补 `package.nls*.json`），webview 用 `src/i18n.ts` 字典

## 发布

`CHANGELOG.md` 是版本的唯一来源：CI 从顶部 `## [x.y.z] - date` 标题读取版本号写入 `package.json`，其下条目作为发布摘要。新增版本时**同时更新 CHANGELOG 与 `package.json` 的 version 到同一版本号**再提交，否则 CI 会把版本覆写回 CHANGELOG 里的旧号。

- `ci.yml`：release 分支的 push 与 PR 触发，三平台矩阵（ubuntu / windows / macos）跑 typecheck → test → build
- `release.yml`：仅 release 分支（或手动触发）：读 CHANGELOG 版本与摘要写入 `package.json` → `npm run package`（内置 CLI 一起打进 `.vsix`）→ 打 tag `v*` 建 GitHub release 并附 `.vsix`（用原生 `gh` CLI 三态幂等处理：已存在 draft 则发布、已发布仅刷新 asset、不存在则新建）

## 架构

三层单向数据流：`webview/`（React 投影）← 节流快照 / 增量 blockPatch ← `shared/`（纯 reducer）← ACP 事件 ← `src/`（Extension Host）← NDJSON ← iFlow CLI 子进程。状态只存在于 Extension Host，WebView 只渲染快照。

架构细节、开发约定与已知陷阱详见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)