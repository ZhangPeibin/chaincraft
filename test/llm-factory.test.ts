import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultLlmClientFactory, LlmClientFactory } from "../src/core/llm.ts";
import type { LlmProviderRegistration } from "../src/core/llm.ts";
import type { LlmClient } from "../src/core/types.ts";

// 默认工厂需要把用户常用叫法 gpt/chatgpt 映射到 OpenAI provider。
test("default LLM factory resolves GPT aliases to OpenAI", () => {
  const factory = createDefaultLlmClientFactory();

  assert.equal(factory.resolve("gpt").canonicalName, "openai");
  assert.equal(factory.resolve("chatgpt").canonicalName, "openai");
  assert.equal(factory.resolve("openai").canonicalName, "openai");
});

// 默认工厂需要把 claude 映射到 Anthropic provider。
test("default LLM factory resolves Claude alias to Anthropic", () => {
  const factory = createDefaultLlmClientFactory();

  assert.equal(factory.resolve("claude").canonicalName, "anthropic");
  assert.equal(factory.resolve("anthropic").canonicalName, "anthropic");
});

// 工厂模式的关键价值是后续可以注册本地模型或其他云厂商，而不用改 Agent 主流程。
test("LLM factory supports custom provider registration", async () => {
  const factory = new LlmClientFactory();
  const customProvider: LlmProviderRegistration = {
    canonicalName: "local",
    aliases: ["ollama"],
    create(input): LlmClient {
      return {
        async generate() {
          return {
            provider: "local",
            model: input.model ?? input.env.CHAINCRAFT_LLM_MODEL ?? "local-default",
            text: input.env.CHAINCRAFT_LLM_API_KEY ?? "no-key-needed",
            raw: null,
          };
        },
      };
    },
  };

  factory.register(customProvider);
  const client = factory.createFromEnv({
    provider: "ollama",
    env: {
      CHAINCRAFT_LLM_MODEL: "llama3.1",
      CHAINCRAFT_LLM_API_KEY: "local-key",
    },
  });
  const response = await client.generate({
    system: "test",
    user: "hello",
  });

  assert.equal(response.provider, "local");
  assert.equal(response.model, "llama3.1");
  assert.equal(response.text, "local-key");
});

// 选择了 provider 但没配置 key 时，错误信息要直接指出应该配哪个 key。
test("LLM factory reports missing selected provider key", () => {
  const factory = createDefaultLlmClientFactory();

  assert.throws(
    () =>
      factory.createFromEnv({
        provider: "gpt",
        env: {},
      }),
    /Missing OPENAI_API_KEY/,
  );
});
