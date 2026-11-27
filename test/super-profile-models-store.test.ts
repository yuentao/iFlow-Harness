// @vitest-environment jsdom
/**
 * 「超流体模型下拉」专用通道（`refreshSuperProfileModels` ↔ `superProfileModels`）
 * 的 **store 侧**闭环。`test/super-agent-endpoint-settings.test.tsx` 整体 mock 了
 * store，只能证明 UI 怎么消费视图；真正的「这条回包属于哪一次请求」判定在这里：
 *
 *  · 请求带自增 `requestId`，回包只在 id 与**最近一次请求**配对时入库
 *    （迟到的旧回包一律丢弃）—— 与 `requestSuperResidueList` 同款语义；
 *  · 这条判据不依赖「能否确定活动 Profile 名」，所以「活动名解析不出来就放行
 *    迟到回包」的洞被堵上（旧启发式只保留给没有 id 的宿主主动推送）；
 *  · `iflow.superAgentProfile` 指针一变，旧列表立刻作废（乐观更新与宿主回声都算）。
 *
 * 另外钉住 dev 预览 mock host 的语义：空串解析为活动 Profile、未知配置回真
 * 实错误文案、回包原样回显 requestId、且都不落到「未处理消息」的 warn 上。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialSessionState, type HostSettingsUi } from "../shared/messages";

/**
 * store 模块求值时读 `acquireVsCodeApi`。这里先用 vi.hoisted 在导入前装桩并
 * 捕获全部 webview → host 消息：普通用例只验证「发出了什么」，绝不能落到
 * dev mock host（它的回包有 60ms 延迟，会串进后面的 dev 预览用例）。
 * dev 预览那组用例再删桩 + resetModules，重建真正的 mock host。
 */
const capture = vi.hoisted(() => {
  const posted: Array<Record<string, unknown>> = [];
  (globalThis as typeof globalThis & {
    acquireVsCodeApi: () => { postMessage: (m: unknown) => void };
  }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => {
      posted.push(m as Record<string, unknown>);
    },
  });
  return { posted };
});

import { useChat } from "../webview/src/store";

const settingsBase = {
  superAgentProfile: "",
  superAgentModel: "",
} as HostSettingsUi;

function seedState(profiles: Array<{ name: string; modelName: string; active: boolean }>): void {
  const base = initialSessionState();
  useChat.setState({
    state: {
      ...base,
      auth: {
        ...base.auth,
        profiles: profiles.map((p) => ({ ...p, baseUrl: `https://${p.name}.example/v1`, keyTail: "…test" })),
      },
    },
  });
}

function setPointer(superAgentProfile: string): void {
  useChat.getState().applyHostMessage({
    type: "hostSettings",
    ...settingsBase,
    superAgentProfile,
  });
}

/** 最近一次 webview → host 消息。 */
function lastSent(): Record<string, unknown> {
  const sent = capture.posted[capture.posted.length - 1];
  if (!sent) throw new Error("nothing was posted");
  return sent;
}

/** 走专用的请求 action，返回这次发出的 requestId（= store 记录的最近一次）。 */
function request(profileName: string): number {
  useChat.getState().requestSuperProfileModels(profileName);
  const requestId = useChat.getState().superProfileModelsRequestId;
  if (requestId === null) throw new Error("requestSuperProfileModels 没有记录 requestId");
  // 发出的 wire 消息同时带上 requestId（宿主据此原样回显）。
  const sent = lastSent();
  expect(sent).toMatchObject({ type: "refreshSuperProfileModels", requestId });
  return requestId;
}

const reply = (profileName: string, requestId: number) => ({
  type: "superProfileModels" as const,
  requestId,
  profileName,
  models: [{ id: `${profileName}-model`, name: `${profileName}-model` }],
  currentModelId: `${profileName}-model`,
});

beforeEach(() => {
  capture.posted.length = 0;
  useChat.setState({
    hostSettings: { ...settingsBase },
    superProfileModelsView: null,
    superProfileModelsRequestId: null,
  });
  seedState([
    { name: "gateway", modelName: "alpha-1", active: true },
    { name: "backup", modelName: "beta-2", active: false },
  ]);
});

describe("超流体模型列表 · 请求序号配对", () => {
  it("requestSuperProfileModels 发出带自增 requestId 的请求，并记录为最近一次", () => {
    const first = request("backup");
    expect(typeof first).toBe("number");
    expect(useChat.getState().superProfileModelsRequestId).toBe(first);

    const second = request("backup");
    expect(second).toBeGreaterThan(first);
    expect(useChat.getState().superProfileModelsRequestId).toBe(second);
  });

  it("与最近一次请求配对的回包才入库", () => {
    const requestId = request("backup");
    useChat.getState().applyHostMessage(reply("backup", requestId));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("backup");
  });

  it("旧 requestId 的回包迟到时被丢弃（即便 profileName 与当前选择同名）", () => {
    const stale = request("backup");
    const fresh = request("backup");
    expect(fresh).not.toBe(stale);

    // 第一次请求的慢回包后到：profileName 完全一致，但 id 已过期。
    useChat.getState().applyHostMessage(reply("backup", stale));
    expect(useChat.getState().superProfileModelsView).toBeNull();

    useChat.getState().applyHostMessage(reply("backup", fresh));
    expect(useChat.getState().superProfileModelsView).not.toBeNull();
  });

  it("活动 Profile 名解析不出来时，迟到的旧 requestId 回包依然被丢弃", () => {
    // 旧实现的洞：空串选择 + 鉴权快照没有 active 行 → 启发式「放行」，
    // 于是 A → 跟随主会话 之后，A 的迟到回包会冒充主链路结果。
    setPointer("");
    seedState([]);
    const stale = request("");
    const fresh = request("");

    useChat.getState().applyHostMessage(reply("unknown-endpoint", stale));
    expect(useChat.getState().superProfileModelsView).toBeNull();

    useChat.getState().applyHostMessage(reply("unknown-endpoint", fresh));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("unknown-endpoint");
  });

  it("跟随主会话时，切换前的旧端点回包（旧 id）不会串台", () => {
    const stale = request("backup");
    setPointer("");
    const fresh = request("");

    useChat.getState().applyHostMessage(reply("backup", stale));
    expect(useChat.getState().superProfileModelsView).toBeNull();

    useChat.getState().applyHostMessage(reply("gateway", fresh));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("gateway");
  });

  it("宿主主动推送（无 requestId）仍按 profileName 启发式双保险过滤", () => {
    setPointer("backup");
    request("backup");
    // 无 id：走启发式 —— 与当前非空选择不同名的推送被丢弃。
    useChat.getState().applyHostMessage({ ...reply("gateway", 0), requestId: undefined });
    expect(useChat.getState().superProfileModelsView).toBeNull();

    useChat.getState().applyHostMessage({ ...reply("backup", 0), requestId: undefined });
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("backup");
  });

  it("切换 API 配置指针会作废旧列表（乐观更新路径）", () => {
    setPointer("backup");
    useChat.getState().applyHostMessage(reply("backup", request("backup")));
    expect(useChat.getState().superProfileModelsView).not.toBeNull();

    useChat.getState().updateHostSetting({ superAgentProfile: "" });
    expect(useChat.getState().superProfileModelsView).toBeNull();
  });

  it("宿主回声换了指针也会作废旧列表，且不相关的设置回推不清空", () => {
    setPointer("backup");
    useChat.getState().applyHostMessage(reply("backup", request("backup")));
    expect(useChat.getState().superProfileModelsView).not.toBeNull();

    // 同一个指针的整份设置回推：列表保留（否则每次设置写入都会闪一下加载态）。
    setPointer("backup");
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("backup");

    setPointer("");
    expect(useChat.getState().superProfileModelsView).toBeNull();
  });
});

describe("dev 预览 mock host 的 refreshSuperProfileModels 语义", () => {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function preview(): Promise<typeof useChat> {
    vi.resetModules();
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const mod = await import("../webview/src/store");
    return mod.useChat;
  }

  it("空串解析为活动 Profile，回包原样回显 requestId 且不触发未处理消息告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => seen.push(event.data as Record<string, unknown>);
    window.addEventListener("message", onMessage);
    const chat = await preview();

    chat.getState().requestSuperProfileModels("");
    const requestId = chat.getState().superProfileModelsRequestId;
    expect(typeof requestId).toBe("number");
    await wait(150);

    const replyMsg = seen.find((m) => m.type === "superProfileModels");
    expect(replyMsg).toMatchObject({
      profileName: "工作密钥",
      currentModelId: "deepseek-v4-pro",
      requestId,
    });
    expect(warn).not.toHaveBeenCalled();
    window.removeEventListener("message", onMessage);
    warn.mockRestore();
  });

  it("未知 API 配置回宿主同款真实错误文案，同样回显 requestId", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => seen.push(event.data as Record<string, unknown>);
    window.addEventListener("message", onMessage);
    const chat = await preview();

    chat.getState().requestSuperProfileModels("ghost");
    const requestId = chat.getState().superProfileModelsRequestId;
    await wait(150);

    const replyMsg = seen.find((m) => m.type === "superProfileModels");
    expect(replyMsg).toMatchObject({
      profileName: "ghost",
      models: [],
      error: "未找到 API 配置：ghost",
      requestId,
    });
    window.removeEventListener("message", onMessage);
  });
});