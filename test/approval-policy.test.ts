import { describe, it, expect } from "vitest";
import {
  decideApproval,
  deriveAllowRule,
  globToRegExp,
  hardDenyReason,
  matchPathGlob,
  matchRule,
  normalizeApprovalRule,
  parseApprovalPolicy,
  relativePathFor,
  segmentTokens,
  serializeApprovalPolicy,
  splitCommandSegments,
  type ApprovalRequestInfo,
  type ApprovalRule,
} from "../shared/approval-policy.js";

function info(over: Partial<ApprovalRequestInfo> = {}): ApprovalRequestInfo {
  return {
    toolName: "",
    toolKind: "other",
    title: "",
    paths: [],
    cwd: "J:/repo",
    ...over,
  };
}

function rule(over: Partial<ApprovalRule>): ApprovalRule {
  return { id: "r", label: "test rule", enabled: true, action: "allow", ...over };
}

describe("splitCommandSegments / segmentTokens", () => {
  it("splits POSIX, PowerShell and multi-line chains", () => {
    expect(splitCommandSegments("git add . && git commit -m x")).toEqual(["git add .", "git commit -m x"]);
    expect(splitCommandSegments("npm test; npm run build")).toEqual(["npm test", "npm run build"]);
    expect(splitCommandSegments("echo a || echo b")).toEqual(["echo a", "echo b"]);
    expect(splitCommandSegments("ls | wc -l")).toEqual(["ls", "wc -l"]);
    expect(splitCommandSegments("line1\r\nline2")).toEqual(["line1", "line2"]);
    expect(splitCommandSegments("&& & ;")).toEqual([]);
  });

  it("normalises tokens: quotes, directory prefixes, case", () => {
    expect(segmentTokens('"C:\\Windows\\System32\\cmd.exe" /c dir')).toEqual(["cmd.exe", "/c", "dir"]);
    expect(segmentTokens("/usr/bin/Git push")).toEqual(["git", "push"]);
    expect(segmentTokens("   ")).toEqual([]);
  });
});

describe("hardDenyReason", () => {
  it("vetoes destructive execute commands", () => {
    expect(hardDenyReason(info({ toolKind: "execute", title: "rm -rf dist" }))).toBe("rm");
    expect(hardDenyReason(info({ toolKind: "execute", title: "git push origin main" }))).toBe("git push");
    expect(hardDenyReason(info({ toolKind: "execute", title: "Remove-Item -Recurse x" }))).toBe("remove-item");
  });

  it("vetoes when ANY chained segment is destructive", () => {
    expect(hardDenyReason(info({ toolKind: "execute", title: "npm test && rm -rf coverage" }))).toBe("rm");
    expect(hardDenyReason(info({ toolKind: "execute", title: "git add .; git clean -fd" }))).toBe("git clean");
  });

  it("does not veto read-only or unrelated commands", () => {
    expect(hardDenyReason(info({ toolKind: "execute", title: "git status" }))).toBeNull();
    expect(hardDenyReason(info({ toolKind: "execute", title: "npm run format" }))).toBeNull();
    expect(hardDenyReason(info({ toolKind: "read" }))).toBeNull();
  });

  it("vetoes the delete tool kind regardless of title", () => {
    expect(hardDenyReason(info({ toolKind: "delete", title: "whatever" }))).toBe("delete");
  });
});

describe("glob matching", () => {
  it("'*' stays inside a segment, '**' crosses segments", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true); // **/ matches zero segments
    expect(globToRegExp("src/**/*.ts").test("src/deep/deeper/a.ts")).toBe(true);
  });

  it("slash-free globs fall back to basename", () => {
    expect(matchPathGlob("*.test.ts", "src/foo/bar.test.ts")).toBe(true);
    expect(matchPathGlob(".env*", ".env.local")).toBe(true);
    expect(matchPathGlob(".env*", "config/.env.local")).toBe(true);
    expect(matchPathGlob("*.md", "src/a.ts")).toBe(false);
  });

  it("relativePathFor strips the cwd and POSIX-ifies (case-insensitive drive)", () => {
    expect(relativePathFor("J:\\repo\\src\\a.ts", "J:/repo")).toBe("src/a.ts");
    expect(relativePathFor("j:/repo/x.md", "J:/repo/")).toBe("x.md");
    expect(relativePathFor("C:/elsewhere/a.ts", "J:/repo")).toBe("C:/elsewhere/a.ts");
  });
});

describe("matchRule dimensions", () => {
  it("empty rule matches everything", () => {
    expect(matchRule(rule({}), info())).toBe(true);
  });

  it("kinds and tool are case-insensitive", () => {
    expect(matchRule(rule({ kinds: ["Read"] }), info({ toolKind: "read" }))).toBe(true);
    expect(matchRule(rule({ kinds: ["read"] }), info({ toolKind: "edit" }))).toBe(false);
    expect(matchRule(rule({ tool: "Read_File" }), info({ toolName: "read_file" }))).toBe(true);
  });

  it("path dimension needs at least one location hit", () => {
    const r = rule({ path: "src/**" });
    expect(matchRule(r, info({ paths: ["J:/repo/src/a.ts", "J:/repo/README.md"] }))).toBe(true);
    expect(matchRule(r, info({ paths: ["J:/repo/docs/a.md"] }))).toBe(false);
    expect(matchRule(r, info({ paths: [] }))).toBe(false);
  });

  it("server matches as substring of toolName (best-effort)", () => {
    expect(matchRule(rule({ server: "chrome" }), info({ toolName: "chrome-devtools_click" }))).toBe(true);
    expect(matchRule(rule({ server: "chrome" }), info({ toolName: "" }))).toBe(false);
  });

  it("commands: allow requires EVERY segment, deny ANY segment", () => {
    const allow = rule({ action: "allow", kinds: ["execute"], commands: ["git"] });
    expect(matchRule(allow, info({ toolKind: "execute", title: "git add . && git commit" }))).toBe(true);
    expect(matchRule(allow, info({ toolKind: "execute", title: "git add . && rm -rf x" }))).toBe(false);
    const deny = rule({ action: "deny", kinds: ["execute"], commands: ["git"] });
    expect(matchRule(deny, info({ toolKind: "execute", title: "npm test && git push" }))).toBe(true);
  });

  it("commands only apply to execute kind", () => {
    const r = rule({ kinds: ["read"], commands: ["git"] });
    expect(matchRule(r, info({ toolKind: "read", title: "git status" }))).toBe(false);
  });
});

describe("decideApproval", () => {
  const allowAll = rule({ id: "a", action: "allow" });

  it("no rules / no match → ask", () => {
    expect(decideApproval([], info())).toEqual({ action: "ask" });
    expect(decideApproval([rule({ action: "allow", kinds: ["edit"] })], info({ toolKind: "read" }))).toEqual({
      action: "ask",
    });
  });

  it("first enabled match wins; disabled rules are skipped", () => {
    const rules = [
      rule({ id: "off", enabled: false, action: "deny" }),
      rule({ id: "first", action: "allow" }),
      rule({ id: "second", action: "deny" }),
    ];
    expect(decideApproval(rules, info())).toEqual({ action: "allow", ruleId: "first", ruleLabel: "test rule" });
  });

  it("deny short-circuits before a broader allow", () => {
    const rules = [rule({ id: "deny-env", action: "deny", path: "**/.env*" }), allowAll];
    expect(decideApproval(rules, info({ paths: ["J:/repo/.env"] })).action).toBe("deny");
  });

  it("hard veto downgrades allow to ask (never silent auto-approve)", () => {
    const d = decideApproval([allowAll], info({ toolKind: "execute", title: "git push" }));
    expect(d).toEqual({ action: "ask", ruleId: "a", ruleLabel: "test rule", vetoed: true });
  });

  it("hard veto does NOT block an explicit deny rule", () => {
    const d = decideApproval([rule({ id: "d", action: "deny", kinds: ["execute"] })], info({ toolKind: "execute", title: "rm x" }));
    expect(d.action).toBe("deny");
  });

  it("an ask rule stops the chain with its label", () => {
    const d = decideApproval([rule({ id: "ask1", action: "ask", kinds: ["edit"] })], info({ toolKind: "edit" }));
    expect(d).toEqual({ action: "ask", ruleId: "ask1", ruleLabel: "test rule" });
  });
});

describe("deriveAllowRule", () => {
  it("execute: collects the first word of every segment", () => {
    const r = deriveAllowRule(info({ toolKind: "execute", title: "git add . && git commit -m x" }), "d1");
    expect(r).toMatchObject({ id: "d1", action: "allow", kinds: ["execute"], commands: ["git"] });
  });

  it("file tool: uses the kind and the first location (relative)", () => {
    const r = deriveAllowRule(info({ toolKind: "read", toolName: "read_file", paths: ["J:/repo/src/a.ts"] }), "d2");
    expect(r).toMatchObject({ kinds: ["read"], path: "src/a.ts", tool: "read_file" });
  });

  it("returns null for hard-vetoed requests", () => {
    expect(deriveAllowRule(info({ toolKind: "execute", title: "rm -rf x" }), "d3")).toBeNull();
    expect(deriveAllowRule(info({ toolKind: "delete" }), "d4")).toBeNull();
  });

  it("returns null when nothing is matchable", () => {
    expect(deriveAllowRule(info({ toolKind: "execute", title: "   " }), "d5")).toBeNull();
    expect(deriveAllowRule(info({ toolKind: "", toolName: "", paths: [] }), "d6")).toBeNull();
  });
});

describe("persistence round-trip", () => {
  it("serialize → parse preserves the rules", () => {
    const rules = [
      rule({ id: "a", action: "allow", kinds: ["read"], path: "src/**", hits: 7 }),
      rule({ id: "b", label: "deny env", action: "deny", path: ".env*", hits: 0 }),
    ];
    const parsed = parseApprovalPolicy(serializeApprovalPolicy(rules));
    expect(parsed).toEqual(rules);
  });

  it("parse rejects garbage but normalises junk entries", () => {
    expect(parseApprovalPolicy("not json")).toBeNull();
    expect(parseApprovalPolicy("[]")).toBeNull();
    expect(parseApprovalPolicy('{"rules":[]}')).toEqual([]);
    const parsed = parseApprovalPolicy(
      JSON.stringify({
        rules: [
          { action: "allow" }, // missing id/label → fallbacks
          { action: "nope" }, // invalid action → dropped
          "junk", // non-object → dropped
          { id: "dup", action: "deny" },
          { id: "dup", action: "allow" }, // duplicate id → dropped
        ],
      }),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ id: "rule-1", label: "rule-1", action: "allow", enabled: true });
    expect(parsed![1]).toMatchObject({ id: "dup", action: "deny" });
  });

  it("normalizeApprovalRule defaults enabled true and clamps hits", () => {
    expect(normalizeApprovalRule({ action: "ask" }, "f1")).toMatchObject({ id: "f1", enabled: true, hits: 0 });
    expect(normalizeApprovalRule({ action: "ask", hits: -3 }, "f2")).toMatchObject({ hits: 0 });
    expect(normalizeApprovalRule({ action: "ask", hits: 2.9 }, "f3")).toMatchObject({ hits: 2 });
    expect(normalizeApprovalRule(null, "f4")).toBeNull();
  });
});
