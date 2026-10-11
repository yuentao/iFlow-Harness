/**
 * M4 P1-1 — host-side approval pre-review rule table (pure, unit-testable).
 *
 * The CLI only offers four coarse modes (default / smart / yolo / plan). This
 * module adds Cline-style fine-grained auto-approval WITHOUT touching the CLI:
 * the host runs `decideApproval` before surfacing a `session/request_permission`
 * card, so a matching rule answers the wire request directly.
 *
 * Decision order (roadmap §2 P1-1):
 *   hard veto (built-in, cannot be lifted by any rule) → deny rules → allow
 *   rules → ask rules → no match = the existing card (default-deny discipline
 *   and the 5-minute timeout are untouched).
 *
 * Safety floor: an `allow` rule NEVER auto-approves a destructive command
 * (`rm`, `git push`, …) or a `delete`-kind tool. The veto downgrades the
 * decision to `ask` — the user still sees the card — rather than silently
 * rejecting, so a legitimate `git push` is one click away instead of a mystery
 * failure. An explicit `deny` rule is always honoured (denying is never unsafe).
 *
 * Zero VSCode dependency: the same matcher runs in the host (decision) and in
 * the webview (the management card previews which rules a sample request hits).
 */

/** What a rule does when it matches. `ask` = fall through to the card. */
export type ApprovalAction = "allow" | "deny" | "ask";

/** One user-editable pre-review rule. Every dimension is optional; an empty
 * dimension matches anything, so a rule with no dimensions matches everything
 * (the card warns about that — it is a global allow/deny switch). */
export interface ApprovalRule {
  id: string;
  /** User-facing name shown in the card and in the transcript note. */
  label: string;
  enabled: boolean;
  action: ApprovalAction;
  /** ACP `ToolKind` values ("read" | "edit" | "execute" | …). */
  kinds?: string[];
  /** Path glob, matched against each `locations[].path` made relative to the
   * session cwd. `*` stays inside a segment, `**` crosses segments. */
  path?: string;
  /** Command first-words, `execute` kind only. Asymmetric on purpose: a `deny`
   * rule matches when ANY chained segment starts with one of them, an
   * `allow`/`ask` rule only when EVERY segment does. */
  commands?: string[];
  /** MCP server name (best-effort: matched as a substring of the wire
   * `toolName`, which CLI 0.5.19 often omits on permission requests). */
  server?: string;
  /** Exact wire `toolName` (case-insensitive). */
  tool?: string;
  /** How many requests this rule decided. Persisted for global rules only —
   * the project file is user-owned and never written back. */
  hits?: number;
}

/** The wire facts a decision is made from. CLI 0.5.19 permission requests
 * carry `kind`, `title` (the command text for execute tools) and `locations`,
 * but NOT `toolName`/`args` — every field here may be empty. */
export interface ApprovalRequestInfo {
  toolName: string;
  toolKind: string;
  title: string;
  /** `toolCall.locations[].path`, verbatim (absolute or agent-relative). */
  paths: string[];
  /** Session cwd — the base for `path` glob matching. */
  cwd: string;
}

export interface ApprovalDecision {
  action: ApprovalAction;
  /** The rule that decided (`undefined` = no rule matched → show the card). */
  ruleId?: string;
  ruleLabel?: string;
  /** True when a hard veto downgraded an `allow` rule to `ask`. */
  vetoed?: boolean;
}

/** Above this the table stops being reviewable — refuse to load more. */
export const APPROVAL_RULES_MAX = 100;

export const APPROVAL_POLICY_VERSION = 1;

/** Chained-command separators. PowerShell uses `;`, POSIX shells `&&`/`||`/`|`,
 * and agents emit multi-line scripts — every segment is judged on its own. */
const COMMAND_SEPARATORS = /&&|\|\||[;&|\n\r]/;

/**
 * Built-in destructive prefixes an `allow` rule can never cover (roadmap:
 * 「不得覆盖删除类与 rm / git push 类命令」). Token sequences, matched against
 * the start of each chained segment. NOT user-editable and NOT overridable.
 */
export const HARD_DENY_PREFIXES: readonly (readonly string[])[] = [
  ["rm"], ["rmdir"], ["rd"], ["del"], ["erase"], ["remove-item"], ["unlink"], ["shred"],
  ["format"], ["mkfs"], ["dd"], ["diskpart"], ["fdisk"],
  ["shutdown"], ["reboot"], ["halt"], ["poweroff"], ["restart-computer"], ["stop-computer"],
  ["git", "push"], ["git", "reset"], ["git", "clean"], ["git", "checkout"],
  ["git", "restore"], ["git", "rebase"], ["git", "filter-branch"], ["git", "update-ref"],
  ["npm", "publish"], ["yarn", "publish"], ["pnpm", "publish"], ["vsce", "publish"],
  ["reg", "delete"], ["setx"],
];

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** Split a command line into its chained segments (empty segments dropped). */
export function splitCommandSegments(text: string): string[] {
  return text
    .split(COMMAND_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Leading tokens of one segment, lowercased, with quotes and any directory
 * prefix stripped (`C:\Windows\System32\cmd.exe /c …` → `cmd.exe`, `/c`, …).
 * Returned as a list so multi-word prefixes (`git push`) can be matched.
 */
export function segmentTokens(segment: string): string[] {
  const raw = segment.split(/\s+/).filter((t) => t.length > 0);
  return raw
    .map((token, index) => {
      let t = token.replace(/^["'`]+|["'`]+$/g, "");
      // Only the command name (first token) can be a path; `/c`-style POSIX
      // flags elsewhere in the line must stay verbatim.
      if (index === 0) {
        const slash = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
        if (slash > 0) t = t.slice(slash + 1);
      }
      return t.toLowerCase();
    })
    .filter((t) => t.length > 0);
}

/** True when `tokens` starts with every element of `prefix`. */
function startsWithPrefix(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || tokens.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (tokens[i] !== prefix[i]) return false;
  return true;
}

/**
 * The safety floor: the destructive prefix (or "delete" tool kind) that blocks
 * auto-approval, or null when the request is eligible for an `allow` rule.
 * Any ONE chained segment is enough — `npm test && rm -rf dist` is vetoed.
 */
export function hardDenyReason(info: ApprovalRequestInfo): string | null {
  if (info.toolKind === "delete") return "delete";
  if (info.toolKind !== "execute") return null;
  for (const segment of splitCommandSegments(info.title)) {
    const tokens = segmentTokens(segment);
    for (const prefix of HARD_DENY_PREFIXES) {
      if (startsWithPrefix(tokens, prefix)) return prefix.join(" ");
    }
  }
  return null;
}

/** Compile a glob (`*` intra-segment, `**` cross-segment, `?` single char). */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero segments
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExpChar(c);
    }
  }
  return new RegExp(`${out}$`, "i");
}

/** `path` relative to `cwd` with POSIX separators; unchanged when outside. */
export function relativePathFor(path: string, cwd: string): string {
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const base = norm(cwd);
  if (base && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return p.slice(base.length + 1);
  return p.replace(/^\/+/, "");
}

/** Match one glob against a path (basename fallback for slash-free globs, so
 * `*.test.ts` also hits `src/foo/bar.test.ts`). */
export function matchPathGlob(glob: string, path: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(path)) return true;
  if (glob.includes("/")) return false;
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return re.test(base);
}

/** Does `rule` match this request? Every set dimension must match. */
export function matchRule(rule: ApprovalRule, info: ApprovalRequestInfo): boolean {
  if (rule.kinds && rule.kinds.length > 0) {
    if (!rule.kinds.some((k) => k.toLowerCase() === info.toolKind.toLowerCase())) return false;
  }
  if (rule.tool && rule.tool.trim()) {
    if (rule.tool.trim().toLowerCase() !== info.toolName.toLowerCase()) return false;
  }
  if (rule.server && rule.server.trim()) {
    // Best-effort: MCP tool names embed the server name; the wire often omits
    // toolName entirely on permission requests, in which case this cannot match.
    if (!info.toolName.toLowerCase().includes(rule.server.trim().toLowerCase())) return false;
  }
  if (rule.path && rule.path.trim()) {
    const glob = rule.path.trim();
    const hit = info.paths.some((p) => matchPathGlob(glob, relativePathFor(p, info.cwd)));
    if (!hit) return false;
  }
  if (rule.commands && rule.commands.length > 0) {
    if (info.toolKind.toLowerCase() !== "execute") return false;
    const wanted = new Set(rule.commands.map((c) => c.trim().toLowerCase()).filter(Boolean));
    if (wanted.size === 0) return false;
    const segments = splitCommandSegments(info.title);
    if (segments.length === 0) return false;
    const firsts = segments.map((s) => segmentTokens(s)[0] ?? "");
    if (rule.action === "deny") {
      if (!firsts.some((f) => wanted.has(f))) return false;
    } else if (!firsts.every((f) => wanted.has(f))) {
      return false;
    }
  }
  return true;
}

/**
 * The pre-review verdict. `rules` must already be in precedence order (the
 * host concatenates project rules before global rules, so a project
 * `.iflow/approval.json` overrides the user's global table).
 */
export function decideApproval(rules: readonly ApprovalRule[], info: ApprovalRequestInfo): ApprovalDecision {
  const veto = hardDenyReason(info);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchRule(rule, info)) continue;
    if (rule.action === "deny") return { action: "deny", ruleId: rule.id, ruleLabel: rule.label };
    if (rule.action === "allow") {
      if (veto) return { action: "ask", ruleId: rule.id, ruleLabel: rule.label, vetoed: true };
      return { action: "allow", ruleId: rule.id, ruleLabel: rule.label };
    }
    return { action: "ask", ruleId: rule.id, ruleLabel: rule.label };
  }
  return { action: "ask" };
}

/**
 * Derive the rule for a 「始终允许」 click: the narrowest useful generalisation
 * of THIS request (command first-words for execute, the touched path for
 * file tools). Returns null when the request is hard-vetoed — persisting an
 * allow rule that could never fire would just mislead the user.
 */
export function deriveAllowRule(info: ApprovalRequestInfo, id: string): ApprovalRule | null {
  if (hardDenyReason(info)) return null;
  const kinds = info.toolKind ? [info.toolKind] : undefined;
  if (info.toolKind.toLowerCase() === "execute") {
    const words: string[] = [];
    for (const segment of splitCommandSegments(info.title)) {
      const first = segmentTokens(segment)[0];
      if (first && !words.includes(first)) words.push(first);
    }
    if (words.length === 0) return null;
    return {
      id,
      label: `自动允许 ${words.join(" / ")}`,
      enabled: true,
      action: "allow",
      kinds: ["execute"],
      commands: words,
      hits: 0,
    };
  }
  const first = info.paths[0];
  if (first) {
    const rel = relativePathFor(first, info.cwd);
    return {
      id,
      label: `自动允许 ${info.toolKind || "tool"} ${rel}`,
      enabled: true,
      action: "allow",
      kinds,
      path: rel,
      tool: info.toolName || undefined,
      hits: 0,
    };
  }
  if (!info.toolName && (!kinds || kinds.length === 0)) return null;
  return {
    id,
    label: `自动允许 ${info.toolName || info.toolKind || "tool"}`,
    enabled: true,
    action: "allow",
    kinds,
    tool: info.toolName || undefined,
    hits: 0,
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return out.length > 0 ? out : undefined;
}

/** Coerce one untrusted rule object into a valid rule, or null. */
export function normalizeApprovalRule(raw: unknown, fallbackId: string): ApprovalRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const action = r.action;
  if (action !== "allow" && action !== "deny" && action !== "ask") return null;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : fallbackId;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
  return {
    id,
    label,
    enabled: r.enabled !== false,
    action,
    kinds: asStringArray(r.kinds),
    path: typeof r.path === "string" && r.path.trim() ? r.path.trim() : undefined,
    commands: asStringArray(r.commands),
    server: typeof r.server === "string" && r.server.trim() ? r.server.trim() : undefined,
    tool: typeof r.tool === "string" && r.tool.trim() ? r.tool.trim() : undefined,
    hits: typeof r.hits === "number" && Number.isFinite(r.hits) && r.hits > 0 ? Math.floor(r.hits) : 0,
  };
}

/** Parse a persisted policy (globalState JSON or `.iflow/approval.json`).
 * Returns null when the payload is not a recognisable policy — the caller then
 * keeps whatever it had instead of silently wiping the table. */
export function parseApprovalPolicy(text: string): ApprovalRule[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = (parsed as Record<string, unknown>).rules;
  if (!Array.isArray(raw)) return null;
  const rules: ApprovalRule[] = [];
  for (const entry of raw.slice(0, APPROVAL_RULES_MAX)) {
    const rule = normalizeApprovalRule(entry, `rule-${rules.length + 1}`);
    if (rule && !rules.some((r) => r.id === rule.id)) rules.push(rule);
  }
  return rules;
}

export function serializeApprovalPolicy(rules: readonly ApprovalRule[]): string {
  return JSON.stringify({ version: APPROVAL_POLICY_VERSION, rules }, null, 2);
}
