import assert from "node:assert/strict";
import test from "node:test";
import { extractInputContext } from "../src/core/input-extractor.ts";
import { createSession } from "../src/core/session.ts";

// 用户自然语言里直接贴 tx hash 时，输入提取层需要识别交易哈希和通用 EVM 交易分析意图。
test("extracts generic EVM transaction context from natural language", () => {
  const txHash = "0xaf68c69ff4f160e126e70934792dd1b4370db6f6e1a9fefcf4be9fd29b58937a";
  const context = extractInputContext({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: `帮我看下这个 tx ${txHash} 是啥意思`,
  });

  assert.equal(context.transactionHash, txHash);
  assert.deepEqual(context.protocolHints, ["evm"]);
  assert.ok(context.actionHints.includes("explain_transaction"));
  assert.ok(context.inputTypes.includes("transactionHash"));
  assert.ok(context.inputTypes.includes("walletAddress"));
});

// 协议名只影响协议提示，不应该让 ask 入口直接写死某个 skill。
test("extracts protocol hints without selecting a skill", () => {
  const context = extractInputContext({
    session: createSession(),
    prompt: "Explain this FourMeme transaction and check whether it was a sell.",
  });

  assert.ok(context.protocolHints.includes("fourmeme"));
  assert.ok(context.actionHints.includes("explain_transaction"));
  assert.ok(context.actionHints.includes("swap_or_trade"));
});
