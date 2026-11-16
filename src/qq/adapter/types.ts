/**
 * Platform-neutral ports for the QQ channel.
 *
 * Everything in `src/qq/adapter/` is transport-only: it converts wire payloads
 * into these shapes and back, and never imports `vscode` (so it stays unit
 * testable). The bridge/service layers above own scheduling, chunking and
 * retries; this file only fixes the contract they program against.
 */

/** OneBot v11 `message_type` — the only two chat kinds the adapter handles. */
export type ChatType = "private" | "group";

/**
 * An attachment carried by an inbound message.
 *
 * OneBot v11 gives either a URL or an opaque platform file id depending on the
 * implementation; both fields are optional because neither is guaranteed.
 */
export interface InboundAttachment {
  kind: "image" | "file";
  /** Direct download URL when the implementation exposes one. */
  url?: string;
  /** Platform file identifier (`file` in the CQ params / segment data). */
  fileId?: string;
  /** Original file name when known. */
  name?: string;
  /** Size in bytes when the implementation reports it. */
  sizeBytes?: number;
}

/** A normalized inbound chat message. */
export interface InboundMessage {
  chatType: ChatType;
  /** Private: sender QQ. Group: group number. Always a decimal string. */
  chatId: string;
  /** Author of the message (QQ number). */
  senderId: string;
  /** Platform message id, used for replies and de-duplication. */
  msgId: string;
  /** Plain text with CQ codes resolved (at/image/file/reply stripped out). */
  text: string;
  /** True when the bot itself was @-mentioned. */
  mentionsBot: boolean;
  attachments: InboundAttachment[];
  /** Milliseconds since epoch (OneBot reports seconds — converted on ingest). */
  timestamp: number;
}

/** A message the host wants to deliver to a chat. */
export interface OutboundMessage {
  chatType: ChatType;
  chatId: string;
  text: string;
  /** Quote-reply target; the adapter prefixes a `[CQ:reply,id=…]` code. */
  replyToMsgId?: string;
  /**
   * Local file to upload instead of (or in addition to) text. Upload support is
   * a later milestone — the port is declared now so callers can be written
   * against it, and implementations must fail with `retryable: false`.
   */
  filePath?: string;
}

/**
 * Outcome of one send attempt. `retryable` lets the caller decide whether to
 * re-queue: 4xx and protocol rejections are final, 5xx and network failures
 * are worth another try.
 */
export type SendResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string; retryable: boolean };

/** Snapshot of the channel's liveness, for the status surface. */
export interface ChannelHealth {
  connected: boolean;
  /** Human-readable detail (last error, connection mode, …). */
  detail?: string;
  /** Milliseconds since epoch of the last inbound event. */
  lastEventAt?: number;
}

/**
 * What the bridge/service programs against. Implementations are free to talk
 * to a WebSocket reverse connection, an HTTP API or a fake in tests.
 */
export interface ChannelAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(msg: OutboundMessage): Promise<SendResult>;
  health(): Promise<ChannelHealth>;
}
