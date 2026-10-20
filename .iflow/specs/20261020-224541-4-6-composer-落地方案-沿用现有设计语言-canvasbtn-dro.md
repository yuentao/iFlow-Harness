---
title: "4.6 Composer 落地方案（沿用现有设计语言：CANVAS_BTN/Dropdown/语义字号 token/圆角 5 档/24-28px 点击区）"
created: 2026-10-20T14:45:41.005Z
session: 51624b14-dc64-43b0-915c-c6e0df49800b
---

## 4.6 Composer 落地方案（沿用现有设计语言：CANVAS_BTN/Dropdown/语义字号 token/圆角 5 档/24-28px 点击区）

已核对现状：占位符「向 iFlow 提问…」与空状态底部提示（4.6 第 1 条）**已落地**，本轮不动。

### 1. 一行 7 控件 → 4 控件（P0/P1）
- **思考级别移入模型菜单底部**：删除独立思考下拉，在模型菜单末尾加 `分隔线 + 「思考级别」小标题 + 4 行（沿用现有行样式与 thinkUnsupported 置灰）`。
  - 取舍说明：模型菜单在 `controlsLocked`（含生成中）整体禁用，因此**生成中将无法改思考级别**（现状可以）。模式/模型/思考同属会话级设置，生成中改思考对当轮几乎无效，按 spec 优先「操作区从仪表盘变输入栏」。
- **用量并入模型 chip**：`SessionUsageChip` 移进模型触发器内部（仍是独立组件、仍按原语订阅，避免整 Composer 每 500ms 重渲染）；模型菜单底部加一段用量摘要（上下文占用 / ↑↓ / 预估成本），满足「点击看用量详情」。
- **增强按需出现**：仅在有文本、增强中或可还原时渲染，空输入不再占一个禁用按钮位。
- 结果：模式 · 模型(含用量+思考) · 附件 · 发送/停止。

### 2. 模型下拉信息一致（P1/P2）
- 触发器显示 **name**（无 name 回退 id），去掉 `font-mono`；菜单行改**主行 name + 次行 mono id**（与权限模式菜单的两行结构一致）。
- 搜索框仅 `models.length > 8` 时渲染（Dropdown 已有「菜单内含 input 则不抢焦点」逻辑，无需改 ui.tsx）。

### 3. 上下文卡折叠为 chip（P1）
- 默认单行 chip：`图标 + 名称 + 范围(detail) + 大小(字符数，复用「{0} 字符」) + 移除`，样式对齐附件 chip（rounded-lg / border-border / bg-surface/80 / shadow-card）。
- 点击 chip 展开/收起预览，预览沿用现有 `<pre>`（code max-h-40、其他 max-h-24）。
- 最多显示 3 张，其余收成「+N」chip，点击展开全部。

### 4. 建议 chip 中性化（P2）
- `border-primary/30 bg-primary/10` → `border-border bg-surface/70 hover:bg-surface-2`；标签「下一步」→「建议」；最多 3 条；关闭按钮点击区提到 24px。

### 5. 内联 note 通道 → toast（P1）
- `store.ts` 新增 `notify(message, level?)`：本地 toast，4s 自动消失，复用现有 `ToastItem` / `Toasts` 渲染栈（单一通知通道）。
- Composer 删除 `note` state、`showNote`、note 行，8 处调用改 `notify`；`test/composer-history.test.tsx` 的 useChat mock 补 `notify`。

### 6. 点击区（P1）
- 附件 chip 移除、图片移除（16px→24px）、队列行 5 个操作（12px→24px）统一 24px 点击区，图标保持 14px。

### 7. 排队占位符（P2）
- `生成中/规划中/压缩中 · Enter 排队发送` → 统一 **「排队发送（Enter）」**；状态由发送按钮（排队态）与顶栏表达。随之删除 `compressing` 订阅与 `isPlanMode` 导入。

### 8. i18n 收尾
- 新增：`建议`、`排队发送（Enter）`、`用量`、`还有 {0} 张`（+N chip）等；删除已无引用的 `生成中/规划中/压缩中 · Enter 排队发送`、`下一步`。

### 9. 验证
`cd webview && npx tsc --noEmit` → `npx vitest run test/composer-history.test.tsx` → `npm test` → `npm run webview:dev` 构建 → **frontend-tester** 在 mock webview 逐项点验（4 控件行、模型菜单含思考+用量、上下文 chip 展开/+N、建议中性 chip、note 走 toast、24px 点击区、排队占位符、300/360/480px 无溢出）。

不改动：host 侧协议、`shared/`、发送/排队/增强/@补全等既有行为逻辑。
