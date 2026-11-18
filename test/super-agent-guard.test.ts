import { describe, it, expect } from "vitest";
import {
  classifyChildShellCommand,
  classifyChildToolCall,
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

/**
 * 带「脚本文件读取能力」的上下文 —— 模拟宿主读子会话 worktree 里的脚本。
 *
 * 护栏本身零文件系统依赖，读取能力由宿主注入（这里是测试替身）。
 */
function ctxWithScripts(
  files: Record<string, string>,
  overrides: Partial<ChildShellGuardContext> = {},
): ChildShellGuardContext {
  return ctx({
    ...overrides,
    readLocalFile: (absolutePath: string) => {
      const probe = absolutePath.replace(/\\/g, "/").toLowerCase();
      const hit = Object.keys(files).find((name) => probe.endsWith(name.replace(/\\/g, "/").toLowerCase()));
      return hit ? files[hit]! : null;
    },
  });
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
    {
      name: "cmd /c 引号包裹的 npm ci（node_modules 是链接）",
      command: 'cmd /c "npm ci"',
      context: { nodeModulesIsLink: true },
    },
    {
      name: "powershell -c 引号包裹的 npm ci（node_modules 是链接）",
      command: 'powershell -c "npm ci"',
      context: { nodeModulesIsLink: true },
    },
    {
      name: "powershell -NoProfile -Command 引号包裹的删除 node_modules",
      command: 'powershell -NoProfile -Command "Remove-Item -Recurse -Force node_modules"',
    },
    {
      name: "bash -c 引号里先 cd 到主仓再安装",
      command: 'bash -c "cd J:/git/proj && npm ci"',
    },
    {
      name: "powershell -c 里的环境变量赋值与安装（分号分隔）",
      command: 'powershell -c "$env:FOO=1; npm ci"',
      context: { nodeModulesIsLink: true },
    },
    {
      // 取值型选项：第一个非选项词其实是 --prefix 的取值，子命令在它后面。
      name: "npm --prefix <主仓> ci（选项取值不能被当成子命令）",
      command: 'npm --prefix "J:\\git\\proj" ci',
    },
    {
      name: "pnpm --dir <主仓> install",
      command: 'pnpm --dir "J:\\git\\proj" install',
    },
    {
      name: "yarn --cwd <主仓> install",
      command: 'yarn --cwd "J:\\git\\proj" install',
    },
    {
      // 反向：布尔选项不能把后面的子命令一起吞掉。
      name: "npm --silent ci（布尔选项不遮挡子命令）",
      command: "npm --silent ci",
      context: { nodeModulesIsLink: true },
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
    {
      name: "回归：--prefix 指向自己的 worktree 且安装是子命令",
      command: `npm --prefix "${WORKTREE}" ci`,
    },
    { name: "删除非依赖目录", command: "rm -rf dist" },
    { name: "git clean（不涉及 node_modules）", command: "git clean -fdx" },
    { name: "node_modules_backup 不是 node_modules", command: "rm -rf node_modules_backup" },
    { name: "多段命令里的普通检查", command: "npm test; npm run typecheck" },
    { name: "空命令", command: "   " },
    {
      name: "包装命令里跑普通测试（解包后仍不是安装）",
      command: 'powershell -c "npm test"',
    },
    {
      name: "提交信息里出现 npm ci（只是文本，不是执行的命令）",
      command: 'git commit -m "fix: npm ci 联接事故"',
      context: { nodeModulesIsLink: true },
    },
    {
      name: "bash 跑脚本文件（没有内联命令开关，不解包）",
      command: "bash scripts/harness.mjs",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, ctx(testCase.context));
      expect(result.decision).toBe("allow");
      expect(result.reason).toBeUndefined();
    });
  }
});

describe("子会话 shell 护栏 · Node 内联脚本与脚本文件", () => {
  // 命令藏在 JS 里：命令文本里根本没有包管理器词，按词切分看不见。
  const inlineDenyCases: Array<{ name: string; command: string }> = [
    {
      name: "node -e 内联 execSync 跑 npm ci",
      command: `node -e "require('child_process').execSync('npm ci')"`,
    },
    {
      name: "node --eval 内联 spawnSync 跑 pnpm install（数组写法）",
      command: `node --eval "require('child_process').spawnSync('pnpm', ['install'])"`,
    },
    {
      name: "node -p 内联 execSync 跑 yarn add",
      command: `node -p "require('child_process').execSync('yarn add left-pad')"`,
    },
    {
      name: "node --eval= 内联跑 bun install",
      command: `node --eval="require('child_process').execSync('bun install')"`,
    },
    {
      name: "node -e 内联 execSync 建 junction 指向 node_modules",
      command: `node -e "require('child_process').execSync('mklink /J node_modules J:/git/proj/node_modules')"`,
    },
    {
      name: "node -e 内联 fs.symlinkSync 指向 node_modules",
      command: `node -e "require('fs').symlinkSync('J:/git/proj/node_modules','node_modules','junction')"`,
    },
  ];

  for (const testCase of inlineDenyCases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, ctx());
      expect(result.decision).toBe("deny");
      expect(result.reason).toBeTruthy();
    });
  }

  it("node <脚本文件> 内容含 npm ci → 拒绝", () => {
    const context = ctxWithScripts({
      "install-deps.js": "const { execSync } = require('child_process');\nexecSync('npm ci');\n",
    });
    const result = classifyChildShellCommand("node install-deps.js", context);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBeTruthy();
  });

  it("node <脚本文件> 内容含 mklink 建联接 → 拒绝", () => {
    const context = ctxWithScripts({
      "make-link.js":
        "require('child_process').execSync('mklink /J node_modules J:/git/proj/node_modules');\n",
    });
    const result = classifyChildShellCommand("node make-link.js", context);
    expect(result.decision).toBe("deny");
    expect(result.reason).toBeTruthy();
  });

  it("node <脚本文件> 内容用 fs.symlinkSync 指向 node_modules → 拒绝", () => {
    const context = ctxWithScripts({
      "link.cjs":
        "require('fs').symlinkSync('J:/git/proj/node_modules', 'node_modules', 'junction');\n",
    });
    const result = classifyChildShellCommand("node link.cjs", context);
    expect(result.decision).toBe("deny");
  });

  it("普通 node 脚本（无危险调用）→ 放行", () => {
    const context = ctxWithScripts({
      "build.js": "console.log('hello');\nrequire('child_process').execSync('git status');\n",
    });
    const result = classifyChildShellCommand("node build.js", context);
    expect(result.decision).toBe("allow");
    expect(result.reason).toBeUndefined();
  });

  it('node -e "require(\'child_process\').execSync(\'npm ci\')" → 拒绝', () => {
    const result = classifyChildShellCommand(
      `node -e "require('child_process').execSync('npm ci')"`,
      ctx(),
    );
    expect(result.decision).toBe("deny");
  });

  it("node 内联 mklink/junction 指向 node_modules → 拒绝", () => {
    const result = classifyChildShellCommand(
      `node -e "require('child_process').execSync('mklink /J node_modules J:/git/proj/node_modules')"`,
      ctx(),
    );
    expect(result.decision).toBe("deny");
  });

  it("普通 node <脚本文件> → 放行", () => {
    const context = ctxWithScripts({ "ordinary.js": "console.log('build');" });
    expect(classifyChildShellCommand("node ordinary.js", context).decision).toBe("allow");
  });

  it("cd 到 worktree 后 npm ci 且 node_modules 不是链接 → 放行", () => {
    expect(classifyChildShellCommand(`cd "${WORKTREE}" && npm ci`, ctx()).decision).toBe("allow");
  });

  it("脚本里只是提到 npm ci（不起子进程）→ 放行", () => {
    const context = ctxWithScripts({
      "docs.js": "console.log('run npm ci to install dependencies');\n",
    });
    const result = classifyChildShellCommand("node docs.js", context);
    expect(result.decision).toBe("allow");
  });

  it("脚本读不到（文件不存在 / 没给读取能力）→ 放行，不误伤正常用法", () => {
    const result = classifyChildShellCommand("node missing.js", ctx());
    expect(result.decision).toBe("allow");
    expect(result.reason).toBeUndefined();
  });

  it("脚本在工作目录之外 → 不读、不拦", () => {
    const context = ctxWithScripts({
      "outside.js": "require('child_process').execSync('npm ci');\n",
    });
    const result = classifyChildShellCommand("node ../outside.js", context);
    expect(result.decision).toBe("allow");
  });
});

describe("子会话 shell 护栏 · 嵌套壳解包", () => {
  it('cmd /c "npm ci"（联接存在）→ 拒绝', () => {
    const result = classifyChildShellCommand('cmd /c "npm ci"', ctx({ nodeModulesIsLink: true }));
    expect(result.decision).toBe("deny");
  });

  it('powershell -NoProfile -Command "npm ci"（联接存在）→ 拒绝', () => {
    const result = classifyChildShellCommand(
      'powershell -NoProfile -Command "npm ci"',
      ctx({ nodeModulesIsLink: true }),
    );
    expect(result.decision).toBe("deny");
  });

  it('bash -c "npm ci"（联接存在）→ 拒绝', () => {
    const result = classifyChildShellCommand('bash -c "npm ci"', ctx({ nodeModulesIsLink: true }));
    expect(result.decision).toBe("deny");
  });

  it('sh -c "npm ci"（联接存在）→ 拒绝', () => {
    const result = classifyChildShellCommand('sh -c "npm ci"', ctx({ nodeModulesIsLink: true }));
    expect(result.decision).toBe("deny");
  });

  it('cmd /c "npm ci"（没有联接）→ 放行：包装命令本身不是危险信号', () => {
    // 包装命令只是写法差异：内层 `npm ci` 在子会话自己的 worktree 里跑是
    // 允许的（子会话本来就没有依赖，要自己装）。危险来自「装到用户主工作区」
    // 或「node_modules 是联接」，不是来自 cmd /c 这个壳。
    const result = classifyChildShellCommand('cmd /c "npm ci"', ctx());
    expect(result.decision).toBe("allow");
  });
});

describe("子会话 shell 护栏 · 处置档位（severity）", () => {
  it("创建 node_modules 链接 → session 档（预检路径据此终止子会话）", () => {
    const result = classifyChildShellCommand(
      'mklink /J node_modules "J:\\git\\proj\\node_modules"',
      ctx(),
    );
    expect(result.decision).toBe("deny");
    expect(result.severity).toBe("session");
  });

  it("联接存在时的安装 → session 档", () => {
    const result = classifyChildShellCommand("npm ci", ctx({ nodeModulesIsLink: true }));
    expect(result.severity).toBe("session");
  });

  it("装到主工作区 → session 档", () => {
    const result = classifyChildShellCommand('npm install --prefix "J:\\git\\proj"', ctx());
    expect(result.severity).toBe("session");
  });

  it("删自己 worktree 里的 node_modules → tool 档（不因此杀掉子会话）", () => {
    const result = classifyChildShellCommand("rm -rf node_modules", ctx());
    expect(result.decision).toBe("deny");
    expect(result.severity).toBe("tool");
  });

  it("node 内联装依赖 → tool 档（装到哪儿看不见，但不明确动主工作区）", () => {
    const result = classifyChildShellCommand(
      `node -e "require('child_process').execSync('npm ci')"`,
      ctx(),
    );
    expect(result.decision).toBe("deny");
    expect(result.severity).toBe("tool");
  });

  it("node 内联装依赖 + worktree 已经是联接 → session 档", () => {
    const result = classifyChildShellCommand(
      `node -e "require('child_process').execSync('npm ci')"`,
      ctx({ nodeModulesIsLink: true }),
    );
    expect(result.severity).toBe("session");
  });
});

describe("子会话 shell 护栏 · repo 档（主仓工作区）的破坏性 git 命令", () => {
  /** repo 档上下文：cwd 就是主仓根，宿主显式标记 repoWorkspace。 */
  function repoCtx(overrides: Partial<ChildShellGuardContext> = {}): ChildShellGuardContext {
    return { cwd: REPO, repoRoot: REPO, repoWorkspace: true, ...overrides };
  }

  const denyCases: Array<{ name: string; command: string }> = [
    { name: "git reset --hard", command: "git reset --hard" },
    { name: "git reset --hard 到指定提交", command: "git reset --hard HEAD~3" },
    { name: "git -C <主仓> reset --hard（全局选项带取值）", command: `git -C "${REPO}" reset --hard` },
    { name: "git clean -fd", command: "git clean -fd" },
    { name: "git clean -fdx", command: "git clean -fdx" },
    { name: "git clean --force -d", command: "git clean --force -d" },
    { name: "git checkout -- .", command: "git checkout -- ." },
    { name: "git checkout .", command: "git checkout ." },
    { name: "git checkout -f", command: "git checkout -f" },
    { name: "git restore .", command: "git restore ." },
    { name: "cmd /c 包装的 git reset --hard", command: 'cmd /c "git reset --hard"' },
    { name: "powershell -c 包装的 git clean -fd", command: 'powershell -c "git clean -fd"' },
  ];

  for (const testCase of denyCases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, repoCtx());
      expect(result.decision).toBe("deny");
      expect(result.reason).toBeTruthy();
      // session 档：预检路径据此终止子会话（命令一跑就不可逆）。
      expect(result.severity).toBe("session");
      expect(result.reason).toContain("MAIN repository workspace");
    });
  }

  const allowCases: Array<{ name: string; command: string }> = [
    { name: "git status", command: "git status" },
    { name: "git diff --stat", command: "git diff --stat" },
    { name: "git log --oneline -3", command: "git log --oneline -3" },
    { name: "git add 单个文件", command: "git add a.txt" },
    { name: "git merge --no-ff <分支>（repo 档的授权操作）", command: "git merge --no-ff iflow/super/fix-login-abcd1234" },
    { name: "git clean -nd（dry-run 不删文件）", command: "git clean -nd" },
    { name: "git checkout -b <新分支>", command: "git checkout -b feature/x" },
    { name: "git restore --staged（只取消暂存）", command: "git restore --staged a.txt" },
    { name: "提交信息里出现 reset --hard（只是文本）", command: 'git commit -m "revert: undo git reset --hard"' },
  ];

  for (const testCase of allowCases) {
    it(testCase.name, () => {
      const result = classifyChildShellCommand(testCase.command, repoCtx());
      expect(result.decision).toBe("allow");
      expect(result.reason).toBeUndefined();
    });
  }

  it("worktree 档行为不变：同样的破坏性命令仍放行（毁掉的是自己的临时目录）", () => {
    for (const command of ["git reset --hard", "git clean -fd", "git checkout -- ."]) {
      const result = classifyChildShellCommand(command, ctx());
      expect(result.decision).toBe("allow");
    }
  });

  it("预检帧（tool_call_update in_progress）在 repo 档被拦下", () => {
    const verdict = classifyChildToolCall(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "run_shell_command",
        kind: "execute",
        status: "in_progress",
        title: "git clean -fd",
        args: { command: "git clean -fd" },
      },
      repoCtx(),
    );
    expect(verdict?.decision).toBe("deny");
    expect(verdict?.severity).toBe("session");
  });

  it("预检帧在 worktree 档不受影响", () => {
    const verdict = classifyChildToolCall(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "run_shell_command",
        kind: "execute",
        status: "in_progress",
        title: "git reset --hard",
        args: { command: "git reset --hard" },
      },
      ctx(),
    );
    expect(verdict?.decision).toBe("allow");
  });
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
