#!/usr/bin/env node
import { createChaincraftAgent } from "../../../src/agent.ts";
import { createSession } from "../../../src/core/session.ts";
import type { ChainTransaction } from "../../../src/core/types.ts";

// skill 目录内的脚本示例：用内置 fixture 演示如何复用核心 Agent。
const fixture: ChainTransaction = {
  chainId: "bsc-mainnet",
  hash: "0xskilldemo",
  from: "0xWallet000000000000000000000000000000000001",
  to: "0xFourMemeRouter0000000000000000000000000001",
  valueWei: "0",
  method: "transfer",
  tokenTransfers: [
    {
      tokenAddress: "0xToken000000000000000000000000000000000001",
      tokenSymbol: "MEME",
      tokenDecimals: 18,
      from: "0xWallet000000000000000000000000000000000001",
      to: "0xRecipient000000000000000000000000000000001",
      amount: "1200",
    },
  ],
};

// 这里走确定性 explain 路径，不依赖 OpenAI/Anthropic API key；真正 ask 路径会额外读取完整 SKILL.md 做 runtime 规划。
const agent = createChaincraftAgent();
const session = createSession({ walletAddress: fixture.from });
const reply = await agent.explainFourMemeTokenTx({ session, transaction: fixture });
console.log(reply.text);
