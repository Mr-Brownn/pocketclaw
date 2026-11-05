import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir, ensurePrivateDir, isInside } from "./utils.ts";

export interface SkillMetadata {
  name: string;
  description: string;
  directoryPath: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MAIN_CONTENT = 200_000;
const MAX_EXTRA_FILE = 100_000;
const MAX_EXTRA_FILES = 20;

function skillsDir(): string {
  return ensurePrivateDir(join(dataDir(), "skills"));
}

export function parseYamlFrontmatter(fileContent: string): { metadata: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fileContent);
  if (!match) return { metadata: {}, body: fileContent };

  const metadata: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    metadata[key] = value;
  }
  return { metadata, body: match[2] ?? "" };
}

function skillFolder(name: string): string {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid skill name "${name}" (letters, digits, ".", "_" and "-" only)`);
  }
  const folder = resolve(skillsDir(), name);
  if (!isInside(skillsDir(), folder) || folder === resolve(skillsDir())) {
    throw new Error(`Invalid skill name "${name}"`);
  }
  return folder;
}

/** Resolves `relPath` inside `folder`, rejecting absolute paths, traversal and NUL bytes. */
function fileInside(folder: string, relPath: string): string {
  const rel = relPath.replace(/\\/g, "/").trim();
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Invalid file path "${relPath}"`);
  }
  const target = resolve(folder, rel);
  if (target === resolve(folder) || !isInside(folder, target)) {
    throw new Error(`File path "${relPath}" escapes the skill folder`);
  }
  return target;
}

export class SkillManager {
  public listSkills(): SkillMetadata[] {
    const dir = skillsDir();
    const result: SkillMetadata[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, entry.name);
      let skillFile = join(folder, "SKILL.md");
      if (!existsSync(skillFile)) skillFile = join(folder, "skill.md");
      if (!existsSync(skillFile)) continue;
      try {
        const { metadata } = parseYamlFrontmatter(readFileSync(skillFile, "utf8"));
        result.push({
          name: metadata.name || entry.name,
          description: metadata.description || "No description provided.",
          directoryPath: folder,
        });
      } catch {
        // ignore unreadable skill files
      }
    }
    return result;
  }

  public loadSkill(name: string, subFile = "SKILL.md"): string {
    let folder: string;
    let filePath: string;
    try {
      folder = skillFolder(name);
      if (!existsSync(folder)) return `Error: Skill '${name}' not found.`;
      filePath = fileInside(folder, subFile);
      if (!existsSync(filePath) && subFile === "SKILL.md") filePath = fileInside(folder, "skill.md");
      if (!existsSync(filePath)) return `Error: File '${subFile}' not found in skill '${name}'.`;
      // Block symlinks that point outside the skill folder.
      if (!isInside(realpathSync(folder), realpathSync(filePath))) {
        return `Error: File '${subFile}' resolves outside skill '${name}'.`;
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    return readFileSync(filePath, "utf8");
  }

  public createSkill(
    name: string,
    description: string,
    mainContent: string,
    extraFiles: Record<string, string> = {}
  ): string {
    const cleanName = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^[-_]+/, "")
      .slice(0, 64);
    if (!cleanName) throw new Error("Skill name must contain at least one letter or digit");
    const folder = skillFolder(cleanName);

    const cleanDescription = description.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!cleanDescription) throw new Error("Skill description must not be empty");
    if (mainContent.length > MAX_MAIN_CONTENT) throw new Error("mainContent is too large");

    const entries = Object.entries(extraFiles);
    if (entries.length > MAX_EXTRA_FILES) throw new Error(`At most ${MAX_EXTRA_FILES} extra files are allowed`);

    // Validate every path before writing anything so a bad entry cannot leave a half-written skill.
    const planned: Array<[string, string]> = entries.map(([filename, content]) => {
      if (typeof content !== "string") throw new Error(`Extra file "${filename}" must be a string`);
      if (content.length > MAX_EXTRA_FILE) throw new Error(`Extra file "${filename}" is too large`);
      const target = fileInside(folder, filename);
      if (/^skill\.md$/i.test(filename.replace(/\\/g, "/"))) {
        throw new Error("Use mainContent for SKILL.md instead of extraFiles");
      }
      return [target, content];
    });

    mkdirSync(folder, { recursive: true });
    // JSON strings are valid YAML double-quoted scalars, so colons/quotes/newlines cannot inject keys.
    const skillMd = `---\nname: ${cleanName}\ndescription: ${JSON.stringify(cleanDescription)}\n---\n\n${mainContent}`;
    writeFileSync(join(folder, "SKILL.md"), skillMd, "utf8");
    for (const [target, content] of planned) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    return `Successfully created skill '${cleanName}' at ${folder}`;
  }

  public deleteSkill(name: string): string {
    let folder: string;
    try {
      folder = skillFolder(name);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!existsSync(folder)) return `Error: Skill '${name}' not found.`;
    rmSync(folder, { recursive: true, force: true });
    return `Successfully deleted skill '${name}'.`;
  }
}

let skillManagerInstance: SkillManager | null = null;

export function getSkillManager(): SkillManager {
  skillManagerInstance ??= new SkillManager();
  return skillManagerInstance;
}
