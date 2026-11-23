# 子会话项目纪律（精简下发 · 替代工作区 AGENTS.md 全文）

你在独立 worktree 与 CLI 进程中运行，只完成委派给你的具体任务；**不要派发更下级子会话**，也不要操作主会话的看板、合并/重试/上报车道。实现完成前在自己的分支提交，再把结论作为最终回答返回。

## 分层与类型

- 纯逻辑放 `shared/` 或 `src/acp/jsonrpc.ts`（零 VSCode 依赖）；状态变更走 `shared/session-state.ts` 的 reducer，不要在 panel.ts 里就地改 state。
- 新增 wire 消息必须同时更新 `shared/messages.ts` 的 `WebviewToHost` / `HostToWebview`，两侧共用。
- TypeScript strict + `noUncheckedIndexedAccess`；Node16 模块解析，import 必须带 `.js` 扩展名；webview 有独立 tsconfig（Bundler resolution），不参与主 typecheck。
- 控件统一收敛到 `webview/src/components/ui.tsx`；原生控件仅 Composer 提示输入 textarea 一处例外。禁止 `text-[Npx]` / `rounded-[Npx]` 任意值。

## 隔离与安全

- 只在自己的 worktree 内读写；绝不碰主工作区或其它子会话目录，不做破坏性 git 命令（`reset --hard` / `clean -fd` / `checkout -- .`）。
- 遵守 `allowedRoots` / `--include-directories` 同源边界；执行类工具（shell）不受路径围栏约束，别用它绕过工作区边界。
- API key 只存 SecretStorage，不落盘、不进日志；写 `~/.iflow/settings.json` 用 tmp + 覆盖式 rename，不要先 unlink。
- `npm ci` 绝不能与指向主仓 `node_modules` 的目录联接共存（会删除主仓依赖）；需要真装依赖时先删联接再在自己的 worktree 里 `npm ci`。

## 内置 CLI 与锚点

- 执行体是 vendor 内置裁剪 CLI，不做 PATH/npm 探测；改 vendor 必须同步回本地 fork 源快照，并跑 `npm run harness` 验收后才能算闭环。
- mod 注入点靠字符串常量定位，不依赖行号/混淆标识符；锚点必须唯一 + round-trip 校验。loader 缺失/抛错静默回退上游，stdout 永不 console（NDJSON wire）。
- 子会话免确认（host 直接放行审批/Plan 退出），但提问会落到子会话自己的看板槽位；工作目录隔离之外没有额外沙箱，如实标注。

## 验证与提交

- 提交前依次 `npm run typecheck` → 定向 `npx vitest run <file>` → `npm run build`；时间允许再跑全量 `npx vitest run`。
- Windows 上 `attachments.test.ts` 的 broken-symlink EPERM 属环境限制，不是回归；全量回归不要用 `--no-isolate`（mock 会跨文件串味）。
- 完成前在自己的分支 `git add -A && git commit`；不要 push、不要建 PR、不要切分支。
