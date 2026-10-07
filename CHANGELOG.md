# 更新日志 / Changelog

本文件是版本的唯一来源（single source of truth）：CI 从 `## [x.y.z]` 标题读取
版本号写入 `package.json`，其下的条目作为该版本的发布摘要。

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
