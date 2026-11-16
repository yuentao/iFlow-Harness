import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildReplyPayload,
  buildSendGroupMsg,
  buildSendPrivateMsg,
  normalizeOneBotEvent,
  parseCqCodes,
} from "../src/qq/adapter/onebot.js";
import { HttpOneBotTransport, OneBotHttpError } from "../src/qq/adapter/http-transport.js";

const SELF_ID = "10000";

describe("normalizeOneBotEvent — CQ string form", () => {
  it("normalizes a private message and strips CQ codes from the text", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        time: 1_700_000_000,
        self_id: 10000,
        user_id: 22222,
        message_id: 777,
        message: "[CQ:at,qq=33333] 你好 [CQ:image,file=abc.jpg,url=https://example.test/abc.jpg]",
        sender: { user_id: 22222, nickname: "alice" },
      },
      { selfId: SELF_ID },
    );

    expect(message).not.toBeNull();
    expect(message!.chatType).toBe("private");
    expect(message!.chatId).toBe("22222");
    expect(message!.senderId).toBe("22222");
    expect(message!.msgId).toBe("777");
    expect(message!.text).toBe("你好");
    // The @ targets someone else — see the dedicated mention cases below.
    expect(message!.mentionsBot).toBe(false);
    expect(message!.attachments).toEqual([
      { kind: "image", url: "https://example.test/abc.jpg", fileId: "abc.jpg" },
    ]);
    // OneBot reports seconds; the normalized shape is milliseconds.
    expect(message!.timestamp).toBe(1_700_000_000_000);
  });

  it("detects a bot mention written as a CQ code in a group message", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        group_id: 55555,
        user_id: 22222,
        message_id: 888,
        message: "[CQ:at,qq=10000] 帮我看下",
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.chatType).toBe("group");
    expect(message!.chatId).toBe("55555");
    expect(message!.mentionsBot).toBe(true);
    expect(message!.text).toBe("帮我看下");
  });

  it("does not treat @-mentioning another user as a bot mention", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        group_id: 55555,
        user_id: 22222,
        message_id: 889,
        message: "[CQ:at,qq=33333] hi",
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.mentionsBot).toBe(false);
  });

  it("extracts file attachments with size", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        message_id: 1,
        message: "[CQ:file,file=f1,url=https://example.test/f.zip,file_size=1234]",
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.attachments).toEqual([
      {
        kind: "file",
        url: "https://example.test/f.zip",
        fileId: "f1",
        name: undefined,
        sizeBytes: 1234,
      },
    ]);
  });
});

describe("normalizeOneBotEvent — segment array form", () => {
  it("normalizes an at/reply/text segment array and detects the bot mention", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        group_id: 55555,
        user_id: 22222,
        message_id: 900,
        time: 1_700_000_100,
        message: [
          { type: "at", data: { qq: 10000 } },
          { type: "text", data: { text: " 帮我看下" } },
          { type: "reply", data: { id: "777" } },
        ],
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.mentionsBot).toBe(true);
    expect(message!.text).toBe("帮我看下");
    expect(message!.attachments).toEqual([]);
    expect(message!.msgId).toBe("900");
  });

  it("does not treat an @all segment as a bot mention", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        group_id: 55555,
        user_id: 22222,
        message: [
          { type: "at", data: { qq: "all" } },
          { type: "text", data: { text: "公告" } },
        ],
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.mentionsBot).toBe(false);
  });

  it("keeps a private message without mentions as mentionsBot=false", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        message: [{ type: "text", data: { text: "hello" } }],
        sender: { user_id: 22222 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.mentionsBot).toBe(false);
    expect(message!.text).toBe("hello");
  });

  it("normalizes message_sent events using the target as the chat", () => {
    const privateSent = normalizeOneBotEvent(
      {
        post_type: "message_sent",
        message_type: "private",
        user_id: 10000,
        target_id: 22222,
        message_id: 901,
        message: "sent to friend",
        sender: { user_id: 10000 },
      },
      { selfId: SELF_ID },
    );
    expect(privateSent!.chatType).toBe("private");
    expect(privateSent!.chatId).toBe("22222");
    expect(privateSent!.senderId).toBe("10000");

    const groupSent = normalizeOneBotEvent(
      {
        post_type: "message_sent",
        message_type: "group",
        group_id: 55555,
        user_id: 10000,
        message_id: 902,
        message: "sent to group",
      },
      { selfId: SELF_ID },
    );
    expect(groupSent!.chatType).toBe("group");
    expect(groupSent!.chatId).toBe("55555");
  });
});

describe("normalizeOneBotEvent — non-message and malformed input", () => {
  it("returns null for notice, meta_event and request events", () => {
    expect(normalizeOneBotEvent({ post_type: "notice", notice_type: "group_increase" }, { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent({ post_type: "meta_event", meta_event_type: "heartbeat" }, { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent({ post_type: "request", request_type: "friend" }, { selfId: SELF_ID })).toBeNull();
  });

  it("returns null for non-objects and for message events with no chat id", () => {
    expect(normalizeOneBotEvent(null, { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent("payload", { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent([], { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent({}, { selfId: SELF_ID })).toBeNull();
    expect(normalizeOneBotEvent({ post_type: "message", message_type: "group" }, { selfId: SELF_ID })).toBeNull();
  });

  it("does not throw on missing optional fields", () => {
    const before = Date.now();
    const message = normalizeOneBotEvent(
      { post_type: "message", message_type: "private", user_id: 1, message: "hi" },
      { selfId: SELF_ID },
    );

    expect(message).not.toBeNull();
    expect(message!.msgId).toBe("");
    expect(message!.senderId).toBe("1");
    expect(message!.text).toBe("hi");
    expect(message!.timestamp).toBeGreaterThanOrEqual(before);
    expect(message!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("tolerates unknown segment types without losing the rest", () => {
    const message = normalizeOneBotEvent(
      {
        post_type: "message",
        message_type: "private",
        user_id: 1,
        message: [
          { type: "face", data: { id: "13" } },
          { type: "text", data: { text: "ok" } },
          "garbage",
        ],
        sender: { user_id: 1 },
      },
      { selfId: SELF_ID },
    );

    expect(message!.text).toBe("ok");
  });
});

describe("parseCqCodes", () => {
  it("splits text and codes, decoding CQ escapes", () => {
    const segments = parseCqCodes("a&#44;b[CQ:text,text=x&#44;y][CQ:face,id=1]tail");

    expect(segments).toEqual([
      // OneBot v11 escapes exist inside CQ parameter values only; literal text
      // between codes is preserved verbatim.
      { type: "text", text: "a&#44;b" },
      { type: "text", text: "x,y" },
      { type: "other", code: "face", params: { id: "1" } },
      { type: "text", text: "tail" },
    ]);
  });

  it("decodes escaped brackets and ampersands", () => {
    const segments = parseCqCodes("[CQ:text,text=&#91;a&#93;&amp;b]");

    expect(segments).toEqual([{ type: "text", text: "[a]&b" }]);
  });

  it("returns a single text segment when there is no CQ code", () => {
    expect(parseCqCodes("plain text")).toEqual([{ type: "text", text: "plain text" }]);
  });
});

describe("action builders", () => {
  it("builds send_private_msg", () => {
    expect(buildSendPrivateMsg("22222", "hello")).toEqual({
      action: "send_private_msg",
      params: { user_id: "22222", message: "hello" },
    });
  });

  it("builds send_group_msg with and without auto_escape", () => {
    expect(buildSendGroupMsg("55555", "hello")).toEqual({
      action: "send_group_msg",
      params: { group_id: "55555", message: "hello" },
    });
    expect(buildSendGroupMsg("55555", "hello", { autoEscape: true })).toEqual({
      action: "send_group_msg",
      params: { group_id: "55555", message: "hello", auto_escape: true },
    });
  });

  it("builds a reply payload per chat type", () => {
    expect(buildReplyPayload("55555", "收到", "777", "group")).toEqual({
      action: "send_group_msg",
      params: { group_id: "55555", message: "[CQ:reply,id=777]收到" },
    });
    expect(buildReplyPayload("22222", "收到", "777", "private")).toEqual({
      action: "send_private_msg",
      params: { user_id: "22222", message: "[CQ:reply,id=777]收到" },
    });
  });

  it("escapes a hostile reply id so it cannot inject CQ codes", () => {
    const built = buildReplyPayload("1", "x", "7,7][CQ:at,qq=all", "private");
    expect(built.params["message"]).toBe("[CQ:reply,id=7&#44;7&#93;&#91;CQ:at&#44;qq=all]x");
  });
});

describe("HttpOneBotTransport", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastAuth: string | undefined;
  let lastBody: unknown;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      lastAuth = typeof auth === "string" ? auth : undefined;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        lastBody = JSON.parse(raw) as unknown;
        if (req.url === "/fail500") {
          res.statusCode = 500;
          res.end('{"status":"failed","retcode":-1}');
          return;
        }
        if (req.url === "/fail404") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        if (req.url === "/hang") {
          // Never respond — the client-side timeout must fire.
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end('{"status":"ok","retcode":0,"data":{"message_id":42}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("posts JSON to the endpoint and sends the bearer token", async () => {
    const transport = new HttpOneBotTransport({ baseUrl: `${baseUrl}/`, accessToken: "s3cret" });
    const result = await transport.post("send_private_msg", { user_id: "22222", message: "hi" });

    expect(result).toEqual({ status: "ok", retcode: 0, data: { message_id: 42 } });
    expect(lastAuth).toBe("Bearer s3cret");
    expect(lastBody).toEqual({ action: "send_private_msg", params: { user_id: "22222", message: "hi" } });
  });

  it("omits the Authorization header when no token is configured", async () => {
    const transport = new HttpOneBotTransport({ baseUrl: `${baseUrl}/` });
    await transport.post("get_status");

    expect(lastAuth).toBeUndefined();
    expect(lastBody).toEqual({ action: "get_status", params: {} });
  });

  it("maps 5xx to a retryable error", async () => {
    const transport = new HttpOneBotTransport({ baseUrl: `${baseUrl}/fail500` });
    await expect(transport.post("send_group_msg", { group_id: "1", message: "x" })).rejects.toMatchObject({
      name: "OneBotHttpError",
      status: 500,
      retryable: true,
    });
  });

  it("maps 4xx to a non-retryable error", async () => {
    const transport = new HttpOneBotTransport({ baseUrl: `${baseUrl}/fail404` });
    await expect(transport.post("send_group_msg", { group_id: "1", message: "x" })).rejects.toMatchObject({
      name: "OneBotHttpError",
      status: 404,
      retryable: false,
    });
  });

  it("maps a timeout to a retryable error", async () => {
    const transport = new HttpOneBotTransport({ baseUrl: `${baseUrl}/hang`, timeoutMs: 80 });
    const error = await transport.post("send_group_msg", { group_id: "1", message: "x" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OneBotHttpError);
    expect((error as OneBotHttpError).retryable).toBe(true);
    expect((error as Error).message).toContain("timed out");
  });

  it("rejects an unsupported baseUrl scheme", () => {
    expect(() => new HttpOneBotTransport({ baseUrl: "ws://127.0.0.1:3000/" })).toThrow(
      /Unsupported OneBot baseUrl protocol/,
    );
    expect(() => new HttpOneBotTransport({ baseUrl: "not a url" })).toThrow(/Invalid OneBot baseUrl/);
  });
});
