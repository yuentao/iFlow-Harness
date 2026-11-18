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
  route: "child",
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

/**
 * 所有 `role="alert"` 的文本合并。页面里的 warnings 警告块也是 alert，
 * 「只取第一个」会永远读到警告而不是就地校验错误。
 */
function alertText(): string {
  return [...container.querySelectorAll("[role='alert']")]
    .map((element) => element.textContent ?? "")
    .join("\n");
}

/** 访问控制的两张表都带 aria-label；测试按名称取，避免误取别的表格。 */
function accessTable(label: string): HTMLTableElement {
  const table = container.querySelector<HTMLTableElement>(`table[aria-label='${label}']`);
  expect(table, `table 「${label}」`).toBeTruthy();
  return table!;
}

/** 行内图标按钮：可访问名带实体名（备注优先，空备注退回脱敏 id）。 */
function rowButton(scope: ParentNode, label: string): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  expect(button, `button 「${label}」`).toBeTruthy();
  return button!;
}

function clickEdit(table: string, name: string): void {
  act(() => rowButton(accessTable(table), `编辑 ${name}`).click());
}

function clickDelete(table: string, name: string): void {
  act(() => rowButton(accessTable(table), `删除 ${name}`).click());
}

/** ConfirmDialog 走 portal 挂在 document.body，不在组件容器里。 */
function confirmDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[role='alertdialog']");
}

function pressKey(el: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
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
    // 关面板 ≠ 停通道：说明里必须讲清楚（用户容易误以为关掉面板就断开）。
    expect(text).toContain("关闭面板不会停止 QQ 通道");
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

  it("explains the supervised policy including the 4-minute rejection rule", () => {
    render(<Harness />);
    expect(container.textContent).toContain("4 分钟未响应按拒绝处理");

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

  it("消息去向默认为独立子会话，可切换到主会话并回传补丁", () => {
    render(<Harness />);
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-label='消息去向']")!;
    expect(trigger.textContent).toContain("独立子会话");
    // 默认项要说明「隔离执行」。
    expect(container.textContent).toContain("隔离执行");

    act(() => trigger.click());
    const items = [...document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
    const main = items.find((item) => item.textContent?.includes("主会话"))!;
    act(() => main.click());
    expect(onChange).toHaveBeenCalledWith({ route: "main" });
  });

  it("默认态：两列表格（条目 / 操作），行内无输入框，条目列含备注与完整脱敏值", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    const table = accessTable("允许的用户");
    // 两列：条目 + 操作（操作列在最后）。
    const headers = [...table.querySelectorAll("th")];
    expect(headers).toHaveLength(2);
    expect(headers.map((th) => th.textContent)).toEqual(["条目", "操作"]);
    expect(headers.every((th) => th.getAttribute("scope") === "col")).toBe(true);

    // 展示态没有任何输入框：备注与脱敏 id 都是纯文本。
    expect(table.querySelectorAll("input")).toHaveLength(0);
    const text = table.textContent ?? "";
    expect(text).toContain("同事");
    // 脱敏值必须完整可见：星号段与末尾 4 位都在。
    expect(text).toContain("********");
    expect(text).toContain("8D11");
    expect(text).toContain("D754********8D11");
    expect(text).not.toContain(openid);
    // 完整 openid 连 title 属性里都不出现（只有脱敏串可作 title）。
    expect(table.innerHTML).not.toContain(openid);

    // 唯一一行、两个单元格：条目列 + 操作列。
    const cells = [...table.querySelectorAll<HTMLElement>("tbody tr td")];
    expect(cells).toHaveLength(2);

    // 操作列两个图标按钮，可访问名带实体名。
    expect(rowButton(table, "编辑 同事")).toBeTruthy();
    expect(rowButton(table, "删除 同事")).toBeTruthy();
  });

  it("脱敏 id 元素不带 truncate：宽度不足时换行，绝不截掉末尾 4 位", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    const masked = accessTable("允许的用户").querySelector<HTMLElement>("tbody tr td span[title='D754********8D11']")!;
    expect(masked).toBeTruthy();
    expect(masked.textContent).toBe("D754********8D11");
    // 关键回归：不能被 truncate 切成 `D754**...`。
    expect(masked.className).not.toContain("truncate");
    expect(masked.className).toContain("break-all");
  });

  it("备注为空时显示「未命名」占位，编辑按钮退回脱敏 id 作可访问名", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid }] }} />);

    const table = accessTable("允许的用户");
    expect(table.textContent).toContain("未命名");
    expect(rowButton(table, "编辑 D754********8D11")).toBeTruthy();
    expect(rowButton(table, "删除 D754********8D11")).toBeTruthy();
  });

  it("编辑：点铅笔进入行内编辑态，保存后落盘并回到展示态", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);
    clickEdit("允许的用户", "同事");

    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    expect(input.value).toBe("同事");
    // 编辑态也只有备注一个输入框：openid 仍不可编辑。
    expect(accessTable("允许的用户").querySelectorAll("input")).toHaveLength(1);

    setInput(input, "  运维同事 ");
    pressKey(input, "Enter");

    expect(onChange).toHaveBeenLastCalledWith({ allowedUsers: [{ openid, note: "运维同事" }] });
    const table = accessTable("允许的用户");
    expect(table.querySelectorAll("input")).toHaveLength(0);
    expect(table.textContent).toContain("运维同事");
  });

  it("编辑态：输入框占满条目列（不是固定 68px），脱敏 id 仍在第二行完整可见", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "我的手机（私聊）" }] }} />);
    clickEdit("允许的用户", "我的手机（私聊）");

    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 我的手机（私聊）']")!;
    expect(input.value).toBe("我的手机（私聊）");
    // 关键回归：上一版输入框只有 68px（内容宽度 auto），「我的手机（私聊）」
    // 显示成「（私聊）」。现在必须撑满条目列。
    expect(input.className).toContain("w-full");
    expect(input.className).not.toMatch(/\bw-\[\d/);
    expect(input.className).not.toMatch(/\bw-(?:8|10|12|14|16|20|24|28|32|40|48|56|64)\b/);

    // 编辑态里脱敏 id 仍作为第二行只读显示，且完整（不截尾）。
    const masked = container.querySelector<HTMLElement>(
      "table[aria-label='允许的用户'] tbody tr td span[title='D754********8D11']",
    )!;
    expect(masked).toBeTruthy();
    expect(masked.className).not.toContain("truncate");
    expect(masked.textContent).toBe("D754********8D11");
  });

  it("编辑态视觉统一：紧凑输入框 + 固定 24px 备注槽 + 整行表面色，不再割裂/跳动", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);
    const row = () => accessTable("允许的用户").querySelector<HTMLElement>("tbody tr")!;

    // 展示态：备注包在固定高度槽里，行本身无编辑表面色。
    const noteSlot = row().querySelector<HTMLElement>("td div > div")!;
    expect(noteSlot.className).toContain("min-h-6");
    expect(row().className).not.toContain("bg-accent");

    clickEdit("允许的用户", "同事");

    // 输入框用 kit 的 size="sm"：13px 字（text-ui-label），24px 高（h-6），
    // 不再是 14px / 35px 的表单盒砸进 13px 表格。
    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    expect(input.className).toContain("text-ui-label");
    expect(input.className).not.toContain("text-ui-body");
    expect(input.className).toContain("h-6");
    // 展示态与编辑态共用同一个 min-h-6 槽：切换不撑高整行（布局不跳动）。
    expect(row().querySelector<HTMLElement>("td div > div")!.className).toContain("min-h-6");

    // 编辑行整行铺一层浅色表面，让「这一行正在编辑」读成连续表面。
    expect(row().className).toContain("bg-accent/40");
    // 行内动作按钮把 hover 底色让给行，不再叠出第三种色调。
    for (const label of ["保存", "取消"]) {
      const btn = row().querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!;
      expect(btn.className).not.toContain("hover:bg-accent");
    }
  });

  it("分组标题与提示上下排版：标题独占一行，提示在下一行且不被截断", () => {
    render(<Harness />);
    const heading = [...container.querySelectorAll("h3")].find(
      (node) => node.textContent === "访问控制",
    )!;
    expect(heading).toBeTruthy();
    const header = heading.parentElement!;
    // 上下排版：标题与提示是 column 的直接子元素。
    expect(header.className).toContain("flex-col");
    const hint = [...header.children].find((node) => node.textContent === "留空表示不接受该来源的任务")!;
    expect(hint).toBeTruthy();
    expect(hint.tagName).toBe("SPAN");
    // 提示不再用 truncate 与标题抢同一行。
    expect(hint.className).not.toContain("truncate");
  });

  it("编辑：Esc 取消不落盘；IME 组合中的 Enter 不算提交", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);
    clickEdit("允许的用户", "同事");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;

    setInput(input, "不该保存");
    // IME 组合中的 Enter 是「确认候选词」，不能提交。
    pressKey(input, "Enter", { isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeTruthy();

    pressKey(input, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeNull();
    expect(accessTable("允许的用户").textContent).toContain("同事");

    // 行内「取消」按钮等价于 Esc：丢弃草稿、不落盘。
    clickEdit("允许的用户", "同事");
    const again = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    setInput(again, "取消掉");
    act(() => rowButton(accessTable("允许的用户"), "取消").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(accessTable("允许的用户").querySelectorAll("input")).toHaveLength(0);
  });

  it("编辑时清空备注：写回不带 note 的条目", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);
    clickEdit("允许的用户", "同事");

    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    setInput(input, "   ");
    pressKey(input, "Enter");
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [{ openid }] });
  });

  it("草稿保护：改备注后点另一行的铅笔，旧值先落盘再进入新行", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    const b = "ABCDEF0123456789ABCDEF0123456789";
    render(
      <Harness
        initial={{
          allowedUsers: [
            { openid: a, note: "同事" },
            { openid: b, note: "运维" },
          ],
        }}
      />,
    );

    clickEdit("允许的用户", "同事");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    setInput(input, "运维同事");
    // 不按 Enter、不点保存：直接点另一行的铅笔。
    clickEdit("允许的用户", "运维");

    // 旧草稿自动提交，一次写入（不是先切行再丢）。
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      allowedUsers: [
        { openid: a, note: "运维同事" },
        { openid: b, note: "运维" },
      ],
    });
    // 回灌后第一行展示新备注，编辑态落在第二行且带出它自己的旧备注。
    expect(accessTable("允许的用户").textContent).toContain("运维同事");
    const second = container.querySelector<HTMLInputElement>("input[aria-label='备注 运维']")!;
    expect(second.value).toBe("运维");
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeNull();
  });

  it("草稿保护：未修改备注直接切行不产生任何写入", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    const b = "ABCDEF0123456789ABCDEF0123456789";
    render(
      <Harness
        initial={{
          allowedUsers: [
            { openid: a, note: "同事" },
            { openid: b, note: "运维" },
          ],
        }}
      />,
    );

    clickEdit("允许的用户", "同事");
    clickEdit("允许的用户", "运维");

    // 草稿与已存值一致：切行不该顺手写一次设置。
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("input[aria-label='备注 运维']")!.value).toBe(
      "运维",
    );
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeNull();
  });

  it("草稿保护：编辑中删除另一行，草稿与删除同一次落盘", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    const b = "ABCDEF0123456789ABCDEF0123456789";
    render(
      <Harness
        initial={{
          allowedUsers: [
            { openid: a, note: "同事" },
            { openid: b, note: "运维" },
          ],
        }}
      />,
    );

    clickEdit("允许的用户", "同事");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    setInput(input, "运维同事");
    clickDelete("允许的用户", "运维");
    // 确认前不落盘（用户还可能取消）。
    expect(onChange).not.toHaveBeenCalled();

    const dialog = confirmDialog()!;
    const confirm = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    )!;
    act(() => confirm.click());

    // 一次写入同时包含「备注落盘」与「行被删除」，不会用旧数组把草稿盖回去。
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      allowedUsers: [{ openid: a, note: "运维同事" }],
    });
    expect(accessTable("允许的用户").querySelectorAll("input")).toHaveLength(0);
    expect(accessTable("允许的用户").textContent).toContain("运维同事");
  });

  it("草稿保护：编辑中进入添加行，草稿先落盘", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid: a, note: "同事" }] }} />);

    clickEdit("允许的用户", "同事");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    setInput(input, "运维同事");
    clickText("添加用户");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      allowedUsers: [{ openid: a, note: "运维同事" }],
    });
    expect(container.querySelector("input[aria-label='输入用户标识']")).toBeTruthy();
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeNull();
  });

  it("草稿保护：添加行有内容时点铅笔，先提交添加再进入编辑", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    const b = "ABCDEF0123456789ABCDEF0123456789";
    render(<Harness initial={{ allowedUsers: [{ openid: a, note: "同事" }] }} />);

    clickText("添加用户");
    const id = container.querySelector<HTMLInputElement>("input[aria-label='输入用户标识']")!;
    const note = container.querySelector<HTMLInputElement>("input[aria-label='新用户的备注']")!;
    setInput(id, b);
    setInput(note, "新同事");
    clickEdit("允许的用户", "同事");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      allowedUsers: [
        { openid: a, note: "同事" },
        { openid: b, note: "新同事" },
      ],
    });
    // 添加已提交，编辑态落在被点的那一行。
    expect(container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!.value).toBe(
      "同事",
    );
    expect(container.querySelector("input[aria-label='输入用户标识']")).toBeNull();
  });

  it("草稿保护：添加行只有备注、标识为空时点铅笔，就地报错并留在添加行", () => {
    const a = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid: a, note: "同事" }] }} />);

    clickText("添加用户");
    const note = container.querySelector<HTMLInputElement>("input[aria-label='新用户的备注']")!;
    setInput(note, "只有备注");
    clickEdit("允许的用户", "同事");

    // 提交失败：不写入、不切行，输入与错误提示都留在原地。
    expect(onChange).not.toHaveBeenCalled();
    expect(alertText()).toContain("请填写完整的用户标识");
    expect(container.querySelector<HTMLInputElement>("input[aria-label='输入用户标识']")).toBeTruthy();
    expect(container.querySelector("input[aria-label='备注 同事']")).toBeNull();
  });

  it("删除需要确认：确认前不落盘，确认后行消失并回到空态", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "同事" }] }} />);

    clickDelete("允许的用户", "同事");
    expect(onChange).not.toHaveBeenCalled();
    const dialog = confirmDialog();
    expect(dialog).toBeTruthy();
    // 确认文案说明完整 id 无法从脱敏显示还原（误删不可恢复）。
    expect(dialog!.textContent).toContain("无法恢复");
    expect(dialog!.textContent).toContain("同事");

    const confirm = [...dialog!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    )!;
    act(() => confirm.click());
    expect(onChange).toHaveBeenCalledWith({ allowedUsers: [] });

    // Harness 回灌空列表：表格消失，只剩空态文案。
    expect(container.querySelector("table[aria-label='允许的用户']")).toBeNull();
    expect(container.textContent).toContain("尚未添加条目");
  });

  it("空态：只显示「尚未添加条目」，不渲染空表头", () => {
    render(<Harness />);
    expect(container.querySelector("table[aria-label='允许的用户']")).toBeNull();
    expect(container.querySelector("table[aria-label='允许的群']")).toBeNull();
    expect(container.textContent).toContain("尚未添加条目");
    expect(container.textContent).not.toContain("操作");
  });

  it("空态：两张表都用项目既有虚线空态盒，而非裸 Hint 段落", () => {
    render(<Harness />);
    const empties = [...container.querySelectorAll<HTMLElement>("div")].filter(
      (node) => node.textContent?.trim() === "尚未添加条目",
    );
    // 用户表与群表各一个空态盒。
    expect(empties).toHaveLength(2);
    for (const box of empties) {
      expect(box.className).toContain("border-dashed");
      expect(box.className).toContain("rounded-lg");
      expect(box.className).toContain("text-center");
      expect(box.className).toContain("text-ui-label");
      // 关键回归：不能退回裸 <p> Hint 段落。
      expect(box.tagName).toBe("DIV");
    }
  });

  it("窄屏：两列表格不横向溢出，操作列固定宽度，脱敏值换行而非截尾", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid, note: "很长的备注".repeat(8) }] }} />);

    const table = accessTable("允许的用户");
    // table-fixed：列宽由表头决定，内容再长也不会把表格撑得横向溢出。
    expect(table.className).toContain("table-fixed");
    expect(table.className).toContain("w-full");
    const opHeader = [...table.querySelectorAll("th")][1]!;
    expect(opHeader.className).toContain("w-16");
    expect(opHeader.className).toContain("text-right");

    // 两个图标按钮自带 shrink-0（kit IconButton 基类），不会被压缩或推出。
    const buttons = [...table.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.className).toContain("shrink-0");

    // 备注最多两行（line-clamp-2），不是单行 truncate。
    const note = table.querySelector<HTMLElement>("tbody tr td span")!;
    expect(note.className).toContain("line-clamp-2");
    expect(note.className).not.toContain("truncate");
    expect(note.getAttribute("title")).toBe("很长的备注".repeat(8));

    // 脱敏 id 靠 break-all 换行保持完整，禁止 truncate 切掉尾巴。
    const masked = table.querySelector<HTMLElement>("tbody tr td span[title='D754********8D11']")!;
    expect(masked.className).not.toContain("truncate");
    expect(masked.className).toContain("break-all");
    expect(masked.getAttribute("title")).toBe("D754********8D11");
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
    // 添加行在表格末尾：表头是两列（条目 / 操作）。
    expect(accessTable("允许的用户").querySelectorAll("thead th")).toHaveLength(2);
    // 添加输入框的可见标签是占位符，可访问名必须另外给（不能拿 placeholder 充当）。
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入用户标识']")!;
    expect(input.placeholder).toBe("完整 openid");
    // 标识输入占满条目列（不是固定像素宽）。
    expect(input.className).toContain("w-full");
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
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入群标识']")!;
    expect(input.placeholder).toBe("完整群号");
    const cancel = container.querySelector<HTMLButtonElement>("button[aria-label='取消添加']")!;
    setInput(input, openid);
    act(() => cancel.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("input[aria-label='输入群标识']")).toBeNull();

    clickText("添加群");
    const again = container.querySelector<HTMLInputElement>("input[aria-label='输入群标识']")!;
    setInput(again, openid);
    act(() => {
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ allowedGroups: [{ openid }] });
    // 回灌后立即脱敏：群 openid 与用户 openid 用同一规则。
    expect(container.textContent).toContain("ABCD********6789");
    expect(container.textContent).not.toContain(openid);
  });

  it("添加用户：脱敏串被就地拒绝，带空格的完整 openid 仍可保存", () => {
    render(<Harness />);
    clickText("添加用户");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入用户标识']")!;
    const confirm = container.querySelector<HTMLButtonElement>("button[aria-label='确认添加']")!;

    // 从界面复制来的脱敏串（含 *）是最常见的误粘贴：必须报错且不写入。
    setInput(input, "D754********8D11");
    act(() => confirm.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(alertText()).toContain("无效的用户标识");
    // 输入保留（用户可以修正），不是静默丢弃。
    expect(input.value).toBe("D754********8D11");

    // 复制常带首尾空白：trim 后是合法完整 id，应正常添加。
    setInput(input, "  D754D2240C503C2ABE2B236DC1E78D11  ");
    act(() => confirm.click());
    expect(onChange).toHaveBeenCalledWith({
      allowedUsers: [{ openid: "D754D2240C503C2ABE2B236DC1E78D11" }],
    });
  });

  it("添加群：过短 / 超长 / 含空格的标识一律拒绝并提示", () => {
    render(<Harness />);
    clickText("添加群");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入群标识']")!;
    const confirm = container.querySelector<HTMLButtonElement>("button[aria-label='确认添加']")!;

    for (const bad of ["abc", "a".repeat(65), "1234 5678"]) {
      setInput(input, bad);
      act(() => confirm.click());
      expect(onChange, bad).not.toHaveBeenCalled();
      expect(alertText(), bad).toContain("无效的群标识");
    }
  });

  it("重复添加同一标识会明确报错，而不是静默忽略", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    render(<Harness initial={{ allowedUsers: [{ openid }] }} />);
    clickText("添加用户");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='输入用户标识']")!;
    const confirm = container.querySelector<HTMLButtonElement>("button[aria-label='确认添加']")!;

    setInput(input, openid);
    act(() => confirm.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(alertText()).toContain("已在名单中");
  });

  it("群条目同构：两列（条目 / 操作），备注可编辑，且不牵连用户列表", () => {
    const group = "12345678";
    const user = "D754D2240C503C2ABE2B236DC1E78D11";
    render(
      <Harness
        initial={{
          allowedUsers: [{ openid: user, note: "同事" }],
          allowedGroups: [{ openid: group, note: "测试群" }],
        }}
      />,
    );

    const table = accessTable("允许的群");
    // 与用户表完全同构：两列（条目 / 操作）。
    expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "条目",
      "操作",
    ]);
    // 条目列上下两行：备注在前（8 位群号脱敏后恒为纯星号，备注才是唯一
    // 可辨识信息），脱敏群号紧随其后且完整可见。
    const cells = [...table.querySelectorAll<HTMLElement>("tbody tr td")];
    expect(cells).toHaveLength(2);
    expect(cells[0]?.textContent).toContain("测试群");
    expect(cells[0]?.textContent).toContain("********");
    // 群号脱敏元素同样不带 truncate。
    const masked = cells[0]?.querySelector<HTMLElement>("span[title='********']")!;
    expect(masked).toBeTruthy();
    expect(masked.className).not.toContain("truncate");

    clickEdit("允许的群", "测试群");
    const note = container.querySelector<HTMLInputElement>("input[aria-label='备注 测试群']")!;
    expect(note.value).toBe("测试群");
    setInput(note, " 运营群 ");
    pressKey(note, "Enter");
    expect(onChange).toHaveBeenLastCalledWith({
      allowedGroups: [{ openid: group, note: "运营群" }],
    });

    // 每次补丁都只带群列表：用户列表（含备注）不被牵连。
    for (const call of onChange.mock.calls) {
      expect(call[0]).not.toHaveProperty("allowedUsers");
    }
  });

  it("添加群：可在同一编辑行填写备注，一起落盘", () => {
    const openid = "12345678";
    render(<Harness />);

    clickText("添加群");
    // 添加行插在表格末尾：表头先出现（空态文案让位给表格），两列。
    expect(accessTable("允许的群").querySelectorAll("thead th")).toHaveLength(2);
    const note = container.querySelector<HTMLInputElement>("input[aria-label='新群的备注']")!;
    const id = container.querySelector<HTMLInputElement>("input[aria-label='输入群标识']")!;
    setInput(note, "测试群");
    setInput(id, openid);
    pressKey(id, "Enter");

    expect(onChange).toHaveBeenLastCalledWith({ allowedGroups: [{ openid, note: "测试群" }] });

    // 回灌后回到展示态：没有任何输入框，备注与脱敏群号各就各位。
    const table = accessTable("允许的群");
    expect(table.querySelectorAll("input")).toHaveLength(0);
    expect(table.textContent).toContain("测试群");
    expect(table.textContent).toContain("********");
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
    // 展示态没有输入框：点第二条（备注「同事」）的铅笔进入行内编辑。
    clickEdit("允许的用户", "同事");
    const note = container.querySelector<HTMLInputElement>("input[aria-label='备注 同事']")!;
    expect(note.value).toBe("同事");
    setInput(note, "运维同事");
    pressKey(note, "Enter");

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

  it("端到端往返（群）：改群备注不影响用户备注，无备注群仍是裸字符串", async () => {
    const io = new MemoryIo({
      allowedUsers: [{ openid: "user-with-note", note: "同事" }, "user-plain"],
      allowedGroups: ["987654321012", { openid: "group-with-note", note: "测试群" }],
    });
    const initial = await readQqSettings(io);
    expect(initial.allowedGroups).toEqual([
      { openid: "987654321012" },
      { openid: "group-with-note", note: "测试群" },
    ]);

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
    clickEdit("允许的群", "测试群");
    const note = container.querySelector<HTMLInputElement>("input[aria-label='备注 测试群']")!;
    expect(note.value).toBe("测试群");
    setInput(note, "运营群");
    pressKey(note, "Enter");

    const calls = onChange.mock.calls;
    const patch = calls[calls.length - 1]![0] as QqSettingsPatch;
    expect(patch.allowedGroups).toEqual([
      { openid: "987654321012" },
      { openid: "group-with-note", note: "运营群" },
    ]);
    // 群备注补丁不携带用户列表，两者互不影响。
    expect(patch.allowedUsers).toBeUndefined();

    await act(async () => {
      await applyQqSettingsPatch(io, patch);
    });
    // 无备注的群保持裸字符串；用户列表（含备注）原封不动。
    expect(io.settings.allowedGroups).toEqual([
      "987654321012",
      { openid: "group-with-note", note: "运营群" },
    ]);
    expect(io.settings.allowedUsers).toEqual([
      { openid: "user-with-note", note: "同事" },
      "user-plain",
    ]);

    const after = await readQqSettings(io);
    expect(after.allowedGroups).toEqual([
      { openid: "987654321012" },
      { openid: "group-with-note", note: "运营群" },
    ]);
    expect(after.allowedUsers).toEqual([
      { openid: "user-with-note", note: "同事" },
      { openid: "user-plain" },
    ]);
  });
});
