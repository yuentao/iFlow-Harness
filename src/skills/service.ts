import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readIfExists } from "../memory/files.js";
import { parseFrontmatter } from "../assets/service.js";

/**
 * Host-side skill lookup (CLI 0.5.19 contract, probed in the bundle):
 *
 *   - The CLI's SkillScanner walks TWO roots, one level deep:
 *     `~/.iflow/skills/<dir>/SKILL.md` (global) and
 *     `<cwd>/.iflow/skills/<dir>/SKILL.md` (project). A skill without a
 *     frontmatter `name` is skipped.
 *   - The skill's NAME is the frontmatter `name` — NOT the directory name —
 *     and the GLOBAL set wins: a project skill whose name matches a loaded
 *     global one is never loaded (the CLI keeps the global entry).
 *   - The Skill tool injects `buildUserMessageContent`: the skill's BASE
 *     DIRECTORY (the `<dir>` holding SKILL.md) plus the body after the
 *     frontmatter.
 *
 * The panel resolves a skill through this module so `/skill <name>` injects
 * exactly what the CLI's own Skill tool would have injected.
 */

export interface SkillEntry {
  /** Frontmatter `name` — the name the CLI reports and the agent matches. */
  name: string;
  description: string | null;
  scope: "global" | "project";
  /** Directory holding SKILL.md — the skill's base directory. */
  baseDirectory: string;
  filePath: string;
  /** SKILL.md body (frontmatter stripped). */
  content: string;
}

export interface SkillRoot {
  scope: "global" | "project";
  dir: string;
}

/** The two roots the CLI scans, global first (global wins on a name clash). */
export function skillRoots(home: string, cwd: string | null): SkillRoot[] {
  const roots: SkillRoot[] = [{ scope: "global", dir: path.join(home, "skills") }];
  if (cwd) roots.push({ scope: "project", dir: path.join(cwd, ".iflow", "skills") });
  return roots;
}

/** All skills under the given roots; a global skill shadows a project one of
 * the same name (the CLI never loads the project copy in that case). */
export async function scanSkills(roots: readonly SkillRoot[]): Promise<SkillEntry[]> {
  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue; // root missing (ENOENT) — the CLI treats it as "no skills"
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const baseDirectory = path.join(root.dir, entry.name);
      const filePath = path.join(baseDirectory, "SKILL.md");
      const raw = await readIfExists(filePath);
      if (raw === null) continue;
      const { meta, body } = parseFrontmatter(raw);
      const name = meta["name"]?.[0]?.trim();
      if (!name) continue; // CLI: missing 'name' → not loaded
      if (byName.has(name)) continue; // global already won
      byName.set(name, {
        name,
        description: meta["description"]?.[0]?.trim() ?? null,
        scope: root.scope,
        baseDirectory,
        filePath,
        content: body.trim(),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve ONE skill by name (exact match, like the CLI's `getSkill`). */
export async function resolveSkill(
  roots: readonly SkillRoot[],
  name: string,
): Promise<SkillEntry | null> {
  const skills = await scanSkills(roots);
  return skills.find((skill) => skill.name === name) ?? null;
}
