import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SkillManifest, SkillSafetyPolicy } from "./types.ts";

/** 扫描 skills 根目录并加载每个子目录中的 SKILL.md。 */
export async function loadSkills(skillsRoot: string): Promise<SkillManifest[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills: SkillManifest[] = [];

  for (const entry of entries) {
    // 只把目录视为 skill，忽略 README、临时文件等非目录条目。
    if (!entry.isDirectory()) {
      continue;
    }

    const id = entry.name;
    const directory = path.join(skillsRoot, id);
    const skillPath = path.join(directory, "SKILL.md");
    const raw = await readFile(skillPath, "utf8");
    skills.push(parseSkill(id, directory, raw));
  }

  // 稳定排序，避免 skill 列表顺序影响 prompt cache 和测试输出。
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 解析单个 SKILL.md，并强制要求 name/description 两个最小 frontmatter 字段。 */
export function parseSkill(id: string, directory: string, raw: string): SkillManifest {
  const parsed = parseFrontmatter(raw);
  const name = readFrontmatterString(parsed.frontmatter.get("name"));
  const description = readFrontmatterString(parsed.frontmatter.get("description"));

  if (!name || !description) {
    throw new Error(`Skill ${id} must define name and description in SKILL.md frontmatter.`);
  }

  return {
    id,
    name,
    description,
    tools: readFrontmatterStringList(parsed.frontmatter.get("tools")),
    safety: readSkillSafetyPolicy(parsed.frontmatter.get("safety")),
    directory,
    body: parsed.body.trim(),
  };
}

/** frontmatter value 的最小类型集合，覆盖 scalar、list 和一层 object。 */
type FrontmatterValue = string | boolean | string[] | Record<string, string | boolean>;

/** 轻量 YAML frontmatter 解析器；MVP 支持 key: value、数组和一层对象，避免过早引入依赖。 */
function parseFrontmatter(raw: string): { frontmatter: Map<string, FrontmatterValue>; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter.");
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex === -1) {
    throw new Error("SKILL.md frontmatter must end with ---.");
  }

  const frontmatter = new Map<string, FrontmatterValue>();
  const frontmatterLines = lines.slice(1, endIndex);
  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const line = frontmatterLines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    // 只解析顶层 key；缩进行由父 key 的分支消费。
    if (/^\s/.test(line)) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (rawValue) {
      frontmatter.set(key, parseScalarFrontmatterValue(rawValue));
      continue;
    }

    const nestedLines: string[] = [];
    while (index + 1 < frontmatterLines.length && /^\s+/.test(frontmatterLines[index + 1])) {
      index += 1;
      nestedLines.push(frontmatterLines[index]);
    }

    frontmatter.set(key, parseNestedFrontmatterValue(nestedLines));
  }

  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

/** 解析 scalar frontmatter value，支持基础布尔值和去引号字符串。 */
function parseScalarFrontmatterValue(value: string): string | boolean {
  const normalized = trimQuotes(value.trim());
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return normalized;
}

/** 解析缩进块：支持 `- value` 数组或 `key: value` 对象。 */
function parseNestedFrontmatterValue(lines: string[]): FrontmatterValue {
  const meaningfulLines = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (meaningfulLines.every((line) => line.startsWith("- "))) {
    return meaningfulLines.map((line) => trimQuotes(line.slice(2).trim()));
  }

  const record: Record<string, string | boolean> = {};
  for (const line of meaningfulLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseScalarFrontmatterValue(line.slice(separatorIndex + 1).trim());
    record[key] = value;
  }

  return record;
}

/** 从 frontmatter value 中读取字符串。 */
function readFrontmatterString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 从 frontmatter value 中读取字符串数组，也兼容逗号分隔的单行写法。 */
function readFrontmatterStringList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

/** 读取 skill 安全策略；未声明时默认禁止自动签名和自动广播。 */
function readSkillSafetyPolicy(value: FrontmatterValue | undefined): SkillSafetyPolicy {
  if (isFrontmatterRecord(value)) {
    return {
      autoSign: value.autoSign === true,
      autoBroadcast: value.autoBroadcast === true,
    };
  }

  return {
    autoSign: false,
    autoBroadcast: false,
  };
}

/** 去掉成对单双引号。 */
function trimQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** 判断 frontmatter value 是否是一层对象。 */
function isFrontmatterRecord(value: FrontmatterValue | undefined): value is Record<string, string | boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
