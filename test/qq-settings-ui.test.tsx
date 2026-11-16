// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  adapter: "onebot",
  endpoint: "",
  bridgePort: 0,
  allowedUsers: [],
  allowedGroups: [],
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
};

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn>;
let onTestConnection: ReturnType<typeof vi.fn>;
let onGenerateBindCode: ReturnType<typeof vi.fn>;
let onUnbind: ReturnType<typeof vi.fn>;

/** Stateful harness: the component is controlled, so a test must feed the
 * patch back for the next render (like the host will). */
function Harness({ initial }: { initial?: Partial<QqSettingsValue> }) {
  const [value, setValue] = useState<QqSettingsValue>({ ...VALUE, ...initial });
  return (
    <QqSettings
      value={value}
      onChange={(patch) => {
        onChange(patch);
        setValue((current) => ({ ...current, ...patch }));
      }}
      onTestConnection={onTestConnection}
      onGenerateBindCode={onGenerateBindCode}
      onUnbind={onUnbind}
      status={{ connected: initial?.enabled ? true : false, detail: "本机 OneBot 桥" }}
      bindCode={initial?.enabled ? { code: "K7Q2", expiresAt: Date.now() + 60_000 } : undefined}
      warnings={initial?.enabled ? [] : ["端点还没有配置"]}
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
  onGenerateBindCode = vi.fn();
  onUnbind = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QqSettings", () => {
  it("renders the twelve remote-task settings", () => {
    render(<Harness />);
    const text = container.textContent ?? "";
    for (const label of [
      "启用 QQ 远程任务",
      "协议适配器",
      "适配器端点",
      "允许的用户",
      "允许的群",
      "远程任务策略",
      "结果详细度",
      "同时运行的任务数",
      "每分钟任务上限",
      "完成后自动合并",
      "桥接端口",
      "工作区目录",
    ]) {
      expect(text, label).toContain(label);
    }
  });

  it("reports the enabled switch and adapter choice", () => {
    render(<Harness />);
    const toggle = container.querySelector<HTMLButtonElement>("button[role='switch'][aria-label='启用 QQ 远程任务']")!;
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({ enabled: true });

    // qqbot is only reachable through the adapter segmented control.
    expect(container.querySelector("input[aria-label='机器人 Token']")).toBeNull();
    clickText("QQ 官方机器人");
    expect(onChange).toHaveBeenCalledWith({ adapter: "qqbot" });
    expect(container.querySelector("input[aria-label='机器人 Token']")).toBeTruthy();
    expect(container.querySelector("input[aria-label='App Secret']")).toBeTruthy();
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
    expect(alert.textContent).toContain("端点还没有配置");
  });

  it("shows the bind code and wires the connection actions", () => {
    render(<Harness initial={{ enabled: true }} />);
    expect(container.textContent).toContain("K7Q2");
    expect(container.textContent).toContain("剩余");

    clickText("测试连接");
    clickText("生成配对码");
    clickText("解除绑定");
    expect(onTestConnection).toHaveBeenCalledTimes(1);
    expect(onGenerateBindCode).toHaveBeenCalledTimes(1);
    expect(onUnbind).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials in a revealable field fed only by props", () => {
    render(<Harness initial={{ adapter: "qqbot", botToken: "secret-token" }} />);
    const input = container.querySelector<HTMLInputElement>("input[aria-label='机器人 Token']")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("secret-token");

    const reveal = container.querySelector<HTMLButtonElement>("button[aria-label='显示密码']")!;
    act(() => reveal.click());
    expect(input.type).toBe("text");
  });
});
