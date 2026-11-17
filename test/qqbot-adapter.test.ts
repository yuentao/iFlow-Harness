import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import {
  QqBotAdapter,
  QQBOT_INTENTS,
  QQBOT_OP,
  TOKEN_REFRESH_SKEW_MS,
  type QqBotSocket,
  type QqBotTransport,
} from "../src/qq/qqbot/adapter.js";
import {
  buildAccessTokenRequest,
  buildAuthHeaders,
  buildSendGroupMsg,
  buildSendPrivateMsg,
  cleanQqBotContent,
  DEFAULT_QQBOT_GATEWAY_URL,
  normalizeQqBotEvent,
  parseAccessTokenResponse,
} from "../src/qq/qqbot/protocol.js";
import { parseQqCommand } from "../shared/qq-command.js";

// ---------------------------------------------------------------------------
// 纯协议层
// ---------------------------------------------------------------------------

describe("normalizeQqBotEvent", () => {
  it("C2C_MESSAGE_CREATE → 私聊，chatId=sender openid，mentionsBot=true", () => {
    const inbound = normalizeQqBotEvent({
      op: QQBOT_OP.DISPATCH,
      s: 1,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-c2c-1",
        author: { id: "openid-user-1", unionid: "u-1" },
        content: "你好机器人",
        timestamp: "2026-11-17T10:00:00+08:00",
        attachments: [],
      },
    });
    expect(inbound).not.toBeNull();
    expect(inbound).toMatchObject({
      chatType: "private",
      chatId: "openid-user-1",
      senderId: "openid-user-1",
      msgId: "msg-c2c-1",
      text: "你好机器人",
      mentionsBot: true,
      attachments: [],
    });
    expect(inbound?.timestamp).toBe(Date.parse("2026-11-17T10:00:00+08:00"));
  });

  it("GROUP_AT_MESSAGE_CREATE → 群聊，chatId=group openid，mentionsBot=true", () => {
    const inbound = normalizeQqBotEvent({
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "msg-group-at-1",
        group_id: "group-openid-1",
        group_openid: "group-openid-1",
        author: { member_openid: "member-openid-1", id: "member-openid-1" },
        content: "帮我看下构建",
        timestamp: 1763359200000,
      },
    });
    expect(inbound).toMatchObject({
      chatType: "group",
      chatId: "group-openid-1",
      senderId: "member-openid-1",
      msgId: "msg-group-at-1",
      text: "帮我看下构建",
      mentionsBot: true,
    });
    expect(inbound?.timestamp).toBe(1763359200000);
  });

  it("GROUP_MESSAGE_CREATE 无 @ → mentionsBot=false；带 <@> 标记 → true", () => {
    const plain = normalizeQqBotEvent({
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "g-1",
        group_id: "group-openid-2",
        author: { id: "member-2" },
        content: "大家早",
      },
    });
    expect(plain?.chatType).toBe("group");
    expect(plain?.mentionsBot).toBe(false);
    expect(plain?.text).toBe("大家早");

    const mentioned = normalizeQqBotEvent({
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "g-2",
        group_id: "group-openid-2",
        author: { id: "member-3" },
        content: "<@12345> 在吗",
      },
    });
    expect(mentioned?.mentionsBot).toBe(true);
    expect(mentioned?.text).toBe("在吗");
  });

  it("系统/未知事件（Hello / READY / 任意非消息事件）返回 null", () => {
    expect(normalizeQqBotEvent({ op: QQBOT_OP.HELLO, d: { heartbeat_interval: 45000 } })).toBeNull();
    expect(normalizeQqBotEvent({ t: "READY", d: {} })).toBeNull();
    expect(normalizeQqBotEvent({ t: "GUILD_CREATE", d: { id: "x" } })).toBeNull();
    expect(normalizeQqBotEvent({ op: QQBOT_OP.HEARTBEAT_ACK, s: 3 })).toBeNull();
  });

  it("content 清洗：去 <@>/<at> 与 @提及、保留换行结构、收敛行内空白", () => {
    // 字面量 \n 也是换行（很多网关把换行转义后塞进 content），不能折成空格。
    expect(cleanQqBotContent("<@bot> 你好\n世界\\n再见")).toBe("你好\n世界\n再见");
    expect(cleanQqBotContent("@机器人 请帮我看看")).toBe("请帮我看看");
    expect(cleanQqBotContent("<at id=\"123\"> 开始任务")).toBe("开始任务");
    // 邮箱里的 @ 不该被吃掉。
    expect(cleanQqBotContent("发到 user@example.com 谢谢")).toBe("发到 user@example.com 谢谢");
    expect(cleanQqBotContent(undefined)).toBe("");
  });

  it("content 清洗：保留单换行，连续空白行压成最多一个空行，首尾空白 trim", () => {
    expect(cleanQqBotContent("第一行\n第二行")).toBe("第一行\n第二行");
    expect(cleanQqBotContent("第一行\n\n\n\n第二行")).toBe("第一行\n\n第二行");
    expect(cleanQqBotContent("\n\n  第一行  \n\n")).toBe("第一行");
    expect(cleanQqBotContent("  第一行   \n  第二行  ")).toBe("第一行\n第二行");
  });

  it("content 清洗：剥 @ 后行结构不变", () => {
    expect(cleanQqBotContent("<@123> /qq task 第一行\n<@!456> 第二行")).toBe(
      "/qq task 第一行\n第二行",
    );
  });

  it("含换行的群消息：normalizeQqBotEvent 保留换行，parseQqCommand 取到多行 task prompt", () => {
    const inbound = normalizeQqBotEvent({
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "msg-multi",
        group_openid: "group-multi",
        author: { member_openid: "member-multi" },
        content: "<@bot> /qq task 第一行\n\n第二行",
      },
    });
    expect(inbound?.mentionsBot).toBe(true);
    expect(inbound?.text).toBe("/qq task 第一行\n\n第二行");
    expect(parseQqCommand(inbound?.text ?? "")).toEqual({
      ok: true,
      intent: { kind: "task", prompt: "第一行\n\n第二行" },
    });
  });

  it("附件映射：content_type 决定 kind，url/filename/size/file_uuid 逐字段映射", () => {
    const inbound = normalizeQqBotEvent({
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "m-att",
        author: { id: "openid-att" },
        content: "看图",
        attachments: [
          {
            content_type: "image/png",
            url: "https://example.com/a.png",
            filename: "a.png",
            size: 1234,
            file_uuid: "uuid-a",
          },
          {
            content_type: "application/pdf",
            url: "https://example.com/b.pdf",
            filename: "b.pdf",
            size: 9999,
            file_info: "info-b",
          },
          { content_type: "image/jpeg" },
          null,
        ],
      },
    });
    expect(inbound?.attachments).toEqual([
      { kind: "image", url: "https://example.com/a.png", fileId: "uuid-a", name: "a.png", sizeBytes: 1234 },
      { kind: "file", url: "https://example.com/b.pdf", fileId: "info-b", name: "b.pdf", sizeBytes: 9999 },
      { kind: "image" },
    ]);
  });

  it("缺字段不崩：msgId/sender/text 退化为 ''，时间退化为当前毫秒；定位不到 chatId 返回 null", () => {
    const before = Date.now();
    const inbound = normalizeQqBotEvent({
      t: "GROUP_MESSAGE_CREATE",
      d: { group_id: "g-minimal" },
    });
    const after = Date.now();
    expect(inbound).toMatchObject({
      chatType: "group",
      chatId: "g-minimal",
      senderId: "",
      msgId: "",
      text: "",
      mentionsBot: false,
      attachments: [],
    });
    expect(inbound?.timestamp).toBeGreaterThanOrEqual(before);
    expect(inbound?.timestamp).toBeLessThanOrEqual(after);

    expect(normalizeQqBotEvent({ t: "C2C_MESSAGE_CREATE", d: { content: "hi" } })).toBeNull();
    expect(normalizeQqBotEvent(null)).toBeNull();
    expect(normalizeQqBotEvent("not an event")).toBeNull();
  });

  it("兼容直接传 d 载荷（带 t、无 d 包装）", () => {
    const inbound = normalizeQqBotEvent({
      t: "C2C_MESSAGE_CREATE",
      id: "bare-1",
      author: { id: "openid-bare" },
      content: "直接载荷",
      timestamp: "2026-11-17T00:00:00Z",
    });
    expect(inbound?.chatId).toBe("openid-bare");
    expect(inbound?.text).toBe("直接载荷");
    expect(inbound?.timestamp).toBe(Date.parse("2026-11-17T00:00:00Z"));
  });
});

describe("鉴权与 OpenAPI 载荷构造", () => {
  it("buildAuthHeaders → Authorization: QQBot <token>", () => {
    expect(buildAuthHeaders("tok-abc")).toEqual({ Authorization: "QQBot tok-abc" });
  });

  it("buildAccessTokenRequest / parseAccessTokenResponse", () => {
    const request = buildAccessTokenRequest("app-1", "secret-1");
    expect(request.method).toBe("POST");
    expect(request.endpoint).toContain("getAppAccessToken");
    expect(request.body).toEqual({ appId: "app-1", clientSecret: "secret-1" });

    expect(parseAccessTokenResponse({ access_token: "tok-1", expires_in: 7200 })).toEqual({
      accessToken: "tok-1",
      expiresIn: 7200,
    });
    expect(parseAccessTokenResponse({ access_token: "tok-1", expires_in: "3600" })).toEqual({
      accessToken: "tok-1",
      expiresIn: 3600,
    });
    expect(parseAccessTokenResponse({ access_token: "tok-1" })?.expiresIn).toBe(7200);
    expect(parseAccessTokenResponse({ expires_in: 7200 })).toBeNull();
    expect(parseAccessTokenResponse("bad")).toBeNull();
  });

  it("buildSendPrivateMsg / buildSendGroupMsg：正确 endpoint、body、msg_id 可选", () => {
    const priv = buildSendPrivateMsg("openid-x", "你好");
    expect(priv).toEqual({
      endpoint: "https://api.sgroup.qq.com/v2/users/openid-x/messages",
      method: "POST",
      body: { content: "你好" },
    });
    const privReply = buildSendPrivateMsg("openid-x", "收到", "msg-9");
    expect(privReply.body).toEqual({ content: "收到", msg_id: "msg-9" });

    const group = buildSendGroupMsg("group-y", "群消息", "msg-10");
    expect(group.endpoint).toBe("https://api.sgroup.qq.com/v2/groups/group-y/messages");
    expect(group.method).toBe("POST");
    expect(group.body).toEqual({ content: "群消息", msg_id: "msg-10" });
  });
});

// ---------------------------------------------------------------------------
// adapter（注入假 transport）
// ---------------------------------------------------------------------------

class FakeSocket implements QqBotSocket {
  readonly sent: unknown[] = [];
  readonly closed = { value: false };
  private callback: ((raw: unknown) => void) | undefined;

  onMessage(cb: (raw: unknown) => void): void {
    this.callback = cb;
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed.value = true;
  }
  emit(raw: unknown): void {
    this.callback?.(raw);
  }
}

class FakeTransport implements QqBotTransport {
  readonly posts: Array<{ endpoint: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  readonly connects: Array<{ url: string; headers: Record<string, string> }> = [];
  readonly socket = new FakeSocket();
  tokenResponse: unknown = { access_token: "tok-1", expires_in: 7200 };

  async connect(url: string, headers: Record<string, string>): Promise<QqBotSocket> {
    this.connects.push({ url, headers });
    return this.socket;
  }
  async post(
    endpoint: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    this.posts.push({ endpoint, headers, body });
    if (endpoint.includes("getAppAccessToken")) return this.tokenResponse;
    return { id: "sent-1" };
  }

  tokenRequestCount(): number {
    return this.posts.filter((p) => p.endpoint.includes("getAppAccessToken")).length;
  }
}

function helloFrame(intervalMs = 60_000): unknown {
  return { op: QQBOT_OP.HELLO, d: { heartbeat_interval: intervalMs } };
}

function dispatchFrame(t: string, d: Record<string, unknown>, s = 1): unknown {
  return { op: QQBOT_OP.DISPATCH, s, t, d };
}

const c2cPayload = {
  id: "in-1",
  author: { id: "openid-in-1" },
  content: "请帮我看构建",
  timestamp: "2026-11-17T09:00:00+08:00",
};

describe("QqBotAdapter", () => {
  it("connect：先换 token → 再建连（带鉴权头）→ Hello 回 Identify → Dispatch 推 InboundMessage", async () => {
    const transport = new FakeTransport();
    const received: InboundMessage[] = [];
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
    }).setEventCallback((msg) => {
      received.push(msg);
    });

    await adapter.connect();
    expect(transport.tokenRequestCount()).toBe(1);
    expect(transport.connects).toHaveLength(1);
    expect(transport.connects[0]).toMatchObject({ url: DEFAULT_QQBOT_GATEWAY_URL });
    expect(transport.connects[0]?.headers).toEqual({ Authorization: "QQBot tok-1" });

    // Hello → Identify（op=2，token 带 QQBot 前缀，intents 正确）。
    transport.socket.emit(helloFrame());
    expect(transport.socket.sent).toHaveLength(1);
    const identify = transport.socket.sent[0] as { op: number; d: { token: string; intents: number } };
    expect(identify.op).toBe(QQBOT_OP.IDENTIFY);
    expect(identify.d.token).toBe("QQBot tok-1");
    expect(identify.d.intents).toBe(QQBOT_INTENTS);

    // Dispatch → onEvent。
    transport.socket.emit(dispatchFrame("C2C_MESSAGE_CREATE", c2cPayload, 7));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ chatType: "private", chatId: "openid-in-1", text: "请帮我看构建" });

    // 下一次心跳应带上最后序列号 7。
    transport.socket.emit({ op: QQBOT_OP.HEARTBEAT });
    const heartbeat = transport.socket.sent.at(-1) as { op: number; d: number | null };
    expect(heartbeat.op).toBe(QQBOT_OP.HEARTBEAT);
    expect(heartbeat.d).toBe(7);

    expect(await adapter.health()).toMatchObject({ connected: true });
    await adapter.close();
    expect(transport.socket.closed.value).toBe(true);
    expect(await adapter.health()).toMatchObject({ connected: false });
  });

  it("token 缓存：未过期不重复换；过期前 5 分钟内会刷新", async () => {
    let clock = 1_000_000;
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      now: () => clock,
    });

    await adapter.connect();
    expect(transport.tokenRequestCount()).toBe(1);

    // 多次 send 均复用同一 token（7200s 有效期远未到刷新阈值）。
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "a" });
    await adapter.send({ chatType: "group", chatId: "group-1", text: "b" });
    expect(transport.tokenRequestCount()).toBe(1);

    // 推进到「距过期不足 5 分钟」之后 → 下次 send 触发刷新。
    clock += 7200 * 1000 - TOKEN_REFRESH_SKEW_MS + 1000;
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "c" });
    expect(transport.tokenRequestCount()).toBe(2);

    await adapter.close();
  });

  it("send：私聊/群聊走正确 endpoint，带鉴权头，回传 messageId", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

    const priv = await adapter.send({ chatType: "private", chatId: "openid-1", text: "hi", replyToMsgId: "m-0" });
    expect(priv).toEqual({ ok: true, messageId: "sent-1" });
    const privPost = transport.posts.find((p) => p.endpoint.includes("/users/"));
    expect(privPost?.endpoint).toBe("https://api.sgroup.qq.com/v2/users/openid-1/messages");
    expect(privPost?.headers).toMatchObject({ Authorization: "QQBot tok-1", "content-type": "application/json" });
    expect(privPost?.body).toEqual({ content: "hi", msg_id: "m-0" });

    const group = await adapter.send({ chatType: "group", chatId: "group-1", text: "hello" });
    expect(group.ok).toBe(true);
    const groupPost = transport.posts.find((p) => p.endpoint.includes("/groups/"));
    expect(groupPost?.endpoint).toBe("https://api.sgroup.qq.com/v2/groups/group-1/messages");
    expect(groupPost?.body).toEqual({ content: "hello" });

    // 富媒体在 M2 明确不支持，retryable=false 交给上层提示用户。
    const file = await adapter.send({ chatType: "private", chatId: "openid-1", text: "", filePath: "/tmp/a.png" });
    expect(file).toMatchObject({ ok: false, retryable: false });

    await adapter.close();
  });

  it("心跳定时：Hello 启动周期心跳，close 后停止；token 不出现在 log", async () => {
    const transport = new FakeTransport();
    const logs: string[] = [];
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      log: (line) => logs.push(line),
    });

    await adapter.connect();
    transport.socket.emit(helloFrame(25));
    await new Promise((resolve) => setTimeout(resolve, 70));
    const heartbeatsAfterStart = transport.socket.sent.filter(
      (frame) => (frame as { op: number }).op === QQBOT_OP.HEARTBEAT,
    ).length;
    expect(heartbeatsAfterStart).toBeGreaterThan(0);

    await adapter.close();
    const countAtClose = transport.socket.sent.filter(
      (frame) => (frame as { op: number }).op === QQBOT_OP.HEARTBEAT,
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    const countAfterClose = transport.socket.sent.filter(
      (frame) => (frame as { op: number }).op === QQBOT_OP.HEARTBEAT,
    ).length;
    expect(countAfterClose).toBe(countAtClose);

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain("tok-1");
    expect(logs.join("\n")).not.toContain("secret-1");
  });

  it("token 换取失败：connect 抛错，上层可重试；错误文本不含凭据", async () => {
    const transport = new FakeTransport();
    transport.tokenResponse = { error: "bad secret" };
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });
    await expect(adapter.connect()).rejects.toThrow("未返回 access_token");
    expect(transport.connects).toHaveLength(0);
  });
});
