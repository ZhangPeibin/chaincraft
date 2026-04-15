import type { LlmClient, LlmProviderName, LlmRequest, LlmResponse } from "./types.ts";

/** 创建 LLM client 的配置，优先级高于环境变量。 */
export interface CreateLlmClientInput {
  /** 指定 provider；支持 openai/gpt/chatgpt/anthropic/claude 等别名。 */
  provider?: string;
  /** 指定模型；不传时读取对应 provider 的环境变量。 */
  model?: string;
  /** 指定 API key；不传时读取对应 provider 的环境变量。 */
  apiKey?: string;
  /** 环境变量来源；生产默认 process.env，测试可传自定义对象。 */
  env?: NodeJS.ProcessEnv;
}

/** 单个 provider 注册项，封装别名和 client 创建逻辑。 */
export interface LlmProviderRegistration {
  /** provider 规范名，会写入 LlmResponse.provider。 */
  canonicalName: LlmProviderName;
  /** provider 可识别别名，例如 gpt/chatgpt 都会指向 openai。 */
  aliases: readonly string[];
  /** 根据环境变量和显式参数创建具体 client。 */
  create(input: LlmProviderCreateInput): LlmClient;
}

/** provider 创建 client 时拿到的归一化上下文。 */
export interface LlmProviderCreateInput {
  /** 环境变量来源。 */
  env: NodeJS.ProcessEnv;
  /** 显式模型名；优先级高于环境变量。 */
  model?: string;
  /** 显式 API key；优先级高于环境变量。 */
  apiKey?: string;
}

/** LLM client 工厂：通过注册 provider，实现按 .env/CLI 选择不同模型供应商。 */
export class LlmClientFactory {
  /** provider 别名到注册项的映射，统一使用小写 key。 */
  private readonly providersByAlias = new Map<string, LlmProviderRegistration>();

  /** 注册一个 provider；同一个别名不能被多个 provider 占用。 */
  register(provider: LlmProviderRegistration): void {
    const aliases = new Set([provider.canonicalName, ...provider.aliases].map(normalizeProviderKey));

    for (const alias of aliases) {
      const existing = this.providersByAlias.get(alias);
      if (existing) {
        throw new Error(`LLM provider alias '${alias}' is already registered for '${existing.canonicalName}'.`);
      }

      this.providersByAlias.set(alias, provider);
    }
  }

  /** 根据 provider 名或别名解析注册项；找不到时给出可选 provider 列表。 */
  resolve(providerName: string): LlmProviderRegistration {
    const provider = this.providersByAlias.get(normalizeProviderKey(providerName));
    if (!provider) {
      throw new Error(
        `Unsupported LLM provider: ${providerName}. Available providers: ${this.listProviderAliases().join(", ")}.`,
      );
    }

    return provider;
  }

  /** 从环境变量和显式参数创建 client；这是 CLI 默认使用的工厂入口。 */
  createFromEnv(input: CreateLlmClientInput = {}): LlmClient {
    const env = input.env ?? process.env;
    const providerName = input.provider ?? env.CHAINCRAFT_LLM_PROVIDER ?? "openai";
    const provider = this.resolve(providerName);

    return provider.create({
      env,
      model: input.model,
      apiKey: input.apiKey,
    });
  }

  /** 返回稳定排序后的别名列表，主要用于错误信息和测试。 */
  listProviderAliases(): string[] {
    return [...this.providersByAlias.keys()].sort((a, b) => a.localeCompare(b));
  }
}

/** 创建内置 provider 工厂，当前包含 OpenAI/GPT 和 Anthropic/Claude。 */
export function createDefaultLlmClientFactory(): LlmClientFactory {
  const factory = new LlmClientFactory();
  factory.register(createOpenAIProviderRegistration());
  factory.register(createAnthropicProviderRegistration());
  return factory;
}

/** 从环境变量创建 LLM client，CLI 的 ask 命令使用这个兼容入口。 */
export function createLlmClientFromEnv(input: CreateLlmClientInput = {}): LlmClient {
  return createDefaultLlmClientFactory().createFromEnv(input);
}

/** OpenAI provider 注册项；gpt/chatgpt 都作为 OpenAI 别名。 */
export function createOpenAIProviderRegistration(): LlmProviderRegistration {
  return {
    canonicalName: "openai",
    aliases: ["gpt", "chatgpt"],
    create(input) {
      // 通用 CHAINCRAFT_LLM_API_KEY 支持“当前选中的 provider”只配一个 key。
      const apiKey = input.apiKey ?? input.env.CHAINCRAFT_LLM_API_KEY ?? input.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("Missing OPENAI_API_KEY. Set it in .env, or set CHAINCRAFT_LLM_API_KEY for the selected provider.");
      }

      return createOpenAIClient({
        apiKey,
        model: input.model ?? input.env.CHAINCRAFT_LLM_MODEL ?? input.env.OPENAI_MODEL ?? "gpt-5.4",
      });
    },
  };
}

/** Anthropic provider 注册项；claude 是 Anthropic 的常用别名。 */
export function createAnthropicProviderRegistration(): LlmProviderRegistration {
  return {
    canonicalName: "anthropic",
    aliases: ["claude"],
    create(input) {
      const apiKey = input.apiKey ?? input.env.CHAINCRAFT_LLM_API_KEY ?? input.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Missing ANTHROPIC_API_KEY. Set it in .env, or set CHAINCRAFT_LLM_API_KEY for the selected provider.",
        );
      }

      return createAnthropicClient({
        apiKey,
        model: input.model ?? input.env.CHAINCRAFT_LLM_MODEL ?? input.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      });
    },
  };
}

/** 创建 OpenAI Responses API 客户端。 */
export function createOpenAIClient(input: { apiKey: string; model: string }): LlmClient {
  return {
    async generate(request) {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          instructions: request.system,
          input: request.user,
          max_output_tokens: request.maxOutputTokens ?? 900,
        }),
      });

      // API 错误也尽量解析 JSON，这样能把平台返回的 message 透传给开发者。
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) {
        throw new Error(`OpenAI request failed (${response.status}): ${summarizeApiError(payload)}`);
      }

      return {
        provider: "openai",
        model: input.model,
        text: extractOpenAIText(payload),
        raw: payload,
      };
    },
  };
}

/** 创建 Anthropic Messages API 客户端。 */
export function createAnthropicClient(input: { apiKey: string; model: string }): LlmClient {
  return {
    async generate(request) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: request.maxOutputTokens ?? 900,
          system: request.system,
          messages: [
            {
              role: "user",
              content: request.user,
            },
          ],
        }),
      });

      // Anthropic 错误同样保留结构化 message，便于 CLI 直接显示可行动错误。
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) {
        throw new Error(`Anthropic request failed (${response.status}): ${summarizeApiError(payload)}`);
      }

      return {
        provider: "anthropic",
        model: input.model,
        text: extractAnthropicText(payload),
        raw: payload,
      };
    },
  };
}

/** 从 OpenAI Responses API 响应里抽取文本，兼容 output_text 和分段 output 两种形状。 */
function extractOpenAIText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const output = isRecord(payload) && Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

/** 从 Anthropic Messages API 响应里抽取 text content block。 */
function extractAnthropicText(payload: unknown): string {
  const content = isRecord(payload) && Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];

  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.join("\n").trim();
}

/** 尽量把 provider 的错误响应压缩成人类可读的一句话。 */
function summarizeApiError(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return JSON.stringify(payload);
}

/** provider key 统一小写并去掉首尾空白，让 .env/CLI 配置更宽容。 */
function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

/** unknown 到对象字典的窄化工具，避免在外部 API 响应上使用 any。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
