---
title: "在 webview/src/components/ui.tsx 建立统一控件套件（Button/IconButton/TextInput/CommitInput/CommitNumberInput/TextArea/Select/SearchInput/Switch/Checkbox/OptionGroup/ToggleChip/Slider/TabButton/FloatPill/Toast），全部复用项目既有设计语言（五档圆角、五档字号 token、4px 间距网格、两档控件高度、oklch 色板、亚克力材质、既有阴影/动效 token、三档图标、i18n 术语）；styles.css 仅补 .ui-slider/.ui-checkbox（值取自既有 token）；串行迁移 16 个调用点文件；新增 test/ui-kit-guard.test.ts 守卫（禁原生控件绕过套件、禁重复按钮渐变、禁任意字号/圆角）+ knip；验证 webview tsc / vite build / vitest / knip / frontend-tester；在 AGENTS.md 沉淀控件体系规范。"
created: 2026-10-21T18:46:54.896Z
session: 30c8ec7c-5e8e-47a7-bf76-ac6cb1be6c4c
---

在 webview/src/components/ui.tsx 建立统一控件套件（Button/IconButton/TextInput/CommitInput/CommitNumberInput/TextArea/Select/SearchInput/Switch/Checkbox/OptionGroup/ToggleChip/Slider/TabButton/FloatPill/Toast），全部复用项目既有设计语言（五档圆角、五档字号 token、4px 间距网格、两档控件高度、oklch 色板、亚克力材质、既有阴影/动效 token、三档图标、i18n 术语）；styles.css 仅补 .ui-slider/.ui-checkbox（值取自既有 token）；串行迁移 16 个调用点文件；新增 test/ui-kit-guard.test.ts 守卫（禁原生控件绕过套件、禁重复按钮渐变、禁任意字号/圆角）+ knip；验证 webview tsc / vite build / vitest / knip / frontend-tester；在 AGENTS.md 沉淀控件体系规范。
