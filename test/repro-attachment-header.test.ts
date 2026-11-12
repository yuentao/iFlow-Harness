import { describe, it, expect } from "vitest";
import { findCliHistoryCut } from "../shared/session-state.js";

const user = (text: string) => ({ role: "user", parts: [{ text }] });

/**
 * Reproducer for the one-end-only English-ification of the attachment header.
 *
 * Producer (src/panel/panel.ts, after commit 185e842) writes:
 *   "The user attached the following local files (read them as needed):"
 * Consumer (shared/session-state.ts, cliTurnMatches) still matches:
 *   /用户附带以下本地文件[\s\S]*：\n- /u
 *
 * → the consumer no longer recognizes what the producer writes.
 */
describe("REPRO: attachment header producer/consumer mismatch", () => {
  it("shows the current producer output is NOT recognized by the consumer", () => {
    const PRODUCED = "看这个文件\n\nThe user attached the following local files (read them as needed):\n- a.ts → /p/a.ts";
    const cut = findCliHistoryCut([user(PRODUCED)], ["看这个文件"], 0);
    // eslint-disable-next-line no-console
    console.log("[repro] findCliHistoryCut =>", JSON.stringify(cut));
    expect(cut).toEqual({ kind: "truncate", index: 0 });
  });

  it("shows the OLD (Chinese) header IS recognized — proving the consumer is the stale side", () => {
    const OLD = "看这个文件\n\n用户附带以下本地文件（可按需读取）：\n- a.ts → /p/a.ts";
    const cut = findCliHistoryCut([user(OLD)], ["看这个文件"], 0);
    // eslint-disable-next-line no-console
    console.log("[repro] old header =>", JSON.stringify(cut));
    expect(cut).toEqual({ kind: "truncate", index: 0 });
  });
});