/**
 * 多仓库协作 MVP 的纯逻辑测试：根列表单一来源（realpath + 去重 + 稳定排序）、
 * 别名分配、会话级目标根子集（`settings.add_dirs`）、@ 提及的根前缀还原、
 * 以及投影的 three-state（selected / applied / pendingChange）。
 *
 * 全部通过注入 realpath / 直接构造根列表完成，不碰磁盘。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  aliasForRootPath,
  buildAddDirs,
  buildWorkspaceRootsUi,
  collectWorkspaceRoots,
  normalizeSelection,
  rewriteRootMentions,
  workspaceRootsFrom,
} from "../src/panel/workspace-roots.js";

const abs = (p: string): string => path.resolve(p);

describe("collectWorkspaceRoots", () => {
  it("按 realpath 去重，并保持第一个工作区文件夹在最前", () => {
    const target = abs("repo-a");
    const alias = abs("repo-a-link");
    const realpath = (p: string): string => (p === alias ? target : p);
    const roots = collectWorkspaceRoots([alias, abs("repo-c"), abs("repo-b"), target], realpath);
    // 前两项（alias 与 target）realpath 后同一个目录 → 去重成一项，且它是第 0 项。
    expect(roots.map((r) => r.path)).toEqual([target, abs("repo-b"), abs("repo-c")]);
    expect(roots[0]!.name).toBe("repo-a");
  });

  it("其余根按路径稳定排序（大小写不敏感）", () => {
    const roots = collectWorkspaceRoots([abs("zeta"), abs("Alpha"), abs("beta")]);
    expect(roots.slice(1).map((r) => r.path)).toEqual([abs("Alpha"), abs("beta")]);
  });

  it("重复别名加序号（web / web-2）", () => {
    const roots = collectWorkspaceRoots([abs("one/web"), abs("two/web")]);
    expect(roots.map((r) => r.name)).toEqual(["web", "web-2"]);
  });

  it("realpath 失败时回退词法路径，不丢根", () => {
    const missing = path.join(abs("nonexistent-root-xyz"), "child");
    const roots = collectWorkspaceRoots([missing]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.path).toBe(missing);
  });

  it("空输入得到空列表；workspaceRootsFrom 读取 workspaceFolders", () => {
    expect(collectWorkspaceRoots([])).toEqual([]);
    const roots = workspaceRootsFrom(
      { workspaceFolders: [{ uri: { fsPath: abs("repo-x") } }] },
      (p) => p,
    );
    expect(roots).toEqual([{ path: abs("repo-x"), name: "repo-x" }]);
    expect(workspaceRootsFrom({}, (p) => p)).toEqual([]);
  });
});

describe("aliasForRootPath", () => {
  it("把空格与非法字符归一为 -，空名回退 root", () => {
    expect(aliasForRootPath(path.join(abs("x"), "my repo"))).toBe("my-repo");
    expect(aliasForRootPath(path.join(abs("x"), "项目"))).toBe("root");
  });
});

describe("normalizeSelection", () => {
  const roots = collectWorkspaceRoots([abs("a"), abs("b"), abs("c")]);

  it("null 表示全量根", () => {
    expect(normalizeSelection(null, roots)).toEqual(roots.map((r) => r.path));
  });

  it("丢弃未知路径并按根顺序返回", () => {
    expect(normalizeSelection([abs("c"), abs("zzz"), abs("a")], roots)).toEqual([
      abs("a"),
      abs("c"),
    ]);
  });

  it("空数组保持空（交给调用方决定语义）", () => {
    expect(normalizeSelection([], roots)).toEqual([]);
  });
});

describe("buildAddDirs", () => {
  const roots = collectWorkspaceRoots([abs("a"), abs("b"), abs("c")]);
  const cwd = abs("a");

  it("未选 / 空列表 → null（与今天完全一致，不写 add_dirs）", () => {
    expect(buildAddDirs(null, roots, cwd)).toBeNull();
    expect(buildAddDirs(undefined, roots, cwd)).toBeNull();
    expect(buildAddDirs([], roots, cwd)).toBeNull();
  });

  it("全选 → null（等价于今天的全量根）", () => {
    expect(buildAddDirs(roots.map((r) => r.path), roots, cwd)).toBeNull();
  });

  it("严格子集 → 收紧为该子集减去 cwd", () => {
    expect(buildAddDirs([abs("a"), abs("b")], roots, cwd)).toEqual([abs("b")]);
  });

  it("只选 cwd → 空数组（CLI 只看得到 cwd，合法收紧）", () => {
    expect(buildAddDirs([abs("a")], roots, cwd)).toEqual([]);
  });

  it("单根工作区永不收紧", () => {
    const single = collectWorkspaceRoots([abs("a")]);
    expect(buildAddDirs([abs("a")], single, abs("a"))).toBeNull();
  });
});

describe("rewriteRootMentions", () => {
  const roots = collectWorkspaceRoots([abs("cwd"), abs("other")]);
  const cwd = abs("cwd");

  it("非 cwd 根的提及还原成绝对路径", () => {
    const text = `看下 @other/src/a.ts 和 @cwd/src/b.ts`;
    expect(rewriteRootMentions(text, roots, cwd)).toBe(
      `看下 @${path.join(abs("other"), "src/a.ts")} 和 @cwd/src/b.ts`,
    );
  });

  it("未知别名 / 空相对部分保持原样", () => {
    expect(rewriteRootMentions("@nope/x.ts @other/", roots, cwd)).toBe("@nope/x.ts @other/");
  });

  it("逃出根的 .. 路径保持原样（不改写成工作区外路径）", () => {
    expect(rewriteRootMentions("@other/../secret.txt", roots, cwd)).toBe("@other/../secret.txt");
  });

  it("@url: 形态不被误改", () => {
    expect(rewriteRootMentions("@url:https://x.dev/a", roots, cwd)).toBe("@url:https://x.dev/a");
  });

  it("单根工作区完全不动文本", () => {
    const single = collectWorkspaceRoots([abs("cwd")]);
    expect(rewriteRootMentions("@cwd/src/a.ts", single, cwd)).toBe("@cwd/src/a.ts");
  });
});

describe("buildWorkspaceRootsUi", () => {
  const roots = collectWorkspaceRoots([abs("a"), abs("b")]);
  const all = roots.map((r) => r.path);

  it("null applied 视为全量根；选择全量时没有待生效变更", () => {
    const ui = buildWorkspaceRootsUi(roots, all.filter((p) => p === abs("a")), null);
    expect(ui.applied).toEqual(all);
    expect(ui.selected).toEqual([abs("a")]);
    expect(ui.pendingChange).toBe(true);
  });

  it("选择与 applied 一致时 pendingChange=false", () => {
    const ui = buildWorkspaceRootsUi(roots, [abs("a")], [abs("a")]);
    expect(ui.pendingChange).toBe(false);
  });

  it("投影里的 roots 是值拷贝（宿主不外泄内部对象）", () => {
    const ui = buildWorkspaceRootsUi(roots, all, all);
    expect(ui.roots).toEqual(roots);
    expect(ui.roots[0]).not.toBe(roots[0]);
  });
});

/** 注入恒等 realpath：这些用例只看词法层，不碰磁盘。 */
const identityRealpath = (p: string): string => p;

describe("rewriteRootMentions — 词法安全边界（Windows）", () => {
  const winRoots = [
    { path: "D:\\work\\app", name: "app" },
    { path: "D:\\work\\app2", name: "app2" },
    { path: "D:\\work\\other", name: "other" },
  ];
  const rewrite = (text: string): string =>
    rewriteRootMentions(text, winRoots, null, identityRealpath);

  it.skipIf(process.platform !== "win32")("`..` 穿越不被重写成越界绝对路径", () => {
    for (const payload of [
      "@app/../x",
      "@app/../../etc/passwd",
      "@app/..\\..\\secret.txt",
      "@app/..\\..\\..\\Windows\\System32\\config",
      "@other/../../Users/Administrator/.ssh/id_rsa",
    ]) {
      expect(rewrite(payload)).toBe(payload);
    }
  });

  it.skipIf(process.platform !== "win32")("兄弟目录前缀（app vs app2）不会被误命中", () => {
    // 逃到 app2：root=app 时这条必须原样保留，而不是认成 app 根内路径。
    expect(rewrite("@app/../app2/x")).toBe("@app/../app2/x");
    // 正主是 app2 时正常还原（不越界）。
    expect(rewrite("@app2/src/f.ts")).toBe("@D:\\work\\app2\\src\\f.ts");
  });

  it.skipIf(process.platform !== "win32")("大小写变体行为一致且不越界", () => {
    expect(rewrite("@APP/src/f.ts")).toBe("@D:\\work\\app\\src\\f.ts");
    expect(rewrite("@App/../APP2/x")).toBe("@App/../APP2/x");
  });

  it.skipIf(process.platform !== "win32")("UNC / 驱动器绝对路径不被放行", () => {
    for (const payload of [
      "@app/\\\\server\\share\\secret.txt",
      "@app/D:\\Windows\\system32\\drivers\\etc\\hosts",
      "@app/..\\..\\..\\..\\server\\share",
    ]) {
      expect(rewrite(payload)).toBe(payload);
    }
  });

  it.skipIf(process.platform !== "win32")("合法输入照旧还原为根内绝对路径", () => {
    expect(rewrite("看 @app/src/f.ts")).toBe("看 @D:\\work\\app\\src\\f.ts");
  });
});

describe("rewriteRootMentions — 词法安全边界（POSIX）", () => {
  const posixRoots = [
    { path: "/work/app", name: "app" },
    { path: "/work/app2", name: "app2" },
  ];
  const rewrite = (text: string): string =>
    rewriteRootMentions(text, posixRoots, null, identityRealpath);

  it.skipIf(process.platform === "win32")("`..` 穿越与兄弟前缀都不越界", () => {
    for (const payload of [
      "@app/../../etc/passwd",
      "@app/../../../root/.ssh/id_rsa",
      "@app/../app2/x",
    ]) {
      expect(rewrite(payload)).toBe(payload);
    }
    expect(rewrite("@app/src/f.ts")).toBe("@/work/app/src/f.ts");
  });
});

describe("rewriteRootMentions — realpath 不可用时退到词法层", () => {
  it("realpath 全抛错：合法仍还原，穿越仍拒绝", () => {
    const roots = [
      { path: path.resolve("app"), name: "app" },
      { path: path.resolve("other"), name: "other" },
    ];
    const boom = (): string => {
      throw new Error("no fs");
    };
    expect(rewriteRootMentions("@app/src/f.ts", roots, null, boom)).toBe(
      `@${path.join(path.resolve("app"), "src/f.ts")}`,
    );
    expect(rewriteRootMentions("@app/../../etc/passwd", roots, null, boom)).toBe(
      "@app/../../etc/passwd",
    );
  });
});

describe("rewriteRootMentions — 物理边界（根内符号链接/联接点）", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "iflow-root-mention-"));
  const rootDir = path.join(tmp, "app");
  const outsideDir = path.join(tmp, "outside");
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, "secret.txt"), "secret", "utf8");
  let linked = true;
  try {
    symlinkSync(outsideDir, path.join(rootDir, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    linked = false; // 无权限建链接的环境（部分 Windows 配置）跳过该断言，不谎报通过
  }
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const roots = [
    { path: rootDir, name: "app" },
    { path: path.join(tmp, "other"), name: "other" },
  ];

  it.skipIf(!linked)("根内链接指向根外：已存在与未创建的文件都拒绝重写", () => {
    expect(rewriteRootMentions("@app/link/secret.txt", roots, null)).toBe("@app/link/secret.txt");
    expect(rewriteRootMentions("@app/link/new-file.ts", roots, null)).toBe("@app/link/new-file.ts");
  });

  it("根内普通（尚未创建的）路径照旧还原", () => {
    expect(rewriteRootMentions("@app/src/fresh.ts", roots, null)).toBe(
      `@${path.join(rootDir, "src", "fresh.ts")}`,
    );
  });
});
