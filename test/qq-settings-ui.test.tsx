// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqPendingUserUi, QqSettingsPatch } from "../shared/messages";
import {
  applyQqSettingsPatch,
  readQqSettings,
  type QqSettingsIo,
} from "../src/qq/settings-host.js";
import { QqSettings, type QqSettingsValue } from "../webview/src/components/QqSettings";

/** jsdom ships neither ResizeObserver nor scrollIntoView; the Dropdown clamp
 * needs the members to exist. */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** No layout in jsdom: offsetParent stays null, so the kit's visibility filter
 * would drop every menu item. */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});

const VALUE: QqSettingsValue = {
  enabled: false,
  allowedUsers: [],
  allowedGroups: [],
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
  hasAppSecret: false,
};

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn>;
let onTestConnection: ReturnType<typeof vi.fn>;
let onUnbind: ReturnType<typeof vi.fn>;
let onUserAction: ReturnType<typeof vi.fn>;

/**
 * 端到端往返用的最小 IO：设置值存在内存里，secret 一律空。
 * 与 `applyQqSettingsPatch` / `readQqSettings` 搭配即为「磁盘」。
 */
class MemoryIo implements QqSettingsIo {
  readonly settings: Record<string, unknown>;

  constructor(settings: Record<string, unknown> = {}) {
    this.settings = { ...settings };
  }

  readAll(): Record<string, unknown> {
    return { ...this.settings };
  }

  async writeAll(patch: Record<string, unknown>): Promise<void> {
    Object.assign(this.settings, patch);
  }

  async getSecret(_key: string): Promise<string | undefined> {
    return undefined;
  }

  async setSecret(_key: string, _value: string): Promise<void> {}

  async deleteSecret(_key: string): Promise<void> {}
}

/** Stateful harness: the component is controlled, so a test must feed the
 * patch back for the next render (like the host will). */
function Harness({
  initial,
  pending,
}: {
  initial?: Partial<QqSettingsValue>;
  pending?: QqPendingUserUi[];
}) {
  const [value, setValue] = useState<QqSettingsValue>({ ...VALUE, ...initial });
  return (
    <QqSettings
      value={value}
      onChange={(patch) => {
        onChange(patch);
        // 这里的用例只回灌组件自己产出的条目形式（不带裸字符串），断言收窄。
        setValue((current) => ({ ...current, ...patch }) as QqSettingsValue);
      }}
      onTestConnection={onTestConnection}
      onUnbind={onUnbind}
      pendingUsers={pending}
      onUserAction={onUserAction}
      status={{ connected: initial?.enabled ? true : false, detail: "QQ 官方机器人已连接" }}
      warnings={initial?.enabled ? [] : ["机器人凭据还没有配置"]}
    />
  );
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(element));
}

function clickText(text: string): void {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(button, `button 「${text}」`).toBeTruthy();
  act(() => button!.click());
}

function setInput(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  onChange = vi.fn();
  onTestConnection = vi.fn();
  onUnbind = vi.fn();
  onUserAction = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QqSettings", () => {
  it("renders the nine QQBot remote-task settings", () => {
    render(<Harness />);
    const text = container.textContent ?? "";
    for (const label of [
      "启用 QQ 远程任务",
      "允许的用户",
      "允许的群",
      "远程任务策略",
      "结果详细度",
      "同时运行的任务数",
      "每分钟任务上限",
      "完成后自动合并",
      "工作区目录",
    ]) {
      expect(text, label).toContain(label);
    }
    // 展平后不再有适配器分流与端点/桥接端口字段。
    expect(text).not.toContain("协议适配器");
    expect(text).not.toContain("适配器端点");
    expect(text).not.toContain("桥接端口");
    // 凭据只由扫码写入：页面没有手填输入框。
    expect(text).not.toContain("机器人 Token");
    expect(text).not.toContain("App Secret");
  });

  it("reports the enabled switch and offers no credential inputs", () => {
    render(<Harness />);
    const toggle = container.querySelector<HTMLButtonElement>("button[role='switch'][aria-label='启用 QQ 远程任务']")!;
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({ enabled: true });

    expect(container.querySelector("input[aria-label='机器人 Token']")).toBeNull();
    expect(container.querySelector("input[aria-label='App Secret']")).toBeNull();
  });

  it("commits numeric fields on blur and clamps them", () => {
    render(<Harness />);
    const field = container.querySelector<HTMLInputElement>("input[aria-label='同时运行的任务数']")!;
    act(() => field.focus());
    setInput(field, "4");
    act(() => field.blur());
    expect(onChange).toHaveBeenCalledWith({ maxConcurrentTasks: 4 });

    const rate = container.querySelector<HTMLInputElement>("input[aria-label='每分钟任务上限']")!;
    act(() => rate.focus());
    setInput(rate, "999");
    act(() => rate.blur());
    expect(onChange).toHaveBeenCalledWith({ rateLimitPerMin: 60 });
  });

  it("explains the supervised policy including the 5-minute rejection rule", () => {
    render(<Harness />);
    expect(container.textContent).toContain("5 分钟未响应按拒绝处理");

    const trigger = container.querySelector<HTMLButtonElement>("button[aria-label='远程任务策略']")!;
    expect(trigger.textContent).toContain("受监督");
    act(() => trigger.click());
    // Portaled menu: it lives under document.body, not inside the settings card.
    const items = [...document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    const trusted = items.find((item) => item.textContent?.includes("受信任"))!;
    act(() => trusted.click());
    expect(onChange).toHaveBeenCalledWith({ remotePolicy: "trusted" });
    expect(container.textContent).toContain("工具调用无需 QQ 审核直接执行");
  });

  it("已存在条目只读展示脱敏 openid，并带可提交的备注字段", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    const text = container.textContent ?? "";
    expect(text).toContain("D754********8D11");
    expect(text).not.toContain(openid);
    // 不是输入框：页面上没有能直接改 openid 的字段。
    expect(container.querySelector("input[aria-label='允许的用户 1']")).toBeNull();

    const note = container.querySelector<HTMLInputElement>(
      "input[aria-label='允许的用户 1 的备注']",
    )!;
    expect(note.value).toBe("同事");

    act(() => note.focus());
    setInput(note, "运维同事");
    act(() => note.blur());
    expect(onChange).toHaveBeenCalledWith({
      allowedUsers: [{ openid, note: "运维同事" }],
    });
  });

  it("备注可以清空（写回不带 note 的条目）", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    const note = container.querySelector<HTMLInputElement>(
      "input[aria-label='允许的用户 1 的备注']",
    )!;
    act(() => note.focus());
    setInput(note, "");
    act(() => note.blur());
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [{ openid }] });
  });

  it("删除按钮仍可用", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    const remove = container.querySelector<HTMLButtonElement>(
      "button[aria-label='删除 允许的用户 1']",
    )!;
    act(() => remove.click());
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [] });
  });

  it("portals the execution-policy menu out of the clipping settings card", () => {
    render(<Harness />);
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-label='远程任务策略']")!;
    const wrapper = trigger.closest<HTMLElement>(".relative")!;
    const anchorRect = {
      x: 260,
      y: 120,
      left: 260,
      top: 120,
      right: 360,
      bottom: 148,
      width: 100,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect;
    wrapper.getBoundingClientRect = () => anchorRect;

    act(() => trigger.click());

    const menu = document.body.querySelector<HTMLElement>("[role='menu']")!;
    expect(menu).toBeTruthy();
    // Not a descendant of the settings group (which is overflow-hidden):
    // fixed + body portal is what stops the「受信任」row from being cut off.
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");
    // Content width: long descriptions get a readable sentence width instead
    // of one character per line; still never narrower than the trigger.
    expect(menu.style.width).toBe("max-content");
    expect(menu.style.minWidth).toBe("100px");
    expect(Number.parseInt(menu.style.maxWidth, 10)).toBeLessThanOrEqual(448);
    expect(Number.parseInt(menu.style.maxHeight, 10)).toBeGreaterThan(0);
    expect(menu.className).toContain("overflow-y-auto");
    // The long 受信任 description is rendered in full inside that readable menu.
    expect(menu.textContent).toContain("仅建议对自己完全掌控的账号与群使用");
  });

  it("添加用户：必须先输入完整 openid，提交后立即按脱敏展示", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness />);
    expect(container.textContent).toContain("尚未添加条目");

    clickText("添加用户");
    // 添加输入框的可见标签是占位符，可访问名必须另外给（不能拿 placeholder 充当）。
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入用户的 openid']")!;
    expect(input.placeholder).toBe("完整 openid");
    setInput(input, openid);

    const confirm = container.querySelector<HTMLButtonElement>("button[aria-label='确认添加']")!;
    act(() => confirm.click());

    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [{ openid }] });
    // Harness 会把补丁回灌：条目立即以脱敏形式出现，完整 openid 不再泄露。
    const text = container.textContent ?? "";
    expect(text).toContain("D754********8D11");
    expect(text).not.toContain(openid);
  });

  it("添加群按同一规则脱敏，取消添加不会写入", () => {
    const openid = "ABCDEF0123456789ABCDEF0123456789";
    render(<Harness />);

    clickText("添加群");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入群的 openid']")!;
    const cancel = container.querySelector<HTMLButtonElement>("button[aria-label='取消添加']")!;
    setInput(input, openid);
    act(() => cancel.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("input[aria-label='输入群的 openid']")).toBeNull();

    clickText("添加群");
    const again = container.querySelector<HTMLInputElement>("input[aria-label='输入群的 openid']")!;
    setInput(again, openid);
    act(() => {
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ allowedGroups: [{ openid }] });
    // 回灌后立即脱敏：群 openid 与用户 openid 用同一规则。
    expect(container.textContent).toContain("ABCD********6789");
    expect(container.textContent).not.toContain(openid);
  });

  it("paints warnings in the warning tone, never primary", () => {
    render(<Harness />);
    const alert = container.querySelector<HTMLElement>("[role='alert']")!;
    expect(alert.className).toContain("bg-warning");
    expect(alert.className).not.toContain("bg-primary");
    expect(alert.textContent).toContain("机器人凭据还没有配置");
  });

  it("未授权时只保留「一键接入」，隐藏测试连接 / 解除绑定", () => {
    render(<Harness />);
    const text = container.textContent ?? "";
    expect(text).toContain("一键接入 QQ 机器人");
    for (const hidden of ["测试连接", "解除绑定", "重新扫码授权"]) {
      expect(text, hidden).not.toContain(hidden);
    }
    // 白名单区与开关不受授权态影响。
    expect(text).toContain("允许的用户");
    expect(text).toContain("允许的群");
  });

  it("已授权时显示重新扫码授权 / 测试连接 / 解除绑定并接线", () => {
    render(<Harness initial={{ enabled: true }} />);
    clickText("测试连接");
    clickText("解除绑定");
    clickText("重新扫码授权");
    expect(onTestConnection).toHaveBeenCalledTimes(1);
    expect(onUnbind).toHaveBeenCalledTimes(1);
  });

  it("待审核用户列表：脱敏 openid、来源、次数、预览与时间", () => {
    render(
      <Harness
        pending={[
          {
            openid: "abcdef123456",
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 3,
            preview: "帮我改一下 README 的安装说明",
            chatType: "private",
          },
          {
            openid: "group-user-654321",
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 1,
            preview: "群里的陌生人",
            chatType: "group",
            groupId: "123456789012",
          },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("待审核用户");
    // 与白名单区同一套脱敏：前 4 + 固定 8 个 * + 后 4（≤8 位整体覆盖）。
    // 完整 openid / 完整群号都不出现。
    expect(text).toContain("abcd********3456");
    expect(text).not.toContain("abcdef123456");
    expect(text).toContain("grou********4321");
    expect(text).not.toContain("group-user-654321");
    expect(text).toContain("1234********9012");
    expect(text).not.toContain("123456789012");
    expect(text).toContain("私聊");
    expect(text).toContain("群 1234********9012");
    expect(text).toContain("出现次数");
    expect(text).toContain("3");
    expect(text).toContain("帮我改一下 README 的安装说明");
    expect(text).toContain("首次");
    expect(text).toContain("最近");
  });

  it("待审核区短 id 不得原样显示：≤8 位整体覆盖，星号个数恒为 8", () => {
    render(
      <Harness
        pending={[
          {
            openid: "abc123",
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 1,
            preview: "短 id",
            chatType: "private",
          },
          {
            openid: "abcdefgh12345678",
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 1,
            preview: "长 id",
            chatType: "group",
            groupId: "12345678",
          },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    // 短值（6 位）与 8 位群号都整体覆盖，绝不出现原文。
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("12345678");
    expect(text).toContain("abcd********5678");
    expect(text).toContain("群 ********");
    // 三条脱敏串的星号段长度一致（固定 8），不能由星号数推出原始长度。
    const starRuns = text.match(/\*+/g) ?? [];
    expect(starRuns).toHaveLength(3);
    expect(starRuns.every((run) => run.length === 8)).toBe(true);
  });

  it("待审核列表为空时不渲染该区", () => {
    render(<Harness pending={[]} />);
    expect(container.textContent).not.toContain("待审核用户");
    expect(container.textContent).not.toContain("暂无待审核用户");
  });

  it("批准 / 拒绝把 openid 与动作交回调用方", () => {
    const openid = "openid-123456";
    render(
      <Harness
        pending={[
          {
            openid,
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 1,
            preview: "你好",
            chatType: "private",
          },
        ]}
      />,
    );
    clickText("批准");
    expect(onUserAction).toHaveBeenCalledWith(openid, "approve");
    clickText("拒绝");
    expect(onUserAction).toHaveBeenCalledWith(openid, "reject");
  });

  it("端到端往返：读 → UI 全量回传（只改一条备注）→ 写 → 再读，无备注条目仍是裸字符串", async () => {
    const io = new MemoryIo({
      allowedUsers: ["legacy-plain", { openid: "user-with-note", note: "同事" }],
    });
    // 1) 读：磁盘值经宿主归一成 UI 快照。
    const initial = await readQqSettings(io);
    expect(initial.allowedUsers).toEqual([
      { openid: "legacy-plain" },
      { openid: "user-with-note", note: "同事" },
    ]);

    // 2) UI：只改第二条的备注；onChange 交回全量数组（对象形态，与宿主语义一致）。
    function IoHarness() {
      const [value, setValue] = useState<QqSettingsValue>({ ...initial });
      return (
        <QqSettings
          value={value}
          onChange={(patch) => {
            onChange(patch);
            setValue((current) => ({ ...current, ...patch }) as QqSettingsValue);
          }}
          onTestConnection={onTestConnection}
          onUnbind={onUnbind}
          onUserAction={onUserAction}
        />
      );
    }
    render(<IoHarness />);
    const note = container.querySelector<HTMLInputElement>(
      "input[aria-label='允许的用户 2 的备注']",
    )!;
    expect(note.value).toBe("同事");
    act(() => note.focus());
    setInput(note, "运维同事");
    act(() => note.blur());

    const calls = onChange.mock.calls;
    const patch = calls[calls.length - 1]![0] as QqSettingsPatch;
    expect(patch.allowedUsers).toEqual([
      { openid: "legacy-plain" },
      { openid: "user-with-note", note: "运维同事" },
    ]);

    // 3) 写：真实写入层落盘。
    await act(async () => {
      await applyQqSettingsPatch(io, patch);
    });
    // 无备注条目保持裸字符串 —— 不被 UI 的对象形态无意义升格成 `{ openid }`。
    expect(io.settings.allowedUsers).toEqual([
      "legacy-plain",
      { openid: "user-with-note", note: "运维同事" },
    ]);

    // 4) 再读：备注落盘且条目形状照旧。
    const after = await readQqSettings(io);
    expect(after.allowedUsers).toEqual([
      { openid: "legacy-plain" },
      { openid: "user-with-note", note: "运维同事" },
    ]);
  });
});
