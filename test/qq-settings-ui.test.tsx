// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqPendingUserUi } from "../shared/messages";
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
        setValue((current) => ({ ...current, ...patch }));
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
    const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    const trusted = items.find((item) => item.textContent?.includes("受信任"))!;
    act(() => trusted.click());
    expect(onChange).toHaveBeenCalledWith({ remotePolicy: "trusted" });
    expect(container.textContent).toContain("工具调用无需 QQ 审核直接执行");
  });

  it("adds, edits and removes allowed users with per-row accessible names", () => {
    render(<Harness />);
    expect(container.textContent).toContain("尚未添加条目");

    clickText("添加用户");
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [""] });

    const field = container.querySelector<HTMLInputElement>("input[aria-label='允许的用户 1']")!;
    setInput(field, "1234567890");
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: ["1234567890"] });

    const remove = container.querySelector<HTMLButtonElement>("button[aria-label='删除 允许的用户 1']")!;
    act(() => remove.click());
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [] });
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
    // 末 6 位可见，完整 openid / 完整群号不出现。
    expect(text).toContain("…123456");
    expect(text).not.toContain("abcdef123456");
    expect(text).toContain("…654321");
    expect(text).not.toContain("group-user-654321");
    expect(text).toContain("…789012");
    expect(text).not.toContain("123456789012");
    expect(text).toContain("私聊");
    expect(text).toContain("群 …789012");
    expect(text).toContain("出现次数");
    expect(text).toContain("3");
    expect(text).toContain("帮我改一下 README 的安装说明");
    expect(text).toContain("首次");
    expect(text).toContain("最近");
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
});
