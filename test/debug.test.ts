import assert from "node:assert/strict";
import test from "node:test";
import { createStderrDebugLogger, isDebugEnabled } from "../src/core/debug.ts";

// debug 可以由 CLI flag 打开，也可以由环境变量打开。
test("debug mode resolves from CLI value or environment", () => {
  assert.equal(isDebugEnabled({ cliValue: "true", env: {} }), true);
  assert.equal(isDebugEnabled({ cliValue: "1", env: {} }), true);
  assert.equal(isDebugEnabled({ env: { CHAINCRAFT_DEBUG: "yes" } }), true);
  assert.equal(isDebugEnabled({ cliValue: "false", env: { CHAINCRAFT_DEBUG: "yes" } }), false);
  assert.equal(isDebugEnabled({ env: {} }), false);
});

// debug 需要保护真正的密钥，但不能把链上 token 字段误判成 secret。
test("debug logger redacts secrets without hiding token facts", () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    const logger = createStderrDebugLogger({ enabled: true, color: false });
    logger.log("test.event", {
      apiKey: "sk-secret",
      tokenAddress: "0xToken",
      tokenTransferCount: 1,
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /apiKey=\[redacted\]/);
  assert.match(lines[0] ?? "", /tokenAddress=0xToken/);
  assert.match(lines[0] ?? "", /tokenTransferCount=1/);
});

// 终端支持颜色时，debug 输出应包含 ANSI 颜色码。
test("debug logger can render colored call chain lines", () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    const logger = createStderrDebugLogger({ enabled: true, color: true });
    logger.log("llm.route.done", {
      provider: "openai",
      model: "gpt-5.4",
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /\x1b\[/);
  const plain = stripAnsi(lines[0] ?? "");
  assert.match(plain, /LLM/);
  assert.match(plain, /route done/);
  assert.match(plain, /provider=openai/);
});

// FORCE_COLOR 应该能覆盖 NO_COLOR，方便用户在特殊终端里强制打开颜色。
test("debug color mode lets FORCE_COLOR override NO_COLOR", () => {
  const lines: string[] = [];
  const originalError = console.error;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    process.env.FORCE_COLOR = "1";
    process.env.NO_COLOR = "1";
    const logger = createStderrDebugLogger({ enabled: true });
    logger.log("tool.decode_transaction.done", {
      tool: "decode_transaction",
      ok: true,
    });
  } finally {
    restoreEnv("FORCE_COLOR", originalForceColor);
    restoreEnv("NO_COLOR", originalNoColor);
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /\x1b\[/);
});

// debug 行固定包含 seq/time/phase/action/status，便于以后落库或接 UI。
test("debug logger renders standardized columns", () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };

  try {
    const logger = createStderrDebugLogger({ enabled: true, color: false });
    logger.log("tool.decode_transaction.done", {
      ok: true,
      tool: "decode_transaction",
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^chaincraft #0001 \d{2}:\d{2}:\d{2}\.\d{3} TOOL decode_transaction done /);
  assert.match(lines[0] ?? "", /tool=decode_transaction/);
  assert.match(lines[0] ?? "", /ok=true/);
});

/** 测试彩色输出时先去掉 ANSI，避免样式码影响内容断言。 */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 还原环境变量，避免测试之间互相污染。 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
