// @vitest-environment jsdom
/**
 * 「超流体模型下拉」专用通道（`refreshSuperProfileModels` ↔ `superProfileModels`）
 * 的 **store 侧**闭环。`test/super-agent-endpoint-settings.test.tsx` 整体 mock 了
 * store，只能证明 UI 怎么消费视图；真正的「这条回包属于哪一次选择」判定在这里：
 *
 *  · 非空选择：只收 `profileName` 精确相等的回包；
 *  · 空串（跟随主会话）：以鉴权快照里 active 的 Profile 名当期望值，丢弃上一个
 *    非空选择的迟到回包（宿主回包乱序时不能把别的端点列表冒充成主链路结果）；
 *  · 活动 Profile 名解析不出来时照收（宁可多刷一次也不能卡在加载态）；
 *  · `iflow.superAgentProfile` 指针一变，旧列表立刻作废（乐观更新与宿主回声都算）。
 *
 * 另外钉住 dev 预览 mock host 的语义：空串解析为活动 Profile、未知配置回真
 * 实错误文案、且都不落到「未处理消息」的 warn 上。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialSessionState, type HostSettingsUi } from "../shared/messages";
import { useChat } from "../webview/src/store";

/** jsdom 下 store 模块求值时读 acquireVsCodeApi；不装桩 = 走 createMockHost。 */
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

const reply = (profileName: string) => ({
  type: "superProfileModels" as const,
  profileName,
  models: [{ id: `${profileName}-model`, name: `${profileName}-model` }],
  currentModelId: `${profileName}-model`,
});

beforeEach(() => {
  useChat.setState({ hostSettings: { ...settingsBase }, superProfileModelsView: null });
  seedState([
    { name: "gateway", modelName: "alpha-1", active: true },
    { name: "backup", modelName: "beta-2", active: false },
  ]);
});

describe("超流体模型列表回包的归属判定", () => {
  it("非空选择只接受同名回包", () => {
    setPointer("backup");
    useChat.getState().applyHostMessage(reply("gateway"));
    expect(useChat.getState().superProfileModelsView).toBeNull();

    useChat.getState().applyHostMessage(reply("backup"));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("backup");
  });

  it("空串选择丢弃上一个非空选择的迟到回包（A → 跟随主会话 → A 的回包迟到）", () => {
    setPointer("");
    // 活动 Profile 是 gateway；backup 的回包是切换前那次请求的迟到结果。
    useChat.getState().applyHostMessage(reply("backup"));
    expect(useChat.getState().superProfileModelsView).toBeNull();

    // 跟随主链路自己的回包（宿主解析出的活动 Profile 名）照收。
    useChat.getState().applyHostMessage(reply("gateway"));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("gateway");
  });

  it("空串选择下活动 Profile 名未知时照收回包，不把下拉卡在加载态", () => {
    setPointer("");
    seedState([]);
    useChat.getState().applyHostMessage(reply("unknown-endpoint"));
    expect(useChat.getState().superProfileModelsView?.profileName).toBe("unknown-endpoint");
  });

  it("宿主解析不出名字（profileName 为空串）时照收", () => {
    setPointer("");
    useChat.getState().applyHostMessage({ ...reply("gateway"), profileName: "" });
    expect(useChat.getState().superProfileModelsView).not.toBeNull();
  });

  it("切换 API 配置指针会作废旧列表（乐观更新路径）", () => {
    setPointer("backup");
    useChat.getState().applyHostMessage(reply("backup"));
    expect(useChat.getState().superProfileModelsView).not.toBeNull();

    useChat.getState().updateHostSetting({ superAgentProfile: "" });
    expect(useChat.getState().superProfileModelsView).toBeNull();
  });

  it("宿主回声换了指针也会作废旧列表，且不相关的设置回推不清空", () => {
    setPointer("backup");
    useChat.getState().applyHostMessage(reply("backup"));
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

  it("空串解析为活动 Profile，回包带该端点的模型列表且不触发未处理消息告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => seen.push(event.data as Record<string, unknown>);
    window.addEventListener("message", onMessage);
    const chat = await preview();

    chat.getState().send({ type: "refreshSuperProfileModels", profileName: "" });
    await wait(150);

    const replyMsg = seen.find((m) => m.type === "superProfileModels");
    expect(replyMsg).toMatchObject({ profileName: "工作密钥", currentModelId: "deepseek-v4-pro" });
    expect(warn).not.toHaveBeenCalled();
    window.removeEventListener("message", onMessage);
    warn.mockRestore();
  });

  it("未知 API 配置回宿主同款真实错误文案", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const onMessage = (event: MessageEvent) => seen.push(event.data as Record<string, unknown>);
    window.addEventListener("message", onMessage);
    const chat = await preview();

    chat.getState().send({ type: "refreshSuperProfileModels", profileName: "ghost" });
    await wait(150);

    const replyMsg = seen.find((m) => m.type === "superProfileModels");
    expect(replyMsg).toMatchObject({ profileName: "ghost", models: [], error: "未找到 API 配置：ghost" });
    window.removeEventListener("message", onMessage);
  });
});
