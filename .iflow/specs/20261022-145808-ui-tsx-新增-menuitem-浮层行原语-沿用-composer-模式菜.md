---
title: "ui.tsx 新增 MenuItem 浮层行原语（沿用 Composer 模式菜单样式：主文案 + 副描述 + 选中勾标 + danger/disabled 档位），选中项 role=\"menuitemradio\" + aria-checked。"
created: 2026-10-22T06:58:08.945Z
session: 30c8ec7c-5e8e-47a7-bf76-ac6cb1be6c4c
---

1. ui.tsx 新增 MenuItem 浮层行原语（沿用 Composer 模式菜单样式：主文案 + 副描述 + 选中勾标 + danger/disabled 档位），选中项 role="menuitemradio" + aria-checked。
2. ui.tsx 重写 Select 为 Dropdown + MenuItem 自定义浮层：BTN_INPUT 字段材质触发器 + ChevronDown，size md/sm 两档，aria-haspopup/aria-expanded/ariaLabel，菜单 min-w-full + 视口夹取，onChange(value) 套件惯例，options 支持 description，新增 wrapperClass；移除原生 select 与 SelectHTMLAttributes 导入，加 ChevronDown 导入。
3. ui.tsx Dropdown：菜单项选择器扩到 menuitemradio/menuitemcheckbox，初始焦点优先落在 aria-checked="true"。
4. 迁移调用点：ApprovalPolicyCard（ariaLabel）、MemoryCard（wrapperClass 收缩）、MemoryReviewDialog（size=sm）、Composer 模式菜单改用 MenuItem（视觉与逻辑不变）。
5. test/ui-kit-guard.test.ts 导出清单加 MenuItem/SelectOption，跑定向单测。
6. 验证：webview tsc、vite build、ui-kit-guard、npm test；frontend-tester 在 mock webview 验收三个下拉 + 模式菜单（深浅主题、320px 夹取、键盘导航）。
不新增 i18n 键、不改模型下拉与 Dropdown 外壳材质。
