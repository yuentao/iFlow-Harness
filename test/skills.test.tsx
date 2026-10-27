// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillPrompt, parseSkillInvocation } from "../shared/skills";
import { setMeta } from "../shared/session-state";
import { initialSessionState } from "../shared/messages";
import { resolveSkill, scanSkills, skillRoots } from "../src/skills/service";
import { Composer } from "../webview/src/components/Composer";
import type { SessionState } from "../shared/messages";

/** jsdom ships no scrollIntoView — the slash popup scrolls the active row. */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

describe("skill invocation syntax", () => {
  it("parses /skill <name> with and without an instruction", () => {
    expect(parseSkillInvocation("/skill pdf 提取表格")).toEqual({ name: "pdf", args: "提取表格" });
    expect(parseSkillInvocation("/skill pdf")).toEqual({ name: "pdf", args: "" });
    expect(parseSkillInvocation("  /skill pdf  提取表格  ")).toEqual({ name: "pdf", args: "提取表格" });
  });

  it("ignores anything that is not a skill invocation", () => {
    expect(parseSkillInvocation("/skill")).toBeNull();
    expect(parseSkillInvocation("/skill ")).toBeNull();
    expect(parseSkillInvocation("/skills pdf")).toBeNull();
    expect(parseSkillInvocation("/compress")).toBeNull();
    expect(parseSkillInvocation("提取表格")).toBeNull();
  });

  it("builds the agent payload from the base directory, the skill body and the instruction", () => {
    const prompt = buildSkillPrompt({
      baseDirectory: "C:\\skills\\pdf",
      content: "Read the PDF, then answer.",
      args: "提取表格",
    });
    expect(prompt).toContain("Base directory for this skill:\nC:\\skills\\pdf");
    expect(prompt).toContain("Read the PDF, then answer.");
    expect(prompt).toContain("提取表格");
    // The skill body is transported verbatim — the host never rewrites it.
    expect(prompt.indexOf("Read the PDF")).toBeLessThan(prompt.indexOf("提取表格"));
  });
});

describe("session state", () => {
  it("carries the CLI-reported skills", () => {
    const state = initialSessionState();
    expect(state.skills).toEqual([]);
    setMeta(state, { skills: [{ name: "pdf", description: "PDF 技能", scope: "global" }] });
    expect(state.skills).toHaveLength(1);
    expect(state.skills[0]?.name).toBe("pdf");
  });
});

describe("skill resolution (CLI SkillScanner semantics)", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "iflow-skills-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "iflow-skills-cwd-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeSkill(root: string, dir: string, frontmatter: string, body: string): void {
    const skillDir = path.join(root, dir);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  }

  it("reads the skill name from the frontmatter and strips it from the body", async () => {
    writeSkill(path.join(home, "skills"), "pdf-dir", "name: pdf\ndescription: PDF 技能", "正文");
    const skill = await resolveSkill(skillRoots(home, cwd), "pdf");
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("pdf");
    expect(skill?.description).toBe("PDF 技能");
    expect(skill?.scope).toBe("global");
    expect(skill?.content).toBe("正文");
    expect(skill?.content).not.toContain("name: pdf");
  });

  it("lets a global skill shadow a project skill of the same name", async () => {
    writeSkill(path.join(home, "skills"), "pdf", "name: pdf", "全局正文");
    writeSkill(path.join(cwd, ".iflow", "skills"), "pdf", "name: pdf", "项目正文");
    const skill = await resolveSkill(skillRoots(home, cwd), "pdf");
    expect(skill?.scope).toBe("global");
    expect(skill?.content).toBe("全局正文");
  });

  it("skips skills without a name and reports unknown names as null", async () => {
    writeSkill(path.join(home, "skills"), "broken", "description: 没有名字", "正文");
    expect(await resolveSkill(skillRoots(home, cwd), "broken")).toBeNull();
    expect(await resolveSkill(skillRoots(home, cwd), "nope")).toBeNull();
    // A missing skills root is not an error — the CLI treats it as "no skills".
    expect(await scanSkills(skillRoots(path.join(home, "missing"), cwd))).toEqual([]);
  });
});

// --- webview: the /skill slash entries ---------------------------------------

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  state: undefined as SessionState | undefined,
}));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(
      selector: (s: {
        state: SessionState | undefined;
        pending: null;
        send: typeof mocked.send;
        beginPending: ReturnType<typeof vi.fn>;
        notify: typeof mocked.notify;
      }) => T,
    ) => selector({ state: mocked.state, pending: null, send: mocked.send, beginPending: vi.fn(), notify: mocked.notify }),
    { getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }) },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s, modeDisplay: () => ({ label: "mode", desc: "" }) }));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    Dropdown: ({ trigger, children }: { trigger: (open: boolean) => ReactNode; children: ReactNode }) => <>{trigger(false)}{children}</>,
    fuzzyScore: () => 0,
  };
});

let root: Root;
let container: HTMLDivElement;

function makeState(): SessionState {
  return {
    ...initialSessionState(),
    status: "idle",
    sessionId: "s1",
    activeSessionId: "s1",
    auth: {
      authenticated: true,
      needsSetup: false,
      saved: null,
      profiles: [],
      importable: [],
      onboardingDismissed: false,
    },
  } as SessionState;
}

function render(): HTMLTextAreaElement {
  act(() => root.render(<Composer />));
  return container.querySelector("textarea")!;
}

function change(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocked.state = makeState();
  mocked.send.mockReset();
  mocked.notify.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("composer /skill entries", () => {
  it("lists one /skill entry per skill and completes the chosen one", () => {
    mocked.state = {
      ...makeState(),
      commands: [{ name: "init", description: "初始化" }],
      skills: [
        { name: "pdf", description: "PDF 技能", scope: "global" },
        { name: "xlsx", description: "Excel 技能", scope: "project" },
      ],
    };
    const textarea = render();
    // "/" opens the popup with every entry: the CLI's own commands and the
    // synthetic skill entries share one list.
    change(textarea, "/");
    let labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("/init"))).toBe(true);
    expect(labels.some((l) => l.includes("/skill pdf"))).toBe(true);
    expect(labels.some((l) => l.includes("/skill xlsx"))).toBe(true);

    // Typing the command name narrows the list to the skills.
    change(textarea, "/skill");
    labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("/skill pdf"))).toBe(true);
    expect(labels.some((l) => l.includes("/skill xlsx"))).toBe(true);
    expect(labels.some((l) => l.includes("/init"))).toBe(false);

    const entry = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("/skill pdf"));
    act(() => entry!.click());
    expect(textarea.value).toBe("/skill pdf ");
  });

  it("also matches a skill by its bare name", () => {
    mocked.state = {
      ...makeState(),
      skills: [{ name: "pdf", description: "PDF 技能", scope: "global" }],
    };
    const textarea = render();
    change(textarea, "/pdf");
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("/skill pdf"))).toBe(true);
  });

  it("shows no /skill entry when the CLI reported no skills", () => {
    const textarea = render();
    change(textarea, "/skill");
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("/skill"))).toBe(false);
  });
});
