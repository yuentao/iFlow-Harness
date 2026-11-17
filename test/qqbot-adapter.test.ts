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

  it("buildSendPrivateMsg / buildSendGroupMsg：正确 endpoint、body、msg_id 与 msg_seq 可选", () => {
    const priv = buildSendPrivateMsg("openid-x", "你好");
    expect(priv).toEqual({
      endpoint: "https://api.sgroup.qq.com/v2/users/openid-x/messages",
      method: "POST",
      body: { content: "你好" },
    });
    const privReply = buildSendPrivateMsg("openid-x", "收到", "msg-9");
    expect(privReply.body).toEqual({ content: "收到", msg_id: "msg-9" });
    // msg_seq 必须随 msg_id 一起出现在 body 里，否则同一条消息的第二条回复
    // 会被平台按重复消息丢弃。
    const privSeq = buildSendPrivateMsg("openid-x", "结果", "msg-9", 2);
    expect(privSeq.body).toEqual({ content: "结果", msg_id: "msg-9", msg_seq: 2 });
    // 非法 seq（0 / NaN / 非有限）不写进 body，交给平台默认。
    expect(buildSendPrivateMsg("openid-x", "x", "msg-9", 0).body).toEqual({
      content: "x",
      msg_id: "msg-9",
    });

    const group = buildSendGroupMsg("group-y", "群消息", "msg-10");
    expect(group.endpoint).toBe("https://api.sgroup.qq.com/v2/groups/group-y/messages");
    expect(group.method).toBe("POST");
    expect(group.body).toEqual({ content: "群消息", msg_id: "msg-10" });
    expect(buildSendGroupMsg("group-y", "群结果", "msg-10", 3).body).toEqual({
      content: "群结果",
      msg_id: "msg-10",
      msg_seq: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// adapter（注入假 transport）
// ---------------------------------------------------------------------------

class FakeSocket implements QqBotSocket {
  readonly sent: unknown[] = [];
  readonly closed = { value: false };
  /** 为 true 时 send 抛错（模拟底层连接已死）。 */
  failSend = false;
  private callback: ((raw: unknown) => void) | undefined;
  private closeCallback: ((error?: unknown) => void) | undefined;

  onMessage(cb: (raw: unknown) => void): void {
    this.callback = cb;
  }
  onClose(cb: (error?: unknown) => void): void {
    this.closeCallback = cb;
  }
  send(data: unknown): void {
    if (this.failSend) throw new Error("socket is not open");
    this.sent.push(data);
  }
  close(): void {
    if (this.closed.value) return;
    this.closed.value = true;
    this.closeCallback?.();
  }
  /** 模拟底层异常断开（触发适配器的 onClose，而不是显式 close）。 */
  drop(error?: unknown): void {
    this.closed.value = true;
    this.closeCallback?.(error);
  }
  emit(raw: unknown): void {
    this.callback?.(raw);
  }
}

class FakeTransport implements QqBotTransport {
  readonly posts: Array<{ endpoint: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  readonly connects: Array<{ url: string; headers: Record<string, string> }> = [];
  readonly sockets: FakeSocket[] = [];
  tokenResponse: unknown = { access_token: "tok-1", expires_in: 7200 };
  /** 消息发送端点的响应体（默认成功）。 */
  sendResult: unknown = { id: "sent-1" };
  /** 非 undefined 时消息发送端点抛这个错误（模拟 transport 的非 2xx / 超时）。 */
  sendError: unknown;
  /** token 请求等待这个 promise（并发共享 in-flight 用例）。 */
  tokenGate: Promise<void> | undefined;
  /** 前 N 次 token 请求抛错（失败不缓存用例）。 */
  tokenFailures = 0;
  /** connect 抛错（重连失败用例）。 */
  connectError: unknown;
  private tokenAttempts = 0;

  /** 最近一次建连的 socket。 */
  get socket(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  async connect(url: string, headers: Record<string, string>): Promise<QqBotSocket> {
    this.connects.push({ url, headers });
    if (this.connectError !== undefined) throw this.connectError;
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
  async post(
    endpoint: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    this.posts.push({ endpoint, headers, body });
    if (endpoint.includes("getAppAccessToken")) {
      this.tokenAttempts += 1;
      if (this.tokenGate) await this.tokenGate;
      if (this.tokenAttempts <= this.tokenFailures) throw new Error("token endpoint down");
      return this.tokenResponse;
    }
    if (this.sendError !== undefined) throw this.sendError;
    return this.sendResult;
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
    // 被动回复必须带 msg_seq：QQ 用 (msg_id, msg_seq) 去重，缺省都当 1 会让
    // 同一条用户消息的第 2 条回复被平台当成重复消息丢掉。
    expect(privPost?.body).toEqual({ content: "hi", msg_id: "m-0", msg_seq: 1 });

    // 同一个 msg_id 的下一条回复序号递增（结果回包就靠这个才送得出去）。
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "结果", replyToMsgId: "m-0" });
    const secondReply = transport.posts.filter((p) => p.endpoint.includes("/users/")).at(-1);
    expect(secondReply?.body).toEqual({ content: "结果", msg_id: "m-0", msg_seq: 2 });

    // 换了 msg_id 就从头计数；主动消息（无 replyToMsgId）不带这两个字段。
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "另一条", replyToMsgId: "m-1" });
    const otherReply = transport.posts.filter((p) => p.endpoint.includes("/users/")).at(-1);
    expect(otherReply?.body).toEqual({ content: "另一条", msg_id: "m-1", msg_seq: 1 });

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

  it("dedupeKey：同一逻辑消息的重试复用同一 msg_seq（平台按 msg_id+msg_seq 去重）", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

    const base = { chatType: "private" as const, chatId: "openid-1", replyToMsgId: "m-0" };
    await adapter.send({ ...base, text: "attempt-1", dedupeKey: "task:T-1:1" });
    await adapter.send({ ...base, text: "attempt-2", dedupeKey: "task:T-1:1" });
    const bodies = transport.posts
      .filter((p) => p.endpoint.includes("/users/"))
      .map((p) => p.body);
    // 同一 dedupeKey 的两次发送共享 msg_seq：网络超时但实际已送达的重试不会
    // 被平台当成新消息刷出来；若首试真的失败，复用的 seq 等价于新消息。
    expect(bodies[0]).toEqual({ content: "attempt-1", msg_id: "m-0", msg_seq: 1 });
    expect(bodies[1]).toEqual({ content: "attempt-2", msg_id: "m-0", msg_seq: 1 });

    // 新逻辑消息（新 dedupeKey）正常递增，不与重试共享。
    await adapter.send({ ...base, text: "next", dedupeKey: "task:T-1:2" });
    expect(transport.posts.filter((p) => p.endpoint.includes("/users/")).at(-1)?.body).toEqual({
      content: "next",
      msg_id: "m-0",
      msg_seq: 2,
    });

    // 不带 dedupeKey 维持旧行为：每次发送都递增。
    await adapter.send({ ...base, text: "a" });
    await adapter.send({ ...base, text: "b" });
    const tail = transport.posts.filter((p) => p.endpoint.includes("/users/")).slice(-2);
    expect(tail[0]?.body).toEqual({ content: "a", msg_id: "m-0", msg_seq: 3 });
    expect(tail[1]?.body).toEqual({ content: "b", msg_id: "m-0", msg_seq: 4 });

    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 失败分类与序号记账（复核阻塞项 2026-11-17）
// ---------------------------------------------------------------------------

describe("QqBotAdapter — 失败分类", () => {
  function httpError(status: number): Error {
    // ws-transport 的 QqBotHttpError 形态：message + status 字段。
    return Object.assign(new Error(`QQBot: HTTP ${status} from /v2/users/x/messages`), {
      status,
    });
  }

  it("HTTP 4xx（429 除外）是确定性拒绝：retryable:false", async () => {
    for (const status of [400, 401, 403, 404]) {
      const transport = new FakeTransport();
      transport.sendError = httpError(status);
      const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

      const result = await adapter.send({ chatType: "private", chatId: "openid-1", text: "hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
        expect(result.error).toContain(`HTTP ${status}`);
      }

      await adapter.close();
    }
  });

  it("429 / 5xx / 超时 / 网络错误仍可重试：retryable:true", async () => {
    for (const status of [429, 500, 502, 503]) {
      const transport = new FakeTransport();
      transport.sendError = httpError(status);
      const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

      const result = await adapter.send({ chatType: "private", chatId: "openid-1", text: "hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);

      await adapter.close();
    }

    // 超时 / 网络错误没有 status：无法判定确定性，按可重试处理（保守一侧）。
    for (const error of [
      new Error("QQBot: 请求超时（15000ms）: /v2/users/x/messages"),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    ]) {
      const transport = new FakeTransport();
      transport.sendError = error;
      const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

      const result = await adapter.send({ chatType: "private", chatId: "openid-1", text: "hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);

      await adapter.close();
    }
  });

  it("HTTP 200 + 非零业务码算失败（不把没发出去的消息记成已送达）", async () => {
    const bodies = [
      { code: 40054, message: "主动消息额度已用尽" },
      { errcode: 11244, msg: "消息发送频率过快" },
      { retcode: 1 },
    ];
    for (const body of bodies) {
      const transport = new FakeTransport();
      transport.sendResult = body;
      const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

      const result = await adapter.send({ chatType: "private", chatId: "openid-1", text: "hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
        expect(result.error).toContain("业务错误");
      }

      await adapter.close();
    }

    // code: 0 表示成功（平台也可能在成功响应里回 0）。
    const transport = new FakeTransport();
    transport.sendResult = { code: 0, id: "sent-ok" };
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });
    await expect(
      adapter.send({ chatType: "private", chatId: "openid-1", text: "hi" }),
    ).resolves.toEqual({ ok: true, messageId: "sent-ok" });
    await adapter.close();
  });
});

describe("QqBotAdapter — 序号记账", () => {
  it("replySeq 逐出时同步作废 dedupe 条目（不会复用旧窗口的 seq）", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });
    const base = { chatType: "private" as const, chatId: "openid-1" };

    // 给 m-old 建立 seq 1、2，并缓存第二个逻辑消息的 seq。
    await adapter.send({ ...base, text: "old-1", replyToMsgId: "m-old", dedupeKey: "k-old-1" });
    await adapter.send({ ...base, text: "old-2", replyToMsgId: "m-old", dedupeKey: "k-old-2" });

    // 塞满序号表触发逐出（私有上限 5000，m-old 是最旧条目）。
    for (let i = 0; i < 5001; i += 1) {
      await adapter.send({ ...base, text: `churn-${i}`, replyToMsgId: `m-churn-${i}` });
    }

    // m-old 已被逐出：它的 dedupe 缓存必须一起作废。若缓存还在，这里会复用
    // 旧 seq=2；正确行为是按新窗口从 1 重开。
    await adapter.send({ ...base, text: "old-3", replyToMsgId: "m-old", dedupeKey: "k-old-2" });
    const last = transport.posts.filter((p) => p.endpoint.includes("/users/")).at(-1);
    expect(last?.body).toEqual({ content: "old-3", msg_id: "m-old", msg_seq: 1 });

    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 传输层七项修复（2026-11-17）：心跳隔离 / Resume / 空 msgId / token 并发 / 诊断
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("QqBotAdapter — 心跳异常隔离与重连", () => {
  it("心跳 send 抛错不穿透定时器：记 lastError → 主动断开 → 退避重连 → 心跳重启", async () => {
    const transport = new FakeTransport();
    const logs: string[] = [];
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      log: (line) => logs.push(line),
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
    });

    await adapter.connect();
    const first = transport.socket;
    first.emit(helloFrame(5));
    // 模拟底层已死但定时器还在跑：心跳 send 抛错。
    first.failSend = true;

    await sleep(40);

    expect(first.closed.value).toBe(true);
    expect(transport.connects.length).toBeGreaterThanOrEqual(2);
    expect(logs.join("\n")).toContain("心跳发送失败");

    // 新 socket：Hello 之后心跳定时器必须已重启（不是停在死连接上）。
    const second = transport.socket;
    second.emit(helloFrame(5));
    await sleep(25);
    const heartbeats = second.sent.filter(
      (frame) => (frame as { op: number }).op === QQBOT_OP.HEARTBEAT,
    );
    expect(heartbeats.length).toBeGreaterThan(0);

    await adapter.close();
  });

  it("心跳 send 抛错期间 health().detail 带出脱敏后的最近错误", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      reconnectBaseDelayMs: 500,
      reconnectMaxDelayMs: 500,
    });

    await adapter.connect();
    const socket = transport.socket;
    socket.emit(helloFrame(5));
    socket.failSend = true;

    await sleep(20);
    const health = await adapter.health();
    expect(health.connected).toBe(false);
    expect(health.detail).toContain("心跳发送失败");
    // 凭据绝不进 health。
    expect(health.detail).not.toContain("tok-1");
    expect(health.detail).not.toContain("secret-1");

    await adapter.close();
  });
});

describe("QqBotAdapter — 断线 Resume", () => {
  it("断线后用 resume_gateway_url 重连并发 op=6（session_id + 最近 seq），READY 后清除缺口提示", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
    });

    await adapter.connect();
    const first = transport.socket;
    first.emit(helloFrame(60_000));
    first.emit(
      dispatchFrame(
        "READY",
        { session_id: "sess-1", resume_gateway_url: "wss://resume.example/ws" },
        1,
      ),
    );
    first.emit(dispatchFrame("C2C_MESSAGE_CREATE", { ...c2cPayload, id: "m-1" }, 9));

    // 底层断开（不是用户 close）。
    first.drop();
    await sleep(40);

    expect(transport.connects).toHaveLength(2);
    expect(transport.connects[1]!.url).toBe("wss://resume.example/ws");

    const second = transport.socket;
    second.emit(helloFrame(60_000));
    const handshake = second.sent[0] as {
      op: number;
      d: { token: string; session_id: string; seq: number };
    };
    expect(handshake.op).toBe(QQBOT_OP.RESUME);
    expect(handshake.d).toMatchObject({
      token: "QQBot tok-1",
      session_id: "sess-1",
      seq: 9,
    });

    // Resume 成功的 READY：没有丢消息提示。
    second.emit(
      dispatchFrame(
        "READY",
        { session_id: "sess-1", resume_gateway_url: "wss://resume.example/ws" },
        10,
      ),
    );
    const health = await adapter.health();
    expect(health.connected).toBe(true);
    expect(health.detail).not.toContain("丢消息");

    await adapter.close();
  });

  it("op=9 作废会话：下一轮重连退回 Identify，且 health 保留「可能丢消息」提示", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
    });

    await adapter.connect();
    const first = transport.socket;
    first.emit(helloFrame(60_000));
    first.emit(
      dispatchFrame(
        "READY",
        { session_id: "sess-dead", resume_gateway_url: "wss://resume.example/ws" },
        3,
      ),
    );

    first.emit({ op: QQBOT_OP.INVALID_SESSION });
    expect((await adapter.health()).detail).toContain("会话已失效");

    first.drop();
    await sleep(40);

    // 会话已作废 → 不再连 resume 地址，而是回到默认网关。
    expect(transport.connects[1]!.url).toBe(DEFAULT_QQBOT_GATEWAY_URL);
    const second = transport.socket;
    second.emit(helloFrame(60_000));
    expect((second.sent[0] as { op: number }).op).toBe(QQBOT_OP.IDENTIFY);

    second.emit(dispatchFrame("READY", { session_id: "sess-new" }, 4));
    const health = await adapter.health();
    expect(health.detail).toContain("丢消息");

    await adapter.close();
  });

  it("resume 地址连续不可达：重试上限后退回默认网关 Identify，不无限卡住", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 10,
    });
    const gatewayConnect = transport.connect.bind(transport);
    let resumeAttempts = 0;
    transport.connect = async (url: string, headers: Record<string, string>) => {
      if (url.includes("resume.example")) {
        resumeAttempts += 1;
        throw new Error("resume gateway down");
      }
      return gatewayConnect(url, headers);
    };

    await adapter.connect();
    const first = transport.socket;
    first.emit(helloFrame(60_000));
    first.emit(
      dispatchFrame(
        "READY",
        { session_id: "sess-x", resume_gateway_url: "wss://resume.example/ws" },
        2,
      ),
    );
    first.drop();

    await sleep(200);
    expect(resumeAttempts).toBeGreaterThanOrEqual(3);
    // 最终在默认网关新建了一条连接（初始 socket + fallback socket）。
    expect(transport.sockets).toHaveLength(2);

    const second = transport.socket;
    second.emit(helloFrame(60_000));
    expect((second.sent[0] as { op: number }).op).toBe(QQBOT_OP.IDENTIFY);
    expect((await adapter.health()).detail).toContain("丢消息");

    await adapter.close();
  });
});

describe("QqBotAdapter — 空 msgId 丢弃", () => {
  it("缺 msgId 的入站事件不进回调，丢弃原因可观测（日志 + health）", async () => {
    const transport = new FakeTransport();
    const logs: string[] = [];
    const received: InboundMessage[] = [];
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
      log: (line) => logs.push(line),
    }).setEventCallback((msg) => {
      received.push(msg);
    });

    await adapter.connect();
    transport.socket.emit(helloFrame(60_000));

    // 无 id：normalize 后 msgId 为空串，必须丢弃。
    transport.socket.emit(
      dispatchFrame("C2C_MESSAGE_CREATE", { author: { id: "openid-1" }, content: "hi" }, 2),
    );
    expect(received).toHaveLength(0);
    expect(logs.join("\n")).toContain("missing msgId");
    expect((await adapter.health()).detail).toContain("msgId");

    // 正常消息不受影响。
    transport.socket.emit(dispatchFrame("C2C_MESSAGE_CREATE", c2cPayload, 3));
    expect(received).toHaveLength(1);

    await adapter.close();
  });
});

describe("QqBotAdapter — token 刷新并发与诊断", () => {
  it("并发 5 次发送共享同一次 token 刷新（只发 1 次 token 请求）", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    transport.tokenGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

    const sends = Array.from({ length: 5 }, (_, i) =>
      adapter.send({ chatType: "private", chatId: "openid-1", text: `t-${i}` }),
    );
    await sleep(0);
    expect(transport.tokenRequestCount()).toBe(1);

    release();
    const results = await Promise.all(sends);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(transport.tokenRequestCount()).toBe(1);

    await adapter.close();
  });

  it("token 刷新失败不缓存：下一次调用会重新请求", async () => {
    const transport = new FakeTransport();
    transport.tokenFailures = 1;
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

    const first = await adapter.send({ chatType: "private", chatId: "openid-1", text: "a" });
    expect(first.ok).toBe(false);
    expect(transport.tokenRequestCount()).toBe(1);

    const second = await adapter.send({ chatType: "private", chatId: "openid-1", text: "b" });
    expect(second.ok).toBe(true);
    expect(transport.tokenRequestCount()).toBe(2);

    await adapter.close();
  });

  it("token 端点 200 + 业务错误码：异常带 code/message，且不含 secret", async () => {
    const transport = new FakeTransport();
    transport.tokenResponse = { code: 10001, message: "invalid appid" };
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });

    let message = "";
    try {
      await adapter.connect();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("10001");
    expect(message).toContain("invalid appid");
    expect(message).not.toContain("secret-1");
    expect(transport.connects).toHaveLength(0);
  });

  it("send 失败写入 lastError（health.detail），成功发送后清除", async () => {
    const transport = new FakeTransport();
    const adapter = new QqBotAdapter({ appId: "app-1", appSecret: "secret-1", transport });
    transport.sendError = Object.assign(new Error("boom tok-1 secret-1"), { status: 429 });

    const failed = await adapter.send({ chatType: "private", chatId: "openid-1", text: "a" });
    expect(failed.ok).toBe(false);

    const healthAfterFailure = await adapter.health();
    expect(healthAfterFailure.detail).toContain("发送失败");
    expect(healthAfterFailure.detail).not.toContain("tok-1");
    expect(healthAfterFailure.detail).not.toContain("secret-1");

    transport.sendError = undefined;
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "b" });
    expect((await adapter.health()).detail).not.toContain("发送失败");

    await adapter.close();
  });
});
