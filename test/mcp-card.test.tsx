// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpSection } from "../webview/src/components/McpCard";
import { entriesToServers, sameMcpServers } from "../webview/src/components/mcp-servers";

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
function reply(servers: Record<string, unknown>, error?: string) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "mcpServers", servers, error } })));
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
  click("返回");
  expect(header.mock.calls.some(([h]) => h === null)).toBe(true);
});
it("refresh re-reads disk config and status without a second save in flight", () => {
  reply({ a: { command: "node" } });
  statusReply({ discoveryState: "completed", servers: { a: { status: "connected", toolCount: 0, promptCount: 0, tools: [], prompts: [], contextTokens: 0 } } });
  click("刷新");
  expect(send.mock.calls.filter(([m]) => m.type === "listMcpServers")).toHaveLength(2);
  expect(send.mock.calls.filter(([m]) => m.type === "mcpStatus")).toHaveLength(2);
  expect(container.textContent).toContain("读取中…");
});
