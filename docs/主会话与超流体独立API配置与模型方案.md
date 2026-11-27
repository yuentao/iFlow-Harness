# 主会话与超流体独立 API 配置与模型方案

> 文档状态：**已落地（2026-11-27 按实现核对）**。正文描述目标形态，第 7 节记录实现事实、被否方案与实现期硬口径；两者冲突处以第 7 节为准。
> 适用对象：VSCode 扩展「心流·驭光」（iFlow Harness）。
> 编写依据：对当前代码库的只读取证 + 三份调研结论。文中代码锚点统一给**文件名 + 函数 / 符号名**，不写行号——行号跨提交漂移，一律以实现时实际代码为准。

---

## 0. 背景与术语

> （括注：本文所说的「凭据只经 ACP `authenticate` 推送」是**产品口径**——面板只用 `authenticate`；内核层面 vendor CLI 另有一条 env 凭据通道，存在但本产品不用，详见第 7.1 节「关于 env 的旧结论订正」。）

- **主会话（Main Session）**：面板中的顶层 ACP 会话，是编排者，直接面向用户聊天。
- **超流体 / 子会话（Super Agent / Child Session）**：每个派发任务一个独立 CLI 进程，拥有独立 worktree、独立 ACP client；磁盘上仍与主会话**共用同一份 `~/.iflow` 配置存储**，但凭据与模型在 spawn 时按链路解析后仅通过 ACP `authenticate` 推送，不再由主会话充当传声筒。
- **Profile**：一组 API 连接参数，包含 baseUrl、apiKey、modelName 三个字段（`src/acp/auth.ts` 的 `OpenAiCompatCredentials`），分「具名 Profile」与「活动凭据」两类。面板侧的**权威存储是内核 `~/.iflow/settings.json` 的 `apiProfiles`**（`src/acp/api-profiles.ts`），不是 VSCode SecretStorage。
- **活动指针**：决定「当前用哪个 Profile」的引用，当前仅有一条有效链；另有一个跨窗口全局指针被刻意停用。

### 要解决的问题

今天主会话与超流体虽然进程隔离，但凭据与模型曾来自同一处：子会话 spawn 时先解析工作区握手凭据（`resolveWorkspaceHandshakeCreds`），缺失时回退到已加载凭据（`loadCredentials`）（`src/panel/super-agent-host.ts` 的 `createSuperClient` 调用点）；模型取自 `deps` 的 `currentModel` 方法，其值为 store 的 `currentModelId`。因此**主会话切换 Profile / 模型会连带改变新派发子会话的配置**，无法做到「主用一个网关、超流体用另一个网关」或「两者用不同模型」。

本轮已落地独立解析层（`shared/super-profile.ts`）与宿主接线（`resolveSuperSpawnPlan`）：两条链路各自持有「活动 Profile 指针 + 模型选择」，同时保持老用户零配置零行为变化（见第 7.6 节）。

---

## 1. 配置内容与入口

### 1.1 两方各自需要配置的参数

| 参数类别 | 主会话（现状，保持不变） | 超流体（已落地） |
| --- | --- | --- |
| API Profile（baseUrl / apiKey / modelName） | 现有具名 Profile + 活动 Profile 指针 `iflow.workspaceActiveProfile`（workspaceState） | 新增独立指针 `iflow.superAgentProfile`（存 Global，值为 Profile 名）；apiKey/baseUrl/modelName 从**同一份** Profile 定义按名读取，不新建第二套凭据存储 |
| 模型选择 | 权威为 store 的 `currentModelId`（`src/panel/panel.ts` 多处读取） | 新增可选 `iflow.superAgentModel`（存 Global，模型 id；留空则回退 Profile 的 `modelName`，再回退主会话 `currentModelId`） |
| 上下文窗口额度 | `tokensLimitEnv` 按主链路活动 Profile 解析 | 独立的 `resolveSuperCliTokensLimit` / `superTokensLimitEnv`：tier 2 用「超流体端点命中的具名 Profile」，**不读**主会话 `currentApiProfile`（见第 2.2 节） |
| 任务级覆盖 | 不适用 | `SuperTaskSpec` 新增两个可选字段：`profileId`、`modelId`，用于单个任务临时指定（字段、第①级解析与透传已就位；但派发载荷、任务 prompt 与工具 schema 均未声明这两个字段，生产通道不开放，理由见第 7.9 节） |

### 1.2 配置入口与 UI

| 入口 | 位置 | 本方案动作 |
| --- | --- | --- |
| 设置按钮 | `webview/src/App.tsx` 的 `onOpenSettings`（打开设置弹窗，取值 api 或 runtime）与 `setSettingsTab`（切到 api tab） | 不变 |
| 设置弹窗 tab 定义 | `webview/src/components/SettingsModal.tsx` 的 `SettingsTab`（api / chat / appearance / mcp / memory / assets / super / qq / runtime 共 9 个取值）；`super` tab → `SuperAgentSection`；`api` tab → `ApiConfigSection` | 「账户与模型」tab 继续显示**主链路**配置；「超流体」分类内新增两个选择项：超流体 Profile、超流体模型（已在 `SuperAgentSection` 落地） |
| API Profile 管理 | `SettingsModal.tsx` 的 `ApiConfigSection`（通过 `send` 发送 activateProfile 消息，携带 name） | 保持/新建会话卡 `ProfileSwitchCard.tsx` 不改；不要复制第二套 profile 快速切换器（`App.tsx` 已废弃旧实现） |
| 模型下拉 | `webview/src/components/Composer.tsx` 的模型菜单（`modelMenuOpen` / `filteredModels` 逻辑） | 主会话模型选择不变；超流体模型选择放在「超流体」分类，不改 Composer |
| 控件规范 | `webview/src/components/ui.tsx` 控件 kit | 两个选择项走 kit 的 `Select`；`test/ui-kit-guard.test.ts` 禁原生控件（仅 `ui.tsx` 与 Composer 一处 textarea 例外）、禁用文字大小与圆角的任意像素值写法 |

### 1.3 管理原则

1. **共用 Profile 定义，不共用活动指针**：两套链路从同一份 Profile 库按名取值，但各自记住「我当前用哪个」。该 Profile 库的**权威存储是内核 `~/.iflow/settings.json` 的 `apiProfiles`**（`src/acp/api-profiles.ts`）；VSCode SecretStorage 只保留热重认证缓存与一次性迁移源。
2. **不新增 SecretStorage key，也不新建第二份凭据存储**：凭据仍从内核 `apiProfiles` 读取（面板侧入口是 `src/acp/api-profiles.ts` 的 `readKernelApiProfiles`）；SecretStorage 侧既有的 `iflow.openai-compatible`（活动凭据）、`iflow.profiles`（具名 Profile）继续保留为热重认证缓存与一次性迁移源（`src/acp/api-profiles.ts` 的 `migrateKernelApiProfiles`），不作为权威读源。
3. **明文落盘风险（已知现网行为，须标注）**：具名 Profile 的 apiKey 实际以明文写入内核 `~/.iflow/settings.json`（`src/acp/api-profiles.ts` 的 `writeKernelApiProfile`，写入落在 `updateCliSettings`）。这是现网既有行为，本方案**不新增落盘、不恶化该风险**；是否接受见第 6 节已拍板项 ①。
4. **已知过期注释（须标注，勿据此改实现）**：`src/acp/auth.ts` 的文件头注释仍写着凭据「stored in VSCode SecretStorage — never in plain settings or on disk」，与现状（API Key 明文落 `~/.iflow/settings.json` 的 `apiProfiles`）矛盾。该注释已过期，修订归属实现任务，本文不改源码（列在第 7.9 节残留项）。

---

## 2. 调用逻辑

### 2.1 主会话链路（完全不动）

- 消费端点：`readActiveEndpoint`（`src/acp/models-query.ts`）→ `queryModelIds`（向基础地址下的 models 端点发起 GET 请求，使用原生 `node:http(s)`）。
- 提示词补全：`completeInternalPrompt`（`src/panel/panel.ts`）。
- 模型校验：`validateModelForPush`（`src/panel/panel.ts`）。
- 切换 Profile：热重认证 `reconnectWithCredentials` → `activateProfile`（`src/panel/panel.ts`），模型即时通过 `set_model` 生效。
- 活动 Profile 解析：`resolveActiveProfileName`（`src/acp/models-query.ts`），基于内核 `currentApiProfile` + workspaceState `iflow.workspaceActiveProfile`。

### 2.2 超流体链路（已落地接线）

调用流程按顺序描述如下：

1. 派发任务后，`src/panel/super-agent-host.ts` 的 `resolveSuperSpawnPlan(taskProfileId, taskModelId)` 调 `shared/super-profile.ts` 的 `resolveSuperApiSpec`，按「任务级覆盖（profileId / modelId）→ 超流体链路配置 → 主链路配置」解析出本任务的凭据与模型。`prepareSuperSpec` **职责不变**（补全附件与指令，得到交给子会话的最终 spec），只负责把 `profileId` / `modelId` 透传进 spec，不承载配置解析。
2. `SuperTaskSpec` 透传两个可选字段：`profileId`、`modelId`（`shared/super-agent.ts`）。
3. `superEndpointInput` 收集解析事实：合并 Profile 库（内核 `apiProfiles` 优先于 SecretStorage）、握手凭据（`resolveWorkspaceHandshakeCreds() ?? loadCredentials()`）、内核 `currentApiProfile`、`readActiveEndpoint()` 的内核顶层默认；`configured` 标记用户是否配置了任何超流体专属指针，`modelConfigured` 在此基础上并入任务级 `modelId` 覆盖 —— 它是派发前 live 校验的门槛（见第 7.8 节）。
4. `createSuperClient` 连接后，**只有解析出端点时**才推 `authenticate`（`methodId: "openai-compatible"`，`methodInfo: {apiKey, baseUrl, modelName}`）；无端点则不推，沿用 CLI 启动配置。子进程 env 里**不含面板注入的任何凭据**，并且显式把 `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 置 `undefined`（Node 的 spawn 跳过值为 undefined 的变量），用户 shell 里残留的同名凭据变量同样不会进入子会话（见第 7.9 节）。
5. 模型：管理器通过 `deps.spawnModel`（宿主实现为 `resolveSpawnModelForSpec`，优先复用 `createSuperClient` 刚解析出的同一份 spawn 计划，见第 7.8 节）取得目标模型，再 `session/set_model` 推送；`authenticate.modelName` 仅作基线。
6. 令牌窗口：`configured` 为真时用 `superTokensLimitEnv`（`src/acp/cli-tokens-limit.ts`，tier 2 = 超流体端点命中的具名 Profile）；为假时沿用 `deps.tokensLimitEnv()` / `tokensLimitEnvFromSettings`。spawn 算出的窗口记入 `superClientTokensLimits`，`set_model` 成功后由 `setTokensLimit` 按同一口径推给子 CLI。
7. 子会话 spawn，工作目录与 includeDirectories 已隔离（见 2.3）。

关键点：

- **独立 client 实例**：每个 `createSuperClient` 是一个独立 CLI 进程实例，子进程级 `authenticate` / `set_model` **不会串味到主会话**。主会话已证明无条件重推 `authenticate` 可破 CLI `isAuthenticated` 缓存（`reconnectWithCredentials` 热重认证路径），子会话沿用同一机制。
- **接线位置**：`src/panel/super-agent-host.ts` 的 `superEndpointInput` / `resolveSuperSpawnPlan` / `createSuperClient` / `spawnModel` / `setTokensLimit`；`src/panel/super-agent.ts` 的 `setModel`（`deps.spawnModel` 取值后推 `session/set_model`）。通道定义在 `src/acp/client.ts` 的 `authenticate` 与 `setModel`。
- **任务书不含配置**：`buildTaskPrompt`（`src/panel/super-agent.ts`）把任务包成以「你是子会话」开头的提示词散文。Profile / model **不写进任务书**，它们只走宿主接线。
- **派发时校验 live 列表（已反转）**：`resolveSuperSpawnPlan` 先做纯函数解析；仅当 `modelConfigured` 且端点与模型非空时，用该端点查一次 live `/models`（4s 上限），取证成功才带 `liveModelIds` 重解并可能显式降级；超时 / 失败 / 空列表一律无证据，零配置派发不发查询。取舍见第 7.8 节。
- **数据结构调整（已落地）**：
  - `SuperTaskSpec`（`shared/super-agent.ts`）新增 `profileId`、`modelId` 两个可选字段。
  - `SuperSessionUi`（`shared/super-agent.ts`）新增可选 `profileId`，与 `model` 成对说明「这个子会话跑在哪个网关 + 哪个模型」。
  - 工具白名单解析（`normalizeDisallowedTools`、`disallowed_tools` 注入）、归档/恢复（`archived`、`findArchived`、`restoreSessions`）带上新字段。这三处实现属于 **`src/panel/super-agent.ts`**，**不在** `shared/super-agent.ts`。

### 2.3 隔离边界现状

- **进程与目录已隔离**：主会话 spawn env 在 `src/panel/panel.ts`，子会话 spawn env 在 `src/panel/super-agent-host.ts` 的 `createSuperClient`。子会话 env 实际只含：
  - `IFLOW_HARNESS` 置 `"1"`；
  - `IFLOW_HARNESS_CONTEXT_FILE`（上下文报告文件）；
  - `IFLOW_SUPER_CHILD` 置 `"1"`（子会话标记）；
  - `IFLOW_SUPER_TOOL` **显式抹除该键（值为 `undefined`）**——Node 的 spawn 会跳过值为 undefined 的环境变量，子会话因此拿不到主会话的内置 `super-agent` 工具（避免无限套娃）；置 `"1"` 的是**主会话自己**；
  - `IFLOW_TOKENS_LIMIT` **经展开注入且可能不存在**（`...childTokensLimitEnv`；解析不出正整数时该键整体缺席，见 `src/acp/cli-tokens-limit.ts` 的 `cliTokensLimitEnv`）；
  - `IFLOW_SYSTEM_MD` 是**条件赋值**（仅当 `systemPromptFile` 存在时才写入）。
  - **`IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 显式抹除（值为 `undefined`）**：面板**构造**的 env 对象本就不含这些项，凭据只走 `authenticate` 载荷；即便用户 shell 里已设（或某处误注入），Node 的 spawn 也会跳过值为 `undefined` 的变量，子会话因此拿不到（`test/super-spawn-credentials.test.ts` / `test/panel-spawn-env.test.ts` 对构造结果有断言锁死）。vendor CLI 的 env → settings → `refreshAuth` 凭据通道仍存在（须同时给 `IFLOW_SELECTED_AUTH_TYPE` 才能越过门禁，见第 7.1、7.4 节），抹除属防御纵深，不再依赖 `authenticate` 的 `methodInfo` 覆盖兼平。
- **子会话 cwd 为 worktree 根、`includeDirectories` 为空**。
- **磁盘配置未隔离**：`~/.iflow` 的 settings / Profile 是**读写同一份**。本方案不改变磁盘布局，只在「进程启动后按目标 Profile 推送凭据与模型」这一层实现逻辑隔离。
- **OAuth 缓存防御纵深**：`createSuperClient` 连接前调用 `retireStaleOAuthCreds`（`src/acp/models-query.ts`），对已过期的 `oauth_creds.json` 只做可逆改名（`.bak`）；token 未过期 / 文件缺失 / 内容不可解析时原样不动。即便 vendor 的 `IFLOW_OAUTH_STRIP=0` 回滚，也不会让每个子会话在 authenticate 上白卡约 60s。

---

## 3. 默认与回退规则

### 3.1 Profile 解析优先级（从高到低）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 任务 `profileId` | 单次任务临时覆盖，`SuperTaskSpec.profileId`；指向不存在的 Profile 时继续往下回退 |
| 2 | `iflow.superAgentProfile` | 超流体链路独立指针（Global） |
| 3 | 主链路 `iflow.workspaceActiveProfile` | 未配置超流体链路时回退到主会话活动 Profile |
| 4 | 握手调用点的活动凭据 | `resolveWorkspaceHandshakeCreds() ?? loadCredentials()`（与今天子会话一致，**先于**内核指针） |
| 5 | 内核 `currentApiProfile` → 内核顶层默认 | workspaceState 与活动凭据都不可用时最后兜底；内核顶层默认由 `readActiveEndpoint()` 合成后传入 |

> 第 4/5 级只在**用户配置了超流体专属指针**时启用；未配置时宿主把第 5 级置空，使端点与今天的握手路径逐字段相同（见第 7.6 节）。

### 3.2 Model 解析优先级（从高到低）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 任务 `modelId` | 单次任务临时覆盖 |
| 2 | `iflow.superAgentModel` | 超流体链路独立模型（Global） |
| 3 | 目标 Profile 的 `modelName` | **仅当用户点名了 Profile**（任务级覆盖或 `iflow.superAgentProfile`）才参与；未点名时显式传 `null`，直接落到第 4 级 |
| 4 | 主 store `currentModelId` | 最终回退到主会话当前模型 |

设置页模型列表通道在拉取后做 live /models 下架判定；派发路径**也做**——仅 `modelConfigured` 时、4s 上限查一次，取证失败（超时 / 非 2xx / 空列表）即无证据（见第 7.8 节）。遵循 AGENTS.md 两条编号纪律：

- **陷阱 #23**：`set_model` 只改 `contentGeneratorConfig.model`，**不回写** `Config.model` / settings.json；`session/new` 的 `_meta.models.currentModelId` 取自 `Config.model`（CLI 启动值）。因此 **store 的 `currentModelId` 是权威**，绝不反向信任 `session/new` 上报值。
- **陷阱 #25**：空 / 失败的 live /models 查询**不构成下架证据**，照常推送；只有「live 列表非空且确实不含目标模型」才回退并警告。单测覆盖「空 live 列表不算下架」。

### 3.3 生效时机

| 变更 | 生效时机 | 实现要点 |
| --- | --- | --- |
| 主链路 Profile / 模型 | 即时（热重认证 + `set_model`） | 现网行为不变 |
| 超流体 Profile / 模型 | **新派发任务即时生效** | `onDidChangeConfiguration` 已有两个新键分支：改 `iflow.superAgentProfile` → 清模型列表缓存并重推；改 `iflow.superAgentModel` → 重推载荷刷新 `currentModelId` |
| 已运行子会话 | **保持 spawn 时快照**，下一批生效 | 不重启已运行子会话、不打断长任务 |

### 3.4 硬性禁止项（避免互相覆盖）

- **禁止写 `iflow.active-profile`**：这是跨窗口全局指针，现有代码刻意不写（说明见 `src/panel/panel.ts`；`ACTIVE_PROFILE_KEY` 定义于 `src/acp/auth.ts`），本方案继续遵守，否则主 / 子切换会互相覆盖。
- **禁止把超流体配置塞进 `iflow.profiles`**：一次性迁移会写进内核 `apiProfiles`，与重名守卫（`migrateKernelApiProfiles` 的 `taken` 判定，`src/acp/api-profiles.ts`）冲突。

---

## 4. 兼容性与影响范围

### 4.1 对现有功能 / 用户流程 / 已有配置的影响

- **老用户零配置零行为变化**：未配置超流体链路时，回退链命中主链路活动 Profile 与主会话当前模型，凭据 / 模型 / 令牌窗口与今天逐字段相同（见第 7.6 节的断言）。
- **进程隔离本就存在**：子会话使用独立进程、cwd 已隔离；env 由面板按需增量构造（继承父进程环境，见 2.3），本方案只补「凭据与模型按链路解析」这一层。
- **profile 明文落盘**：现网行为（`src/acp/api-profiles.ts`），本方案不新增落盘。
- **超流体专属指针只写 VSCode 用户设置**：`iflow.superAgentProfile` / `iflow.superAgentModel` 通过 `SettingsWriteService` 单键写入 Global，不触碰 `~/.iflow/settings.json`。

### 4.2 注入方案取舍（为什么选「spawn 后推送」）

| 方案 | 结论 | 依据 |
| --- | --- | --- |
| (a) env 注入 key/baseUrl/model | **可行但不采用** | vendor CLI **确实保留** env → settings → `refreshAuth` 的凭据通道（内核用运行时拼名的环境变量读取函数取 `IFLOW_*`，字面检索找不到属检索盲区）；实测配上 `IFLOW_SELECTED_AUTH_TYPE` 后假网关能收到 env 里的 key / baseUrl / model。不用它的原因是 env 会进 `process.env`、被子会话派生的 shell 读到，且会随父进程继承（本方案已在子会话 spawn 时抹除这组变量，见第 2.3 节与第 7.1、7.4 节） |
| (b) 独立 `IFLOW_HOME` + settings.json | **不可行** | `IFLOW_HOME` 只改内核 home 解析（`Tn()`），**不改变 User settings 的路径**——内核把 settings.json 硬编码为 `join(homedir(), ".iflow", "settings.json")`（`vendor/iflow-fork/bundle/api-config-isolation-loader.cjs` 的 `userSettingsPath()`）；于是面板与内核读写不同文件；详见第 7.2.1 节 |
| (c) **spawn 后按目标 profile 推 `authenticate` + `set_model`（采用）** | **已落地** | 通道现成（`src/acp/client.ts` 的 `authenticate` / `setModel`）；独立进程实例不串味；热重认证已证明可破 CLI 缓存；凭据不由面板写入 `process.env`，且子会话 env 显式抹除 `IFLOW_*` 凭据变量，不主动暴露给子会话派生的 shell（见第 2.3、7.9 节） |

### 4.3 落盘与合规纪律（必须遵守）

| 写入对象 | 唯一允许路径 | 禁止 |
| --- | --- | --- |
| 内核 `~/.iflow/settings.json` | `updateCliSettings`（单键合并写入：Object.assign 单键合并 + 唯一 tmp + `renameWithRetrySync`，**从不 unlink**；`src/acp/models-query.ts`）及其包装（`src/acp/api-profiles.ts` 中 `writeKernelApiProfile` / `setKernelActiveProfile` / `deleteKernelApiProfile` / `migrateKernelApiProfiles`） | 裸 `fs.writeFile`、读全量 JSON 改后整写回、先 `unlink` 再 `rename`（历史丢键回归，见 `src/acp/models-query.ts` 注释与 `test/models-query.test.ts`） |
| VSCode `iflow.*` 设置 | `SettingsWriteService.writeUserSetting`：通过 `getConfiguration` 取得 iflow 配置后按单键 update（目标为 Global）（`src/panel/settings-write-service.ts`） | 同上；settings.json 是用户可编辑文件 |

写入失败**必须携带真实错误 toast**（只读 / JSON 损坏 / Settings Sync 冲突 / 旧 vsix），不得退化为泛化提示。

### 4.4 新增设置键的连锁影响

- `test/settings-declared.test.ts`：`ALL_KEYS` 快照已从 **55** 项增到 **57** 项；该文件头注释同步写明「全部 57 个 iflow.* 设置」。两份 nls（`package.nls.json` / `package.nls.zh-cn.json`）键集合必须完全一致（新增 `iflow.configuration.superAgentProfile.description` / `iflow.configuration.superAgentModel.description`）。
- l10n：面板文案以中文为源语言，登记 `l10n/source.en.json` 后运行 l10n 生成脚本，生成 `l10n/bundle.l10n.en.json` 与 `webview/src/i18n.ts`；漂移由 `test/l10n-drift.test.ts` / `test/l10n-key-coverage.test.ts` 校验。
- vendor bundle：本轮 OAuth / 遥测净化改的是 loader 与 vendoring 脚本，**未新增/改动其它 Mod 锚点**；按 `AGENTS.md` 纪律，改 vendor 必须跑 `npm run harness` 验收。

### 4.5 已落地模块清单

| 模块 | 落地内容 |
| --- | --- |
| `shared/super-profile.ts`（新增） | 单真值层：`resolveSuperEndpoint` / `resolveSuperModel` / `resolveSuperApiSpec`，零 VSCode / 零 IO 依赖 |
| `shared/super-agent.ts` | `SuperTaskSpec` 加 `profileId` / `modelId`；`SuperSessionUi` 加 `profileId`；归档/恢复记录透传 |
| `shared/messages.ts` | `HostSettingsUi` 加两个键；`SuperProfileModelsUi` 与 `refreshSuperProfileModels` / `superProfileModels` 通道（含 `requestId` / `degraded` 字段） |
| `src/panel/super-agent-host.ts` | `superEndpointInput` / `resolveSuperSpawnPlan`（含派发前 live 校验）/ `querySpawnLiveModelIds` / `rememberSpawnPlan` / `takeSpawnPlan` / `resolveSpawnModelForSpec` / `createSuperClient`（仅推 authenticate；env 显式抹除 `IFLOW_*` 凭据变量）/ `spawnModel` / `setTokensLimit`；`retireStaleOAuthCreds` 调用 |
| `src/panel/super-agent.ts` | `deps.spawnModel` → `session/set_model`；白名单与归档/恢复带新字段 |
| `src/panel/panel.ts` | 两个新键单键写入；`buildSuperProfileModels` / `pushSuperProfileModels` / `querySuperProfileModelIds`；缓存失效；`onDidChangeConfiguration` 分支；`superEndpointInput` 与宿主同口径；`buildSuperHost` 注入 `querySuperModelIds`（复用同一份模型列表缓存） |
| `src/acp/cli-tokens-limit.ts` | `resolveSuperCliTokensLimit` / `superTokensLimitEnv`（tier 2 换成超流体 Profile，不读主会话 `currentApiProfile`） |
| `package.json` / nls / l10n | 声明 2 个新键、补双语文案、生成 l10n |
| `webview/src/components/SettingsModal.tsx` | `SuperAgentSection` 内两个 `Select`（Profile / 模型），走 ui kit |
| `webview/src/store.ts` | `requestSuperProfileModels`（自增 `requestId`）+ 只认最近一次请求的回包 |

---

## 5. 验证方式与落地情况

### 5.1 数据结构与配置

新增的 VSCode 用户设置（均为单键写入）如下表：

| 设置键 | 含义 | 示例值（普通文字） | 留空行为 |
| --- | --- | --- | --- |
| `iflow.superAgentProfile` | 超流体专用 Profile 名 | super-gateway（一个超流体专用 Profile 名） | 回退主链路活动 Profile |
| `iflow.superAgentModel` | 可选的模型 id | deepseek-chat（一个模型 id） | 回退 Profile 的 `modelName`，再回退主会话当前模型 |

纯函数（位于 `shared/super-profile.ts`，零 VSCode 依赖）如下表：

| 纯函数 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- |
| `resolveSuperEndpoint` | 解析入参（Profile 名与链路上下文） | 基础地址、apiKey、模型名三项组成的端点信息 + 命中来源 | 优先级与第 3.1 节表格一一对应 |
| `resolveSuperModel` | 解析入参，以及 live /models 查询得到的模型 id 列表 | 模型 id、命中来源、是否降级、降级原因 | 优先级与第 3.2 节表格一一对应 |
| `resolveSuperApiSpec` | 端点链 + 模型链入参合并 | 端点 + 模型 | 未显式给 `profileModelName` 时自动取端点自带模型名；显式传 `null` 则跳过第 3 级 |

- Profile 本体仍存内核 `apiProfiles`（面板侧入口 `src/acp/api-profiles.ts` 的 `readKernelApiProfiles`），按 `iflow.superAgentProfile` 名读取；apiKey/baseUrl/modelName 不复制、不另存。
- `SuperTaskSpec` 新增字段均为**可选**，缺省时走回退链。

### 5.2 落地进度（四期均已实现）

| 期 | 范围 | 交付 |
| --- | --- | --- |
| ① 纯逻辑 | `shared/super-agent.ts` 加字段；新建 `shared/super-profile.ts` | 三个纯函数 + 单测（`test/super-profile.test.ts`，覆盖两条回退链与「空 live 列表不算下架」） |
| ② 设置 / nls / l10n / UI | 声明 2 个新键；`settings-declared.test.ts` 快照 55→57；补齐两份 nls；生成 l10n；「超流体」分类加两个选择项 | 设置可配置、文案无漂移、UI kit 合规 |
| ③ 宿主接线 | 解析链 / `createSuperClient` / `spawnModel` / `setTokensLimit` / `onDidChangeConfiguration` 新键分支 | 两套链路真正独立工作 |
| ④ 测试 / 文档 / 版本号 | 全量回归 + typecheck + build；本文更新为落地事实；CHANGELOG 顶部唯一来源 + `package.json.version` 同步（release 分支执行） | 可发布 |

### 5.3 验证方式

| 层级 | 方法 |
| --- | --- |
| 单元 | 纯函数单测覆盖两条回退链与「空 live 列表不算下架」；断言 `iflow.active-profile` 从未被写入 |
| 接线 | `test/super-spawn-credentials.test.ts` 用真实子进程 mock：断言 `authenticate` 的 `methodInfo` 与面板构造的 env（不含凭据，且 `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 均不存在）符合预期 |
| 集成 | 用两个不同 baseUrl 的 mock 端点跑真实 ACP，检查 wire 日志中主 / 子进程的 Authorization 与 model 各自正确 |
| 回归 | 运行全量 vitest、类型检查与构建、`test/ui-kit-guard.test.ts`、`test/settings-declared.test.ts`；harness 校验仅在改 vendor 时执行 |
| 手工验收 | 配置两套 Profile → 主会话发一条消息、派一个超流体 → 看板 model chip 与两个 CLI 进程的实际模型一致；切换超流体 Profile 后新任务用新配置、旧任务不变 |

### 5.4 已跟随调整的测试

| 测试 | 调整 |
| --- | --- |
| `test/super-profile.test.ts` | 新增：端点 / 模型两条链、显式 `null` 语义、空 live 不算下架 |
| `test/super-profile-models.test.ts` | 新增：按 Profile 实时拉列表、失败不回退内置目录、`requestId` 回显、降级标记、载荷不带 apiKey |
| `test/super-profile-models-store.test.ts` | 新增：只接受与最近一次请求配对的回包；宿主主动推送走 `profileName` 启发式 |
| `test/super-agent-endpoint-settings.test.tsx` | 新增：设置页两个选择项、空列表提示、降级提示 |
| `test/super-spawn-credentials.test.ts` | 新增：子会话按自己的 Profile 推 `authenticate`、构造的 env 不含凭据、未配置时与握手结果全等；派发前 live 校验（降级提示 / 空列表与失败不降级 / 4s 超时 / 零配置不查询 / 共享缓存只发 1 次 / 同一派发复用计划 / 不同 Profile 不串台） |
| `test/cli-tokens-limit-env.test.ts` | 新增 `resolveSuperCliTokensLimit` 用例 |
| `test/panel-spawn-env.test.ts` | 「零配置零变化」与「配置后按自己的 Profile 解析」两条断言；断言子会话 env 抹除 `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_SELECTED_AUTH_TYPE` |
| `test/super-agent-manager.test.ts` | `currentModel` 单一回调假设改为按 `spawnModel` 注入 |
| `test/models-query.test.ts` | 保持丢键回归锁；新增写入路径不得绕过 |
| `test/fixtures/probe-super-agent.mjs` | 探针跟随新接线 |

---

## 6. 已拍板项

> 本轮均已按推荐默认值实现；如需变更按对应章节重新评估。

| # | 决策点 | 结论 | 理由 |
| --- | --- | --- | --- |
| ① | 是否接受 profile apiKey 明文落盘 | **维持现网行为，本方案不新增落盘** | 属既有风险，独立改造范围外；新键只存 VSCode 设置 |
| ② | 一期是否同时加 `profileId` 与 `modelId` | **同时加** | 用户要求 API 配置与模型都独立，缺一不可 |
| ③ | 是否引入子会话独立 `IFLOW_HOME` | **不引入** | 会静默切换内核全局目录与记忆 / 会话 / 项目路径，且内核 User settings 不认 `IFLOW_HOME`（见第 7.2.1 节） |
| ④ | 已运行子会话是否要求即时切换 | **不接受，下一批生效** | 避免打断长任务；已运行子会话保持 spawn 时快照 |
| ⑤ | 是否用 env 承载凭据 / 模型 | **否决，只走 ACP `authenticate`** | env 会进入 `process.env`，子会话派生的 shell 可读；vendor CLI 的 env 通道确实存在（须同时给 `IFLOW_SELECTED_AUTH_TYPE` 才能越过 `session/new` 门禁），不用的原因是泄漏面而非不生效（见第 7.1、7.4 节）。本方案不改用它，并在子会话 spawn 时把这组变量显式抹除（见第 2.3、7.9 节） |

---

## 附录 A：关键代码引用索引

> 本索引覆盖第 0–6 节的方案描述；第 7 节各自带锚点，不重复收录。锚点只给文件名与符号名，行号以实现时实际代码为准。

| 主题 | 位置 |
| --- | --- |
| Profile 结构 / 凭据 Secret key | `src/acp/auth.ts`（`OpenAiCompatCredentials` / `ACTIVE_PROFILE_KEY`） |
| Profile 权威存储（内核 settings.json `apiProfiles`） | `src/acp/api-profiles.ts`（文件头注释、`readKernelApiProfiles`） |
| 具名 Profile 明文落盘 | `src/acp/api-profiles.ts` 的 `writeKernelApiProfile` → `updateCliSettings` |
| 活动 Profile 解析 | `src/acp/models-query.ts` 的 `resolveActiveProfileName` |
| 内核设置单键合并写入 | `src/acp/models-query.ts` 的 `updateCliSettings` |
| 主会话端点 / 模型查询 | `src/acp/models-query.ts` 的 `readActiveEndpoint` / `queryModelIds` |
| 主会话热重认证 | `src/panel/panel.ts` 的 `reconnectWithCredentials` / `activateProfile` |
| 主会话模型校验 | `src/panel/panel.ts` 的 `validateModelForPush` |
| live 模型查询 | `src/panel/panel.ts` 的 `queryLiveModelsDetailed` |
| 内部提示词补全 | `src/panel/panel.ts` 的 `completeInternalPrompt` |
| 上下文额度解析 | `src/panel/panel.ts` 的 `tokensLimitEnv`；`src/panel/super-agent-host.ts` 的 `setTokensLimit`；`src/acp/cli-tokens-limit.ts` 的 `resolveCliTokensLimit` / `resolveSuperCliTokensLimit` / `cliTokensLimitEnv` |
| 跨窗口全局指针刻意停用 | `src/panel/panel.ts`（`iflow.active-profile` 说明） |
| 主会话 spawn env | `src/panel/panel.ts`（`IFLOW_SUPER_TOOL` 置 `"1"`） |
| 子会话 spawn env | `src/panel/super-agent-host.ts` 的 `createSuperClient`（`IFLOW_SUPER_CHILD` 置 1；`IFLOW_SUPER_TOOL` 显式抹除；`IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 显式抹除；`IFLOW_TOKENS_LIMIT` 展开注入；`IFLOW_SYSTEM_MD` 条件赋值） |
| 子会话凭据装配 | `src/panel/super-agent-host.ts` 的 `superEndpointInput` / `createSuperClient` |
| 子会话模型来源 | `src/panel/super-agent-host.ts` 的 `spawnModel` → `resolveSpawnModelForSpec`（`rememberSpawnPlan` / `takeSpawnPlan` 复用同一次派发的计划，未命中时回退 `resolveSuperSpawnPlan`）；`src/panel/super-agent.ts` 的 `spawnModel` → `setModel` |
| 派发前 live 模型校验 | `src/panel/super-agent-host.ts` 的 `resolveSuperSpawnPlan` / `querySpawnLiveModelIds` / `noticeSpawnModelDegraded`；共享查询通道 `SuperAgentHostCallbacks.querySuperModelIds` 由 `src/panel/panel.ts` 的 `buildSuperHost` 注入（复用设置页同一份缓存） |
| env 凭据通道（存在但本产品不用，见第 7.1 节） | `vendor/iflow-fork/bundle/iflow.js` 的 `CT(name)` 运行时拼名读取（`IFLOW_<name>` / `IFLOW_<SCREAMING_SNAKE(name)>` / `iflow_<name>` / `iflow_<SNAKE>`）与 `session/new` 的 `authRequired` 门禁（需 `IFLOW_SELECTED_AUTH_TYPE`） |
| 子会话 spec 补全 | `src/panel/super-agent-host.ts` 的 `prepareSuperSpec`（职责=补全附件 / 指令，并透传 `profileId` / `modelId`） |
| `authenticate` / `set_model` 通道 | `src/acp/client.ts` 的 `authenticate` / `setModel` |
| 任务书封装 | `src/panel/super-agent.ts` 的 `buildTaskPrompt` |
| 任务 / 会话数据结构 | `shared/super-agent.ts` 的 `SuperTaskSpec` / `SuperSessionUi` |
| 归档 / 恢复 / 白名单实现 | `src/panel/super-agent.ts` 的 `archived` / `findArchived` / `restoreSessions` / `normalizeDisallowedTools` / `disallowed_tools` 注入 |
| 设置写入纪律 | `src/panel/settings-write-service.ts`（`writeUserSetting` 与纪律声明） |
| CLI 内核不认 IFLOW_HOME 作为 settings 路径 | `vendor/iflow-fork/bundle/api-config-isolation-loader.cjs`（开头注释、`userSettingsPath()`、`STRIP_KEYS`） |
| 模型双变量 / 下架陷阱 | `AGENTS.md` 陷阱 #23、#25 |
| 设置键快照锁 | `test/settings-declared.test.ts` 的 `ALL_KEYS`（57 项） |
| `iflow.*` 设置项总数 | `package.json` → `contributes.configuration.properties` 实测 57 项（含两个超流体键） |
| UI tab / 组件 | `webview/src/components/SettingsModal.tsx` 的 `SettingsTab` / `SuperAgentSection` / `ApiConfigSection`；`webview/src/App.tsx` 的 `onOpenSettings` / `setSettingsTab` |

---

## 7. 实现事实与实测结论（2026-11-27 核对）

> 本节记录落地实现、实测结论与被否方案，上文描述目标形态；冲突处**以本节为准**。

### 7.1 采纳方案：存储与注入分离（已落地）

> （括注：本节所说的「凭据只经 `authenticate`」是**产品口径**——面板只用 `authenticate`；内核层面 vendor CLI 另有 env 凭据通道，存在但本产品不用，详见下方「关于 env 的旧结论订正」。）

**结论**：超流体侧**不新建凭据库**，复用已有 `apiProfiles` 中的 profile；用**两个独立指针**（超流体用哪个 profile、哪个模型）存 VSCode 扩展设置；由面板在子会话 spawn 时解析出端点与模型，**凭据只通过 ACP `authenticate` 载荷推送**，模型通过 `session/set_model` 推送，令牌窗口走独立的超流体解析入口。

| 维度 | 决策 | 依据（可回溯锚点） |
| --- | --- | --- |
| 凭据存储 | 复用内核 `~/.iflow/settings.json` 的 `apiProfiles`，不新增第二套存储 | `src/acp/api-profiles.ts`（`readKernelApiProfiles`）；`src/panel/super-agent-host.ts` 的 `superEndpointInput` |
| 链路指针 | 两个独立指针存 VSCode 扩展设置：`iflow.superAgentProfile`（用哪个 profile）、`iflow.superAgentModel`（用哪个模型） | `package.json` → `contributes.configuration.properties`；`shared/messages.ts` 的 `HostSettingsUi` |
| 凭据注入 | **只走** `authenticate` 的 `methodInfo`（`apiKey` / `baseUrl` / `modelName`），**明确不用 env 注入凭据**（env 通道在内核里存在且实测有效，不用它是泄漏面取舍，见下方订正） | `src/panel/super-agent-host.ts` 的 `createSuperClient`；`src/acp/client.ts` 的 `authenticate`；`test/super-spawn-credentials.test.ts` 断言构造的 env 不含凭据 |
| 模型注入 | `session/set_model`；`authenticate.modelName` **仅作基线** | `src/panel/super-agent-host.ts` 的 `spawnModel` / `resolveSuperSpawnPlan`；`src/panel/super-agent.ts` 的 `spawnModel` → `setModel` |
| 令牌窗口 | 独立的 `resolveSuperCliTokensLimit` / `superTokensLimitEnv`；tier 2 用超流体端点命中的 Profile，**不读**主会话 `currentApiProfile` | `src/acp/cli-tokens-limit.ts`；`src/panel/super-agent-host.ts` 的 `spawnPlan.configured` 分支 |
| 成本 | 磁盘格式不变、旧用户零迁移；OAuth / 遥测净化属独立改动（第 7.5 节） | 未新增 `~/.iflow/settings.json` 键；两个新指针只写 VSCode 用户设置 |

**关于 env 的旧结论订正**：旧稿据「vendor bundle 内 `IFLOW_API_KEY` 字面仅 2 处、`IFLOW_MODEL_NAME` 0 命中」断言「凭据 / 模型从不经 env 传递」，并把 env 当作不生效的通道。静态字面计数只是检索手段的盲区（内核运行时拼名读取），该结论**已被实测推翻**，准确事实如下。

**事实一：本扩展的产品路径只用 ACP `authenticate`**。`src/` 里这些 `IFLOW_*` 变量的**唯一**出现是 `createSuperClient` 把它们显式置 `undefined`（抹除，不注入任何值）——`IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE`；面板既不从 env 读凭据也不向 env 写凭据，子会话凭据只经 `authenticate` 载荷推送，构造的 env 断言不含 apiKey / baseUrl（`test/super-spawn-credentials.test.ts`、`test/panel-spawn-env.test.ts` 对构造结果有断言锁死）。这是**产品选择**，不是内核限制。

**事实二：vendor CLI 仍保留一条 env → settings → `refreshAuth` 的凭据通道**。

- 内核读 env 走统一的环境变量读取函数（`CT(name)`），依次尝试 `IFLOW_<name>`、`IFLOW_<SCREAMING_SNAKE(name)>`、`iflow_<name>`、`iflow_<SNAKE>`，变量名是**运行时拼接**的——所以按字面检索时 `IFLOW_API_KEY` 只有 2 处、`IFLOW_MODEL_NAME` 0 命中，这是检索手段的盲区，不代表内核不读。
- ACP `session/new` 的真门禁：仅当 `settings.merged.selectedAuthType` 为真时才继续 `refreshAuth(selectedAuthType, {apiKey, baseUrl, modelName})`，否则直接 `throw authRequired()`。因此 env 里的 key / baseUrl / modelName **必须同时配上 `IFLOW_SELECTED_AUTH_TYPE`**（或先调 `authenticate`）才能越过门禁。
- `initialize.isAuthenticated` = `authType ∈ {iflow, aone, openai-compatible} && !!config.getApiKey()`。
- `authenticate` 会 `setValue("User", "selectedAuthType" / "apiKey" / ...)`，因此 `methodInfo` 会覆盖 env 合并出来的值——这是现有实现能兼平继承 env 的机制。

**实测（当前 HEAD + 两个 loader 补丁）**：

| 变体 | 配置与调用 | 结果 |
| --- | --- | --- |
| V0 | 无 env、不调 `authenticate` | `session/new` 报 `Authentication required`（`-32000`）；全程**未出现** `pleaseSetAuthMethod` |
| V1 | 只设 `IFLOW_API_KEY` + `IFLOW_BASE_URL` + `IFLOW_MODEL_NAME`，不调 `authenticate` | **不发请求**；`session/new` 报 `Authentication required`；`initialize.isAuthenticated=false` |
| V2 | V1 + `IFLOW_SELECTED_AUTH_TYPE=openai-compatible` | **生效**：假网关收到 `POST /v1/chat/completions`，`Bearer` 与 env 里的 key **逐字节相等**，`model` = `IFLOW_MODEL_NAME` 的值，正常 `end_turn` |
| V3 | 不设 env，只调 `authenticate(...methodInfo)` | 生效，使用 `methodInfo` 的 key / baseUrl / modelName |
| V4 | V3 + 临时 HOME 里放过期 `oauth_creds.json` | 生效；无 Google `tokeninfo` 探测、无约 64s 阻塞（证明 OAuth loader 有效） |
| V5 | V2 但 key 不以 `sk-` 开头 | 生效，非 `sk-` key 原样进 `Bearer` |

所有变体在预加载拦截器下均记录 `blocked: []`，零非 loopback 连接。

**因此准确结论**：本扩展的**产品路径只使用 ACP `authenticate`**（`src/` 里这些 `IFLOW_*` 变量只出现在子会话 spawn 的显式抹除处，子会话 env 也断言不含 apiKey / baseUrl）；但 vendor CLI 本身**仍保留**一条 env → settings → `refreshAuth` 的凭据通道，只是必须同时提供 `IFLOW_SELECTED_AUTH_TYPE`（或先 `authenticate`）才能越过 `session/new` 的 authRequired 门禁。所以「凭据只能经 `authenticate` 生效」**不是事实**，准确说法是「本产品选择只用 `authenticate`」；这一选择的原因是 env 会进 `process.env`，子会话派生的 shell 可读，存在泄漏面——为此子会话 spawn 时已把这组变量显式抹除（见第 2.3、7.9 节）。

### 7.2 被否方案及原因

#### 7.2.1 为何不做 HOME / USERPROFILE 隔离

- **事实**：内核的 home 解析只有一个入口 `Tn()`：命中 `IFLOW_HOME` 就规范化后返回，否则 `join(homedir(), 子目录名)`（`vendor/iflow-fork/bundle/iflow.js`）。静态字面检索可见 `process.env.IFLOW_HOME` 2 处、`Tn()` 在 bundle 中 34 处调用；但内核存在**运行时拼名**的环境变量读取（`CT(name)`，见第 7.1 节），字面计数仅作参考、不宣称穷尽。无论具体点数多少，把 `IFLOW_HOME` 指到别处都会一次性切换整批全局目录解析点。
- **事实**：User settings 的路径**不认** `IFLOW_HOME`——内核把 settings.json 硬编码为 `join(homedir(), ".iflow", "settings.json")`（`vendor/iflow-fork/bundle/api-config-isolation-loader.cjs` 开头注释与 `userSettingsPath()`）。
- **后果一（读错文件）**：同一 bundle 内部存在口径分裂——`vendor/iflow-fork/bundle/context-window-loader.cjs` 与 `multimodal-model-loader.cjs` 都按 `process.env.IFLOW_HOME` 优先解析 `settings.json`，而内核本体仍读写 homedir 那一份。子会话指向独立 home 后，这两个 loader 会读到空 / 另一份设置，上下文窗口与视觉模型选择静默失效。
- **后果二（静默丢功能）**：全局目录都挂在 `Tn()` 下，实测包括 `join(Tn(), "skills")`（global skills）、`join(Tn(), "agents")`、`join(Tn(), "commands")`、`join(Tn(), "projects")`、`join(Tn(), "acp", "sessions")`（`vendor/iflow-fork/bundle/iflow.js`）。隔离 home 等于让子会话看不到用户已有的全局 skills / agents / commands、会话历史与项目记录；`save_memory` 的 global 语义（`memory-scope-loader.cjs` 的 global 目录同样镜像 `Tn()`）也会漂到另一个目录；语言探测读的 settings `language` 同样随文件路径改变。
- **`USERPROFILE` 不是另一条出路**：Windows 上 `os.homedir()` 取的就是 `USERPROFILE`，所以改它与改 `IFLOW_HOME` 等价——同样会切换 `Tn()` 的 34 个调用点，且同样改不动 User settings 的硬编码路径。
- **结论**：不做 home 隔离；逻辑隔离只在「进程启动后推 `authenticate` / `set_model`」这一层。

#### 7.2.2 在 settings.json 里新增并列 `superApiProfiles` / `superCurrentApiProfile`

- **不会被 loader 误伤**：`vendor/iflow-fork/bundle/api-config-isolation-loader.cjs` 的 `STRIP_KEYS` 列表里**没有**这两个键，因此不会像 `apiProfiles` / `currentApiProfile` 那样被「磁盘为准」规则保护。
- **但拿不到「磁盘为准」**：非 STRIP 键走子进程启动快照优先的路径——内核的 `saveSettings` 整文件回写时用的是子进程启动时的快照，面板后写的值会被子会话整文件回写**回滚**。
- **修不动**：要让它也享受「磁盘为准」，必须把新键加进 vendor 的 `STRIP_KEYS`，与「本方案不改 vendor 的隔离逻辑」直接冲突。

### 7.3 落地时遵守的两条硬口径

1. **`authenticate` 是本产品唯一的凭据通道，且必须带子会话自己的解析结果** —— 端点来自 `resolveSuperSpawnPlan`，不再取主会话链路的载荷；面板不向 env 注入任何凭据，并在 spawn 时把 `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 显式置 `undefined`（vendor CLI 的 env 通道仍存在，但本产品不用，见第 7.1、7.4 节）。依据：`src/panel/super-agent-host.ts` 的 `createSuperClient` 只在 `spawnPlan.spec.endpoint` 存在时推 `authenticate`；`test/super-spawn-credentials.test.ts` 与 `test/panel-spawn-env.test.ts` 断言构造出的 `env.IFLOW_API_KEY` / `env.IFLOW_BASE_URL` 为 `undefined` 且环境串中不含 apiKey / baseUrl。
2. **子会话令牌窗口必须由超流体侧独立解析** —— `superTokensLimitEnv` / `resolveSuperCliTokensLimit` 的 tier 2 只读「超流体端点命中的具名 Profile」的 `tokensLimit`，绝不读内核 `currentApiProfile`；未配置超流体时才沿用主会话那套 `deps.tokensLimitEnv()`。依据：`src/acp/cli-tokens-limit.ts`；`spawnPlan.configured` 分支。

### 7.4 CLI 内核的真实读法

- vendor bundle 内核**不读** `apiProfiles` / `currentApiProfile`：在 `vendor/iflow-fork/bundle/iflow.js` 全文件检索，这两个字符串均为 **0 命中**。
- 因此 settings.json 的 `apiProfiles` 是**面板侧**的数据源；**内核侧**的凭据来自 `refreshAuth` 收到的合并值（settings 快照 + env + ACP `authenticate` 的 `methodInfo`），模型来自 `set_model`。
- env 的真实角色（按实测，见第 7.1 节）：
  - `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` **确实会被内核读取并进入凭据合并值**——读取走运行时拼名的 `CT(name)`（`IFLOW_<name>` / `IFLOW_<SCREAMING_SNAKE(name)>` / `iflow_<name>` / `iflow_<SNAKE>`），字面检索统计不到（vendor bundle 内 `IFLOW_API_KEY` 字面 2 处、`IFLOW_MODEL_NAME` 0 命中即由此而来；`src/` 里它们只出现在子会话 spawn 的显式抹除处）；
  - 但仅设这三项**不生效**：`session/new` 在 `settings.merged.selectedAuthType` 为空时直接 `throw authRequired()`，必须在 env 里再给 `IFLOW_SELECTED_AUTH_TYPE`（或先调 `authenticate`）才能走到 `refreshAuth`；
  - `IFLOW_HOME` 只参与 home 解析（`Tn()`），与凭据无关（见第 7.2.1 节）。
- 推论：超流体侧要换网关 / 换模型，本方案**只走**「`authenticate` + `set_model`」这一对通道——改 settings.json 里的 profile 只影响面板侧的读取，不改变已在运行的子进程；env 通道虽然在 CLI 里存在且经实测有效，但因会进入 `process.env`、被子会话派生的 shell 读到而不采用，子会话 spawn 时已把这组变量显式抹除（见第 2.3、7.9 节）。

### 7.5 OAuth 与遥测移除

三个净化类 loader 位于 `vendor/iflow-fork/bundle/`：

| loader | 作用 | 开关 |
| --- | --- | --- |
| `oauth-strip-loader.cjs` | 移除内核 iFlow / Google OAuth 登录分支，统一走 API 认证 | `IFLOW_OAUTH_STRIP` 取 `0 / false` 时恢复上游行为 |
| `telemetry-strip-loader.cjs` | 移除阿里侧 `cna` / PV / AI tracking / OTel / ducky 采集 | `IFLOW_TELEMETRY_STRIP` 取 `0 / false` 时恢复上游行为 |
| `internal-host-strip-loader.cjs` | 移除内核自带的 iFlow 云主机默认值与内部端点（`cloud.iflow.cn` 插件下载、`platform.iflow.cn` 内建 web 工具、`iflow.cn` OAuth/userinfo/ad-phrases、`apis.iflow.cn` 默认 baseUrl） | `IFLOW_INTERNAL_HOST_STRIP` 取 `0 / false` 时恢复上游行为 |

- **锚点机制**：三个 loader 各自导出一张 `PATCHES` 表（`{ id, anchor, replacement, sentinel }`）。`scripts/vendor-cli.mjs` 的 `applyLoaderPatches()` 在拷贝出 `vendor/iflow-cli` 后逐条注入：`anchor` 必须在压缩后的 `bundle/iflow.js` 中**恰好出现一次**，`sentinel` 注入前必须不存在、注入后必须**恰好出现一次**（round-trip）。任一条件不满足即**硬失败**，绝不静默产出未打补丁或重复打补丁的 CLI。快照 `vendor/iflow-fork/bundle/iflow.js` **保持上游原文**，方便核对；锚点漂移时 vendoring 直接失败。
- **OAuth 行为**：`authenticate` 入口把 `oauth-iflow` / `oauth-aone` 归一为 `openai-compatible`；`restoreOauthClient`（原 `BOe`，会读 `oauth_creds.json` 并向 Google `getTokenInfo`）与 `validateOAuthToken`（原 `POe`，`initialize` 用）直接返回 false；`Config.refreshAuth` 的 authType 归一为 API；`clearCachedCredentialFile` 被短路（**永不删除 / 改写 `oauth_creds.json`**）；`getOauthClient`（`kG`）抛 `SERVER_OAUTH2_REQUIRED`，pre-ACP 的 `kG` 预热分支被跳过。`openai-compatible` + `methodInfo` 的请求字节不变。
- **遥测行为**：`bqe()`（`log.mmstat.com` 的 cna 引导，且不再写 `settings.cna`）、`vln()`（PV 上报）、`Q3e()`（`gm.mmstat.com` 的 AI tracking 传输）、`kOt()`（每请求入口）、`DAe()`（OpenTelemetry SDK 初始化，默认端点 `sunfire-ingestion-external.alibaba-inc.com`）全部加「激活即提前返回」守卫；`LTe()`（`ducky.code.alibaba-inc.com/v1/models`）改为返回内置 fallback 列表。
- **诚实影响声明**：
  - OAuth 用户**失去登录方式**：`getOauthClient` 抛错，只剩 API 认证；旧的 `oauth-iflow` / `oauth-aone` 设置会被归一为 `openai-compatible`，不会崩溃也不会弹浏览器登录。
  - `ducky` 中和后，**仅** Aone / IDEALAB 认证分支的模型下拉退化为**内置 fallback 列表**（`LTe` 返回 `Ucu()`）；`openai-compatible` 用户不受影响。
  - 未改动的对外依赖：用户 profile 的 `baseUrl`（对话）、MCP server。**注意**：`internal-host-strip-loader.cjs` 之后，内建 web 搜索 / 网页抓取工具不可用、IDE 插件下载禁用、内核不再有任何 iFlow 云主机默认值；但**显式配置的 `baseUrl`（哪怕指向 `apis.iflow.cn`）照发**，扩展宿主侧的 Bing/DDG 检索也不受影响。

### 7.6 零配置零变化保证

用户**未配置** `iflow.superAgentProfile` 与 `iflow.superAgentModel`、且任务未带 `profileId` / `modelId` 时（`resolveSuperSpawnPlan` 的 `configured === false`）：

- **端点**：宿主把 `kernelProfileName` / `kernelDefaultEndpoint` 置空，解析链只剩 ③ `iflow.workspaceActiveProfile` → ④ `resolveWorkspaceHandshakeCreds() ?? loadCredentials()` ——与今天子会话的凭据路径**同源同序**；
- **模型**：`profileModelName` 显式传 `null`，模型链直接落到主 store 的 `currentModelId`（今天子会话的实际取值），不会静默换成 Profile 默认模型；
- **令牌窗口**：走 `deps.tokensLimitEnv()`（主会话同一套解析），不走 `superTokensLimitEnv`；
- **`authenticate` 载荷**：与主会话握手结果逐字段相同（`{apiKey, baseUrl, modelName}` 三项全等），且同样只经 `authenticate` 推送、不由面板写入 env。
- **不发 live 校验**：`modelConfigured === false`，派发前**不发** `/models` 查询，模型链不会因任何 live 证据降级。

对应测试：`test/super-spawn-credentials.test.ts` 的「未配置超流体时，子会话与主会话握手结果全等（凭据 + 模型 + 窗口）」与「零配置派发不发 live 查询：老用户零配置零行为变化」；`test/panel-spawn-env.test.ts` 的「未配置超流体时子会话沿用主会话同一兜底查表（零配置零变化）」。只有配置任一超流体指针后，才启用完整的 ①→⑤ 端点链与 ②→④ 模型链。

### 7.7 协议与体验：模型列表通道

- **请求 / 回包**：webview 发 `refreshSuperProfileModels`（`{ profileName?: string; requestId: number }`），宿主回 `superProfileModels`（载荷 `SuperProfileModelsUi`）并**原样回显** `requestId`。webview 只接受与**最近一次**请求配对的回包，迟到的旧回包一律丢弃（`webview/src/store.ts` 的 `requestSuperProfileModels` 与 `superProfileModels` 分支）。宿主**主动推送**（面板外改了设置）不带 `requestId`，webview 退回 `profileName` 启发式作双保险；脏值不伪造序号，绝不冒充另一次请求的回包。
- **数据源**：唯一来源是实时 `GET {baseUrl}/models`（原生 `node:http(s)` 直连），**绝不**回退 CLI 上报的 `_meta.models.availableModels` 硬编码目录。缓存 key 是归一化后的 models URL，并逐次比对 apiKey；失败结果不进缓存。
- **空列表提示**：端点返回 200 但一个模型都没有时，`models` 为空数组且**没有** `error`——这是「成功但空」的第三种状态，UI 必须显式提示，不能冒充加载中，也不能静默留空。
- **下架降级显式提示**：`live` 列表非空且确实不含当前选中模型时，载荷带 `degraded` / `delistedModelId` / `degradedModelId` / `degradedReason`。UI 只做提示（「仅提示，不会自动修改你的设置」），**绝不**因此改写 `iflow.superAgentModel`。
- **live 为空不算证据**：`live` 为空数组（200 但无模型）或查询失败（端点不可达）都不标记降级——端点挂了 ≠ 模型没了。
- **凭据不出宿主**：载荷 `SuperProfileModelsUi` 不含 apiKey（`test/super-profile-models.test.ts` 有断言）。
- **一定回包**：宿主内部异常同样回一条空列表 + 真实原因，避免下拉永远转圈。

### 7.8 派发时校验 live 列表（已反转）

- **实现（两遍纯函数 + 一次取证）**：`resolveSuperSpawnPlan` 先用 `resolveSuperApiSpec` 做一遍**纯函数**解析（无网络），得到端点与链上的目标模型；仅当 `modelConfigured`（任务级 `profileId` / `modelId`，或 `iflow.superAgentProfile` / `iflow.superAgentModel` 至少一个非空）且端点与模型 id 都非空时，才用该端点查一次 live `/models`；取证成功就带 `liveModelIds` 用**同一份** `resolveSuperApiSpec` 重解并交给 `set_model` —— 下架判定只有一份实现（`shared/super-profile.ts` 的 `resolveSuperModel`），宿主不复制判定逻辑。
- **4s 上限**：派发路径上这一跳用 `SUPER_SPAWN_LIVE_MODELS_TIMEOUT_MS`（4000ms，`Promise.race`）；设置页那条查询仍是用户主动刷新的默认 10s。宁可放弃证据，也不卡住子会话冷启动。
- **失败一律无证据**：超时 / 连接失败 / 非 2xx / 解析失败 / 200 但空列表，全部按「没有证据」处理 → 返回 `undefined`，不重解、不降级、不抛错、不阻断派发（AGENTS.md 陷阱 #25）。只有「live 列表非空且确实不含目标模型」才降级。
- **零配置派发不发查询**：`modelConfigured === false` 时不发这一跳（零配置子会话的模型就是主会话当前模型，下架时主会话会先报错）；有测试锁死「零配置派发不发 live 查询」。
- **降级显式、不改设置**：降级时 `log.warn` 记一条真实原因（被下架的模型 id + 实际回退目标），并向看板发 warning toast；同一组「下架 → 回退」按 `delisted\u0000fallback` 去重，一批并行派发只弹一次。**绝不**因此改写 `iflow.superAgentModel`。
- **缓存与计划复用**：面板通过 `SuperAgentHostCallbacks.querySuperModelIds`（由 `panel.ts` 的 `buildSuperHost` 注入 → `querySuperProfileModelIds`）把设置页那条查询通道交给宿主，**与设置页同源**：同 30s TTL、同 `normalizeModelsUrl` 缓存键、逐次比对 apiKey，因此「设置页刚查过」或「同批并行派发」最多只发一次真实请求；被 4s 放弃的请求仍在后台填缓存，下次派发直接命中。未接线的宿主（单测直接 `new`）回退到无缓存直连。此外 `createSuperClient` 解析出的 spawn 计划按 `profileId\u0000modelId` 暂存（TTL 60s、消费即删），紧随其后的 `spawnModel` 经 `resolveSpawnModelForSpec` 复用同一份计划 —— 同一次派发只解析一遍端点 / 模型 / live 校验，不同 Profile 的派发互不命中。
- **代价**：`modelConfigured` 的派发在缓存未命中时多一跳 HTTP；零配置路径完全不受影响。

### 7.9 未覆盖 / 残留

- **`entry.js` 父进程 OTel 配置未做源码级闭环**：`iflow.js` 的 OTel 初始化（`DAe`）已加守卫；`bundle/entry.js` 是否在父进程另行初始化 OpenTelemetry 尚未逐行确认，因此「遥测完全不发」只对 `iflow.js` 内的采集点成立。
- **`cloud.iflow.cn` 插件下载已移除**：`internal-host-strip-loader.cjs` 把 `oMi()`（IDE 插件 zip 下载）变成 no-op + 明确错误，零网络；`platform.iflow.cn` 内建 `web_search` / `web_fetch` 在注册表层摘除；`iflow.cn` 的 OAuth/userinfo/ad-phrases 与 `apis.iflow.cn` 的默认 baseUrl 同样不再使用（缺 baseUrl 直接报错）。残留的 `apis.iflow.cn` URL 仅出现在「用户显式把 baseUrl 指向该主机」才会走到的多模态 / JSON 修复 / 中文检测分支，属显式配置路径。
- **扩展侧 iFlow Provider 预设已移除**：`shared/provider-presets.ts` 的内置 iFlow 预设不再提供（由另一变更完成）；本文件所述 CLI 侧改动与其相互独立，两者都只影响「默认值」，不影响用户已保存的 Profile。
- **`src/acp/auth.ts` 文件头注释过期**：仍称凭据只存 SecretStorage、从不落盘，与 `apiProfiles` 明文落盘的现状矛盾；本轮只改文档，注释待实现任务订正。
- **任务级 `profileId` / `modelId` 覆盖未对外暴露**：`SuperTaskSpec` 的字段、`resolveSuperSpawnPlan` 的第①级解析、`prepareSuperSpec` 的透传都已就位，但**派发载荷解析（`parseSuperDelegationPayload`）、任务 prompt 与 `super-agent` 工具 schema 均未声明这两个字段**，模型写不出来，故生产通道不会到达。不开放的理由：让模型生成的 JSON 决定子会话用哪套凭据（乃至哪把 apiKey）属于**扩权**，应由用户在设置里显式选择；若将来开放，需显式校验 Profile 名并考虑审批。
- **已运行子会话不随设置变更**：保持 spawn 时快照；未发现「按新配置重启单个已运行子会话」的专用入口，设置改动只对下一个派发生效。
- **`tsconfig.test.json` 既有报错**：与本方案无关，仍不在 CI 闸门内。
- **子会话 spawn 已显式抹除继承的凭据 env（已完成）**：`createSuperClient` 在构造 env 时把 `IFLOW_API_KEY` / `IFLOW_BASE_URL` / `IFLOW_MODEL_NAME` / `IFLOW_MODEL` / `IFLOW_SELECTED_AUTH_TYPE` 置 `undefined`（与既有 `IFLOW_SUPER_TOOL: undefined` 同手法）；`test/super-spawn-credentials.test.ts` / `test/panel-spawn-env.test.ts` 断言即使宿主 `process.env` 里有这些键，子会话 env 中也不存在。vendor CLI 的 env 通道仍存在（见第 7.1 节），此项属防御纵深，兼平不再依赖 `authenticate` 的 `methodInfo` 覆盖。