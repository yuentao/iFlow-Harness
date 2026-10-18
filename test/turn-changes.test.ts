import { expect, it } from "vitest";
import { canReviewTurn, collectTurnChanges, collectTurnToolBlocks, isLatestTurn, turnsWithChanges } from "../shared/turn-changes.js";
import { initialSessionState, type Block, type ToolBlock } from "../shared/messages.js";

const tool = (id: string, path = `${id}.ts`, oldText: string | null = "a", newText: string | null = id): ToolBlock => ({
  kind: "tool", toolCallId: id, toolName: "replace", title: id,
  toolKind: "edit", status: "completed", output: "", locations: [], diff: { path, oldText, newText },
});

it("collects nested records in order, preserves repeated files and stops at the next top-level user", () => {
  const blocks: Block[] = [tool("before"), { kind: "user", id: "u", text: "go" }, tool("one"),
    { kind: "subagent", entries: [{ kind: "user", text: "nested" }, { ...tool("two"), status: "failed", partiallyReverted: true } ] } as Block,
    { ...tool("three"), reverted: true }, { kind: "user", id: "next", text: "next" }, tool("after")];
  const records = collectTurnChanges(blocks, "u");
  expect(records.map((r) => r.toolCallId)).toEqual(["one", "two", "three"]);
  expect(records[1]).toMatchObject({ status: "failed", partiallyReverted: true });
  expect(records[2]?.reverted).toBe(true);
  expect(records[0]?.path).toBe("one.ts");
  expect(records[0]?.canUndo).toBe(true);
  expect(collectTurnChanges(blocks, "missing")).toEqual([]);
});

it("collects raw turn tool blocks for single-file undo", () => {
  const blocks: Block[] = [
    tool("before"),
    { kind: "user", id: "u", text: "go" },
    tool("a", "same.ts"),
    { kind: "subagent", entries: [tool("b", "same.ts")] } as Block,
    { kind: "user", id: "next", text: "next" },
  ];
  expect(collectTurnToolBlocks(blocks, "u").map((block) => block.toolCallId)).toEqual(["a", "b"]);
});

it("aggregates chained diffs into one file with net line counts", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    tool("a", "src/same.ts", "a", "b"),
    tool("b", "src/same.ts", "b", "c"),
  ];
  const records = collectTurnChanges(blocks, "u");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ path: "src/same.ts", toolCallId: "b", edits: 2, additions: 1, deletions: 1, canUndo: true });
});

it("disables undo for chained edits whose identity is only a basename", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    tool("a", "same.ts", "a", "b"),
    tool("b", "same.ts", "b", "c"),
  ];
  expect(collectTurnChanges(blocks, "u")[0]?.canUndo).toBe(false);
});

it("splits same-basename files by location and keeps undo safe", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    { ...tool("a", "index.ts", "a", "b"), locations: [{ path: "src/a/index.ts", line: 1 }] },
    { ...tool("b", "index.ts", "a", "b"), locations: [{ path: "src/b/index.ts", line: 1 }] },
  ];
  const records = collectTurnChanges(blocks, "u");
  expect(records.map((record) => record.key)).toEqual(["src/a/index.ts", "src/b/index.ts"]);
  expect(records.every((record) => record.canUndo)).toBe(true);
});

it("aggregates revert markers across every edit in a file", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    { ...tool("a", "src/a.ts", "a", "b"), reverted: true },
    { ...tool("b", "src/a.ts", "b", "c"), reverted: false, partiallyReverted: true },
  ];
  const record = collectTurnChanges(blocks, "u")[0]!;
  expect(record.reverted).toBe(false);
  expect(record.partiallyReverted).toBe(true);
  const allReverted = collectTurnChanges([
    { kind: "user", id: "u", text: "go" },
    { ...tool("a", "src/a.ts", "a", "b"), reverted: true },
    { ...tool("b", "src/a.ts", "b", "c"), reverted: true },
  ] as Block[], "u")[0]!;
  expect(allReverted.reverted).toBe(true);
  expect(allReverted.partiallyReverted).toBe(false);
});

it("marks only the turn with no later user message as latest", () => {
  const blocks: Block[] = [{ kind: "user", id: "u", text: "go" }, { kind: "user", id: "next", text: "next" }];
  expect(isLatestTurn(blocks, "u")).toBe(false);
  expect(isLatestTurn(blocks, "next")).toBe(true);
  expect(isLatestTurn(blocks, "missing")).toBe(false);
});

it("sums per-record counts when the diffs do not chain", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    tool("a", "same.ts", "a", "b"),
    tool("b", "same.ts", "x", "y"),
  ];
  expect(collectTurnChanges(blocks, "u")[0]).toMatchObject({ edits: 2, additions: 2, deletions: 2, canUndo: false });
});

it("counts file creation and deletion without diff text", () => {
  const blocks: Block[] = [
    { kind: "user", id: "u", text: "go" },
    tool("new", "new.ts", null, "a\nb"),
    tool("gone", "gone.ts", "a\nb", null),
  ];
  const records = collectTurnChanges(blocks, "u");
  expect(records[0]).toMatchObject({ path: "new.ts", additions: 2, deletions: 0, canUndo: false });
  expect(records[1]).toMatchObject({ path: "gone.ts", additions: 0, deletions: 2, canUndo: true });
});

it("indexes turns with recorded diffs without letting nested users split the turn", () => {
  const blocks: Block[] = [
    { kind: "user", id: "empty", text: "no edits" },
    { kind: "assistant", text: "done" },
    { kind: "user", id: "changed", text: "edit" },
    { kind: "subagent", entries: [{ kind: "tool", ...tool("nested") }, { kind: "user", text: "inner" }] } as Block,
    { kind: "user", id: "evicted", text: "release" },
    { ...tool("gone"), diff: null, hadDiff: true, evicted: true },
    { kind: "user", id: "later", text: "another" },
  ];
  expect([...turnsWithChanges(blocks)]).toEqual(["changed", "evicted"]);
});

it("allows error/cancelled idle turns and history but gates active, replay and pending approval", () => {
  const state = { ...initialSessionState(), sessionId: "s", blocks: [{ kind: "user", id: "u", text: "go" }] as Block[] };
  for (const status of ["idle", "error"] as const) expect(canReviewTurn({ ...state, status }, "u")).toBe(true);
  expect(canReviewTurn({ ...state, status: "streaming" }, "u")).toBe(false);
  expect(canReviewTurn({ ...state, initializing: true }, "u")).toBe(false);
  expect(canReviewTurn({ ...state, replaying: true }, "u")).toBe(false);
  expect(canReviewTurn({ ...state, pendingApproval: {} as NonNullable<typeof state.pendingApproval> }, "u")).toBe(false);
  state.blocks.push({ kind: "user", id: "next", text: "next" });
  expect(canReviewTurn({ ...state, status: "streaming" }, "u")).toBe(true);
});