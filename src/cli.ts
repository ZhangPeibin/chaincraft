#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChaincraftAgent } from "./agent.ts";
import { loadDotEnv } from "./core/env.ts";
import { createLlmClientFromEnv } from "./core/llm.ts";
import { configureProxyFromEnv } from "./core/proxy.ts";
import { createSession } from "./core/session.ts";
import type { ChainId, ChainTransaction } from "./core/types.ts";

/** CLI 原始参数，去掉 node 和脚本路径。 */
const args = process.argv.slice(2);

/** CLI 主分发入口：负责把命令路由到具体 handler。 */
async function main(): Promise<void> {
  // 启动时先加载项目根目录 .env，方便本地直接配置 OPENAI_API_KEY。
  await loadDotEnv({ cwd: projectRoot() });

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
    await ask();
    return;
  }

  // explain 是确定性工具入口，适合测试和无 API key 的本地演示。
  if (command === "explain") {
    await explain();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
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
async function ask(): Promise<void> {
  const commandArgs = args.slice(1);
  const options = parseOptions(commandArgs);
  const prompt = options.get("prompt") ?? parsePositionalPrompt(commandArgs);
  if (!prompt) {
    throw new Error("Missing prompt. Use `chaincraft ask \"...\"` or `chaincraft ask --prompt \"...\"`.");
  }

  // 当前 MVP 仍使用本地归一化交易文件；下一步会替换成 RPC 拉取交易。
  const txPath = options.get("tx");
  const transaction = txPath ? await readTransaction(txPath) : undefined;
  const session = createSession({
    walletAddress: options.get("wallet"),
    chainId: parseChainId(options.get("chain") ?? transaction?.chainId ?? "bsc-mainnet"),
  });
  // provider/model 可以从 CLI 参数覆盖环境变量，便于快速切换 GPT/Claude/其他 provider。
  const provider = parseProvider(options.get("provider"));
  // Node fetch 不会自动读取 Clash Verge 系统代理，这里显式接入 .env/环境变量代理。
  configureProxyFromEnv();
  const llm = createLlmClientFromEnv({
    provider,
    model: options.get("model"),
  });
  const agent = createChaincraftAgent({
    skillsRoot: path.join(projectRoot(), "skills"),
    llm,
  });
  const reply = await agent.ask({
    session,
    prompt,
    transaction,
    tokenAddress: options.get("token"),
  });
  
  console.log("=== Agent Reply ===");
  console.log(reply.text);
}

/** 确定性 FourMeme 解释命令：不经过 LLM，直接执行 skill + tools。 */
async function explain(): Promise<void> {
  const options = parseOptions(args.slice(1));
  const txPath = options.get("tx");

  if (!txPath) {
    throw new Error("Missing --tx <file>.");
  }

  const transaction = await readTransaction(txPath);
  const session = createSession({
    walletAddress: options.get("wallet"),
    chainId: parseChainId(options.get("chain") ?? transaction.chainId),
  });
  const agent = createChaincraftAgent({ skillsRoot: path.join(projectRoot(), "skills") });
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
  node src/cli.ts skills
  node src/cli.ts ask "<prompt>" [--provider gpt|openai|claude|anthropic] [--tx <file>] [--wallet <address>]
  node src/cli.ts explain --tx <file> [--wallet <address>] [--token <address>] [--chain bsc-mainnet]

Examples:
  node src/cli.ts skills
  OPENAI_API_KEY=... node src/cli.ts ask "Explain this FourMeme tx" --provider gpt --tx fixtures/fourmeme-transfer.json --wallet 0xWallet000000000000000000000000000000000001
  ANTHROPIC_API_KEY=... node src/cli.ts ask "What can you do for FourMeme monitoring?" --provider claude
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
