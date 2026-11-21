// @vitest-environment jsdom
/**
 * 多模态方案 A：转录图片网格与面板内灯箱。
 *
 * 过去的缩略图是一条 64px 高的单行图片条，点击直接把 data URL 交给宿主，
 * 用 VSCode 的图片预览打开——面板丢了刚粘贴图片的阅读上下文。现在：
 * 1. 缩略图是固定格子的小网格（多图 3 列 / 单图适度放大），点击在面板内开灯箱；
 * 2. 灯箱支持 Esc 关闭、多图方向键切换、关闭后焦点归还触发元素；
 * 3. 只渲染 `data:image/` 开头的 src（模型输出不得变成远程 <img> 请求）；
 * 4. 缩略图/大图都有 onError 失败态，不再是一格空白边框；
 * 5. 图片已释放时保留占位并带可访问名。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "../webview/src/components/ui";
import { MessageList } from "../webview/src/components/MessageList";
import { initialSessionState, type Block, type SessionState } from "../shared/messages";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.current),
    { getState: () => store.current },
  ),
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

const PHOTO_A = "data:image/png;base64,AAAA";
const PHOTO_B = "data:image/png;base64,BBBB";
const PHOTO_C = "data:image/png;base64,CCCC";

let root: Root;
let container: HTMLDivElement;
let send: ReturnType<typeof vi.fn>;

function userBlock(patch: Partial<Extract<Block, { kind: "user" }>> = {}): Extract<Block, { kind: "user" }> {
  return { kind: "user", id: "u-1", text: "看这两张图", ...patch };
}

function stateWithUser(patch: Partial<Extract<Block, { kind: "user" }>> = {}): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.blocks = [userBlock(patch)];
  return state;
}

function renderMessageList(state: SessionState): void {
  store.current = {
    state,
    toasts: [],
    send,
    notify: vi.fn(),
    dismissToast: vi.fn(),
    setHeaderScrolled: vi.fn(),
    focusMode: false,
    promptSeq: 0,
    requestDraft: vi.fn(),
    requestMemoryDraft: vi.fn(),
  };
  act(() => root.render(<MessageList />));
}

function renderLightbox(images: string[], index = 0): void {
  act(() =>
    root.render(
      <ImageLightbox
        open
        images={images}
        index={index}
        onClose={() => {}}
        ariaLabel="图片预览"
      />,
    ),
  );
}

function thumbnails(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="查看第"]'));
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="图片预览"]');
}

function lightboxSrc(): string | null | undefined {
  return document.body.querySelector<HTMLImageElement>(".image-lightbox-img")?.getAttribute("src");
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send = vi.fn();
  class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  Element.prototype.scrollTo = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("转录图片网格", () => {
  it("缩略图按钮带序号可访问名，点击在面板内打开灯箱而不是交给宿主", () => {
    renderMessageList(stateWithUser({ images: [PHOTO_A, PHOTO_B] }));
    const thumbs = thumbnails();
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.getAttribute("aria-label")).toBe("查看第 1 张图片");
    expect(thumbs[1]!.getAttribute("aria-label")).toBe("查看第 2 张图片");

    act(() => thumbs[1]!.click());
    expect(dialog()).toBeTruthy();
    expect(lightboxSrc()).toBe(PHOTO_B);
    // 点击不再直接离开面板（旧实现 send({ type: "openImage" })）。
    expect(send).not.toHaveBeenCalled();
  });

  it("data: 之外的 src 不渲染缩略图", () => {
    renderMessageList(stateWithUser({ images: ["https://evil.example/x.png", PHOTO_A] }));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(PHOTO_A);
    expect(container.innerHTML).not.toContain("evil.example");
  });

  it("缩略图加载失败时格子里显示失败文案，不再是空白边框", () => {
    renderMessageList(stateWithUser({ images: [PHOTO_A] }));
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("加载失败");
  });

  it("图片已释放时保留占位并带可访问文本", () => {
    renderMessageList(stateWithUser({ evicted: true }));
    expect(container.textContent).toContain("附件图片已释放");
    expect(container.querySelector('[aria-label="附件图片已释放"]')).toBeTruthy();
  });
});

describe("ImageLightbox", () => {
  it("Esc 关闭并把焦点归还触发元素", () => {
    renderMessageList(stateWithUser({ images: [PHOTO_A] }));
    const thumb = thumbnails()[0]!;
    act(() => {
      thumb.focus();
      thumb.click();
    });
    expect(dialog()).toBeTruthy();

    press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it("多图时左右方向键切换并循环", () => {
    renderMessageList(stateWithUser({ images: [PHOTO_A, PHOTO_B, PHOTO_C] }));
    act(() => thumbnails()[0]!.click());
    expect(lightboxSrc()).toBe(PHOTO_A);

    press("ArrowRight");
    expect(lightboxSrc()).toBe(PHOTO_B);
    expect(document.body.textContent).toContain("第 2 / 3 张");

    press("ArrowRight");
    press("ArrowRight"); // 从末尾回卷到第一张
    expect(lightboxSrc()).toBe(PHOTO_A);
    expect(document.body.textContent).toContain("第 1 / 3 张");

    press("ArrowLeft"); // 从第一张回卷到最后一张
    expect(lightboxSrc()).toBe(PHOTO_C);
  });

  it("只渲染 data:image/ 来源，远程 URL 不进入 DOM", () => {
    renderLightbox(["https://evil.example/x.png", PHOTO_A]);
    expect(lightboxSrc()).toBe(PHOTO_A);
    expect(document.body.innerHTML).not.toContain("evil.example");
    // 只剩一张有效图 → 不显示切换按钮。
    expect(document.body.querySelector('button[aria-label="下一张"]')).toBeNull();
  });

  it("没有任何 data:image/ 来源时不渲染遮罩", () => {
    renderLightbox(["https://evil.example/x.png"]);
    expect(dialog()).toBeNull();
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("大图加载失败时显示失败态", () => {
    renderLightbox([PHOTO_A]);
    const img = document.body.querySelector<HTMLImageElement>(".image-lightbox-img");
    expect(img).toBeTruthy();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(document.body.querySelector(".image-lightbox-img")).toBeNull();
    expect(document.body.textContent).toContain("图片加载失败");
  });

  it("遮罩点击关闭，面板内部点击不关闭", () => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        <ImageLightbox open images={[PHOTO_A]} index={0} onClose={onClose} ariaLabel="图片预览" />,
      ),
    );
    const panel = document.body.querySelector<HTMLElement>(".image-lightbox-panel")!;
    act(() => {
      panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
