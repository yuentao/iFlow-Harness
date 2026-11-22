import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPrompt } from "../prompts/index.js";
import { buildTaskPrompt } from "../src/panel/super-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const systemText = readFileSync(path.join(root, "prompts", "system-prompt.md"), "utf8");
const templateText = readFileSync(path.join(root, "prompts", "super-agent-task.md"), "utf8");
const managerSource = readFileSync(path.join(root, "src", "panel", "super-agent.ts"), "utf8");

const normalize = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\n+$/, "");

const worktreeBrief = (): string =>
  buildTaskPrompt("改登录", "干活", {
    kind: "git_worktree",
    path: "/tmp/wt",
    branch: "iflow/super/x",
    baseRef: "abc",
  });
const repoBrief = (): string => buildTaskPrompt("合并", "干活", { kind: "repo", path: "/ws" });
const dirBrief = (): string => buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });

/**
 * SA-3 权威口径的关键短句。system-prompt.md 的子会话子句与 worktree 档
 * describeSubmission() 必须逐字包含同一套短句——模型无论从系统提示还是从任务书
 * 读到，都得到同一条提交契约。`commits any changes you leave uncommitted` 与
 * `git add -A && git commit` 同时被 super-agent-manager.test.ts 依赖，不得改写。
 */
const CANONICAL_CONTRACT = [
  'git add -A && git commit -m "<message describing the change>"',
  "Commit only the files that belong to this task.",
  "Do not switch, rename or delete branches, and do not push, create a pull request or merge.",
  "commits any changes you leave uncommitted",
  "`super-agent: <title>` message before integrating",
  "If you fail or are interrupted the host deliberately does not commit",
  "cleaning up the worktree discards uncommitted changes",
];

describe("super agent · 提交契约三处对齐（SA-3）", () => {
  it("在盘 prompts/*.md 与运行时加载/内联的内容一致", () => {
    // system-prompt 会被 materialiseSystemPrompt 写到磁盘供 CLI 读取，
    // super-agent-task 由 esbuild/vitest 以文本内联——两者都必须与仓库文件逐字相同，
    // 否则测试校验的文本与实际发给模型的文本会悄悄分叉。
    expect(loadPrompt("system-prompt")).toBe(normalize(systemText));
    expect(loadPrompt("super-agent-task")).toBe(normalize(templateText));
  });

  it("子会话系统提示裁掉主会话编排段，保留角色锚点与全部动态 token", () => {
    const childText = readFileSync(path.join(root, "prompts", "system-prompt-child.md"), "utf8");
    // 与 system-prompt 一样：落盘文本必须和内联/运行时加载的内容逐字一致。
    expect(loadPrompt("system-prompt-child")).toBe(normalize(childText));

    // 去掉的是主会话专属编排段（约 5,198 tokens），不是整份提示。
    expect(childText).not.toContain("# Super Agent (managing child sessions)");
    expect(childText).not.toContain("**You are the orchestrator");
    expect(childText).not.toContain("## Hard prohibitions for the main session");

    // 必须保留子会话身份锚点，避免与汇报提示词里的主会话锚点互相误判。
    expect(childText).toContain("# Role (child session)");
    expect(childText).toContain("你是子会话（SubAgent），只完成委派给你的具体任务");
    expect(childText).toContain("不要派发子会话");

    // 动态段 token 一个都不能吞：子会话也要知道所在 worktree 的 cwd / 分支 / 环境。
    for (const token of [
      "{{iflow:Sandbox}}",
      "{{iflow:Git Repository}}",
      "{{iflow:Environment Information}}",
      "{{iflow:gitStatus}}",
    ]) {
      expect(childText, `child 系统提示缺少动态 token: ${token}`).toContain(token);
    }

    // 反向保护：主会话模板仍是完整版，没被 child 化。
    expect(systemText).toContain("# Super Agent (managing child sessions)");
  });

  it("任务书模板把 Submitting your work 声明为按隔离档生成的权威口径", () => {
    expect(templateText).toContain(
      "The `Submitting your work` section below is the authoritative submission contract",
    );
    expect(templateText).toContain("generated for your actual isolation mode");
    expect(templateText).toContain("{{submission}}");
  });

  it("system-prompt.md 的子会话子句与 worktree 档任务书逐字包含同一套契约短句", () => {
    const brief = worktreeBrief();
    for (const phrase of CANONICAL_CONTRACT) {
      expect(systemText, `system-prompt.md 缺少契约短句: ${phrase}`).toContain(phrase);
      expect(brief, `worktree 任务书缺少契约短句: ${phrase}`).toContain(phrase);
    }
  });

  it("旧的冲突措辞已全部消除", () => {
    // 「宿主只认提交 + 无前置条件地兜底」会误导模型以为失败/中断也有人代提交。
    expect(systemText).not.toContain("The host only merges commits");
    expect(systemText).not.toContain(
      "if you leave uncommitted changes behind, the host commits them on your behalf before integrating",
    );
    // 旧句漏了「不切分支/改名/删分支」，且提交消息占位符与任务书不一致。
    expect(systemText).not.toContain("Never push, merge or open pull requests");
    expect(systemText).not.toContain("<what changed>");
    // repo 档 / directory 档专用的否定句不得串进 worktree 任务书。
    expect(worktreeBrief()).not.toContain("do not create commits of your own");
    expect(worktreeBrief()).not.toContain("not a git repository: do not commit");
  });

  it("三档隔离的提交契约互不串味", () => {
    const wt = worktreeBrief();
    const repo = repoBrief();
    const dir = dirBrief();

    // worktree：完成前自己提交，宿主仅正常完成兜底，不切分支/不推送/不建 PR。
    for (const phrase of CANONICAL_CONTRACT) expect(wt).toContain(phrase);
    expect(wt).toContain("do not push");

    // repo / 合并档：合并提交就是交付物，绝不自己提交，也不许 git add -A。
    expect(repo).toContain("do not create commits of your own");
    expect(repo).toContain("`git add -A`");
    expect(repo).not.toContain("git add -A && git commit");
    expect(repo).not.toContain("super-agent: <title>");

    // 目录隔离档：没有 git，别碰 git 命令，也别指望兜底提交。
    expect(dir).toContain("do not run git commands");
    expect(dir).not.toContain("git add -A && git commit");
    expect(dir).not.toContain("super-agent: <title>");
  });

  it("文本口径与宿主实际提交行为一致（以代码为准）", () => {
    // 兜底提交只在 git worktree 发生：其它档 commitChildWork 直接返回未提交。
    expect(managerSource).toContain('isolation.kind !== "git_worktree"');
    // 兜底提交消息 = super-agent: <标题> + 摘要（与 `super-agent: <title>` 口径一致）。
    expect(managerSource).toContain('message: `super-agent: ${session.title}');
    // 失败/中断刻意不提交：收尾守卫在入口挡住，返回 interrupted。
    expect(managerSource).toContain("if (!this.canSettle(id, attempt))");
    expect(managerSource).toContain("return { committed: false, files: 0, interrupted: true };");
    // 只有正常完成（无条件分支）才调用 commitChildWork。
    expect(managerSource).toContain("const commit = await this.commitChildWork(id, isolation, attempt);");
  });
});

describe("子会话任务书 · 附件说明（多模态方案 C）", () => {
  it("附件清单带上用户说明，无说明时不追加破折号", () => {
    const brief = buildTaskPrompt("看图", "干活", { kind: "directory", path: "/tmp/dir" }, {
      copies: [
        { name: "image1.png", path: "/tmp/att/image1.png", caption: "报错弹窗" },
        { name: "image2.png", path: "/tmp/att/image2.png" },
      ],
      images: [],
      failures: [],
    });
    expect(brief).toContain("- image1.png → /tmp/att/image1.png — 报错弹窗");
    expect(brief).toContain("- image2.png → /tmp/att/image2.png\n");
    expect(brief).not.toContain("- image2.png → /tmp/att/image2.png —");
    // 模板里明确告诉子会话：说明来自用户，用来对应图片顺序。
    expect(brief).toContain("Any attachment caption comes from the user");
  });
});
