# 主会话与超流体独立 API 配置与模型方案

> 文档状态：**功能方案（提议）**，尚未实现。本文描述目标架构与实施建议，`推荐` / `建议` 字样均表示待落地方向，不代表现网行为。
> 适用对象：VSCode 扩展「心流·驭光」（iFlow Harness）。
> 编写依据：对当前代码库的只读取证 + 三份调研结论。所有 `file:line` 引用均可回溯到源码，行号以本分支代码为准。

---

## 0. 背景与术语

- **主会话（Main Session）**：面板中的顶层 ACP 会话，是编排者，直接面向用户聊天。
- **超流体 / 子会话（Super Agent / Child Session）**：每个派发任务一个独立 CLI 进程，拥有独立 worktree、独立 ACP client，但当前与主会话**共用同一份 `~/.iflow` 配置与凭据**。
- **Profile**：一组 API 连接参数，结构为 `{ baseUrl, apiKey, modelName }`（`src/acp/auth.ts:15`），分「具名 Profile」与「活动凭据」两类。
- **活动指针**：决定「当前用哪个 Profile」的引用，当前仅有一条有效链；另有一个跨窗口全局指针被刻意停用。

### 要解决的问题

今天主会话与超流体虽然进程隔离，但凭据与模型来自同一处：子会话 spawn 时读取 `resolveWorkspaceHandshakeCreds() ?? loadCredentials()`（`src/panel/super-agent-host.ts:1941-1942`），模型取 `deps.currentModel()` = `store.currentModelId`（`src/panel/super-agent-host.ts:1722`）。因此**主会话切换 Profile / 模型会连带改变新派发子会话的配置**，无法做到「主用一个网关、超流体用另一个网关」或「两者用不同模型」。本方案的目标就是让两条链路各自持有独立的「活动 Profile 指针 + 模型选择」，同时保持老用户零配置零行为变化。

---

## 1. 配置内容与入口

### 1.1 两方各自需要配置的参数

| 参数类别 | 主会话（现状，保持不变） | 超流体（本方案新增，待实现） |
| --- | --- | --- |
| API Profile（baseUrl / apiKey / modelName） | 现有具名 Profile + 活动 Profile 指针 `iflow.workspaceActiveProfile`（workspaceState） | 新增独立指针 `iflow.superAgentProfile`（存 Global，值为 Profile 名）；apiKey/baseUrl/modelName 从**同一份** Profile 定义按名读取，不新建第二套凭据存储 |
| 模型选择 | 权威为 store 的 `currentModelId`（`src/panel/panel.ts` 大量读取，如 `:1872`、`:1941`） | 新增可选 `iflow.superAgentModel`（存 Global，模型 id；留空则回退 Profile 的 `modelName`） |
| 上下文窗口额度 | `tokensLimitEnv()`（`src/panel/panel.ts:8517`）按主链路活动 Profile 解析 | 同一函数按「本子会话链路」解析（见第 2 节） |
| 任务级覆盖 | 不适用 | `SuperTaskSpec` 新增可选 `profileId?` / `modelId?`，用于单个任务临时指定（见第 2 节） |

### 1.2 配置入口与 UI

| 入口 | 位置 | 本方案动作 |
| --- | --- | --- |
| 设置按钮 | `webview/src/App.tsx:129`（`onOpenSettings(tab: "api" \| "runtime")`）、`:995`（`setSettingsTab("api")`） | 不变 |
| 设置弹窗 tab 定义 | `webview/src/components/SettingsModal.tsx:64`（`SettingsTab` 含 `"api"` / `"super"`）、`:116` / `:244`（api tab → `ApiConfigSection`）、`:252`（super tab → `SuperAgentSection`，组件定义 `:807`） | 「账户与模型」tab 继续显示**主链路**配置；「超流体」tab 内新增两个选择项：超流体 Profile、超流体模型 |
| API Profile 管理 | `SettingsModal.tsx:1348`（`ApiConfigSection`）、`:1713`（`send({ type: "activateProfile", name })`） | 保持/新建会话卡 `ProfileSwitchCard.tsx` 不改；不要复制第二套 profile 快速切换器（`App.tsx` 已废弃旧实现） |
| 模型下拉 | `webview/src/components/Composer.tsx` 的模型菜单（约 `:1098` 起的 `modelMenuOpen` / `filteredModels` 逻辑） | 主会话模型选择不变；超流体模型选择放在「超流体」tab，不改 Composer |
| 控件规范 | `webview/src/components/ui.tsx` 控件 kit | 新增选择项必须走 kit；`test/ui-kit-guard.test.ts` 禁原生控件（仅 `ui.tsx` 与 Composer 一处 textarea 例外）、禁 `text-[Npx]` / `rounded-[Npx]` 任意值 |

### 1.3 管理原则

1. **共用 Profile 定义，不共用活动指针**：两套链路从同一份 Profile 库（SecretStorage + 内核 `apiProfiles`）按名取值，但各自记住「我当前用哪个」。
2. **不新增 SecretStorage key**：凭据仍从既有 `iflow.openai-compatible`（活动凭据，`src/acp/auth.ts:27`）、`iflow.profiles`（具名 Profile，`:66`）读取。
3. **明文落盘风险（已知现网行为，须标注）**：具名 Profile 的 apiKey 实际以明文写入内核 `~/.iflow/settings.json`（`src/acp/api-profiles.ts:48-68` 的 `writeKernelApiProfile`，经 `updateCliSettings` 落盘）。这是现网既有行为，本方案**不新增落盘、不恶化该风险**；是否接受见文末待拍板项 ①。

---

## 2. 调用逻辑

### 2.1 主会话链路（完全不动）

- 消费端点：`readActiveEndpoint`（`src/acp/models-query.ts:447`）→ `queryModelIds`（`:522`，`GET {baseUrl}/models`，原生 `node:http(s)`）。
- 提示词补全：`completeInternalPrompt`（`src/panel/panel.ts:4593`）。
- 模型校验：`validateModelForPush`（`src/panel/panel.ts:9207`）。
- 切换 Profile：热重认证 `reconnectWithCredentials` → `activateProfile`（`src/panel/panel.ts:7236` / `:7079`），模型即时 `set_model`。
- 活动 Profile 解析：`resolveActiveProfileName()`（`src/acp/models-query.ts:219`），基于内核 `currentApiProfile` + workspaceState `iflow.workspaceActiveProfile`。

### 2.2 超流体链路（本方案新增接线）

```
派发任务
  → prepareSuperSpec：解析 spec = 任务级(profileId/modelId) → 超流体链路配置 → 主链路
  → SuperTaskSpec 透传 profileId? / modelId?
  → createSuperClient 按 spec 取 profile
       → authenticate({ baseUrl, apiKey, modelName })   // client.ts:219
       → set_model(解析出的 modelId)                     // client.ts:252，新增 live 校验
  → tokensLimitEnv 按本链路解析额度
  → 子会话 spawn（env/cwd 已隔离，见 2.3）
```

关键点：

- **独立 client 实例**：每个 `createSuperClient` 是一个独立 CLI 进程实例，子进程级 `authenticate` / `set_model` **不会串味到主会话**。主会话已证明无条件重推 `authenticate` 可破 CLI `isAuthenticated` 缓存（`src/panel/panel.ts:7236` 起的热重认证路径），子会话沿用同一机制。
- **接线位置**：`src/panel/super-agent-host.ts` 的 `createSuperClient`（凭据装配见 `:1941-1947`）与 `src/panel/super-agent.ts` 的 `setModel`（`:2944`）/ `newSession`（`:2902`）。现成通道在 `src/acp/client.ts:219-221`（authenticate）与 `:252-253`（set_model）。
- **给 `createSuperClient` 增加「本子会话 creds/model」入参**，由 `prepareSuperSpec` 计算后传入，避免在各处散落解析。
- **任务书不含配置**：`buildTaskPrompt`（`src/panel/super-agent.ts:5242`）把任务包成 `You are a child session:` 散文。Profile / model **不要写进任务书**，它们只走宿主接线。
- **子会话 live 校验（新增）**：当前 `newSession` 不传模型、不读 `_meta.models`（`src/panel/super-agent.ts:2902`），无 live 校验，失败仅 `warn`（`:2952`）。本方案在 `set_model` 前按第 3 节规则做一次 live `/models` 校验。
- **数据结构调整**：
  - `SuperTaskSpec`（`shared/super-agent.ts:1399`）新增可选 `profileId?` / `modelId?`。
  - `SuperSessionUi`（`shared/super-agent.ts:567`）新增可选 `profileId?`（已有 `model?`，`:586`）。
  - 工具白名单解析（`normalizeDisallowedTools` `:339`、`disallowed_tools` 注入 `:2892-2899`）、归档/恢复（`archived` map `:951`、`findArchived` `:1126`、`restoreSessions` `:1150`）需带上新字段。

### 2.3 隔离边界现状

- **进程与目录已隔离**：主会话 spawn env 在 `src/panel/panel.ts:8648` 起，子会话 spawn env 在 `src/panel/super-agent-host.ts:1909-1927`（`IFLOW_HARNESS=1`、`IFLOW_HARNESS_CONTEXT_FILE`、`IFLOW_SUPER_CHILD=1`、`IFLOW_SUPER_TOOL=undefined`、`IFLOW_TOKENS_LIMIT`、`IFLOW_SYSTEM_MD`）；子会话 cwd 为 worktree 根、`includeDirectories` 为空。
- **配置未隔离**：`~/.iflow` 的 settings / 凭据 / Profile 是**读写同一份**。本方案不改变磁盘布局，只在「进程启动后按目标 Profile 推送凭据与模型」这一层实现逻辑隔离。

---

## 3. 默认与回退规则

### 3.1 Profile 解析优先级（从高到低）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 任务 `profileId` | 单次任务临时覆盖，`SuperTaskSpec.profileId` |
| 2 | `iflow.superAgentProfile` | 超流体链路独立指针（新增，Global） |
| 3 | 主链路 `iflow.workspaceActiveProfile` | 未配置超流体链路时回退到主会话活动 Profile |
| 4 | 内核 `currentApiProfile` | workspaceState 缺失时再回退 |
| 5 | 默认模型名 | 以上均不可用时取 Profile 的 `modelName` / 内核默认 |

### 3.2 Model 解析优先级（从高到低）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 任务 `modelId` | 单次任务临时覆盖 |
| 2 | `iflow.superAgentModel` | 超流体链路独立模型（新增，Global） |
| 3 | Profile 的 `modelName` | 目标 Profile 自带模型名 |
| 4 | 主 store `currentModelId` | 最终回退到主会话当前模型 |

发送前做 live `/models` 校验。遵循 AGENTS.md 两条编号纪律：

- **陷阱 #23**（`AGENTS.md:170`）：`set_model` 只改 `contentGeneratorConfig.model`，**不回写** `Config.model` / settings.json；`session/new` 的 `_meta.models.currentModelId` 取自 `Config.model`（CLI 启动值）。因此 **store 的 `currentModelId` 是权威**，绝不反向信任 `session/new` 上报值。
- **陷阱 #25**（`AGENTS.md:172`）：空 / 失败的 live `/models` 查询**不构成下架证据**，照常推送；只有「能证明下架」的结果才回退并警告。单测必须覆盖「空 live 列表不算下架」。

### 3.3 生效时机

| 变更 | 生效时机 | 实现要点 |
| --- | --- | --- |
| 主链路 Profile / 模型 | 即时（热重认证 + `set_model`） | 现网行为不变 |
| 超流体 Profile / 模型 | **新派发任务即时生效** | `onDidChangeConfiguration` 增加两个新键分支：清缓存 + 提示「新任务生效」 |
| 已运行子会话 | **保持 spawn 时快照**，下一批生效 | 不重启已运行子会话、不打断长任务；提供手动重启入口（建议） |

### 3.4 硬性禁止项（避免互相覆盖）

- **禁止写 `iflow.active-profile`**：这是跨窗口全局指针，现有代码刻意不写（说明见 `src/panel/panel.ts:732`；`ACTIVE_PROFILE_KEY` 定义于 `src/acp/auth.ts:67`），本方案继续遵守，否则主 / 子切换会互相覆盖。
- **禁止把超流体配置塞进 `iflow.profiles`**：一次性迁移会写进内核 `apiProfiles`，与重名守卫（`migrateKernelApiProfiles` 的 `taken` 判定，`src/acp/api-profiles.ts`）冲突。

---

## 4. 兼容性与影响范围

### 4.1 对现有功能 / 用户流程 / 已有配置的影响

- **老用户零配置零行为变化**：未配置超流体链路时，回退链命中主链路活动 Profile 与模型，行为与今天完全一致。
- **进程隔离本就存在**：env / cwd 已隔离（见 2.3），本方案只补「凭据与模型按链路解析」这一层。
- **profile 明文落盘**：现网行为（`src/acp/api-profiles.ts:48-68`），本方案不新增落盘。

### 4.2 注入方案取舍（为什么选「spawn 后推送」）

| 方案 | 结论 | 依据 |
| --- | --- | --- |
| (a) env 注入 key/baseUrl/model | **不可行** | CLI 不认这些 env；`IFLOW_API_KEY` 仅作布尔判据，真 key 来自 settings.json |
| (b) 独立 `IFLOW_HOME` + settings.json | **半可行但不达目标** | 扩展侧认 IFLOW_HOME，但 CLI 内核 User settings 路径硬编码 homedir（`vendor/iflow-fork/bundle/api-config-isolation-loader.cjs` 开头注释 + `STRIP_KEYS` 约 `:101`），且不认 IFLOW_HOME；指向 worktree 外会绕过隔离 |
| (c) **spawn 后按目标 profile 推 `authenticate` + `set_model`（推荐）** | **采用** | 通道现成（`src/acp/client.ts:219-221` / `:252-253`）；独立进程实例不串味；热重认证已证明可破 CLI 缓存 |

### 4.3 落盘与合规纪律（必须遵守）

| 写入对象 | 唯一允许路径 | 禁止 |
| --- | --- | --- |
| 内核 `~/.iflow/settings.json` | `updateCliSettings(patch, file, options)`（`src/acp/models-query.ts:375`：Object.assign 单键合并 + 唯一 tmp + `renameWithRetrySync`，**从不 unlink**）及其包装（`src/acp/api-profiles.ts` 中 `writeKernelApiProfile` / `setKernelActiveProfile` / `deleteKernelApiProfile` / 迁移函数） | 裸 `fs.writeFile`、读全量 JSON 改后整写回、先 `unlink` 再 `rename`（历史丢键回归，见 `src/acp/models-query.ts:407-416` 注释与 `test/models-query.test.ts:171-269`） |
| VSCode `iflow.*` 设置 | `SettingsWriteService.writeUserSetting` → `getConfiguration("iflow").update(key, value, ConfigurationTarget.Global)` 单键合并（`src/panel/settings-write-service.ts:143` / `:179`，纪律声明 `:7-16`） | 同上；settings.json 是用户可编辑文件 |

写入失败**必须携带真实错误 toast**（只读 / JSON 损坏 / Settings Sync 冲突 / 旧 vsix），不得退化为泛化提示。

### 4.4 新增设置键的连锁影响

- `test/settings-declared.test.ts`：新增 2 个键会使 `ALL_KEYS` 快照（当前 43 项，声明见 `:12`、数组 `:41`）变为 45，须显式更新；两份 nls（`package.nls.json` / `package.nls.zh-cn.json`）键集合必须完全一致。
- l10n：面板文案以中文为源语言，登记 `l10n/source.en.json` 后跑 `npm run l10n:gen` 生成 `l10n/bundle.l10n.en.json` 与 `webview/src/i18n.ts`；漂移由 `test/l10n-drift.test.ts` / `test/l10n-key-coverage.test.ts` 校验。
- vendor bundle **不改**，因此**不需要** `npm run harness`；若改 vendor 必须同步 fork 快照并跑 harness。

### 4.5 需新增 / 调整的模块清单

| 模块 | 动作 |
| --- | --- |
| `shared/super-agent.ts` | `SuperTaskSpec` 加 `profileId?` / `modelId?`；`SuperSessionUi` 加 `profileId?`；白名单、归档/恢复带字段 |
| `shared/super-profile.ts`（新建） | 放 `resolveSuperEndpoint` / `resolveSuperModel` 纯函数（零 VSCode 依赖） |
| `src/panel/super-agent-host.ts` | `createSuperClient` 加 creds/model 入参；按 spec 推 `authenticate`；`onDidChangeConfiguration` 加两个新键分支 |
| `src/panel/super-agent.ts` | `setModel` 接入 live 校验；`prepareSuperSpec` 解析链 |
| `src/panel/panel.ts` | `tokensLimitEnv` 按链路解析；主会话路径不动 |
| `package.json` / nls / l10n | 声明 2 个新键、补双语文案、跑 l10n:gen |
| `webview/src/components/SettingsModal.tsx` | 「超流体」tab 加两个选择项（走 ui kit） |
| 测试与版本号 | 见第 5 节 |

---

## 5. 实现建议与验证方式

### 5.1 推荐数据结构与配置示例

```jsonc
// VSCode 用户设置（iflow.*，单键写入）
{
  "iflow.superAgentProfile": "super-gateway",  // 超流体专用 Profile 名；留空回退主链路
  "iflow.superAgentModel": "deepseek-chat"      // 可选模型 id；留空回退 Profile.modelName
}
```

```ts
// shared/super-profile.ts（纯函数，零 VSCode 依赖）
resolveSuperEndpoint(input): { baseUrl, apiKey, modelName }
resolveSuperModel(input, liveIds): { modelId, degraded, reason }
// 优先级常量与第 3 节表格一一对应
```

- Profile 本体仍存既有 SecretStorage + 内核 `apiProfiles`，按 `iflow.superAgentProfile` 名读取；apiKey/baseUrl/modelName 不复制、不另存。
- `SuperTaskSpec` 新增字段均为**可选**，缺省时走回退链。

### 5.2 实现步骤（四期）

| 期 | 范围 | 交付 |
| --- | --- | --- |
| ① 纯逻辑 | `shared/super-agent.ts` 加字段；新建 `shared/super-profile.ts` 放 `resolveSuperEndpoint` / `resolveSuperModel` | 两个纯函数 + 单测（覆盖两条回退链、空 live 列表不算下架） |
| ② 设置 / nls / l10n / UI | 声明 2 个新键；`settings-declared.test.ts` 快照 43→45；补齐 `package.nls.json` / `package.nls.zh-cn.json`；`l10n/source.en.json` 登记后跑 `npm run l10n:gen`；「超流体」tab 加两个选择项 | 设置可配置、文案无漂移、UI kit 合规 |
| ③ 宿主接线 | `prepareSuperSpec` / `createSuperClient` / `setModel` / `tokensLimitEnv` / 子会话 live 校验；`onDidChangeConfiguration` 新键分支 | 两套链路真正独立工作 |
| ④ 测试 / 文档 / 版本号 | 全量回归 + typecheck + build；本文归档；CHANGELOG 顶部唯一来源 + `package.json.version` 同步（release 分支执行） | 可发布 |

### 5.3 验证方式

| 层级 | 方法 |
| --- | --- |
| 单元 | 新纯函数单测两条回退链与「空 live 列表不算下架」；断言 `iflow.active-profile` 从未被写入 |
| 接线 | 给 `createSuperClient` 注入 spy，断言主 / 子会话 `authenticate` 的 baseUrl/apiKey/model 不同，且互不写入对方指针 |
| 集成 | 用两个不同 baseUrl 的 mock 端点跑真实 ACP，检查 wire 日志中主 / 子进程的 Authorization 与 model 各自正确 |
| 回归 | `npx vitest run` 全量、`npm run typecheck`、`npm run build`、`test/ui-kit-guard.test.ts`、`test/settings-declared.test.ts`；`npm run harness` 仅在改 vendor 时执行 |
| 手工验收 | 配置两套 Profile → 主会话发一条消息、派一个超流体 → 看板 model chip 与两个 CLI 进程的实际模型一致；切换超流体 Profile 后新任务用新配置、旧任务不变 |

### 5.4 需跟随调整的既有测试

| 测试 | 调整 |
| --- | --- |
| `test/panel-spawn-env.test.ts:215` | 「子会话与主会话共用同一兜底查表」断言需反转（子会话应按独立链路解析） |
| `test/cli-tokens-limit-env.test.ts:209` 起 | `tokensLimitEnv` 按链路解析后更新断言 |
| `test/super-agent-manager.test.ts:331` | `currentModel` 单一回调假设改为按 spec 注入 |
| `test/models-query.test.ts:171-269` | 保持丢键回归锁，新增写入路径不得绕过 |
| `fixtures/probe-super-agent.mjs` | 探针跟随新接线 |

---

## 6. 待用户拍板项

> 每项已给推荐默认值；若无异议按推荐执行。

| # | 决策点 | 推荐默认值 | 理由 |
| --- | --- | --- | --- |
| ① | 是否接受 profile apiKey 明文落盘 | **维持现网行为，本方案不新增落盘** | 属既有风险，独立改造范围外；单独治理更稳妥 |
| ② | 一期是否同时加 `profileId` 与 `modelId` | **同时加** | 用户要求 API 配置与模型都独立，缺一不可 |
| ③ | 是否引入子会话独立 `IFLOW_HOME` | **不引入** | 会改变记忆 / session 存储位置，且与隔离意图冲突；内核 User settings 也不认 |
| ④ | 已运行子会话是否要求即时切换 | **不接受，下一批生效** | 避免打断长任务；提供手动重启入口即可 |

---

## 附录 A：关键代码引用索引

| 主题 | 位置 |
| --- | --- |
| Profile 结构 / 凭据 Secret key | `src/acp/auth.ts:15`、`:27`、`:66`、`:67` |
| 具名 Profile 明文落盘 | `src/acp/api-profiles.ts:48-68`（`writeKernelApiProfile`） |
| 活动 Profile 解析 | `src/acp/models-query.ts:219`（`resolveActiveProfileName`） |
| 内核设置单键合并写入 | `src/acp/models-query.ts:375`（`updateCliSettings`） |
| 主会话端点 / 模型查询 | `src/acp/models-query.ts:447`、`:522` |
| 主会话热重认证 | `src/panel/panel.ts:7236`（`reconnectWithCredentials`）、`:7079`（`activateProfile`） |
| 跨窗口全局指针刻意停用 | `src/panel/panel.ts:732` |
| 主会话 spawn env | `src/panel/panel.ts:8648` 起 |
| 子会话 spawn env | `src/panel/super-agent-host.ts:1909-1927` |
| 子会话凭据装配 | `src/panel/super-agent-host.ts:1941-1942` |
| 子会话模型来源 | `src/panel/super-agent-host.ts:1722`（`currentModel`） |
| `authenticate` / `set_model` 通道 | `src/acp/client.ts:219-221`、`:252-253` |
| 子会话 setModel / newSession | `src/panel/super-agent.ts:2944`、`:2902`；失败仅 warn `:2952` |
| 任务书封装 | `src/panel/super-agent.ts:5242`（`buildTaskPrompt`） |
| 任务 / 会话数据结构 | `shared/super-agent.ts:1399`（`SuperTaskSpec`）、`:567` / `:586`（`SuperSessionUi`） |
| 设置写入纪律 | `src/panel/settings-write-service.ts:7-16`、`:143`、`:179` |
| CLI 内核不认 IFLOW_HOME | `vendor/iflow-fork/bundle/api-config-isolation-loader.cjs`（开头注释、`STRIP_KEYS` 约 `:101`） |
| 模型双变量 / 下架陷阱 | `AGENTS.md:170`（#23）、`:172`（#25） |
| 设置键快照锁 | `test/settings-declared.test.ts:12`、`:41` |
| 兜底查表共享断言（待反转） | `test/panel-spawn-env.test.ts:215` |
| UI tab / 组件 | `webview/src/components/SettingsModal.tsx:64`、`:116`、`:244`、`:252`、`:807`、`:1348`、`:1713`；`webview/src/App.tsx:129`、`:995` |
