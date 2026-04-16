/** debug 日志字段，只允许结构化输出，避免到处拼接字符串。 */
export type DebugFields = Record<string, unknown>;

/**
 * debug 事件统一采用 phase.action.status：
 * - phase：cli / agent / skill / llm / tool
 * - action：当前阶段里的动作，比如 route、skill_plan、decode_transaction
 * - status：start / done / skip / error / info
 *
 * 这样同一条调用链既适合人看，也方便以后写入 JSON trace 或接 Web UI。
 */

/** debug 事件阶段，控制日志分组和颜色。 */
type DebugPhase = "cli" | "agent" | "skill" | "llm" | "tool" | "debug";

/** debug 事件状态，统一放在事件名最后一段。 */
type DebugStatus = "start" | "done" | "skip" | "error" | "info";

/** 标准化后的 debug 事件。 */
interface NormalizedDebugEvent {
  /** 单个 logger 生命周期内递增序号。 */
  seq: number;
  /** 人类可读时间戳。 */
  time: string;
  /** 标准阶段。 */
  phase: DebugPhase;
  /** 阶段内动作，比如 route、skill_plan、decode_transaction。 */
  action: string;
  /** 标准状态。 */
  status: DebugStatus;
  /** 已脱敏字段。 */
  fields: DebugFields;
}

/** 调用链 debug logger；默认关闭，CLI 通过 --debug 或环境变量打开。 */
export interface DebugLogger {
  /** 是否启用 debug 输出。 */
  enabled: boolean;
  /** 写入一条调用链事件。 */
  log(event: string, fields?: DebugFields): void;
}

/** stderr debug logger 的创建选项。 */
export interface CreateStderrDebugLoggerInput {
  /** 是否启用 debug 输出。 */
  enabled: boolean;
  /** 是否强制使用颜色；不传时按终端能力自动判断。 */
  color?: boolean;
}

/** ANSI 样式码，集中放这里便于未来换主题。 */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

/** 永远关闭的 logger，方便核心代码无条件调用。 */
export const noopDebugLogger: DebugLogger = {
  enabled: false,
  log() {
    // no-op logger 用于生产默认路径，不产生任何输出。
  },
};

/** 判断 CLI/env 是否打开 debug 模式。 */
export function isDebugEnabled(input: { cliValue?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const value = input.cliValue ?? input.env?.CHAINCRAFT_DEBUG ?? process.env.CHAINCRAFT_DEBUG;
  if (value === undefined) {
    return false;
  }

  return ["1", "true", "yes", "on", "debug"].includes(value.toLowerCase());
}

/** 创建 stderr logger；debug 走 stderr，避免污染 stdout 的 Agent 回复。 */
export function createStderrDebugLogger(input: CreateStderrDebugLoggerInput): DebugLogger {
  if (!input.enabled) {
    return noopDebugLogger;
  }

  // 颜色只影响终端展示，不改变事件字段本身；非 TTY 会自动退回纯文本。
  const colorEnabled = input.color ?? shouldUseColor(process.stderr, process.env);
  // seq 是单个进程内的调用链顺序号，便于肉眼定位“第几步慢/错”。
  let sequence = 0;

  return {
    enabled: true,
    log(event, fields) {
      sequence += 1;
      console.error(
        formatDebugLine(
          normalizeDebugEvent({
            event,
            fields,
            seq: sequence,
            now: new Date(),
          }),
          colorEnabled,
        ),
      );
    },
  };
}

/** 统一输出 debug 事件；调用方不用反复判断 enabled。 */
export function debugLog(logger: DebugLogger | undefined, event: string, fields?: DebugFields): void {
  if (!logger?.enabled) {
    return;
  }

  logger.log(event, fields);
}

/** 把任意 debug event string 归一化为固定 phase/action/status 结构。 */
function normalizeDebugEvent(input: {
  event: string;
  fields: DebugFields | undefined;
  seq: number;
  now: Date;
}): NormalizedDebugEvent {
  // 兼容调用方偶尔传入非标准 event；最终输出仍会收敛成标准结构。
  const parts = input.event.split(".").filter(Boolean);
  const rawPhase = parts[0];
  const rawStatus = parts.at(-1);
  const phase = isDebugPhase(rawPhase) ? rawPhase : "debug";
  const status = isDebugStatus(rawStatus) ? rawStatus : inferStatus(input.fields);
  // 标准事件名的中间段都归为 action，例如 tool.decode_transaction.done -> decode_transaction。
  const actionParts =
    phase === "debug"
      ? parts
      : parts.slice(1, isDebugStatus(rawStatus) ? -1 : undefined);
  const action = actionParts.length > 0 ? actionParts.join(".") : "event";
  // 字段在进入 formatter 前先统一脱敏，避免后续新增 sink 时忘记处理密钥。
  const fields = sanitizeDebugValue(input.fields ?? {}) as DebugFields;

  return {
    seq: input.seq,
    time: formatDebugTime(input.now),
    phase,
    action,
    status,
    fields,
  };
}

/** 格式化一行标准 debug 调用链日志。 */
function formatDebugLine(event: NormalizedDebugEvent, colorEnabled: boolean): string {
  const label = debugEventLabel(event);
  // 固定列：产品名、序号、时间、阶段、动作、状态，后面才是 key=value 扩展字段。
  const prefix = paint("chaincraft", [ansi.bold, ansi.cyan], colorEnabled);
  const seq = paint(`#${event.seq.toString().padStart(4, "0")}`, [ansi.gray], colorEnabled);
  const time = paint(event.time, [ansi.gray], colorEnabled);
  const phase = paint(event.phase.toUpperCase(), [ansi.bold, label.phaseColor], colorEnabled);
  const action = paint(event.action, [ansi.bold], colorEnabled);
  const status = paint(event.status, [label.statusColor], colorEnabled);
  const fieldText = formatDebugFields(event.fields, colorEnabled);

  return fieldText.length > 0
    ? `${prefix} ${seq} ${time} ${phase} ${action} ${status} ${fieldText}`
    : `${prefix} ${seq} ${time} ${phase} ${action} ${status}`;
}

/** 按标准 phase/status 选择可视化分组和颜色。 */
function debugEventLabel(event: NormalizedDebugEvent): {
  phaseColor: string;
  statusColor: string;
} {
  // 阶段颜色用于快速扫调用链：LLM、Tool、Skill 一眼分开。
  const phaseColor =
    event.phase === "llm"
      ? ansi.magenta
      : event.phase === "tool"
        ? ansi.green
        : event.phase === "skill"
          ? ansi.yellow
          : event.phase === "agent"
            ? ansi.cyan
            : event.phase === "cli"
              ? ansi.blue
              : ansi.gray;
  // 状态颜色用于快速看成功/跳过/失败，尤其是长调用链里定位问题。
  const statusColor =
    event.status === "done"
      ? ansi.green
      : event.status === "skip"
        ? ansi.yellow
        : event.status === "error"
          ? ansi.red
          : event.status === "start"
        ? ansi.blue
        : ansi.gray;

  return {
    phaseColor,
    statusColor,
  };
}

/** 把字段格式化为 key=value，方便扫调用链。 */
function formatDebugFields(fields: DebugFields, colorEnabled: boolean): string {
  return sortDebugFieldEntries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const name = paint(key, [ansi.gray], colorEnabled);

      return `${name}=${formatDebugFieldValue(value, colorEnabled)}`;
    })
    .join(" ");
}

/** debug 字段固定排序，常用定位字段放前面，其余字段按字母序。 */
function sortDebugFieldEntries(fields: DebugFields): Array<[string, unknown]> {
  // 常用定位字段固定在前面，避免每行字段顺序漂移导致 debug 很难横向对比。
  const priority = [
    "session",
    "sessionId",
    "chain",
    "chainId",
    "wallet",
    "walletAddress",
    "provider",
    "model",
    "skill",
    "skillId",
    "skillName",
    "tool",
    "ok",
    "source",
    "reason",
    "error",
    "input",
    "output",
  ];
  const rank = new Map(priority.map((key, index) => [key, index]));

  return Object.entries(fields).sort(([left], [right]) => {
    const leftRank = rank.get(left) ?? priority.length;
    const rightRank = rank.get(right) ?? priority.length;

    return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
  });
}

/** 单个字段值的展示规则：简单值直接展示，复杂对象压成紧凑 JSON。 */
function formatDebugFieldValue(value: unknown, colorEnabled: boolean): string {
  // 布尔值常用于 ok/status 类字段，单独上色比 JSON 字符串更容易扫。
  if (typeof value === "boolean") {
    return paint(String(value), [value ? ansi.green : ansi.red], colorEnabled);
  }

  // 数字和 bigint 常用于耗时、数量、区块高度，保留原值但用醒目色。
  if (typeof value === "number" || typeof value === "bigint") {
    return paint(String(value), [ansi.yellow], colorEnabled);
  }

  // 简单字符串不加引号；包含空格的字符串加 JSON 引号，避免 key=value 歧义。
  if (typeof value === "string") {
    const text = needsQuoting(value) ? JSON.stringify(value) : value;
    return value === "[redacted]" ? paint(text, [ansi.red], colorEnabled) : text;
  }

  if (value === null) {
    return paint("null", [ansi.gray], colorEnabled);
  }

  return paint(JSON.stringify(value), [ansi.dim], colorEnabled);
}

/** 遮蔽 debug 字段中的敏感信息，保留足够排查调用链的上下文。 */
function sanitizeDebugValue(value: unknown): unknown {
  // BigInt 无法直接 JSON.stringify，debug 里统一转成字符串。
  if (typeof value === "bigint") {
    return value.toString();
  }

  // Error 对象只保留 name/message，避免 stack 把日志刷得过长。
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugValue(item));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // 脱敏按字段名递归进行，能覆盖嵌套 input/output 里的 key。
    if (isSensitiveKey(key)) {
      output[key] = "[redacted]";
      continue;
    }

    output[key] = sanitizeDebugValue(item);
  }

  return output;
}

/** 是否给字符串加 JSON 引号，避免空格破坏 key=value 阅读。 */
function needsQuoting(value: string): boolean {
  return value.length === 0 || /\s/.test(value);
}

/** 统一时间格式，只保留当天时间，减少日志噪音。 */
function formatDebugTime(value: Date): string {
  return value.toISOString().slice(11, 23);
}

/** 判断事件名第一段是否为标准 phase。 */
function isDebugPhase(value: string | undefined): value is DebugPhase {
  return value === "cli" || value === "agent" || value === "skill" || value === "llm" || value === "tool" || value === "debug";
}

/** 判断事件名最后一段是否为标准 status。 */
function isDebugStatus(value: string | undefined): value is DebugStatus {
  return value === "start" || value === "done" || value === "skip" || value === "error" || value === "info";
}

/** 老调用没给 status 时，从字段里推断，保证输出仍然标准化。 */
function inferStatus(fields: DebugFields | undefined): DebugStatus {
  if (typeof fields?.ok === "boolean") {
    return fields.ok ? "done" : "error";
  }

  if (typeof fields?.error === "string") {
    return "error";
  }

  return "info";
}

/** 根据终端和环境变量决定是否输出 ANSI 颜色。 */
function shouldUseColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") {
    return true;
  }

  if (env.NO_COLOR !== undefined) {
    return false;
  }

  return Boolean(stream.isTTY);
}

/** 给文本套 ANSI 样式。 */
function paint(text: string, styles: string[], enabled: boolean): string {
  if (!enabled || styles.length === 0) {
    return text;
  }

  return `${styles.join("")}${text}${ansi.reset}`;
}

/** 粗粒度识别常见敏感字段名，防止 debug 意外泄露 key/secret/access token。 */
function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|authorization|bearer|secret|password|access[_-]?token|refresh[_-]?token/i.test(key);
}
