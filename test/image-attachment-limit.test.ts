import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { base64DecodedByteLength } from "../src/panel/attachments.js";
import { setConfigOverrides } from "./vscode-stub.js";

/**
 * 图片附件的两个上限都以「原图字节数」为准：
 *  - `MAX_IMAGE_ATTACHMENT_BYTES` = 8MB：openImage 拒绝打开超过它的图；
 *  - `ATTACHMENT_IMAGE_MAX_BYTES` = 5MB：挑选的图片超过它就降级为文件附件。
 *
 * 历史缺陷：`openImageAttachment` 拿 base64 字符串长度（比原图大约 4/3）
 * 直接和 8MB 比，于是 raw 6MB 以上就被拒，而 toast 仍写「超过 8 MB」。
 * 本测试用真实的 base64 编码构造边界数据，断言换算后的原图口径。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
/** MAX_IMAGE_ATTACHMENT_BYTES / ATTACHMENT_IMAGE_MAX_BYTES 的镜像，用于造数。 */
const OPEN_LIMIT = 8 * MB;
const DEGRADE_LIMIT = 5 * MB;

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue) as T,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscodeTypes.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: noop, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: noop, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

/** `n` raw bytes (3-multiple so the base64 carries no padding) → data URL. */
function imageDataUrl(rawBytes: number, mime = "image/png"): string {
  const raw = Buffer.alloc(rawBytes, 7);
  return `data:${mime};base64,${raw.toString("base64")}`;
}

describe("base64DecodedByteLength", () => {
  it("equals the real decoded length for every padding shape", () => {
    for (let n = 0; n <= 12; n += 1) {
      const raw = Buffer.alloc(n, 1);
      const b64 = raw.toString("base64");
      expect(base64DecodedByteLength(b64)).toBe(raw.byteLength);
    }
  });

  it("accepts unpadded base64 too", () => {
    expect(base64DecodedByteLength("QQ")).toBe(1);
    expect(base64DecodedByteLength("QUI")).toBe(2);
    expect(base64DecodedByteLength("QUJD")).toBe(3);
    expect(base64DecodedByteLength("")).toBe(0);
  });

  it("maps an 8MB raw image to an ~11MB base64 string", () => {
    const b64 = Buffer.alloc(OPEN_LIMIT, 3).toString("base64");
    // The regression: the encoded length is well over the byte cap…
    expect(b64.length).toBeGreaterThan(OPEN_LIMIT);
    // …but the decoded length is exactly the raw cap.
    expect(base64DecodedByteLength(b64)).toBe(OPEN_LIMIT);
  });
});

describe("openImageAttachment · 8MB cap measured in raw bytes", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let written: string[];

  const openImage = (dataUrl: string) =>
    (panel as unknown as { openImageAttachment: (d: string) => Promise<void> }).openImageAttachment(
      dataUrl,
    );

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-img-limit-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    warnSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    written = [];
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(((
      command: string,
      uri: { fsPath: string },
    ) => {
      if (command === "vscode.open") written.push(uri.fsPath);
      return Promise.resolve(undefined);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    for (const file of written) fs.rmSync(file, { force: true });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("opens a 6.2MB raw image (base64 ≈ 8.27MB) that the old base64-length check rejected", async () => {
    const raw = 6.2 * MB;
    const dataUrl = imageDataUrl(Math.floor(raw / 3) * 3);
    const encodedLen = dataUrl.length - "data:image/png;base64,".length;
    // Guard the premise: the encoded payload alone already exceeds 8MB.
    expect(encodedLen).toBeGreaterThan(OPEN_LIMIT);

    await openImage(dataUrl);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
  });

  it("opens a raw image just under 8MB", async () => {
    await openImage(imageDataUrl(OPEN_LIMIT - 2)); // 3-multiple, raw < 8MB
    expect(warnSpy).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
  });

  it("rejects a raw image just over 8MB with the 8 MB wording", async () => {
    await openImage(imageDataUrl(OPEN_LIMIT + 3));
    expect(written).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("8 MB");
  });
});

describe("pickAttachments · 5MB degrade threshold measured in raw bytes", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let posted: unknown[];

  type WorkspaceMut = {
    fs?: { readFile: (uri: { fsPath: string }) => Promise<Uint8Array> };
  };
  type WindowMut = { showOpenDialog?: (opts: unknown) => Promise<Array<{ fsPath: string }>> };
  const workspaceMut = vscode.workspace as unknown as WorkspaceMut;
  const windowMut = vscode.window as unknown as WindowMut;

  const pick = (rawBytes: number) =>
    (panel as unknown as { pickAttachments: () => Promise<void> }).pickAttachments();

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-img-pick-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    posted = [];
    (panel as unknown as { postToWebview: (m: unknown) => void }).postToWebview = (m: unknown) => {
      posted.push(m);
    };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    windowMut.showOpenDialog = async () => [{ fsPath: path.join(here, "picked.png") }];
    workspaceMut.fs = {
      readFile: async () => new Uint8Array(DEGRADE_LIMIT),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    delete workspaceMut.fs;
    delete windowMut.showOpenDialog;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const lastFilesPicked = () =>
    posted.filter((m) => (m as { type?: string }).type === "filesPicked").pop() as
      | { images: unknown[]; files: unknown[] }
      | undefined;

  it("keeps a 5MB raw image as an image attachment (boundary is inclusive)", async () => {
    await pick(DEGRADE_LIMIT);
    const reply = lastFilesPicked();
    expect(reply?.images).toHaveLength(1);
    expect(reply?.files).toHaveLength(0);
  });

  it("degrades a 5MB+1 raw image to a file attachment", async () => {
    workspaceMut.fs = { readFile: async () => new Uint8Array(DEGRADE_LIMIT + 1) };
    await pick(DEGRADE_LIMIT + 1);
    const reply = lastFilesPicked();
    expect(reply?.images).toHaveLength(0);
    expect(reply?.files).toHaveLength(1);
  });
});

describe("pickDefaultWorkspace · 设置页选择目录必须打开原生目录选择器", () => {
  let panel: ChatPanel;
  let storageDir: string;
  const windowMut = vscode.window as unknown as {
    showOpenDialog?: (opts: unknown) => Promise<Array<{ fsPath: string }> | undefined>;
  };

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-pick-ws-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    delete windowMut.showOpenDialog;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("routes the settings button message to the host folder picker", async () => {
    const showOpenDialog = vi.fn(async () => undefined);
    windowMut.showOpenDialog = showOpenDialog as unknown as typeof windowMut.showOpenDialog;
    await (panel as unknown as { handleWebviewMessage: (m: unknown) => Promise<void> })
      .handleWebviewMessage({ type: "pickDefaultWorkspace" });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ canSelectFolders: true, canSelectFiles: false }),
    );
  });
});
