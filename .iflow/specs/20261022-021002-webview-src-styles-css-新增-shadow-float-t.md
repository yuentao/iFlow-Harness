---
title: "`webview/src/styles.css`：新增 `--shadow-float` token（浅色 `:root` + 深色 `.dark`），并在 explicit utilities 块加 `.shadow-float { box-shadow: var(--shadow-float) }`；spread 收在胶囊高度内，修掉 `--shadow-panel` 的 -24px 在小胶囊上塌陷导致投影消失的问题。"
created: 2026-10-21T18:10:02.026Z
session: 9ff2efbf-546e-443d-8f46-87c9363d3099
---

1. `webview/src/styles.css`：新增 `--shadow-float` token（浅色 `:root` + 深色 `.dark`），并在 explicit utilities 块加 `.shadow-float { box-shadow: var(--shadow-float) }`；spread 收在胶囊高度内，修掉 `--shadow-panel` 的 -24px 在小胶囊上塌陷导致投影消失的问题。
2. `webview/src/components/MessageList.tsx`：底部浮层家族投影归一为 `shadow-float`（ToastPill 三种 tone、sticky tone 去掉 `card-lift`、生成中/恢复历史通知带、回到最新/展开更早 chip）；ToastCard「忽略」按钮改 `shadow-btn`。
3. `webview/src/components/ui.tsx`：HelpTip 改 `shadow-float`。
4. `test/notification-merge.test.tsx`：新增断言，浮层家族（含自动提取记忆等待 pill）统一带 `shadow-float` + `rounded-full`。
5. 验证：定向 vitest、`npm run typecheck`、`npx vite build webview` 产物 grep、全量 `npm test`、mock webview 浏览器实测深浅主题与 320px 窄屏（computed box-shadow 可见性 + 圆角 + 截图）。
