import { describe, it, expect } from "vitest";
import {
  classifyChildShellCommand,
  extractShellCommand,
  isShellToolCall,
  pickChildPermissionOption,
  type ChildShellGuardContext,
} from "../shared/super-agent-guard.js";

/** 主工作区（用户自己的仓库，装着用户的 node_modules）。 */
const REPO = "J:\\git\\proj";
/** 子会话的 worktree —— 刻意放在主仓里面（`.iflow/super/worktrees/...`），与真实布局一致。 */
const WORKTREE = "J:\\git\\proj\\.iflow\\super\\worktrees\\fix-login-abcd1234";

function ctx(overrides: Partial<ChildShellGuardContext> = {}): ChildShellGuardContext {
  return { cwd: WORKTREE, repoRoot: REPO, ...overrides };
}

describe("子会话 shell 护栏 · 拒绝", () => {
  const cases: Array<{
    name: string;
    command: string;
    context?: Partial<ChildShellGuardContext>;
  }> = [
    {
      name: "mklink /J 把 node_modules 联接到主仓",
      command: 'mklink /J node_modules "J:\\git\\proj\\node_modules"',
    },
    {
      name: "cmd /c mklink /D 相对路径指向主仓依赖",
      command: "cmd /c mklink /D node_modules ..\\..\\..\\..\\node_modules",
    },
    {
      name: "New-Item -ItemType Junction 创建目录联接",
      command:
        "New-Item -ItemType Junction -Path node_modules -Target J:\\git\\proj\\node_modules",
    },
    {
      name: "ln -s 创建符号链接",
      command: "ln -s /srv/proj/node_modules node_modules",
    },
    {
      name: "junction.exe（Sysinternals）创建联接",
      command: "junction node_modules J:\\git\\proj\\node_modules",
    },
    {
      name: "worktree 的 node_modules 是链接时 npm ci",
      command: "npm ci",
      context: { nodeModulesIsLink: true },
    },
    {
      name: "worktree 的 node_modules 是链接时 pnpm install",
      command: "pnpm install",
      context: { nodeModulesIsLink: true },
    },
    {
      name: "worktree 的 node_modules 是链接时 npm i",
      command: "npm i --no-audit",
      context: { nodeModulesIsLink: true },
    },
    {
      name: "worktree 的 node_modules 是链接时裸 yarn",
      command: "yarn --frozen-lockfile",
      context: { nodeModulesIsLink: true },
    },
    {
      name: "install 命令里出现主工作区根路径",
      command: 'npm install --prefix "J:\\git\\proj"',
    },
    {
      name: "npm ci 带主仓路径（正斜杠）",
      command: "npm ci --prefix=J:/git/proj",
    },
    {
      name: "cd 到主工作区后执行 npm ci",
      command: 'cd "J:\\git\\proj"; npm ci',
    },
    {
      name: "相对 cd 四层回到主仓根后安装",
      command: "cd ..\\..\\..\\..; npm install",
    },
    {
      name: "子会话本身就跑在主仓工作区（合并子会话）",
      command: "npm ci",
      context: { cwd: REPO },
    },
    {
      name: "rm -rf node_modules",
      command: "rm -rf node_modules",
    },
    {
      name: "rmdir /s node_modules",
      command: "rmdir /s /q node_modules",
    },
    {
      name: "Remove-Item -Recurse node_modules",
      command: "Remove-Item -Recurse -Force node_modules",
    },
    {
      name: "删除链过去的 node_modules 子目录",
      command: "rm -rf node_modules/.cache",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, ctx(testCase.context));
      expect(result.decision).toBe("deny");
      expect(result.reason).toBeTruthy();
    });
  }
});

describe("子会话 shell 护栏 · 放行", () => {
  const cases: Array<{
    name: string;
    command: string;
    context?: Partial<ChildShellGuardContext>;
  }> = [
    { name: "npm run typecheck", command: "npm run typecheck" },
    { name: "npm test", command: "npm test" },
    { name: "npx vitest run", command: "npx vitest run test/super-agent-guard.test.ts" },
    { name: "node 脚本", command: "node scripts/harness.mjs" },
    { name: "git status", command: "git status" },
    { name: "tsc --noEmit", command: "tsc --noEmit" },
    { name: "yarn run build", command: "yarn run build" },
    { name: "pnpm exec vitest", command: "pnpm exec vitest run" },
    {
      name: "回归：worktree 内自装依赖（node_modules 不是链接）",
      command: "npm ci",
    },
    {
      name: "回归：命令里带自己的 worktree 路径也算自装",
      command: `cd "${WORKTREE}"; npm ci`,
    },
    {
      name: "回归：--prefix 指向自己的 worktree",
      command: `npm install --prefix "${WORKTREE}"`,
    },
    { name: "删除非依赖目录", command: "rm -rf dist" },
    { name: "git clean（不涉及 node_modules）", command: "git clean -fdx" },
    { name: "node_modules_backup 不是 node_modules", command: "rm -rf node_modules_backup" },
    { name: "多段命令里的普通检查", command: "npm test; npm run typecheck" },
    { name: "空命令", command: "   " },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, ctx(testCase.context));
      expect(result.decision).toBe("allow");
      expect(result.reason).toBeUndefined();
    });
  }
});

describe("子会话 shell 护栏 · 工具识别与命令提取", () => {
  it("run_shell_command 是 shell 工具", () => {
    expect(isShellToolCall({ toolName: "run_shell_command" })).toBe(true);
  });

  it("kind === execute 视为 shell 类（工具名可能变）", () => {
    expect(isShellToolCall({ toolName: "some_mcp_tool", kind: "execute" })).toBe(true);
  });

  it("名字里带 shell / terminal 的 MCP 工具也算", () => {
    expect(isShellToolCall({ toolName: "terminal_exec" })).toBe(true);
    expect(isShellToolCall({ toolName: "execute_shell" })).toBe(true);
  });

  it("write_file / read_file 不是 shell 工具", () => {
    expect(isShellToolCall({ toolName: "write_file", kind: "edit" })).toBe(false);
    expect(isShellToolCall({ toolName: "read_file", kind: "read" })).toBe(false);
  });

  it("从 args.command 取命令（live wire 形态）", () => {
    expect(
      extractShellCommand({ args: { command: "npm ci", description: "install" } }),
    ).toBe("npm ci");
  });

  it("从 title 取命令（shell 工具的 title 就是命令行）", () => {
    expect(extractShellCommand({ title: "npm ci" })).toBe("npm ci");
  });

  it("取不到命令时返回 null（无法判定就不假装拦得住）", () => {
    expect(extractShellCommand({})).toBeNull();
    expect(extractShellCommand({ title: "   " })).toBeNull();
  });
});

describe("子会话 shell 护栏 · 审批选项", () => {
  const options = [
    { optionId: "once", name: "允许一次", kind: "allow_once" },
    { optionId: "always", name: "始终允许", kind: "allow_always" },
    { optionId: "deny", name: "拒绝", kind: "reject_once" },
  ];

  it("shell 工具必须回 allow_once —— 否则 CLI 后续调用不再问宿主，护栏失明", () => {
    expect(pickChildPermissionOption(options, true)?.optionId).toBe("once");
  });

  it("非 shell 工具维持 allow_always（少打扰）", () => {
    expect(pickChildPermissionOption(options, false)?.optionId).toBe("always");
  });

  it("shell 工具没有 allow_once 时不回落到 allow_always", () => {
    expect(pickChildPermissionOption([options[1]!, options[2]!], true)).toBeUndefined();
  });

  it("非 shell 工具没有 allow_always 时退到任意允许项", () => {
    expect(pickChildPermissionOption([options[0]!], false)?.optionId).toBe("once");
  });
});
