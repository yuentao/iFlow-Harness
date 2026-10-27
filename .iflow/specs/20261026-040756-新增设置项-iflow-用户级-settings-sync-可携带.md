---
title: "新增设置项（`iflow.*`，用户级，Settings Sync 可携带）"
created: 2026-10-25T20:07:56.393Z
session: f1e93dea-ec65-4a38-9e75-267654ff9f56
---

## 新增设置项（`iflow.*`，用户级，Settings Sync 可携带）

| 设置键 | 默认 | 范围 | 语义 |
|---|---|---|---|
| `iflow.memoryExtractTimeoutSeconds` | 90 | 0–600 | 0 = 不限制 |
| `iflow.nextStepTimeoutSeconds` | 25 | 0–300 | 0 = 不限制 |
| `iflow.compressTimeoutSeconds` | 0 | 0–600 | 0 = 不限制 |
| `iflow.autoCompressThresholdPercent` | 95 | 50–100 | 回合末自动压缩的上下文占用阈值（%） |

默认值全部沿用现状 → 运行时行为零回归。

## 改动清单

**1. `src/acp/complete.ts`** — `timeoutMs`/`idleMs` 为 0 时不装定时器（当前 `setTimeout(fn, 0)` 会立刻触发，把「不限制」变成「立即超时」，必须先修）。

**2. `src/acp/jsonrpc.ts`** — 新增导出 `isRequestTimeoutError()`：识别本地看门狗拒绝（`Request timed out after <n>ms: <method>`）。

**3. `shared/messages.ts`** — `HostSettingsUi` 增 4 个字段。

**4. `src/panel/panel.ts`（主改动）**
- 配置读取助手（clamp 到区间）：`timeoutSeconds()` / `memoryExtractTimeoutMs()` / `nextStepTimeoutMs()` / `compressTimeoutMs()` / `autoCompressThresholdRatio()`。
- `followupCeiling()`：每 task 上限读配置；任一 task 为 0 → 整个合并请求无墙钟上限且关闭 idle 看门狗；task 上限 > 0 时 idle = min(该 task 默认 idle, 上限/2)。默认值下与现状一致。
- `maybeAutoCompressOnIdle()`：阈值读 `autoCompressThresholdPercent`。
- `promptWithRetry()`：`isCompressAttempt` 提到循环作用域；压缩轮走 `client.prompt(request, timeoutMs)` per-call 超时；超时 → `client.cancel(sessionId)` + 抛 `CompressTimeoutError`。
- `runCompressTurn()` / `maybeAutoCompressOnIdle()` catch：超时 → 警告 toast，不升级成错误横幅。
- `postHostSettings()` / `setHostSettings`：承载并校验 4 个值。

**5. `webview/src/store.ts`** — `DEFAULT_HOST_SETTINGS` 增 4 个字段。

**6. `webview/src/components/SettingsModal.tsx`** — `ChatSection`：3 个 `NumberRow`（秒，0 = 不限制）+ 1 个 `RangeRow`（Slider 50–100 步进 5）。

**7. 文案** — `package.json` + `package.nls.json` + `package.nls.zh-cn.json` + `l10n/bundle.l10n.en.json` + `webview/src/i18n.ts`。

**8. 测试** — 更新两个 base settings 对象；新增定向用例（配置驱动上限、0 = 不装定时器、idle 收敛、压缩超时 cancel + CompressTimeoutError、阈值可配置）。

## 取舍

- 回合末三个任务合并成一次请求，上限取「所携带任务中最宽松的」；任一任务设 0 → 整个合并请求不设限（标题任务 180s 兜底随之失效，合并设计的必然结果）。
- 压缩超时默认 0：压缩超大历史会话本来就可能跑很久（陷阱 #13 不得静默掐断长任务）。
