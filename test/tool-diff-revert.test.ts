/**
 * Disk-level evidence for the tool-level single-file revert paths.
 *
 * The three host-side operations (`revertToolDiff`, `revertTurnFile`,
 * `applyHunkSelection`) all write through `vscode.workspace.fs.writeFile` so
 * the file watcher stays consistent. Until now that final write had no test
 * coverage — every other diff/revert capability had a real test. These cases
 * drive the real `ToolDiffService` (no reimplementation of the revert logic),
 * stub only the VSCode file-service edge, and assert both the writeFile call
 * and the resulting bytes on disk. A protection case proves the write is not
 * unconditional.
 */
import path from "node:path";
import os from "node:os";
import nodeFs from "node:fs";
import nodeFsPromises from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import {
  initialSessionState,
  type SessionState,
  type ToolBlock,
  type ToolDiffUi,
  type UserBlock,
} from "../shared/messages.js";
import { computeHunks, replayHunks } from "../shared/hunks.js";
import { turnChangeKey } from "../shared/turn-changes.js";
import { ToolDiffService, type ToolDiffServiceDeps } from "../src/panel/tool-diff-service.js";

interface UriLike {
  fsPath: string;
}
interface DocLike {
  uri: UriLike;
  isDirty: boolean;
}
interface WriteRecord {
  fsPath: string;
  text: string;
}

/** The shared vscode stub has no `workspace.fs` / `textDocuments` / `showTextDocument`. */
type WorkspaceMut = {
  fs?: {
    readFile: (uri: UriLike) => Promise<Uint8Array>;
    writeFile: (uri: UriLike, content: Uint8Array) => Promise<void>;
  };
  openTextDocument?: (uri: UriLike) => Promise<DocLike>;
  textDocuments?: DocLike[];
};
type WindowMut = {
  showTextDocument?: (doc: DocLike, options?: unknown) => Promise<unknown>;
};

const workspaceMut = vscode.workspace as unknown as WorkspaceMut;
const windowMut = vscode.window as unknown as WindowMut;

const SESSION_ID = "revert-session";
const USER_ID = "u1";

function makeState(blocks: SessionState["blocks"]): SessionState {
  return { ...initialSessionState(), sessionId: SESSION_ID, status: "idle", blocks };
}

function userBlock(): UserBlock {
  return { kind: "user", id: USER_ID, text: "edit note.txt" };
}

function toolBlock(id: string, diff: ToolDiffUi, filePath: string): ToolBlock {
  return {
    kind: "tool",
    id,
    toolCallId: id,
    toolName: "write_file",
    title: "edit note.txt",
    toolKind: "edit",
    status: "completed",
    output: "",
    locations: [{ path: filePath }],
    diff,
  };
}

describe("tool diff revert · disk writes", () => {
  let tmp: string;
  let file: string;
  let writes: WriteRecord[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), "iflow-tool-diff-revert-"));
    file = path.join(tmp, "note.txt");
    writes = [];
    // Fake the VSCode file service on top of the real temp disk: reads see the
    // real bytes (so locateDiffFile's newText probe resolves without a picker)
    // and writes actually land on disk, giving genuine disk-level evidence.
    workspaceMut.fs = {
      readFile: vi.fn(async (uri: UriLike) => nodeFsPromises.readFile(uri.fsPath)),
      writeFile: vi.fn(async (uri: UriLike, content: Uint8Array) => {
        writes.push({ fsPath: uri.fsPath, text: Buffer.from(content).toString("utf8") });
        await nodeFsPromises.writeFile(uri.fsPath, content);
      }),
    };
    workspaceMut.openTextDocument = vi.fn(async (uri: UriLike): Promise<DocLike> => ({ uri, isDirty: false }));
    workspaceMut.textDocuments = [];
    windowMut.showTextDocument = vi.fn(async () => ({ isDirty: false }));
    warnSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete workspaceMut.fs;
    delete workspaceMut.openTextDocument;
    delete workspaceMut.textDocuments;
    delete windowMut.showTextDocument;
    nodeFs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeService(getState: () => SessionState): { service: ToolDiffService; deps: ToolDiffServiceDeps } {
    const deps: ToolDiffServiceDeps = {
      log: { warn: vi.fn() },
      getSessionCwd: () => tmp,
      getWorkspaceRoots: () => [tmp],
      getExtensionPath: () => tmp,
      resolvePath: (p: string) => (path.isAbsolute(p) ? p : path.join(tmp, p)),
      getState: getState,
      post: vi.fn(),
      toolDiffSynthesized: vi.fn(),
      toolReverted: vi.fn(),
      toolHunkDecisions: vi.fn(),
      toolArgs: new Map(),
      preSnapshots: new Map(),
      toolArgsCap: 100,
    };
    return { service: new ToolDiffService(deps), deps };
  }

  const oldText = "alpha\nbeta\nOLD\ndelta\n";
  const newText = "alpha\nbeta\nNEW\ndelta\n";

  it("revertToolDiff writes the diff's oldText back to the original path", async () => {
    nodeFs.writeFileSync(file, newText, "utf8");
    const block = toolBlock("t1", { path: file, oldText, newText }, file);
    const state = makeState([userBlock(), block]);
    const { service, deps } = makeService(() => state);

    await service.revertTool("t1");

    expect(writes).toHaveLength(1);
    expect(writes[0]!.fsPath).toBe(file);
    expect(writes[0]!.text).toBe(oldText);
    expect(nodeFs.readFileSync(file, "utf8")).toBe(oldText);
    expect(deps.toolReverted).toHaveBeenCalledWith("t1");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("revertTurnFile writes the turn's first oldText back to disk", async () => {
    nodeFs.writeFileSync(file, newText, "utf8");
    const block = toolBlock("t2", { path: file, oldText, newText }, file);
    const state = makeState([userBlock(), block]);
    const key = turnChangeKey(block);
    const { service, deps } = makeService(() => state);

    await service.revertTurn(SESSION_ID, USER_ID, key);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.fsPath).toBe(file);
    expect(writes[0]!.text).toBe(oldText);
    expect(nodeFs.readFileSync(file, "utf8")).toBe(oldText);
    expect(deps.post).toHaveBeenCalledWith({
      type: "turnFileReverted",
      sessionId: SESSION_ID,
      userBlockId: USER_ID,
      key,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("applyHunkSelection writes the real hunk replay result", async () => {
    const oldLines = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", ""];
    const newLines = ["A", "B", "X", "D", "E", "F", "G", "Y", "I", "J", ""];
    const hunkOld = oldLines.join("\n");
    const hunkNew = newLines.join("\n");
    nodeFs.writeFileSync(file, hunkNew, "utf8");

    const hunks = computeHunks(hunkOld, hunkNew);
    expect(hunks).not.toBeNull();
    expect(hunks!).toHaveLength(2);
    const keep = [true, false];
    const expected = replayHunks(hunkOld, hunkNew, hunks!, keep);
    // Keep the first hunk (C→X), revert the second (Y→H).
    expect(expected).toBe(["A", "B", "X", "D", "E", "F", "G", "H", "I", "J", ""].join("\n"));

    const block = toolBlock("t3", { path: file, oldText: hunkOld, newText: hunkNew }, file);
    const state = makeState([userBlock(), block]);
    const { service, deps } = makeService(() => state);

    await service.applyHunks("t3", keep);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.fsPath).toBe(file);
    expect(writes[0]!.text).toBe(expected);
    expect(nodeFs.readFileSync(file, "utf8")).toBe(expected);
    expect(deps.toolHunkDecisions).toHaveBeenCalledWith("t3", keep, true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("refuses whole-file revert when the diff has no oldText (new file)", async () => {
    const created = "brand new content\n";
    nodeFs.writeFileSync(file, created, "utf8");
    const block = toolBlock("t4", { path: file, oldText: null, newText: created }, file);
    const state = makeState([userBlock(), block]);
    const { service, deps } = makeService(() => state);

    await service.revertTool("t4");

    expect(writes).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(deps.toolReverted).not.toHaveBeenCalled();
    expect(nodeFs.readFileSync(file, "utf8")).toBe(created);
  });

  it("refuses hunk replay when the file has unsaved editor changes", async () => {
    const oldLines = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", ""];
    const newLines = ["A", "B", "X", "D", "E", "F", "G", "Y", "I", "J", ""];
    const hunkOld = oldLines.join("\n");
    const hunkNew = newLines.join("\n");
    nodeFs.writeFileSync(file, hunkNew, "utf8");
    workspaceMut.textDocuments = [{ uri: { fsPath: file }, isDirty: true }];

    const hunks = computeHunks(hunkOld, hunkNew)!;
    const block = toolBlock("t5", { path: file, oldText: hunkOld, newText: hunkNew }, file);
    const state = makeState([userBlock(), block]);
    const { service, deps } = makeService(() => state);

    await service.applyHunks("t5", [true, false]);

    // The modal confirmation was declined (stub returns undefined): no write.
    expect(writes).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(deps.toolHunkDecisions).not.toHaveBeenCalled();
    expect(hunks).toHaveLength(2);
    expect(nodeFs.readFileSync(file, "utf8")).toBe(hunkNew);
  });
});
