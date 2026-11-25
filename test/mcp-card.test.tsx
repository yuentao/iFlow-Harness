// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpSection } from "../webview/src/components/McpCard";
import { entriesToServers, sameMcpServers } from "../webview/src/components/mcp-servers";

// jsdom has no ResizeObserver; the row Dropdown observes its menu on open.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const send = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", () => ({ useChat: (selector: (s: { send: typeof send }) => unknown) => selector({ send }) }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? "") }));
let root: Root;
let container: HTMLDivElement;
const header = vi.fn();
function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
/** Disk-truth reply. `servers` is the GLOBAL dict; `project` defaults to null
 * (no project scope, so the project tab stays disabled) and can be set to
 * exercise scope switching and the cross-scope override chips. */
function reply(
  servers: Record<string, unknown>,
  error?: string,
  project: Record<string, unknown> | null = null,
) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "mcpServers", global: servers, project, error } }),
    ),
  );
}
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  send.mockReset(); header.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<McpSection busy={false} onHeader={header} />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("preserves unknown fields and legal prototype-like names while rejecting duplicates", () => {
  const servers = entriesToServers([{ name: "__proto__", json: '{"extra":{"x":1},"env":{"TOKEN":"abc"}}' }, { name: "constructor", json: '{}' }]);
  expect(Object.keys(servers)).toEqual(["__proto__", "constructor"]);
  expect(servers.__proto__).toEqual({ extra: { x: 1 }, env: { TOKEN: "abc" } });
  expect(() => entriesToServers([{ name: " same ", json: '{}' }, { name: "same", json: '{}' }])).toThrow("same");
  expect(sameMcpServers({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
});
it("persists a deletion to disk so reopening the card cannot resurrect the server", () => {
  reply({ keep: { command: "node" }, gone: { command: "npx" } });
  expect(container.textContent).toContain("gone");
  clickTitle("服务器 gone 的操作");
  bodyClick("删除"); // row menu item
  expect(document.body.textContent).toContain("确定删除");
  bodyClick("删除"); // ConfirmDialog confirm
  const call = send.mock.calls.find(([m]) => m.type === "saveMcpServers")?.[0];
  expect(call).toBeTruthy();
  expect(call!.servers).toEqual({ keep: { command: "node" } });
  expect(Object.hasOwn(call!.servers, "gone")).toBe(false);
  // Reopen the settings panel: a fresh disk read must not bring it back.
  act(() => root.unmount());
  root = createRoot(container);
  act(() => root.render(<McpSection busy={false} onHeader={header} />));
  reply(call!.servers);
  expect(container.textContent).not.toContain("gone");
  expect(container.textContent).toContain("keep");
});

it("shows success only after Host confirms and retains draft on save failure", () => {
  reply({ original: { command: "node", unknown: { kept: true } } });
  click("保存");
  expect(container.textContent).toContain("保存中…");
  expect(container.textContent).not.toContain("已保存");
  const payload = send.mock.calls.at(-1)![0];
  reply(payload.servers, "write failed");
  expect(container.textContent).toContain("write failed");
  click("保存");
  reply(payload.servers);
  expect(container.textContent).toContain("已保存");
  expect(payload.servers.original.unknown).toEqual({ kept: true });
});
it("does not accept a mismatched save reply or allow a second concurrent save", () => {
  reply({ original: { command: "node" } });
  click("保存"); click("保存中…");
  expect(send.mock.calls.filter(([m]) => m.type === "saveMcpServers")).toHaveLength(1);
  reply({ unrelated: {} });
  expect(container.textContent).toContain("保存中…");
  expect(container.querySelector('button[title="编辑"]')!.hasAttribute("disabled")).toBe(true);
  reply(send.mock.calls.at(-1)![0].servers);
  expect(container.textContent).toContain("已保存");
});
it("does not overwrite disk configuration after an initial read failure", () => {
  reply({}, "read failed");
  click("保存"); click("添加");
  expect(send.mock.calls.map(([m]) => m.type)).toEqual(["listMcpServers", "mcpStatus"]);
  expect(container.querySelector("textarea")).toBeNull();
});
it("ignores stale replies while editing and preserves the editor index", () => {
  reply({ existing: { command: "node" } });
  click("添加");
  const name = container.querySelector("input")!;
  input(name, "my-draft");
  reply({});
  expect(container.querySelector("input")!.value).toBe("my-draft");
  expect(container.querySelector("textarea")).toBeTruthy();
});

function statusReply(status: null | { discoveryState?: string; servers: Record<string, unknown> }) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "mcpStatus", status } })));
}
function clickTitle(title: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.getAttribute("title") === title);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
// ConfirmDialog portals onto document.body, outside the component container.
function bodyClick(text: string) {
  const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}
it("lights each row by the reported connection state and appends the context chip", () => {
  reply({ a: { command: "node" }, b: { url: "https://mcp.example.com/mcp" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "connected", toolCount: 1, promptCount: 0,
        tools: [{ name: "do_it", description: "does it", schema: { type: "object" } }],
        prompts: [], contextTokens: 1234,
      },
      b: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        error: "spawn ENOENT", errorKind: "spawn_failed", contextTokens: 0,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("bg-success"))).toBe(true);
  expect(spans.some((s) => s.className.includes("bg-destructive"))).toBe(true);
  expect(container.textContent).toContain("≈1.2k");
  expect(container.textContent).toContain("≈0");
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("spawn ENOENT"))).toBe(true);
});
it("renders a hollow dot when the status channel is unavailable, none while pending", () => {
  reply({ a: { command: "node" } });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("rounded-full"))).toBe(false);
  statusReply(null);
  expect([...container.querySelectorAll("span")].some((s) => s.className.includes("border-muted-foreground"))).toBe(true);
});
it("opens the detail sub-page with declarations, error and back header", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "disconnected", toolCount: 1, promptCount: 1,
        tools: [{ name: "do_it", description: "does it", schema: { type: "object", properties: { x: { type: "string" } } } }],
        prompts: [{ name: "help", description: "usage" }],
        error: "network timeout", errorKind: "timeout", contextTokens: 42,
      },
    },
  });
  clickTitle("详情");
  expect(header.mock.calls.some(([h]) => h !== null && h.title === "MCP 服务器详情")).toBe(true);
  expect(container.textContent).toContain("do_it");
  expect(container.querySelector("pre")?.textContent).toContain("properties");
  expect(container.textContent).toContain("network timeout");
  // Back is the shell header arrow (no bottom 「返回」 button anymore).
  const lastHeader = header.mock.calls.at(-1)![0];
  expect(lastHeader).not.toBeNull();
  act(() => lastHeader!.back());
  expect(header.mock.calls.some(([h]) => h === null)).toBe(true);
});
it("keeps a still-discovering detail honest instead of claiming no tools", () => {
  reply({ shared: { command: "node" } }, undefined, { shared: { command: "npx" } });
  statusReply({
    discoveryState: "in_progress",
    servers: {
      shared: {
        status: "connecting", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        contextTokens: 0, scope: "both",
      },
    },
  });
  clickTitle("详情");
  // toolCount is 0 while discovery runs; that must read as "reading…", not "none".
      expect(container.textContent).toContain("正在读取工具列表…");
      expect(container.textContent).not.toContain("这个服务器没有提供工具或提示");  expect(container.textContent).toContain("项目级覆盖全局");
});
it("colors a disconnected detail chip with the danger tone and labels its scope", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        contextTokens: 0, scope: "global",
      },
    },
  });
  clickTitle("详情");
  expect([...container.querySelectorAll("span")].some((s) => s.className.includes("bg-destructive"))).toBe(true);
  expect(container.textContent).toContain("全局");
      expect(container.textContent).toContain("无法获取工具列表");});
it("refresh re-reads disk config and status without a second save in flight", () => {
  reply({ a: { command: "node" } });
  statusReply({ discoveryState: "completed", servers: { a: { status: "connected", toolCount: 0, promptCount: 0, tools: [], prompts: [], contextTokens: 0 } } });
  click("刷新");
  expect(send.mock.calls.filter(([m]) => m.type === "listMcpServers")).toHaveLength(2);
  expect(send.mock.calls.filter(([m]) => m.type === "mcpStatus")).toHaveLength(2);
  expect(container.textContent).toContain("读取中…");
});
it("browse the template catalog and install a form-filled entry as a local draft", () => {
  reply({ existing: { command: "node" } });
  click("模板目录");
  expect(header.mock.calls.some(([h]) => h !== null && h.title === "模板目录")).toBe(true);
  expect(container.textContent).not.toContain("返回列表");
  expect(container.textContent).toContain("Filesystem");
  expect(container.textContent).toContain("@modelcontextprotocol/server-filesystem");
  clickTitle("安装");
  const inputs = container.querySelectorAll("input");
  expect(inputs).toHaveLength(2); // name + required directory field
  input(inputs[1] as unknown as HTMLInputElement, "J:\\demo");
  click("安装");
  const argValues = [...container.querySelectorAll("input")].map((el) => el.value);
  // The editor renders the stdio branch: each arg is its own input row.
  expect(argValues.some((v) => v.includes("J:\\demo"))).toBe(true);
  click("完成");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveMcpServers");
  expect(call.servers.existing).toEqual({ command: "node" });
  const installed = call.servers.filesystem;
  expect(installed).toEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "J:\\demo"],
  });
});
it("refuses installing a template whose required field was left blank", () => {
  reply({});
  click("模板目录");
  clickTitle("安装");
  click("安装");
  // The warning names the field the form shows, never the internal JSON key.
  expect(container.textContent).toContain("还需要填写：允许访问的目录（智能体只能在这里读写、搜索）");
  expect(container.textContent).not.toContain("还需要填写：directory");
  expect(send.mock.calls.filter(([m]) => m.type === "saveMcpServers")).toHaveLength(0);
});
it("edits command, arg and env rows while preserving unknown keys", () => {
  reply({ a: { command: "node", args: ["-x"], env: { TOKEN: "abc" }, description: "keep me", extra: { kept: true } } });
  clickTitle("编辑");
      expect(container.textContent).toContain("这些字段会原样保留：extra");  input(container.querySelectorAll("input")[1] as unknown as HTMLInputElement, "npx");
  input(container.querySelectorAll("input")[2] as unknown as HTMLInputElement, "-y");
  click("添加参数");
  input(container.querySelectorAll("input")[3] as unknown as HTMLInputElement, "--flag");
  input(container.querySelectorAll("input")[4] as unknown as HTMLInputElement, "TOKEN=xyz");
  click("完成");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveMcpServers");
  expect(call.servers.a).toEqual({ command: "npx", args: ["-y", "--flag"], env: { TOKEN: "xyz" }, description: "keep me", extra: { kept: true } });
});
it("blocks completing a stdio draft that has no command", () => {
  reply({});
  click("添加");
  input(container.querySelectorAll("input")[0] as unknown as HTMLInputElement, "demo");
  click("完成");
      expect(container.textContent).toContain("stdio 方式需要填写「命令」");  input(container.querySelectorAll("input")[1] as unknown as HTMLInputElement, "npx");
  click("完成");
      expect(container.textContent).not.toContain("stdio 方式需要填写「命令」");  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveMcpServers");
  expect(call.servers).toEqual({ demo: { command: "npx" } });
});
it("switching transport to sse moves the draft to the remote branch and requires url", () => {
  reply({});
  click("添加");
  input(container.querySelectorAll("input")[0] as unknown as HTMLInputElement, "demo");
  clickTitle("sse");
  click("完成");
      expect(container.textContent).toContain("sse / streamable-http 方式需要填写「服务 URL」");  input(container.querySelectorAll("input")[1] as unknown as HTMLInputElement, "https://mcp.example.com/mcp");
  click("完成");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.servers).toEqual({ demo: { url: "https://mcp.example.com/mcp", type: "sse" } });
});

function tab(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeTruthy();
  return button!;
}

it("disables the project tab when the host reports no project scope", () => {
  reply({ g: { command: "node" } });
  expect(tab("项目").hasAttribute("disabled")).toBe(true);
  expect(tab("全局").hasAttribute("disabled")).toBe(false);
  expect(container.textContent).toContain("~/.iflow/settings.json");
});

it("switches scope locally, flags the clash both ways and saves the active scope", () => {
  reply(
    { shared: { command: "node" }, onlyGlobal: { command: "g" } },
    undefined,
    { shared: { command: "npx" } },
  );
  // The CLI lets the project entry win, so the global row must say so.
  expect(container.textContent).toContain("被项目覆盖");
  expect(container.textContent).toContain("onlyGlobal");
  click("项目");
  // Switching is local: both dicts arrived in one reply.
  expect(send.mock.calls.filter(([m]) => m.type === "listMcpServers")).toHaveLength(1);
  expect(container.textContent).toContain("覆盖全局");
  expect(container.textContent).not.toContain("被项目覆盖");
  expect(container.textContent).not.toContain("onlyGlobal");
  expect(container.textContent).toContain("<工作区>/.iflow/settings.json");
  click("保存");
  const call = send.mock.calls.at(-1)![0];
  expect(call.type).toBe("saveMcpServers");
  expect(call.scope).toBe("project");
  expect(call.servers).toEqual({ shared: { command: "npx" } });
  reply(
    { shared: { command: "node" }, onlyGlobal: { command: "g" } },
    undefined,
    { shared: { command: "npx" } },
  );
  expect(container.textContent).toContain("已保存");
});

it("parks an unsaved draft per scope so a switch round trip does not lose it", () => {
  reply({ a: { command: "node" } }, undefined, { b: { command: "npx" } });
  click("添加");
  input(container.querySelectorAll("input")[0] as unknown as HTMLInputElement, "draft-global");
  input(container.querySelectorAll("input")[1] as unknown as HTMLInputElement, "node");
  click("完成");
  click("项目");
  expect(container.textContent).toContain("b");
  expect(container.textContent).not.toContain("draft-global");
  click("全局");
  expect(container.textContent).toContain("draft-global");
});

it("explains these servers are used by child sessions, not the main session", () => {
  reply({ a: { command: "node" } });
  expect(container.textContent).toContain("这些 MCP server 仅供超流体使用，主会话不加载 MCP。");
      expect(container.textContent).toContain("新建的超流体会通过宿主代理（broker）使用这些 server");});

it("does not read a main-session-blocked server as a failure without broker data", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        blocked: true, contextTokens: 0,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  // `blocked` alone means "main session never loads MCP" — never a red dot,
  // and the label says so rather than implying the server is broken.
  expect(spans.some((s) => s.className.includes("bg-destructive"))).toBe(false);
  expect(spans.some((s) => s.className.includes("bg-muted-foreground"))).toBe(true);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("主会话未加载 MCP"))).toBe(true);
  expect(container.textContent).not.toContain("已屏蔽");
});

it("lights a child-connected server green and treats the broker as authoritative", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "connected", toolCount: 1, promptCount: 0,
        tools: [{ name: "do_it" }], prompts: [], blocked: true,
        childConnected: true, contextTokens: 2000,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("bg-success"))).toBe(true);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("已在超流体连接"))).toBe(true);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("在超流体中占用约 2k tokens"))).toBe(true);
});

it("surfaces a real child-side failure in red with the child-session label", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        blocked: true, childConnected: false, error: "spawn ENOENT", errorKind: "unknown", contextTokens: 0,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("bg-destructive"))).toBe(true);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("超流体连接失败"))).toBe(true);
  clickTitle("详情");
  expect(container.textContent).toContain("超流体连接失败：");
  expect(container.textContent).toContain("spawn ENOENT");
});

it("explains in the detail page why no tools show up when only the main report exists", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "completed",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        blocked: true, contextTokens: 0,
      },
    },
  });
  clickTitle("详情");
  expect(container.textContent).toContain("主会话不加载 MCP，新建超流体并连接后才会上报工具列表");
});

it("uses the shared settings-group primitive and stays structurally within a 320px editor", () => {
  reply({ a: { command: "node", args: ["-y"], env: { TOKEN: "abc" } } });
  clickTitle("编辑");
  container.style.width = "320px";

  // jsdom has no layout engine (scrollWidth/clientWidth are 0), so the width
  // invariant holds trivially here; the structural assertions below are the
  // real guard for the narrow-screen fix.
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);

  // The editor root can shrink inside the narrow settings panel.
  expect(container.querySelector(".min-w-0.space-y-3")).toBeTruthy();

  // Both sections come from SettingsGroup: caption typography + tracked
  // heading, no drifted hand-written `tracking-wider` / `px-3 py-1.5` header.
  const headings = [...container.querySelectorAll("h3")];
  expect(headings).toHaveLength(2);
  expect(headings.every((h) => h.className.includes("tracking-[0.08em]") && h.className.includes("text-ui-caption"))).toBe(true);
  expect(container.querySelector(".tracking-wider")).toBeNull();

  // Transport row wraps so the shrink-0 Segmented drops to its own line.
  const transportRow = [...container.querySelectorAll("div")].find(
    (d) => d.firstElementChild?.textContent === "传输类型" && d.className.includes("flex-wrap"),
  );
  expect(transportRow).toBeTruthy();

  // Inline inputs in arg/env rows can shrink below their intrinsic width.
  const shrunk = [...container.querySelectorAll("input")].filter((el) => el.className.includes("flex-1"));
  expect(shrunk.length).toBeGreaterThan(0);
  expect(shrunk.every((el) => el.className.includes("min-w-0"))).toBe(true);
});

it("opens the editor directly from the detail header", () => {
  reply({ a: { command: "node" } });
  clickTitle("详情");
  expect(header.mock.calls.some(([h]) => h !== null && h.title === "MCP 服务器详情")).toBe(true);
  clickTitle("编辑");
  expect(header.mock.calls.some(([h]) => h !== null && h.title === "编辑 MCP 服务器")).toBe(true);
  expect(container.textContent).toContain("服务器信息");
});

it("keeps the list-page actions on a single row (primary left, conveniences right)", () => {
  // User feedback 2026-11-20: the block used to be TWO stacked strips
  // (添加/保存 above a divider, 模板目录/刷新 below a second one). All four
  // actions must share ONE row container now, or the block reads as two
  // unrelated toolbars.
  reply({ a: { command: "node" } });
  const byText = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  const add = byText("添加")!;
  const save = byText("保存")!;
  const catalog = byText("模板目录")!;
  const refresh = byText("刷新")!;
  expect(add && save && catalog && refresh).toBeTruthy();

  const row = add.closest("div.flex-wrap");
  expect(row).toBeTruthy();
  expect(row!.contains(save)).toBe(true);
  expect(row!.contains(catalog)).toBe(true);
  expect(row!.contains(refresh)).toBe(true);

  // Exactly one divider closes that row — the second strip's divider is gone.
  const strips = [...container.querySelectorAll("div")].filter((d) =>
    d.className.includes("border-b border-border/50"),
  );
  expect(strips).toHaveLength(1);
  expect(strips[0]).toBe(row);

  // Semantic layering survives the merge: 保存 stays the primary button, the
  // two conveniences stay ghost (never peers of it) and ride the row's right
  // edge — the panel convention (primary flow left, utility action right).
  expect(save.className).toContain("from-primary");
  expect(catalog.className).toContain("ml-auto");
  expect(catalog.className).not.toContain("from-primary");
  expect(refresh.className).not.toContain("from-primary");
});

it("shows a blue connecting dot (not red or neutral) while the broker handshake is in flight", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "in_progress",
    servers: {
      a: {
        status: "connecting", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        // The main session always reports `blocked`; a connecting broker must
        // still win over that neutral flag.
        blocked: true, childConnected: undefined, contextTokens: 0,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("bg-info"))).toBe(true);
  expect(spans.some((s) => s.className.includes("bg-destructive"))).toBe(false);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("连接中…"))).toBe(true);
});

it("reads discoveryState=in_progress as 'reading tools' even behind a blocked main report", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "in_progress",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        blocked: true, childConnected: undefined, contextTokens: 0,
      },
    },
  });
  clickTitle("详情");
  expect(container.textContent).toContain("正在读取工具列表…");
  expect(container.textContent).not.toContain("主会话不加载 MCP，新建超流体并连接后才会上报工具列表");
});

it("keeps a real child failure red even while discovery is still in progress", () => {
  reply({ a: { command: "node" } });
  statusReply({
    discoveryState: "in_progress",
    servers: {
      a: {
        status: "disconnected", toolCount: 0, promptCount: 0, tools: [], prompts: [],
        blocked: true, childConnected: false, error: "spawn ENOENT", errorKind: "spawn_failed", contextTokens: 0,
      },
    },
  });
  const spans = [...container.querySelectorAll("span")];
  expect(spans.some((s) => s.className.includes("bg-destructive"))).toBe(true);
  expect(spans.some((s) => (s.getAttribute("title") ?? "").includes("超流体连接失败"))).toBe(true);
});

it("exposes the full server name via title when the list row truncates it", () => {
  const name = "an-extremely-long-server-name-that-will-be-truncated-in-a-narrow-panel";
  reply({ [name]: { command: "node" } });
  const span = [...container.querySelectorAll("span")].find(
    (s) => s.textContent === name && s.className.includes("truncate"),
  );
  expect(span).toBeTruthy();
  expect(span!.getAttribute("title")).toBe(name);
});

it("exposes the full template title and description via title in the catalog", () => {
  reply({});
  click("模板目录");
  const title = "Filesystem";
  const description = "让智能体在你指定的本机目录里读写、搜索文件";
  const titleSpan = [...container.querySelectorAll("span")].find(
    (s) => s.textContent === title && s.className.includes("truncate"),
  );
  expect(titleSpan).toBeTruthy();
  expect(titleSpan!.getAttribute("title")).toBe(title);
  const descDiv = [...container.querySelectorAll("div")].find(
    (d) => d.textContent === description && d.className.includes("truncate"),
  );
  expect(descDiv).toBeTruthy();
  expect(descDiv!.getAttribute("title")).toBe(description);
});

it("exposes the full preserved-extra-keys list via title in the editor", () => {
  reply({ a: { command: "node", extraOne: 1, extraTwo: 2 } });
  clickTitle("编辑");
  const label = "这些字段会原样保留：extraOne, extraTwo";
  const div = [...container.querySelectorAll("div")].find(
    (d) => d.textContent === label && d.className.includes("truncate"),
  );
  expect(div).toBeTruthy();
  expect(div!.getAttribute("title")).toBe("extraOne, extraTwo");
});

it("shows a visible error alert instead of a false empty state when the initial read fails", () => {
  reply({}, "read failed: EACCES");
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("read failed: EACCES");
  // The empty-state copy would claim there are no MCP servers at all — it must
  // not replace the failure message.
  expect(container.textContent).not.toContain("尚未配置 MCP 服务器");
});
