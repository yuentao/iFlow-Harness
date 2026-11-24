import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyMeta,
  factFingerprint,
  loadMeta,
  maintenanceMetaPath,
  pruneMeta,
  saveMeta,
  touchFact,
  type MemoryMaintenanceMeta,
} from "../src/memory/maintenance-meta.js";

const dirs: string[] = [];

function tempHome(prefix = "iflow-mem-meta-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("maintenance meta: loadMeta", () => {
  it("returns an empty structure when the sidecar is missing", async () => {
    const home = tempHome();
    const meta = await loadMeta(home);
    expect(meta).toEqual({ version: 1, facts: {} });
  });

  it("returns an empty structure when the sidecar is corrupted", async () => {
    const home = tempHome();
    const file = maintenanceMetaPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not json at all", "utf8");
    expect(await loadMeta(home)).toEqual({ version: 1, facts: {} });

    writeFileSync(file, JSON.stringify({ version: 2, facts: {} }), "utf8");
    expect(await loadMeta(home)).toEqual({ version: 1, facts: {} });

    writeFileSync(file, JSON.stringify({ version: 1, facts: [] }), "utf8");
    expect(await loadMeta(home)).toEqual({ version: 1, facts: {} });
  });

  it("drops malformed fact entries but keeps the valid ones", async () => {
    const home = tempHome();
    const file = maintenanceMetaPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        facts: {
          good: { firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z", useCount: 2 },
          broken: { firstSeenAt: "x" },
          notAnObject: 7,
        },
      }),
      "utf8",
    );
    const meta = await loadMeta(home);
    expect(Object.keys(meta.facts)).toEqual(["good"]);
    expect(meta.facts.good?.useCount).toBe(2);
  });
});

describe("maintenance meta: touchFact", () => {
  it("adds a new fact with useCount 1 and does not mutate the input", () => {
    const before = emptyMeta();
    const now = "2026-11-23T10:00:00.000Z";
    const after = touchFact(before, "Use pnpm for installs", now);
    expect(before.facts).toEqual({});
    const key = factFingerprint("Use pnpm for installs");
    expect(after.facts[key]).toEqual({ firstSeenAt: now, lastSeenAt: now, useCount: 1 });
  });

  it("increments useCount and refreshes lastSeenAt on a repeat observation", () => {
    const first = touchFact(emptyMeta(), "Use pnpm", "2026-11-23T10:00:00.000Z");
    const second = touchFact(first, "Use pnpm", "2026-11-23T11:00:00.000Z");
    const key = factFingerprint("Use pnpm");
    expect(second.facts[key]).toEqual({
      firstSeenAt: "2026-11-23T10:00:00.000Z",
      lastSeenAt: "2026-11-23T11:00:00.000Z",
      useCount: 2,
    });
    // The previous snapshot is untouched (pure function).
    expect(first.facts[key]?.useCount).toBe(1);
  });

  it("normalizes punctuation and whitespace to the same fingerprint", () => {
    expect(factFingerprint("Use  pnpm.")).toBe(factFingerprint("use pnpm"));
    const once = touchFact(emptyMeta(), "Use  pnpm.", "2026-11-23T10:00:00.000Z");
    const twice = touchFact(once, "use pnpm", "2026-11-23T10:00:01.000Z");
    expect(Object.keys(twice.facts)).toHaveLength(1);
    expect(twice.facts[factFingerprint("use pnpm")]?.useCount).toBe(2);
  });

  it("ignores blank text", () => {
    const before = emptyMeta();
    expect(touchFact(before, "   ")).toBe(before);
  });
});

describe("maintenance meta: pruneMeta", () => {
  it("removes facts that no longer exist and keeps the live ones", () => {
    const now = "2026-11-23T10:00:00.000Z";
    const meta = touchFact(touchFact(emptyMeta(), "keep me", now), "drop me", now);
    const pruned = pruneMeta(meta, ["keep me", "another live fact"]);
    const keys = Object.keys(pruned.facts);
    expect(keys).toEqual([factFingerprint("keep me")]);
    // Input not mutated.
    expect(Object.keys(meta.facts)).toHaveLength(2);
  });

  it("matches existing facts through the same normalization", () => {
    const meta = touchFact(emptyMeta(), "Use pnpm.", "2026-11-23T10:00:00.000Z");
    const pruned = pruneMeta(meta, ["use  pnpm"]);
    expect(Object.keys(pruned.facts)).toEqual([factFingerprint("use pnpm")]);
  });
});

describe("maintenance meta: save/load round-trip", () => {
  it("writes the sidecar under memory-maintenance/meta.json and reads it back", async () => {
    const home = tempHome();
    const meta: MemoryMaintenanceMeta = touchFact(
      emptyMeta(),
      "round trip fact",
      "2026-11-23T10:00:00.000Z",
    );
    await saveMeta(home, meta);
    expect(maintenanceMetaPath(home)).toBe(
      path.join(home, "memory-maintenance", "meta.json"),
    );
    const loaded = await loadMeta(home);
    expect(loaded).toEqual(meta);
  });
});
