import assert from "node:assert/strict";
import test from "node:test";
import { applyDotEnv, parseDotEnv } from "../src/core/env.ts";

// .env loader 需要支持本地最常见的 key/value、export、注释和引号写法。
test("parses common dotenv syntax", () => {
  const parsed = parseDotEnv(`
# comment
OPENAI_API_KEY=sk-test
export OPENAI_MODEL="gpt-5.4"
ANTHROPIC_MODEL='claude-sonnet-4-20250514'
PLAIN_WITH_COMMENT=value # ignored
PLAIN_WITH_HASH=value#kept
MULTILINE="hello\\nworld"
`);

  assert.equal(parsed.get("OPENAI_API_KEY"), "sk-test");
  assert.equal(parsed.get("OPENAI_MODEL"), "gpt-5.4");
  assert.equal(parsed.get("ANTHROPIC_MODEL"), "claude-sonnet-4-20250514");
  assert.equal(parsed.get("PLAIN_WITH_COMMENT"), "value");
  assert.equal(parsed.get("PLAIN_WITH_HASH"), "value#kept");
  assert.equal(parsed.get("MULTILINE"), "hello\nworld");
});

// 默认不覆盖 shell 里已有的环境变量，避免用户临时 export 的值被 .env 改掉。
test("applies dotenv values without overriding existing env by default", () => {
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "from-shell",
  };
  const applied = applyDotEnv(
    new Map([
      ["OPENAI_API_KEY", "from-file"],
      ["OPENAI_MODEL", "gpt-5.4"],
    ]),
    env,
  );

  assert.deepEqual(applied, ["OPENAI_MODEL"]);
  assert.equal(env.OPENAI_API_KEY, "from-shell");
  assert.equal(env.OPENAI_MODEL, "gpt-5.4");
});
