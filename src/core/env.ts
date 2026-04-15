import { readFile } from "node:fs/promises";
import path from "node:path";

/** .env 加载选项，默认读取当前工作目录下的 .env。 */
export interface LoadDotEnvOptions {
  /** .env 所在目录；CLI 会传项目根目录。 */
  cwd?: string;
  /** 环境变量文件名，默认 .env。 */
  fileName?: string;
  /** 是否覆盖已经存在的环境变量；默认不覆盖 shell 显式传入的值。 */
  override?: boolean;
  /** 注入目标，测试时可以传自定义对象，生产默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/** .env 加载结果，方便未来 debug 命令展示配置来源。 */
export interface LoadDotEnvResult {
  /** 实际尝试读取的文件路径。 */
  path: string;
  /** 文件是否存在并成功读取。 */
  loaded: boolean;
  /** 实际写入 env 的 key 列表，不包含被已有环境变量保护而跳过的 key。 */
  keys: string[];
}

/** 从磁盘读取 .env 并写入目标 env；文件不存在时静默跳过。 */
export async function loadDotEnv(options: LoadDotEnvOptions = {}): Promise<LoadDotEnvResult> {
  const dotEnvPath = path.resolve(options.cwd ?? process.cwd(), options.fileName ?? ".env");

  let raw: string;
  try {
    raw = await readFile(dotEnvPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        path: dotEnvPath,
        loaded: false,
        keys: [],
      };
    }

    throw error;
  }

  const values = parseDotEnv(raw);
  const keys = applyDotEnv(values, options.env ?? process.env, options.override ?? false);

  return {
    path: dotEnvPath,
    loaded: true,
    keys,
  };
}

/** 解析 .env 文本；MVP 支持 KEY=value、export KEY=value、单双引号和注释。 */
export function parseDotEnv(raw: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values.set(match[1], parseDotEnvValue(match[2] ?? ""));
  }

  return values;
}

/** 把解析后的键值写入 env；默认保留外部 shell 已经设置的值。 */
export function applyDotEnv(
  values: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  override = false,
): string[] {
  const appliedKeys: string[] = [];

  for (const [key, value] of values) {
    if (!override && env[key] !== undefined) {
      continue;
    }

    env[key] = value;
    appliedKeys.push(key);
  }

  return appliedKeys;
}

/** 解析单个 .env value，尽量贴近常见 dotenv 行为但保持零依赖。 */
function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trimStart();

  if (value.startsWith('"')) {
    return readDoubleQuotedValue(value);
  }

  if (value.startsWith("'")) {
    return readSingleQuotedValue(value);
  }

  // 非引号值允许行尾注释：KEY=value # comment；KEY=value#hash 会保留 #hash。
  return value.replace(/\s+#.*$/, "").trim();
}

/** 读取双引号值，并处理常见转义字符。 */
function readDoubleQuotedValue(value: string): string {
  let result = "";
  let escaped = false;

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      result += decodeDoubleQuotedEscape(character);
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      return result;
    }

    result += character;
  }

  return result;
}

/** 读取单引号值；单引号内不做转义处理。 */
function readSingleQuotedValue(value: string): string {
  const endIndex = value.indexOf("'", 1);
  if (endIndex === -1) {
    return value.slice(1);
  }

  return value.slice(1, endIndex);
}

/** 双引号 .env value 中支持的最小转义集合。 */
function decodeDoubleQuotedEscape(character: string): string {
  if (character === "n") {
    return "\n";
  }

  if (character === "r") {
    return "\r";
  }

  if (character === "t") {
    return "\t";
  }

  return character;
}

/** 判断读取 .env 失败是否只是文件不存在。 */
function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
