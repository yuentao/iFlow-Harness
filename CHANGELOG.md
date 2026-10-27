# 更新日志 / Changelog

本文件是版本的唯一来源（single source of truth）：CI 从 `## [x.y.z]` 标题读取
版本号写入 `package.json`，其下的条目作为该版本的发布摘要。

## [2.1.0] - 2026-10-27

- 新增 `/skill <name>` 技能触发：CLI 的 Skill 工具是模型调用（工具描述里带 `<available_skills>`），且 `shouldConfirmExecute` 会先要一次确认——ACP 下变成 `session/request_permission`，默认审批策略是拒绝，所以「让模型去调 Skill 工具」不能保证真跑起来；CLI 自带的 `/skills` 又是交互态命令，ACP 模式只会回「requires interactive mode」。因此由宿主解析并注入：`shared/skills.ts` 纯逻辑（`parseSkillInvocation` 解析 `/skill <name> [指令]`、`buildSkillPrompt` 拼 agent 侧载荷）+ `src/skills/service.ts` 按名解析技能文件（复用 `parseFrontmatter`，全局 `~/.iflow/skills` 先扫、项目 `<cwd>/.iflow/skills` 后扫、同名全局胜），注入内容与 CLI `buildUserMessageContent` 同构（Base directory + SKILL.md 正文 + 用户指令，正文逐字搬运不改写）；`sendPrompt`/`regenerate` 两条路径都在 `toAgentPromptText` 之前拦截；技能不存在时不拦发送（只 toast 提示并按普通文本发出，绝不吞用户文本）；Composer 斜杠弹层为每个技能合成一条 `/skill <name>` 条目（输入 `/pdf` 这类裸名也命中），选中后填入 `/skill <name> `
- 新增 回合末超时与自动压缩阈值可配置：`iflow.memoryExtractTimeoutSeconds`（默认 90）/`iflow.nextStepTimeoutSeconds`（默认 25）/`iflow.compressTimeoutSeconds`（默认 0 = 不限制）/`iflow.autoCompressThresholdPercent`（默认 95，范围 50–100），全部用户级、Settings Sync 可携带；`src/acp/complete.ts` 修掉 `setTimeout(fn, 0)` 把「不限制」变成立即超时的缺陷（0 时不装定时器）；`jsonrpc.ts` 新增 `isRequestTimeoutError()` 识别本地看门狗拒绝；`followupCeiling` 每任务上限读配置、任一任务为 0 → 整个合并请求无墙钟上限且关闭 idle 看门狗、任务上限 > 0 时 idle = min(该任务默认 idle, 上限/2)；`promptWithRetry` 压缩轮走 per-call 超时、超时先 `client.cancel` 再抛 `CompressTimeoutError`（压缩调用点转成警告 toast 而非「压缩失败」错误横幅）；`maybeAutoCompressOnIdle` 阈值读配置
- 优化 设置面板「回合结束后」分组重构：三组超时/阈值设置从独立的「超时与阈值」分组移进「回合结束后」分组，紧贴各自开关下方并跟随开关状态（开关关闭 → 该行完全不显示；开关打开 → 行出现在开关正下方）；新增本地 `DependentRow` 包装（缩进一档 `pl-4`、自带 `divide-y` 只分隔内部多行、不在开关与其从属行之间画线）；默认值全部沿用现状 → 运行时行为零回归
- 修复 Composer 斜杠弹层布局：长技能名（如 `skill code-review`）曾把行撑成三行、行高参差、Tab 补全提示被挤成竖条——命令名保留自身宽度（超宽才省略号）、描述占剩余并截断、提示 `shrink-0 whitespace-nowrap` 保持单行；`cancelInflight` 修复「增强标记」残留（draft 已发送/会话切换后 wand 仍带增强色、点击会恢复过期草稿——增强标记随 draft 一起清空）

## [2.0.0] - 2026-10-23

- 新增 统一控件套件 UI Kit（控件之家只有一个）：`webview/src/components/ui.tsx` 收齐 Button/IconButton、TextInput/Commit*/SearchInput/Select、Switch/Checkbox/ToggleChip/OptionGroup+OptionCard、Slider/TabButton/Segmented、MenuItem 浮层行原语与 FloatPill/FloatChip/CountdownSeconds/ToastStack 浮层族，17 个组件文件的自绘控件全部改为套件引用（MessageList -334 行、SettingsModal -296 行、Composer -135 行）；原生 `<input>/<textarea>/<select>/checkbox/range` 只允许出现在 ui.tsx（唯一例外是 Composer 的提示输入 textarea），新增 `ui-kit-guard` 静态守卫断言原生控件位置、按钮基串与渐变串、无 `accent-[`/`text-[Npx]`/`rounded-[Npx]`、导出成员清单与 jsdom 行为用例
- 新增 浏览器原生字段外观由 kit 接管：`styles.css` 关掉 number 微调箭头（键盘 ↑/↓ 步进保留）、把 autofill 黄底覆写成 `--editor` 底并保留焦点光晕、`caret-color` 与 `::selection` 走 primary、textarea 一律 `resize-none` 并由 `.ui-resize` 斜纹手柄拖拽高度（clamp 到 40px 下限与视口减 120 上限）、密码显隐走 `TextInput revealable`（kit IconButton 替代无法覆写的 Chrome 内置眼睛）、`OptionCard` 新增 `emphasis` 推荐项与 `ariaLabel` 显式可访问名；Profile 切换卡的两行选项从 `Button+py-2` 改为 `OptionGroup+OptionCard`（紫色描边只画在 28px 框上、文字溢出到框外）
- 新增 回合末合并请求：AI 标题、下一步建议、自动提取记忆过去各发一次网关调用（一轮最多烧三次），现在由 `shared/turn-followup.ts` 按「已开启且符合条件」拼一份提示词一次发送，回复是单一 JSON 信封；解析先按外层对象、失败退化为按键挖取，缺项一律 `null`/`[]`——绝不伪造标题、chip 或记忆事实；单一 `followupBusy` lane、enhance 在飞时整批跳过且不登记 `titledSessionIds`、超时取所携带任务最宽松的上限、压缩轮只关闭对话派生的两项
- 新增 设置面板「联网补充模型数据」：宿主侧直连检索（`src/acp/web-search.ts`，Bing `cn.bing.com` 端点优先、DDG 回退，`node:http(s)` 直连避开 fetch 代理 patch）→ 抓取最相关的页面原文（价格表在折叠线以下，搜索摘要不够用）→ 带编号的可引用来源交给 `streamChatCompletion` 直连提炼 → 宿主解析/校验/**只追加不覆盖**；溯源校验是结构性保证：条目必须引用存在的来源编号、该来源文本必须提到模型名、模型报出的每个数字必须能在该来源中找到（单位感知 `200000`↔"200K"、`1000000`↔"1M"），任一不满足整条丢弃；查询形态与端点是硬约束（英文 pricing/context window 形态退回 Bing 固定品牌卡片，中文价格/上下文长度才命中官方定价页），来源按 URL 去查询串去重；非美元来源省略价格字段（绝不汇率换算）。首版走一次性内核 agent 会话实测在第三方网关 key 下完全不工作（内核在 `searchApiKey` 为空时把 `web_search`/`web_fetch` 全部过滤，agent 直接回空信封）且一轮平凡 prompt 烧 56,287 input tokens（system 39,992 + tools schema 12,160，`mcpServers: []` 挡不住 settings.json 里的 MCP），改走宿主侧后同任务 11,273 tokens；设置行如实披露一次额外 token 消耗，完成态报追加计数、无新数据诚实提示
- 新增 MCP 模板目录与 CLI 资产（技能/命令/子代理）可视化管理：MCP 配置编辑器表单化替代裸 JSON，支持全局/项目双作用域与合并规则预览；新增 界面反馈与状态可见（计划清单种子与勾选、工具输出完整导出）与异常处理错误提示（错误分类建议 + 设置跳转）
- 新增 全局字号维度与会话重命名：5 档语义字号 token（title 16 / body 14 / label 13 / caption 12 / micro 11 + display 20）替换硬编码 px，`--ui-font-scale` 预设紧凑 0.92 / 标准 1 / 大 1.1；圆角归为 5 档语义 token（inner 4 / control 6 / card 8 / overlay 12 / bubble 16），按钮与图标尺寸约定（28/24、图标 14/16/20）、布局间距 token 化并随 `--ui-density` 缩放
- 优化 设置面板信息架构与布局归一化：一级分类取代「通用/高级」兜底，侧栏 roving tabindex 键盘导航、初始焦点落当前侧栏项、切 tab 重置滚动；`ui.tsx` 新增 `Hint`/`ActionRow`/`ToolbarRow`/`FieldLabel`/`Field` 布局原语，5 个设置卡片的内联样式收敛为组件引用；`SettingsDisclosure` 承载次要内容（模型元数据默认收起），动作行与状态行同容器避免 `divide-y` 多出边线；返回交互统一为单一通道（子页经 header 返回箭头，底部不再放「返回」）
- 优化 Composer 与通知层级：上下文 chip 折叠、模型菜单整合思考级别与用量明细、note 改走共用 toast 栈、24px 点击区、排队占位符统一；错误与未配置凭据提示改为转录上方的 inline banner（正文独占整行、操作行下移，320/480px 窄屏可读无横向溢出），限流/流中断倒计时合并进粘性「生成中」pill 并从底部 toast 栈跳过，抽共享 `CountdownSeconds` 锚定 host 绝对 deadline 消除计时漂移
- 优化 引导向导精简为 4 步（欢迎并入连接、偏好步骤改由设置承接、模型搜索仅长目录显示、初始焦点落首个空输入、单一逃逸门）；记忆候选通知卡带 preview 与「查看确认」动作
- 修复 渲染与浮层视觉：VSCode 注入的 webview 模板样式静默覆盖设计系统（裸 `code` 的 `--vscode-textPreformat-*` 底色是 unlayered，任何 utility 都压不过，现补 unlayered 重置与 `.approval-target` token 底色）；代码块底色板作用域（普通块保留 `--editor` 底板与软换行，仅思考卡内的围栏豁免底色）；浮层菜单阴影统一 `shadow-float`（`--shadow-panel` 的负 spread 在贴触发器的浮层上会塌陷）；底部通知带遮挡最新消息（streaming/恢复 pill 从 sticky 改 absolute 浮层，最新消息与 pill 之间保留可见间隙）；hover 操作条被 paint containment 裁切；工具卡标题窄屏截断（硬固定宽度 + 副标题吞溢出）；HelpTip 气泡被卡片 `overflow-hidden` 剪切（portal 到 body + 视口夹取 + 底部不足向上翻转）
- 修复 语义与状态：工具卡轮末僵尸挂起、迟到 `in_progress` 帧覆盖已完成输出、Plan 退出被打断时的模式漂移（cancel 后立即重推当前模式）、审批/提问/Plan 卡焦点安全侧与 IME 回车、下拉菜单项语义（值选择整组 `menuitemradio` + 仅在 checkable 时输出 `aria-checked`）、错误表面动作按钮色调（警告横幅走 `warning-soft`、错误横幅走 `danger-soft`，中性灰 chip 浮在琥珀提示上读成无关控件）
- 优化 撤销「工具活动分组」回到每工具一张独立卡片（分组把并行 task 的工具混进同一张卡）；记忆卡事实列表折叠（超过 3 条收成摘要行、行内 clamp 两行点击展开）、未注入标注改 warning 色调；新增 `npm run webview:serve` 长期静态调试入口
- 变更 用户可见文案里的「iFlow CLI」统一改为「内核」（l10n 源、`package.nls` 双语与英文 bundle）



- 新增 记忆管理与项目知识库（F3 三阶段落地）：设置页「记忆」tab 读取并内联编辑 CLI 实际加载的全局与项目 AGENTS.md/IFLOW.md（按 ## iFlow Added Memories 追加/删除事实、新建项目记忆、token 成本展示、sha256 冲突检测，遗留 memory.md 只展示不注入）；助手消息行内「记住这条」与编辑器右键「记住选中内容」走 MemoryQuickAdd 弹窗（requestId 匹配自己的回包，防广播串包）；iflow.autoMemoryCapture（默认开）回合结束后用当前模型提取长期记忆候选（独立 lane 不阻塞 enhance/AI 标题、2 分钟限流、归一化去重 + 置信度 ≥0.6 + 最多 5 条），只进审阅对话框确认才写盘；项目知识库生成 .iflow/knowledge/index.md + manifest.json（2000 文件上限扫描、增量刷新仅变化时调模型、基线 hash 不匹配强制显式全量重建、注入托管块 @import 并遵循 contextFileName 遍历全部项目记忆文件防重复展开）
- 新增 首次引导向导与提供商预设配置：OnboardingWizard 引导网关/凭据/模型首次配置，provider-presets 预设切换不继承旧网关模型名防「新端点 + 旧模型」错配
- 新增 计划规格持久化与会话导航快捷键：Plan 卡计划落盘 .iflow/specs/ 供跨会话追溯；会话导航快捷键快速切换历史会话
- 新增 终端工具卡增强与 @terminal 上下文及诊断变化推送：终端记录捕获注入上下文，@terminal 补全把当前终端内容带进 prompt，诊断变化实时推送
- 新增 轮次变更摘要与设置面板重构：turn-changes 每轮结束汇总本轮文件变更；设置面板 7 个一级分类布局，新增主题与通知配置、字号/密度调节、下一步建议候选词与自动压缩开关
- 新增 MCP 连接状态指示与详情子页：MCP 卡片行首状态圆点（connected 绿/connecting 蓝/disconnected 红）+ ≈N tokens 上下文 chip（真实 BPE 口径）+ 详情子页（错误框/transport/tools schema/prompts）+ 手动刷新；MCP 工具专属呈现（Plug 图标 + 服务器名副标题）与执行卡实时命令行展示；MCP 工具声明注入自动上下文卡（经 mcp-status 通道查询各 server 工具声明，未连接者诚实标注不伪造）
- 新增 工具卡片语义化呈现与参数审计视图：按工具名映射标签/图标/强调色，执行参数结构化 key/value 摘要 + 原始参数懒挂载折叠；推理级别选择（自动/快速/平衡/深度）+ 思考能力规则同步（iflow.thinkingModelRules 设置与 ~/.iflow/thinking-models.json 双向同步，不支持思考的模型灰化推理级别）
- 新增 OS 级系统通知投递与策略收敛：原生 toast 传输层（macOS terminal-notifier 带 vscode:// 点击穿透、Windows SnoreToast），原生不可用回退 IDE 内消息；通知收敛为审批/提问/计划卡与整轮完成四触发点 + 60s 内容冷却 + 1.5s 延迟复检槽位归属，修复并行权限请求碰撞产生幽灵通知；SubAgent 审批静默只留面板
- 新增 上下文透明卡与压缩/规划状态指示：模型实际携带的 system prompt/记忆/context files 渲染成注入卡；压缩/规划进行中 pill；下一步预测 loading pill（in-flight 独立通道发布，settle 即清防 stuck spinner）
- 新增 系统提示词覆写随包交付：spawnEnv 注入 IFLOW_SYSTEM_MD 指向 VSIX 内模板，{{iflow:Name}} token 由 system-prompt-refactor Mod 从内置模板 splice 回填，cwd/git HEAD/当前模型/分支快照保持 live，session/load 恢复会话同样覆写
- 优化 上下文占用锚定语义与缓存读取拆分：lastRequestInputTokens 锚点 + 自身输出 prefill + 增量块三段口径（整份转录重折会漂移约 2 倍），缓存读取只作成本拆分不二次计入占用；vendor:cli 默认源改为本地 fork checkout ../iflow-fork（npm registry 永久滞后本地 Mod 注入，缺 checkout 硬 fail 报错不兜底）
- 修复 工具卡片标题与副标题 flexbox 挤压截断（标题永不收缩 + 副标题高权重吞溢出）；审批卡片快捷键误授权（隐藏卡片/SELECT 聚焦/事件已 defaultPrevented 时不响应）；压缩轮次误触发记忆提取；文件撤销确认流程

## [1.6.0] - 2026-10-13

- 新增 审批卡内嵌 Diff 预览：编辑类工具审批卡渲染只读 DiffView 的 pending diff（256KB 单侧上限，超限整体丢弃而非截半——半截 diff 是撒谎的 diff），用户批的是变更本身而非一个标题；放行按钮风险分层「允许一次」实心渐变主按钮 vs 「始终允许」描边+图标，不可肌肉记忆混淆
- 新增 CLI 连接逃逸与错误重试：连接耗时秒数计时器，45s 耐心阈值后弹出「重启 CLI」按钮（host 握手超时要 2 分钟，用户不该干盯着 spinner）；错误 toast 内「重试」（restartCli 会话自动恢复）与「关闭」按钮；restartCli 代际守卫防被取代 wedged 握手覆盖后继共享状态
- 新增 上下文接近上限自动压缩与占用条预警：内置模型窗口表 + contextWindowOverrides 覆盖 + 未知模型保守回并标注估算 + 分类 breakdown + 滞回 toast 带「立即压缩」内动作；acp-usage-report Mod 把末次请求输入补进 PromptResponse 使占用条 contextUsed 权威值（块数一变即退回估算）
- 新增 子代理单独停止与 MCP 服务目录：agent-cancel-refactor Mod 按 agentId 单独停止子代理（父继续，被停代理走 CLI 优雅 interrupt 分支）；子代理树生命周期重构 + MCP 服务目录卡片可视化管理
- 新增 工作区级 Profile 与模型记忆：SecretStorage active profile pointer 是全局跨窗口共享，一个窗口切换静变所有工作区启动配置——现在每个工作区各自记「最后激活 profile」与「最后选模型」，握手优先解析工作区记录命中时强制 re-authenticate（冷启动子进程读共享 settings.json，isAuthenticated 可能反映终端 CLI 配置而非本工作区记住）
- 新增 快照大文件过滤与自定义存储路径：iflow.checkpointMaxFileMB（默认 300、0=不限）捕获前逐文件测量超限者 exclude pathspec 排除（一个 300MB 模型文件不再放大每轮提交，被跳过文件不参与文件回滚）；checkpoint 保留策略与自定义存储路径
- 新增 设置面板统一 Tab 弹窗；空状态示例 prompt + 能力提示行（/命令 · @文件 · @problems · @git · 粘贴附件）
- 优化 P1/P2 交互与可读性：用户气泡操作图标常驻可见（核心能力不该藏 hover）、Composer 固定单行两区（停止与发送原地互换）、危险操作统一 ConfirmDialog 模态、ErrorToast 组件（多行 JSON 默认单行折叠 + 展开/复制）、Dropdown 去 nested role a11y、全局字号 11px、DiffView ARIA 状态、Focus 视图 pill、恢复会话骨架屏、pending card 遮挡修复、共享按钮原语
- 优化 长会话内存双上限与 OS 提醒修复：webview 侧 evictBlockPayloads 释放保留窗口之外旧块重 payload（双上限块数 200 + 字节预算 4M，host 全保真承诺）；WireRingBuffer 双上限；Collapse 折叠体懒挂载；DiffView DOM 行上限 800；离开态提示音与 OS 通知共用 isUserWatching 双条件（panel visible AND window focused，此前只看 visible 但 retainContextWhenHidden 使切 App 时仍 true 导致两提醒全灭）
- 修复 多窗口 API 配置隔离与消息编辑操作栏遮挡：工作区 profile 记录压过全局 slot 且重新同步 active creds；用户消息编辑跳转按钮不再遮挡操作栏

## [1.5.0] - 2026-10-11

- 新增 工具 Diff 逐块（hunk）保留/回退：DiffView 每个 hunk 头部带保留/回退开关，提交后 host 从 oldText 确定性回放保留块写盘——hunk 切分与回放共用 shared/hunks.ts 单一实现（UI 预览与落盘字节一致），磁盘内容与 diff newText 不一致时整单拒绝（绝不做模糊 patch），超过 200 个 hunk 自动降级为整文件操作
- 新增 审批策略规则表（Cline 式细粒度自动审批，不改 CLI）：host 在弹出审批卡前按规则预审直接应答 wire 请求，决策序为内置硬否决→deny→allow→ask→默认弹卡；allow 规则永不自动放行破坏性命令（rm/git push 等硬否决降级为询问卡，拒绝规则始终生效）；规则支持工具类别/路径 glob/命令首词/精确工具名维度，设置页管理卡可视化编辑并预览命中，全局规则存 globalState、项目规则文件用户自持不回写，审批卡可一键「始终允许」生成规则
- 新增 会话归档与置顶：历史会话可置顶/归档（标志随会话索引持久化），历史下拉分「活跃 / 已归档」两段，置顶会话恒排最前，归档会话不进默认搜索结果；标题自动更新保留用户标志不被静默清除
- 新增 编辑旧消息重发（回归 1.1.2 移除的入口，与 checkpoint 联动）：用户气泡悬停出现编辑按钮，行内编辑器改文本后重发——先恢复该轮 checkpoint 文件快照（未保存编辑器与整仓覆盖双重复确认，取消即中止），再复用删除截断链（转录 + CLI chatHistory + 重载）移除该轮及其后，最后走正常发送管线重发编辑文本；无完整快照时降级为纯截断重发并提示；截断被拒绝时不重发，绝不重复投喂旧轮

## [1.4.0] - 2026-10-10

- 新增 轮级 Checkpoint 与工作区回退：每轮对话前把工作区快照到独立影子 git 仓库（GIT_DIR 在扩展存储目录、work-tree 指向会话工作目录，绝不触碰用户自己的 .git，非 git 目录同样可用），用户气泡动作条新增「回滚到此轮」，两步确认后三档恢复——仅文件（影子 git checkout，编辑器未保存修改与整仓覆盖双重复确认）、仅对话（复用删除截断链，含 CLI chatHistory 截断）、文件+对话（先文件后截断）；快照以轮为单位锚定用户消息稳定 id，索引每会话一文件与转录同原子写纪律；影子仓库初始化/提交失败或超时（10s）该轮标记 partial 并在 UI 禁用文件恢复档，文件数超阈值（默认 5 万）自动关闭快照并提示；恢复会话时按 id 重锚定投影，删除会话/清理孤儿会话同步删除影子仓库目录；设置项 iflow.checkpoints（默认开）与 iflow.checkpointMaxFiles

## [1.3.0] - 2026-10-10

- 新增 消息排队与打断发送（Steer）：生成中可继续输入，Enter 即入队（host 队列上限 10 条，当前轮结束后自动依序发送）；队列条支持编辑取回/删除/上下移/立即发送（打断当前轮）；本轮失败自动暂停队列并提示，可继续或清空；新会话/恢复/重启 CLI/profile 切换/删除截断转录时队列集中清空
- 新增 @mention 上下文源扩展：`@/` 搜索文件夹、`@problems` 注入工作区诊断、`@git` 注入 status+diff（超时 5s/32KB 上限）、`@url:` 抓取网页正文（仅 http/https、2MB 响应上限、3 次重定向；SPA 空正文回退 title/description，按 charset 解码 GBK 等中文站，提取为空时明确提示而非静默空卡）；右键选区入口并入统一上下文卡列表（可移除、多卡并存），发送时 host 拼成带标题 fenced 段落前置到 prompt（永不 slash-leading，围栏自适应防正文逃逸）
- 新增 Mermaid 图表渲染：` ```mermaid ` 围栏懒加载渲染（动态 import 不进首屏 bundle），securityLevel strict + 独立 SVG 净化白名单（inline style），解析失败回退高亮源码纯文本；深/浅主题跟随编辑器

## [1.2.9] - 2026-10-07

- 修复 审批超时自动拒绝后卡死在生成中：新增 post-rejection 存活看门狗，超时自动拒绝后若模型 2 分钟无响应则自动中断本轮并解锁输入框；修正超时处理器 resolve 顺序确保 wire 响应不被 UI 层异常吞掉
- 新增 API 配置切换保留当前会话选项：切换时若有活跃会话则弹窗询问开启新会话或停留在当前会话，keepSession 通过 session/load 原地重载会话实现无缝切换（转录不闪烁），冷启动路径经恢复 ID 自动恢复会话
- 优化 API 配置切换选择弹窗为自定义 webview 模态：替换原生提示以保持面板亚克力视觉语言一致性，支持取消整个切换与二次切换自动取消前一个弹窗
- 优化 API 配置权威源改为扩展侧 SecretStorage：激活 Profile 解析与模型列表查询改扩展优先，删除 settings.json 外部变更同步链路与 currentApiProfile 回写，面板配置不再依赖共享 CLI 设置文件
- 变更 移除 CLI 探测回退链：内置定制 fork（vendor/iflow-cli）是面板唯一执行体，不再探测本机安装的 CLI（PATH / npm 全局 / 已知路径），删除 `iflow.cliPath` 设置项与 `IFLOW_CLI_ENTRY` 扩展侧覆盖——定制 loader 补丁只存在于内置 bundle，跑外部 CLI 会静默丢补丁改变 agent 行为；内置 CLI 缺失时直接报错提示重装扩展（dev checkout 先跑 `npm run vendor:cli`）
- 变更 同步内置默认规则：thinking-models 收敛为 glm-/qwen3.8-/deepseek-v4- 宽前缀匹配，新增 stream-toolcall-repair 规则（随定制 CLI 的流式工具调用修复 loader 生效）

## [1.2.8] - 2026-10-05

- 修复 多个子代理并行时子任务归类错误：策略 2 的「区间状态机」把任何 task 更新都塞进最新未终态卡，并行时第二个 task 的 tool_call 混进第一张卡、真正的第二张卡从未创建，其适配器事件只能兜底建出无标题无类型的无名卡——现 task 自身的 call/update 按其 toolCallId 精确归属对应卡，匹配不到任何卡才开新卡；`adoptUnboundSubAgent` 改按 FIFO（最早未绑定卡）收养，与适配器按 agent 启动顺序推事件的时序一致；补充并行双 task 与 FIFO 收养回归测试
- 优化 子代理卡步骤列表超过 4 条时默认折叠只显示最新 4 条，可「显示更早 N 条 / 收起」切换；移除卡片底部与步骤列表内容重复的「子代理日志」折叠条
- 修复 模型空响应静默失败：检测 end_turn 零输出自动重试
- 修复 提问卡多问题溢出视口：问题列表增加滚动上限，标题与操作栏保持可见

## [1.2.7] - 2026-10-04

- 修复删除用户消息频繁误报「无法在模型上下文中验证该消息，已保留原转录」：findCliHistoryCut 由「transcript 与 CLI chatHistory 从头严格逐条相等」改为出现序数对齐——CLI 会注入异文本条目（next-speaker 的 Please continue.、自动压缩摘要）、slash 轮次不入 chatHistory、图片轮混有 inlineData，旧算法在这些正常偏移下 63% 的删除点被误拒（17 个真实会话 97 个删除点复现）；新算法按「transcript 第 N 个相同文本 ↔ CLI 第 N 个相同文本」定位，目标被压缩时截到第一条幸存后继，目标/后继均不在模型上下文时纯转录删除并提示；双向安全网（前序幸存轮次须在截断点之前、后序幸存轮次须在之后，证明压缩未把重复文本错映射）无法成立时退回纯转录删除，绝不猜测截断索引；图片轮的 typed text 不再被 inlineData 连坐跳过；验证失败提示由 info toast 升级为 warning toast
- 删除确认交互统一设计语言：新增 ui.tsx `InlineConfirm` 两步确认组件（危险描边 + 确认/取消，与审批卡同一套 acrylic/press 风格），消息气泡、会话历史下拉、MCP 服务器条目三处删除入口替换各自手写的割裂确认条

## [1.2.6] - 2026-10-04

- 修复 npm registry 不可达时 npx 型 MCP 服务器挂起、阻塞内置 CLI 的 ACP initialize 握手导致面板永远无法就绪：CLI 0.5.19 在 --experimental-acp 下 isNonInteractive 为 true，discoverAllTools 走同步 await discoverAllMcpTools() 分支且连接无超时；内置 CLI 升级至 0.5.19-custom.3，注入 mcp-background-loader 让 ACP 场景改走 CLI 自带的后台发现路径（与交互 TUI 一致，MCP 工具连接完成后陆续注册），IFLOW_MCP_BACKGROUND=0 可退回原行为

## [1.2.5] - 2026-10-02

- 新增 MCP 服务器管理面板：API 配置弹窗「管理 MCP 服务器…」打开卡片，直接读取 ~/.iflow/settings.json 现有 mcpServers 展示列表（stdio 命令 / 远程 URL），支持增删改（JSON 编辑 + 校验），保存原子写回并提示一键热重启；移除文本设置项 iflow.mcpServers（与面板形成双份真值会互相覆写）
- 修复 restoreLastSession 开启后启动仍是新会话：active 槽会被面板打开时自动创建、从未发过消息的空会话覆写（转录要等首次 prompt 完成才落盘），恢复分支静默跳过——现回退到持久化列表中最近一个真正持有转录的会话，并记录回退日志

## [1.2.4] - 2026-10-02

- 新增 启动会话策略设置 iflow.restoreLastSession：开启后面板握手完成时恢复上次使用的会话（无持久化转录或恢复失败自动回退新建会话）
- 新增 启动自动打开面板设置 iflow.autoOpenPanel：VSCode 启动时自动打开聊天面板（与 warmStart 的连接幂等汇合）
- 新增 CLI 热重启：设置页「重启 CLI」按钮与 iflow.restartCli 命令，终止并重新 spawn CLI 子进程使启动期设置生效，当前会话自动恢复；生成中拒绝重启
- 新增 暴露 CLI 设置：iflow.language / iflow.approvalMode / iflow.mcpServers 写入 ~/.iflow/settings.json（留空不干预 CLI 自身值），写入后提示一键热重启
- 优化 updateCurrentApiProfile 泛化为 updateCliSettings(patch) 原子读-改-写，保留并发外部写入安全语义

## [1.2.3] - 2026-09-27

- 修复 上下文 token 计数器在 /compress 后不降反增：估算器改为压缩感知，以 CLI 事件携带的权威压缩后上下文大小折叠压缩点之前的所有块（含恢复的转录），多轮压缩只折最后一张，待处理压缩卡不折叠
- 修复 权限模式下拉在流式生成与审批/提问卡期间被误锁：权限模式是会话级设置，仅在会话不存在或另一个切换进行中时锁定，生成中保持可切换
- 修复 提问卡跨会话泄漏：beginReplay 与 newSessionState 共用转录作用域字段单一清理清单，杜绝两处手工枚举漂移
- 修复 错误横幅直出原始 JSON 与超长信封淹没关键信息：JSON-RPC 信封改紧凑摘要，兜底序列化统一裁剪上限，完整信封仍落 Output 日志
- 优化 清理死协议与空设置项：删除无发送入口的 revealOutput 消息与未实现的 iflow.idleTimeoutMinutes 设置

## [1.2.2] - 2026-09-21

- 修复 仍使用本机 CLI：1.2.1 把 vendored 检查放在跨窗口缓存复验之后，旧版扩展持久化的本机路径经 globalState 灌入缓存并抢先命中，vendored CLI 永远不执行；现 vendored 检查提到最前（仅环境变量与 iflow.cliPath 可显式覆盖）
- 修复 spawn 日志失真：日志打印 buildAcpCommand 的默认可执行文件而非 AcpClient 实际使用的 node，日志曾显示 Code.exe 启动而实际为独立 node

## [1.2.1] - 2026-09-21

- 修复 CLI 探测被本机安装覆盖：扩展内置 vendor CLI（定制 fork）始终优先，仅 IFLOW_CLI_ENTRY 环境变量与 iflow.cliPath 设置可显式覆盖
- 修复 vendor 拉取非最新 fork：版本解析链改为 npm latest → custom → PINNED（作者新发布标在 latest 上、custom tag 滞后），离线回退 PINNED_VERSION 并更新至 0.5.19-custom.2

## [1.2.0] - 2026-09-21

- 新增 Markdown 代码块语法高亮：接入 highlight.js 常用语言子集（约 40 语言），未知语言降级为转义纯文本并保留语言徽章
- 修复 fs 回调目录边界逃逸：resolveAgentPath 按允许根并集校验并拒绝 .. 上逃与范围外绝对路径，CLI 侧以 --include-directories 同源对齐
- 修复 工具卡片阴影不渲染与被裁切：Tailwind v4 将 shadow-card 解析为颜色修饰符导致无 box-shadow，改用普通 CSS 类声明；content-visibility 的 paint containment 裁切以垂直 padding/margin 抵消
- 优化 审批/提问/Plan 退出卡片改为浮层：挂载不再挤压消息列表，浮层高度经 ResizeObserver 写入 CSS 变量并由列表底部内边距预留
- 优化 阴影体系整体减半：卡片/按钮/舞台/面板明暗两套令牌统一降调，移除 hover 冗余描边环
- 优化 等宽文本面板自动换行：长 URL、路径与 hash 自动打断，消除不可达横向滚动条
- 优化 会话历史与模型下拉搜索框内边距、图标尺寸与内嵌聚焦环样式
- 优化 内置 CLI 拉取默认解析 npm 最新 custom 标签版本，打包时强制重新裁剪
- 优化 默认规则同步改为 denylist 模式：扫描全量 JSON 跳过凭据文件，打包二次校验阻断凭据进入 VSIX；thinking-models 新增 glm-5.3/5.2 与 qwen3.8 规则并移除 ^glm- 兜底
- 优化 构建链路：新增 knip 依赖与死代码检查并接入流水线，typecheck 拆分为主进程与 webview 双侧检查

## [1.1.2] - 2026-09-19

- 新增 Plan 退出卡片计划编辑与 Markdown 渲染：编辑文本随重新规划回传并在解析备注中留痕
- 修复 会话历史下拉中搜索框与标题随列表一起滚动消失：菜单改为 flex 列布局，仅会话列表滚动
- 修复 自动压缩提示在压缩期间被提前自动消失：新增 persistent 标记与 dismissToast 消息，由 host 显式管理提示生命周期
- 新增 toast displayOnly 标记：host 主导的等待（压缩重试/倒计时）渲染为不可点击 pill，避免误以为可取消
- 修复 模型下拉与实际使用模型不一致：以面板 currentModelId 为权威值，新会话/恢复会话补发 set_model 并对齐 live 列表

## [1.1.1] - 2026-09-15

- 修复 面板打开即白屏崩溃：aria-live 播报的 useMemo 位于 splash 早返回之后，首帧（无快照）与快照渲染的 hooks 数量不一致触发 React error #310
- 优化 输入框拖拽高度：默认高度即最小高度、上限改为视口高度 45%（窗口变矮自动收窄）、操作按钮行与输入文字增加间距、圆角输入框与外层容器间距均匀化
- 修复 vendor-cli 嵌套 node_modules/.bin 符号链接导致 vsce 在 Linux CI 打包失败

## [1.1.0] - 2026-09-15

- 新增 会话累计 token 消耗估算（真实 BPE tokenizer + 启发式回退）与状态栏用量指示
- 新增 Plan 模式退出确认卡与超时自动拒绝，替换原生 QuickPick 审批
- 新增 消息编辑重发、消息重新生成与复制、会话搜索与删除（两步确认）
- 新增 diff 折叠展开、附件拖拽、输入框高度拖拽与代码块语言标签
- 新增 代码块复制按钮与主题切换平滑过渡
- 新增 动态极光光斑背景层
- 新增 问题卡选项描述展示与 mock 演示数据
- 新增 主机通知从 transcript 块迁移至 toast 浮层并支持重试倒计时
- 新增 aria-live 状态播报与 / 聚焦快捷键、下拉菜单键盘导航
- 修复 Plan 模式审批在停用/取消/重认证/会话重置时未清理导致 agent 阻塞
- 修复 状态栏在生成中与创建新会话阶段无指示
- 修复 会话重置时旧会话残留 session_update 泄漏进新记录
- 修复 下拉菜单键盘导航未接线导致方向键与 type-ahead 失效
- 修复 @文件与 /命令补全弹层键盘导航激活项未滚动到可视区
- 修复 输入框拖拽调高后 textarea 未随之撑满
- 优化 toast 倒计时锚定主机绝对截止时间消除计时漂移
- 优化 审批与提问卡无障碍标注及回到最新按钮脉冲提示
- 优化 下拉弹层选项补全 menuitem 无障碍角色、凭据卡焦点陷阱与还原
- 优化 回到最新按钮改为平滑滚动并抑制动画期间贴底状态更新
- 优化 初始化标志 teardown 后复位与 Dropdown 无障碍标注
- 优化 会话恢复提示移除 emoji 前缀
- 修复 release workflow 移除 gh release create 的 --confirm 标志（gh CLI 2.x 已删除该标志导致 unknown flag 失败）

## [1.0.5] - 2026-09-13

- 修复流式生成中仍可打开会话/模型/模式/API 配置下拉：触发按钮的 disabled + pointer-events-none 因点击穿透到 Dropdown 内部 click 代理 div 而失效，改为 Dropdown 显式 disabled 硬门控
- 修复模型瞬间输出大段内容时滚动条不贴底：禁用消息列表容器的原生 scroll anchoring（overflow-anchor: none），浏览器自动调 scrollTop 触发的 scroll 事件曾被误判为用户上滑而杀死跟随
- 修复对话条出现孤立品牌图标的空行：流式分隔产生的纯空白 text 块整行跳过渲染
- 流式 shimmer 从整行收窄到文字列并加圆角与内边距，消除横贯整行的矩形色带割裂感
- 视觉细节修正：「回到最新」按钮改中性卡片底避免与用户气泡争抢，diff 行号 gutter 合并为单列消除成对 -/+ 行行号重复，浅色次要文本对比度加深

## [1.0.4] - 2026-09-13

- 审批卡与提问卡自动过期倒计时:进度条+剩余时间提示,临期变色警示;超时自动拒绝,避免 agent 永久阻塞
- 修复停止按钮在有待处理审批或提问卡时被禁用、取消审批时未同步清理待处理审批与提问的问题
- 面板视觉层次升级:卡片多层阴影与质感圆角、主色渐变按钮与按压反馈、下拉入场动画、状态呼吸灯
- 助手回复增加品牌头像与流式提示光标,空状态升级为品牌卡,工具/子代理图标改为渐变砖块承载,用户气泡与整体品牌风格统一

## [1.0.1] - 2026-09-12

- 修复模型端点不可达时模型下拉整个消失：`GET {baseUrl}/models` 查询失败仍保留当前激活模型可选（会话启动延迟推送路径补入 currentModelId，与下拉打开时刷新路径的失败保护对齐）

## [1.0.0] - 2026-09-11

- ask_user_question 提问卡与 Plan 模式审批：支持单选/多选/自由文本，Plan 计划复用审批卡形态确认
- 附件与代码上下文：OS 选择器/拖拽/粘贴多路径附件（>5MB 图片自动降级为文件），右键「加入 iFlow 上下文」生成代码上下文卡
- 上下文溢出自动压缩并重发原 prompt，速率限制改为递增退避自动重试（5s/15s/30s）
- 提示音与状态栏：Web Audio 合成提示音（完成/出错，无资源文件），状态栏展示 agent 状态与当前模型
- API 配置热重认证免重启 CLI；模型下拉模糊搜索，下拉打开时实时刷新配置与模型列表
- 内置 CLI 回退与默认规则配置：扩展无需单独安装 iFlow CLI 即可运行
- CLI 启动提速：优先独立 Node ≥20、并行探测、进程树清理、过期 OAuth 缓存归档、窗口激活后台预热
- 长会话体验：增量快照（blockPatch 锚定）、块稳定 id、超长转录离屏渲染与后缀挂载窗口
- transcript 持久化迁移至每会话独立文件（原子写），修复关闭/崩溃/切换路径的内容丢失
- UI 升级：Win12 风格亚克力材质系统，修复 Vite 压缩导致 backdrop-filter 模糊失效
- 稳定性修复：新会话残留旧历史、空会话残留条目、GUI 启动陈旧 PATH 慢启动、热重认证后配置回退、Ctrl+A 全选扫过转录区等

## [0.2.0] - 2026-09-07

- 全新 UI：移植设计稿视觉体系（Tailwind 4 + oklch 设计 token），支持深/浅色主题切换，默认跟随编辑器主题
- 子代理卡片：按类型着色、步骤进度、本地化标题与日志面板（基于 ACP wire 实测的 task 区间归组）
- 聊天面板改为编辑器标签页形态，宽度可自由拖拽
- 会话管理增强：历史会话切换/删除、恢复时自动滚动到底部、专用恢复状态标识
- 生成中状态明确化：粘性「正在生成」指示器，切换类操作全量防呆禁用，操作消息防抖
- API 配置改为居中弹框；生成期间禁用凭据变更
- 工具卡升级：行号 diff 视图、回退与并排对比操作
- 修复 CI 打包缺少 baseContentUrl 导致的发布失败，VSIX 瘦身至 202KB

## [0.1.0] - 2026-08-30

- 首个可用版本：ACP 协议接入、流式对话、工具审批、Diff 回退、会话持久化、API Profile 管理、@文件补全、图片输入
