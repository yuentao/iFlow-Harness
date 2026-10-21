---
title: "wire：shared/messages.ts 的 toast 消息加 preview?: {text,scope}[]；src/panel/store.ts sendToast 透传。2. host：src/memory/service.ts 标题改「发现 {0} 条可记忆内容」、动作标签改「查看并确认」、附带最多 3 条 preview；l10n/bundle.l10n.en.json 同步英文。3. webview：store.ts ToastItem 加 preview 并透传；i18n.ts 加 4 个键；MessageList.tsx 新增 ToastCard（审批卡同族：acrylic/rounded-xl/glow-ring/card-lift + header eyebrow+标题+关闭 + preview 行带 scope chip + 动作行主按钮「查看并确认」与次按钮「忽略」+ 提示），无 preview 的 sticky 仍走 pill。4. 测试：notification-merge.test.tsx 记忆用例改卡片断言；memory-service.test.ts 标签与 preview 断言。5. 验证：定向 vitest、npm run typecheck、vite build + CSS 类检查、全量 npm test、frontend-tester 复核。"
created: 2026-10-21T16:34:39.948Z
session: 57586f73-19e1-468e-96e0-c9437c7f3088
---

1. wire：shared/messages.ts 的 toast 消息加 preview?: {text,scope}[]；src/panel/store.ts sendToast 透传。2. host：src/memory/service.ts 标题改「发现 {0} 条可记忆内容」、动作标签改「查看并确认」、附带最多 3 条 preview；l10n/bundle.l10n.en.json 同步英文。3. webview：store.ts ToastItem 加 preview 并透传；i18n.ts 加 4 个键；MessageList.tsx 新增 ToastCard（审批卡同族：acrylic/rounded-xl/glow-ring/card-lift + header eyebrow+标题+关闭 + preview 行带 scope chip + 动作行主按钮「查看并确认」与次按钮「忽略」+ 提示），无 preview 的 sticky 仍走 pill。4. 测试：notification-merge.test.tsx 记忆用例改卡片断言；memory-service.test.ts 标签与 preview 断言。5. 验证：定向 vitest、npm run typecheck、vite build + CSS 类检查、全量 npm test、frontend-tester 复核。
