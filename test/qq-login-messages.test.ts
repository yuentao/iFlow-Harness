import { describe, expect, it } from "vitest";
import {
  isQrDataUrl,
  QR_DATA_URL_PREFIX,
  type HostToWebview,
  type WebviewToHost,
} from "../shared/messages.js";

// 一张最小但结构完整的 1x1 PNG 的 base64（Buffer 生成，保证合法且为 4 的倍数）。
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9k7Z8AAAAASUVORK5CYII=";

// ---------------------------------------------------------------------------
// isQrDataUrl — PNG base64 data URL 安全护栏
// ---------------------------------------------------------------------------

describe("isQrDataUrl 正例", () => {
  it("接受严格的 data:image/png;base64,<合法 base64>", () => {
    expect(isQrDataUrl(QR_DATA_URL_PREFIX + PNG_B64)).toBe(true);
  });

  it("接受任意合法 base64 正文（含 0/1/2 个填充）", () => {
    expect(isQrDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isQrDataUrl("data:image/png;base64,AAA=")).toBe(true);
    expect(isQrDataUrl("data:image/png;base64,AA==")).toBe(true);
  });
});

describe("isQrDataUrl 反例", () => {
  it("拒绝空正文", () => {
    expect(isQrDataUrl("data:image/png;base64,")).toBe(false);
  });

  it("拒绝非 PNG 前缀（jpeg / webp / 缺 base64 段）", () => {
    expect(isQrDataUrl("data:image/jpeg;base64," + PNG_B64)).toBe(false);
    expect(isQrDataUrl("data:image/webp;base64," + PNG_B64)).toBe(false);
    expect(isQrDataUrl("data:image/png," + PNG_B64)).toBe(false);
  });

  it("拒绝 svg data URL（base64 与明文两种）", () => {
    expect(isQrDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
    expect(isQrDataUrl("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")).toBe(false);
  });

  it("拒绝 javascript: 与其它协议伪装", () => {
    expect(isQrDataUrl("javascript:alert(1)")).toBe(false);
    expect(isQrDataUrl("javascript:data:image/png;base64," + PNG_B64)).toBe(false);
    expect(isQrDataUrl("https://example.com/qr.png")).toBe(false);
  });

  it("拒绝非法 base64 正文", () => {
    expect(isQrDataUrl("data:image/png;base64,AAA!")).toBe(false); // 非法字符 "!"
    expect(isQrDataUrl("data:image/png;base64,AAA")).toBe(false); // 长度非 4 的倍数
    expect(isQrDataUrl("data:image/png;base64,AAAAA")).toBe(false); // 长度非 4 的倍数
    expect(isQrDataUrl("data:image/png;base64,A===")).toBe(false); // 3 个填充
    expect(isQrDataUrl("data:image/png;base64,=AAA")).toBe(false); // 填充在开头
    expect(isQrDataUrl("data:image/png;base64,AA=A")).toBe(false); // 填充在中间
    expect(isQrDataUrl("data:image/png;base64,====")).toBe(false); // 纯填充无正文
  });

  it("拒绝非字符串输入", () => {
    expect(isQrDataUrl(null as unknown as string)).toBe(false);
    expect(isQrDataUrl(undefined as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 消息联合方向（编译期断言）：四类新消息各归其位
// ---------------------------------------------------------------------------

/** 精确类型相等（对属性顺序不敏感，但要求结构完全一致）。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
/** 从消息联合中取出 type === K 的分支（无则 never）。 */
type Member<T, K extends string> = T extends { type: K } ? T : never;

// Host → Webview 两分支
export type AssertQrLoginQrOnHost = Expect<
  Equal<
    Member<HostToWebview, "qqLoginQr">,
    {
      type: "qqLoginQr";
      dataUrl: string;
      expiresAt: number;
      phase: "waiting_scan" | "scanned" | "confirmed" | "expired";
      detail?: string;
    }
  >
>;
export type AssertManagedStatusOnHost = Expect<
  Equal<
    Member<HostToWebview, "qqManagedStatus">,
    {
      type: "qqManagedStatus";
      phase:
        | "idle"
        | "checking"
        | "downloading"
        | "configuring"
        | "starting"
        | "waiting_login"
        | "logged_in"
        | "error";
      message: string;
      progress?: number;
    }
  >
>;

// Webview → Host 两分支（qqConfigAction 的新 action 也算一类）
export type AssertManagedSetupOnWebview = Expect<
  Equal<Member<WebviewToHost, "qqManagedSetup">, { type: "qqManagedSetup"; action: "start" | "stop" }>
>;
export type AssertQrActionsOnWebview = Expect<
  Equal<
    Member<WebviewToHost, "qqConfigAction">["action"],
    "testConnection" | "generateBindCode" | "unbind" | "startQrLogin" | "refreshQr" | "cancelQrLogin"
  >
>;

// 方向互斥：这些 type 绝不能出现在另一方向
export type AssertQrNotOnWebview = Expect<Equal<Member<WebviewToHost, "qqLoginQr">, never>>;
export type AssertStatusNotOnWebview = Expect<Equal<Member<WebviewToHost, "qqManagedStatus">, never>>;
export type AssertSetupNotOnHost = Expect<Equal<Member<HostToWebview, "qqManagedSetup">, never>>;

describe("扫码登录与一键托管消息方向", () => {
  it("四类新消息可在各自方向的联合上构造", () => {
    const hostQr: HostToWebview = {
      type: "qqLoginQr",
      dataUrl: QR_DATA_URL_PREFIX + PNG_B64,
      expiresAt: Date.now(),
      phase: "waiting_scan",
    };
    const hostStatus: HostToWebview = {
      type: "qqManagedStatus",
      phase: "downloading",
      message: "正在准备接入环境",
      progress: 42,
    };
    const webSetup: WebviewToHost = { type: "qqManagedSetup", action: "start" };
    const webConfig: WebviewToHost = { type: "qqConfigAction", action: "startQrLogin" };

    expect(hostQr.type).toBe("qqLoginQr");
    expect(hostStatus.type).toBe("qqManagedStatus");
    expect(webSetup.type).toBe("qqManagedSetup");
    expect(webConfig.action).toBe("startQrLogin");
  });
});
