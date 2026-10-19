---
title: "改进 F4：MCP 模板目录 + CLI 资产（skills/agents/commands）可视化管理"
created: 2026-10-19T09:15:56.050Z
session: 439fd54b-b1d8-45a4-9d03-3486639fa78d
---

## 改进 F4：MCP 模板目录 + CLI 资产（skills/agents/commands）可视化管理

### A. MCP 目录卡片式安装（内置模板 + 表单化配置）
1. **`shared/mcp-catalog.ts`**（新建，纯数据 + 纯 builder，同形态参照 `shared/provider-presets.ts`）
   - `MCP_CATALOG`：6 个内置 npx-based 模板（filesystem、playwright、chrome-devtools、memory、time、sequential-thinking），字段：id/name/title/category/description(中文源)/docsUrl/transport(stdio|url)/command+args 或 url/fields(表单槽：key/label/required/placeholder)
   - `buildCatalogConfig(entry, values)`：模板 + 表单值 → mcpServers 配置对象（args 追加非空 field values）
2. **`webview/src/components/McpCard.tsx`**：McpSection 新增「模板目录」子页（catalog list：title/description/transport 预览/docs）+ 选模板 → 表单（名称 input + 各 field input）→「安装」= 构建 config、合并 entries（同名冲突报错）、复用现有 saveMcpServers replace-semantics 保存 + 已保存 flash + 重启 CLI 提示（host 侧 unchanged）

### B. skills/agents/commands 可视化管理
3. **`shared/messages.ts`**：
   - 类型 `AssetKind`/`AssetScope`/`AssetUi`/`AssetsStateUi`（注释记录 bundle 实证：commands 递归 `**/*.{md,toml}` name=":" joined；agents 顶层 .md frontmatter agent-type/name/allowed-tools；skills `<dir>/SKILL.md`，global 同名覆盖 project）
   - WebviewToHost 新增：`listAssets`/`readAsset`/`saveAsset`(expectedHash)/`createAsset`(kind/scope/name/content)/`deleteAsset`（均带 requestId）
   - HostToWebview 新增：`assetsState`/`assetContent`/`assetSaved`(ok/conflict/requestId)/`assetDeleted`
4. **`src/assets/service.ts`**（新建 `AssetsService`，镜像 `src/memory/service.ts` 纪律）
   - 复用 `src/memory/files.ts` 的 readIfExists/statIfExists/writeAtomic/sha256/isWithin/displayPathFor/memoryHome
   - scan：global `home/{commands,agents,skills}` + project `cwd/.iflow/{...}`；commands 递归 walk（cap 200）、agents 顶层 .md、skills 子目录 SKILL.md（shadowed 标记）；frontmatter 简易 parser（display-only）
   - resolveTarget：path 必须落在六个资产根 + 结构判定（command .md/.toml；agent 顶层 .md；skill */SKILL.md）否则拒绝（协议边界，not arbitrary write）
   - saveFile：expectedHash 冲突检测（explicit null = 要求不存在）；createFile：host 拼 path 从 kind/scope/name（name 校验 `[A-Za-z0-9][A-Za-z0-9_-]*`），exists→conflict；deleteFile：unlink + 若 skill 目录空则 rmdir；所有 writes 走 enqueue chain
5. **`src/panel/panel.ts`**：import `AssetsService`（`../assets/service.js`）、构造（log/getCwd/getWorkspaceRoots/post）、5 case 路由、dispose()
6. **`webview/src/components/AssetCard.tsx`**（新建 `AssetSection`）：三组列表（命令/子代理/技能；name+scope chip+description+shadowed chip+bytes/updated）；详情子页（readAsset body `<pre>`）；编辑（textarea + hash 回包，conflict 提示）；新建（kind/scope radio + name + body textarea + frontmatter 模板 → createAsset）；删除（ConfirmDialog → deleteAsset）；requestId 过滤（陷阱 #29 纪律）
7. **`webview/src/components/SettingsModal.tsx`**：SettingsTab 新增 "assets"，TABS 条目（icon Sparkles，label「技能与命令»），render 行，import AssetSection
8. **`webview/src/store.ts`**：mock host 五个 handler（listAssets/readAsset/saveAsset/createAsset/deleteAsset 回包）+ unknown-message passthrough list 新增 4 类型

### C. 测试 + 验证
9. `test/mcp-catalog.test.ts`（catalog 数据 + builder 输出 shape）
10. `test/assets.test.ts`（host service 真 fs mkdtemp：scan 三 kind 格式解析、shadowed、save conflict、create exists-conflict、delete skill 目录清理、boundary 拒绝）
11. `test/assets-card.test.tsx`（jsdom UI：open 渲染三组、edit save、create、delete confirm、conflict）
12. `test/mcp-card.test.tsx` 扩展：模板目录 render + install flow（form → saveMcpServers payload 含 template config → saved flash）
13. 验证顺序：`npm run typecheck` → webview `npx tsc --noEmit` → 定向 vitest（新测试）→ `npm test`（broken-symlink 环境用例可忽略）→ frontend-tester 验证 UI

### 不做（scope 控制）
- 不 touch host saveMcpServers（reuse as-is）；不 add env-var 模板（无 key-required templates）；不 add en i18n entries（fallback 现状）；不 commit/CHANGELOG（未 asked）
