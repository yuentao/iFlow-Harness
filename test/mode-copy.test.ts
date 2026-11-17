import { afterEach, describe, expect, it } from "vitest";
import { modeDisplay, setLocale } from "../webview/src/i18n";

/**
 * Copy guard for the permission-mode menu.
 *
 * The mode descriptions used to promise behaviour the main session cannot
 * perform any more ("所有操作直接执行" / "每次执行操作前都要你确认"): since the
 * Super Agent split, the main session only holds `super-agent` / `todo_write` /
 * `todo_read` / `ask_user_question` / `exit_plan_mode`, every one of them has
 * `shouldConfirmExecute() === false`, and its CLI process runs without MCP
 * servers (see `mainSessionSettings()` in src/panel/panel.ts and the comment
 * above `modeDisplay`). Execution lives in child sessions, which are
 * auto-approved by default. These assertions keep the copy honest and keep it
 * in i18n (no hardcoded strings in the menu component).
 */

const MODES = [
  {
    id: "smart",
    zhLabel: "智能",
    zhDesc: "主会话只规划与派发；执行在子会话，风险判断已无作用",
  },
  {
    id: "yolo",
    zhLabel: "免确认",
    zhDesc: "主会话只规划与派发；执行在子会话，默认免确认",
  },
  {
    id: "default",
    zhLabel: "标准",
    zhDesc: "主会话只规划与派发；执行在子会话，无需逐次确认",
  },
  {
    id: "plan",
    zhLabel: "规划",
    zhDesc: "只做计划，不派发子会话；需要执行时先请求退出规划模式",
  },
] as const;

/** CJK ideographs — anything left untranslated. */
const CJK = /[\u3400-\u9fff]/;

describe("permission-mode copy", () => {
  afterEach(() => setLocale(undefined));

  it("labels and descriptions all come from i18n (English locale has no leftover Chinese)", () => {
    setLocale("en");
    for (const mode of MODES) {
      const view = modeDisplay({ id: mode.id, name: "" });
      expect(view.label).not.toBe(mode.zhLabel);
      expect(view.desc).not.toBe(mode.zhDesc);
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.desc.length).toBeGreaterThan(0);
      expect(CJK.test(view.label)).toBe(false);
      expect(CJK.test(view.desc)).toBe(false);
    }
  });

  it("Chinese locale renders the rewritten copy", () => {
    setLocale("zh-cn");
    for (const mode of MODES) {
      const view = modeDisplay({ id: mode.id, name: "" });
      expect(view.label).toBe(mode.zhLabel);
      expect(view.desc).toBe(mode.zhDesc);
    }
  });

  it("no description repeats the old claims contradicted by the main session's tool set", () => {
    setLocale("zh-cn");
    const all = MODES.map((m) => modeDisplay({ id: m.id, name: "" }).desc).join("\n");
    for (const stale of [
      "所有操作直接执行",
      "不再询问",
      "每次执行操作前",
      "自行判断风险",
      "只读：只分析",
      "不改动文件",
    ]) {
      expect(all).not.toContain(stale);
    }
  });

  it("the three approval modes say the main session only plans/delegates and execution is in child sessions", () => {
    setLocale("zh-cn");
    for (const mode of MODES.filter((m) => m.id !== "plan")) {
      const desc = modeDisplay({ id: mode.id, name: "" }).desc;
      expect(desc).toContain("主会话只规划与派发");
      expect(desc).toContain("执行在子会话");
    }
  });

  it("Plan mode says it dispatches no child sessions and requires leaving Plan mode", () => {
    setLocale("zh-cn");
    const plan = modeDisplay({ id: "plan", name: "Plan" });
    expect(plan.desc).toContain("不派发");
    expect(plan.desc).toContain("退出规划模式");
  });

  it("unknown mode ids fall back to the agent-provided name", () => {
    setLocale("zh-cn");
    expect(modeDisplay({ id: "custom-mode", name: "Custom" })).toEqual({ label: "Custom", desc: "" });
  });
});