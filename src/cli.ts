#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChaincraftAgent, createDefaultToolRegistry } from "./agent.ts";
import { createStderrDebugLogger, isDebugEnabled } from "./core/debug.ts";
import { loadDotEnv } from "./core/env.ts";
import { createLlmClientFromEnv } from "./core/llm.ts";
import { configureProxyFromEnv } from "./core/proxy.ts";
import { createSession } from "./core/session.ts";
import type { ChainId, ChainTransaction } from "./core/types.ts";
import type { ToolRegistry } from "./core/tools.ts";
import type { EvmRpcReceipt, EvmRpcTransaction } from "./tools/evm-rpc.ts";

/** CLI 原始参数，去掉 node 和脚本路径。 */
const args = process.argv.slice(2);
/** 没有参数值的布尔 flag；解析 prompt 时不能吞掉后面的自然语言。 */
const booleanOptions = new Set(["debug"]);

/** CLI 主分发入口：负责把命令路由到具体 handler。 */
async function main(): Promise<void> {
  // 启动时先加载项目根目录 .env，方便本地直接配置 OPENAI_API_KEY。
  await loadDotEnv({ cwd: projectRoot() });
  // Node fetch 不会自动读取系统代理；这里让 LLM 和 RPC 请求都能走 Clash/HTTP 代理。
  configureProxyFromEnv();

  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // skill 列表是只读操作，不需要 LLM 或链上 RPC。
  if (command === "skills") {
    await listSkills();
    return;
  }

  // ask 是 LLM Agent 入口，会读取 provider API key。
  if (command === "ask") {
    await ask(args.slice(1));
    return;
  }

  // explain 是确定性工具入口，适合测试和无 API key 的本地演示。
  if (command === "explain") {
    await explain();
    return;
  }

  // 普通用户更像聊天，不会先输入 ask；未知命令默认当作自然语言 prompt 交给 Agent。
  await ask(args);
}

/** 输出当前可用 skills，方便确认 SKILL.md 是否被正确加载。 */
async function listSkills(): Promise<void> {
  const agent = createChaincraftAgent({ skillsRoot: path.join(projectRoot(), "skills") });
  const skills = await agent.listSkills();

  for (const skill of skills) {
    console.log(`${skill.id}\t${skill.name}\t${skill.description}`);
  }
}

/** 自然语言 Agent 命令：LLM 负责计划，typed tools 负责事实。 */
async function ask(commandArgs: string[]): Promise<void> {
  const options = parseOptions(commandArgs);
  const prompt = options.get("prompt") ?? parsePositionalPrompt(commandArgs);
  if (!prompt) {
    throw new Error("Missing prompt. Use `chaincraft ask \"...\"` or `chaincraft ask --prompt \"...\"`.");
  }

  const debug = createStderrDebugLogger({
    enabled: isDebugEnabled({ cliValue: options.get("debug") }),
  });
  const tools = createDefaultToolRegistry();
  const session = createSession({
    walletAddress: options.get("wallet"),
    chainId: parseChainId(options.get("chain") ?? "bsc-mainnet"),
  });
  // provider/model 可以从 CLI 参数覆盖环境变量，便于快速切换 GPT/Claude/其他 provider。
  const provider = parseProvider(options.get("provider"));
  // CLI 阶段只记录“准备进入 Agent”的外层信息，不在这里读取 tx 或决定 skill。
  debug.log("cli.ask.start", {
    provider: provider ?? "env/default",
    model: options.get("model") ?? "env/default",
    promptChars: prompt.length,
  });
  const llm = createLlmClientFromEnv({
    provider,
    model: options.get("model"),
  });
  const agent = createChaincraftAgent({
    skillsRoot: path.join(projectRoot(), "skills"),
    tools,
    llm,
    debug,
  });
  const reply = await agent.ask({
    session,
    prompt,
    txPath: options.get("tx"),
    txHash: options.get("tx-hash"),
    rpcUrl: options.get("rpc-url"),
    tokenAddress: options.get("token"),
  });
  
  console.log("=== Agent Reply ===");
  console.log(reply.text);
}

/** 确定性 FourMeme 解释命令：不经过 LLM，直接执行 skill + tools。 */
async function explain(): Promise<void> {
  const options = parseOptions(args.slice(1));
  const debug = createStderrDebugLogger({
    enabled: isDebugEnabled({ cliValue: options.get("debug") }),
  });
  // explain 是确定性路径，也接入同一个 debug logger，方便对照 LLM Agent 路径。
  const tools = createDefaultToolRegistry();
  const inputChainId = parseChainId(options.get("chain") ?? "bsc-mainnet");
  const transaction = await readRequiredTransaction(options, inputChainId, tools);
  const session = createSession({
    walletAddress: options.get("wallet"),
    chainId: parseChainId(options.get("chain") ?? transaction.chainId),
  });
  const agent = createChaincraftAgent({ skillsRoot: path.join(projectRoot(), "skills"), tools, debug });
  const reply = await agent.explainFourMemeTokenTx({
    session,
    transaction,
    prompt:
      options.get("prompt") ??
      "Explain this FourMeme token transaction and tell me whether the focused wallet increased or reduced exposure.",
    tokenAddress: options.get("token"),
  });

  console.log(reply.text);
}

/** 读取必需交易输入：explain 必须有 --tx 或 --tx-hash。 */
async function readRequiredTransaction(
  options: Map<string, string>,
  chainId: ChainId,
  tools: ToolRegistry,
): Promise<ChainTransaction> {
  if (!options.has("tx") && !options.has("tx-hash")) {
    throw new Error("Missing transaction input. Use --tx <file> or --tx-hash <hash>.");
  }

  return readTransactionFromOptions(options, chainId, tools);
}

/** 根据 CLI 参数读取本地 fixture 或通过 RPC 拉取真实链上交易。 */
async function readTransactionFromOptions(
  options: Map<string, string>,
  chainId: ChainId,
  tools: ToolRegistry,
): Promise<ChainTransaction> {
  const txPath = options.get("tx");
  const txHash = options.get("tx-hash");

  if (txPath && txHash) {
    throw new Error("Use either --tx <file> or --tx-hash <hash>, not both.");
  }

  if (txPath) {
    return readTransaction(txPath);
  }

  if (!txHash) {
    throw new Error("Missing transaction input. Use --tx <file> or --tx-hash <hash>.");
  }

  return fetchTransactionByHash({
    txHash,
    chainId,
    rpcUrl: options.get("rpc-url"),
    tools,
  });
}

/** 通过 typed RPC tools 拉交易、receipt，并归一化成 ChainTransaction。 */
async function fetchTransactionByHash(input: {
  txHash: string;
  chainId: ChainId;
  rpcUrl?: string;
  tools: ToolRegistry;
}): Promise<ChainTransaction> {
  const toolSession = createSession({ chainId: input.chainId });
  const transaction = await callCliTool<EvmRpcTransaction>(
    input.tools,
    "rpc_get_transaction",
    {
      txHash: input.txHash,
      chainId: input.chainId,
      rpcUrl: input.rpcUrl,
    },
    toolSession,
  );
  const receipt = await callCliTool<EvmRpcReceipt>(
    input.tools,
    "rpc_get_transaction_receipt",
    {
      txHash: input.txHash,
      chainId: input.chainId,
      rpcUrl: input.rpcUrl,
    },
    toolSession,
  );

  return callCliTool<ChainTransaction>(
    input.tools,
    "normalize_evm_transaction",
    {
      chainId: input.chainId,
      transaction,
      receipt,
    },
    toolSession,
  );
}

/** CLI 层调用 typed tool 的小包装，把结构化错误转成命令行异常。 */
async function callCliTool<Output>(
  tools: ToolRegistry,
  name: string,
  input: unknown,
  session: ReturnType<typeof createSession>,
): Promise<Output> {
  const result = await tools.call<Output>(name, input, session);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

/** 读取归一化交易 JSON，并把 blockNumber 转回 bigint。 */
async function readTransaction(txPath: string): Promise<ChainTransaction> {
  const resolved = path.resolve(process.cwd(), txPath);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as ChainTransaction & { blockNumber?: string | number };

  return {
    ...parsed,
    blockNumber: parsed.blockNumber === undefined ? undefined : BigInt(parsed.blockNumber),
    tokenTransfers: parsed.tokenTransfers ?? [],
  };
}

/** 解析 --key value 形式的 CLI 参数；MVP 先不用第三方 CLI 框架。 */
function parseOptions(values: string[]): Map<string, string> {
  const options = new Map<string, string>();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    // 非 -- 开头的参数会交给 parsePositionalPrompt 处理。
    if (!value.startsWith("--")) {
      continue;
    }

    const key = value.slice(2);
    if (booleanOptions.has(key)) {
      options.set(key, "true");
      continue;
    }

    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, "true");
      continue;
    }

    // 支持布尔 flag 形态，虽然当前命令主要使用 key/value。
    options.set(key, next);
    index += 1;
  }

  return options;
}

/** 把 ask 后面的非 option 参数拼成自然语言 prompt。 */
function parsePositionalPrompt(values: string[]): string | undefined {
  const parts: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (booleanOptions.has(key)) {
        continue;
      }

      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    // 多段 prompt 合并，支持不加引号的简单输入。
    parts.push(value);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** CLI 输入到 ChainId union 的收窄。 */
function parseChainId(value: string): ChainId {
  if (value === "bsc-mainnet" || value === "ethereum-mainnet" || value === "base-mainnet") {
    return value;
  }

  return "unknown";
}

/** CLI provider 参数只做基础清洗；是否支持交给 LLM 工厂统一校验。 */
function parseProvider(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const provider = value.trim();

  return provider.length > 0 ? provider : undefined;
}

/** 打印 CLI 帮助文本。 */
function printHelp(): void {
  console.log(`Chaincraft

Usage:
  node src/cli.ts [--debug] "<natural language request>"
  node src/cli.ts skills
  node src/cli.ts ask "<prompt>" [--debug] [--provider gpt|openai|claude|anthropic] [--tx <file>|--tx-hash <hash>] [--wallet <address>] [--rpc-url <url>]
  node src/cli.ts explain (--tx <file>|--tx-hash <hash>) [--debug] [--wallet <address>] [--token <address>] [--chain bsc-mainnet] [--rpc-url <url>]

Examples:
  node src/cli.ts "帮我看下这个 tx 0x... 是啥意思"
  node src/cli.ts --debug "帮我看下这个 tx 0x... 是啥意思"
  node src/cli.ts skills
  node src/cli.ts ask "Explain this FourMeme tx" --tx fixtures/fourmeme-transfer.json --wallet 0xWallet000000000000000000000000000000000001
  node src/cli.ts ask "Explain this real BSC transaction 0x..." --chain bsc-mainnet
  node src/cli.ts ask "What can you do for FourMeme monitoring?"
  node src/cli.ts explain --tx fixtures/fourmeme-transfer.json --wallet 0xWallet000000000000000000000000000000000001
`);
}

/** 计算项目根目录，源码模式直接运行时用于定位 skills/。 */
function projectRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** 顶层错误处理：CLI 只输出错误信息，并设置非零退出码。 */
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
