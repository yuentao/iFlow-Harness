import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostToWebview, AssetUi, AssetsStateUi } from "../shared/messages.js";
import { AssetsService } from "../src/assets/service.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function mk(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(home: string, cwd: string) {
  const messages: HostToWebview[] = [];
  const service = new AssetsService({
    home,
    getCwd: () => (cwd || null),
    getWorkspaceRoots: () => (cwd ? [cwd] : []),
    post: (message) => messages.push(message),
    log: { info: () => {}, warn: () => {} },
  });
  return { service, messages };
}

function lastMessage(messages: HostToWebview[], type: string): HostToWebview {
  const found = [...messages].reverse().find((m) => m.type === type);
  if (!found) throw new Error(`no ${type} posted`);
  return found;
}

function findItem(items: AssetUi[], name: string): AssetUi {
  const found = items.find((item) => item.name === name);
  if (!found) throw new Error(`asset ${name} not listed`);
  return found;
}

describe("AssetsService", () => {
  it("scans all three kinds per CLI loader rules (recursive commands, top-level agents, <dir>/SKILL.md)", async () => {
    const home = tempDir("iflow-assets-home-");
    const cwd = tempDir("iflow-assets-ws-");
    mk(path.join(home, "commands", "sub"));
    writeFileSync(
      path.join(home, "commands", "fix-tests.md"),
      "---\ndescription: Run the tests and fix failures\n---\n\nFix {{args}} please\n",
      "utf8",
    );
    writeFileSync(
      path.join(home, "commands", "sub", "nested.toml"),
      'description = "Nested toml command"\nprompt = "do it"\n',
      "utf8",
    );
    mk(path.join(home, "agents"));
    writeFileSync(
      path.join(home, "agents", "helper.md"),
      "---\nname: helper\ndescription: A helper subagent\nallowed-tools: Read, Grep\n---\n\nYou help.\n",
      "utf8",
    );
    writeFileSync(path.join(home, "agents", "no-frontmatter.md"), "# just a heading\n", "utf8");
    mk(path.join(home, "skills", "pdf"));
    writeFileSync(
      path.join(home, "skills", "pdf", "SKILL.md"),
      "---\nname: pdf-forms\ndescription: Fill PDF forms\n---\n\n# Steps\n",
      "utf8",
    );
    mk(path.join(cwd, ".iflow", "commands"));
    writeFileSync(path.join(cwd, ".iflow", "commands", "proj.md"), "no frontmatter\n", "utf8");
    mk(path.join(cwd, ".iflow", "skills", "pdf"));
    writeFileSync(
      path.join(cwd, ".iflow", "skills", "pdf", "SKILL.md"),
      "---\nname: pdf-forms\ndescription: Project copy shadowed by global\n---\n\n# Steps\n",
      "utf8",
    );

    const { service, messages } = makeService(home, cwd);
    await service.sendState();
    const reply = lastMessage(messages, "assetsState");
    const state = reply.state as AssetsStateUi;

    expect(state.home).toBe(home);
    expect(state.cwd).toBe(cwd);

    // commands: global recursive (sub:nested) + project top level
    expect(state.commands.length).toBe(3);
    const fix = findItem(state.commands, "fix-tests");
    expect(fix.description).toBe("Run the tests and fix failures");
    const nested = findItem(state.commands, "sub:nested");
    expect(nested.description).toBe("Nested toml command");
    const proj = findItem(state.commands, "proj");
    expect(proj.scope).toBe("project");
    expect(proj.description).toBe(null);

    // agents: only frontmatter-named top-level .md; missing name → skipped
    expect(state.agents.length).toBe(1);
    const helper = findItem(state.agents, "helper");
    expect(helper.tools).toEqual(["Read", "Grep"]);

    // skills: both copies listed, project one flagged shadowed (global wins)
    expect(state.skills.length).toBe(2);
    const globalSkill = findItem(state.skills, "pdf");
    expect(globalSkill.scope).toBe("global");
    expect(globalSkill.shadowed ?? false).toBe(false);
    const projectSkill = state.skills.find((s) => s.scope === "project");
    expect(projectSkill?.shadowed).toBe(true);
  });

  it("save round trip: stale expectedHash conflicts without writing; fresh hash writes", async () => {
    const home = tempDir("iflow-assets-home-");
    const cwd = tempDir("iflow-assets-ws-");
    mk(path.join(home, "commands"));
    const target = path.join(home, "commands", "edit.md");
    writeFileSync(target, "---\ndescription: original\n---\n\nbody\n", "utf8");

    const { service, messages } = makeService(home, cwd);
    await service.readFile(target, 7);
    const read = lastMessage(messages, "assetContent");
    expect(read.path).toBe(target);
    expect(typeof read.hash).toBe("string");

    // Disk moved since the read — the draft's hash no longer matches.
    writeFileSync(target, "---\ndescription: external edit\n---\n\nbody\n", "utf8");
    await service.saveFile({
      path: target,
      content: "---\ndescription: overwritten\n---\n\nbody\n",
      expectedHash: read.hash as string,
      requestId: 7,
    });
    const conflict = lastMessage(messages, "assetSaved");
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.requestId).toBe(7);
    expect(readFileSync(target, "utf8")).toContain("external edit");

    // Re-read the moved file, save with the fresh hash.
    await service.readFile(target, 8);
    const fresh = lastMessage(messages, "assetContent");
    await service.saveFile({
      path: target,
      content: "---\ndescription: saved\n---\n\nbody\n",
      expectedHash: fresh.hash as string,
      requestId: 8,
    });
    const saved = lastMessage(messages, "assetSaved");
    expect(saved.ok).toBe(true);
    expect(saved.requestId).toBe(8);
    expect(readFileSync(target, "utf8")).toContain("saved");
  });

  it("create rejects bad names, conflicts on existing files, builds skill dirs host-side", async () => {
    const home = tempDir("iflow-assets-home-");
    const cwd = tempDir("iflow-assets-ws-");
    mk(path.join(home, "commands"));
    writeFileSync(path.join(home, "commands", "taken.md"), "x\n", "utf8");

    const { service, messages } = makeService(home, cwd);

    await service.createFile({ kind: "command", scope: "global", name: "bad name!", content: "x" });
    const bad = lastMessage(messages, "assetSaved");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("名称仅允许");

    await service.createFile({ kind: "command", scope: "global", name: "taken", content: "y" });
    const clash = lastMessage(messages, "assetSaved");
    expect(clash.ok).toBe(false);
    expect(clash.conflict).toBe(true);

    await service.createFile({ kind: "skill", scope: "project", name: "new-skill", content: "---\nname: new-skill\n---\n" });
    const created = lastMessage(messages, "assetSaved");
    expect(created.ok).toBe(true);
    const skillFile = path.join(cwd, ".iflow", "skills", "new-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);

    // Project scope without a session cwd is refused.
    const noCwd = makeService(home, "");
    await noCwd.service.createFile({ kind: "command", scope: "project", name: "ghost", content: "x" });
    const ghost = lastMessage(noCwd.messages, "assetSaved");
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toContain("无项目上下文");
  });

  it("delete removes skill dirs when empty and rejects structurally invalid targets", async () => {
    const home = tempDir("iflow-assets-home-");
    const cwd = tempDir("iflow-assets-ws-");
    mk(path.join(home, "skills", "doomed"));
    const doomed = path.join(home, "skills", "doomed", "SKILL.md");
    writeFileSync(doomed, "---\nname: doomed\n---\n", "utf8");
    mk(path.join(home, "agents", "nested"));
    const nested = path.join(home, "agents", "nested", "deep.md");
    writeFileSync(nested, "---\nname: deep\n---\n", "utf8");

    const { service, messages } = makeService(home, cwd);

    await service.deleteFile(doomed, 3);
    const gone = lastMessage(messages, "assetDeleted");
    expect(gone.ok).toBe(true);
    expect(gone.requestId).toBe(3);
    expect(existsSync(doomed)).toBe(false);
    // The empty skill directory is cleaned up too (SKILL.md was its only entry).
    expect(existsSync(path.join(home, "skills", "doomed"))).toBe(false);

    // An agent file one directory deep is NOT a valid agent target (top-level
    // only) — nor is an arbitrary path outside the six roots.
    await service.deleteFile(nested, 4);
    const refused = lastMessage(messages, "assetDeleted");
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("不在可编辑资产范围");
    expect(existsSync(nested)).toBe(true);

    await service.readFile(path.join(home, "evil.md"), 5);
    const outside = lastMessage(messages, "assetContent");
    expect(outside.error).toContain("不在可编辑资产范围");
  });
});
