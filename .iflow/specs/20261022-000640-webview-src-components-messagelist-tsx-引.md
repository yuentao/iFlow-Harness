---
title: "`webview/src/components/MessageList.tsx`：引入 `ICON_INLINE`；新增 `TOAST_ACTION_ICON`（memory-review → Brain）；重写 `ToastPill` 为单一浮层外壳（rounded-xl + acrylic-pop / 色调底 + shadow-panel、text-ui-label、px-3 py-2）、动作按钮 h-6 px-2.5（sticky 用主渐变）、关闭按钮 size-6、等待态 Loader2 旋转；保留原有可点性与嵌套按钮纪律。2. `test/notification-merge.test.tsx`：toneOf 支持 rounded-xl、idle 断言改 rounded-xl、新增记忆候选与提取中 pill 的图标/控件断言。3. 验证：webview tsc、定向 vitest、npm run typecheck、vite build、frontend-tester 复核。"
created: 2026-10-21T16:06:40.203Z
session: 57586f73-19e1-468e-96e0-c9437c7f3088
---

1. `webview/src/components/MessageList.tsx`：引入 `ICON_INLINE`；新增 `TOAST_ACTION_ICON`（memory-review → Brain）；重写 `ToastPill` 为单一浮层外壳（rounded-xl + acrylic-pop / 色调底 + shadow-panel、text-ui-label、px-3 py-2）、动作按钮 h-6 px-2.5（sticky 用主渐变）、关闭按钮 size-6、等待态 Loader2 旋转；保留原有可点性与嵌套按钮纪律。2. `test/notification-merge.test.tsx`：toneOf 支持 rounded-xl、idle 断言改 rounded-xl、新增记忆候选与提取中 pill 的图标/控件断言。3. 验证：webview tsc、定向 vitest、npm run typecheck、vite build、frontend-tester 复核。
