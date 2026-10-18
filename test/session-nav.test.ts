import { describe, expect, it } from "vitest";
import { adjacentSessionId } from "../shared/session-nav";

const sessions = [
  { id: "a" },
  { id: "b", archived: true },
  { id: "c" },
  { id: "d" },
];

describe("adjacentSessionId", () => {
  it("moves forward and backward through non-archived sessions", () => {
    expect(adjacentSessionId(sessions, "a", 1)).toBe("c");
    expect(adjacentSessionId(sessions, "c", -1)).toBe("a");
  });

  it("wraps at both ends", () => {
    expect(adjacentSessionId(sessions, "d", 1)).toBe("a");
    expect(adjacentSessionId(sessions, "a", -1)).toBe("d");
  });

  it("never lands on an archived session", () => {
    const ids = ["a", "c", "d"];
    for (const id of ids) {
      expect(adjacentSessionId(sessions, id, 1)).not.toBe("b");
      expect(adjacentSessionId(sessions, id, -1)).not.toBe("b");
    }
  });

  it("starts at the first/last item when no active session matches", () => {
    expect(adjacentSessionId(sessions, null, 1)).toBe("a");
    expect(adjacentSessionId(sessions, null, -1)).toBe("d");
    expect(adjacentSessionId(sessions, "missing", 1)).toBe("a");
  });

  it("returns null without candidates", () => {
    expect(adjacentSessionId([], null, 1)).toBeNull();
    expect(adjacentSessionId([{ id: "x", archived: true }], null, 1)).toBeNull();
  });
});
