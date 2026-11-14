---
title: "Super Agent（主会话 + 多子会话 + worktree 隔离）"
created: 2026-11-09T10:40:10.257Z
session: be187d33-412f-4ce8-a51e-22b66cff4566
---

# Super Agent（主会话 + 多子会话 + worktree 隔离）

## 一、参考资料 → 本项目的取舍

| 来源机制 | 采纳 | 不采纳 / 原因 |
|---|---|---|
| Orca `worker_done` 必带 taskId+dispatchId、**恰好发一次** | 子会话终态由单一状态机裁决，终态不可回退（幂等护栏） | — |
| Orca worktree 一等公民 + 保留分支审查 | git worktree 隔离、分支命名、**分支有未合并提交时拒绝静默删** | `.worktreeinclude` 共享文件拷贝（v1 不做） |
| dsh Report 五态 + 结构化 `human_action` | `SuperReport{progress/ready/blocked/failed/dropped}` + `humanAction` | — |
| dsh `internal_only` vs `notify` | 内部进展只更新看板、不打扰主会话；仅 ready/blocked/failed/dropped 上报 | — |
| dsh「Worker 不能直接问人」 | 子会话的审批/提问**必须**经宿主，用户在看板就地应答 | 保留审批（项目安全底线），不照抄 danger-full-access |
| dsh Worker Slot + 人类额外槽 | 并发上限 4 + FIFO 排队（超出排队而非拒绝，满足「随时开启」） | — |
| DeepSeek「Router 只分派不执行」 | 主会话只做规划/汇报；子会话在独立 worktree 里改文件 | — |
| DeepSeek 订阅直通 / Watchdog | — | 形态不符，v1 不做 |

**硬约束**：CLI 内核的 agent→client 方法表（`BX`）是固定集合，新增原生工具须改 fork bundle（锚点漂移会硬失败、需重生成 code.js + 重 vendor）。**本方案内核零改动**，改用宿主侧委派指令协议。

## 二、架构（三层，遵循单向数据流）

```
webview/ SuperAgentBoard  ←── SessionState.superSessions（blockPatch tail 通道）──┐
   ↑ WebviewToHost: superAgent                                                        │
   │                                                                                  ↓
src/panel/panel.ts ──→ src/panel/super-agent.ts（编排） ──→ src/panel/worktree.ts（隔离）
                            └──→ src/acp/client.ts（每子会话一个独立 CLI 进程）
shared/super-agent.ts（纯逻辑：模型 / 状态机 / 指令解析 / 汇报文本）
```

## 三、关键机制

### 1. 主 Agent 如何自行开启子会话（委派指令协议）
主 Agent 在回复中输出闭合代码块，宿主**流式扫描**、命中即**立即**派发（不等本轮结束 → 满足「随时开启」）：

````
```super-agent
{"tasks":[{"title":"修复登录跳转","task":"修复 src/auth.ts 的登录跳转并补测试"}]}
```
````

- 扫描点：宿主 `onSessionUpdate` 的 `agent_message_chunk` 累积缓冲 + 消费偏移量去重（同一文本不会重复派发）；**仅扫描主客户端**，子会话文本不扫（禁止嵌套）。
- 系统提示词新增 `# Super Agent` 段说明协议（`prompts/system-prompt.md`，经 `IFLOW_SYSTEM_MD` 生效；loader 保留宿主正文，仅 `{{iflow:*}}` 令牌被替换）。
- **UI 兜底**：看板有「新建子会话」按钮，模型不配合也能用。
- JSON 非法 → 忽略并 toast「委派指令解析失败」（不静默）。

### 2. 文件隔离（git worktree）
- 每个子会话一个 worktree：`<globalStorage>/super-worktrees/<repoSlug>/<name>`，分支 `iflow/super/<name>`，base = 主仓 HEAD。
- 子会话 CLI 进程 `cwd = worktree 路径`，`allowedRoots = [worktree 路径]`（**不含主仓根**）→ CLI 侧 `--include-directories` 与宿主 `resolveAgentPath` 同源收窄，子代理**无法写主工作区**。
- 非 git 仓库 → 退化为独立空目录，看板明示「仅目录隔离」。
- 已知限制（诚实声明）：worktree 只含**已提交**内容，未提交/未跟踪文件对子会话不可见。

### 3. 子会话生命周期（状态机，终态不可回退）
`preparing → running → (awaiting_input) → completed | failed | cancelled`
每子会话 = 独立 CLI 进程 + 独立 ACP session；并发上限 4，超出进 FIFO 排队。

### 4. 上报主会话（双通道 + 用户处置）
- **通道 A 看板**：`SessionState.superSessions`（非 blocks 元数据，搭 blockPatch tail 通道，零协议改动）。
- **通道 B 主会话**：子会话进入 ready/blocked/failed/dropped → 宿主向**主会话**发 `session/prompt`，主 Agent 据此转述并决策。主会话 streaming 时延迟到空闲；多条汇报合并为一条（保序）。
- **待应答**：子会话的 `session/request_permission` / `_iflow/user/questions` / `_iflow/plan/exit` **不弹到主会话**，落到该子会话自己的 pending 槽位，看板就地应答；5 分钟超时自动拒绝（沿用主会话纪律）。
- 用户可：中断单个/全部、应答、**合并回当前分支**（`git merge --no-ff`，显式按钮 + 二次确认）、清理（保留分支/删 worktree）。

## 四、改动清单

**新增**
- `shared/super-agent.ts` — 子会话模型、状态机、委派指令解析、汇报文本（纯逻辑、零 VSCode 依赖）
- `src/panel/worktree.ts` — git worktree 增删查 + 分支未合并检测 + 路径命名（纯函数部分可单测）
- `src/panel/super-agent.ts` — `SuperAgentManager`：派发/中断/应答/清理、子 CLI 生命周期、并发池
- `webview/src/components/SuperAgentBoard.tsx` — 看板（只用 ui.tsx 套件控件）
- `test/super-agent.test.ts` / `test/worktree.test.ts` / `test/super-agent-panel.test.ts`

**修改**
- `shared/messages.ts` — `SessionState.superSessions` 字段；`WebviewToHost` 加 `superAgent` 消息
- `src/panel/panel.ts` — 装配 manager、指令扫描、汇报回主会话、webview 路由、dispose 时清理子进程与 worktree
- `webview/src/App.tsx` — 看板挂载在 transcript 容器内（`MessageList` 之前，不占 toast 栈底边距）
- `webview/src/i18n.ts` — 中英文案
- `prompts/system-prompt.md` — `# Super Agent` 协议段
- `AGENTS.md` / `CHANGELOG.md` — 架构与发布说明

## 五、验证
`npx vitest run <file>` → `npm run typecheck`（host + webview）→ `npm test` 全量 → `npx vite build webview` → frontend-tester 逐项点看板交互（展开/应答/中断/合并/清理）。

## 六、本版明确不做（诚实边界）
1. **原生 CLI 工具**（须改 fork bundle）→ 用委派指令文本协议 + UI 手动派发
2. worktree 自动合并 / PR 流程 → 只提供用户显式合并
3. 子会话共享依赖目录（`.worktreeinclude`）→ 子会话看不到未提交文件
4. 子会话转录落盘 → 只留摘要与报告历史
5. 多层嵌套子会话 → 只支持主→子一层
